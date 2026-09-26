'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileResponses,
  SUPPORTED_CHANNELS,
  RUN_LABEL,
  STATUS,
  RECONCILIATION_STATUS,
  CATEGORY,
  SEVERITY,
  CATEGORY_SEVERITY,
  VIOLATION_CATEGORIES,
  OUTREACH_ID_REGEX,
} = require('../src/response-reconcile');
const { loadResponseReconcileFixtures, RESP_RECON_REGEX } = require('../src/response-reconcile-fixtures');

const FIXED_NOW = new Date('2026-09-11T09:00:00.000Z').getTime();

const fixtures = loadResponseReconcileFixtures();

// Fixture-id → expected per-row reconciliation statuses, in report order.
const EXPECTED_CARD_STATUS = {
  'TEST-RESP-RECON-001': ['VERIFIED'],
  'TEST-RESP-RECON-002': ['NOT_VERIFIABLE'],
  'TEST-RESP-RECON-003': ['VIOLATION'],
  'TEST-RESP-RECON-004': ['NOT_VERIFIABLE'],
  'TEST-RESP-RECON-005': ['NOT_VERIFIABLE'],
  'TEST-RESP-RECON-006': ['VIOLATION'],
  'TEST-RESP-RECON-007': ['NOT_VERIFIABLE'],
  'TEST-RESP-RECON-008': ['VERIFIED', 'VIOLATION'],
  'TEST-RESP-RECON-009': ['NOT_VERIFIABLE'],
  'TEST-RESP-RECON-010': [],
  'TEST-RESP-RECON-011': ['VIOLATION'],
  'TEST-RESP-RECON-012': [],
  'TEST-RESP-RECON-013': [],
  'TEST-RESP-RECON-014': [],
  'TEST-RESP-RECON-015': [],
  'TEST-RESP-RECON-016': ['VERIFIED'],
  'TEST-RESP-RECON-017': ['VERIFIED', 'VERIFIED'],
  'TEST-RESP-RECON-018': ['NOT_VERIFIABLE'],
};

// Fixture-id → sorted exception categories.
const EXPECTED_CATEGORIES = {
  'TEST-RESP-RECON-001': [],
  'TEST-RESP-RECON-002': ['OUTREACH_ID_FORMAT_INVALID'],
  'TEST-RESP-RECON-003': ['RESPONSE_OUTREACH_NOT_FOUND'],
  'TEST-RESP-RECON-004': ['RESPONSE_WITHOUT_OUTREACH_ID'],
  'TEST-RESP-RECON-005': [],
  'TEST-RESP-RECON-006': ['CHANNEL_MISMATCH'],
  'TEST-RESP-RECON-007': ['INVALID_RESPONSE_RECORD'],
  'TEST-RESP-RECON-008': ['DUPLICATE_RESPONSE'],
  'TEST-RESP-RECON-009': ['DUPLICATE_OUTREACH_ID'],
  'TEST-RESP-RECON-010': [],
  'TEST-RESP-RECON-011': ['RESPONSE_LEAD_NOT_FOUND'],
  'TEST-RESP-RECON-012': [],
  'TEST-RESP-RECON-013': ['READ_FAILURE'],
  'TEST-RESP-RECON-014': ['READ_FAILURE'],
  'TEST-RESP-RECON-015': ['READ_FAILURE'],
  'TEST-RESP-RECON-016': [],
  'TEST-RESP-RECON-017': [],
  'TEST-RESP-RECON-018': ['INVALID_OUTREACH_RECORD'],
};

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function runFixture(fx, overrides = {}) {
  return reconcileResponses({
    responseRows: fx.initialResponseRows,
    outreachRows: fx.initialOutreachRows,
    responseReadError: fx.response_read_error,
    outreachReadError: fx.outreach_read_error,
    now: FIXED_NOW,
    ...overrides,
  });
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

function categoriesOf(report) {
  return [...new Set(report.exceptions.map((e) => e.category))].sort();
}

function reconciliationStatuses(report) {
  return report.results.map((r) => r.reconciliation_status);
}

/* ------------------------------------------------------------------ */
/* Contract surface                                                    */
/* ------------------------------------------------------------------ */

test('engine exports the full reconciliation vocabulary', () => {
  assert.equal(RUN_LABEL, 'RESPRECON');
  assert.deepEqual(SUPPORTED_CHANNELS, ['email', 'call']);
  assert.equal(STATUS.COMPLETED, 'COMPLETED');
  assert.equal(STATUS.INCOMPLETE, 'INCOMPLETE');
  for (const status of ['VERIFIED', 'VIOLATION', 'NOT_VERIFIABLE']) {
    assert.equal(RECONCILIATION_STATUS[status], status);
  }
  for (const category of [
    'RESPONSE_WITH_VALID_OUTREACH', 'RESPONSE_OUTREACH_NOT_FOUND', 'RESPONSE_LEAD_NOT_FOUND',
    'RESPONSE_WITHOUT_OUTREACH_ID', 'CHANNEL_MISMATCH', 'OUTREACH_ID_FORMAT_INVALID',
    'DUPLICATE_RESPONSE', 'DUPLICATE_OUTREACH_ID', 'INVALID_RESPONSE_RECORD',
    'INVALID_OUTREACH_RECORD', 'READ_FAILURE',
  ]) {
    assert.equal(CATEGORY[category], category, 'missing category ' + category);
    assert.ok(CATEGORY_SEVERITY[category], 'missing severity for ' + category);
  }
  assert.deepEqual(VIOLATION_CATEGORIES.sort(), [
    'CHANNEL_MISMATCH', 'DUPLICATE_OUTREACH_ID', 'DUPLICATE_RESPONSE',
    'RESPONSE_LEAD_NOT_FOUND', 'RESPONSE_OUTREACH_NOT_FOUND',
  ].sort());
  assert.equal(CATEGORY_SEVERITY[CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID], SEVERITY.WARNING);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.OUTREACH_ID_FORMAT_INVALID], SEVERITY.WARNING);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.INVALID_RESPONSE_RECORD], SEVERITY.WARNING);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.INVALID_OUTREACH_RECORD], SEVERITY.WARNING);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.CHANNEL_MISMATCH], SEVERITY.ERROR);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.RESPONSE_OUTREACH_NOT_FOUND], SEVERITY.ERROR);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.RESPONSE_LEAD_NOT_FOUND], SEVERITY.ERROR);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.DUPLICATE_RESPONSE], SEVERITY.ERROR);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.DUPLICATE_OUTREACH_ID], SEVERITY.ERROR);
  assert.equal(CATEGORY_SEVERITY[CATEGORY.READ_FAILURE], SEVERITY.ERROR);
  assert.ok(OUTREACH_ID_REGEX.test('EX-LEAD-123-email'));
  assert.ok(OUTREACH_ID_REGEX.test('EX-multi-dash-lead-call'));
  assert.ok(!OUTREACH_ID_REGEX.test('CONTACT-REFERENCE-123'));
});

test('fixture set covers the full TEST-RESP-RECON-001..018 range', () => {
  const ids = new Set(fixtures.map((f) => f.id));
  for (let i = 1; i <= 18; i += 1) {
    const id = `TEST-RESP-RECON-${String(i).padStart(3, '0')}`;
    assert.ok(ids.has(id), 'missing fixture ' + id);
  }
  assert.equal(fixtures.length, 18);
  for (const fx of fixtures) {
    assert.ok(RESP_RECON_REGEX.test(fx.id), fx.id + ' must match ' + RESP_RECON_REGEX);
  }
});

/* ------------------------------------------------------------------ */
/* Fixture expectations                                                */
/* ------------------------------------------------------------------ */

test('every fixture reconciles to its documented summary and status', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    const exp = fx.expected;
    assert.equal(report.status, exp.status, fx.id + ': status');
    for (const field of [
      'response_records', 'matched_records', 'unmatched_records', 'linked_records',
      'not_verifiable', 'invalid_records', 'duplicate_records', 'violations', 'exception_count',
    ]) {
      assert.equal(report.summary[field], exp[field], fx.id + ': summary.' + field);
    }
    assert.deepEqual(report.summary.coverage_rate, exp.coverage_rate, fx.id + ': coverage_rate');
    assert.deepEqual(categoriesOf(report), EXPECTED_CATEGORIES[fx.id], fx.id + ': categories');
    assert.deepEqual(reconciliationStatuses(report), EXPECTED_CARD_STATUS[fx.id], fx.id + ': card statuses');
  }
});

test('run_id follows the RESPRECON label with 14-digit second granularity', () => {
  const report = runFixture(fixtureById('TEST-RESP-RECON-016'));
  assert.match(report.run_id, /^RESPRECON-\d{14}$/);
  const digits = String(new Date(FIXED_NOW).getTime()).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  assert.equal(report.run_id, `RESPRECON-${digits}`);
  assert.equal(report.run_at, new Date(FIXED_NOW).toISOString());
  assert.equal(report.detected_at, new Date(FIXED_NOW).toISOString());
});

test('violation severities map to the exception carriers', () => {
  const severityMap = {
    RESPONSE_OUTREACH_NOT_FOUND: 'ERROR',
    RESPONSE_LEAD_NOT_FOUND: 'ERROR',
    CHANNEL_MISMATCH: 'ERROR',
    DUPLICATE_RESPONSE: 'ERROR',
    DUPLICATE_OUTREACH_ID: 'ERROR',
    RESPONSE_WITHOUT_OUTREACH_ID: 'WARNING',
    OUTREACH_ID_FORMAT_INVALID: 'WARNING',
    INVALID_RESPONSE_RECORD: 'WARNING',
    INVALID_OUTREACH_RECORD: 'WARNING',
  };
  for (const [category, severity] of Object.entries(severityMap)) {
    const fx = Object.keys(EXPECTED_CATEGORIES).find(
      (id) => EXPECTED_CATEGORIES[id].includes(category),
    );
    assert.ok(fx, 'no fixture exercises ' + category);
    const report = runFixture(fixtureById(fx));
    const match = report.exceptions.find((e) => e.category === category);
    assert.ok(match, fx + ': exception ' + category);
    assert.equal(match.severity, severity, fx + ': severity of ' + category);
  }
});

test('coverage_rate aggregates lead-linkage, never exceeds 1, and stays null on zero eligibility', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    if (report.status !== 'COMPLETED') continue;
    const exp = fx.expected;
    if (exp.coverage_rate === null) {
      assert.equal(report.summary.linked_records, 0, fx.id + ': null coverage implies zero linked');
    } else {
      assert.ok(report.summary.coverage_rate >= 0 && report.summary.coverage_rate <= 1, fx.id + ': coverage in [0,1]');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Independent behavioral checks                                       */
/* ------------------------------------------------------------------ */

test('verification is gated on a confirmed sent_at: unconfirmed echoes are NOT_VERIFIABLE', () => {
  const report = reconcileResponses({
    responseRows: [{
      response_id: 'RES-ECHO', idempotency_key: 'k-echo::email',
      lead_id: 'L-ECHO', outreach_id: 'EX-L-ECHO-email', channel: 'email', response_status: 'CAPTURED',
    }],
    outreachRows: [{
      outreach_id: 'EX-L-ECHO-email', lead_id: 'L-ECHO', channel: 'email', sent_at: '',
    }, {
      outreach_id: 'EX-L-ECHO-call', lead_id: 'L-ECHO', channel: 'call', sent_at: '2026-09-11T08:30:00.000Z',
    }],
    now: FIXED_NOW,
  });
  assert.equal(report.results[0].reconciliation_status, 'NOT_VERIFIABLE');
  assert.ok(report.results[0].relationship.includes('send not confirmed'));
  assert.deepEqual(categoriesOf(report), ['INVALID_OUTREACH_RECORD']);
});

test('a response referencing a malformed outreach id never reaches the log lookup', () => {
  const report = reconcileResponses({
    responseRows: [{
      response_id: 'RES-BAD', idempotency_key: 'k-bad::email',
      lead_id: 'L-BAD', outreach_id: 'BAD', channel: 'email', response_status: 'CAPTURED',
    }],
    outreachRows: [],
    now: FIXED_NOW,
  });
  assert.equal(report.results[0].reconciliation_status, 'NOT_VERIFIABLE');
  assert.deepEqual(categoriesOf(report), ['OUTREACH_ID_FORMAT_INVALID']);
  assert.equal(report.summary.matched_records, 0);
});

test('duplicate outreach ids make the echoed attempt ambiguous', () => {
  const report = reconcileResponses({
    responseRows: [{
      response_id: 'RES-DUP', idempotency_key: 'k-dup::email',
      lead_id: 'L-DUP', outreach_id: 'EX-L-DUP-email', channel: 'email', response_status: 'CAPTURED',
    }],
    outreachRows: [
      { outreach_id: 'EX-L-DUP-email', lead_id: 'L-DUP', channel: 'email', sent_at: '2026-09-11T08:00:00.000Z' },
      { outreach_id: 'EX-L-DUP-email', lead_id: 'L-DUP2', channel: 'email', sent_at: '2026-09-11T08:01:00.000Z' },
    ],
    now: FIXED_NOW,
  });
  assert.equal(report.results[0].reconciliation_status, 'NOT_VERIFIABLE');
  assert.deepEqual(categoriesOf(report), ['DUPLICATE_OUTREACH_ID']);
  assert.equal(report.summary.violations, 1);
});

test('channel mismatch is detected from the EX-<lead>-<channel> segment', () => {
  const report = reconcileResponses({
    responseRows: [{
      response_id: 'RES-CM', idempotency_key: 'k-cm::call',
      lead_id: 'L-CM', outreach_id: 'EX-L-CM-email', channel: 'call', response_status: 'CAPTURED',
    }],
    outreachRows: [{ outreach_id: 'EX-L-CM-email', lead_id: 'L-CM', channel: 'email', sent_at: '2026-09-11T08:30:00.000Z' }],
    now: FIXED_NOW,
  });
  assert.equal(report.results[0].reconciliation_status, 'VIOLATION');
  const e = report.exceptions.find((x) => x.category === 'CHANNEL_MISMATCH');
  assert.deepEqual(e.evidence, { referenced_channel: 'email', response_channel: 'call' });
});

test('response text and provider_message_id are excluded from cards and exceptions', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    for (const card of report.results) {
      const raw = JSON.stringify(card);
      assert.ok(!raw.includes('response_text'), fx.id + ': cards must not carry response_text');
      assert.ok(!raw.includes('provider_message_id'), fx.id + ': cards must not carry provider_message_id');
    }
    for (const e of report.exceptions) {
      const raw = JSON.stringify(e);
      assert.ok(!raw.includes('response_text'), fx.id + ': exceptions must not carry response_text');
      assert.ok(!raw.includes('provider_message_id'), fx.id + ': exceptions must not carry provider_message_id');
      assert.ok(!raw.includes('@example.com'), fx.id + ': exceptions must not carry email addresses');
    }
  }
});

test('exception envelopes carry the canonical key set', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    for (const e of report.exceptions) {
      assert.deepEqual(
        Object.keys(e).sort(),
        ['category', 'channel', 'detected_at', 'evidence', 'lead_id', 'outreach_id', 'reason', 'response_id', 'run_id', 'severity'].sort(),
        fx.id + ': exception envelope keys',
      );
    }
  }
});

test('summary invariant: record counts always partition the full response log', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    if (report.status !== 'COMPLETED') continue;
    const s = report.summary;
    const violationCards = report.results.filter((r) => r.reconciliation_status === 'VIOLATION').length;
    const violationRowsNotDuplicates = violationCards - s.duplicate_records;
    assert.equal(
      s.response_records,
      s.matched_records + s.not_verifiable + s.invalid_records + s.duplicate_records + violationRowsNotDuplicates,
      fx.id + ': partition invariant',
    );
    assert.equal(report.results.length, s.response_records, fx.id + ': results = response_records');
    assert.equal(s.exception_count, report.exceptions.length, fx.id + ': exception_count');
    assert.ok(s.linked_records >= s.matched_records, fx.id + ': linked_records >= matched_records');
  }
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

test('reconciliation is deterministic for identical inputs', () => {
  for (const id of ['TEST-RESP-RECON-001', 'TEST-RESP-RECON-009', 'TEST-RESP-RECON-018']) {
    const fx = fixtureById(id);
    const a = runFixture(fx);
    const b = runFixture(fx);
    assert.deepEqual(stripRuntime(a), stripRuntime(b), id + ': deterministic');
  }
});

test('reconciliation is order-independent on both source arrays', () => {
  for (const id of ['TEST-RESP-RECON-001', 'TEST-RESP-RECON-008', 'TEST-RESP-RECON-017', 'TEST-RESP-RECON-018']) {
    const fx = fixtureById(id);
    const normal = runFixture(fx);
    const reordered = reconcileResponses({
      responseRows: fx.initialResponseRows.slice().reverse(),
      outreachRows: fx.initialOutreachRows.slice().reverse(),
      responseReadError: fx.response_read_error,
      outreachReadError: fx.outreach_read_error,
      now: FIXED_NOW,
    });
    assert.deepEqual(stripRuntime(normal), stripRuntime(reordered), id + ': order-independent');
  }
});

test('reorder fixture 016 is identical to its parent 001', () => {
  const a = runFixture(fixtureById('TEST-RESP-RECON-001'));
  const b = runFixture(fixtureById('TEST-RESP-RECON-016'));
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('duplicate-carrier choice is independent of physical row order', () => {
  // The canonically-first key (lowest response_id) must be the verify carrier
  // regardless of array position.
  const rows = [
    { response_id: 'RES-B', idempotency_key: 'k-carrier::email', lead_id: 'L-C', outreach_id: 'EX-L-C-email', channel: 'email', response_status: 'CAPTURED' },
    { response_id: 'RES-A', idempotency_key: 'k-carrier::email', lead_id: 'L-C', outreach_id: 'EX-L-C-email', channel: 'email', response_status: 'CAPTURED' },
  ];
  const forward = reconcileResponses({
    responseRows: rows,
    outreachRows: [{ outreach_id: 'EX-L-C-email', lead_id: 'L-C', channel: 'email', sent_at: '2026-09-11T08:30:00.000Z' }],
    now: FIXED_NOW,
  });
  const backward = reconcileResponses({
    responseRows: rows.slice().reverse(),
    outreachRows: [{ outreach_id: 'EX-L-C-email', lead_id: 'L-C', channel: 'email', sent_at: '2026-09-11T08:30:00.000Z' }],
    now: FIXED_NOW,
  });
  assert.deepEqual(stripRuntime(forward), stripRuntime(backward));
  const verified = forward.results.filter((r) => r.reconciliation_status === 'VERIFIED');
  assert.equal(verified.length, 1);
  assert.equal(verified[0].response_id, 'RES-A', 'canonical (lowest id) row is the verified carrier');
});

/* ------------------------------------------------------------------ */
/* Read failure semantics                                              */
/* ------------------------------------------------------------------ */

test('each read-failure fixture yields INCOMPLETE with null dependent metrics and zero results', () => {
  for (const id of ['TEST-RESP-RECON-013', 'TEST-RESP-RECON-014', 'TEST-RESP-RECON-015']) {
    const report = runFixture(fixtureById(id));
    assert.equal(report.status, 'INCOMPLETE', id);
    assert.equal(report.results.length, 0, id + ': no classification on read failure');
    for (const field of [
      'response_records', 'matched_records', 'unmatched_records', 'linked_records',
      'not_verifiable', 'invalid_records', 'duplicate_records', 'violations', 'coverage_rate',
    ]) {
      assert.equal(report.summary[field], null, id + ': summary.' + field + ' must be null');
    }
    assert.deepEqual(categoriesOf(report), ['READ_FAILURE'], id);
    const errs = report.exceptions.filter((e) => e.category === 'READ_FAILURE');
    const expectedCount = (fixtureById(id).response_read_error ? 1 : 0) + (fixtureById(id).outreach_read_error ? 1 : 0);
    assert.equal(errs.length, expectedCount, id + ': one exception per failed source');
    for (const e of errs) {
      assert.equal(e.severity, 'ERROR', id);
      assert.match(JSON.stringify(e.evidence), /response log|outreach log/, id + ': evidence identifies source');
    }
  }
});

test('read failure propagates the untouched source-error state onto sources', () => {
  const report = runFixture(fixtureById('TEST-RESP-RECON-013'));
  assert.equal(report.sources.outreach_log_ok, false);
  assert.equal(report.sources.outreach_log_read_error, 'SheetNotFound');
  assert.equal(report.sources.response_log_ok, true);
  assert.equal(report.sources.response_log_read_error, '');
});

test('explicit run id is honored verbatim', () => {
  const report = runFixture(fixtureById('TEST-RESP-RECON-001'), { runId: 'RESPRECON-MANUAL-1' });
  assert.equal(report.run_id, 'RESPRECON-MANUAL-1');
});

test('non-string read errors and whitespace-only strings are treated truthfully as failures', () => {
  const report = reconcileResponses({
    responseRows: [],
    outreachRows: [],
    responseReadError: '   ',
    outreachReadError: 42,
    now: FIXED_NOW,
  });
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.summary.exception_count, 2);
  assert.equal(report.exceptions.length, 2);
});