'use strict';

/*
 * Phase 5.1 / 5.2 / 5.4 regression tests: workflow wiring and contract
 * hardening.
 *
 * Guards the defect class that stalled Phase 6: a variant that diverges from
 * the canonical topology — a dropped chain edge, an extra edge, an orphaned or
 * unreachable node, or an unreachable code reference. The contract must fail
 * loudly with the exact missing/extra edge and identify every condition.
 *
 * Phase 5.2: Manual Trigger has exactly one output, so every connection lives
 * in output slot main[0] — never main[1+]. Phase 5.4: each slot holds exactly
 * ONE target in the strict chain (Manual Trigger -> Read Reconciliation Report
 * -> Read Response Log -> Interpret Responses -> Complete), so the old
 * two-target diamond fan-out is gone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/response-interpretation-workflow-contract.js');
const builder = require('../scripts/build-response-interpretation-workflow.js');

const SHIPPED_PATH = path.join(__dirname, '..', 'Response-Interpretation V1.json');
const EXPECTED_EDGE_STRINGS = contract.EXPECTED_EDGES.map(([from, to]) => `${from} -> ${to}`).sort();

function shippedWorkflow() {
  return JSON.parse(fs.readFileSync(SHIPPED_PATH, 'utf8'));
}

function cloneWorkflow(wf) {
  return JSON.parse(JSON.stringify(wf));
}

function expectContractFail(wf, messagePart) {
  assert.throws(
    () => contract.assertWorkflowContract(wf),
    (err) => err.message.includes(messagePart),
    `expected violation mentioning "${messagePart}"`
  );
}

test('shipped JSON contains exactly the expected edge set', () => {
  const edges = contract.workflowEdges(shippedWorkflow().connections);
  assert.deepEqual(edges, EXPECTED_EDGE_STRINGS);
});

test('builder output contains exactly the expected edge set', () => {
  const edges = contract.workflowEdges(builder.responseInterpretationWorkflow().connections);
  assert.deepEqual(edges, EXPECTED_EDGE_STRINGS);
});

test('shipped JSON and builder output are byte-identical', () => {
  const shipped = fs.readFileSync(SHIPPED_PATH, 'utf8');
  const built = JSON.stringify(builder.responseInterpretationWorkflow(), null, 2);
  assert.equal(built + '\n', shipped);
});

test('every node is reachable from the trigger (no unreachable nodes)', () => {
  const wf = shippedWorkflow();
  const reachable = contract.reachableNodes(wf.connections, contract.EXPECTED_NODES);
  for (const name of contract.EXPECTED_NODES) {
    assert.ok(reachable.has(name), `node "${name}" must be reachable from trigger`);
  }
});

test('every non-trigger node has an incoming edge (no orphans)', () => {
  const edges = contract.workflowEdges(shippedWorkflow().connections);
  const targets = new Set(edges.map((edge) => edge.split(' -> ')[1]));
  for (const name of contract.EXPECTED_NODES) {
    if (name === 'Manual Trigger') continue;
    assert.ok(targets.has(name), `node "${name}" must have an incoming edge`);
  }
});

test('contract fails on missing edge (dropped chain edge)', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [[{ node: 'Read Response Log', type: 'main', index: 0 }]];
  expectContractFail(wf, 'missing edge(s): Manual Trigger -> Read Reconciliation Report');
});

test('contract fails on extra edge', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main.push([
    { node: 'Response Interpretation Complete', type: 'main', index: 0 },
  ]);
  expectContractFail(wf, 'unexpected edge(s): Manual Trigger -> Response Interpretation Complete');
});

test('contract fails on unchanged edge count but wrong target', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main[0][0].node = 'Read Response Log';
  // Now Manual Trigger targets Read Response Log (chain says Read Reconciliation
  // Report), so the chain edge Manual Trigger -> Read Reconciliation Report is gone.
  expectContractFail(wf, 'missing edge(s): Manual Trigger -> Read Reconciliation Report');
});

test('contract fails on orphaned node (dropped incoming edge)', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  delete wf.connections['Read Response Log'];
  // The chain "Read Response Log -> Interpret Responses" edge is gone, leaving
  // Interpret Responses without any incoming edge.
  expectContractFail(wf, 'orphaned node (no incoming edge): Interpret Responses');
});

test('contract fails on unreachable node', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [[{ node: 'Read Response Log', type: 'main', index: 0 }]];
  expectContractFail(wf, 'node unreachable from trigger: Read Reconciliation Report');
});

test('contract fails when code references an unknown node', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  const interpret = wf.nodes.find((n) => n.name === 'Interpret Responses');
  interpret.parameters.jsCode = `const data = $('Ghost Node').all();`;
  expectContractFail(wf, 'code references unknown node: Ghost Node');
});

test('contract fails when code references an unreachable node', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [[{ node: 'Read Response Log', type: 'main', index: 0 }]];
  const interpret = wf.nodes.find((n) => n.name === 'Interpret Responses');
  interpret.parameters.jsCode = `const data = $('Read Reconciliation Report').all();`;
  expectContractFail(wf, 'code references unreachable node: Read Reconciliation Report');
});

test('codeNodeReferences extracts quoted node names only', () => {
  const code = `const a = $('Read Response Log').all();\nconst b = items[0].json.x;`;
  assert.deepEqual(contract.codeNodeReferences(code), ['Read Response Log']);
  assert.deepEqual(contract.codeNodeReferences('no refs here'), []);
});

test('workflowEdges is deterministic across identical connection layouts', () => {
  const edges = contract.workflowEdges(shippedWorkflow().connections);
  assert.deepEqual(edges, edges.slice().sort());
  assert.equal(new Set(edges).size, edges.length);
});