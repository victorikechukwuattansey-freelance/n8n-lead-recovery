'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WF_PATH = path.join(__dirname, '..', 'Response-Interpretation V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const {
  FIXED_NOW,
  assertWorkflowContract,
  assertCleanSource,
  engineBehaviorFor,
  stripRuntime,
} = require('../src/response-interpretation-workflow-contract');
const { reconcileResponses } = require('../src/response-reconcile');
const { loadResponseInterpretationFixtures } = require('../src/response-interpretation-fixtures');
const { responseInterpretationWorkflow } = require('../scripts/build-response-interpretation-workflow');
const {
  interpretCode,
  relayCode,
  embeddedSource,
} = require('../src/embedded-response-interpret');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Response Log',
  'Read Reconciliation Report',
  'Interpret Responses',
  'Response Interpretation Complete',
];

const fixtures = loadResponseInterpretationFixtures();

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

function reportFor(fx) {
  if (fx.upstreamIncomplete) return { status: 'INCOMPLETE', results: [] };
  if (fx.responseReadError || fx.reconciliationReadError) return { status: 'COMPLETED', results: [] };
  return reconcileResponses({
    responseRows: fx.reconcileResponseRows || [],
    outreachRows: fx.reconcileOutreachRows || [],
    now: FIXED_NOW,
    runId: 'RESPRECON-FIXED',
  });
}

function triggerItemsFor(fx) {
  return [
    {
      json: {
        event: '',
        reconciliation_report: reportFor(fx),
        response_log_read_error: fx.responseReadError || '',
        reconciliation_read_error: fx.reconciliationReadError || '',
      },
    },
  ];
}

function runInterpretChain(fx) {
  const triggerItems = triggerItemsFor(fx);
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  const out = executeCode('Interpret Responses', {
    refs: {
      'Manual Trigger': triggerItems,
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Reconciliation Report': relayOut,
    },
  });
  if (out.length !== 2) throw new Error(fx.id + ': expected two-item output');
  return { relay: relayOut[0].json, report: out[0].json, envelope: out[1].json };
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
  assert.ok(!names.includes('Initialize Execution Evidence'), 'response interpretation must NOT have an initialization node');
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

test('the topology is a strict chain starting at Manual Trigger', () => {
  const fanout = WF.connections['Manual Trigger'].main.map((branch) => branch.map((e) => e.node));
  assert.deepEqual(fanout, [['Read Reconciliation Report']]);
});

test('read nodes flow through the chain into Interpret Responses and the completion node', () => {
  const reconRead = WF.connections['Read Reconciliation Report'].main.map((branch) => branch.map((e) => e.node));
  const responseRead = WF.connections['Read Response Log'].main.map((branch) => branch.map((e) => e.node));
  const interpretConns = WF.connections['Interpret Responses'].main.map((branch) => branch.map((e) => e.node));
  assert.deepEqual(reconRead, [['Read Response Log']]);
  assert.deepEqual(responseRead, [['Interpret Responses']]);
  assert.deepEqual(interpretConns, [['Response Interpretation Complete']]);
});

test('workflow is read-only: exactly one googleSheets read, no writes, no execution', () => {
  const types = WF.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.httpRequest'), 'httpRequest must not appear');
  assert.deepEqual(
    new Set(types),
    new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.googleSheets', 'n8n-nodes-base.code', 'n8n-nodes-base.noOp']),
  );
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 1, 'exactly one sheet node (Response Log read only)');
  const sheet = sheets[0];
  assert.equal(sheet.parameters.sheetName.value, 'Response Log');
  assert.equal(sheet.parameters.operation, 'read');
  assert.equal(sheet.parameters.documentId.value, SPREADSHEET_ID);
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
  for (const name of ['Interpret Responses', 'Read Reconciliation Report']) {
    const code = jsCodeOf(name);
    assert.ok(!code.includes('staticData'), name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), name + ' must not read env');
    assert.ok(!/$env/.test(code), name + ' must not read $env');
  }
});

test('workflow meta is read-only and shipped inactive with empty-read and error-carrier documentation', () => {
  assert.equal(WF.active, false);
  assert.equal(WF.meta.readOnly, true);
  assert.equal(WF.meta.artifact, 'Response-Interpretation V1');
  assert.deepEqual(WF.meta.sheets, ['Response Log']);
  assert.match(WF.meta.readErrorsCarriedBy, /Manual Trigger/);
  assert.match(WF.meta.readErrorsCarriedBy, /response_log_read_error/);
  assert.match(WF.meta.readErrorsCarriedBy, /reconciliation_read_error/);
  assert.match(WF.meta.emptyReadBehavior, /alwaysOutputData/);
});

test('both code nodes set alwaysOutputData so empty reads still execute', () => {
  for (const name of ['Interpret Responses', 'Read Reconciliation Report']) {
    const node = byName(name);
    assert.equal(node.type, 'n8n-nodes-base.code');
    assert.equal(node.alwaysOutputData, true, name + ' must set alwaysOutputData');
  }
});

test('embedded code matches the source modules exactly', () => {
  assert.equal(byName('Interpret Responses').parameters.jsCode, interpretCode);
  assert.equal(byName('Read Reconciliation Report').parameters.jsCode, relayCode);
  assert.equal(embeddedSource, interpretCode);
});

test('deterministic build: the builder output byte-matches the shipped workflow file and passes the contract validator', () => {
  const rebuilt = responseInterpretationWorkflow();
  const shipped = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), shipped);
  assert.equal(
    fs.readFileSync(WF_PATH, 'utf8'),
    JSON.stringify(responseInterpretationWorkflow(), null, 2) + '\n',
    'rebuild must be byte-identical',
  );
  const hashOf = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  assert.equal(hashOf(fs.readFileSync(WF_PATH, 'utf8')), hashOf(JSON.stringify(rebuilt, null, 2) + '\n'));
  assert.doesNotThrow(() => assertWorkflowContract(shipped), 'contract validator must accept shipped workflow');
});

test('assertCleanSource accepts both embedded code bodies', () => {
  assert.doesNotThrow(() => assertCleanSource(jsCodeOf('Interpret Responses')));
  assert.doesNotThrow(() => assertCleanSource(jsCodeOf('Read Reconciliation Report')));
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                              */
/* ------------------------------------------------------------------ */

test('the relay passes a healthy injected report through unchanged', () => {
  const fx = fixtureById('TEST-RESP-INT-001');
  const triggerItems = triggerItemsFor(fx);
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  assert.equal(relayOut.length, 1);
  assert.deepEqual(relayOut[0].json, triggerItems[0].json.reconciliation_report);
  assert.equal(relayOut[0].json.status, 'COMPLETED');
  assert.ok(Array.isArray(relayOut[0].json.results));
});

test('the relay defaults to a healthy empty report when trigger items are absent', () => {
  const relayOut = executeCode('Read Reconciliation Report', { refs: {} });
  assert.equal(relayOut.length, 1);
  assert.deepEqual(relayOut[0].json, { status: 'COMPLETED', results: [] });
});

test('the relay passes a non-COMPLETED upstream report through unchanged', () => {
  const fx = fixtureById('TEST-RESP-INT-024');
  const triggerItems = triggerItemsFor(fx);
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  assert.deepEqual(relayOut[0].json, triggerItems[0].json.reconciliation_report);
  assert.equal(relayOut[0].json.status, 'INCOMPLETE');
});

test('the relay carries reconciliation_read_error metadata onto the outgoing payload', () => {
  const triggerItems = [{ json: { event: '', reversal: 'x' } }];
  const report = { status: 'COMPLETED', results: [{ response_id: 'RESP-1' }] };
  const relayOut = executeCode('Read Reconciliation Report', {
    refs: {
      'Manual Trigger': [
        { json: { reconciliation_report: report, reconciliation_read_error: 'SheetNotFound' } },
        ...triggerItems,
      ],
    },
  });
  assert.equal(relayOut[0].json.status, 'COMPLETED');
  assert.equal(relayOut[0].json.reconciliation_read_error, 'SheetNotFound');
  assert.deepEqual(relayOut[0].json.results, report.results);
});

test('Interpret Responses returns a two-item output: report then exception envelope', () => {
  const fx = fixtureById('TEST-RESP-INT-001');
  const { report, envelope } = runInterpretChain(fx);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(envelope.run_id, report.run_id);
  assert.equal(envelope.exception_count, report.summary.exception_count);
  assert.deepEqual(envelope.exceptions, report.exceptions);
});

test('Interpret Responses run_id has the RESPINT shape and matches its envelope', () => {
  const fx = fixtureById('TEST-RESP-INT-021');
  const { report, envelope } = runInterpretChain(fx);
  assert.match(report.run_id, /^RESPINT-\d{14}$/);
  assert.equal(envelope.run_id, report.run_id);
});

test('absent trigger metadata defaults to healthy COMPLETED interpretation', () => {
  const fx = fixtureById('TEST-RESP-INT-001');
  const triggerItems = [{ json: { event: '' } }];
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  const out = executeCode('Interpret Responses', {
    refs: {
      'Manual Trigger': triggerItems,
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Reconciliation Report': relayOut,
    },
  });
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.sources.response_log_ok, true);
  assert.equal(out[0].json.sources.reconciliation_ok, true);
});

test('embedded node and src/response-interpretation.js stay in sync on every fixture', () => {
  for (const fx of fixtures) {
    const { report, envelope } = runInterpretChain(fx);
    const engine = engineBehaviorFor(fx);
    assert.deepEqual(stripRuntime(report), stripRuntime(engine), fx.id + ': report');
    assert.deepEqual(
      stripRuntime(envelope),
      stripRuntime({ run_id: engine.run_id, exception_count: engine.summary.exception_count, exceptions: engine.exceptions }),
      fx.id + ': envelope',
    );
  }
});

test('healthy empty reads yield COMPLETED with valid zero metrics', () => {
  const triggerItems = [{ json: { event: '' } }];
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  const out = executeCode('Interpret Responses', {
    refs: {
      'Manual Trigger': triggerItems,
      'Read Response Log': [],
      'Read Reconciliation Report': relayOut,
    },
  });
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.summary.response_records, 0);
  assert.equal(out[0].json.summary.interpreted_records, 0);
  assert.equal(out[0].json.summary.skipped_records, 0);
  assert.equal(out[0].json.summary.coverage_rate, null);
  assert.equal(out[0].json.summary.exception_count, 0);
  assert.deepEqual(out[0].json.results, []);
  assert.deepEqual(out[0].json.exceptions, []);
});

test('fixture 024: an upstream INCOMPLETE reconciliation report surfaces as an honest INCOMPLETE run', () => {
  const fx = fixtureById('TEST-RESP-INT-024');
  const { report, envelope } = runInterpretChain(fx);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.response_log_ok, true);
  assert.equal(report.sources.reconciliation_ok, false);
  assert.equal(report.sources.reconciliation_read_error, 'reconciliation upstream state INCOMPLETE');
  assert.equal(report.summary.exception_count, 1);
  assert.deepEqual(report.exceptions.map((e) => e.category), ['READ_FAILURE']);
  assert.match(JSON.stringify(report.exceptions[0].evidence), /reconciliation report/);
  assert.equal(envelope.run_id, report.run_id);
});

test('fixture 025: a response-log read failure surfaces as INCOMPLETE with a nulled summary', () => {
  const fx = fixtureById('TEST-RESP-INT-025');
  const { report } = runInterpretChain(fx);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.response_log_ok, false);
  assert.equal(report.sources.response_log_read_error, 'SheetNotFound');
  assert.equal(report.sources.reconciliation_ok, true);
  for (const field of [
    'response_records', 'interpreted_records', 'skipped_records', 'by_intent',
    'by_confidence_band', 'by_actionability', 'stop_contact_count', 'manual_review_count',
    'conflict_count', 'coverage_rate',
  ]) {
    assert.equal(report.summary[field], null, 'summary.' + field + ' must be null on read failure');
  }
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.results.length, 0);
  assert.deepEqual(report.exceptions.map((e) => e.category), ['READ_FAILURE']);
});

test('fixture 026: a reconciliation-report read failure surfaces as INCOMPLETE', () => {
  const fx = fixtureById('TEST-RESP-INT-026');
  const { report } = runInterpretChain(fx);
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.response_log_ok, true);
  assert.equal(report.sources.reconciliation_ok, false);
  assert.equal(report.sources.reconciliation_read_error, 'SheetNotFound');
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.results.length, 0);
  assert.match(JSON.stringify(report.exceptions[0].evidence), /reconciliation report/);
});

test('a composed double read failure emits exactly one READ_FAILURE exception per failed source', () => {
  const fx = fixtureById('TEST-RESP-INT-001');
  const triggerItems = [
    {
      json: {
        event: '',
        reconciliation_report: reportFor(fx),
        response_log_read_error: 'LongRunning',
        reconciliation_read_error: 'SheetNotFound',
      },
    },
  ];
  const relayOut = executeCode('Read Reconciliation Report', { refs: { 'Manual Trigger': triggerItems } });
  const out = executeCode('Interpret Responses', {
    refs: {
      'Manual Trigger': triggerItems,
      'Read Response Log': itemsFromRows(fx.initialResponseRows),
      'Read Reconciliation Report': relayOut,
    },
  });
  assert.equal(out[0].json.status, 'INCOMPLETE');
  assert.equal(out[0].json.summary.exception_count, 2);
  assert.deepEqual(out[0].json.exceptions.map((e) => e.category), ['READ_FAILURE', 'READ_FAILURE']);
  const evidenceJoined = JSON.stringify(out[0].json.exceptions.map((e) => e.evidence));
  assert.match(evidenceJoined, /response log/);
  assert.match(evidenceJoined, /reconciliation report/);
  assert.equal(out[0].json.sources.response_log_read_error, 'LongRunning');
  assert.equal(out[0].json.sources.reconciliation_read_error, 'SheetNotFound');
});

test('interpreted records carry INTERP- interpretation ids and the RESP-INT-V1 version', () => {
  const fx = fixtureById('TEST-RESP-INT-001');
  const { report } = runInterpretChain(fx);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.results.length, 1);
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'INTERPRETED');
  assert.match(card.interpretation_id, /^INTERP-[0-9a-f]{8}$/);
  assert.equal(card.interpretation_version, 'RESP-INT-V1');
  assert.ok(['RESPOND', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED', 'OPT_OUT', 'UNDELIVERABLE', 'SPAM_OR_AUTOMATED', 'NO_INTENT'].includes(card.intent_label));
});

test('no PII or raw response payload leaks into any workflow output', () => {
  const SENSITIVE_KEYS = ['response_text', 'provider_message_id', 'sender', 'recipient'];

  function collectKeys(node, keys) {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        keys.add(k);
        collectKeys(v, keys);
      }
    }
    return keys;
  }

  function rawValuesFor(fx) {
    const values = new Set();
    for (const row of [...(fx.initialResponseRows || []), ...(fx.reconcileResponseRows || [])]) {
      for (const field of ['response_text', 'provider_message_id']) {
        const raw = row && row[field];
        if (typeof raw === 'string' && raw.trim() !== '') values.add(raw);
      }
    }
    return values;
  }

  for (const fx of fixtures) {
    const { report, envelope } = runInterpretChain(fx);
    const keys = collectKeys({ report, envelope }, new Set());
    for (const key of SENSITIVE_KEYS) {
      assert.ok(!keys.has(key), fx.id + ': raw PII key present: ' + key);
    }
    const serialized = JSON.stringify({ report, envelope });
    for (const raw of rawValuesFor(fx)) {
      assert.ok(!serialized.includes(raw), fx.id + ': raw value leaked into output');
    }
    for (const card of report.results) {
      assert.equal(card.text_preview, '', fx.id + ': text_preview must stay empty');
    }
  }
});

test('embedded code is self-contained: it runs with only trigger/log semantics and the manual trigger input', () => {
  const fx = fixtureById('TEST-RESP-INT-016');
  const { report } = runInterpretChain(fx);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.response_records, fx.initialResponseRows.length);
  assert.equal(report.summary.interpreted_records, report.results.filter((c) => c.interpretation_status === 'INTERPRETED').length);
});