'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Response-Reconciliation V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { reconcileResponses } = require('../src/response-reconcile');
const { loadResponseReconcileFixtures } = require('../src/response-reconcile-fixtures');
const { responseReconciliationWorkflow } = require('../scripts/build-response-reconciliation-workflow');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Response Log',
  'Read Outreach Log',
  'Reconcile Responses',
  'Response Reconciliation Complete',
];

const FIXED_NOW = new Date('2026-09-11T09:00:00.000Z').getTime();
const fixtures = loadResponseReconcileFixtures();

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

function triggerRef(fx) {
  return [{
    json: {
      response_log_read_error: fx.response_read_error || '',
      outreach_log_read_error: fx.outreach_read_error || '',
    },
  }];
}

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

/* ------------------------------------------------------------------ */
/* Structural / importability validation                               */
/* ------------------------------------------------------------------ */

test('workflow has exactly the expected 5-node read-only set with unique names and ids', () => {
  const names = WF.nodes.map((n) => n.name);
  assert.deepEqual(new Set(names).size, names.length, 'node names must be unique');
  assert.deepEqual([...new Set(names)].sort(), [...EXPECTED_NODES].sort());
  const ids = WF.nodes.map((n) => n.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'node ids must be unique');
  assert.equal(names.length, 5, 'expected exactly 5 nodes');
  assert.ok(!names.includes('Initialize Execution Evidence'), 'response reconciliation must NOT have an initialization node');
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

test('the Manual Trigger fans out to exactly both read nodes and nothing else', () => {
  const fanout = WF.connections['Manual Trigger'].main.map((branch) => branch.map((e) => e.node));
  assert.deepEqual(fanout, [['Read Response Log'], ['Read Outreach Log']]);
});

test('read nodes feed Reconcile Responses which feeds only the completion node', () => {
  const readConns = WF.connections['Read Response Log'].main.map((branch) => branch.map((e) => e.node));
  const readConns2 = WF.connections['Read Outreach Log'].main.map((branch) => branch.map((e) => e.node));
  const reconConns = WF.connections['Reconcile Responses'].main.map((branch) => branch.map((e) => e.node));
  assert.deepEqual(readConns, [['Reconcile Responses']]);
  assert.deepEqual(readConns2, [['Reconcile Responses']]);
  assert.deepEqual(reconConns, [['Response Reconciliation Complete']]);
});

test('workflow is read-only: exactly two googleSheets reads, no writes, no execution', () => {
  const types = WF.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.httpRequest'), 'httpRequest must not appear');
  assert.deepEqual(
    new Set(types),
    new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.googleSheets', 'n8n-nodes-base.code', 'n8n-nodes-base.noOp']),
  );
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 2, 'exactly two sheet nodes (Response Log + Outreach Log reads)');
  const sheetNames = sheets.map((s) => s.parameters.sheetName.value).sort();
  assert.deepEqual(sheetNames, ['Outreach Log', 'Response Log']);
  for (const s of sheets) {
    assert.equal(s.parameters.operation, 'read');
    assert.equal(s.parameters.documentId.value, SPREADSHEET_ID);
  }
  for (const n of WF.nodes) {
    assert.notEqual(n.type, 'n8n-nodes-base.scheduleTrigger', 'no schedules');
    assert.notEqual(n.type, 'n8n-nodes-base.webhook', 'no webhooks');
  }
});

test('no outreach side effects, scheduling, enrichment, provider, or AI nodes', () => {
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
    '@n8n/n8n-nodes-langchain.chatOpenAI',
    'n8n-nodes-base.openAi',
  ]) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }
});

test('no hardcoded secrets or credential material in any node', () => {
  const raw = fs.readFileSync(WF_PATH, 'utf8');
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env var interpolation');
  assert.ok(!raw.includes('credentials'), 'no embedded credential blocks');
});

test('code nodes contain no staticData, no process.env, no $env usage', () => {
  for (const name of ['Reconcile Responses']) {
    const code = jsCodeOf(name);
    assert.ok(!code.includes('staticData'), name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), name + ' must not read env');
    assert.ok(!/$env/.test(code), name + ' must not read $env');
  }
});

test('workflow meta is read-only and shipped inactive with empty-read and error-carrier documentation', () => {
  assert.equal(WF.active, false);
  assert.equal(WF.meta.readOnly, true);
  assert.equal(WF.meta.artifact, 'Response-Reconciliation V1');
  assert.deepEqual(WF.meta.sheets, ['Response Log', 'Outreach Log']);
  assert.match(WF.meta.readErrorsCarriedBy, /Manual Trigger/);
  assert.match(WF.meta.emptyReadBehavior, /alwaysOutputData/);
});

test('the Reconcile Responses node sets alwaysOutputData so empty reads still execute', () => {
  const node = byName('Reconcile Responses');
  assert.equal(node.type, 'n8n-nodes-base.code');
  assert.equal(node.alwaysOutputData, true);
});

test('deterministic build: the builder output byte-matches the shipped workflow file', () => {
  const rebuilt = responseReconciliationWorkflow();
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(fs.readFileSync(WF_PATH, 'utf8')));
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                              */
/* ------------------------------------------------------------------ */

test('Reconcile Responses returns a two-item output: report then exception envelope', () => {
  const fx = fixtureById('TEST-RESP-RECON-001');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Manual Trigger': triggerRef(fx),
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[1].json.run_id, out[0].json.run_id);
  assert.equal(out[1].json.exception_count, out[0].json.summary.exception_count);
  assert.deepEqual(out[1].json.exceptions, out[0].json.exceptions);
});

test('embedded node and src/response-reconcile.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const out = executeCode('Reconcile Responses', {
      refs: {
        'Manual Trigger': triggerRef(fx),
        'Read Response Log': itemsFromRows(fx.initialResponseRows),
        'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
      },
    });
    const embedded = out[0].json;
    const engine = reconcileResponses({
      responseRows: fx.initialResponseRows,
      outreachRows: fx.initialOutreachRows,
      responseReadError: fx.response_read_error,
      outreachReadError: fx.outreach_read_error,
      now: FIXED_NOW,
    });
    assert.deepEqual(stripRuntime(embedded), stripRuntime(engine), fx.id + ': report');
    assert.deepEqual(
      stripRuntime(out[1].json),
      stripRuntime({ run_id: engine.run_id, exception_count: engine.summary.exception_count, exceptions: engine.exceptions }),
      fx.id + ': envelope',
    );
  }
});

test('embedded node reconciles empty successful sources to COMPLETED with valid zero metrics', () => {
  const fx = fixtureById('TEST-RESP-RECON-012');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Manual Trigger': triggerRef(fx),
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.summary.response_records, 0);
  assert.equal(out[0].json.summary.matched_records, 0);
  assert.equal(out[0].json.summary.exception_count, 0);
});

test('embedded node reads read-failure metadata from the Manual Trigger and reports INCOMPLETE', () => {
  const fx = fixtureById('TEST-RESP-RECON-014');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Manual Trigger': triggerRef(fx),
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out[0].json.status, 'INCOMPLETE');
  for (const field of [
    'response_records', 'matched_records', 'unmatched_records', 'linked_records',
    'not_verifiable', 'invalid_records', 'duplicate_records', 'violations', 'coverage_rate',
  ]) {
    assert.equal(out[0].json.summary[field], null, 'summary.' + field + ' must be null on read failure');
  }
  assert.equal(out[0].json.results.length, 0);
  assert.deepEqual(out[0].json.exceptions.map((e) => e.category), ['READ_FAILURE']);
});

test('embedded node emits exactly one READ_FAILURE exception per failed source', () => {
  const fx = fixtureById('TEST-RESP-RECON-015');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Manual Trigger': triggerRef(fx),
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out[0].json.status, 'INCOMPLETE');
  assert.equal(out[0].json.summary.exception_count, 2);
  assert.deepEqual(out[0].json.exceptions.map((e) => e.category), ['READ_FAILURE', 'READ_FAILURE']);
  const sources = out[0].json.sources;
  assert.equal(sources.response_log_ok, false);
  assert.equal(sources.outreach_log_ok, false);
  assert.equal(sources.response_log_read_error, 'NetworkError');
  assert.equal(sources.outreach_log_read_error, 'SheetNotFound');
});

test('absent trigger metadata defaults to healthy sources', () => {
  const fx = fixtureById('TEST-RESP-RECON-001');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.sources.response_log_ok, true);
  assert.equal(out[0].json.sources.outreach_log_ok, true);
});

test('embedded node never fabricates a healthy run for read failures', () => {
  const fx = fixtureById('TEST-RESP-RECON-013');
  const out = executeCode('Reconcile Responses', {
    refs: {
      'Manual Trigger': triggerRef(fx),
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Outreach Log': itemsFromRows(fx.initialOutreachRows),
    },
  });
  assert.equal(out[0].json.status, 'INCOMPLETE');
  assert.equal(out[0].json.summary.response_records, null);
  assert.equal(out[0].json.summary.exception_count, 1);
  assert.equal(out[0].json.exceptions[0].category, 'READ_FAILURE');
  assert.match(JSON.stringify(out[0].json.exceptions[0].evidence), /outreach log/);
});