'use strict';

/*
 * Phase 5.2 regression tests: connection output-slot validity.
 *
 * Guards the defect that stalled Phase 6: `Manual Trigger` connections used
 * two output arrays (`main: [[a], [b]]`) while `n8n-nodes-base.manualTrigger`
 * exposes exactly one output, so the `main[1]` fan-out edge was silently
 * discarded at runtime and every execution stopped at "Read Response Log".
 * Contract and tests must enforce the n8n runtime rule: a node with N outputs
 * must have exactly N `main` slots, and every edge into output index `i` lives
 * in `main[i]`, where `i` is strictly below N.
 *
 * Phase 5.4: the workflow is a strict linear chain, so each 1-output node's
 * main[0] holds exactly ONE target (Manual Trigger -> Read Reconciliation
 * Report, never the old two-target diamond).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../src/response-interpretation-workflow-contract.js');
const builder = require('../scripts/build-response-interpretation-workflow.js');

const SHIPPED_PATH = path.join(__dirname, '..', 'Response-Interpretation V1.json');

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

test('shipped Manual Trigger has exactly one output slot with its single chain target', () => {
  const wf = shippedWorkflow();
  const main = wf.connections['Manual Trigger'].main;
  assert.equal(main.length, 1, 'manualTrigger must expose exactly one output slot');
  const targets = main[0].map((t) => t.node);
  assert.deepEqual(targets, ['Read Reconciliation Report']);
});

test('no connection references an output index beyond its source output count', () => {
  const wf = shippedWorkflow();
  for (const [from, connections] of Object.entries(wf.connections)) {
    const source = wf.nodes.find((n) => n.name === from);
    assert.ok(source, `connection source "${from}" must exist as a node`);
    for (const [slotName, branches] of Object.entries(connections)) {
      assert.ok(Array.isArray(branches), `${from}.${slotName} must be an array`);
      for (let i = 0; i < branches.length; i++) {
        assert.ok(
          i < branches[i].length,
          `${from}.${slotName}[${i}] must hold only its own targets`
        );
      }
    }
  }
});

test('contract fails when a single-output node uses a second main output slot', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main = [
    [{ node: 'Read Response Log', type: 'main', index: 0 }],
    [{ node: 'Read Reconciliation Report', type: 'main', index: 0 }],
  ];
  expectContractFail(wf, 'main array has 2 branch(es) but "Manual Trigger" has only 1 output');
});

test('contract fails when a target edge references an out-of-range output index', () => {
  const wf = cloneWorkflow(shippedWorkflow());
  wf.connections['Manual Trigger'].main[0][0] = {
    node: 'Read Reconciliation Report',
    type: 'main',
    index: 1,
  };
  expectContractFail(wf, 'index 1');
});

test('reachable-node computation reaches all 5 nodes under n8n runtime semantics', () => {
  const wf = shippedWorkflow();
  const reachable = contract.reachableNodes(wf.connections, contract.EXPECTED_NODES);
  for (const name of contract.EXPECTED_NODES) {
    assert.ok(reachable.has(name), `node "${name}" must be reachable from trigger`);
  }
});

test('builder output is byte-for-byte reproducible across two runs', () => {
  const first = JSON.stringify(builder.responseInterpretationWorkflow(), null, 2);
  const second = JSON.stringify(builder.responseInterpretationWorkflow(), null, 2);
  assert.equal(first, second);
});