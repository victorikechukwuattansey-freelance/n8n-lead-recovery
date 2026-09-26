'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Execution-Reconciliation V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { reconcileExecution } = require('../src/execution-reconcile');
const { loadExecutionReconFixtures } = require('../src/execution-recon-fixtures');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const EXPECTED_NODES = [
  'Manual Trigger',
  'Initialize Execution Evidence',
  'Read Outreach Log',
  'Reconcile Execution Records',
  'Execution Reconciliation Complete',
];

const fixtures = loadExecutionReconFixtures();

function byName(name) {
  const node = WF.nodes.find((n) => n.name === name);
  if (!node) throw new Error('Node not found: ' + name);
  return node;
}

function jsCodeOf(name) {
  const code = byName(name).parameters.jsCode || '';
  if (!code) throw new Error('No jsCode on node: ' + name);
  return code;
}

function executeCode(nodeName, opts = {}) {
  const refs = opts.refs ?? {};
  const $input = { first: () => ({ json: {} }), item: {}, all: () => [] };
  const $json = {};
  const $ = (name) => {
    const items = refs[name] ?? [];
    return {
      all: () => items,
      item: items[0] ? items[0].json : {},
    };
  };
  const source = jsCodeOf(nodeName);
  const body = '"use strict";\nreturn (function () {\n' + source + '\n})();';
  const fn = new Function('$input', '$json', '$', body);
  return fn($input, $json, $);
}

function itemsFromRows(rows) {
  return rows.map((json) => ({ json }));
}

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function evidenceRef(fx) {
  return [{ json: { execution_reports: fx.evidence, evidence_available: fx.evidence_available, read_errors: fx.read_errors } }];
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

/* ------------------------------------------------------------------ */
/* Structural / importability validation                               */
/* ------------------------------------------------------------------ */

test('workflow has the expected read-only node set with unique names and ids', () => {
  const names = WF.nodes.map((n) => n.name);
  assert.deepEqual(new Set(names).size, names.length, 'node names must be unique');
  assert.deepEqual([...new Set(names)].sort(), [...EXPECTED_NODES].sort());
  const ids = WF.nodes.map((n) => n.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'node ids must be unique');
  assert.equal(names.length, 5, 'expected exactly 5 nodes');
});

test('all connections reference existing nodes', () => {
  const names = new Set(WF.nodes.map((n) => n.name));
  for (const [source, conns] of Object.entries(WF.connections)) {
    assert.ok(names.has(source), 'missing source node: ' + source);
    for (const branches of Object.values(conns)) {
      for (const branch of branches) {
        for (const edge of branch) {
          assert.ok(names.has(edge.node), 'missing target node: ' + edge.node);
        }
      }
    }
  }
});

test('workflow is read-only: zero write nodes, one read of the Outreach Log, no execution', () => {
  const types = WF.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.httpRequest'), 'httpRequest must not appear');
  assert.deepEqual(
    new Set(types),
    new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.googleSheets', 'n8n-nodes-base.code', 'n8n-nodes-base.noOp']),
  );
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 1, 'exactly one sheet node (the Outreach Log read)');
  assert.equal(sheets[0].parameters.operation, 'read');
  assert.equal(sheets[0].parameters.sheetName.value, 'Outreach Log');
  assert.equal(sheets[0].parameters.documentId.value, SPREADSHEET_ID);
  for (const n of WF.nodes) {
    assert.notEqual(n.type, 'n8n-nodes-base.scheduleTrigger', 'no schedules');
    assert.notEqual(n.type, 'n8n-nodes-base.webhook', 'no webhooks');
  }
});

test('no outreach side effects, scheduling, enrichment, or provider nodes', () => {
  const types = WF.nodes.map((n) => n.type);
  for (const banned of [
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.twilio',
    'n8n-nodes-base.whatsapp',
    'n8n-nodes-base.slack',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.hunter',
    'n8n-nodes-base.clearbit',
  ]) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }
});

test('no hardcoded secrets or credential material in any node', () => {
  const raw = fs.readFileSync(WF_PATH, 'utf8');
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env var interpolation');
});

test('code nodes contain no staticData, no process.env, no $env usage', () => {
  for (const name of ['Initialize Execution Evidence', 'Reconcile Execution Records']) {
    const code = jsCodeOf(name);
    assert.ok(!code.includes('staticData'), name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), name + ' must not read env');
    assert.ok(!/$env/.test(code), name + ' must not read $env');
  }
});

test('workflow meta is read-only and shipped inactive', () => {
  assert.equal(WF.active, false);
  assert.equal(WF.meta.readOnly, true);
  assert.equal(WF.meta.artifact, 'Execution-Reconciliation V1');
});

test('Initialize Execution Evidence emits exactly one envelope with an empty, ready evidence source', () => {
  const out = executeCode('Initialize Execution Evidence');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json, { execution_reports: [], evidence_available: true });
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                              */
/* ------------------------------------------------------------------ */

test('Reconcile Execution Records returns a two-item output: report then exception envelope', () => {
  const fx = fixtureById('TEST-EXEC-RECON-001');
  const out = executeCode('Reconcile Execution Records', {
    refs: { 'Initialize Execution Evidence': evidenceRef(fx), 'Read Outreach Log': itemsFromRows(fx.outreachRows) },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[1].json.run_id, out[0].json.run_id);
  assert.equal(out[1].json.exception_count, out[0].json.summary.exception_count);
  assert.deepEqual(out[1].json.exceptions, out[0].json.exceptions);
});

test('embedded node and src/execution-reconcile.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const out = executeCode('Reconcile Execution Records', {
      refs: { 'Initialize Execution Evidence': evidenceRef(fx), 'Read Outreach Log': itemsFromRows(fx.outreachRows) },
    });
    const embedded = out[0].json;
    const engine = reconcileExecution({
      executionReports: fx.evidence,
      logRows: fx.outreachRows,
      evidenceAvailable: fx.evidence_available,
      readErrors: fx.read_errors,
      now: new Date('2026-09-11T09:00:00.000Z').getTime(),
    });
    assert.deepEqual(stripRuntime(embedded), stripRuntime(engine), fx.id + ': report');
    assert.deepEqual(stripRuntime(out[1].json), stripRuntime({ run_id: engine.run_id, exception_count: engine.summary.exception_count, exceptions: engine.exceptions }), fx.id + ': envelope');
  }
});

test('embedded node reconciles empty successful sources without dropping the code path', () => {
  const fx = fixtureById('TEST-EXEC-RECON-016');
  const out = executeCode('Reconcile Execution Records', {
    refs: { 'Initialize Execution Evidence': evidenceRef(fx), 'Read Outreach Log': itemsFromRows(fx.outreachRows) },
  });
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.summary.execution_records, 0);
  assert.equal(out[0].json.summary.log_records, 0);
  assert.equal(out[0].json.summary.exception_count, 0);
});

test('embedded node reports INCOMPLETE when evidence is unavailable', () => {
  const fx = fixtureById('TEST-EXEC-RECON-014');
  const out = executeCode('Reconcile Execution Records', {
    refs: { 'Initialize Execution Evidence': evidenceRef(fx), 'Read Outreach Log': itemsFromRows(fx.outreachRows) },
  });
  assert.equal(out[0].json.status, 'INCOMPLETE');
  assert.equal(out[0].json.summary.execution_records, null);
  assert.equal(out[0].json.summary.unmatched_log, null);
});

test('embedded node never fabricates a healthy run for network-style read failures', () => {
  const fx = fixtureById('TEST-EXEC-RECON-017');
  const out = executeCode('Reconcile Execution Records', {
    refs: { 'Initialize Execution Evidence': evidenceRef(fx), 'Read Outreach Log': itemsFromRows(fx.outreachRows) },
  });
  assert.equal(out[0].json.status, 'FAILED');
  assert.equal(out[0].json.summary.log_records, null);
  assert.equal(out[0].json.summary.exception_count, 1);
  assert.equal(out[0].json.exceptions[0].category, 'SOURCE_READ_FAILURE');
});