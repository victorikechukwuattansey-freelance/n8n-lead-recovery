'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Outreach-Execution-and-Delivery V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { executeFromSheets } = require('../src/execution');
const { loadExecutionFixtures } = require('../src/execution-fixtures');
const { providerFor } = require('../src/provider');
const { OUTREACH_COLUMNS } = require('../src/reconcile');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const WRITE_ONLY_SHEETS = ['Outreach Log'];

const EXPECTED_NODES = [
  'Manual Trigger',
  'Initialize Execution Mode',
  'Read Approved Outreach',
  'Read Outreach Log',
  'Execute Ready Queue',
  'Prepare Outreach Log Write',
  'Write Outreach Log',
  'Execution Complete',
];

const fixtures = loadExecutionFixtures();

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
  const inputItems = opts.inputItems ?? [];
  const $input = {
    all: () => inputItems,
    first: () => (inputItems[0] ?? { json: {} }),
    item: inputItems[0] ?? {},
  };
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

function modeRef(fx) {
  return [{ json: { mode: fx.run.mode, provider: fx.run.provider, message_variants: fx.message_variants } }];
}

function runEmbedded(fx, sourceErrors = {}) {
  const approvedRef = sourceErrors.approved
    ? [{ json: { _source_read_error: sourceErrors.approved } }]
    : itemsFromRows(fx.approvedRows);
  const outreachRef = sourceErrors.outreach
    ? [{ json: { _source_read_error: sourceErrors.outreach } }]
    : itemsFromRows(fx.outreachRows);
  return executeCode('Execute Ready Queue', {
    refs: {
      'Read Approved Outreach': approvedRef,
      'Read Outreach Log': outreachRef,
      'Initialize Execution Mode': modeRef(fx),
    },
  });
}

function stripRunFields(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) =>
      ['run_id', 'run_at', 'queued_at', 'provider_message_id', 'sent_at'].includes(key) ? undefined : val,
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
  assert.equal(names.length, 8, 'expected exactly 8 nodes');
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

test('workflow is provider-independent (only manual trigger, read/append sheets, code, no-op)', () => {
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

test('exactly one write: the Outreach Log append; Approved Outreach is read-only everywhere', () => {
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 3, 'expected read approved + read outreach + append outreach');
  const writes = sheets.filter((n) => n.parameters.operation !== 'read');
  assert.equal(writes.length, 1, 'exactly one write node');
  assert.equal(writes[0].name, 'Write Outreach Log');
  const writeTarget = writes[0].parameters.sheetName.value;
  assert.ok(WRITE_ONLY_SHEETS.includes(writeTarget), 'only Outreach Log may be written');
  for (const n of sheets) {
    assert.equal(n.parameters.documentId.value, SPREADSHEET_ID, n.name + ' must target engine spreadsheet');
  }
  const approvedRead = byName('Read Approved Outreach');
  assert.equal(approvedRead.parameters.operation, 'read');
  assert.equal(approvedRead.parameters.sheetName.value, 'Approved Outreach');
});

test('no outreach side effects, scheduling, enrichment: banned node types are absent', () => {
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
  for (const name of ['Initialize Execution Mode', 'Execute Ready Queue', 'Prepare Outreach Log Write']) {
    const code = jsCodeOf(name);
    assert.ok(!code.includes('staticData'), name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), name + ' must not read env');
    assert.ok(!/$env/.test(code), name + ' must not read $env');
  }
});

test('workflow ships in the safe default: DRY_RUN + NOT_CONFIGURED', () => {
  const out = executeCode('Initialize Execution Mode');
  assert.deepEqual(out[0].json, { mode: 'DRY_RUN', provider: 'NOT_CONFIGURED', message_variants: {} });
  assert.equal(WF.meta.defaultMode, 'DRY_RUN');
  assert.equal(WF.meta.defaultProvider, 'NOT_CONFIGURED');
});

/* ------------------------------------------------------------------ */
/* Embedded code behavior                                             */
/* ------------------------------------------------------------------ */

test('Execute Ready Queue returns a two-item output: execution report then log rows envelope', () => {
  const fx = fixtureById('TEST-EXEC-001');
  const out = runEmbedded(fx);
  assert.equal(out.length, 2);
  assert.equal(out[0].json.status, 'COMPLETED');
  assert.equal(out[0].json.log_rows.length, 1);
  assert.equal(out[1].json.run_id, out[0].json.run_id);
  assert.equal(out[1].json.log_rows_written, out[0].json.log_rows_written);
  assert.deepEqual(out[1].json.log_rows, out[0].json.log_rows);
});

test('embedded report carries the full execution contract fields', () => {
  const fx = fixtureById('TEST-EXEC-013');
  const report = runEmbedded(fx)[0].json;
  assert.ok(report.run_id);
  assert.ok(report.run_at);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.mode, fx.run.mode);
  assert.equal(report.provider, fx.run.provider);
  for (const field of [
    'approved_total', 'queue_total', 'ready_candidates', 'executed_attempted', 'executed_succeeded',
    'executed_failed', 'executed_skipped', 'executed_rejected', 'duplicate_suppressed',
    'log_rows_written', 'provider_calls',
  ]) {
    assert.ok(field in report, 'report missing contract field: ' + field);
    assert.ok(!(report[field] === undefined), 'field is undefined: ' + field);
  }
  assert.ok(Array.isArray(report.results));
  assert.ok(Array.isArray(report.log_rows));
  const card = report.results[0];
  for (const field of ['lead_id', 'outreach_id', 'channel', 'readiness_status', 'status', 'reason', 'detail', 'payload', 'provider_call', 'sent_at']) {
    assert.ok(field in card, 'result card missing field: ' + field);
  }
});

test('embedded node marks the run EXECUTION_INCOMPLETE on a source read failure (no false healthy)', () => {
  const fx = fixtureById('TEST-EXEC-012');
  const out = runEmbedded(fx, { outreach: 'Outreach Log sheet unavailable' });
  const report = out[0].json;
  assert.equal(report.status, 'EXECUTION_INCOMPLETE');
  for (const field of ['approved_total', 'queue_total', 'ready_candidates', 'executed_attempted', 'executed_succeeded', 'executed_failed', 'executed_skipped', 'executed_rejected', 'duplicate_suppressed', 'log_rows_written', 'provider_calls']) {
    assert.equal(report[field], null, field + ' must be null, never a false zero');
  }
  assert.equal(report.sources.outreach_ok, false);
  assert.equal(report.sources.outreach_read_error, 'Outreach Log sheet unavailable');
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.log_rows, []);
  assert.deepEqual(out[1].json.log_rows, []);
});

test('embedded node and src/execution.js stay in sync on every fixture', async () => {
  for (const fx of fixtures) {
    const out = runEmbedded(fx, {
      approved: (fx.read_errors && fx.read_errors.approved) || '',
      outreach: (fx.read_errors && fx.read_errors.outreach) || '',
    });
    const embedded = out[0].json;
    const errors = {
      approvedError: (fx.read_errors && fx.read_errors.approved) || '',
      outreachError: (fx.read_errors && fx.read_errors.outreach) || '',
    };
    const { report } = await executeFromSheets({
      approvedRows: fx.approvedRows,
      outreachRows: fx.outreachRows,
      messageVariants: fx.message_variants,
      mode: fx.run.mode,
      provider: providerFor(fx.run.provider),
      runId: embedded.run_id,
      now: embedded.run_at,
      approvedError: errors.approvedError,
      outreachError: errors.outreachError,
    });
    assert.deepEqual(stripRunFields(embedded), stripRunFields(report), fx.id + ': report');
    assert.deepEqual(
      stripRunFields(out[1].json.log_rows),
      stripRunFields(report.log_rows),
      fx.id + ': log rows',
    );
  }
});

test('embedded failure path matches src/execution.js failure shape', async () => {
  const fx = fixtureById('TEST-EXEC-012');
  const out = runEmbedded(fx, { outreach: 'Outreach Log unavailable' });
  const embedded = out[0].json;
  const { report } = await executeFromSheets({
    approvedRows: [],
    outreachRows: [],
    mode: fx.run.mode,
    provider: providerFor(fx.run.provider),
    approvedError: '',
    outreachError: 'Outreach Log unavailable',
    runId: embedded.run_id,
    now: embedded.run_at,
  });
  assert.deepEqual(stripRunFields(embedded), stripRunFields(report));
});

test('embedded dry-run mode never produces log rows and never calls the provider', () => {
  for (const id of ['TEST-EXEC-003', 'TEST-EXEC-004']) {
    const out = runEmbedded(fixtureById(id));
    assert.equal(out[0].json.status, 'COMPLETED', id);
    assert.equal(out[0].json.mode, 'DRY_RUN', id);
    assert.equal(out[0].json.provider_calls, 0, id);
    assert.equal(out[0].json.log_rows_written, 0, id);
    assert.equal(out[1].json.log_rows.length, 0, id);
    assert.deepEqual(out[0].json.results.map((r) => r.reason), ['DRY_RUN'], id);
  }
});

test('Prepare Outreach Log Write projects log rows onto the canonical OUTREACH_COLUMNS contract', () => {
  const out = runEmbedded(fixtureById('TEST-EXEC-002'));
  const prepared = executeCode('Prepare Outreach Log Write', { inputItems: out });
  assert.equal(prepared.length, 1);
  const json = prepared[0].json;
  assert.deepEqual(Object.keys(json).sort(), OUTREACH_COLUMNS.slice().sort());
  assert.equal(json.channel, 'call');
  assert.equal(json.phone, '5125550100');
  assert.equal(json.email, '');
  assert.equal(json.outcome, '');
});

test('Prepare Outreach Log Write emits zero items when the run stages no log rows', () => {
  const out = runEmbedded(fixtureById('TEST-EXEC-003'));
  const prepared = executeCode('Prepare Outreach Log Write', { inputItems: out });
  assert.deepEqual(prepared, []);
});

test('embedded execution never fabricates engagement fields for a confirmed send', () => {
  const out = runEmbedded(fixtureById('TEST-EXEC-001'));
  const row = out[0].json.log_rows[0];
  for (const empty of ['follow_up_date', 'follow_up_number', 'reply_status', 'reply_date', 'pain_admitted', 'call_booked', 'call_date', 'paid_pilot_interest', 'objection', 'outcome']) {
    assert.equal(row[empty], '', empty + ' must stay canonical-empty');
  }
});

test('embedded node stays consented: REAL mode without an adapter refuses honestly', () => {
  const fx = fixtureById('TEST-EXEC-010');
  const out = runEmbedded(fx);
  const report = out[0].json;
  assert.equal(report.provider, 'NOT_CONFIGURED');
  assert.equal(report.provider_configured, false);
  assert.equal(report.results[0].status, 'EXECUTION_FAILED');
  assert.equal(report.results[0].reason, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(report.results[0].provider_call.error_code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(report.log_rows_written, 0);
});