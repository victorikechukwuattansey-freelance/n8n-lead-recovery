'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { APPROVED_COLUMNS, rowToObject, isWellFormedEmail } = require('../src/schema');
const { OUTREACH_COLUMNS } = require('../src/reconcile');
const { CHANNEL, READINESS, readinessFor } = require('../src/queue');
const { loadExecutionFixtures, EXECUTION_REGEX } = require('../src/execution-fixtures');
const { MockProvider, providerFor, NOT_CONFIGURED_PROVIDER } = require('../src/provider');
const {
  RUN_LABEL,
  MODE,
  EXECUTION_STATUS,
  REASON,
  REPORT_FIELDS,
  outreachIdFor,
  buildSentIndex,
  buildSentScope,
  mergeQueueWithApproved,
  validatePayload,
  buildPayload,
  buildLogRow,
  gateExecution,
  incompleteExecution,
  executeFromSheets,
} = require('../src/execution');

const FIXED_RUN_ID = 'EXECUTION-TEST-000000000000';
const FIXED_NOW = '2026-09-11T12:00:00.000Z';

async function runRows(fx, opts = {}) {
  return executeFromSheets({
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    messageVariants: fx.message_variants,
    mode: fx.run.mode,
    runId: opts.runId || FIXED_RUN_ID,
    now: FIXED_NOW,
    approvedError: (fx.read_errors && fx.read_errors.approved) || '',
    outreachError: (fx.read_errors && fx.read_errors.outreach) || '',
    ...opts,
  });
}

function fixtureById(id) {
  return loadExecutionFixtures().find((f) => f.id === id);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}

function assertExpected(report, expected) {
  for (const key of Object.keys(expected)) {
    if (key === 'results' || key === 'log_row_lead_ids') continue;
    if (key.startsWith('sources_')) continue;
    assert.deepEqual(report[key], expected[key], `${key}`);
  }
  if (expected.sources_approved_ok !== undefined) {
    assert.equal(report.sources.approved_ok, expected.sources_approved_ok, 'sources.approved_ok');
  }
  if (expected.sources_approved_error !== undefined) {
    assert.equal(report.sources.approved_read_error, expected.sources_approved_error, 'sources.approved_read_error');
  }
  if (expected.sources_outreach_ok !== undefined) {
    assert.equal(report.sources.outreach_ok, expected.sources_outreach_ok, 'sources.outreach_ok');
  }
  if (expected.sources_outreach_error !== undefined) {
    assert.equal(report.sources.outreach_read_error, expected.sources_outreach_error, 'sources.outreach_read_error');
  }
}

function assertResult(report, expected) {
  const card = report.results.find((r) => r.lead_id === expected.lead_id);
  assert.ok(card, `result card missing for ${expected.lead_id}`);
  for (const key of Object.keys(expected)) {
    assert.equal(card[key], expected[key], `${expected.lead_id}.${key}`);
  }
}

function assertLogLeadIds(report, expectedIds) {
  const actual = report.log_rows.map((r) => r.lead_id);
  assert.deepEqual(actual, expectedIds, 'log row lead ids (order)');
}

const fixtures = loadExecutionFixtures();

test('module contract: vocabulary and schema symbols are stable', () => {
  assert.equal(RUN_LABEL, 'EXECUTION');
  assert.deepEqual(Object.values(MODE).sort(), ['DRY_RUN', 'REAL']);
  assert.deepEqual(Object.values(EXECUTION_STATUS).sort(), [
    'DUPLICATE_SUPPRESSED',
    'EXECUTION_FAILED',
    'EXECUTION_REJECTED',
    'EXECUTION_SKIPPED',
    'EXECUTION_SUCCEEDED',
  ]);
  assert.deepEqual(Object.values(REASON).sort(), [
    'BLOCKED',
    'DRY_RUN',
    'DUPLICATE',
    'EXECUTION_SUCCESS',
    'INVALID_PAYLOAD',
    'LOG_APPEND_FAILED',
    'LOG_INCONSISTENT',
    'NOT_READY',
    'NO_CHANNEL',
    'PROVIDER_FAILURE',
    'PROVIDER_NOT_CONFIGURED',
  ]);
  assert.equal(outreachIdFor('LEAD-001', 'email'), 'EX-LEAD-001-email');
  assert.ok(REPORT_FIELDS.includes('log_rows_written'));
  assert.ok(REPORT_FIELDS.includes('provider_calls'));
  assert.ok(REPORT_FIELDS.includes('executed_attempted'));
  for (const fn of [buildSentIndex, buildSentScope, mergeQueueWithApproved, validatePayload, buildPayload, buildLogRow, gateExecution, incompleteExecution, executeFromSheets]) {
    assert.equal(typeof fn, 'function');
  }
});

test('fixtures: namespaced fixtures with full column contracts and sane run modes', () => {
  assert.ok(
    fixtures.length >= 25,
    'execution corpus must not shrink below 25 (001-015 core + 020-029 edge cases); got ' + fixtures.length,
  );
  for (const f of fixtures) {
    assert.match(f.id, EXECUTION_REGEX, f.id);
    assert.ok(['DRY_RUN', 'REAL'].includes(f.run.mode), `${f.id} mode`);
    assert.ok(['SUCCESS', 'FAILURE', 'NOT_CONFIGURED'].includes(f.run.provider), `${f.id} provider`);
    for (const row of f.approvedRows) {
      for (const col of APPROVED_COLUMNS) {
        assert.ok(col in row, `${f.id} approved row carries ${col}`);
      }
    }
    for (const row of f.outreachRows) {
      assert.deepEqual(Object.keys(row).sort(), OUTREACH_COLUMNS.slice().sort(), `${f.id} outreach`);
    }
    for (const card of f.expected.results || []) {
      assert.match(card.lead_id, EXECUTION_REGEX, `result ${card.lead_id}`);
    }
    for (const leadId of f.expected.log_row_lead_ids || []) {
      assert.match(leadId, EXECUTION_REGEX, `log row ${leadId}`);
    }
  }
});

test('001 EMAIL_REAL_SUCCESS: real email success stages exactly one committed log row', async () => {
  const fx = fixtureById('TEST-EXEC-001');
  const provider = providerFor(fx.run.provider);
  const { report, logRows } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  assert.equal(provider.calls.length, 1, 'provider called exactly once');
  assert.equal(report.mode, MODE.REAL);
  assert.equal(report.provider_configured, true);
  const card = report.results[0];
  assert.equal(card.payload.email, 'hello@acme.example');
  assert.equal(card.payload.message_variant, 'outreach-v1');
  assert.equal(card.provider_call.success, true);
  assert.equal(card.provider_call.provider_message_id, `mock:${FIXED_RUN_ID}`);
  assert.equal(card.sent_at, FIXED_NOW);
});

test('001 log row matches the OUTREACH_COLUMNS contract and stays canonical-empty for engagement fields', async () => {
  const fx = fixtureById('TEST-EXEC-001');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  const row = report.log_rows[0];
  assert.deepEqual(Object.keys(row).sort(), OUTREACH_COLUMNS.slice().sort(), 'log row column contract');
  assert.equal(row.outreach_id, 'EX-TEST-EXEC-001-email');
  assert.equal(row.lead_id, 'TEST-EXEC-001');
  assert.equal(row.channel, 'email');
  assert.equal(row.email, 'hello@acme.example');
  assert.equal(row.phone, '');
  assert.equal(row.message_variant, 'outreach-v1');
  assert.equal(row.sent_at, FIXED_NOW);
  for (const empty of ['follow_up_date', 'follow_up_number', 'reply_status', 'reply_date', 'pain_admitted', 'call_booked', 'call_date', 'paid_pilot_interest', 'objection', 'outcome']) {
    assert.equal(row[empty], '', `${empty} must stay canonical-empty`);
  }
});

test('002 CALL_REAL_SUCCESS: call success stages a phone-only log row without a variant', async () => {
  const fx = fixtureById('TEST-EXEC-002');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  const row = report.log_rows[0];
  assert.equal(row.channel, 'call');
  assert.equal(row.phone, '5125550100');
  assert.equal(row.email, '');
});

test('003 EMAIL_DRY_RUN: default mode makes zero provider calls and zero writes', async () => {
  const fx = fixtureById('TEST-EXEC-003');
  const provider = providerFor(fx.run.provider);
  const { report, logRows } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  assert.equal(report.mode, MODE.DRY_RUN);
  assert.equal(provider.callCount, 0, 'provider must not be called in dry run');
  assert.equal(logRows.length, 0);
  const card = report.results[0];
  assert.equal(card.payload.email, 'dock@drm.example', 'payload is still previewed in dry run');
  assert.equal(card.provider_call, null);
  assert.equal(card.sent_at, '');
});

test('004 CALL_DRY_RUN: a FAILURE provider is never reached in DRY_RUN', async () => {
  const fx = fixtureById('TEST-EXEC-004');
  const provider = providerFor(fx.run.provider);
  const { report } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(provider.callCount, 0);
});

test('005 EMPTY_REAL: empty sources complete healthily with zero writes', async () => {
  const fx = fixtureById('TEST-EXEC-005');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  assertExpected(report, fx.expected);
  assert.equal(report.approved_total, 0);
  assert.equal(report.queue_total, 0);
  assert.equal(report.results.length, 0);
  assert.equal(report.log_rows.length, 0);
});

test('006 MIXED_READINESS: only READY executes; BLOCKED and NOT_READY skip with distinct reasons', async () => {
  const fx = fixtureById('TEST-EXEC-006');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  assertExpected(report, fx.expected);
  for (const card of fx.expected.results) assertResult(report, card);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  const blocked = report.results.find((r) => r.lead_id === 'TEST-EXEC-0061');
  const notReady = report.results.find((r) => r.lead_id === 'TEST-EXEC-0062');
  assert.equal(blocked.payload, null);
  assert.equal(blocked.provider_call, null);
  assert.equal(notReady.payload, null);
  assert.equal(report.results.filter((r) => r.status === EXECUTION_STATUS.SUCCEEDED).length, 1);
});

test('007 INVALID_PAYLOAD_EMAIL: READY candidate with empty email is rejected, never sent', async () => {
  const fx = fixtureById('TEST-EXEC-007');
  const provider = providerFor(fx.run.provider);
  const { report } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(provider.callCount, 0);
  assert.equal(report.log_rows.length, 0);
});

test('008 DUPLICATE_SUPPRESSED: committed same-channel history suppresses without touching the provider', async () => {
  const fx = fixtureById('TEST-EXEC-008');
  const provider = providerFor(fx.run.provider);
  const { report } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(provider.callCount, 0);
  assert.equal(report.log_rows.length, 0);
  const card = report.results[0];
  assert.equal(card.payload, null);
  assert.equal(card.provider_call, null);
});

test('009 PROVIDER_FAILURE: confirmed provider failure -> EXECUTION_FAILED, zero writes', async () => {
  const fx = fixtureById('TEST-EXEC-009');
  const provider = providerFor(fx.run.provider);
  const { report, logRows } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(provider.callCount, 1);
  assert.equal(logRows.length, 0);
  const card = report.results[0];
  assert.equal(card.provider_call.success, false);
  assert.equal(card.provider_call.error_code, 'MOCK_PROVIDER_FAILURE');
});

test('010 PROVIDER_NOT_CONFIGURED: REAL mode without an adapter refuses honestly', async () => {
  const fx = fixtureById('TEST-EXEC-010');
  const { report } = await runRows(fx, { provider: NOT_CONFIGURED_PROVIDER });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(report.provider_configured, false);
  const card = report.results[0];
  assert.equal(card.provider_call.success, false);
  assert.equal(card.provider_call.error_code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(report.log_rows.length, 0);
});

test('011/012 EXECUTION_INCOMPLETE: read failures null every metric and never fabricate', async () => {
  for (const id of ['TEST-EXEC-011', 'TEST-EXEC-012']) {
    const fx = fixtureById(id);
    const { report, results } = await runRows(fx, { provider: providerFor('SUCCESS') });
    assertExpected(report, fx.expected);
    assert.equal(report.status, 'EXECUTION_INCOMPLETE');
    for (const field of REPORT_FIELDS) {
      assert.equal(report[field], null, `${id} ${field} must be null, never a false zero`);
    }
    assert.deepEqual(results, []);
    assert.deepEqual(report.log_rows, []);
    assert.deepEqual(report.exceptions, []);
  }
});

test('013 MULTI_EMAIL_ORDER: results and log rows follow queue priority order', async () => {
  const fx = fixtureById('TEST-EXEC-013');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  assertExpected(report, fx.expected);
  for (const card of fx.expected.results) assertResult(report, card);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  assert.deepEqual(
    report.results.map((r) => r.lead_id),
    fx.expected.results.map((r) => r.lead_id),
    'results must preserve priority order',
  );
  assert.equal(report.results[0].lead_id, 'TEST-EXEC-013');
  assert.equal(report.results[1].lead_id, 'TEST-EXEC-0131');
});

test('014 DIFFERENT_CHANNEL_HISTORY: call history does not suppress an email attempt', async () => {
  const fx = fixtureById('TEST-EXEC-014');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assertLogLeadIds(report, fx.expected.log_row_lead_ids);
  assert.equal(report.results[0].channel, 'email');
});

test('015 DRY_RUN_DUPLICATE: dedupe is projection-level and reported even in DRY_RUN', async () => {
  const fx = fixtureById('TEST-EXEC-015');
  const provider = providerFor(fx.run.provider);
  const { report } = await runRows(fx, { provider });
  assertExpected(report, fx.expected);
  assertResult(report, fx.expected.results[0]);
  assert.equal(provider.callCount, 0);
  assert.equal(report.log_rows.length, 0);
});

test('provider throw is contained as EXECUTION_FAILED/PROVIDER_FAILURE, never an unhandled crash', async () => {
  const fx = fixtureById('TEST-EXEC-001');
  const throwing = {
    isConfigured: () => true,
    mode: 'THROWING',
    async execute() {
      throw new Error('provider exploded');
    },
  };
  const { report, logRows } = await runRows(fx, { provider: throwing });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.executed_attempted, 1);
  assert.equal(report.executed_failed, 1);
  assert.equal(report.provider_calls, 1);
  assert.equal(logRows.length, 0);
  const card = report.results[0];
  assert.equal(card.status, EXECUTION_STATUS.FAILED);
  assert.equal(card.reason, REASON.PROVIDER_FAILURE);
  assert.equal(card.provider_call.error_code, 'PROVIDER_THREW');
  assert.match(card.provider_call.error_message, /exploded/);
});

test('determinism: identical runId+now yields bit-identical output including provider ids', async () => {
  const fx = fixtureById('TEST-EXEC-013');
  const a = await runRows(fx, { runId: 'EXE-DET', now: FIXED_NOW, provider: providerFor('SUCCESS') });
  const b = await runRows(fx, { runId: 'EXE-DET', now: FIXED_NOW, provider: providerFor('SUCCESS') });
  assert.deepEqual(a.report, b.report);
  assert.equal(a.report.run_id, 'EXE-DET');
  assert.equal(a.report.log_rows[0].sent_at, FIXED_NOW);
});

test('run fields are injectable and also default sanely without injection', async () => {
  const fx = fixtureById('TEST-EXEC-003');
  const defaultRun = await executeFromSheets({
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    messageVariants: fx.message_variants,
    runId: 'EXE-DEFAULT',
    now: FIXED_NOW,
  });
  assert.match(defaultRun.report.run_id, /^EXE-DEFAULT$/);
  assert.equal(defaultRun.report.mode, MODE.DRY_RUN, 'default mode is DRY_RUN');
  assert.equal(defaultRun.report.provider, 'NOT_CONFIGURED', 'default provider is NOT_CONFIGURED');
  const natural = await executeFromSheets({ approvedRows: [], outreachRows: [] });
  assert.match(natural.report.run_id, /^EXECUTION-\d{14}$/);
  assert.equal(natural.report.status, 'COMPLETED');
});

test('source immutability: frozen inputs are never mutated', async () => {
  const fx = fixtureById('TEST-EXEC-013');
  const approved = deepFreeze(fx.approvedRows.map((r) => Object.assign({}, r)));
  const outreach = deepFreeze(fx.outreachRows.map((r) => Object.assign({}, r)));
  const before = JSON.stringify({ approved, outreach });
  const { report } = await runRows(fx, { provider: providerFor('SUCCESS') });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(JSON.stringify({ approved, outreach }), before);
});

test('mergeQueueWithApproved joins contact fields and explicit variants only', () => {
  const queue = [{ lead_id: 'TEST-EXEC-200', available_channel: 'call' }];
  const approved = [{
    lead_id: 'TEST-EXEC-200',
    business_name: 'Join Co',
    email: 'j@j.example',
    phone: '5125550200',
    contact_name: 'Joan',
  }];
  const merged = mergeQueueWithApproved(queue, approved, { 'TEST-EXEC-200': 'script-b' });
  assert.equal(merged[0].email, 'j@j.example');
  assert.equal(merged[0].phone, '5125550200');
  assert.equal(merged[0].contact_name, 'Joan');
  assert.equal(merged[0].message_variant, 'script-b');
  assert.equal(queue[0].message_variant, undefined, 'inputs not mutated');
});

test('validatePayload: email needs email+variant; call needs phone', () => {
  const base = { available_channel: 'email' };
  assert.equal(validatePayload(Object.assign({}, base, { email: 'a@b.example', message_variant: 'x' })).ok, true);
  assert.equal(validatePayload(Object.assign({}, base, { email: 'a@b.example', message_variant: '' })).ok, false);
  assert.equal(validatePayload(Object.assign({}, base, { email: '', message_variant: 'x' })).ok, false);
  const call = { available_channel: 'call' };
  assert.equal(validatePayload(Object.assign({}, call, { phone: '5125550100' })).ok, true);
  assert.equal(validatePayload(Object.assign({}, call, { phone: '' })).ok, false);
});

test('validatePayload: malformed email addresses are rejected (FINDING-020)', () => {
  const result = validatePayload({
    available_channel: CHANNEL.EMAIL,
    email: 'test [at] example.com',
    message_variant: 'cold-outreach-v1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.INVALID_PAYLOAD);
  assert.equal(result.detail, 'email channel requires a well-formed address');
});

test('validatePayload: well-formed email addresses are accepted', () => {
  for (const email of ['user@example.com', 'first.last@sub.example.co.uk', 'user+tag@example.com', 'noreply@x.io']) {
    const result = validatePayload({ available_channel: CHANNEL.EMAIL, email, message_variant: 'cold-outreach-v1' });
    assert.equal(result.ok, true, `expected ok for ${email}`);
  }
});

test('validatePayload: a well-formed address still requires message_variant, with a specific detail', () => {
  const missing = validatePayload({ available_channel: CHANNEL.EMAIL, email: 'user@example.com', message_variant: '' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, REASON.INVALID_PAYLOAD);
  assert.equal(missing.detail, 'email channel requires a non-empty message_variant');

  const absent = validatePayload({ available_channel: CHANNEL.EMAIL, email: 'user@example.com' });
  assert.equal(absent.ok, false, 'an absent message_variant is still rejected');
  assert.equal(absent.detail, 'email channel requires a non-empty message_variant');

  const noEmail = validatePayload({ available_channel: CHANNEL.EMAIL, email: '', message_variant: 'x' });
  assert.equal(noEmail.ok, false, 'the old non-emptiness check is subsumed by the format check');
  assert.equal(noEmail.detail, 'email channel requires a well-formed address');
});

test('isWellFormedEmail: pragmatic shape check, trims and coerces (FINDING-020)', () => {
  for (const v of ['user@example.com', 'first.last@sub.example.co.uk', 'user+tag@example.com', 'noreply@x.io', '  user@example.com  ']) {
    assert.equal(isWellFormedEmail(v), true, `expected accept for ${JSON.stringify(v)}`);
  }
  for (const v of ['test [at] example.com', 'user@localhost', '@example.com', 'user@', 'user@.com', 'user @example.com', 'no-at-sign', '   ', '', null, undefined]) {
    assert.equal(isWellFormedEmail(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
});

test('a malformed email never reaches the payload builder or a log row (FINDING-020)', () => {
  const f = fixtureById('TEST-EXEC-020');
  const source = f.approvedRows[0];
  const queueItem = {
    lead_id: source.lead_id,
    business_name: source.business_name,
    channel: 'email',
    email: source.email,
    message_variant: f.message_variants['TEST-EXEC-020'],
  };
  const readiness = readinessFor(queueItem);
  assert.equal(readiness.readiness_status, READINESS.NOT_READY, 'the queue layer must reject before execution');
  assert.equal(readiness.reason, 'channel email but address is malformed');

  const forced = Object.assign({}, queueItem, { available_channel: CHANNEL.EMAIL, readiness_status: READINESS.READY });
  assert.equal(validatePayload(forced).ok, false, 'the execution layer rejects even if readiness were bypassed');
  // buildPayload is deliberately unguarded: it stages to/from verbatim. validatePayload is
  // the single execution-layer gate, which is why the check there is load-bearing, not redundant.
  assert.equal(
    buildPayload(forced).to,
    source.email,
    'buildPayload forwards the address unchanged; only validatePayload stops it',
  );
});

test('020 MALFORMED_EMAIL_REJECTED: a malformed address is NOT_READY and writes no log row', async () => {
  const f = fixtureById('TEST-EXEC-020');
  const { report, logRows } = await runRows(f);
  assertExpected(report, f.expected);
  assert.equal(report.ready_candidates, 0, 'no READY candidate remains');
  assert.equal(report.executed_skipped, 1, 'the engine still emits one SKIPPED card for the queue entry');
  assert.equal(report.log_rows_written, 0);
  assert.equal(report.provider_calls, 0);
  assertResult(report, f.expected.results[0]);
  assertLogLeadIds(report, f.expected.log_row_lead_ids);
  assert.equal(logRows.length, 0);
  const card = report.results.find((r) => r.lead_id === 'TEST-EXEC-020');
  assert.equal(card.payload, null, 'no payload is built for a NOT_READY lead');
  assert.equal(card.provider_call, null);
});

test('mergeQueueWithApproved defaults email items to cold-outreach-v1 when no explicit variant', () => {
  const queue = [
    { lead_id: 'TEST-EXEC-201', available_channel: 'email' },
    { lead_id: 'TEST-EXEC-202', available_channel: 'call' },
    { lead_id: 'TEST-EXEC-203', available_channel: 'email' },
  ];
  const approved = [
    { lead_id: 'TEST-EXEC-201', email: 'a@a.example', phone: '', contact_name: 'A' },
    { lead_id: 'TEST-EXEC-202', email: '', phone: '5125550300', contact_name: 'B' },
    { lead_id: 'TEST-EXEC-203', email: 'c@c.example', phone: '', contact_name: 'C' },
  ];
  const merged = mergeQueueWithApproved(queue, approved, { 'TEST-EXEC-203': 'outreach-v1' });
  assert.equal(merged[0].message_variant, 'cold-outreach-v1', 'email without explicit variant defaults');
  assert.equal(merged[1].message_variant, '', 'call items keep an empty variant');
  assert.equal(merged[2].message_variant, 'outreach-v1', 'explicit variant wins over the default');
});

test('validatePayload accepts an email item whose variant was defaulted at merge', () => {
  const merged = mergeQueueWithApproved(
    [{ lead_id: 'TEST-EXEC-204', available_channel: 'email' }],
    [{ lead_id: 'TEST-EXEC-204', email: 'd@d.example' }],
    {},
  )[0];
  assert.equal(merged.message_variant, 'cold-outreach-v1');
  assert.equal(validatePayload(merged).ok, true, 'defaulted variant satisfies the email payload contract');
});

test('buildPayload for email merges the message-body resolver envelope', () => {
  const item = {
    lead_id: 'TEST-EXEC-205',
    outreach_id: 'EX-TEST-EXEC-205-email',
    business_name: 'Envelope Co',
    contact_name: 'Ed',
    available_channel: 'email',
    email: 'ed@env.example',
    message_variant: 'cold-outreach-v1',
  };
  const payload = buildPayload(item, 'EXE-DET');
  assert.equal(payload.email, 'ed@env.example');
  assert.equal(payload.to, 'ed@env.example');
  assert.equal(payload.from, process.env.RESEND_FROM_EMAIL || '');
  assert.equal(payload.subject, 'Quick question about Envelope Co');
  assert.match(payload.text, /Envelope Co/);
  assert.match(payload.html, /Envelope Co/);
  assert.equal(payload.resolve_error, undefined, 'no resolver failure for a resolvable variant');
});

test('buildPayload for call stays phone-only with no message fields', () => {
  const item = {
    lead_id: 'TEST-EXEC-206',
    outreach_id: 'EX-TEST-EXEC-206-call',
    business_name: 'Call Co',
    available_channel: 'call',
    phone: '5125550400',
    message_variant: '',
  };
  const payload = buildPayload(item, 'EXE-DET');
  assert.equal(payload.phone, '5125550400');
  assert.equal(payload.email, undefined);
  assert.equal(payload.subject, undefined);
  assert.equal(payload.resolve_error, undefined);
});

test('payload resolve failure rejects INVALID_PAYLOAD and does not throw out of executeFromSheets', async () => {
  const fx = fixtureById('TEST-EXEC-001');
  const { report, logRows } = await runRows(fx, {
    provider: providerFor('SUCCESS'),
    messageVariants: { 'TEST-EXEC-001': 'no-such-template-v1' },
  });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.ready_candidates, 1);
  assert.equal(report.executed_attempted, 0, 'no provider attempt for an unresolvable template');
  assert.equal(report.executed_rejected, 1);
  assert.equal(report.provider_calls, 0);
  assert.equal(logRows.length, 0);
  const card = report.results[0];
  assert.equal(card.status, EXECUTION_STATUS.REJECTED);
  assert.equal(card.reason, REASON.INVALID_PAYLOAD);
  assert.match(card.detail, /message-body: template not found: no-such-template-v1/);
  assert.equal(card.payload.message_variant, 'no-such-template-v1');
  assert.equal(card.provider_call, null);
});

test('gateExecution: empty sent_at holds LOG_INCONSISTENT; confirmed rows suppress; suppressed leads block', () => {
  const sent = buildSentIndex([
    { lead_id: 'TEST-EXEC-300', channel: 'email', sent_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'TEST-EXEC-301', channel: 'email', sent_at: '' },
    { lead_id: 'TEST-EXEC-302', channel: 'email' },
  ]);
  assert.ok(sent.has('TEST-EXEC-300\u0000email'));
  assert.equal(sent.size, 1, 'only committed rows index');
  const ambiguous = buildSentScope([
    { lead_id: 'TEST-EXEC-300', channel: 'email', sent_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'TEST-EXEC-301', channel: 'email', sent_at: '' },
    { lead_id: 'TEST-EXEC-302', channel: 'email' },
  ]).ambiguous;
  assert.ok(ambiguous.has('TEST-EXEC-301\u0000email'));
  assert.ok(ambiguous.has('TEST-EXEC-302\u0000email'));
  assert.equal(ambiguous.size, 2, 'identity-known malformed rows held (301 + 302)');
  const ready = { lead_id: 'TEST-EXEC-300', readiness_status: 'READY', available_channel: 'email', reason: '' };
  assert.equal(gateExecution(ready, sent).ok, false);
  const held = gateExecution(Object.assign({}, ready, { lead_id: 'TEST-EXEC-301' }), sent, ambiguous);
  assert.equal(held.ok, false, 'malformed row holds, never executes');
  assert.equal(held.status, EXECUTION_STATUS.SKIPPED, 'hold uses SKIPPED bucket (bucket conservation)');
  assert.equal(held.reason, REASON.LOG_INCONSISTENT);
  assert.equal(gateExecution(Object.assign({}, ready, { lead_id: 'TEST-EXEC-301' }), sent).ok, true, 'no ambiguous index: fail-open preserved for non-opted callers');
  const blocked = { lead_id: 'TEST-EXEC-400', readiness_status: 'BLOCKED', available_channel: 'none' };
  const gate = gateExecution(blocked, sent);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, REASON.BLOCKED);
});

test('buildSentScope: status === pending with empty sent_at lands in pending, not ambiguous', () => {
  const scope = buildSentScope([
    { lead_id: 'TEST-EXEC-310', channel: 'email', status: 'pending', sent_at: '' },
  ]);
  assert.equal(scope.confirmed.size, 0);
  assert.ok(scope.pending.has('TEST-EXEC-310\u0000email'));
  assert.equal(scope.pending.get('TEST-EXEC-310\u0000email').status, 'pending');
  assert.equal(scope.ambiguous.size, 0);
});

test('buildSentScope: row with both sent_at and status === pending is confirmed (precedence confirmed > pending)', () => {
  const scope = buildSentScope([
    { lead_id: 'TEST-EXEC-311', channel: 'email', status: 'pending', sent_at: '2026-09-01T00:00:00.000Z' },
  ]);
  assert.ok(scope.confirmed.has('TEST-EXEC-311\u0000email'));
  assert.equal(scope.pending.size, 0, 'sent_at wins over pending status');
  assert.equal(scope.ambiguous.size, 0);
});

test('gateExecution: pending match returns { ok: true, pending_retry: true }', () => {
  const pending = buildSentScope([
    { lead_id: 'TEST-EXEC-312', channel: 'email', status: 'pending', sent_at: '' },
  ]).pending;
  const ready = { lead_id: 'TEST-EXEC-312', readiness_status: 'READY', available_channel: 'email', reason: '' };
  const gate = gateExecution(ready, buildSentIndex([]), new Map(), pending);
  assert.equal(gate.ok, true);
  assert.equal(gate.pending_retry, true);
});

test('gateExecution: pending branch wins over ambiguous for the same key', () => {
  const scope = buildSentScope([
    { lead_id: 'TEST-EXEC-313', channel: 'email', status: 'pending', sent_at: '' },
    { lead_id: 'TEST-EXEC-313', channel: 'email', sent_at: '' },
  ]);
  const ready = { lead_id: 'TEST-EXEC-313', readiness_status: 'READY', available_channel: 'email', reason: '' };
  const gate = gateExecution(ready, buildSentIndex([]), scope.ambiguous, scope.pending);
  assert.equal(gate.ok, true, 'pending branch sits above the LOG_INCONSISTENT hold');
  assert.equal(gate.pending_retry, true);
});

test('gateExecution: pending arg default keeps existing LOG_INCONSISTENT behavior', () => {
  const ambiguous = buildSentScope([
    { lead_id: 'TEST-EXEC-314', channel: 'email', sent_at: '' },
  ]).ambiguous;
  const ready = { lead_id: 'TEST-EXEC-314', readiness_status: 'READY', available_channel: 'email', reason: '' };
  const held = gateExecution(ready, buildSentIndex([]), ambiguous);
  assert.equal(held.ok, false);
  assert.equal(held.reason, REASON.LOG_INCONSISTENT);
  assert.equal(held.pending_retry, undefined, 'no pending flag on held rows');
});

test('log row array projection uses the canonical OUTREACH_COLUMNS order', async () => {
  const fx = fixtureById('TEST-EXEC-002');
  const { report } = await runRows(fx, { provider: providerFor(fx.run.provider) });
  const arr = report.log_rows.map((r) => OUTREACH_COLUMNS.map((c) => (r[c] === undefined ? '' : String(r[c]))));
  assert.equal(arr[0].length, OUTREACH_COLUMNS.length);
  assert.equal(arr[0][OUTREACH_COLUMNS.indexOf('channel')], 'call');
  assert.equal(arr[0][OUTREACH_COLUMNS.indexOf('sent_at')], FIXED_NOW);
  assert.deepEqual(Object.keys(rowToObject(arr[0], OUTREACH_COLUMNS)).sort(), OUTREACH_COLUMNS.slice().sort());
});