'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { OUTREACH_COLUMNS } = require('../src/reconcile');
const { loadExecutionReconFixtures, EXEC_RECON_REGEX } = require('../src/execution-recon-fixtures');
const { MockSheets } = require('../src/mock-sheets');

const {
  parseArgs,
  seed,
  run,
  verify,
  buildVerifyOutcome,
  cleanup,
  verifyFinal,
  rowsForNamespace,
  reconcileScoped,
  loadEvidenceArtifacts,
  scenarioEvidence,
  assertLiveableScenario,
} = require('../scripts/run-execution-reconciliation-live');

const OUTREACH_TAB = 'Outreach Log';

function makeMock({ outreachRows = [] } = {}) {
  const mock = new MockSheets();
  const grid = [OUTREACH_COLUMNS];
  for (const row of outreachRows) {
    grid.push(OUTREACH_COLUMNS.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c]))));
  }
  mock.addTab(OUTREACH_TAB, grid);
  return mock;
}

const FIXTURES = loadExecutionReconFixtures();
const SCENARIO_001 = FIXTURES.find((f) => f.id === 'TEST-EXEC-RECON-001');
const SCENARIO_004 = FIXTURES.find((f) => f.id === 'TEST-EXEC-RECON-004');
const SCENARIO_015 = FIXTURES.find((f) => f.id === 'TEST-EXEC-RECON-015');
const SCENARIO_017 = FIXTURES.find((f) => f.id === 'TEST-EXEC-RECON-017');

test('live runner export surface is present', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof seed, 'function');
  assert.equal(typeof run, 'function');
  assert.equal(typeof verify, 'function');
  assert.equal(typeof buildVerifyOutcome, 'function');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof verifyFinal, 'function');
  assert.equal(typeof rowsForNamespace, 'function');
  assert.equal(typeof reconcileScoped, 'function');
  assert.equal(typeof loadEvidenceArtifacts, 'function');
  assert.equal(typeof scenarioEvidence, 'function');
  assert.equal(typeof assertLiveableScenario, 'function');
});

test('parseArgs: default scenario is TEST-EXEC-RECON-001', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.scenario, 'TEST-EXEC-RECON-001');
  assert.equal(args.execute, false);
  assert.deepEqual(args.phases, ['seed', 'run', 'verify', 'cleanup', 'verify-final']);
  const scoped = parseArgs(['--seed', '--execute', '--scenario=TEST-EXEC-RECON-004']);
  assert.equal(scoped.execute, true);
  assert.equal(scoped.scenario, 'TEST-EXEC-RECON-004');
  assert.deepEqual(scoped.phases, ['seed']);
});

test('parseArgs: reportsDir defaults to <project>/reports', () => {
  const args = parseArgs(['--run']);
  assert.equal(args.reportsDir, path.join(__dirname, '..', 'reports'));
});

test('assertLiveableScenario: throws for scenarios with read_errors', () => {
  assert.throws(
    () => assertLiveableScenario({ id: 'TEST-EXEC-RECON-017', read_errors: { outreach: 'sheet unavailable' } }),
    /cannot run live/,
  );
  assertLiveableScenario({ id: 'TEST-EXEC-RECON-001', read_errors: {} });
});

test('seed dry-run without --execute writes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: false, scenario: 'TEST-EXEC-RECON-001', reportsDir: os.tmpdir() });
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);
});

test('seed refuses non-namespaced scenario id', async () => {
  const mock = makeMock();
  await assert.rejects(
    () => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }),
    /TEST-EXEC-RECON/,
  );
});

test('seed appends outreach rows for scenario 001', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001', reportsDir: os.tmpdir() });
  const rows = mock.listRows(OUTREACH_TAB).slice(1);
  const leadIds = rows.map((r) => r[1]);
  assert.ok(leadIds.includes('TEST-EXEC-RECON-001'), 'appended lead present');
  assert.equal(rows.length, SCENARIO_001.outreachRows.length);
});

test('reconcileScoped matches engine reconcileExecution', () => {
  const result = reconcileScoped({
    evidence: SCENARIO_001.evidence,
    outreachRows: SCENARIO_001.outreachRows,
    evidenceAvailable: SCENARIO_001.evidence_available,
    now: Date.parse('2026-09-11T09:00:00.000Z'),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.match(result.run_id, /^EXECRECON-/);
  assert.equal(result.summary.execution_records, SCENARIO_001.evidence[0].results.length);
  assert.equal(result.summary.log_records, SCENARIO_001.outreachRows.length);
  assert.equal(result.summary.matched, 1);
});

test('reconcileScoped handles empty sources without error', () => {
  const result = reconcileScoped({
    evidence: [],
    outreachRows: [],
    evidenceAvailable: true,
    now: Date.parse('2026-09-11T09:00:00.000Z'),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summary.execution_records, 0);
  assert.equal(result.summary.log_records, 0);
});

test('rowsForNamespace filters TEST-EXEC-RECON-*, skips header', () => {
  const mock = makeMock({
    outreachRows: [
      { lead_id: 'TEST-EXEC-RECON-001', outreach_id: 'LOG-1', channel: 'email', sent_at: '2026-09-05T10:00:00.000Z', email: 'test@example.com', phone: '' },
      { lead_id: 'LEAD-PROD', outreach_id: 'LOG-2', channel: 'email', sent_at: '2026-09-05T10:00:00.000Z', email: 'prod@example.com', phone: '' },
      { lead_id: 'TEST-EXEC-RECON-002', outreach_id: 'LOG-3', channel: 'email', sent_at: '2026-09-05T10:00:00.000Z', email: 'test2@example.com', phone: '' },
    ],
  });
  const grid = mock.listRows(OUTREACH_TAB);
  const rows = rowsForNamespace(grid, OUTREACH_COLUMNS, 1);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => EXEC_RECON_REGEX.test(r.leadId)));
  assert.deepEqual(rows.map((r) => r.index).sort(), [1, 3]);
});

test('loadEvidenceArtifacts returns [] for non-existent directory', () => {
  const result = loadEvidenceArtifacts(path.join(os.tmpdir(), 'non-existent-dir-' + Date.now()));
  assert.deepEqual(result, []);
});

test('scenarioEvidence prefers artifacts matching scenario run_ids', () => {
  const scenario = { evidence: [{ run_id: 'EXECRECON-111', status: 'COMPLETED' }] };
  const artifacts = [
    { run_id: 'EXECRECON-111', status: 'COMPLETED', matched: 5 },
    { run_id: 'EXECRECON-999', status: 'COMPLETED', matched: 0 },
  ];
  const result = scenarioEvidence(scenario, artifacts);
  assert.equal(result.length, 1);
  assert.equal(result[0].matched, 5);
});

test('scenarioEvidence falls back to scenario evidence when no artifacts match', () => {
  const scenario = { evidence: [{ run_id: 'EXECRECON-111' }] };
  const artifacts = [{ run_id: 'EXECRECON-999' }];
  const result = scenarioEvidence(scenario, artifacts);
  assert.equal(result.length, 1);
  assert.equal(result[0].run_id, 'EXECRECON-111');
});

test('e2e: SEED -> RUN -> VERIFY -> CLEANUP -> VERIFY-FINAL', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-recon-reports-'));

  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001', reportsDir });
  assert.equal(mock.listRows(OUTREACH_TAB).length, SCENARIO_001.outreachRows.length + 1);

  const report = await run({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001', reportsDir });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.execution_records, SCENARIO_001.evidence[0].results.length);
  assert.equal(report.summary.matched, 1);
  const written = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-execution-reconciliation.json'));
  assert.equal(written.length, 1);

  const outcome = await verify({}, mock, { scenario: 'TEST-EXEC-RECON-001', reportsDir });
  assert.ok(outcome.ok, `verify must pass all metric checks; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);

  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001' }), true);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);

  await verifyFinal(mock);
  assert.equal(process.exitCode, undefined);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001', reportsDir: os.tmpdir() });
  const before = mock.listRows(OUTREACH_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-EXEC-RECON-001' }), false);
  assert.equal(mock.listRows(OUTREACH_TAB).length, before);
});

test('cleanup: deletes only TEST-EXEC-RECON rows; production rows survive', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001', reportsDir: os.tmpdir() });
  mock.appendRows(OUTREACH_TAB, [
    OUTREACH_COLUMNS.map((c, i) => i === 1 ? 'LEAD-PROD' : i === 3 ? 'email' : i === 5 ? 'prod@example.com' : ''),
  ]);
  const beforeProd = mock.listRows(OUTREACH_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-EXEC-RECON-001' }), true);
  const survivors = mock.listRows(OUTREACH_TAB).slice(1).map((r) => r[1]);
  assert.deepEqual(survivors, ['LEAD-PROD']);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 2);
});

test('spawn guard: GOOGLE_SHEET_ID missing exits 1', (t, done) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-execution-reconciliation-live.js');
  const env = Object.assign({}, process.env);
  delete env.GOOGLE_SHEET_ID;
  const proc = spawn(process.execPath, [scriptPath, '--run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  proc.on('close', (code) => {
    assert.equal(code, 1, 'expected exit code 1 when GOOGLE_SHEET_ID is missing');
    assert.ok(stderr.includes('GOOGLE_SHEET_ID'), 'stderr mentions GOOGLE_SHEET_ID');
    done();
  });
  proc.on('error', (err) => { done(err); });
});
