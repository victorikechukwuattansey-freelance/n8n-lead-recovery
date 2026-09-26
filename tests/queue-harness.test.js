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
  verify,
  cleanup,
  verifyFinal,
  rowsForNamespace,
  queueScoped,
  buildVerifyOutcome,
} = require('../scripts/run-outreach-queue-live');

const APPROVED_TAB = 'Approved Outreach';
const OUTREACH_TAB = 'Outreach Log';

function makeMock() {
  const mock = new MockSheets();
  mock.addTab(APPROVED_TAB, [APPROVED_COLUMNS]);
  mock.addTab(OUTREACH_TAB, [OUTREACH_COLUMNS]);
  return mock;
}

test('live runner export surface is present', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof seed, 'function');
  assert.equal(typeof verify, 'function');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof verifyFinal, 'function');
  assert.equal(typeof rowsForNamespace, 'function');
  assert.equal(typeof queueScoped, 'function');
  assert.equal(typeof buildVerifyOutcome, 'function');
});

test('parseArgs: default dry-run scenario is TEST-QUEUE-001', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.phases.join(','), 'seed,run,verify,cleanup,verify-final');
  assert.equal(args.scenario, 'TEST-QUEUE-001');
  assert.equal(args.execute, false);
  const scoped = parseArgs(['--seed', '--execute', '--scenario=TEST-QUEUE-005']);
  assert.equal(scoped.execute, true);
  assert.equal(scoped.scenario, 'TEST-QUEUE-005');
  assert.deepEqual(scoped.phases, ['seed']);
});

test('seed dry-run is a no-op: nothing written without --execute', async () => {
  const mock = makeMock();
  const beforeApproved = mock.listRows(APPROVED_TAB).length;
  const beforeOutreach = mock.listRows(OUTREACH_TAB).length;
  await seed({}, mock, { execute: false, scenario: 'TEST-QUEUE-001' });
  assert.equal(mock.listRows(APPROVED_TAB).length, beforeApproved);
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeOutreach);
});

test('seed refuses non-namespaced scenario ids', async () => {
  const mock = makeMock();
  await assert.rejects(() => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }), /TEST-QUEUE/);
});

test('e2e: SEED -> VERIFY (has history) -> CLEANUP -> VERIFY-FINAL', async () => {
  const mock = makeMock();
  const env = {};
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-reports-'));

  await seed(env, mock, { execute: true, scenario: 'TEST-QUEUE-005', reportsDir });
  assert.equal(mock.listRows(APPROVED_TAB).length, 2); // header + 1 approved
  assert.equal(mock.listRows(OUTREACH_TAB).length, 2); // header + 1 outreach

  const outcome = await verify(env, mock, { scenario: 'TEST-QUEUE-005', reportsDir });
  assert.ok(outcome.ok, 'verify outcome must pass all metric checks');
  assert.equal(outcome.passed, outcome.total);
  assert.ok(outcome.total >= 15, 'coverage must include the metric checks');
  assert.equal(outcome.report.approved_total, 1);
  assert.equal(outcome.report.queue_total, 1);
  assert.equal(outcome.report.ready_count, 1);
  assert.equal(outcome.report.email_ready_count, 1);
  assert.equal(outcome.report.history_attached, 1);
  assert.equal(outcome.report.outreach_total, 1);
  assert.equal(outcome.report.queue[0].outreach_count, 1);

  const artifact = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-outreach-queue.json'));
  assert.equal(artifact.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(reportsDir, artifact[0]), 'utf8'));
  assert.equal(written.status, 'COMPLETED');
  assert.equal(written.run_id, outcome.report.run_id);

  assert.equal(await cleanup(env, mock, { execute: true, scenario: 'TEST-QUEUE-005' }), true);
  assert.equal(mock.listRows(APPROVED_TAB).length, 1); // header only
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);

  await verifyFinal(mock);
  assert.equal(process.exitCode, undefined, 'verify-final must not set a failure exit code');

  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('verify: BLOCKED suppressed lead surfaces correctly from the sheets', async () => {
  const mock = makeMock();
  const env = {};
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-reports-'));
  await seed(env, mock, { execute: true, scenario: 'TEST-QUEUE-011', reportsDir });
  const outcome = await verify(env, mock, { scenario: 'TEST-QUEUE-011', reportsDir });
  assert.ok(outcome.ok, 'suppressed scenario must verify');
  assert.equal(outcome.report.blocked_count, 1);
  assert.equal(outcome.report.queue[0].readiness_status, 'BLOCKED');
  assert.equal(outcome.report.queue[0].enrichment_required, false);
  assert.equal(outcome.report.queue[0].available_channel, 'none');
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('cleanup: deletes only TEST-QUEUE rows; production rows survive', async () => {
  const mock = makeMock();
  mock.appendRows(APPROVED_TAB, [[
    'LEAD-PROD', 'Prod Co', '', '', '', '', '', '', '', '', '', '', '', '', '', '70', 'QUALIFIED',
    'email', 'not_ready', '2026-09-02T00:00:00.000Z', '',
  ]]);
  await seed({}, mock, { execute: true, scenario: 'TEST-QUEUE-001' });
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-QUEUE-001' }), true);
  const survivors = mock.listRows(APPROVED_TAB).slice(1).map((r) => r[0]);
  assert.deepEqual(survivors, ['LEAD-PROD']);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1); // header only
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-QUEUE-001' });
  const before = mock.listRows(APPROVED_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-QUEUE-001' }), false);
  assert.equal(mock.listRows(APPROVED_TAB).length, before);
});

test('rowsForNamespace: filters TEST-QUEUE-* only, skips header, reports grid indexes', () => {
  const re = /^TEST-QUEUE-\d+$/;
  const grid = [
    APPROVED_COLUMNS,
    ['TEST-QUEUE-001', 'A Co'],
    ['LEAD-PROD', 'Prod Co'],
    ['TEST-QUEUE-009', 'Z Co'],
  ];
  const rows = rowsForNamespace(grid, APPROVED_COLUMNS, 0);
  assert.deepEqual(rows.map((r) => r.leadId), ['TEST-QUEUE-001', 'TEST-QUEUE-009']);
  assert.deepEqual(rows.map((r) => r.index), [1, 3]);
  assert.ok(rows.every((r) => re.test(r.leadId)));
});

test('outreach rows are located by lead column (col 1) for namespace scoping', () => {
  const grid = [
    OUTREACH_COLUMNS,
    ['OR-0001', 'TEST-QUEUE-005', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['OR-0002', 'LEAD-PROD', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const rows = rowsForNamespace(grid, OUTREACH_COLUMNS, 1);
  assert.deepEqual(rows.map((r) => r.leadId), ['TEST-QUEUE-005']);
});

test('queueScoped: delegates to the engine with a stable run id prefix', () => {
  const { buildQueueFromSheets } = require('../src/queue');
  const result = queueScoped({ approvedRows: [], outreachRows: [] });
  assert.equal(result.report.status, 'COMPLETED');
  assert.match(result.report.run_id, /^QUEUE-/);
  assert.equal(result.report.approved_total, 0);
  assert.equal(result.report.queue_total, 0);
  assert.deepEqual(result.report.queue, []);
  const direct = buildQueueFromSheets({ approvedRows: [], outreachRows: [] });
  assert.equal(direct.report.status, result.report.status);
});