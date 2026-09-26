'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Response-Capture V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { captureFromEvents, RESPONSE_COLUMNS } = require('../src/response-capture');
const { loadResponseCaptureFixtures } = require('../src/response-capture-fixtures');
const { responseCaptureWorkflow, SPREADSHEET_ID } = require('../scripts/build-response-capture-workflow');

const EXPECTED_NODES = [
  'Manual Trigger',
  'Initialize Response Capture',
  'Read Response Log',
  'Capture Inbound Responses',
  'DRY_RUN?',
  'Build Capture Result',
  'Prepare Response Log Write',
  'Write Response Log',
  'Response Capture Complete',
];

const fixtures = loadResponseCaptureFixtures();

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

function captureRefs(fx, opts = {}) {
  return {
    'Initialize Response Capture': [{
      json: {
        mode: opts.mode || fx.mode,
        events: fx.events,
        identity_lookup: fx.identity_lookup,
        response_log_read_error: opts.readError || '',
      },
    }],
    'Read Response Log': itemsFromRows(fx.initialResponseRows),
  };
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

/* ------------------------------------------------------------------ */
/* Structural / importability validation                               */
/* ------------------------------------------------------------------ */

test('workflow has exactly 9 nodes with the exact expected names and unique ids', () => {
  const names = WF.nodes.map((n) => n.name);
  assert.equal(names.length, 9, 'expected exactly 9 nodes');
  assert.deepEqual(new Set(names).size, names.length, 'node names must be unique');
  assert.deepEqual([...new Set(names)].sort(), [...EXPECTED_NODES].sort());
  const ids = WF.nodes.map((n) => n.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'node ids must be unique');
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

test('trigger is Manual Trigger and workflow is shipped inactive', () => {
  assert.equal(byName('Manual Trigger').type, 'n8n-nodes-base.manualTrigger');
  assert.equal(WF.active, false);
  assert.equal(WF.meta.artifact, 'Response-Capture V1');
  assert.equal(WF.meta.spreadsheetId, SPREADSHEET_ID);
  assert.equal(WF.meta.defaultMode, 'DRY_RUN');
  assert.equal(WF.meta.generatedBy, 'scripts/build-response-capture-workflow.js');
});

test('exactly one sheet read (Response Log) and one append (Response Log, the only write surface)', () => {
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 2, 'exactly two sheet nodes');
  const reads = sheets.filter((n) => n.parameters.operation === 'read');
  const appends = sheets.filter((n) => n.parameters.operation === 'append');
  assert.equal(reads.length, 1);
  assert.equal(appends.length, 1);
  assert.equal(reads[0].parameters.sheetName.value, 'Response Log');
  assert.equal(appends[0].parameters.sheetName.value, 'Response Log');
  assert.equal(reads[0].parameters.documentId.value, SPREADSHEET_ID);
  assert.equal(appends[0].parameters.documentId.value, SPREADSHEET_ID);
  assert.equal(appends[0].name, 'Write Response Log');
});

test('no send, scheduling, webhook, provider, or enrichment nodes', () => {
  const types = WF.nodes.map((n) => n.type);
  for (const banned of [
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.twilio',
    'n8n-nodes-base.whatsapp',
    'n8n-nodes-base.slack',
    'n8n-nodes-base.httpRequest',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.intervalTrigger',
    'n8n-nodes-base.cron',
  ]) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }
});

test('no hardcoded secrets, bearer tokens, or credentials in the workflow', () => {
  const raw = fs.readFileSync(WF_PATH, 'utf8');
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env var interpolation');
  assert.ok(!/api_?key|secret|password/i.test(raw), 'no api key/secret/password material');
});

test('code nodes contain no staticData, no process.env, no $env usage', () => {
  for (const name of ['Initialize Response Capture', 'Capture Inbound Responses', 'Prepare Response Log Write']) {
    const code = jsCodeOf(name);
    assert.ok(!code.includes('staticData'), name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), name + ' must not read env');
    assert.ok(!/$env/.test(code), name + ' must not read $env');
  }
});

test('builder output is deterministic and matches the shipped workflow file', () => {
  const a = JSON.parse(JSON.stringify(responseCaptureWorkflow()));
  const b = JSON.parse(JSON.stringify(responseCaptureWorkflow()));
  assert.deepEqual(a, b, 'builder output must be identical across calls');
  assert.deepEqual(WF, a, 'shipped workflow must equal builder output');
});

/* ------------------------------------------------------------------ */
/* DRY_RUN gate topology                                               */
/* ------------------------------------------------------------------ */

test('DRY_RUN? IF condition compares mode against DRY_RUN with string equality', () => {
  const ifNode = byName('DRY_RUN?');
  assert.equal(ifNode.type, 'n8n-nodes-base.if');
  const cond = ifNode.parameters.conditions;
  assert.equal(cond.combinator, 'and');
  assert.equal(cond.conditions.length, 1);
  assert.equal(cond.conditions[0].leftValue, '={{ $json.mode }}');
  assert.equal(cond.conditions[0].rightValue, 'DRY_RUN');
  assert.deepEqual(cond.conditions[0].operator, { type: 'string', operation: 'equals' });
});

test('true branch (DRY_RUN) leads only to Build Capture Result, never to a write', () => {
  const branches = WF.connections['DRY_RUN?'].main;
  assert.equal(branches.length, 2);
  assert.deepEqual(branches[0].map((e) => e.node), ['Build Capture Result']);
  assert.deepEqual(branches[1].map((e) => e.node), ['Prepare Response Log Write']);
  // graceful check: no path from Build Capture Result to Write Response Log
  const writeReachableFromBuild = (WF.connections['Build Capture Result'] || { main: [[]] }).main
    .flat().map((e) => e.node);
  assert.ok(!writeReachableFromBuild.includes('Write Response Log'));
});

test('false branch (REAL) reaches exactly the single Write Response Log node', () => {
  const branches = WF.connections['DRY_RUN?'].main;
  const falseTo = branches[1].map((e) => e.node);
  assert.deepEqual(falseTo, ['Prepare Response Log Write']);
  const prepareTo = WF.connections['Prepare Response Log Write'].main.flat().map((e) => e.node);
  assert.deepEqual(prepareTo, ['Write Response Log']);
  const writeTo = WF.connections['Write Response Log'].main.flat().map((e) => e.node);
  assert.deepEqual(writeTo, ['Response Capture Complete']);
});

test('Capture Inbound Responses joins Initialize + Read and always emits exactly one item', () => {
  const out = executeCode('Capture Inbound Responses');
  assert.equal(out.length, 1, 'exactly one report item');
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.summary.events_processed, 0);
});

/* ------------------------------------------------------------------ */
/* Embedded implementation presence                                    */
/* ------------------------------------------------------------------ */

test('Capture Inbound Responses embeds the response capture implementation', () => {
  const code = jsCodeOf('Capture Inbound Responses');
  assert.ok(code.includes("$('Initialize Response Capture').all()"), 'reads init envelope');
  assert.ok(code.includes("$('Read Response Log').all()"), 'reads response log');
  assert.ok(code.includes('fnv1a32Hex'), 'embeds deterministic FNV response ids');
  assert.ok(code.includes('idempotency_key') && code.includes("provider_message_id || event_id") === false);
});

test('Prepare Response Log Write embeds the RESPONSE_COLUMNS mapping', () => {
  const code = jsCodeOf('Prepare Response Log Write');
  const out = executeCode('Prepare Response Log Write', {
    refs: { 'Capture Inbound Responses': [{ json: { response_rows: [{ idempotency_key: 'k', lead_id: 'L' }] } }] },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.lead_id, 'L');
  assert.equal(out[0].json.idempotency_key, 'k');
  assert.deepEqual(Object.keys(out[0].json).sort(), [...RESPONSE_COLUMNS].sort());
});

test('embedded response columns match canonical RESPONSE_COLUMNS', () => {
  const { RESPONSE_COLUMNS_EMBEDDED } = require('../src/embedded-response-capture');
  assert.deepEqual(RESPONSE_COLUMNS_EMBEDDED, RESPONSE_COLUMNS);
});

test('Initialize Response Capture emits exactly one default DRY_RUN envelope', () => {
  const out = executeCode('Initialize Response Capture');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json, {
    mode: 'DRY_RUN',
    events: [],
    identity_lookup: {},
    response_log_read_error: '',
  });
});

/* ------------------------------------------------------------------ */
/* Embedded <> engine parity                                           */
/* ------------------------------------------------------------------ */

test('embedded node and src/response-capture.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const out = executeCode('Capture Inbound Responses', { refs: captureRefs(fx) });
    const embedded = out[0].json;
    const engine = captureFromEvents({
      events: fx.events,
      responseRows: fx.initialResponseRows,
      identityLookup: fx.identity_lookup,
      mode: fx.mode,
      now: new Date('2026-09-11T09:00:00.000Z').getTime(),
    });
    assert.deepEqual(stripRuntime(embedded), stripRuntime(engine), fx.id + ': report');
  }
});

test('embedded read-error path mirrors the engine FAILED report (never a false zero)', () => {
  const fx = fixtureById('TEST-RESP-016');
  const out = executeCode('Capture Inbound Responses', { refs: captureRefs(fx, { readError: 'Response Log sheet unavailable' }) });
  const embedded = out[0].json;
  assert.equal(embedded.status, 'FAILED');
  assert.equal(embedded.sources.response_log_ok, false);
  assert.equal(embedded.sources.response_log_read_error, 'Response Log sheet unavailable');
  for (const field of ['events_processed', 'captured', 'unmatched', 'invalid', 'duplicate', 'staged', 'persisted']) {
    assert.equal(embedded.summary[field], null, field + ' must be null on read failure');
  }
  assert.equal(embedded.summary.exception_count, 1);
  assert.equal(embedded.exceptions[0].category, 'SOURCE_READ_FAILURE');
});

test('embedded DRY_RUN zero-item Response Log still executes (always-output pattern)', () => {
  const fx = fixtureById('TEST-RESP-015');
  const out = executeCode('Capture Inbound Responses', {
    refs: {
      'Initialize Response Capture': [{ json: { mode: 'DRY_RUN', events: fx.events, identity_lookup: {}, response_log_read_error: '' } }],
      'Read Response Log': [],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.mode, 'DRY_RUN');
  assert.deepEqual(out[0].json.response_rows, [], 'DRY_RUN must never emit write rows');
});