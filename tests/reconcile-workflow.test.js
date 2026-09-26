'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Run-Reconciliation-and-Reporting V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { reconcileFromSheets, REPORT_FIELDS } = require('../src/reconcile');
const { loadReconFixtures } = require('../src/recon-fixtures');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';

const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Approved Outreach',
  'Read Outreach Log',
  'Reconcile Records',
  'Reconciliation Complete End',
];

const fixtures = loadReconFixtures();

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
  const $input = { all: () => [], item: {} };
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

function runEmbedded(fx, sourceErrors = {}) {
  const approvedRef = sourceErrors.approved
    ? [{ json: { _source_read_error: sourceErrors.approved } }]
    : itemsFromRows(fx.approvedRows);
  const outreachRef = sourceErrors.outreach
    ? [{ json: { _source_read_error: sourceErrors.outreach } }]
    : itemsFromRows(fx.outreachRows);
  return executeCode('Reconcile Records', {
    refs: {
      'Read Approved Outreach': approvedRef,
      'Read Outreach Log': outreachRef,
    },
  });
}

function stripRunFields(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) =>
      ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Structural / importability validation                               */
/* ------------------------------------------------------------------ */

test('workflow has the expected node set with unique names and ids', () => {
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

test('workflow is provider-independent (only manual trigger, read, code, no-op)', () => {
  const types = WF.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.httpRequest'), 'httpRequest must not appear');
  assert.deepEqual(
    new Set(types),
    new Set([
      'n8n-nodes-base.manualTrigger',
      'n8n-nodes-base.googleSheets',
      'n8n-nodes-base.code',
      'n8n-nodes-base.noOp',
    ]),
  );
});

test('workflow is read-only: both sheets nodes read supported tabs on the engine spreadsheet, zero writes', () => {
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 2, 'expected exactly 2 sheets nodes');
  for (const n of sheets) {
    assert.equal(n.parameters.operation, 'read', n.name + ' must be read-only');
    assert.equal(n.parameters.documentId.value, SPREADSHEET_ID, n.name + ' must target engine spreadsheet');
  }
  assert.deepEqual(sheets.map((n) => n.parameters.sheetName.value).sort(), [
    'Approved Outreach',
    'Outreach Log',
  ]);
  const writes = sheets.filter((n) => n.parameters.operation === 'append');
  assert.equal(writes.length, 0, 'reconciliation must not write anywhere');
});

test('no outreach side effects and no scheduling: banned node types are absent', () => {
  const types = WF.nodes.map((n) => n.type);
  for (const banned of [
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.twilio',
    'n8n-nodes-base.whatsapp',
    'n8n-nodes-base.slack',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.httpRequest',
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

test('code node contains no staticData, no process.env, no $env usage', () => {
  const code = jsCodeOf('Reconcile Records');
  assert.ok(!code.includes('staticData'), 'must not use staticData');
  assert.ok(!code.includes('process.env'), 'must not read env');
  assert.ok(!/$env/.test(code), 'must not read $env');
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                             */
/* ------------------------------------------------------------------ */

test('embedded node returns a two-item output: report then exceptions envelope', () => {
  const fx = fixtureById('TEST-RECON-010');
  const out = runEmbedded(fx);
  assert.equal(out.length, 2);
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.exception_count, 5);
  assert.equal(out[1].json.run_id, out[0].json.run_id);
  assert.equal(out[1].json.exception_count, 5);
  assert.deepEqual(out[1].json.exceptions, out[0].json.exceptions);
});

test('embedded report carries the full v1 report contract fields', () => {
  const fx = fixtureById('TEST-RECON-010');
  const report = runEmbedded(fx)[0].json;
  assert.ok(report.run_id);
  assert.ok(report.run_at);
  assert.ok(report.detected_at);
  assert.ok('coverage_rate' in report);
  for (const field of REPORT_FIELDS) {
    assert.ok(field in report, 'report missing contract field: ' + field);
    assert.ok(!(report[field] === undefined), 'field is undefined: ' + field);
  }
  assert.ok(Array.isArray(report.approvals));
  assert.ok(Array.isArray(report.exceptions));
  assert.ok(report.sources.approved_ok === true);
  assert.ok(report.sources.outreach_ok === true);
});

test('embedded mixed fixture matches the expected categories and exception set', () => {
  const fx = fixtureById('TEST-RECON-010');
  const report = runEmbedded(fx)[0].json;
  assert.equal(report.approved_total, 7);
  assert.equal(report.approved_with_outreach, 3);
  assert.equal(report.approved_no_outreach, 3);
  assert.equal(report.coverage_rate, 0.5);
  assert.equal(report.status_mismatches, 2);
  assert.equal(report.exception_count, 5);
  assert.deepEqual(
    report.exceptions.map((e) => e.exception_type),
    ['MALFORMED_APPROVAL', 'MALFORMED_OUTREACH', 'OUTREACH_WITHOUT_APPROVAL', 'STATUS_MISMATCH', 'STATUS_MISMATCH'],
  );
  assert.ok(
    !report.exceptions.some((e) => e.exception_type === 'APPROVED_NO_OUTREACH'),
    'APPROVED_NO_OUTREACH must be a classification, not an exception',
  );
});

test('embedded node marks the run INCOMPLETE on a source read failure (no false zero)', () => {
  const fx = fixtureById('TEST-RECON-009');
  const out = runEmbedded(fx, { approved: 'sheet read failed' });
  const report = out[0].json;
  assert.equal(report.status, 'RECONCILIATION_INCOMPLETE');
  assert.equal(report.approved_total, null);
  assert.equal(report.exception_count, null);
  for (const field of REPORT_FIELDS) {
    assert.equal(report[field], null, field + ' must be null, never a false zero');
  }
  assert.equal(report.sources.approved_ok, false);
  assert.equal(report.sources.approved_read_error, 'sheet read failed');
  assert.deepEqual(report.exceptions, []);
  assert.deepEqual(out[1].json.exceptions, []);
});

test('embedded node and src/reconcile.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const out = runEmbedded(fx);
    const report = out[0].json;
    const { report: engineReport, exceptions: engineExceptions } = reconcileFromSheets({
      approvedRows: fx.approvedRows,
      outreachRows: fx.outreachRows,
      runId: report.run_id,
      now: report.detected_at,
    });
    assert.deepEqual(stripRunFields(report), stripRunFields(engineReport), fx.id + ': report');
    assert.deepEqual(stripRunFields(out[1].json.exceptions), stripRunFields(engineExceptions), fx.id + ': exceptions');
  }
});

test('embedded failure path matches src/reconcile.js failure shape', () => {
  const out = runEmbedded(fixtureById('TEST-RECON-009'), { outreach: 'Outreach Log unavailable' });
  const embedded = out[0].json;
  const { report } = reconcileFromSheets({
    approvedRows: [],
    outreachRows: [],
    sourceErrors: { outreach: 'Outreach Log unavailable' },
    runId: embedded.run_id,
    now: embedded.detected_at,
  });
  assert.deepEqual(stripRunFields(embedded), stripRunFields(report));
});

test('cleanup complexity stays simple: exactly one code node', () => {
  const codeNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  assert.equal(codeNodes.length, 1, 'single Reconcile Records code node');
});