'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadFixtures } = require('../src/fixtures');
const { isEligible, expectedOutcome } = require('../src/eligibility');
const { buildReport } = require('../src/verify');
const {
  VERIFIED_COLUMNS,
  APPROVED_COLUMNS,
  VERIFIED_FORMULA_COLUMNS,
  CLEANUP_REGEX,
  rowToObject,
  isHeaderRow,
  isControlName,
} = require('../src/schema');
const { isTestName, assertNamespaced, collectTestRows, applyRowDeletes } = require('../src/cleanup');
const { MockSheets } = require('../src/mock-sheets');
const { mintJwt } = require('../src/google-sheets-client');
const { buildFixtureWorkflow, PROD_WORKFLOW } = require('../scripts/build-fixture-workflow');
const { seed, cleanup, parseArgs } = require('../scripts/run-live-harness');

const APPROVED_LEAD_COL = APPROVED_COLUMNS.indexOf('lead_id');

const CANONICAL_LABELS = [
  'QUALIFIED + website',
  'QUALIFIED + phone',
  'REVIEW rejected',
  'DISQUALIFIED rejected',
  'Missing contact rejected',
  'Existing lead deduped',
  'Mixed batch',
  'Repeat execution',
  'Mapping',
  'Schema contract',
  'Verified Leads integrity',
  'Outreach Log isolation',
  'Cleanup',
];

function gridFromObjects(headers, objects) {
  return [headers.slice(), ...objects.map((o) => headers.map((c) => (o[c] === undefined || o[c] === null ? '' : String(o[c]))))];
}

function preparedApprovedRow(lead) {
  return {
    lead_id: lead.lead_id,
    business_name: lead.business_name,
    niche: lead.niche,
    city: lead.city,
    state: lead.state,
    country: lead.country,
    website: lead.website,
    phone: lead.phone,
    email: '',
    contact_name: '',
    score: lead.score === undefined || lead.score === null ? '' : String(lead.score),
    status: 'not_ready',
    approved_at: new Date().toISOString(),
    notes: '',
  };
}

function simulateHandoff(mock) {
  const verifiedGrid = mock.listRows('Verified Leads');
  const leads = verifiedGrid.slice(1).map((r) => rowToObject(r, VERIFIED_COLUMNS));
  const eligible = leads.filter((l) => isEligible(l));

  const approvedGrid = mock.listRows('Approved Outreach');
  const existingIds = new Set(approvedGrid.slice(1).map((r) => String(r[APPROVED_LEAD_COL] || '').trim()).filter(Boolean));

  const seen = new Set();
  const rows = [];
  for (const lead of eligible) {
    const id = String(lead.lead_id || '').trim();
    if (!id) continue;
    if (existingIds.has(id)) continue;
    if (seen.has(id)) continue; // duplicate within batch -> rejected
    seen.add(id);
    rows.push(preparedApprovedRow(lead));
  }
  if (rows.length) {
    mock.appendRows('Approved Outreach', rows.map((r) => APPROVED_COLUMNS.map((c) => r[c] ?? '')));
  }
  return rows.length;
}

function reportFor(mock, fixtures, opts = {}) {
  return buildReport({
    fixtures,
    approvedGrid: mock.listRows('Approved Outreach'),
    verifiedGrid: mock.listRows('Verified Leads'),
    outreachRows: [],
    cleanupOk: Boolean(opts.cleanupOk),
  });
}

test('fixture matrix: 8 namespaced fixtures with expected insert/skip sets', () => {
  const fixtures = loadFixtures();
  assert.equal(fixtures.verifiedSeeds.length, 8);
  for (const row of fixtures.verifiedSeeds) {
    assert.match(row.lead_id, CLEANUP_REGEX, row.lead_id);
  }
  assert.deepEqual([...fixtures.expectedInsert].sort(), ['TEST-AOH-001', 'TEST-AOH-002', 'TEST-AOH-007', 'TEST-AOH-008']);
  assert.deepEqual([...fixtures.expectedSkip].sort(), ['TEST-AOH-003', 'TEST-AOH-004', 'TEST-AOH-005', 'TEST-AOH-006']);
});

test('fixtures: eligibility and preseed dedupe produce the declared expectations', () => {
  const fixtures = loadFixtures();
  for (const row of fixtures.verifiedSeeds) {
    const outcome = expectedOutcome(row, fixtures.preseedIds);
    const expected = fixtures.expectedInsert.has(row.lead_id) ? 'insert' : 'skip';
    assert.equal(outcome, expected, `${row.lead_id} expected=${expected}`);
  }
  assert.ok(isEligible(fixtures.verifiedSeeds[5]), 'TEST-AOH-006 is eligible but deduped by preseed');
  assert.equal(expectedOutcome(fixtures.verifiedSeeds[5], fixtures.preseedIds), 'skip');
});

test('fixtures: verified rows carry the full 28-column schema with formula-owned Q:U', () => {
  const fixtures = loadFixtures();
  const row001 = fixtures.verifiedSeeds.find((r) => r.lead_id === 'TEST-AOH-001');
  assert.equal(row001.has_website, 'TRUE');
  assert.equal(row001.has_phone, 'FALSE');
  const row002 = fixtures.verifiedSeeds.find((r) => r.lead_id === 'TEST-AOH-002');
  assert.equal(row002.has_website, 'FALSE');
  assert.equal(row002.has_phone, 'TRUE');
  const row005 = fixtures.verifiedSeeds.find((r) => r.lead_id === 'TEST-AOH-005');
  assert.equal(row005.website, '');
  assert.equal(row005.phone, '');
  for (const col of VERIFIED_COLUMNS) {
    assert.ok(col in row001, `missing key ${col}`);
  }
  assert.equal(VERIFIED_FORMULA_COLUMNS.length, 5);
  assert.deepEqual(VERIFIED_FORMULA_COLUMNS, ['has_website', 'has_phone', 'target_niche', 'score', 'qualification_status']);
});

test('schema: header and helper conventions are consistent', () => {
  assert.equal(VERIFIED_COLUMNS.length, 28);
  assert.equal(APPROVED_COLUMNS.length, 24);
  assert.equal(APPROVED_COLUMNS[0], 'approval_id');
  assert.equal(APPROVED_COLUMNS[APPROVED_LEAD_COL], 'lead_id');
  assert.ok(VERIFIED_COLUMNS.includes('enrichment_business_status'));
  assert.ok(VERIFIED_COLUMNS.includes('enrichment_confidence'));
  assert.ok(VERIFIED_COLUMNS.includes('enrichment_gers_id'));
  assert.ok(VERIFIED_COLUMNS.includes('enrichment_last_run'));
  assert.ok(APPROVED_COLUMNS.includes('contact_blocked'));
  assert.ok(APPROVED_COLUMNS.includes('contact_source_provider'));
  assert.ok(isHeaderRow(VERIFIED_COLUMNS), 'Verified header row is the column list itself');
  assert.ok(isControlName('_control'));
  assert.ok(isControlName('_noNewApproved'));
  assert.ok(!isControlName('lead_id'));
});

test('report: exactly the 13 canonical lines, all PASS on the completed cycle', () => {
  const fixtures = loadFixtures();
  const preseedApproved = fixtures.approvedPreseed.map((o) => preparedApprovedRow(o));
  const insertedApproved = fixtures.verifiedSeeds
    .filter((r) => fixtures.expectedInsert.has(r.lead_id))
    .map((r) => preparedApprovedRow(r));
  const approvedGrid = gridFromObjects(APPROVED_COLUMNS, [...preseedApproved, ...insertedApproved]);
  const verifiedGrid = gridFromObjects(VERIFIED_COLUMNS, fixtures.verifiedSeeds);

  const report = buildReport({ fixtures, approvedGrid, verifiedGrid, outreachRows: [], cleanupOk: true });
  assert.equal(report.total, 13);
  assert.deepEqual(report.lines.map((l) => l.label), CANONICAL_LABELS);
  assert.equal(report.passed, 13);
  assert.ok(report.ok);
});

test('report: schema contract flags control-field leakage', () => {
  const fixtures = loadFixtures();
  const leakedRows = fixtures.verifiedSeeds
    .filter((r) => fixtures.expectedInsert.has(r.lead_id))
    .map((r) => {
      const row = gridFromObjects(APPROVED_COLUMNS, [preparedApprovedRow(r)])[1];
      row.push('_control'); // stray control field appended past the 24-column contract
      row.push(JSON.stringify({ eligible: 1 }));
      return row;
    });
  const approvedGrid = [APPROVED_COLUMNS, ...leakedRows];
  const verifiedGrid = gridFromObjects(VERIFIED_COLUMNS, fixtures.verifiedSeeds);
  const report = buildReport({ fixtures, approvedGrid, verifiedGrid, outreachRows: [], cleanupOk: true });
  assert.equal(report.lines.find((l) => l.label === 'Schema contract').ok, false);
});

test('report: Verified Leads integrity catches source mutation', () => {
  const fixtures = loadFixtures();
  const mutated = fixtures.verifiedSeeds.map((r) => Object.assign({}, r));
  mutated[0].score = '99'; // tamper with a fixture row's score
  const approvedGrid = gridFromObjects(APPROVED_COLUMNS, fixtures.verifiedSeeds
    .filter((r) => fixtures.expectedInsert.has(r.lead_id))
    .map((r) => preparedApprovedRow(r)));
  const verifiedGrid = gridFromObjects(VERIFIED_COLUMNS, mutated);
  const report = buildReport({ fixtures, approvedGrid, verifiedGrid, outreachRows: [], cleanupOk: true });
  assert.equal(report.lines.find((l) => l.label === 'Verified Leads integrity').ok, false);
});

test('cleanup: selects only TEST-AOH namespace and deletes nothing else', () => {
  const fixtures = loadFixtures();
  const rows = gridFromObjects(APPROVED_COLUMNS, [
    ...fixtures.approvedPreseed,
    preparedApprovedRow(fixtures.verifiedSeeds.find((r) => r.lead_id === 'TEST-AOH-001')),
    { lead_id: 'LEAD-ALPHA', business_name: 'Real Lead Co', outreach_status: 'not_ready' },
  ]);
  const collected = collectTestRows(rows, APPROVED_LEAD_COL);
  assert.deepEqual(collected.map((r) => r.lead_id).sort(), ['TEST-AOH-001', 'TEST-AOH-006']);
  const after = applyRowDeletes(rows, collected.map((r) => r.index));
  const survivors = after.map((r) => r[APPROVED_LEAD_COL]);
  assert.ok(survivors.includes('lead_id'));
  assert.ok(survivors.includes('LEAD-ALPHA'));
  assert.ok(!survivors.includes('TEST-AOH-001'));
});

test('cleanup: assertNamespaced refuses non-namespaced lead ids', () => {
  assert.ok(isTestName('TEST-AOH-001'));
  assert.ok(isTestName('TEST-AOH-999'));
  assert.ok(!isTestName('LEAD-ALPHA'));
  assert.ok(!isTestName('test-aoh-001'));
  assert.throws(() => assertNamespaced('LEAD-ALPHA'), /non-namespaced/);
  assert.throws(() => assertNamespaced('TEST-AOH'), /non-namespaced/);
});

test('mock transport: append, list, delete', () => {
  const mock = new MockSheets();
  mock.addTab('Approved Outreach', [APPROVED_COLUMNS]);
  mock.appendRows('Approved Outreach', [['TEST-AOH-200', 'Two Hundred Co']]);
  mock.appendRows('Approved Outreach', [['LEAD-PROD', 'Production Co']]);
  assert.equal(mock.listRows('Approved Outreach').length, 3);
  mock.deleteRows('Approved Outreach', [1]);
  assert.deepEqual(mock.listRows('Approved Outreach')[1][0], 'LEAD-PROD');
  assert.throws(() => mock.listRows('Missing'), /not found/);
});

test('e2e: SEED (dry-run then live) -> RUN -> VERIFY(12/13) -> repeat -> CLEANUP -> VERIFY-FINAL(13/13)', async () => {
  const fixtures = loadFixtures();
  const env = {};

  const mock = new MockSheets();
  mock.addTab('Verified Leads', [VERIFIED_COLUMNS]);
  mock.addTab('Approved Outreach', [APPROVED_COLUMNS]);
  mock.addTab('Outreach Log', [['lead_id']]);

  const seedDry = { plain: true, execute: false, fixtureSheetId: 'fixture-sheet' };
  await seed(env, fixtures, mock, seedDry); // no-op dry run

  const seedLive = { plain: true, execute: true, fixtureSheetId: 'fixture-sheet' };
  await seed(env, fixtures, mock, seedLive);

  assert.equal(mock.listRows('Verified Leads').length, 9); // header + 8 fixtures
  assert.equal(mock.listRows('Approved Outreach').length, 2); // header + TEST-AOH-006 preseed

  const original007 = mock.listRows('Verified Leads').find((r) => r[0] === 'TEST-AOH-007').slice();
  mock.appendRows('Verified Leads', [original007]); // duplicate within batch (same lead_id)
  assert.equal(mock.listRows('Verified Leads').length, 10);

  assert.equal(simulateHandoff(mock), 4); // 001, 002, 007, 008 inserted

  const report1 = reportFor(mock, fixtures);
  assert.equal(report1.total, 13);
  assert.deepEqual(report1.lines.map((l) => l.label), CANONICAL_LABELS);
  assert.equal(report1.passed, 12, 'pre-cleanup: only Cleanup is pending');

  const approvedIdsAfterRun = mock.listRows('Approved Outreach')
    .slice(1).map((r) => r[APPROVED_LEAD_COL]).filter((x) => /^TEST-AOH-\d+$/.test(x)).sort();
  assert.deepEqual(approvedIdsAfterRun, ['TEST-AOH-001', 'TEST-AOH-002', 'TEST-AOH-006', 'TEST-AOH-007', 'TEST-AOH-008']);

  const seventhCount = mock.listRows('Approved Outreach').filter((r) => r[APPROVED_LEAD_COL] === 'TEST-AOH-007').length;
  assert.equal(seventhCount, 1, 'duplicate within batch must be rejected');

  // repeat execution adds zero new rows
  assert.equal(simulateHandoff(mock), 0);
  const report2 = reportFor(mock, fixtures);
  assert.equal(report2.lines.find((l) => l.label === 'Repeat execution').ok, true);
  assert.equal(report2.passed, 12);

  // production-style rows survive: a real verified lead still flows, a real approved lead stays
  mock.appendRows('Verified Leads', [gridFromObjects(VERIFIED_COLUMNS, [{
    lead_id: 'LEAD-BETA', business_name: 'Beta Constructors', niche: 'General', city: 'Austin',
    state: 'Texas', country: 'USA', website: 'https://beta.example', phone: '', rating: '4.5',
    review_count: '22', google_maps_url: '', business_type: 'Contractor', source: 'SEARCH',
    search_input_id: 'S1', dedupe_key: 'beta', has_website: 'TRUE', has_phone: 'FALSE',
    target_niche: 'General', score: '85', qualification_status: 'QUALIFIED', verified_at: '2026-09-01T00:00:00.000Z',
    notes: '', manual_review_notes: '',
  }])[1]]);
mock.appendRows('Approved Outreach', [gridFromObjects(APPROVED_COLUMNS, [{
    lead_id: 'LEAD-ALPHA', business_name: 'Alpha Roofer', niche: 'Roofing', city: 'Austin',
    state: 'Texas', country: 'USA', score: '70', channel: 'email', approval_stage: 'QUALIFIED',
    approved_at: '2026-09-02T00:00:00.000Z', status: 'ready',
  }])[1]]);
  assert.equal(simulateHandoff(mock), 1); // LEAD-BETA now flows through the handoff

  const snapshotApproved = mock.listRows('Approved Outreach');
  const snapshotVerified = mock.listRows('Verified Leads');

  const clean = await cleanup(env, mock, { execute: true });
  assert.equal(clean, true);
  assert.equal(collectTestRows(mock.listRows('Verified Leads')).length, 0);
  assert.equal(collectTestRows(mock.listRows('Approved Outreach')).length, 0);

  const survivors = mock.listRows('Approved Outreach').slice(1).map((r) => r[APPROVED_LEAD_COL]).sort();
  assert.deepEqual(survivors, ['LEAD-ALPHA', 'LEAD-BETA'], 'non-fixture rows must survive cleanup');

  const finalReport = buildReport({
    fixtures,
    approvedGrid: snapshotApproved,
    verifiedGrid: snapshotVerified,
    outreachRows: [],
    cleanupOk: true,
  });
  assert.deepEqual(finalReport.lines.map((l) => l.label), CANONICAL_LABELS);
  assert.equal(finalReport.passed, 13);
  assert.ok(finalReport.ok);
  assert.equal(parseArgs(['--all']).phases.join(','), 'seed,run,verify,cleanup,verify-final');
});

test('fixture workflow builder: swaps only documentId, keeps node names', () => {
  const fixtureId = 'FIXTURE_SPREADSHEET_ID_ABC';
  const clone = buildFixtureWorkflow({ fixtureSpreadsheetId: fixtureId, sourcePath: PROD_WORKFLOW });
  const names = clone.nodes.map((n) => n.name);
  assert.ok(names.includes('Filter Eligible Leads'));
  assert.ok(names.includes('Dedup Against Approved Outreach'));
  assert.ok(names.includes('Write Approved Outreach'));
  const sheetNodes = clone.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.ok(sheetNodes.length >= 3);
  for (const node of sheetNodes) {
    assert.equal(node.parameters.documentId.value, fixtureId, node.name);
    assert.equal(node.parameters.documentId.mode, 'list');
  }
  assert.notEqual(clone.name, 'Lead Recovery Engine — Approved Outreach Handoff V1');
  assert.equal(clone.active, false);
});

test('auth: mintJwt produces a JWT-shaped assertion', () => {
  const { generateKeyPairSync } = require('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const sa = { client_email: 'svc@example.iam.gserviceaccount.com', private_key: pem };
  const jwt = mintJwt(sa, 1700000000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.equal(header.alg, 'RS256');
});