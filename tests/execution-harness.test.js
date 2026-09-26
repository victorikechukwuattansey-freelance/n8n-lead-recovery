'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { APPROVED_COLUMNS } = require('../src/schema');
const { OUTREACH_COLUMNS } = require('../src/reconcile');
const { MockSheets } = require('../src/mock-sheets');
const {
  parseArgs,
  seed,
  runLocal,
  verify,
  cleanup,
  verifyFinal,
  rowsForNamespace,
  executionScoped,
  expectedPostRun,
} = require('../scripts/run-execution-live');

const APPROVED_TAB = 'Approved Outreach';
const OUTREACH_TAB = 'Outreach Log';

function makeMock() {
  const mock = new MockSheets();
  mock.addTab(APPROVED_TAB, [APPROVED_COLUMNS]);
  mock.addTab(OUTREACH_TAB, [OUTREACH_COLUMNS]);
  return mock;
}

function tmpReports() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-reports-'));
}

test('live runner export surface is present', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof seed, 'function');
  assert.equal(typeof runLocal, 'function');
  assert.equal(typeof verify, 'function');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof verifyFinal, 'function');
  assert.equal(typeof rowsForNamespace, 'function');
  assert.equal(typeof executionScoped, 'function');
  assert.equal(typeof expectedPostRun, 'function');
});

test('parseArgs: safe defaults (DRY_RUN, NOT_CONFIGURED, TEST-EXEC-001) and flags', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.phases.join(','), 'seed,run,verify,cleanup,verify-final');
  assert.equal(args.scenario, 'TEST-EXEC-001');
  assert.equal(args.mode, 'DRY_RUN');
  assert.equal(args.provider, 'NOT_CONFIGURED');
  assert.equal(args.execute, false);
  const scoped = parseArgs(['--seed', '--execute', '--local', '--mode=real', '--provider=failure', '--scenario=TEST-EXEC-009']);
  assert.deepEqual(scoped.phases, ['seed']);
  assert.equal(scoped.mode, 'REAL');
  assert.equal(scoped.provider, 'FAILURE');
  assert.equal(scoped.local, true);
});

test('seed dry-run is a no-op: nothing written without --execute', async () => {
  const mock = makeMock();
  const beforeA = mock.listRows(APPROVED_TAB).length;
  const beforeO = mock.listRows(OUTREACH_TAB).length;
  await seed({}, mock, { execute: false, scenario: 'TEST-EXEC-001' });
  assert.equal(mock.listRows(APPROVED_TAB).length, beforeA);
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeO);
});

test('seed refuses non-namespaced scenario ids', async () => {
  const mock = makeMock();
  await assert.rejects(() => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }), /TEST-EXEC/);
});

test('seed refuses read-error scenarios which cannot run against a live spreadsheet', async () => {
  const mock = makeMock();
  for (const id of ['TEST-EXEC-011', 'TEST-EXEC-012']) {
    await assert.rejects(() => seed({}, mock, { execute: true, scenario: id }), /read errors/);
  }
});

test('runLocal dry-run writes nothing, twice', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-001' });
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-001', mode: 'DRY_RUN', provider: 'NOT_CONFIGURED', reportsDir };
  const first = await runLocal(mock, args);
  const second = await runLocal(mock, args);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.executed_succeeded, 0);
  assert.equal(first.log_rows_written, 0);
  assert.equal(first.executed_skipped, 1);
  assert.equal(second.executed_skipped, 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1); // header only
  assert.equal(mock.listRows(APPROVED_TAB).length, 2); // header + seeded lead
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('runLocal REAL + SUCCESS commits exactly one row; a second run suppresses it', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-001' });
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-001', mode: 'REAL', provider: 'SUCCESS', reportsDir };
  const first = await runLocal(mock, args);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(first.executed_succeeded, 1);
  assert.equal(first.log_rows_written, 1);
  assert.equal(first.provider_calls, 1);

  const rows = mock.listRows(OUTREACH_TAB);
  assert.equal(rows.length, 2); // header + 1 committed
  const committed = rows[1];
  assert.equal(committed[0], 'EX-TEST-EXEC-001-email');
  assert.equal(committed[1], 'TEST-EXEC-001');
  assert.ok(committed[8], 'sent_at must be present');
  assert.equal(committed[11], ''); // reply_status stays canonical-empty
  assert.equal(committed[19], ''); // outcome stays canonical-empty

  const second = await runLocal(mock, args);
  assert.equal(second.executed_succeeded, 0);
  assert.equal(second.duplicate_suppressed, 1);
  assert.equal(second.log_rows_written, 0);
  assert.equal(second.provider_calls, 0);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 2); // still header + 1
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('runLocal REAL + FAILURE writes nothing and reports the failure', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-009' });
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-009', mode: 'REAL', provider: 'FAILURE', reportsDir };
  const run = await runLocal(mock, args);
  assert.equal(run.executed_failed, 1);
  assert.equal(run.log_rows_written, 0);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('runLocal REAL + NOT_CONFIGURED refuses honestly and writes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-010' });
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-010', mode: 'REAL', provider: 'NOT_CONFIGURED', reportsDir };
  const run = await runLocal(mock, args);
  assert.equal(run.provider_configured, false);
  assert.equal(run.results[0].status, 'EXECUTION_FAILED');
  assert.equal(run.results[0].reason, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(run.log_rows_written, 0);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('runLocal without --execute never appends, even in REAL + SUCCESS', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-001' });
  const reportsDir = tmpReports();
  const args = { execute: false, local: true, scenario: 'TEST-EXEC-001', mode: 'REAL', provider: 'SUCCESS', reportsDir };
  const run = await runLocal(mock, args);
  assert.equal(run.executed_succeeded, 1);
  assert.equal(run.log_rows_written, 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1); // staged but NOT appended
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('e2e: SEED -> RUN(REAL+SUCCESS) -> VERIFY -> CLEANUP -> VERIFY-FINAL', async () => {
  const mock = makeMock();
  const env = {};
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-002', mode: 'REAL', provider: 'SUCCESS', reportsDir };

  await seed(env, mock, args);
  assert.equal(mock.listRows(APPROVED_TAB).length, 2);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);

  const run = await runLocal(mock, args);
  assert.equal(run.executed_succeeded, 1);
  assert.equal(run.log_rows_written, 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 2);

  const outcome = await verify(env, mock, args);
  assert.ok(outcome.ok, 'verify outcome must pass all checks');
  assert.equal(outcome.passed, outcome.total);
  assert.ok(outcome.total >= 24, 'coverage includes clean + post-run + committed-row checks');
  assert.equal(outcome.lines.filter((l) => l.label.startsWith('log row')).length, 1);

  const artifacts = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-execution.json'));
  assert.ok(artifacts.length >= 1, 'run and/or verify report artifact must be written');
  const reportArtifacts = artifacts.map((f) => JSON.parse(fs.readFileSync(path.join(reportsDir, f), 'utf8')));
  assert.ok(reportArtifacts.every((r) => r.status === 'COMPLETED'));
  assert.equal(outcome.clean.status, 'COMPLETED', 'verify report contract holds');

  assert.equal(await cleanup(env, mock, args), true);
  assert.equal(mock.listRows(APPROVED_TAB).length, 1); // header only
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);

  await verifyFinal(mock);
  assert.equal(process.exitCode, undefined, 'verify-final must not set a failure exit code');

  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('e2e: SEED -> RUN(dry-run) -> VERIFY double-run writes zero rows', async () => {
  const mock = makeMock();
  const env = {};
  const reportsDir = tmpReports();
  const args = { execute: true, local: true, scenario: 'TEST-EXEC-003', mode: 'DRY_RUN', provider: 'NOT_CONFIGURED', reportsDir };

  await seed(env, mock, args);
  await runLocal(mock, args);
  await runLocal(mock, args);
  const outcome = await verify(env, mock, args);

  assert.ok(outcome.ok, 'dry-run verify must pass');
  const post = outcome.lines.find((l) => l.label.startsWith('post-run log_rows_written'));
  assert.ok(post && post.ok);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('cleanup: deletes only TEST-EXEC rows; production rows survive', async () => {
  const mock = makeMock();
  mock.appendRows(APPROVED_TAB, [[
    'LEAD-PROD', 'Prod Co', '', '', '', '', '', '', '', '', '', '', 'email', '', '', '70', 'QUALIFIED',
    'email', 'approved', '2026-09-02T00:00:00.000Z', '',
  ]]);
  mock.appendRows(OUTREACH_TAB, [OUTREACH_COLUMNS.map((c, i) => (c === 'lead_id' ? 'LEAD-PROD' : c === 'outreach_id' ? 'OR-PROD-1' : c === 'channel' ? 'email' : c === 'sent_at' ? '2026-09-02T00:00:00.000Z' : ''))]);
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-001' });
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-EXEC-001' }), true);
  const survivorsA = mock.listRows(APPROVED_TAB).slice(1).map((r) => r[0]);
  assert.deepEqual(survivorsA, ['LEAD-PROD']);
  const survivorsO = mock.listRows(OUTREACH_TAB).slice(1).map((r) => r[1]);
  assert.deepEqual(survivorsO, ['LEAD-PROD']);
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-001' });
  const beforeA = mock.listRows(APPROVED_TAB).length;
  const beforeO = mock.listRows(OUTREACH_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-EXEC-001' }), false);
  assert.equal(mock.listRows(APPROVED_TAB).length, beforeA);
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeO);
});

test('rowsForNamespace: filters TEST-EXEC-* only, skips header, reports grid indexes', () => {
  const grid = [
    APPROVED_COLUMNS,
    ['TEST-EXEC-001', 'A Co'],
    ['LEAD-PROD', 'Prod Co'],
    ['TEST-EXEC-009', 'Z Co'],
  ];
  const rows = rowsForNamespace(grid, APPROVED_COLUMNS, 0);
  assert.deepEqual(rows.map((r) => r.leadId), ['TEST-EXEC-001', 'TEST-EXEC-009']);
  assert.deepEqual(rows.map((r) => r.index), [1, 3]);
});

test('outreach rows are located by lead column (col 1) for namespace scoping', () => {
  const grid = [
    OUTREACH_COLUMNS,
    ['OR-0001', 'TEST-EXEC-001', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['OR-0002', 'LEAD-PROD', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const rows = rowsForNamespace(grid, OUTREACH_COLUMNS, 1);
  assert.deepEqual(rows.map((r) => r.leadId), ['TEST-EXEC-001']);
});

test('expectedPostRun: successful leader paths become duplicate-suppressed on rerun', () => {
  const clean = {
    executed_succeeded: 2,
    executed_failed: 0,
    executed_skipped: 1,
    executed_rejected: 1,
    executed_attempted: 2,
    duplicate_suppressed: 0,
    log_rows_written: 2,
    provider_calls: 2,
  };
  const post = expectedPostRun(clean);
  assert.equal(post.executed_attempted, 0);
  assert.equal(post.executed_succeeded, 0);
  assert.equal(post.duplicate_suppressed, 2);
  assert.equal(post.log_rows_written, 0);
  assert.equal(post.provider_calls, 0);
});

test('executionScoped: delegates to the engine with a stable EXECUTION run id', async () => {
  const report = await executionScoped({ approvedRows: [], outreachRows: [], mode: 'DRY_RUN', provider: 'NOT_CONFIGURED' });
  assert.equal(report.status, 'COMPLETED');
  assert.match(report.run_id, /^EXECUTION-/);
  assert.equal(report.approved_total, 0);
  assert.equal(report.queue_total, 0);
  assert.equal(report.executed_attempted, 0);
});