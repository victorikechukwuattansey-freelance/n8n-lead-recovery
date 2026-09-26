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
  reconcileScoped,
  buildVerifyOutcome,
} = require('../scripts/run-reconciliation-live');

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
  assert.equal(typeof reconcileScoped, 'function');
  assert.equal(typeof buildVerifyOutcome, 'function');
});

test('parseArgs: default dry-run scenario is TEST-RECON-010', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.phases.join(','), 'seed,run,verify,cleanup,verify-final');
  assert.equal(args.scenario, 'TEST-RECON-010');
  assert.equal(args.execute, false);
  const scoped = parseArgs(['--seed', '--execute', '--scenario=TEST-RECON-001']);
  assert.equal(scoped.execute, true);
  assert.equal(scoped.scenario, 'TEST-RECON-001');
  assert.deepEqual(scoped.phases, ['seed']);
});

test('seed dry-run is a no-op: nothing written without --execute', async () => {
  const mock = makeMock();
  const beforeApproved = mock.listRows(APPROVED_TAB).length;
  const beforeOutreach = mock.listRows(OUTREACH_TAB).length;
  await seed({}, mock, { execute: false, scenario: 'TEST-RECON-001' });
  assert.equal(mock.listRows(APPROVED_TAB).length, beforeApproved);
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeOutreach);
});

test('seed refuses non-namespaced scenario ids', async () => {
  const mock = makeMock();
  await assert.rejects(() => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }), /TEST-RECON/);
});

test('e2e: SEED -> VERIFY (metrics match scenario) -> CLEANUP -> VERIFY-FINAL', async () => {
  const mock = makeMock();
  const env = {};
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-reports-'));

  await seed(env, mock, { execute: true, scenario: 'TEST-RECON-010', reportsDir });
  assert.equal(mock.listRows(APPROVED_TAB).length, 8); // header + 7 approved
  assert.equal(mock.listRows(OUTREACH_TAB).length, 7); // header + 6 outreach

  const outcome = await verify(env, mock, { scenario: 'TEST-RECON-010', reportsDir });
  assert.ok(outcome.ok, 'verify outcome must pass all metric checks');
  assert.equal(outcome.passed, outcome.total);
  assert.ok(outcome.total >= 11);
  assert.equal(outcome.report.approved_total, 7);
  assert.equal(outcome.report.coverage_rate, 0.5);
  assert.equal(outcome.report.exception_count, 5);

  const artifact = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-reconciliation.json'));
  assert.equal(artifact.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(reportsDir, artifact[0]), 'utf8'));
  assert.equal(written.status, 'COMPLETED');
  assert.equal(written.run_id, outcome.report.run_id);

  assert.equal(await cleanup(env, mock, { execute: true, scenario: 'TEST-RECON-010' }), true);
  assert.equal(mock.listRows(APPROVED_TAB).length, 1); // header only
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);

  await verifyFinal(mock);
  assert.equal(process.exitCode, undefined, 'verify-final must not set a failure exit code');

  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('cleanup: deletes only TEST-RECON rows; production rows survive', async () => {
  const mock = makeMock();
  mock.appendRows(APPROVED_TAB, [[
    'LEAD-PROD', 'Prod Co', '', '', '', '', '', '', '', '', '', '', '', '', '', '70', 'QUALIFIED',
    'email', 'not_ready', '2026-09-02T00:00:00.000Z', '',
  ]]);
  await seed({}, mock, { execute: true, scenario: 'TEST-RECON-001' });
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RECON-001' }), true);
  const survivors = mock.listRows(APPROVED_TAB).slice(1).map((r) => r[0]);
  assert.deepEqual(survivors, ['LEAD-PROD']);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1); // header only
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RECON-001' });
  const before = mock.listRows(APPROVED_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-RECON-001' }), false);
  assert.equal(mock.listRows(APPROVED_TAB).length, before);
});

test('rowsForNamespace: filters TEST-RECON-* only, skips header, reports grid indexes', () => {
  const re = /^TEST-RECON-\d+$/;
  const grid = [
    APPROVED_COLUMNS,
    ['TEST-RECON-001', 'A Co'],
    ['LEAD-PROD', 'Prod Co'],
    ['TEST-RECON-009', 'Z Co'],
  ];
  const rows = rowsForNamespace(grid, APPROVED_COLUMNS, 0);
  assert.deepEqual(rows.map((r) => r.leadId), ['TEST-RECON-001', 'TEST-RECON-009']);
  assert.deepEqual(rows.map((r) => r.index), [1, 3]);
  assert.ok(rows.every((r) => re.test(r.leadId)));
});

test('reconcileScoped: delegates to the engine with a stable run id prefix', () => {
  const { reconcileFromSheets } = require('../src/reconcile');
  const result = reconcileScoped({ approvedRows: [], outreachRows: [] });
  assert.equal(result.report.status, 'COMPLETED');
  assert.match(result.report.run_id, /^RECONCILIATION-/);
  assert.equal(result.report.approved_total, 0);
  assert.equal(result.report.coverage_rate, null);
  const direct = reconcileFromSheets({ approvedRows: [], outreachRows: [] });
  assert.equal(direct.report.status, result.report.status);
});