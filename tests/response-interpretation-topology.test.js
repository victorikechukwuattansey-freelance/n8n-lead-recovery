'use strict';

/*
 * Phase 5.4 regression tests: the strict linear chain topology.
 *
 * The pre-5.4 diamond (Manual Trigger -> [RRR, RRL] -> Interpret Responses) is
 * architecturally unreachable in n8n: every code-node input item is paired to
 * exactly ONE parent (pairedItem), so `$('Read Reconciliation Report')` throws
 * pairedItemNoConnectionCodeNode ("Node 'Read Reconciliation Report' hasn't
 * been executed") for items that arrived via the Read Response Log branch.
 * The corrected topology is a strict chain in which all three references are
 * transitive pairedItem ancestors of the Interpret Responses input.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/response-interpretation-workflow-contract.js');
const builder = require('../scripts/build-response-interpretation-workflow.js');
const { interpretCode, relayCode } = require('../src/embedded-response-interpret');

const SHIPPED_PATH = path.join(__dirname, '..', 'Response-Interpretation V1.json');
const CHAIN = contract.TOPOLOGY.chain;
const CHAIN_EDGES = [
  ['Manual Trigger', 'Read Reconciliation Report'],
  ['Read Reconciliation Report', 'Read Response Log'],
  ['Read Response Log', 'Interpret Responses'],
  ['Interpret Responses', 'Response Interpretation Complete'],
];

function shippedWorkflow() {
  return JSON.parse(fs.readFileSync(SHIPPED_PATH, 'utf8'));
}

function cloneWorkflow(wf) {
  return JSON.parse(JSON.stringify(wf));
}

function edgesInOrder(connections, start) {
  const order = [start];
  let cursor = start;
  while (true) {
    const main = connections[cursor] && connections[cursor].main;
    const targets = main && main[0] ? main[0].map((e) => e.node) : [];
    if (targets.length !== 1) break;
    cursor = targets[0];
    order.push(cursor);
    if (cursor === CHAIN[CHAIN.length - 1]) break;
  }
  return order;
}

/*
 * n8n lineage model: each node's output item is paired to exactly ONE parent
 * item (pairedItem). Walking incoming edges yields the node-name ancestry of an
 * item (most recent first). In a chain the lineage is deterministic; in a
 * diamond the branch an item actually arrived through decides the lineage.
 */
function itemLineage(connections, nodeName) {
  const incomingOf = (name) => {
    for (const [src, conns] of Object.entries(connections)) {
      for (const branch of conns.main || []) {
        for (const edge of branch) {
          if (edge.node === name) return src;
        }
      }
    }
    return null;
  };
  const lineage = [];
  let cursor = nodeName;
  while (cursor) {
    lineage.push(cursor);
    cursor = incomingOf(cursor);
  }
  return lineage;
}

test('the shipped workflow walks the exact Phase 5.4 chain in order', () => {
  const wf = shippedWorkflow();
  assert.deepEqual(edgesInOrder(wf.connections, 'Manual Trigger'), CHAIN);
  assert.deepEqual(contract.EXPECTED_EDGES, CHAIN_EDGES);
  assert.deepEqual(contract.TOPOLOGY.chain, CHAIN);
});

test('no node carries more than one incoming or outgoing edge', () => {
  const wf = shippedWorkflow();
  const names = contract.EXPECTED_NODES;
  const inCounts = contract.incomingCounts(wf.connections, names);
  const outCounts = contract.outgoingCounts(wf.connections, names);
  for (const name of names) {
    assert.ok(inCounts.get(name) <= 1, name + ' must have <= 1 incoming edge');
    assert.ok(outCounts.get(name) <= 1, name + ' must have <= 1 outgoing edge');
  }
  assert.equal(outCounts.get('Response Interpretation Complete'), 0, 'terminal must have no outgoing edge');
});

test('every embedded $("...") reference resolves to a transitive pairedItem ancestor', () => {
  const wf = shippedWorkflow();
  for (const node of wf.nodes) {
    const code = node.parameters && node.parameters.jsCode;
    if (typeof code !== 'string' || code.length === 0) continue;
    const ancestors = contract.pairedItemAncestors(wf.connections, node.name, contract.EXPECTED_NODES);
    for (const ref of contract.codeNodeReferences(code)) {
      assert.ok(ancestors.has(ref), node.name + " -> $('" + ref + "') must be a transitive ancestor");
    }
  }
});

test('embedded code references exactly the three chain ancestors and nothing else', () => {
  assert.deepEqual(contract.codeNodeReferences(interpretCode).sort(), [
    'Manual Trigger',
    'Read Reconciliation Report',
    'Read Response Log',
  ]);
  assert.deepEqual(contract.codeNodeReferences(relayCode), ['Manual Trigger']);
});

test('contract rejects the pre-5.4 diamond (two reads feeding Interpret Responses)', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [[
    { node: 'Read Reconciliation Report', type: 'main', index: 0 },
    { node: 'Read Response Log', type: 'main', index: 0 },
  ]];
  wf.connections['Read Reconciliation Report'].main = [[{ node: 'Interpret Responses', type: 'main', index: 0 }]];
  wf.connections['Read Response Log'].main = [[{ node: 'Interpret Responses', type: 'main', index: 0 }]];
  assert.throws(
    () => contract.assertWorkflowContract(wf),
    /has 2 outgoing edge\(s\), expected exactly 1 \(chain\)|has 2 incoming edge\(s\), expected exactly 1 \(chain\)/,
  );
});

test('contract rejects a code reference that is not a transitive pairedItem ancestor', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  const interpret = wf.nodes.find((n) => n.name === 'Interpret Responses');
  // 'Response Interpretation Complete' is reachable but is a DESCENDANT —
  // never an ancestor of items Interpret Responses receives. The chain checks
  // still pass; only the ancestor check must reject this.
  interpret.parameters.jsCode = "const x = $('Response Interpretation Complete').all();";
  assert.throws(
    () => contract.assertWorkflowContract(wf),
    /code node "Interpret Responses" references "Response Interpretation Complete" which is not a transitive pairedItem ancestor/,
  );
});

test('builder determinism: two builds are byte-identical and match the shipped JSON', () => {
  const a = JSON.stringify(builder.responseInterpretationWorkflow(), null, 2);
  const b = JSON.stringify(builder.responseInterpretationWorkflow(), null, 2);
  assert.equal(a, b);
  assert.equal(a + '\n', fs.readFileSync(SHIPPED_PATH, 'utf8'));
});

test('offline item-lineage simulation: the chain resolves all three interpret references', () => {
  const wf = shippedWorkflow();
  const lineage = itemLineage(wf.connections, 'Interpret Responses');
  for (const ref of ['Manual Trigger', 'Read Response Log', 'Read Reconciliation Report']) {
    assert.ok(lineage.includes(ref), ref + ' must be in the lineage of Interpret Responses items');
  }
});

test('offline item-lineage simulation: the diamond leaves the sibling branch unresolvable', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [[
    { node: 'Read Reconciliation Report', type: 'main', index: 0 },
    { node: 'Read Response Log', type: 'main', index: 0 },
  ]];
  wf.connections['Read Reconciliation Report'].main = [[{ node: 'Interpret Responses', type: 'main', index: 0 }]];
  wf.connections['Read Response Log'].main = [[{ node: 'Interpret Responses', type: 'main', index: 0 }]];
  // An item arriving through Read Response Log descends
  // [Read Response Log, Manual Trigger] and NEVER through Read Reconciliation
  // Report — the exact runtime lineage that produced pairedItemNoConnectionCodeNode.
  const rrlLineage = itemLineage(wf.connections, 'Read Response Log');
  assert.ok(rrlLineage.includes('Manual Trigger'));
  assert.ok(
    !rrlLineage.includes('Read Reconciliation Report'),
    'Read Reconciliation Report is a sibling branch, never an ancestor',
  );
});