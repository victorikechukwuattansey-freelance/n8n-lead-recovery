'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileExecution, CATEGORY, SEVERITY, VIOLATION_CATEGORIES, RUN_LABEL, SUPPORTED_CHANNELS } = require('../src/execution-reconcile');
const { loadExecutionReconFixtures } = require('../src/execution-recon-fixtures');

const FIXED_NOW = new Date('2026-09-11T09:00:00.000Z').getTime();

const fixtures = loadExecutionReconFixtures();

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function runFixture(fx) {
  return reconcileExecution({
    executionReports: fx.evidence,
    logRows: fx.outreachRows,
    evidenceAvailable: fx.evidence_available,
    readErrors: fx.read_errors,
    now: FIXED_NOW,
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

/* ------------------------------------------------------------------ */
/* Contract surface                                                    */
/* ------------------------------------------------------------------ */

test('engine exports the full category and severity vocabulary', () => {
  for (const category of [
    'EXECUTION_WITHOUT_LOG', 'LOG_WITHOUT_EXECUTION', 'DUPLICATE_EXECUTION', 'DUPLICATE_LOG',
    'FAILED_AS_SUCCESS', 'NON_READY_EXECUTION', 'INVALID_CHANNEL', 'DRY_RUN_PERSISTENCE',
    'NOT_CONFIGURED_PERSISTENCE', 'MALFORMED_RECORD', 'SOURCE_READ_FAILURE',
  ]) {
    assert.equal(CATEGORY[category], category);
    assert.ok(SEVERITY[Object.values(SEVERITY).find((s) => s)].length > 0);
  }
  assert.deepEqual(
    VIOLATION_CATEGORIES.sort(),
    ['DRY_RUN_PERSISTENCE', 'DUPLICATE_EXECUTION', 'DUPLICATE_LOG', 'FAILED_AS_SUCCESS',
      'NON_READY_EXECUTION', 'NOT_CONFIGURED_PERSISTENCE'].sort(),
  );
  assert.equal(RUN_LABEL, 'EXECRECON');
  assert.deepEqual(SUPPORTED_CHANNELS, ['email', 'call']);
});

test('fixture set covers the full TEST-EXEC-RECON-001..018 range', () => {
  const ids = fixtures.map((f) => f.id);
  for (let i = 1; i <= 18; i += 1) {
    const id = `TEST-EXEC-RECON-${String(i).padStart(3, '0')}`;
    assert.ok(ids.includes(id), 'missing fixture ' + id);
  }
  assert.equal(fixtures.length, 18);
});

/* ------------------------------------------------------------------ */
/* Fixture expectations                                                */
/* ------------------------------------------------------------------ */

test('every fixture reconciles to its documented summary and exceptions', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    const exp = fx.expected;
    assert.equal(report.status, exp.status, fx.id + ': status');
    assert.equal(report.evidence_available, exp.evidence_available, fx.id + ': evidence_available');
    const summary = report.summary;
    for (const field of [
      'execution_records', 'log_records', 'matched', 'unmatched_execution', 'unmatched_log',
      'duplicate_execution', 'duplicate_log', 'invalid_execution', 'invalid_log',
      'violations', 'coverage_rate', 'exception_count',
    ]) {
      assert.equal(summary[field], exp[field], fx.id + ': summary.' + field);
    }
    assert.equal(summary.invalid_execution, exp.invalid_execution, fx.id + ': invalid_execution');
    assert.deepEqual(categoriesOf(report), exp.exception_categories, fx.id + ': exception categories');
  }
});

test('run_id follows the EXECRECON label with 14-digit second granularity', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-016'));
  assert.match(report.run_id, /^EXECRECON-\d{14}$/);
  const digits = String(new Date(FIXED_NOW).getTime()).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  assert.equal(report.run_id, `EXECRECON-${digits}`);
  assert.equal(report.run_at, new Date(FIXED_NOW).toISOString());
});

/* ------------------------------------------------------------------ */
/* Identity and determinism                                            */
/* ------------------------------------------------------------------ */

test('reconciliation is deterministic for identical inputs', () => {
  const fx = fixtureById('TEST-EXEC-RECON-001');
  const a = runFixture(fx);
  const b = runFixture(fx);
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('reconciliation is order-independent: reordering records yields an identical report', () => {
  for (const id of ['TEST-EXEC-RECON-001', 'TEST-EXEC-RECON-005', 'TEST-EXEC-RECON-015']) {
    const fx = fixtureById(id);
    const normal = runFixture(fx);
    const reordered = reconcileExecution({
      executionReports: fx.evidence.slice().reverse(),
      logRows: fx.outreachRows.slice().reverse(),
      evidenceAvailable: fx.evidence_available,
      readErrors: fx.read_errors,
      now: FIXED_NOW,
    });
    assert.deepEqual(stripRuntime(normal), stripRuntime(reordered), id + ': order-independent');
  }
});

test('row position is never used as business identity (reorder fixture 018)', () => {
  const fx = fixtureById('TEST-EXEC-RECON-018');
  const report = runFixture(fx);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.matched, 1);
  assert.deepEqual(categoriesOf(report), []);
});

/* ------------------------------------------------------------------ */
/* Read failure / evidence availability semantics                      */
/* ------------------------------------------------------------------ */

test('read failure produces FAILED with null metrics and a source-naming exception (never a false zero)', () => {
  for (const readErrors of [
    { outreach: 'Outreach Log sheet unavailable' },
    { evidence: 'execution evidence source unavailable' },
    { evidence: 'evidence read failed', outreach: 'log read failed' },
  ]) {
    const report = reconcileExecution({ executionReports: [], logRows: [], readErrors, now: FIXED_NOW });
    assert.equal(report.status, 'FAILED');
    for (const field of [
      'execution_records', 'log_records', 'matched', 'unmatched_execution', 'unmatched_log',
      'duplicate_execution', 'duplicate_log', 'invalid_execution', 'invalid_log',
      'violations', 'coverage_rate',
    ]) {
      assert.equal(report.summary[field], null, field + ' must be null on read failure');
    }
    assert.equal(report.summary.exception_count, Object.keys(readErrors).filter((k) => readErrors[k]).length);
    assert.ok(report.exceptions.every((e) => e.category === 'SOURCE_READ_FAILURE'));
    assert.ok(report.exceptions.every((e) => e.severity === 'ERROR'));
  }
});

test('empty successful sources are COMPLETED with valid zero metrics', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-016'));
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.execution_records, 0);
  assert.equal(report.summary.log_records, 0);
  assert.equal(report.summary.matched, 0);
  assert.equal(report.summary.exception_count, 0);
  assert.equal(report.summary.coverage_rate, null);
});

test('missing historical evidence yields INCOMPLETE with null execution-derived metrics, not a false zero', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-014'));
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.evidence_available, false);
  for (const field of ['execution_records', 'matched', 'unmatched_execution', 'unmatched_log', 'duplicate_execution', 'invalid_execution', 'coverage_rate']) {
    assert.equal(report.summary[field], null, field + ' must be null without evidence');
  }
  assert.equal(report.summary.log_records, 1);
  assert.ok(report.exceptions.every((e) => e.category === 'LOG_WITHOUT_EXECUTION' || e.category === 'DUPLICATE_LOG'), 'only log-derived issues are provable without evidence');
});

/* ------------------------------------------------------------------ */
/* Category semantics                                                   */
/* ------------------------------------------------------------------ */

test('EXECUTION_WITHOUT_LOG fires only for succeeded records with no matching log row', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-002'));
  assert.equal(report.summary.unmatched_execution, 1);
  assert.deepEqual(categoriesOf(report), ['EXECUTION_WITHOUT_LOG']);
  assert.equal(report.exceptions[0].severity, 'WARNING');
  assert.equal(report.unmatched_execution[0].lead_id, 'TEST-EXEC-RECON-002');
});

test('LOG_WITHOUT_EXECUTION is phrased as unable-to-establish, never as proof of error', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-003'));
  assert.equal(report.summary.unmatched_log, 1);
  const reason = report.exceptions[0].reason;
  assert.match(reason, /cannot be fully established/);
});

test('DUPLICATE_EXECUTION fires on a second confirmed execution for the same identity', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-004'));
  assert.equal(report.summary.duplicate_execution, 1);
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.violations, 1);
  assert.equal(report.exceptions[0].severity, 'ERROR');
});

test('DUPLICATE_LOG fires on repeated log rows for the same identity', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-005'));
  assert.equal(report.summary.duplicate_log, 1);
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.violations, 1);
});

test('provider failure represented correctly is NOT a violation (attempted-but-failed ≠ confirmed send)', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-006'));
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.exception_count, 0);
  assert.equal(report.summary.violations, 0);
  assert.equal(report.summary.unmatched_execution, 0);
});

test('provider failure represented as a durable row is FAILED_AS_SUCCESS', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-007'));
  assert.equal(report.summary.unmatched_log, 1);
  assert.equal(report.summary.violations, 1);
  assert.deepEqual(categoriesOf(report), ['FAILED_AS_SUCCESS']);
});

test('DRY_RUN with no log is healthy; DRY_RUN with durable activity is DRY_RUN_PERSISTENCE', () => {
  const healthy = runFixture(fixtureById('TEST-EXEC-RECON-008'));
  assert.equal(healthy.summary.exception_count, 0);
  assert.equal(healthy.status, 'COMPLETED');
  const violating = runFixture(fixtureById('TEST-EXEC-RECON-009'));
  assert.equal(violating.summary.unmatched_log, 1);
  assert.deepEqual(categoriesOf(violating), ['DRY_RUN_PERSISTENCE']);
  assert.equal(violating.summary.violations, 1);
});

test('NOT_CONFIGURED with no log is the expected safety state; with durable activity it is NOT_CONFIGURED_PERSISTENCE', () => {
  const safe = runFixture(fixtureById('TEST-EXEC-RECON-010'));
  assert.equal(safe.summary.exception_count, 0);
  const violating = runFixture(fixtureById('TEST-EXEC-RECON-011'));
  assert.deepEqual(categoriesOf(violating), ['NOT_CONFIGURED_PERSISTENCE']);
  assert.equal(violating.summary.violations, 1);
});

test('NOT_CONFIGURED is never reported as an external provider failure', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-010'));
  assert.ok(report.exceptions.every((e) => e.category !== 'FAILED_AS_SUCCESS'));
  const sources = report.sources;
  assert.equal(sources.evidence_ok, true);
});

test('malformed records are isolated as MALFORMED_RECORD and never become identity', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-012'));
  assert.equal(report.summary.invalid_log, 1);
  assert.deepEqual(categoriesOf(report), ['MALFORMED_RECORD']);
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.violations, 0);
});

test('NON_READY_EXECUTION is provable only from captured readiness at execution time', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-013'));
  assert.equal(report.summary.matched, 1);
  assert.deepEqual(categoriesOf(report), ['NON_READY_EXECUTION']);
  assert.equal(report.exceptions[0].severity, 'ERROR');
  assert.equal(report.exceptions[0].evidence.readiness_status, 'NOT_READY');
});

test('invalid channels are flagged and excluded from identity matching', () => {
  const report = runFixture(fixtureById('TEST-EXEC-RECON-015'));
  assert.deepEqual(categoriesOf(report), ['INVALID_CHANNEL']);
  assert.equal(report.summary.matched, 1);
  assert.equal(report.summary.invalid_log, 0);
  assert.equal(report.summary.violations, 0);
});

/* ------------------------------------------------------------------ */
/* Envelope hygiene                                                    */
/* ------------------------------------------------------------------ */

test('exception envelope contains no secrets, payload bodies, emails, or provider ids', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    for (const e of report.exceptions) {
      assert.deepEqual(
        Object.keys(e).sort(),
        ['category', 'channel', 'detected_at', 'evidence', 'execution_id', 'lead_id', 'outreach_id', 'reason', 'run_id', 'severity'].sort(),
        fx.id + ': exception envelope keys',
      );
      const raw = JSON.stringify(e);
      assert.ok(!raw.includes('@example.com'), fx.id + ': no email addresses in exceptions');
      assert.ok(!/provider_message_id/.test(raw), fx.id + ': no provider ids in exceptions');
      assert.ok(!/MOCK_PROVIDER_FAILURE|error_message/.test(raw), fx.id + ': no error bodies in exceptions');
    }
  }
});

test('summary counts derive consistently from the exception list', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    const dupExec = report.exceptions.filter((e) => e.category === 'DUPLICATE_EXECUTION').length;
    const dupLog = report.exceptions.filter((e) => e.category === 'DUPLICATE_LOG').length;
    const violations = report.exceptions.filter((e) => VIOLATION_CATEGORIES.includes(e.category)).length;
    assert.equal(report.summary.exception_count, report.exceptions.length, fx.id);
    if (report.status === 'FAILED') continue;
    if (!report.evidence_available) {
      assert.ok(
        report.summary.duplicate_execution === null && report.summary.duplicate_log === dupLog,
        fx.id,
      );
      assert.equal(report.summary.violations, violations, fx.id);
      continue;
    }
    assert.equal(report.summary.duplicate_execution, dupExec, fx.id);
    assert.equal(report.summary.duplicate_log, dupLog, fx.id);
    assert.equal(report.summary.violations, violations, fx.id);
  }
});

test('matched/unmatched lists are internally consistent with the summary', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    if (report.status === 'FAILED' || !report.evidence_available) continue;
    assert.equal(report.matched.length, report.summary.matched, fx.id);
    assert.equal(report.unmatched_execution.length, report.summary.unmatched_execution, fx.id);
    assert.equal(report.unmatched_log.length, report.summary.unmatched_log, fx.id);
  }
});