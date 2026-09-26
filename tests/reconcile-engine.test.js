'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OUTREACH_COLUMNS,
  APPROVED_COLUMNS,
  RECONCILE_STATUSES,
  CATEGORY,
  EXCEPTION_TYPE,
  REPORT_FIELDS,
  buildApprovedIndex,
  buildOutreachIndex,
  classifyApprovals,
  findStatusMismatches,
  findOrphans,
  countNonCanonicalStatuses,
  reconcileFromSheets,
} = require('../src/reconcile');
const { loadReconFixtures, RECON_NAMESPACE } = require('../src/recon-fixtures');

const RUN_ID = 'RECON-TEST-0001';
const NOW = '2026-09-11T00:00:00.000Z';

const fixtures = loadReconFixtures();

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function runFixture(id) {
  const fx = fixtureById(id);
  const { report, exceptions } = reconcileFromSheets({
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    runId: RUN_ID,
    now: NOW,
  });
  return { report, exceptions, fx };
}

function assertExpectedMetrics(report, expected) {
  assert.equal(report.status, expected.status);
  for (const field of REPORT_FIELDS) {
    assert.ok(field in report, 'report missing field: ' + field);
    assert.deepEqual(report[field], expected[field], `${field} mismatch`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Model contract                                                      */
/* ------------------------------------------------------------------ */

test('Outreach Log schema matches the v1 contract (22 columns A-V)', () => {
  assert.deepEqual(OUTREACH_COLUMNS, [
    'outreach_id',
    'lead_id',
    'business_name',
    'contact_name',
    'channel',
    'email',
    'phone',
    'message_variant',
    'sent_at',
    'follow_up_date',
    'follow_up_number',
    'reply_status',
    'reply_date',
    'pain_admitted',
    'call_booked',
    'call_date',
    'paid_pilot_interest',
    'objection',
    'outcome',
    'notes',
    'status',
    'provider_message_id',
  ]);
  assert.equal(OUTREACH_COLUMNS.length, 22);
});

test('status vocabulary covers the canonical pre/post/suppressed statuses', () => {
  assert.deepEqual(RECONCILE_STATUSES, [
    '',
    'not_ready',
    'queued',
    'prepared',
    'contacted',
    'follow_up_due',
    'replied',
    'qualified',
    'demo',
    'pilot',
    'won',
    'lost',
    'suppressed',
  ]);
});

/* ------------------------------------------------------------------ */
/* Fixture integrity                                                   */
/* ------------------------------------------------------------------ */

test('all fixtures live in the TEST-RECON namespace', () => {
  for (const fx of fixtures) {
    assert.match(fx.id, /^TEST-RECON-\d+$/, 'bad fixture id: ' + fx.id);
  }
  assert.ok(fixtures.length >= 9, 'at least the 7 spec categories + empty + mixed');
});

test('fixture rows materialize to the exact Approved (24) and Outreach (20) column contracts', () => {
  for (const fx of fixtures) {
    for (const row of fx.approvedRows) {
      for (const col of APPROVED_COLUMNS) {
        assert.ok(col in row, fx.id + ' approved row carries ' + col);
      }
    }
    for (const row of fx.outreachRows) {
      assert.deepEqual(Object.keys(row).sort(), [...OUTREACH_COLUMNS].sort(), fx.id + ' outreach row');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Per-fixture acceptance (metric contracts in recon-fixtures.json)    */
/* ------------------------------------------------------------------ */

test('001 APPROVED_NO_OUTREACH: approved with no logged outreach (INFO, not an exception)', () => {
  const { report, exceptions } = runFixture('TEST-RECON-001');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-001').expected);
  assert.equal(exceptions.length, 0);
  assert.equal(report.approvals[0].category, CATEGORY.APPROVED_NO_OUTREACH);
});

test('002 APPROVED_WITH_OUTREACH: single record and status reflects activity (HEALTHY)', () => {
  const { report, exceptions } = runFixture('TEST-RECON-002');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-002').expected);
  assert.equal(exceptions.length, 0);
  assert.equal(report.approvals[0].category, CATEGORY.APPROVED_WITH_OUTREACH);
  assert.equal(report.approvals[0].first_sent_at, '2026-09-03T13:00:00.000Z');
});

test('003 MULTIPLE_OUTREACH: count and timestamps surfaced, healthy not auto-error', () => {
  const { report, exceptions } = runFixture('TEST-RECON-003');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-003').expected);
  const approval = report.approvals[0];
  assert.equal(approval.category, CATEGORY.MULTIPLE_OUTREACH);
  assert.equal(approval.outreach_count, 2);
  assert.equal(approval.first_sent_at, '2026-09-04T10:00:00.000Z');
  assert.equal(approval.latest_sent_at, '2026-09-10T10:00:00.000Z');
  assert.deepEqual(approval.channels, ['call', 'email']);
  assert.equal(exceptions.length, 0);
});

test('004 OUTREACH_WITHOUT_APPROVAL: orphan reported, never deleted', () => {
  const { report, exceptions } = runFixture('TEST-RECON-004');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-004').expected);
  assert.equal(report.coverage_rate, null);
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.OUTREACH_WITHOUT_APPROVAL);
  assert.equal(exceptions[0].lead_id, 'TEST-RECON-004');
  assert.equal(exceptions[0].severity, 'ERROR');
});

test('005 MALFORMED_APPROVAL: missing approved_at reported, never repaired, coverage not presented', () => {
  const { report, exceptions } = runFixture('TEST-RECON-005');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-005').expected);
  assert.equal(report.coverage_rate, null);
  assert.equal(report.approvals.length, 0, 'malformed approval is not indexed');
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.MALFORMED_APPROVAL);
  assert.equal(exceptions[0].approved_status, 'not_ready');
});

test('006 MALFORMED_OUTREACH: missing sent_at cannot imply activity; lead stays APPROVED_NO_OUTREACH', () => {
  const { report, exceptions } = runFixture('TEST-RECON-006');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-006').expected);
  assert.equal(report.approvals[0].category, CATEGORY.APPROVED_NO_OUTREACH);
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.MALFORMED_OUTREACH);
  assert.equal(exceptions[0].outreach_id, 'OR-RECON-006-1');
  assert.equal(exceptions[0].lead_id, 'TEST-RECON-006');
});

test('007 STATUS_MISMATCH (phantom): status says contacted but nothing logged', () => {
  const { report, exceptions } = runFixture('TEST-RECON-007');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-007').expected);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.STATUS_MISMATCH);
  assert.equal(exceptions[0].severity, 'WARNING');
  assert.match(exceptions[0].details, /implies outreach activity but none is logged/);
});

test('008 STATUS_MISMATCH (stale): outreach logged but status never advanced from not_ready', () => {
  const { report, exceptions } = runFixture('TEST-RECON-008');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-008').expected);
  assert.equal(report.approvals[0].category, CATEGORY.APPROVED_WITH_OUTREACH);
  assert.equal(exceptions[0].exception_type, EXCEPTION_TYPE.STATUS_MISMATCH);
  assert.match(exceptions[0].details, /status remains "not_ready"/);
});

test('009 EMPTY_SOURCES: successful empty read completes with zero totals and no coverage', () => {
  const { report, exceptions } = runFixture('TEST-RECON-009');
  assertExpectedMetrics(report, fixtureById('TEST-RECON-009').expected);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.coverage_rate, null);
  assert.equal(exceptions.length, 0);
});

test('010 MIXED_ALL: full-surface metric contract', () => {
  const { report, exceptions } = runFixture('TEST-RECON-010');
  const expected = fixtureById('TEST-RECON-010').expected;
  assertExpectedMetrics(report, expected);
  const categories = Object.fromEntries(report.approvals.map((a) => [a.lead_id, a.category]));
  assert.deepEqual(categories, expected.categories);
  assert.deepEqual(exceptions.map((e) => e.exception_type), expected.exception_types);
});

/* ------------------------------------------------------------------ */
/* Boundary semantics                                                  */
/* ------------------------------------------------------------------ */

test('coverage_rate is never presented when the classifiable base is empty', () => {
  const cases = ['TEST-RECON-004', 'TEST-RECON-005', 'TEST-RECON-009'];
  for (const id of cases) {
    const { report } = runFixture(id);
    assert.equal(report.coverage_rate, null, id);
  }
});

test('determinism: identical inputs produce bit-identical reports (run fields injected)', () => {
  const fx = fixtureById('TEST-RECON-010');
  const opts = {
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    runId: RUN_ID,
    now: NOW,
  };
  const first = reconcileFromSheets(opts);
  const second = reconcileFromSheets(opts);
  assert.deepEqual(first.report, second.report);
  assert.deepEqual(first.exceptions, second.exceptions);
});

test('read-only: reconcile does not mutate its inputs', () => {
  const fx = fixtureById('TEST-RECON-010');
  const approvedSnapshot = JSON.stringify(fx.approvedRows);
  const outreachSnapshot = JSON.stringify(fx.outreachRows);
  deepFreeze(fx.approvedRows);
  deepFreeze(fx.outreachRows);
  const { report, exceptions } = reconcileFromSheets({
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    runId: RUN_ID,
    now: NOW,
  });
  assert.equal(report.status, 'COMPLETED');
  assert.ok(exceptions.length >= 0);
  assert.equal(JSON.stringify(fx.approvedRows), approvedSnapshot);
  assert.equal(JSON.stringify(fx.outreachRows), outreachSnapshot);
});

test('deterministic order independence: shuffled approved rows give the same classification set', () => {
  const fx = fixtureById('TEST-RECON-010');
  const opts = {
    approvedRows: fx.approvedRows,
    outreachRows: fx.outreachRows,
    runId: RUN_ID,
    now: NOW,
  };
  const baseline = reconcileFromSheets(opts);
  const shuffled = reconcileFromSheets({
    approvedRows: [...fx.approvedRows].reverse(),
    outreachRows: [...fx.outreachRows].reverse(),
    runId: RUN_ID,
    now: NOW,
  });
  assert.deepEqual(shuffled.report.approved_total, baseline.report.approved_total);
  assert.deepEqual(shuffled.report.approved_with_outreach, baseline.report.approved_with_outreach);
  assert.deepEqual(shuffled.report.status_mismatches, baseline.report.status_mismatches);
  assert.deepEqual(shuffled.exceptions.map((e) => [e.exception_type, e.lead_id]), baseline.exceptions.map((e) => [e.exception_type, e.lead_id]));
});

test('source read failure marks the run INCOMPLETE and never emits a false zero/healthy report', () => {
  const options = {
    approvedRows: [],
    outreachRows: [],
    sourceErrors: { approved: 'sheet read failed' },
    runId: RUN_ID,
    now: NOW,
  };
  const { report, exceptions } = reconcileFromSheets(options);
  assert.equal(report.status, 'RECONCILIATION_INCOMPLETE');
  assert.equal(report.approved_total, null);
  assert.equal(report.approved_with_outreach, null);
  assert.equal(report.exception_count, null);
  assert.equal(report.coverage_rate, null);
  assert.equal(report.sources.approved_ok, false);
  assert.equal(report.sources.approved_read_error, 'sheet read failed');
  assert.equal(report.sources.outreach_ok, true);
  assert.deepEqual(exceptions, []);
});

test('a failed outreach read alone also marks the run INCOMPLETE', () => {
  const { report } = reconcileFromSheets({
    approvedRows: [],
    outreachRows: [],
    sourceErrors: { outreach: 'Outreach Log unavailable' },
    runId: RUN_ID,
    now: NOW,
  });
  assert.equal(report.status, 'RECONCILIATION_INCOMPLETE');
  assert.equal(report.sources.outreach_ok, false);
});

test('suppressed status is neutral regardless of activity (no mismatch either way)', () => {
  const approved = [
    { lead_id: 'L-SUPPRESSED-1', business_name: 'Suppressed Co', status: 'suppressed', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'L-SUPPRESSED-2', business_name: 'Suppressed Co 2', status: 'suppressed', approved_at: '2026-09-01T00:00:00.000Z' },
  ];
  const outreach = [
    { outreach_id: 'OR-S-1', lead_id: 'L-SUPPRESSED-1', sent_at: '2026-09-02T00:00:00.000Z' },
  ];
  const { report } = reconcileFromSheets({ approvedRows: approved, outreachRows: outreach, runId: RUN_ID, now: NOW });
  assert.equal(report.status_mismatches, 0);
  assert.equal(report.approved_with_outreach, 1);
  assert.equal(report.approved_no_outreach, 1);
});

test('unknown statuses are tallied as non-canonical without being auto-repaired', () => {
  const approved = [
    { lead_id: 'L-WEIRD', business_name: 'Weird Status Co', status: 'pending_review', approved_at: '2026-09-01T00:00:00.000Z' },
  ];
  const { report } = reconcileFromSheets({ approvedRows: approved, outreachRows: [], runId: RUN_ID, now: NOW });
  assert.equal(report.non_canonical_statuses, 1);
  assert.equal(report.status_mismatches, 0);
  assert.equal(report.exception_count, 0);
});

test('duplicate approved rows for one lead collapse to one classification and are tallied', () => {
  const approved = [
    { lead_id: 'L-DUP', business_name: 'Dup Co', status: 'contacted', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'L-DUP', business_name: 'Dup Co', status: 'contacted', approved_at: '2026-09-02T00:00:00.000Z' },
  ];
  const outreach = [
    { outreach_id: 'OR-DUP-1', lead_id: 'L-DUP', sent_at: '2026-09-03T00:00:00.000Z' },
  ];
  const { report } = reconcileFromSheets({ approvedRows: approved, outreachRows: outreach, runId: RUN_ID, now: NOW });
  assert.equal(report.approval_duplicates, 1);
  assert.equal(report.approved_total, 2);
  assert.equal(report.approvals.length, 1);
  assert.equal(report.approvals[0].lead_id, 'L-DUP');
});

test('built-in indexes: malformed rows are surfaced, duplicates preserve the first occurrence', () => {
  const approved = buildApprovedIndex([
    { lead_id: 'L-1', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'L-1', approved_at: '2026-09-02T00:00:00.000Z' },
    { lead_id: '', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'L-2', approved_at: '' },
  ]);
  assert.equal(approved.index.size, 1);
  assert.equal(approved.index.get('L-1').approved_at, '2026-09-01T00:00:00.000Z');
  assert.equal(approved.duplicates.length, 1);
  assert.equal(approved.malformed.length, 2);

  const outreach = buildOutreachIndex([
    { outreach_id: 'OR-1', lead_id: 'L-1', sent_at: '2026-09-03T00:00:00.000Z' },
    { outreach_id: 'OR-2', lead_id: 'L-1', sent_at: '2026-09-04T00:00:00.000Z' },
    { outreach_id: 'OR-3', lead_id: 'L-2', sent_at: '' },
    { outreach_id: 'OR-4', lead_id: '', sent_at: '2026-09-05T00:00:00.000Z' },
  ]);
  assert.equal(outreach.index.size, 1);
  assert.equal(outreach.index.get('L-1').count, 2);
  assert.equal(outreach.index.get('L-1').first_sent_at, '2026-09-03T00:00:00.000Z');
  assert.equal(outreach.index.get('L-1').latest_sent_at, '2026-09-04T00:00:00.000Z');
  assert.equal(outreach.malformed.length, 2);
  assert.equal(outreach.malformed[0].reason, 'missing sent_at');
});

test('helper functions: classification, mismatches, orphans, non-canonical counts', () => {
  const approved = buildApprovedIndex([
    { lead_id: 'L-ACTIVE', status: 'not_ready', approved_at: '2026-09-01T00:00:00.000Z' },
    { lead_id: 'L-PHANTOM', status: 'contacted', approved_at: '2026-09-01T00:00:00.000Z' },
  ]);
  const outreach = buildOutreachIndex([
    { outreach_id: 'OR-1', lead_id: 'L-ACTIVE', sent_at: '2026-09-02T00:00:00.000Z' },
    { outreach_id: 'OR-2', lead_id: 'L-ORPHAN', sent_at: '2026-09-02T00:00:00.000Z' },
  ]);
  const classifications = classifyApprovals(approved.index, outreach.index);
  assert.equal(classifications[0].category, CATEGORY.APPROVED_WITH_OUTREACH);
  assert.equal(classifications[1].category, CATEGORY.APPROVED_NO_OUTREACH);
  const mismatches = findStatusMismatches(approved.index, outreach.index);
  assert.deepEqual(mismatches.map((m) => m.lead_id), ['L-ACTIVE', 'L-PHANTOM']);
  const orphans = findOrphans(outreach.index, approved.index);
  assert.deepEqual(orphans.map((o) => o.lead_id), ['L-ORPHAN']);
});