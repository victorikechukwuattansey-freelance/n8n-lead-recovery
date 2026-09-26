'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { RESPONSE_COLUMNS } = require('../src/response-capture');
const { loadResponseCaptureFixtures, RESP_REGEX } = require('../src/response-capture-fixtures');
const { MockSheets } = require('../src/mock-sheets');

const {
  parseArgs,
  seed,
  ingest,
  repeat,
  verify,
  buildVerifyOutcome,
  verifyIdempotency,
  cleanup,
  verifyCleanup,
  rowsForNamespace,
  captureScoped,
  keySet,
  assertLiveableScenario,
  assertNamespacedLead,
  DEFAULT_SCENARIO,
  RESPONSE_TAB,
  RESPONSE_LEAD_INDEX,
} = require('../scripts/run-response-capture-live');

function makeMock({ responseRows = [] } = {}) {
  const mock = new MockSheets();
  const grid = [RESPONSE_COLUMNS];
  for (const row of responseRows) {
    grid.push(RESPONSE_COLUMNS.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c]))));
  }
  mock.addTab(RESPONSE_TAB, grid);
  return mock;
}

const FIXTURES = loadResponseCaptureFixtures();
const SCENARIO_001 = FIXTURES.find((f) => f.id === 'TEST-RESP-001');
const SCENARIO_005 = FIXTURES.find((f) => f.id === 'TEST-RESP-005');
const SCENARIO_016 = FIXTURES.find((f) => f.id === 'TEST-RESP-016');
const SCENARIO_017 = FIXTURES.find((f) => f.id === 'TEST-RESP-017');
// fixture 017 has pre-existing initialResponseRows for lifecycle tests (seed/verify/cleanup)
// fixture 016 (REAL) has empty initialResponseRows and schedules no pre-existing rows
// fixture 001/005 are engine-only fixtures (no mock writes)

/* ------------------------------------------------------------------ */
/* Export surface and parseArgs                                         */
/* ------------------------------------------------------------------ */

test('live runner export surface is present', () => {
  assert.equal(typeof parseArgs, 'function');
  assert.equal(typeof seed, 'function');
  assert.equal(typeof ingest, 'function');
  assert.equal(typeof repeat, 'function');
  assert.equal(typeof verify, 'function');
  assert.equal(typeof buildVerifyOutcome, 'function');
  assert.equal(typeof verifyIdempotency, 'function');
  assert.equal(typeof cleanup, 'function');
  assert.equal(typeof verifyCleanup, 'function');
  assert.equal(typeof rowsForNamespace, 'function');
  assert.equal(typeof captureScoped, 'function');
  assert.equal(typeof keySet, 'function');
  assert.equal(typeof assertLiveableScenario, 'function');
  assert.equal(typeof assertNamespacedLead, 'function');
  assert.equal(DEFAULT_SCENARIO, 'TEST-RESP-001');
  assert.equal(RESPONSE_TAB, 'Response Log');
  assert.equal(RESPONSE_LEAD_INDEX, 2);
});

test('parseArgs: default scenario is TEST-RESP-001', () => {
  const args = parseArgs(['--all']);
  assert.equal(args.scenario, 'TEST-RESP-001');
  assert.equal(args.execute, false);
  assert.deepEqual(args.phases, ['seed', 'ingest', 'verify', 'repeat', 'verify-idempotency', 'cleanup', 'verify-cleanup']);
  const scoped = parseArgs(['--seed', '--execute', '--scenario=TEST-RESP-005']);
  assert.equal(scoped.execute, true);
  assert.equal(scoped.scenario, 'TEST-RESP-005');
  assert.deepEqual(scoped.phases, ['seed']);
});

test('parseArgs: reportsDir defaults to <project>/reports', () => {
  const args = parseArgs(['--ingest']);
  assert.equal(args.reportsDir, path.join(__dirname, '..', 'reports'));
});

/* ------------------------------------------------------------------ */
/* assertLiveableScenario / assertNamespacedLead                       */
/* ------------------------------------------------------------------ */

test('assertLiveableScenario: throws for scenarios with unmatched rows (empty lead_id cannot be cleaned)', () => {
  assert.throws(
    () => assertLiveableScenario({ id: 'TEST-RESP-005', mode: 'REAL', expected: { unmatched: 1 } }),
    /cannot run live/,
  );
  assertLiveableScenario({ id: 'TEST-RESP-005', mode: 'DRY_RUN', expected: { unmatched: 1 } });
  assertLiveableScenario({ id: 'TEST-RESP-001', mode: 'REAL', expected: { unmatched: 0 } });
});

test('assertNamespacedLead: rejects non-TEST-RESP lead_id', () => {
  assert.throws(() => assertNamespacedLead('PROD-12345'), /Refusing to delete non-namespaced lead_id/);
  assertNamespacedLead('TEST-RESP-001');
});

/* ------------------------------------------------------------------ */
/* seed                                                                */
/* ------------------------------------------------------------------ */

test('seed dry-run without --execute writes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: false, scenario: 'TEST-RESP-001', reportsDir: os.tmpdir() });
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1, 'only header row present');
});

test('seed refuses non-namespaced scenario id', async () => {
  const mock = makeMock();
  await assert.rejects(
    () => seed({}, mock, { execute: true, scenario: 'LEAD-ALPHA' }),
    /TEST-RESP/,
  );
});

test('seed appends response rows for fixture 017', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const rows = mock.listRows(RESPONSE_TAB).slice(1);
  const idemKeys = rows.map((r) => r[1]);
  for (const row of SCENARIO_017.initialResponseRows) {
    assert.ok(idemKeys.includes(row.idempotency_key), 'appended row key present: ' + row.idempotency_key);
  }
  assert.equal(rows.length, SCENARIO_017.initialResponseRows.length);
});

test('seed deduplicates: running twice does not double-append', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const before = mock.listRows(RESPONSE_TAB).length;
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const after = mock.listRows(RESPONSE_TAB).length;
  assert.equal(after, before, 'no double-append');
});

/* ------------------------------------------------------------------ */
/* ingest (read-only report)                                           */
/* ------------------------------------------------------------------ */

test('ingest produces a report artifact without touching the spreadsheet', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-reports-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });

  const report = await ingest({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });
  assert.equal(report.status, 'COMPLETED');
  assert.match(report.run_id, /^RESPCAP-/);
  assert.equal(report.summary.events_processed, SCENARIO_017.events.length);

  const written = fs.readdirSync(reportsDir).filter((f) => f.endsWith('-response-capture.json'));
  assert.equal(written.length, 1, 'artifact file created');

  // ingest is read-only: grid unchanged
  const rows = mock.listRows(RESPONSE_TAB).slice(1);
  assert.equal(rows.length, SCENARIO_017.initialResponseRows.length, 'no new rows written by ingest');
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* captureScoped / keySet / rowsForNamespace                           */
/* ------------------------------------------------------------------ */

test('captureScoped wraps captureFromEvents deterministically', () => {
  const a = captureScoped({
    events: SCENARIO_001.events,
    responseRows: SCENARIO_001.initialResponseRows,
    identityLookup: SCENARIO_001.identity_lookup,
    mode: SCENARIO_001.mode,
  });
  const b = captureScoped({
    events: SCENARIO_001.events,
    responseRows: SCENARIO_001.initialResponseRows,
    identityLookup: SCENARIO_001.identity_lookup,
    mode: SCENARIO_001.mode,
  });
  assert.deepEqual(a, b, 'identical output across calls');
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.summary.staged, SCENARIO_001.expected.staged);
});

test('keySet extracts idempotency keys', () => {
  const rows = [
    { idempotency_key: 'A::src' },
    { idempotency_key: 'B::src' },
    { idempotency_key: '' },
    { idempotency_key: 'A::src' },
  ];
  assert.deepEqual([...keySet(rows)].sort(), ['A::src', 'B::src']);
});

test('rowsForNamespace filters TEST-RESP-*, skips header', () => {
  const mock = makeMock({
    responseRows: [
      { lead_id: 'TEST-RESP-001', idempotency_key: 'K-001' },
      { lead_id: 'PROD-12345', idempotency_key: 'K-PROD' },
      { lead_id: 'TEST-RESP-002', idempotency_key: 'K-002' },
    ],
  });
  const grid = mock.listRows(RESPONSE_TAB);
  const rows = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => RESP_REGEX.test(r.leadId)));
  assert.deepEqual(rows.map((r) => r.index).sort(), [1, 3]);
});

/* ------------------------------------------------------------------ */
/* repeat (idempotency simulation)                                     */
/* ------------------------------------------------------------------ */

test('repeat: pre-seeded REAL fixture re-ingests with zero staged/persisted (017)', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-repeat-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });

  const second = await repeat({}, mock, { execute: false, scenario: 'TEST-RESP-017', reportsDir });
  assert.equal(second.summary.persisted, 0, 'second ingestion must stage zero');
  assert.equal(second.summary.staged, 0, 'pre-seeded key suppresses re-staging');
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

test('repeat: REAL fixture with empty initial rows still zero-stages on second pass (016)', async () => {
  const second = await repeat({}, makeMock(), { execute: false, scenario: 'TEST-RESP-016', reportsDir: os.tmpdir() });
  assert.equal(second.summary.persisted, 0);
  assert.equal(second.summary.staged, 0, 'first-pass staged rows must suppress second-pass staging');
});

/* ------------------------------------------------------------------ */
/* buildVerifyOutcome / verify                                         */
/* ------------------------------------------------------------------ */

test('buildVerifyOutcome: scenario 017 passes all checks with matching grid', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const outcome = await buildVerifyOutcome({
    responseGrid: mock.listRows(RESPONSE_TAB),
    scenario: SCENARIO_017,
  });
  assert.ok(outcome.ok, `all checks must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);
});

test('verify: e2e full verify cycle on seeded grid', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-verify-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });
  const outcome = await verify({}, mock, { scenario: 'TEST-RESP-017', reportsDir });
  assert.ok(outcome.ok, `verify must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* verifyIdempotency                                                   */
/* ------------------------------------------------------------------ */

test('verifyIdempotency: seeded grid + re-ingest = idempotent', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-idem-'));
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });
  const outcome = await verifyIdempotency({}, mock, { scenario: 'TEST-RESP-017', reportsDir });
  assert.ok(outcome.ok, `idempotency must pass; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* cleanup / verifyCleanup                                             */
/* ------------------------------------------------------------------ */

test('cleanup: deletes only TEST-RESP rows; production rows survive', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  // append a production row at column index 2 (lead_id)
  const prodRow = RESPONSE_COLUMNS.map((c, i) => i === 2 ? 'PROD-LEAD' : i === 1 ? 'K-PROD::mock' : '');
  mock.appendRows(RESPONSE_TAB, [prodRow]);
  const before = mock.listRows(RESPONSE_TAB).length;
  assert.ok(before > 1, 'mock has data rows');

  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-017' }), true);
  const survivors = mock.listRows(RESPONSE_TAB).slice(1).map((r) => r[RESPONSE_LEAD_INDEX]);
  assert.deepEqual(survivors, ['PROD-LEAD'], 'production row survives cleanup');
  assert.equal(mock.listRows(RESPONSE_TAB).length, 2);
});

test('cleanup: dry-run without --execute deletes nothing', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const before = mock.listRows(RESPONSE_TAB).length;
  assert.equal(await cleanup({}, mock, { execute: false, scenario: 'TEST-RESP-017' }), false);
  assert.equal(mock.listRows(RESPONSE_TAB).length, before);
});

test('cleanup: empty grid is idempotent no-op', async () => {
  const mock = makeMock();
  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-017' }), true, 'returns true on zero rows');
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1, 'only header remains');
});

test('verifyCleanup: confirms zero TEST-RESP rows remain', async () => {
  const mock = makeMock();
  const saved = process.exitCode;
  process.exitCode = undefined;
  await verifyCleanup(mock);
  assert.equal(process.exitCode, undefined, 'no exit code change on clean grid');
  process.exitCode = saved;
});

test('verifyCleanup: detects leftover TEST-RESP rows', async () => {
  const mock = makeMock();
  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir: os.tmpdir() });
  const saved = process.exitCode;
  process.exitCode = undefined;
  await verifyCleanup(mock);
  assert.equal(process.exitCode, 1, 'exitCode set to 1 when rows remain');
  process.exitCode = saved;
});

/* ------------------------------------------------------------------ */
/* e2e: full cycle on a clean mock                                     */
/* ------------------------------------------------------------------ */

test('e2e: SEED -> INGEST -> VERIFY -> REPEAT -> VERIFY-IDEMPOTENCY -> CLEANUP -> VERIFY-CLEANUP', async () => {
  const mock = makeMock();
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-e2e-'));

  await seed({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });
  assert.equal(mock.listRows(RESPONSE_TAB).length, SCENARIO_017.initialResponseRows.length + 1);

  const report = await ingest({}, mock, { execute: true, scenario: 'TEST-RESP-017', reportsDir });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.events_processed, SCENARIO_017.events.length);

  const outcome = await verify({}, mock, { scenario: 'TEST-RESP-017', reportsDir });
  assert.ok(outcome.ok, `verify must pass all checks; failed: ${outcome.lines.filter((l) => !l.ok).map((l) => l.label).join(', ')}`);
  assert.equal(outcome.passed, outcome.total);

  const second = await repeat({}, mock, { execute: false, scenario: 'TEST-RESP-017', reportsDir });
  assert.equal(second.summary.persisted, 0, 're-ingest must stage zero');

  const idemOutcome = await verifyIdempotency({}, mock, { scenario: 'TEST-RESP-017', reportsDir });
  assert.ok(idemOutcome.ok, 'idempotency must pass');

  assert.equal(await cleanup({}, mock, { execute: true, scenario: 'TEST-RESP-017' }), true);
  assert.equal(mock.listRows(RESPONSE_TAB).length, 1, 'only header remains');

  await verifyCleanup(mock);
  assert.equal(process.exitCode, undefined);
  fs.rmSync(reportsDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* spawn guard: GOOGLE_SHEET_ID missing                                */
/* ------------------------------------------------------------------ */

test('spawn guard: GOOGLE_SHEET_ID missing exits 1', (t, done) => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'run-response-capture-live.js');
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
