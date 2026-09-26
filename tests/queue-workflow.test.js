'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Outreach-Queue-and-Planning V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { buildQueueFromSheets, QUEUE_FIELDS, REPORT_FIELDS } = require('../src/queue');
const { loadQueueFixtures } = require('../src/queue-fixtures');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';

const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Approved Outreach',
  'Read Outreach Log',
  'Build Queue',
  'Outreach Queue Complete',
];

const fixtures = loadQueueFixtures();

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

function runEmbedded(fx, sourceErrors = {}, useTransition = false) {
  const approvedRows = useTransition ? fx.transition.approvedRows : fx.approvedRows;
  const outreachRows = useTransition ? fx.transition.outreachRows : fx.outreachRows;
  const approvedRef = sourceErrors.approved
    ? [{ json: { _source_read_error: sourceErrors.approved } }]
    : itemsFromRows(approvedRows);
  const outreachRef = sourceErrors.outreach
    ? [{ json: { _source_read_error: sourceErrors.outreach } }]
    : itemsFromRows(outreachRows);
  return executeCode('Build Queue', {
    refs: {
      'Read Approved Outreach': approvedRef,
      'Read Outreach Log': outreachRef,
    },
  });
}

function stripRunFields(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) =>
      ['run_id', 'run_at', 'queued_at'].includes(key) ? undefined : val,
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

test('workflow is read-only: both sheets nodes read the engine spreadsheet, zero writes', () => {
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
  const writes = sheets.filter((n) => n.parameters.operation !== 'read');
  assert.equal(writes.length, 0, 'queue planning must not write anywhere');
});

test('no outreach side effects, no scheduling, no enrichment: banned node types are absent', () => {
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

test('code node contains no staticData, no process.env, no $env usage', () => {
  const code = jsCodeOf('Build Queue');
  assert.ok(!code.includes('staticData'), 'must not use staticData');
  assert.ok(!code.includes('process.env'), 'must not read env');
  assert.ok(!/$env/.test(code), 'must not read $env');
});

test('exactly one code node keeps the algorithm single-sourced', () => {
  const codeNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
  assert.equal(codeNodes.length, 1, 'single Build Queue code node');
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                             */
/* ------------------------------------------------------------------ */

test('embedded node returns a two-item output: queue report then exceptions envelope', () => {
  const fx = fixtureById('TEST-QUEUE-006');
  const out = runEmbedded(fx);
  assert.equal(out.length, 2);
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.queue_total, 1);
  assert.equal(out[1].json.run_id, out[0].json.run_id);
  assert.equal(out[1].json.exception_count, out[0].json.exception_count);
  assert.deepEqual(out[1].json.exceptions, out[0].json.exceptions);
});

test('embedded report carries the full queue + report contract fields', () => {
  const fx = fixtureById('TEST-QUEUE-001');
  const report = runEmbedded(fx)[0].json;
  assert.ok(report.run_id);
  assert.ok(report.run_at);
  assert.ok(report.queued_at);
  assert.equal(report.status, 'COMPLETED');
  for (const field of QUEUE_FIELDS) {
    const item = report.queue[0];
    assert.ok(field in item, `queue item missing contract field: ${field}`);
    assert.ok(!(item[field] === undefined), `queue field is undefined: ${field}`);
  }
  for (const field of REPORT_FIELDS) {
    assert.ok(field in report, 'report missing contract field: ' + field);
    assert.ok(!(report[field] === undefined), 'field is undefined: ' + field);
  }
  assert.ok(Array.isArray(report.queue));
  assert.ok(Array.isArray(report.exceptions));
  assert.ok(report.sources.approved_ok === true);
  assert.ok(report.sources.outreach_ok === true);
});

test('embedded history fixture surfaces count, last sent_at, latest channel/outcome', () => {
  const fx = fixtureById('TEST-QUEUE-006');
  const report = runEmbedded(fx)[0].json;
  const item = report.queue[0];
  assert.equal(item.outreach_count, 2);
  assert.equal(item.last_outreach_at, '2026-09-12T14:30:00.000Z');
  assert.equal(item.latest_channel, 'call');
  assert.equal(item.latest_outcome, 'call_booked');
});

test('embedded node marks the run INCOMPLETE on a source read failure (no false healthy)', () => {
  const fx = fixtureById('TEST-QUEUE-012');
  const out = runEmbedded(fx, { approved: 'sheet read failed' });
  const report = out[0].json;
  assert.equal(report.status, 'QUEUE_INCOMPLETE');
  for (const field of REPORT_FIELDS) {
    assert.equal(report[field], null, field + ' must be null, never a false zero');
  }
  assert.equal(report.sources.approved_ok, false);
  assert.equal(report.sources.approved_read_error, 'sheet read failed');
  assert.deepEqual(report.queue, []);
  assert.deepEqual(report.exceptions, []);
  assert.deepEqual(out[1].json.exceptions, []);
});

test('embedded node and src/queue.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const out = runEmbedded(fx);
    const report = out[0].json;
    const { report: engineReport, exceptions: engineExceptions } = buildQueueFromSheets({
      approvedRows: fx.approvedRows,
      outreachRows: fx.outreachRows,
      runId: report.run_id,
      now: report.queued_at,
    });
    assert.deepEqual(stripRunFields(report), stripRunFields(engineReport), fx.id + ': report');
    assert.deepEqual(stripRunFields(out[1].json.exceptions), stripRunFields(engineExceptions), fx.id + ': exceptions');
  }
});

test('embedded node stays in sync with src/queue.js on every transition stage', () => {
  const withTransition = fixtures.filter((f) => f.transition && f.transition.approvedRows.length);
  assert.ok(withTransition.length >= 1, 'at least one transition fixture exists');
  for (const fx of withTransition) {
    const out = runEmbedded(fx, {}, true);
    const report = out[0].json;
    const { report: engineReport } = buildQueueFromSheets({
      approvedRows: fx.transition.approvedRows,
      outreachRows: fx.transition.outreachRows,
      runId: report.run_id,
      now: report.queued_at,
    });
    assert.deepEqual(
      stripRunFields(report).queue,
      stripRunFields(engineReport).queue,
      fx.id + ': transition queue',
    );
    assert.equal(engineReport.queue[0].readiness_status, 'READY');
    assert.equal(engineReport.queue[0].available_channel, 'email');
  }
});

test('embedded failure path matches src/queue.js failure shape', () => {
  const out = runEmbedded(fixtureById('TEST-QUEUE-012'), { outreach: 'Outreach Log unavailable' });
  const embedded = out[0].json;
  const { report } = buildQueueFromSheets({
    approvedRows: [],
    outreachRows: [],
    approvedError: '',
    outreachError: 'Outreach Log unavailable',
    runId: embedded.run_id,
    now: embedded.queued_at,
  });
  assert.deepEqual(stripRunFields(embedded), stripRunFields(report));
});

test('embedded queue never implies outreach was sent for a READY lead', () => {
  const fx = fixtureById('TEST-QUEUE-001');
  const item = runEmbedded(fx)[0].json.queue[0];
  assert.equal(item.readiness_status, 'READY');
  assert.equal(item.outreach_count, 0);
  assert.equal(item.last_outreach_at, '');
});