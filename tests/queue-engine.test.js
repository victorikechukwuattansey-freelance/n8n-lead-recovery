'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { APPROVED_COLUMNS } = require('../src/schema');
const { OUTREACH_COLUMNS } = require('../src/reconcile');
const { loadQueueFixtures, QUEUE_REGEX } = require('../src/queue-fixtures');
const {
  QUEUE_FIELDS,
  RUN_LABEL,
  READINESS,
  CHANNEL,
  SUPPORTED_CHANNELS,
  MIN_PHONE_DIGITS,
  EXCEPTION_TYPE,
  REPORT_FIELDS,
  parseScore,
  readinessFor,
  isUsablePhone,
  buildQueueFromSheets,
  incompleteQueue,
} = require('../src/queue');

const FIXED_RUN_ID = 'QUEUE-TEST-00000000000000';
const FIXED_NOW = '2026-09-11T12:00:00.000Z';

function runRows(approvedRows, outreachRows, opts = {}) {
  return buildQueueFromSheets({
    approvedRows,
    outreachRows,
    runId: opts.runId || FIXED_RUN_ID,
    now: FIXED_NOW,
    ...opts,
  });
}

function fixtureById(id) {
  return loadQueueFixtures().find((f) => f.id === id);
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
    if (key === 'queue' || key === 'exception_types') continue;
    assert.deepEqual(report[key], expected[key], `${key}`);
  }
  if (expected.exception_types) {
    assert.deepEqual(
      report.exceptions.map((e) => e.exception_type),
      expected.exception_types,
      'exception types',
    );
  }
}

function assertQueueItem(report, expectedEntry) {
  const item = report.queue.find((q) => q.lead_id === expectedEntry.lead_id);
  assert.ok(item, `queue must contain ${expectedEntry.lead_id}`);
  for (const key of Object.keys(expectedEntry)) {
    assert.equal(item[key], expectedEntry[key], `${expectedEntry.lead_id}.${key}`);
  }
}

test('module contract: vocabulary and schema symbols are stable', () => {
  assert.equal(RUN_LABEL, 'QUEUE');
  assert.deepEqual(Object.values(READINESS).sort(), ['BLOCKED', 'NOT_READY', 'READY']);
  assert.deepEqual(SUPPORTED_CHANNELS, ['email', 'call']);
  assert.equal(MIN_PHONE_DIGITS, 7);
  assert.ok(QUEUE_FIELDS.includes('queue_id'));
  assert.ok(QUEUE_FIELDS.includes('lead_id'));
  assert.ok(QUEUE_FIELDS.includes('available_channel'));
  assert.ok(QUEUE_FIELDS.includes('readiness_status'));
  assert.ok(QUEUE_FIELDS.includes('priority'));
  assert.ok(QUEUE_FIELDS.includes('outreach_count'));
  assert.ok(QUEUE_FIELDS.includes('last_outreach_at'));
  assert.ok(REPORT_FIELDS.includes('exception_count'));
  assert.equal(typeof buildQueueFromSheets, 'function');
  assert.equal(typeof incompleteQueue, 'function');
});

test('fixtures: 12 namespaced fixtures with full column contracts', () => {
  const fixtures = loadQueueFixtures();
  assert.equal(fixtures.length, 12);
  for (const f of fixtures) {
    assert.match(f.id, QUEUE_REGEX, f.id);
    for (const row of f.approvedRows) {
      for (const col of APPROVED_COLUMNS) {
        assert.ok(col in row, `${f.id} approved row carries ${col}`);
      }
    }
    for (const row of f.outreachRows) {
      assert.deepEqual(Object.keys(row).sort(), OUTREACH_COLUMNS.slice().sort(), f.id);
    }
    for (const entry of f.expected.queue || []) {
      assert.match(entry.lead_id, QUEUE_REGEX, `queue entry ${entry.lead_id}`);
    }
  }
});

test('001 EMAIL_READY: verified email -> READY / EMAIL', () => {
  const f = fixtureById('TEST-QUEUE-001');
  const { report, exceptions } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assert.equal(exceptions.length, 0);
  assertQueueItem(report, f.expected.queue[0]);
  assert.equal(report.queue[0].queue_id, 'TEST-QUEUE-001');
});

test('002 CALL_READY: usable phone maps to the repository CALL channel', () => {
  const f = fixtureById('TEST-QUEUE-002');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
});

test('003 NO_CHANNEL: no usable channel -> NOT_READY / NONE with enrichment flagged', () => {
  const f = fixtureById('TEST-QUEUE-003');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  assert.equal(report.queue[0].enrichment_required, true);
});

test('004 CONTACT_FORM_ONLY: contact_form is NOT a supported channel', () => {
  const f = fixtureById('TEST-QUEUE-004');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
});

test('005 HISTORY: existing Outreach Log activity is attached to the queue item', () => {
  const f = fixtureById('TEST-QUEUE-005');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  const item = report.queue[0];
  assert.equal(item.latest_channel, 'email');
  assert.equal(item.latest_outcome, 'no_reply');
});

test('006 MULTIPLE_HISTORY: correct count, latest sent_at by timestamp, latest channel/outcome', () => {
  const f = fixtureById('TEST-QUEUE-006');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  const item = report.queue[0];
  assert.equal(item.outreach_count, 2);
  assert.equal(item.last_outreach_at, '2026-09-12T14:30:00.000Z');
  assert.equal(item.latest_channel, 'call');
  assert.equal(item.latest_outcome, 'call_booked');
});

test('007 ORPHAN_OUTREACH: orphan reported as exception, never silently approved', () => {
  const f = fixtureById('TEST-QUEUE-007');
  const { report, exceptions } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.OUTREACH_WITHOUT_APPROVAL);
  assert.equal(exceptions[0].severity, 'ERROR');
  assert.equal(exceptions[0].lead_id, 'TEST-QUEUE-007');
  assert.equal(report.queue.length, 0);
});

test('008 TIE_PRIORITY: equal score -> earlier approved_at ranks first', () => {
  const f = fixtureById('TEST-QUEUE-008');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  assertQueueItem(report, f.expected.queue[1]);
  assert.deepEqual(report.queue.map((q) => q.lead_id), ['TEST-QUEUE-008', 'TEST-QUEUE-009']);
});

test('009 DUPLICATE_APPROVAL: one queue identity, duplicate counted not exceptional', () => {
  const f = fixtureById('TEST-QUEUE-009');
  const { report, exceptions } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  assert.equal(report.queue.length, 1);
  assert.equal(exceptions.length, 0);
});

test('010 TRANSITION: projection reflects current source state, NOT_READY -> READY / EMAIL', () => {
  const f = fixtureById('TEST-QUEUE-010');
  const stageA = runRows(f.approvedRows, f.outreachRows);
  assertExpected(stageA.report, f.expected);
  assertQueueItem(stageA.report, f.expected.queue[0]);
  assert.equal(stageA.report.queue[0].readiness_status, READINESS.NOT_READY);

  const stageB = runRows(f.transition.approvedRows, f.transition.outreachRows);
  assertExpected(stageB.report, f.transition.expected);
  assertQueueItem(stageB.report, f.transition.expected.queue[0]);
  assert.equal(stageB.report.queue[0].readiness_status, READINESS.READY);
  assert.equal(stageB.report.queue[0].available_channel, CHANNEL.EMAIL);
});

test('011 SUPPRESSED_BLOCKED: the canonical suppressed status is the only BLOCKED condition', () => {
  const f = fixtureById('TEST-QUEUE-011');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  assertExpected(report, f.expected);
  assertQueueItem(report, f.expected.queue[0]);
  assert.equal(report.queue[0].readiness_status, READINESS.BLOCKED);
  assert.equal(report.queue[0].available_channel, CHANNEL.NONE);
  assert.equal(report.queue[0].enrichment_required, false);
});

test('012 EMPTY_SOURCES: successful empty queue, not an error', () => {
  const f = fixtureById('TEST-QUEUE-012');
  const { report, exceptions } = runRows(f.approvedRows, f.outreachRows);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.approved_total, 0);
  assert.equal(report.queue_total, 0);
  assert.equal(report.queue.length, 0);
  assert.equal(exceptions.length, 0);
});

test('channel semantics: unverified email is NOT a channel, a short phone is not usable', () => {
  const base = (overrides) => [{
    lead_id: 'TEST-QUEUE-100',
    business_name: 'Semantics Co',
    email: overrides.email || '',
    email_verified: overrides.email_verified || '',
    phone: overrides.phone || '',
    outreach_status: 'not_ready',
    approved_at: '2026-09-01T09:00:00.000Z',
  }];
  const eff = (email, emailVerified, phone) => runRows(base({ email, email_verified: emailVerified, phone }), []).report.queue[0];

  const unverified = eff('boss@x.example', '', '');
  assert.equal(unverified.available_channel, CHANNEL.NONE);
  assert.equal(unverified.readiness_status, READINESS.NOT_READY);

  const verified = eff('boss@x.example', 'true', '');
  assert.equal(verified.available_channel, CHANNEL.EMAIL);
  assert.equal(verified.readiness_status, READINESS.READY);

  const shortPhone = eff('', '', '123456');
  assert.equal(shortPhone.available_channel, CHANNEL.NONE);
  assert.equal(shortPhone.readiness_status, READINESS.NOT_READY);

  const longPhone = eff('', '', '5125550100');
  assert.equal(isUsablePhone({ phone: '5125550100' }), true);
  assert.equal(longPhone.available_channel, CHANNEL.CALL);
  assert.equal(longPhone.readiness_status, READINESS.READY);
});

test('readinessFor rejects malformed email addresses (FINDING-020)', () => {
  const cases = [
    'test [at] example.com',
    'user@localhost',
    '@example.com',
    'user@',
    'user@.com',
    'user @example.com',
    'no-at-sign',
    '   ',
  ];
  for (const email of cases) {
    const r = readinessFor({ lead_id: 'X', channel: 'email', email });
    assert.equal(r.readiness_status, READINESS.NOT_READY, `expected NOT_READY for ${JSON.stringify(email)}`);
    assert.equal(r.available_channel, CHANNEL.NONE, `expected channel none for ${JSON.stringify(email)}`);
  }
});

test('readinessFor accepts well-formed email addresses', () => {
  const cases = [
    'user@example.com',
    'first.last@sub.example.co.uk',
    'user+tag@example.com',
    'noreply@x.io',
  ];
  for (const email of cases) {
    const r = readinessFor({ lead_id: 'X', channel: 'email', email });
    assert.equal(r.readiness_status, READINESS.READY, `expected READY for ${email}`);
    assert.equal(r.available_channel, CHANNEL.EMAIL, `expected channel email for ${email}`);
  }
});

test('readinessFor distinguishes "no email address" from "address is malformed"', () => {
  const missing = readinessFor({ lead_id: 'X', channel: 'email', email: '' });
  assert.equal(missing.readiness_status, READINESS.NOT_READY);
  assert.equal(missing.reason, 'channel email but no email address');

  const blank = readinessFor({ lead_id: 'X', channel: 'email', email: '   ' });
  assert.equal(blank.readiness_status, READINESS.NOT_READY);
  assert.equal(blank.reason, 'channel email but no email address', 'whitespace-only reads as absent, not malformed');

  const malformed = readinessFor({ lead_id: 'X', channel: 'email', email: 'test [at] example.com' });
  assert.equal(malformed.readiness_status, READINESS.NOT_READY);
  assert.equal(malformed.reason, 'channel email but address is malformed');
});

test('readinessFor applies the email check on the inference path too (FINDING-020)', () => {
  const verifiedGood = readinessFor({ lead_id: 'X', channel: '', email: 'boss@x.example', email_verified: 'true' });
  assert.equal(verifiedGood.readiness_status, READINESS.READY);
  assert.equal(verifiedGood.available_channel, CHANNEL.EMAIL);
  assert.equal(verifiedGood.reason, 'verified email available');

  const verifiedBad = readinessFor({ lead_id: 'X', channel: '', email: 'test [at] example.com', email_verified: 'true' });
  assert.equal(verifiedBad.readiness_status, READINESS.NOT_READY, 'verified but malformed must not reach READY');
  assert.equal(verifiedBad.available_channel, CHANNEL.NONE);
  assert.equal(verifiedBad.reason, 'verified email but address is malformed');

  const verifiedBadWithPhone = readinessFor({
    lead_id: 'X',
    channel: '',
    email: 'test [at] example.com',
    email_verified: 'true',
    phone: '5125550100',
  });
  assert.equal(verifiedBadWithPhone.readiness_status, READINESS.READY, 'a bad email must not block a usable phone');
  assert.equal(verifiedBadWithPhone.available_channel, CHANNEL.CALL);
  assert.equal(verifiedBadWithPhone.reason, 'phone available');
});

test('priority: higher score ranks first; score tie then approved_at then lead_id', () => {
  const rows = [
    { lead_id: 'TEST-QUEUE-200', business_name: 'Low', score: '60', approved_at: '2026-01-01T00:00:00.000Z' },
    { lead_id: 'TEST-QUEUE-201', business_name: 'High', score: '95', approved_at: '2026-01-02T00:00:00.000Z' },
    { lead_id: 'TEST-QUEUE-202', business_name: 'Mid', score: '70', approved_at: '2026-01-03T00:00:00.000Z' },
  ];
  const { report } = runRows(rows, []);
  assert.deepEqual(report.queue.map((q) => q.lead_id), ['TEST-QUEUE-201', 'TEST-QUEUE-202', 'TEST-QUEUE-200']);
  assert.deepEqual(report.queue.map((q) => q.priority), [1, 2, 3]);

  const tie = [
    { lead_id: 'TEST-QUEUE-300', score: '80', approved_at: '2026-02-01T00:00:00.000Z' },
    { lead_id: 'TEST-QUEUE-301', score: '80', approved_at: '2026-02-02T00:00:00.000Z' },
  ];
  assert.deepEqual(runRows(tie, []).report.queue.map((q) => q.lead_id), ['TEST-QUEUE-300', 'TEST-QUEUE-301']);
});

test('priority: missing score is treated as 0 (parseScore guard)', () => {
  assert.equal(parseScore(''), 0);
  assert.equal(parseScore('abc'), 0);
  assert.equal(parseScore('72'), 72);
  const rows = [
    { lead_id: 'TEST-QUEUE-400', business_name: 'NoScore', approved_at: '2026-01-02T00:00:00.000Z' },
    { lead_id: 'TEST-QUEUE-401', business_name: 'Scored', score: '50', approved_at: '2026-01-01T00:00:00.000Z' },
  ];
  assert.deepEqual(runRows(rows, []).report.queue.map((q) => q.lead_id), ['TEST-QUEUE-401', 'TEST-QUEUE-400']);
});

test('readiness: post-send statuses are not BLOCKED; only suppressed is', () => {
  for (const status of ['lost', 'won', 'contacted']) {
    const { report } = runRows([{ lead_id: 'TEST-QUEUE-500', score: '70', status: status, approved_at: '2026-09-01T00:00:00.000Z' }], []);
    assert.equal(report.queue[0].readiness_status, READINESS.NOT_READY, status);
  }
  assert.deepEqual(readinessFor({ status: 'suppressed', email_verified: 'true' }), {
    available_channel: CHANNEL.NONE,
    readiness_status: READINESS.BLOCKED,
    reason: 'suppressed',
  });
  const blocked = runRows([{ lead_id: 'TEST-QUEUE-501', status: 'suppressed', email: 'a@b.example', email_verified: 'true', approved_at: '2026-09-01T00:00:00.000Z' }], []).report.queue[0];
  assert.equal(blocked.readiness_status, READINESS.BLOCKED);
  assert.equal(blocked.available_channel, CHANNEL.NONE);
});

test('deduplication and malformed handling: malformed approvals excluded, duplicate first row canonical', () => {
  const approvedRows = [
    { lead_id: 'TEST-QUEUE-600', business_name: 'Canonical', email_verified: 'true', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'TEST-QUEUE-600', business_name: 'Dup', email_verified: 'true', approved_at: '2026-09-02T00:00:00.000Z' },
    { lead_id: '', business_name: 'NoId' },
    { lead_id: 'TEST-QUEUE-601', business_name: 'NoApprovedAt' },
  ];
  const { report, exceptions } = runRows(approvedRows, []);
  assert.equal(report.approved_total, 4);
  assert.equal(report.queue_total, 1);
  assert.equal(report.queue[0].business_name, 'Canonical');
  assert.equal(report.malformed_approvals, 2);
  assert.equal(report.exception_count, 2);
  const types = exceptions.map((e) => e.exception_type);
  assert.deepEqual(types, [EXCEPTION_TYPE.MALFORMED_APPROVAL, EXCEPTION_TYPE.MALFORMED_APPROVAL]);
});

test('history: malformed outreach cannot imply activity but is reported', () => {
  const rows = [
    { lead_id: 'TEST-QUEUE-002', outreach_id: 'OR-QUEUE-002-X', channel: 'email', sent_at: '' },
  ];
  const { report, exceptions } = runRows(fixtureById('TEST-QUEUE-002').approvedRows, rows);
  assert.equal(report.queue[0].outreach_count, 0, 'malformed record must not imply activity');
  assert.equal(report.malformed_outreach, 1);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.MALFORMED_OUTREACH);
});

test('determinism: identical content (any row order) yields an identical queue', () => {
  const approved = fixtureById('TEST-QUEUE-008').approvedRows.slice();
  const approvedShuffled = [approved[1], approved[0]];
  const a = runRows(approved, []);
  const b = runRows(approvedShuffled, []);
  assert.deepEqual(a.report.queue.map((q) => q.lead_id), b.report.queue.map((q) => q.lead_id));
  assert.deepEqual(
    a.report.queue.map((q) => q.priority),
    b.report.queue.map((q) => q.priority),
  );
  assert.deepEqual(a.report.queue, b.report.queue);
  assert.deepEqual(a.report.exceptions, b.report.exceptions);
});

test('failure: approved read error -> QUEUE_INCOMPLETE, null metrics, error preserved', () => {
  const { report, exceptions, queue } = runRows([], [], { approvedError: 'transport failed: 500' });
  assert.equal(report.status, 'QUEUE_INCOMPLETE');
  assert.equal(report.approved_total, null);
  assert.equal(report.queue_total, null);
  assert.equal(report.exception_count, null);
  assert.equal(report.sources.approved_read_error, 'transport failed: 500');
  assert.equal(report.sources.approved_ok, false);
  assert.equal(report.sources.outreach_ok, true);
  assert.deepEqual(queue, []);
  assert.deepEqual(exceptions, []);
});

test('failure: outreach read error -> QUEUE_INCOMPLETE, never a false healthy queue', () => {
  const { report } = runRows(fixtureById('TEST-QUEUE-001').approvedRows, [], { outreachError: 'read failed' });
  assert.equal(report.status, 'QUEUE_INCOMPLETE');
  assert.equal(report.queue_total, null);
  assert.equal(report.sources.outreach_read_error, 'read failed');
  assert.equal(report.sources.outreach_ok, false);
});

test('source immutability: frozen inputs are never mutated', () => {
  const f = fixtureById('TEST-QUEUE-006');
  const approved = deepFreeze(f.approvedRows.map((r) => Object.assign({}, r)));
  const outreach = deepFreeze(f.outreachRows.map((r) => Object.assign({}, r)));
  const before = JSON.stringify({ approved, outreach });
  const { report } = runRows(approved, outreach);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(JSON.stringify({ approved, outreach }), before);
  assert.equal(report.queue[0].outreach_count, 2);
});

test('run fields are injectable; identical injection gives bit-identical output', () => {
  const f = fixtureById('TEST-QUEUE-006');
  const a = runRows(f.approvedRows, f.outreachRows, { runId: 'QUEUE-DET', now: FIXED_NOW });
  const b = runRows(f.approvedRows, f.outreachRows, { runId: 'QUEUE-DET', now: FIXED_NOW });
  assert.deepEqual(a.report, b.report);
  assert.equal(a.report.run_id, 'QUEUE-DET');
  assert.equal(a.report.queued_at, FIXED_NOW);
  assert.equal(a.report.queue[0].queued_at, FIXED_NOW);
});

test('queue item matches the documented QUEUE_FIELDS contract', () => {
  const f = fixtureById('TEST-QUEUE-005');
  const { report } = runRows(f.approvedRows, f.outreachRows);
  const item = report.queue[0];
  for (const field of QUEUE_FIELDS) {
    assert.ok(field in item, `missing queue field ${field}`);
    assert.ok(item[field] !== undefined, `undefined queue field ${field}`);
  }
  assert.equal(item.score, '78');
  assert.equal(item.approved_at, '2026-06-01T09:00:00.000Z');
});