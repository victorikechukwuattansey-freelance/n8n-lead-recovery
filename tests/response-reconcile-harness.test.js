'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { RESPONSE_COLUMNS } = require('../src/response-capture');
const { OUTREACH_COLUMNS } = require('../src/reconcile');
const { RESP_RECON_REGEX } = require('../src/response-reconcile-fixtures');
const { MockSheets } = require('../src/mock-sheets');

const {
  parseArgs,
  seed,
  run,
  repeat,
  verify,
  buildVerifyOutcome,
  verifyIdempotency,
  cleanup,
  verifyCleanup,
  rowsForNamespace,
  reconcileScoped,
  assertLiveableScenario,
  assertNamespacedLead,
  DEFAULT_SCENARIO,
  RESPONSE_TAB,
  RESPONSE_LEAD_INDEX,
  OUTREACH_TAB,
  OUTREACH_LEAD_INDEX,
} = require('../scripts/run-response-reconciliation-live');

const { loadResponseReconcileFixtures } = require('../src/response-reconcile-fixtures');

const FIXTURES = loadResponseReconcileFixtures();

function fixtureById(id) {
  const fx = FIXTURES.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function makeMock({ responseRows = [], outreachRows = [] } = {}) {
  const mock = new MockSheets();
  const responseGrid = [RESPONSE_COLUMNS];
  for (const row of responseRows) {
    responseGrid.push(RESPONSE_COLUMNS.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c]))));
  }
  const outreachGrid = [OUTREACH_COLUMNS];
  for (const row of outreachRows) {
    outreachGrid.push(OUTREACH_COLUMNS.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c]))));
  }
  mock.addTab(RESPONSE_TAB, responseGrid);
  mock.addTab(OUTREACH_TAB, outreachGrid);
  return mock;
}

// fixture 017 has two namespaced rows on BOTH tabs -> ideal for lifecycle tests.
// fixture 001 is a single perfect match on both tabs.
// fixture 012 is empty on both tabs.
// fixture 013 simulates outreach read failure -> not liveable.
// fixture 005 persists an UNMATCHED capture row with an empty lead_id -> not liveable.
const SCENARIO_017 = fixtureById('TEST-RESP-RECON-017');
const SCENARIO_001 = fixtureById('TEST-RESP-RECON-001');
const SCENARIO_012 = fixtureById('TEST-RESP-RECON-012');

/* ------------------------------------------------------------------ */
/* Export surface and parseArgs                                        */
/* ------------------------------------------------------------------ */

test('live runner export surface is present', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof seed, 'function');
  assert.equal(typeof run, 'function');
  assert.equal(typeof repeat, 'function');
  assert.equal(typeof verify, 'function');
  assert.equal(typeof buildVerifyOutcome, 'function');
  assert.equal(typeof verifyIdempotency, 'function');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof verifyCleanup, 'function');
  assert.equal(typeof rowsForNamespace, 'function');
  assert.equal(typeof reconcileScoped, 'function');
  assert.equal(typeof assertLiveableScenario, 'function');
  assert.equal(typeof assertNamespacedLead, 'function');
  assert.equal(DEFAULT_SCENARIO, 'TEST-RESP-RECON-001');
  assert.equal(RESPONSE_TAB, 'Response Log');
  assert.equal(RESPONSE_LEAD_INDEX, 2);
  assert.equal(OUTREACH_TAB, 'Outreach Log');
  assert.equal(OUTREACH_LEAD_INDEX, 1);
});

test('parseArgs: default scenario is TEST-RESP-RECON-001', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.scenario, 'TEST-RESP-RECON-001');
  assert.equal(args.execute, false);
  assert.deepEqual(args.phases, ['seed', 'run', 'verify', 'repeat', 'verify-idempotency', 'cleanup', 'verify-cleanup']);
  const scoped = parseArgs(['--seed', '--execute', '--scenario=TEST-RESP-RECON-017']);
  assert.equal(scoped.execute, true);
  assert.equal(scoped.scenario, 'TEST-RESP-RECON-017');
  assert.deepEqual(scoped.phases, ['seed']);
});

test('parseArgs: reportsDir defaults to <project>/reports', () => {
  const args = parseArgs(['--run']);
  assert.equal(args.reportsDir, path.join(__dirname, '..', 'reports'));
});

/* ------------------------------------------------------------------ */
/* assertLiveableScenario / assertNamespacedLead                       */
/* ------------------------------------------------------------------ */

test('assertLiveableScenario: throws for read-error scenarios', () => {
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-013')), /cannot run live/);
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-014')), /cannot run live/);
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-015')), /cannot run live/);
});

test('assertLiveableScenario: throws when a durable row cannot be namespaced for cleanup', () => {
  // fixture 005: UNMATCHED response row with empty lead_id + non-namespaced outreach lead.
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-005')), /cannot run live/);
  // fixtures 009/010 use non-namespaced lead_ids on the outreach rows.
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-009')), /cannot run live/);
  assert.throws(() => assertLiveableScenario(fixtureById('TEST-RESP-RECON-010')), /cannot run live/);
});

test('assertLiveableScenario: accepts fully namespaced, error-free scenarios', () => {
  for (const id of ['TEST-RESP-RECON-001', 'TEST-RESP-RECON-002', 'TEST-RESP-RECON-012', 'TEST-RESP-RECON-016', 'TEST-RESP-RECON-017', 'TEST-RESP-RECON-018']) {
    assertLiveableScenario(fixtureById(id));
  }
});

test('assertNamespacedLead: rejects non-namespaced lead_id', () => {
  assert.throws(() => assertNamespacedLead('PROD-12345'), /Refusing to delete non-namespaced lead_id/);
  assertNamespacedLead('TEST-RESP-RECON-017');
});

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

test('seed dry-run without --execute writes nothing to either tab', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: false, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1, 'only header row in Response Log');
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1, 'only header row in Outreach Log');
});

test('seed refuses non-namespaced scenario id', async () => {
  const mock = makeMock();
  await assert.rejects(
    () => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }),
    /TEST-RESP-RECON/,
  );
});

test('seed appends namespaced rows to both tabs for fixture 017', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  const responseRows = mock.listRows(RESPONSE_TAB).slice(1);
  const outreachRows = mock.listRows(OUTREACH_TAB).slice(1);
  const responseIds = responseRows.map((r) => r[0]);
  const outreachIds = outreachRows.map((r) => r[0]);
  for (const row of SCENARIO_017.initialResponseRows) {
    assert.ok(responseIds.includes(row.response_id), 'response row present: ' + row.response_id);
  }
  for (const row of SCENARIO_017.initialOutreachRows) {
    assert.ok(outreachIds.includes(row.outreach_id), 'outreach row present: ' + row.outreach_id);
  }
  assert.equal(responseRows.length, SCENARIO_017.initialResponseRows.length);
  assert.equal(outreachRows.length, SCENARIO_017.initialOutreachRows.length);
});

test('seed deduplicates: running twice does not double-append rows', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  const beforeResponse = mock.listRows(RESPONSE_TAB).length;
  const beforeOutreach = mock.listRows(OUTREACH_TAB).length;
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  assert.equal(mock.listRows(RESPONSE_TAB).length, beforeResponse, 'no double-append in Response Log');
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeOutreach, 'no double-append in Outreach Log');
});

/* ------------------------------------------------------------------ */
/* run (read-only reconcile)                                           */
/* ------------------------------------------------------------------ */

test('run produces a report artifact without touching the spreadsheet', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-reports-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });

  const report = await run({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.equal(report.status, 'COMPLETED');
  assert.match(report.run_id, /^RESPRECON-/);
  assert.equal(report.summary.response_records, SCENARIO_017.initialResponseRows.length);

  const written = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-response-reconciliation.json'));
  assert.equal(written.length, 1, 'artifact file created');

  assert.equal(mock.listRows(RESPONSE_TAB).length, SCENARIO_017.initialResponseRows.length + 1, 'no new response rows written by run');
  assert.equal(mock.listRows(OUTREACH_TAB).length, SCENARIO_017.initialOutreachRows.length + 1, 'no new outreach rows written by run');
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* reconcileScoped / rowsForNamespace                                  */
/* ------------------------------------------------------------------ */

test('reconcileScoped wraps reconcileResponses deterministically', () => {
  const a = reconcileScoped({
    responseRows: SCENARIO_017.initialResponseRows,
    outreachRows: SCENARIO_017.initialOutreachRows,
  });
  const b = reconcileScoped({
    responseRows: SCENARIO_017.initialResponseRows,
    outreachRows: SCENARIO_017.initialOutreachRows,
  });
  assert.deepEqual(a, b, 'identical output across calls');
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.summary.matched_records, SCENARIO_017.expected.matched_records);
});

test('rowsForNamespace filters TEST-RESP-RECON-*, skips header', () => {
  const mock = makeMock({
    responseRows: [
      { lead_id: 'TEST-RESP-RECON-001', response_id: 'RES-001' },
      { lead_id: 'PROD-12345', response_id: 'RES-PROD' },
      { lead_id: 'TEST-RESP-RECON-002', response_id: 'RES-002' },
    ],
  });
  const grid = mock.listRows(RESPONSE_TAB);
  const rows = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => RESP_RECON_REGEX.test(r.leadId)));
  assert.deepEqual(rows.map((r) => r.index).sort(), [1, 3]);
});

/* ------------------------------------------------------------------ */
/* repeat (determinism simulation)                                     */
/* ------------------------------------------------------------------ */

test('repeat: second reconcile is byte-identical to the first', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-repeat-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });

  const second = await repeat({}, mock, { execute: false, scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.equal(second.summary.response_records, SCENARIO_017.initialResponseRows.length);
  assert.equal(second.summary.exception_count, SCENARIO_017.expected.exception_count);

  const first = reconcileScoped({
    responseRows: SCENARIO_017.initialResponseRows,
    outreachRows: SCENARIO_017.initialOutreachRows,
    runId: 'REPEAT-RUN-1',
  });
  const a = { ...first, run_id: '' };
  const b = { ...second, run_id: '' };
  assert.deepEqual(a, b, 'deterministic reports');
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* buildVerifyOutcome / verify                                         */
/* ------------------------------------------------------------------ */

test('buildVerifyOutcome: scenario 017 passes all checks with matching grids', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  const outcome = await buildVerifyOutcome({
    responseGrid: mock.listRows(RESPONSE_TAB),
    outreachGrid: mock.listRows(OUTREACH_TAB),
    scenario: SCENARIO_017,
  });
  assert.ok(outcome.ok, `all checks must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);
});

test('verify: e2e full verify cycle on seeded grids', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-verify-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });
  const outcome = await verify({}, mock, { scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.ok(outcome.ok, `verify must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('verify: empty scenario 012 passes with both empty tabs', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-verify-empty-'));
  const outcome = await verify({}, mock, { scenario: 'TEST-RESP-RECON-012', reportsDir });
  assert.ok(outcome.ok, `verify must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* verifyIdempotency                                                   */
/* ------------------------------------------------------------------ */

test('verifyIdempotency: identical reports across two reconciles over the same live rows', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-idem-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });
  const outcome = await verifyIdempotency({}, mock, { scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.ok(outcome.ok, `idempotency must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  // reconcile is read-only -> grids unchanged by the idempotency phase.
  assert.equal(mock.listRows(RESPONSE_TAB).length, SCENARIO_017.initialResponseRows.length + 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, SCENARIO_017.initialOutreachRows.length + 1);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* cleanup / verifyCleanup                                             */
/* ------------------------------------------------------------------ */

test('cleanup: deletes only TEST-RESP-RECON rows on both tabs; production rows survive', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  // append production rows on both tabs
  const prodResponse = RESPONSE_COLUMNS.map((c, i) => (i === RESPONSE_LEAD_INDEX ? 'PROD-LEAD' : i === 0 ? 'RES-PROD' : ''));
  mock.appendRows(RESPONSE_TAB, [prodResponse]);
  const prodOutreach = OUTREACH_COLUMNS.map((c, i) => (i === OUTREACH_LEAD_INDEX ? 'PROD-LEAD' : i === 0 ? 'EX-PROD-email' : ''));
  mock.appendRows(OUTREACH_TAB, [prodOutreach]);

  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017' }), true);
  const responseSurvivors = mock.listRows(RESPONSE_TAB).slice(1).map((r) => r[RESPONSE_LEAD_INDEX]);
  const outreachSurvivors = mock.listRows(OUTREACH_TAB).slice(1).map((r) => r[OUTREACH_LEAD_INDEX]);
  assert.deepEqual(responseSurvivors, ['PROD-LEAD'], 'production response row survives cleanup');
  assert.deepEqual(outreachSurvivors, ['PROD-LEAD'], 'production outreach row survives cleanup');
  assert.equal(mock.listRows(RESPONSE_TAB).length, 2);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 2);
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  const beforeResponse = mock.listRows(RESPONSE_TAB).length;
  const beforeOutreach = mock.listRows(OUTREACH_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-RESP-RECON-017' }), false);
  assert.equal(mock.listRows(RESPONSE_TAB).length, beforeResponse);
  assert.equal(mock.listRows(OUTREACH_TAB).length, beforeOutreach);
});

test('cleanup: empty grids are idempotent no-op', async () => {
  const mock = makeMock();
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017' }), true);
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1);
});

test('verifyCleanup: confirms zero TEST-RESP-RECON rows remain', async () => {
  const mock = makeMock();
  const saved = process.exitCode;
  process.exitCode = undefined;
  await verifyCleanup(mock);
  assert.equal(process.exitCode, undefined, 'no exit code change on clean grids');
  process.exitCode = saved;
});

test('verifyCleanup: detects leftover TEST-RESP-RECON rows', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir: os.tmpdir() });
  const saved = process.exitCode;
  process.exitCode = undefined;
  await verifyCleanup(mock);
  assert.equal(process.exitCode, 1, 'exitCode set to 1 when rows remain');
  process.exitCode = saved;
});

/* ------------------------------------------------------------------ */
/* e2e: full cycle on a clean mock                                     */
/* ------------------------------------------------------------------ */

test('e2e: SEED -> RUN -> VERIFY -> REPEAT -> VERIFY-IDEMPOTENCY -> CLEANUP -> VERIFY-CLEANUP', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-'));

  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.equal(mock.listRows(RESPONSE_TAB).length, SCENARIO_017.initialResponseRows.length + 1);
  assert.equal(mock.listRows(OUTREACH_TAB).length, SCENARIO_017.initialOutreachRows.length + 1);

  const report = await run({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.response_records, SCENARIO_017.initialResponseRows.length);
  assert.equal(report.summary.matched_records, SCENARIO_017.expected.matched_records);

  const outcome = await verify({}, mock, { scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.ok(outcome.ok, `verify must pass all checks; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);

  const second = await repeat({}, mock, { execute: false, scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.equal(second.summary.response_records, SCENARIO_017.initialResponseRows.length);

  const idemOutcome = await verifyIdempotency({}, mock, { scenario: 'TEST-RESP-RECON-017', reportsDir });
  assert.ok(idemOutcome.ok, 'idempotency must pass');

  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-RECON-017' }), true);
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1, 'only Response Log header remains');
  assert.equal(mock.listRows(OUTREACH_TAB).length, 1, 'only Outreach Log header remains');

  await verifyCleanup(mock);
  assert.equal(process.exitCode, undefined);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* spawn guard: GOOGLE_SHEET_ID missing                                */
/* ------------------------------------------------------------------ */

test('spawn guard: GOOGLE_SHEET_ID missing exits 1', (t, done) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-response-reconciliation-live.js');
  const env = Object.assign({}, process.env);
  delete env.GOOGLE_SHEET_ID;
  const proc = spawn(process.execPath, [scriptPath, '--all'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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