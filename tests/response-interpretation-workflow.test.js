'use strict';

/*
 * Phase 3 — Response Interpretation V1 workflow CONTRACT test suite.
 *
 * The workflow is NOT shipped in Phase 3 (no JSON, no builder, no embedded
 * mirror) — that is the Phase 4 gate. What exists here is the contract itself:
 *
 *   - the canonical read-only 5-node topology (`referenceWorkflow`) and the
 *     validator (`assertWorkflowContract`) that any Phase 4 builder output /
 *     shipped JSON must satisfy;
 *   - the three-way feed projection (`projectWorkflowInputs`) that maps the
 *     workflow's read surfaces onto the engine signature, joining exclusively
 *     by response_id and consuming reconciliation as authoritative evidence
 *     that is NEVER recomputed;
 *   - the failure semantics (healthy empty reads -> COMPLETED with valid zero
 *     metrics; read failure -> INCOMPLETE with nulled summary);
 *   - the fixture-parity gate (`engineBehaviorFor` / `assertEngineEquivalence`)
 *     that a Phase 4 embedded node must reproduce byte-for-byte;
 *   - deterministic run identity, PII quarantine, and the banned-surface scan.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WORKFLOW_NAME,
  ARTIFACT,
  RESPONSE_LOG_SHEET,
  JOIN_KEY,
  SPREADSHEET_ID,
  EXPECTED_NODES,
  NODE_TYPES,
  ALWAYS_OUTPUT_DATA,
  TRIGGER_ERROR_KEYS,
  BANNED_NODE_TYPES,
  SENSITIVE_KEYS,
  FIXED_NOW,
  FIXED_RUN_ID,
  TOPOLOGY,
  stripRuntime,
  projectWorkflowInputs,
  engineBehaviorFor,
  assertEngineEquivalence,
  referenceWorkflow,
  describeWorkflowContract,
  assertWorkflowContract,
  assertCleanSource,
} = require('../src/response-interpretation-workflow-contract');
const { interpretResponses } = require('../src/response-interpretation');
const { reconcileResponses } = require('../src/response-reconcile');
const { loadResponseInterpretationFixtures } = require('../src/response-interpretation-fixtures');

const FIXTURES = loadResponseInterpretationFixtures();

function byId(id) {
  const fixture = FIXTURES.find((f) => f.id === id);
  assert.ok(fixture, 'fixture ' + id + ' must be loaded');
  return fixture;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/* Contract surface                                                    */
/* ------------------------------------------------------------------ */

test('contract declares the canonical 5-node read-only topology', () => {
  const contract = describeWorkflowContract();
  assert.equal(contract.name, WORKFLOW_NAME);
  assert.equal(contract.artifact, ARTIFACT);
  assert.equal(contract.joinKey, JOIN_KEY);
  assert.deepEqual(contract.expectedNodes, EXPECTED_NODES);
  assert.equal(contract.expectedNodes.length, 5);
  assert.deepEqual(contract.alwaysOutputData, ALWAYS_OUTPUT_DATA);
  assert.deepEqual(contract.triggerErrorKeys, TRIGGER_ERROR_KEYS);
  assert.deepEqual(contract.bannedNodeTypes, BANNED_NODE_TYPES);
  assert.deepEqual(contract.sensitiveKeys, SENSITIVE_KEYS);
  assert.deepEqual(contract.topology.chain, [
    'Manual Trigger',
    'Read Reconciliation Report',
    'Read Response Log',
    'Interpret Responses',
    'Response Interpretation Complete',
  ]);
  assert.equal(contract.topology.exit, EXPECTED_NODES[4]);
});

test('node type mapping locks every node to its exact implementation type', () => {
  assert.equal(NODE_TYPES['Manual Trigger'], 'n8n-nodes-base.manualTrigger');
  assert.equal(NODE_TYPES['Read Response Log'], 'n8n-nodes-base.googleSheets');
  assert.equal(NODE_TYPES['Read Reconciliation Report'], 'n8n-nodes-base.code');
  assert.equal(NODE_TYPES['Interpret Responses'], 'n8n-nodes-base.code');
  assert.equal(NODE_TYPES['Response Interpretation Complete'], 'n8n-nodes-base.noOp');
});

test('reference workflow is deterministic and satisfies the contract validator', () => {
  assert.doesNotThrow(() => assertWorkflowContract(referenceWorkflow()));
  assert.deepEqual(clone(referenceWorkflow()), clone(referenceWorkflow()));
});

test('reference node names, ids, and type versions are locked', () => {
  const wf = referenceWorkflow();
  assert.deepEqual(
    wf.nodes.map((n) => n.id),
    [
      'resp-int-manual-0000001',
      'resp-int-read-response-0001',
      'resp-int-read-recon-0001',
      'resp-int-interpret-0000001',
      'resp-int-complete-0000001',
    ],
  );
  assert.deepEqual(wf.nodes.map((n) => n.name), EXPECTED_NODES);
  const typeVersion = Object.fromEntries(wf.nodes.map((n) => [n.name, n.typeVersion]));
  assert.deepEqual(typeVersion, {
    'Manual Trigger': 1,
    'Read Response Log': 4,
    'Read Reconciliation Report': 2,
    'Interpret Responses': 2,
    'Response Interpretation Complete': 1,
  });
});

/* ------------------------------------------------------------------ */
/* Topology and read surfaces                                          */
/* ------------------------------------------------------------------ */

test('the topology is a strict chain in connection order with exactly one target per source', () => {
  const conns = referenceWorkflow().connections;
  const chain = [];
  let cursor = 'Manual Trigger';
  for (let depth = 0; depth < 4; depth++) {
    const targets = conns[cursor].main.map((branch) => branch.map((e) => e.node));
    assert.equal(targets.length, 1, cursor + ' must have exactly one output branch');
    assert.equal(targets[0].length, 1, cursor + ' must fan out to exactly one node');
    chain.push([cursor, targets[0][0]]);
    cursor = targets[0][0];
  }
  assert.deepEqual(chain, [
    ['Manual Trigger', 'Read Reconciliation Report'],
    ['Read Reconciliation Report', 'Read Response Log'],
    ['Read Response Log', 'Interpret Responses'],
    ['Interpret Responses', 'Response Interpretation Complete'],
  ]);
});

test('the terminal node has no outgoing connection', () => {
  const conns = referenceWorkflow().connections;
  assert.equal(conns['Response Interpretation Complete'], undefined);
});

test('exactly one googleSheets read: the Response Log, unfiltered, all matches, pinned spreadsheet', () => {
  const wf = referenceWorkflow();
  const sheets = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 1);
  const read = sheets[0];
  assert.equal(read.name, 'Read Response Log');
  const p = read.parameters;
  assert.equal(p.operation, 'read');
  assert.equal(p.sheetName.value, RESPONSE_LOG_SHEET);
  assert.equal(p.documentId.value, SPREADSHEET_ID);
  assert.deepEqual(p.filtersUI, { values: [] });
  assert.deepEqual(p.options, { returnAllMatches: true });
});

test('the Reconciliation Report read is a code-node pure relay, never a sheet, with alwaysOutputData', () => {
  const node = referenceWorkflow().nodes.find((n) => n.name === 'Read Reconciliation Report');
  assert.equal(node.type, 'n8n-nodes-base.code');
  assert.equal(node.typeVersion, 2);
  assert.equal(node.alwaysOutputData, true);
});

test('Interpret Responses sets alwaysOutputData so empty successful reads still execute', () => {
  const node = referenceWorkflow().nodes.find((n) => n.name === 'Interpret Responses');
  assert.equal(node.type, 'n8n-nodes-base.code');
  assert.equal(node.alwaysOutputData, true);
});

test('workflow is read-only and confined to the four allowed node types', () => {
  const types = referenceWorkflow().nodes.map((n) => n.type);
  assert.deepEqual(
    new Set(types),
    new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.googleSheets', 'n8n-nodes-base.code', 'n8n-nodes-base.noOp']),
  );
  for (const s of types) {
    assert.ok(!['append', 'appendOrUpdate', 'update', 'upsert', 'delete'].includes(s), 'no sheet writes');
  }
});

test('no scheduling, webhook, provider, enrichment, or AI node types', () => {
  const types = referenceWorkflow().nodes.map((n) => n.type);
  for (const banned of BANNED_NODE_TYPES) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }
});

test('no hardcoded secrets or credential material in the reference workflow', () => {
  const raw = JSON.stringify(referenceWorkflow());
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env var interpolation');
  assert.ok(!raw.includes('credentials'), 'no embedded credential blocks');
});

test('workflow is shipped inactive with meta documenting read-only, error carrier, and empty-read behavior', () => {
  const wf = referenceWorkflow();
  assert.equal(wf.active, false);
  assert.equal(wf.meta.readOnly, true);
  assert.equal(wf.meta.artifact, ARTIFACT);
  assert.deepEqual(wf.meta.sheets, [RESPONSE_LOG_SHEET]);
  assert.equal(wf.meta.joinKey, JOIN_KEY);
  assert.match(wf.meta.readErrorsCarriedBy, /Manual Trigger/);
  for (const key of TRIGGER_ERROR_KEYS) {
    assert.ok(wf.meta.readErrorsCarriedBy.includes(key), 'meta must carry ' + key);
  }
  assert.match(wf.meta.emptyReadBehavior, /alwaysOutputData/);
});

/* ------------------------------------------------------------------ */
/* Validator negatives                                                 */
/* ------------------------------------------------------------------ */

test('validator rejects missing nodes, node reordering, and duplicate names', () => {
  const tooFew = clone(referenceWorkflow());
  tooFew.nodes.pop();
  assert.throws(() => assertWorkflowContract(tooFew), /workflow contract violation/);

  const reordered = clone(referenceWorkflow());
  const names = reordered.nodes.map((n) => n.name);
  const a = names.indexOf('Read Reconciliation Report');
  const b = names.indexOf('Read Response Log');
  [reordered.nodes[a], reordered.nodes[b]] = [reordered.nodes[b], reordered.nodes[a]];
  assert.throws(() => assertWorkflowContract(reordered), /must be .* in that order/);

  const dup = clone(referenceWorkflow());
  dup.nodes[4].name = 'Interpret Responses';
  assert.throws(() => assertWorkflowContract(dup), /node names must be unique/);
});

test('validator rejects an active workflow and sheet write operations', () => {
  const active = clone(referenceWorkflow());
  active.active = true;
  assert.throws(() => assertWorkflowContract(active), /inactive/);

  const writing = clone(referenceWorkflow());
  writing.nodes.find((n) => n.name === 'Read Response Log').parameters.operation = 'append';
  assert.throws(() => assertWorkflowContract(writing), /operation "read"/);
});

test('validator rejects a second sheet read (reconciliation report must be a code relay)', () => {
  const wf = clone(referenceWorkflow());
  wf.nodes.find((n) => n.name === 'Read Reconciliation Report').type = 'n8n-nodes-base.googleSheets';
  assert.throws(() => assertWorkflowContract(wf), /exactly one googleSheets read|never be a sheet read/);
});

test('validator rejects missing alwaysOutputData and banned node types', () => {
  const noAlways = clone(referenceWorkflow());
  delete noAlways.nodes.find((n) => n.name === 'Interpret Responses').alwaysOutputData;
  assert.throws(() => assertWorkflowContract(noAlways), /alwaysOutputData/);

  const banned = clone(referenceWorkflow());
  banned.nodes.find((n) => n.name === 'Response Interpretation Complete').type = 'n8n-nodes-base.emailSend';
  assert.throws(() => assertWorkflowContract(banned), /banned node type present/);
});

test('validator rejects extra connections beyond the four canonical sources', () => {
  const wf = clone(referenceWorkflow());
  wf.connections['Response Interpretation Complete'] = {
    main: [[{ node: 'Manual Trigger', type: 'main', index: 0 }]],
  };
  assert.throws(() => assertWorkflowContract(wf), /connection key set/);
});

test('validator rejects incomplete meta documentation', () => {
  const wf = clone(referenceWorkflow());
  delete wf.meta.readErrorsCarriedBy;
  assert.throws(() => assertWorkflowContract(wf), /readErrorsCarriedBy/);

  const wf2 = clone(referenceWorkflow());
  wf2.meta.joinKey = 'lead_id';
  assert.throws(() => assertWorkflowContract(wf2), /joinKey/);
});

test('validator rejects filtered or wrong-spreadsheet sheet reads', () => {
  const filtered = clone(referenceWorkflow());
  filtered.nodes.find((n) => n.name === 'Read Response Log').parameters.filtersUI = { values: [{ key: 'x' }] };
  assert.throws(() => assertWorkflowContract(filtered), /unfiltered/);

  const wrongSheet = clone(referenceWorkflow());
  wrongSheet.nodes.find((n) => n.name === 'Read Response Log').parameters.documentId.value = '1-TAMPERED';
  assert.throws(() => assertWorkflowContract(wrongSheet), /pinned engine spreadsheet id/);
});

test('banned-source scan rejects env, static data, network, A/I evaluation, and randomness code', () => {
  assert.throws(() => assertCleanSource('const x = process.env;'), /process\.env/);
  assert.throws(() => assertCleanSource('const y = $env.var;'), /\$env/);
  assert.throws(() => assertCleanSource('if (self.staticData)'), /staticData/);
  assert.throws(() => assertCleanSource('await fetch(url)'), /fetch\(/);
  assert.throws(() => assertCleanSource('require("fs")'), /require\(/);
  assert.throws(() => assertCleanSource('eval(s)'), /eval\(/);
  assert.throws(() => assertCleanSource('new Function("x")'), /new Function/);
  assert.throws(() => assertCleanSource('const r = Math.random();'), /Math\.random/);
  assert.throws(() => assertCleanSource('crypto.randomUUID()'), /crypto\.randomUUID/);
  assert.throws(() => assertCleanSource('const http = require("http")'), /http\(s\) transport|require\(/);
  assert.doesNotThrow(() => assertCleanSource('const a = 1; return a * 2;'));
});

test('validator enforces the banned-source scan over embedded jsCode', () => {
  const wf = clone(referenceWorkflow());
  wf.nodes.find((n) => n.name === 'Interpret Responses').parameters = { jsCode: '// reads env\nprocess.env.secret' };
  assert.throws(() => assertWorkflowContract(wf), /process\.env/);
});

/* ------------------------------------------------------------------ */
/* Feed projection and engine boundary                                 */
/* ------------------------------------------------------------------ */

test('the three workflow feeds project onto the engine signature without extra surface', () => {
  const rows = [{ response_id: 'R1' }];
  const report = { status: 'COMPLETED', results: [{ response_id: 'R1' }] };
  const projected = projectWorkflowInputs({
    errorCarrier: {
      response_log_read_error: 'err-a',
      reconciliation_read_error: 'err-b',
    },
    responseItems: rows.map((json) => ({ json })),
    reportItems: [{ json: report }],
  });
  assert.deepEqual(projected.responseRows, rows);
  assert.deepEqual(projected.reconciliationReport, report);
  assert.equal(projected.responseLogReadError, 'err-a');
  assert.equal(projected.reconciliationReadError, 'err-b');
  assert.equal(projected.now, FIXED_NOW);
  assert.equal(projected.runId, FIXED_RUN_ID);
});

test('absent trigger error keys and absent report items default to healthy sources', () => {
  const projected = projectWorkflowInputs({ responseItems: [], reportItems: [] });
  assert.equal(projected.responseLogReadError, '');
  assert.equal(projected.reconciliationReadError, '');
  assert.deepEqual(projected.reconciliationReport, { status: 'COMPLETED', results: [] });
  assert.deepEqual(projected.responseRows, []);
});

test('reconciliation is consumed as evidence and never recomputed in the workflow', () => {
  const fixture = byId('TEST-RESP-INT-001');
  const clean = interpretResponses({
    responseRows: fixture.initialResponseRows,
    reconciliationReport: reconcileResponses({
      responseRows: fixture.reconcileResponseRows,
      outreachRows: fixture.reconcileOutreachRows,
      now: FIXED_NOW,
      runId: 'RESPRECON-FIXED',
    }),
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  });

  const surplus = interpretResponses({
    responseRows: fixture.initialResponseRows,
    reconciliationReport: reconcileResponses({
      responseRows: fixture.reconcileResponseRows,
      outreachRows: fixture.reconcileOutreachRows,
      now: FIXED_NOW,
      runId: 'RESPRECON-FIXED',
    }),
    reconcileResponseRows: [],
    outreachRows: [],
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  });

  assert.deepEqual(stripRuntime(clean), stripRuntime(surplus));
});

test('surplus fields on the reconciliation report are inert — only status and per-card response_id join matter', () => {
  const fixture = byId('TEST-RESP-INT-001');
  const baseOptions = {
    responseRows: fixture.initialResponseRows,
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  };
  const recon = reconcileResponses({
    responseRows: fixture.reconcileResponseRows,
    outreachRows: fixture.reconcileOutreachRows,
    now: FIXED_NOW,
    runId: 'RESPRECON-FIXED',
  });

  const tampered = clone(recon);
  tampered.reconstruction_attempted = true;
  tampered.recomputed_from_outreach = true;
  tampered.results = recon.results.map((card) =>
    Object.assign(clone(card), {
      reconciliation_origin: 'RECOMPUTED',
      outreach_proof: ['R1@outreach.example'],
    }),
  );

  const a = interpretResponses({ ...baseOptions, reconciliationReport: recon });
  const b = interpretResponses({ ...baseOptions, reconciliationReport: tampered });
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('join is exclusively by response_id: an evidence card without response_id is ignored', () => {
  const fixture = byId('TEST-RESP-INT-001');
  const report = {
    status: 'COMPLETED',
    results: [
      { reconciliation_status: 'VERIFIED', lead_id: 'L9', outreach_id: 'O9' },
      { response_id: fixture.reconcileResponseRows[0].response_id, reconciliation_status: 'VERIFIED' },
    ],
  };
  const out = interpretResponses({
    responseRows: fixture.initialResponseRows,
    reconciliationReport: report,
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  });
  assert.equal(out.results[0].reconciliation_status, 'VERIFIED');
});

/* ------------------------------------------------------------------ */
/* Failure and empty-read semantics                                    */
/* ------------------------------------------------------------------ */

test('empty successful reads reach a COMPLETED run with valid zero metrics, never a silent skip', () => {
  const report = interpretResponses(
    projectWorkflowInputs({
      responseItems: [],
      reportItems: [{ json: { status: 'COMPLETED', results: [] } }],
    }),
  );
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.response_records, 0);
  assert.equal(report.summary.interpreted_records, 0);
  assert.equal(report.summary.skipped_records, 0);
  assert.equal(report.summary.exception_count, 0);
  assert.equal(report.sources.response_log_ok, true);
  assert.equal(report.sources.reconciliation_ok, true);
});

test('a response log read error on the trigger yields INCOMPLETE with null metrics (025)', () => {
  const report = engineBehaviorFor(byId('TEST-RESP-INT-025'));
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.results.length, 0);
  assert.equal(report.sources.response_log_ok, false);
  assert.equal(report.sources.response_log_read_error, 'SheetNotFound');
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.exceptions[0].category, 'READ_FAILURE');
  assert.equal(report.exceptions[0].severity, 'ERROR');
  assert.equal(report.summary.response_records, null);
  assert.equal(report.summary.interpreted_records, null);
  assert.ok(String(JSON.stringify(report.exceptions[0].evidence)).includes('response log'));
});

test('a reconciliation report read error on the trigger yields INCOMPLETE (026)', () => {
  const report = engineBehaviorFor(byId('TEST-RESP-INT-026'));
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.reconciliation_ok, false);
  assert.equal(report.sources.reconciliation_read_error, 'SheetNotFound');
  assert.ok(report.sources.response_log_ok, true);
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.exceptions[0].category, 'READ_FAILURE');
  assert.ok(String(JSON.stringify(report.exceptions[0].evidence)).includes('reconciliation report'));
});

test('an upstream INCOMPLETE reconciliation report is read-failure-equivalent (024)', () => {
  const report = engineBehaviorFor(byId('TEST-RESP-INT-024'));
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.response_log_ok, true);
  assert.equal(report.sources.reconciliation_ok, false);
  assert.equal(report.sources.reconciliation_read_error, 'reconciliation upstream state INCOMPLETE');
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.exceptions[0].category, 'READ_FAILURE');
});

test('both read failures produce exactly two READ_FAILURE exceptions', () => {
  const report = interpretResponses(
    projectWorkflowInputs({
      errorCarrier: {
        response_log_read_error: 'NetworkError',
        reconciliation_read_error: 'SheetNotFound',
      },
      responseItems: [],
      reportItems: [],
    }),
  );
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.summary.exception_count, 2);
  assert.deepEqual(report.exceptions.map((e) => e.category), ['READ_FAILURE', 'READ_FAILURE']);
  assert.equal(report.sources.response_log_ok, false);
  assert.equal(report.sources.reconciliation_ok, false);
});

test('a read failure never fabricates a healthy run or zero metrics', () => {
  for (const id of ['TEST-RESP-INT-024', 'TEST-RESP-INT-025', 'TEST-RESP-INT-026']) {
    const report = engineBehaviorFor(byId(id));
    assert.equal(report.status, 'INCOMPLETE', id);
    assert.equal(report.summary.response_records, null, id);
    assert.equal(report.summary.coverage_rate, null, id);
    assert.equal(report.results.length, 0, id);
  }
});

/* ------------------------------------------------------------------ */
/* Fixture parity gate                                                 */
/* ------------------------------------------------------------------ */

for (const fixture of FIXTURES) {
  test(`${fixture.id} ${fixture.name} — workflow feed projection reproduces the fixture golden`, () => {
    const actual = engineBehaviorFor(fixture);

    assert.equal(actual.status, fixture.expected.status, 'status');
    assert.deepEqual(stripRuntime(actual.summary), fixture.expected.summary, 'summary');
    assert.deepEqual(stripRuntime(actual.sources), fixture.expected.sources, 'sources');
    assert.deepEqual(stripRuntime(actual.exceptions), fixture.expected.exceptions, 'exceptions');
    assert.deepEqual(stripRuntime(actual.results), fixture.expected.results, 'results');
    assert.equal(actual.exceptions.length, fixture.expected.exceptions.length);
    assert.ok(assertEngineEquivalence(actual, fixture), 'engine-equivalence gate');
  });
}

test('the parity gate is strict: a drifted report fails engine equivalence', () => {
  const drift = engineBehaviorFor(byId('TEST-RESP-INT-001'));
  drift.results[0].intent_label = 'QUESTION';
  assert.equal(assertEngineEquivalence(drift, byId('TEST-RESP-INT-001')), false);
});

test('all 27 fixtures reach the parity gate', () => {
  assert.equal(FIXTURES.length, 27);
  for (const fixture of FIXTURES) {
    assert.match(fixture.id, /^TEST-RESP-INT-\d{3}$/);
  }
});

/* ------------------------------------------------------------------ */
/* Deterministic run identity                                          */
/* ------------------------------------------------------------------ */

test('run identity is the frozen clock expressed as RESPINT + 14 digits', () => {
  assert.match(FIXED_RUN_ID, /^RESPINT-\d{14}$/);
  const expectedDigits = String(FIXED_NOW).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  assert.equal(FIXED_RUN_ID, 'RESPINT-' + expectedDigits);
  assert.equal(new Date(FIXED_NOW).toISOString(), '2026-09-12T09:00:00.000Z');
});

test('every projected run carries the deterministic run id and frozen timestamp', () => {
  for (const fixture of FIXTURES) {
    const report = engineBehaviorFor(fixture);
    assert.equal(report.run_id, FIXED_RUN_ID, fixture.id);
    assert.equal(report.run_at, '2026-09-12T09:00:00.000Z', fixture.id);
    assert.equal(report.detected_at, '2026-09-12T09:00:00.000Z', fixture.id);
  }
});

/* ------------------------------------------------------------------ */
/* PII quarantine                                                      */
/* ------------------------------------------------------------------ */

test('no raw response text, provider ids, emails, or phones escape the workflow feed', () => {
  for (const fixture of FIXTURES) {
    const report = engineBehaviorFor(fixture);
    const raw = JSON.stringify(report);

    assert.ok(!raw.includes('"response_text":'), fixture.id + ': response_text data key');
    assert.ok(!raw.includes('"provider_message_id":'), fixture.id + ': provider_message_id data key');
    assert.ok(!raw.includes('pmsg-'), fixture.id + ': provider message id value');
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw), fixture.id + ': email address');
    assert.ok(!raw.includes('+1555'), fixture.id + ': phone number');
    assert.ok(!raw.includes('gmail'), fixture.id + ': source provider value');
    assert.ok(!raw.includes('secret note'), fixture.id + ': raw response body');

    const keyUsages = raw.split('response_text').length - 1;
    if (keyUsages > 0) {
      assert.ok(
        raw.includes('empty response_text'),
        fixture.id + ": the only allowed 'response_text' text is the locked skip reason",
      );
    }
    for (const card of report.results) {
      assert.equal(card.text_preview, '', fixture.id + ':' + card.response_id + ' text_preview');
    }
  }
});

test('none of the sensitive keys ever appears as a serialized report key', () => {
  for (const fixture of FIXTURES) {
    const raw = JSON.stringify(engineBehaviorFor(fixture));
    for (const key of SENSITIVE_KEYS) {
      assert.ok(!raw.includes(`"${key}":`), fixture.id + ': key leak ' + key);
    }
  }
});