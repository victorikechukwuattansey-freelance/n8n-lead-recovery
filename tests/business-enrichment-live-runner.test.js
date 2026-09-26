'use strict';

/*
 * Business Enrichment V1 engine-direct live runner (H.9) — offline tests.
 *
 * Every test runs the SHIPPED engine (src/enrichment-business.js) through the
 * runner (scripts/run-business-enrichment-live.js) with injected seams:
 *   deps.client       MockSheets for the Verified Leads tab
 *   deps.readParquet  a mock Overture parquet reader (no DuckDB I/O)
 *   deps.transport    captures every values.update PUT (no network)
 *   deps.now          a fixed timestamp (deterministic run reports)
 * No test performs network or DuckDB access.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const R = require('../scripts/run-business-enrichment-live');
const { MockSheets } = require('../src/mock-sheets');
const { VERIFIED_COLUMNS } = require('../src/schema');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const NS = 'TEST-ENRICH-LIVE-00aa11bb22cc';
const NOW = '2026-09-18T12:00:00.000Z';
const RUN_ID = 'BIZ-ENRICH-LIVE-00aa11bb22cc-1a2b3c4d';

const ENV_READY = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
};

function leadRow(overrides = {}) {
  const set = (c, fallback = '') => (overrides[c] !== undefined ? overrides[c] : fallback);
  return VERIFIED_COLUMNS.map((c) => {
    const field = {
      lead_id: set(c),
      business_name: set(c),
      city: set(c),
      state: set(c),
      country: set(c, 'US'),
      phone: set(c),
      website: set(c),
      enrichment_business_status: set(c),
      enrichment_confidence: set(c),
      enrichment_gers_id: set(c),
      enrichment_last_run: set(c),
    };
    return field[c] !== undefined ? field[c] : '';
  });
}

function verifiedGrid(rows = []) {
  return [VERIFIED_COLUMNS.slice(), ...rows];
}

function PLACE(
  id,
  {
    name = 'Alpha HVAC',
    website = '',
    phone = '',
    city = 'Austin',
    state = 'TX',
    country = 'US',
    operating_status = 'operating',
    confidence = 0.95,
    names = null,
    websites = null,
    phones = null,
    addresses = null,
  } = {},
) {
  return {
    id,
    names: names || { primary: name },
    confidence,
    websites: websites || (website ? [website] : []),
    phones: phones || (phone ? [phone] : []),
    addresses: addresses || [{}, { locality: city, region: state, country }],
    operating_status,
  };
}

function makeVerifiedMock(rows = []) {
  const mock = new MockSheets();
  mock.addTab(R.VERIFIED_TAB, verifiedGrid(rows));
  mock.addTab('Approved Outreach', [['approval_id']]);
  return mock;
}

function captureTransport() {
  const calls = [];
  const transport = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    return { ok: true, status: 200 };
  };
  return { transport, calls };
}

function buildDeps(parquetRows = [], overrides = {}) {
  return {
    client: makeVerifiedMock(),
    readParquet: async () => parquetRows,
    now: NOW,
    ...overrides,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biz-enrich-live-'));
}

/* ------------------------------------------------------------------ */
/* Export surface                                                      */
/* ------------------------------------------------------------------ */

describe('business-enrichment-live-runner export surface', () => {
  it('exposes the expected runner API', () => {
    for (const name of [
      'readConfig', 'isConfigured', 'namespaceForArgs', 'defaultRunToken', 'isNamespacedLead',
      'toIndexRow', 'firstOf', 'toNumber', 'classifyLead', 'leadHasMatchKey', 'matchKeyFor',
      'buildIndex', 'readParquetRows', 'probeParquet', 'buildWriteBlock', 'countChangedCells',
      'cellValue', 'surfaceFor', 'clientFor', 'updateRange', '_tokenForAuth', 'sortByLeadId',
      'runIdFor', 'redact', 'redactSecret', 'buildRunReport', 'writeRunReport', 'overallStatusOf',
      'preflight', 'runBusinessEnrichment', 'run', 'parseArgs', 'usage', 'exitCodeForStatus', 'main',
    ]) {
      assert.equal(typeof R[name], 'function', `${name} exported as function`);
    }
  });

  it('declares the canonical Verified Leads constants', () => {
    assert.equal(R.VERIFIED_TAB, 'Verified Leads');
    assert.equal(R.TEST_NAMESPACE_PREFIX, 'TEST-ENRICH-LIVE');
    assert.equal(R.DEFAULT_LIMIT, 5);
    assert.deepEqual(R.WRITE_COLS, [24, 25, 26, 27]);
    assert.equal(R.BUSINESS_STATUS_COL, 24);
    assert.equal(R.CONFIDENCE_COL, 25);
    assert.equal(R.GERS_ID_COL, 26);
    assert.equal(R.LAST_RUN_COL, 27);
    assert.equal(VERIFIED_COLUMNS[24], 'enrichment_business_status');
    assert.equal(VERIFIED_COLUMNS[27], 'enrichment_last_run');
  });
});

/* ------------------------------------------------------------------ */
/* parseArgs                                                           */
/* ------------------------------------------------------------------ */

describe('parseArgs', () => {
  it('applies defaults and parses every flag', () => {
    const a = R.parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.help, false);
    assert.equal(a.limit, 5);
    assert.deepEqual(a.leadIds, []);
    assert.equal(a.overture, '');
    assert.equal(a.namespace, '');
    assert.equal(a.reportsDir, R.DEFAULT_REPORTS_DIR);
    const b = R.parseArgs([
      '--execute',
      '--limit=3',
      '--lead-ids=a,b, c',
      '--overture=C:/x/overture.parquet',
      '--namespace=TEST-ENRICH-LIVE-deadbeef',
      '--reports-dir=C:/tmp/x',
      '--no-interactive',
      '--help',
    ]);
    assert.equal(b.execute, true);
    assert.equal(b.limit, 3);
    assert.deepEqual(b.leadIds, ['a', 'b', 'c']);
    assert.equal(b.overture, 'C:/x/overture.parquet');
    assert.equal(b.namespace, 'TEST-ENRICH-LIVE-deadbeef');
    assert.equal(b.reportsDir, 'C:/tmp/x');
    assert.equal(b.noInteractive, true);
    assert.equal(b.help, true);
  });

  it('falls back to the default limit on malformed or negative values', () => {
    assert.equal(R.parseArgs(['--limit=banana']).limit, 5);
    assert.equal(R.parseArgs(['--limit=-4']).limit, 5);
  });
});

/* ------------------------------------------------------------------ */
/* readConfig                                                          */
/* ------------------------------------------------------------------ */

describe('readConfig', () => {
  it('empty env is NOT_CONFIGURED and lists every missing var', () => {
    const c = R.readConfig({});
    assert.equal(c.status, 'NOT_CONFIGURED');
    assert.equal(c.auth.ready, false);
    assert.equal(c.auth.mode, 'none');
    assert.ok(c.missing.includes('GOOGLE_SHEET_ID'));
    assert.ok(c.missing.some((m) => m.includes('GOOGLE_ACCESS_TOKEN')));
    assert.equal(c.overturePath, R.DEFAULT_OVERTURE_PARQUET);
  });

  it('full token env is CONFIGURED', () => {
    const c = R.readConfig(ENV_READY);
    assert.equal(c.status, 'CONFIGURED');
    assert.equal(c.auth.mode, 'token');
    assert.equal(c.auth.ready, true);
    assert.deepEqual(c.missing, []);
  });

  it('service-account auth without a token is CONFIGURED', () => {
    const c = R.readConfig({ GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/keys/sa.json' });
    assert.equal(c.status, 'CONFIGURED');
    assert.equal(c.auth.mode, 'service-account');
    assert.equal(c.auth.ready, true);
  });

  it('prefers OVERTURE_PARQUET_PATH and preserves the default when unset', () => {
    assert.equal(R.readConfig(ENV_READY).overturePath, R.DEFAULT_OVERTURE_PARQUET);
    assert.equal(R.readConfig({ ...ENV_READY, OVERTURE_PARQUET_PATH: 'C:/idx/o.parquet' }).overturePath, 'C:/idx/o.parquet');
  });
});

/* ------------------------------------------------------------------ */
/* Namespace helpers                                                   */
/* ------------------------------------------------------------------ */

describe('namespace helpers', () => {
  it('default run token is hex and the namespace matches the prefix regex', () => {
    assert.match(R.defaultRunToken(), /^[0-9a-f]{8,32}$/i);
    assert.match(R.namespaceForArgs({}), /^TEST-ENRICH-LIVE-[0-9a-f]{8,32}$/i);
  });

  it('an explicit namespace wins', () => {
    assert.equal(R.namespaceForArgs({ namespace: NS }), NS);
  });

  it('isNamespacedLead splits test leads from production leads', () => {
    assert.equal(R.isNamespacedLead(`${NS}-001`), true);
    assert.equal(R.isNamespacedLead('LEAD-REAL-77'), false);
    assert.equal(R.isNamespacedLead('TEST-ENRICH-NOPE-001'), false);
  });

  it('runIdFor derives a stable BIZ-ENRICH-LIVE id from the namespace', () => {
    const clock = () => new Date('2026-09-18T12:00:00.000Z');
    assert.match(R.runIdFor(NS, clock), /^BIZ-ENRICH-LIVE-[0-9a-f-]+$/);
    assert.equal(R.runIdFor(NS, clock), R.runIdFor(NS, clock));
  });
});

/* ------------------------------------------------------------------ */
/* Index build                                                         */
/* ------------------------------------------------------------------ */

describe('index building from Overture parquet rows', () => {
  it('toIndexRow maps the loader projection and BigInt ids safely', () => {
    const row = R.toIndexRow({
      id: 123n,
      names: { primary: 'Alpha HVAC' },
      confidence: '0.95',
      websites: ['https://alpha.example', 'https://extra.example'],
      phones: ['+1 (512) 555-0131'],
      addresses: [{}, { locality: 'Austin', region: 'TX', country: 'US' }],
      operating_status: 'operating',
    });
    assert.equal(row.gers_id, '123');
    assert.equal(row.primary_name, 'Alpha HVAC');
    assert.equal(row.website, 'https://alpha.example');
    assert.equal(row.phone, '+1 (512) 555-0131');
    assert.equal(row.city, 'Austin');
    assert.equal(row.state_code, 'TX');
    assert.equal(row.country, 'US');
    assert.equal(row.operating_status, 'operating');
    assert.equal(row.confidence, 0.95);
  });

  it('toIndexRow tolerates missing optionals and falls back to address[0]', () => {
    const row = R.toIndexRow({
      id: 'gers-1',
      names: { primary: '' },
      websites: undefined,
      phones: [null, 'x'],
      addresses: [{ locality: 'Round Rock', region: 'TX', country: 'US' }],
    });
    assert.equal(row.website, '');
    assert.equal(row.phone, 'x');
    assert.equal(row.city, 'Round Rock');
    assert.equal(row.confidence, 0);
    assert.equal(row.operating_status, '');
  });

  it('firstOf/toNumber behave on their own', () => {
    assert.equal(R.firstOf(['', 'x', 'y']), 'x');
    assert.equal(R.firstOf([]), '');
    assert.equal(R.firstOf(undefined), '');
    assert.equal(R.toNumber(123n), 123);
    assert.equal(R.toNumber('0.5'), 0.5);
    assert.equal(R.toNumber(undefined), 0);
    assert.equal(R.toNumber('not-a-number'), 0);
  });

  it('buildIndex sorts the index by gers_id ascending and counts rows', async () => {
    const rows = [PLACE('gers-3'), PLACE('gers-1'), PLACE('gers-2', { name: 'Beta' })];
    const { index, count } = await R.buildIndex({ parquetPath: 'x.parquet', deps: buildDeps(rows) });
    assert.equal(count, 3);
    assert.deepEqual(index.map((p) => p.gers_id), ['gers-1', 'gers-2', 'gers-3']);
  });
});

/* ------------------------------------------------------------------ */
/* Filtering + match-key reporting                                     */
/* ------------------------------------------------------------------ */

describe('classifyLead', () => {
  it('labels every exclusion reason in priority order', () => {
    const lead = { lead_id: 'a', business_name: 'N', city: 'C', state: 'TX', country: 'US', website: 'x.com', phone: '555' };
    assert.equal(R.classifyLead(lead, { leadIds: new Set(['a']) }).reason, null);
    assert.equal(
      R.classifyLead({ ...lead, enrichment_business_status: 'open' }, { leadIds: new Set(['a']) }).reason,
      'already_enriched',
    );
    assert.equal(
      R.classifyLead({ ...lead, phone: '', website: '', business_name: '' }, { leadIds: new Set(['a']) }).reason,
      'no_match_key',
    );
    assert.equal(R.classifyLead(lead, { leadIds: new Set(['other']) }).reason, 'out_of_scope');
  });

  it('leadHasMatchKey accepts phone, website, or name+city+state only', () => {
    assert.equal(R.leadHasMatchKey({ phone: '(512) 555-0131' }), true);
    assert.equal(R.leadHasMatchKey({ website: 'beta.example' }), true);
    assert.equal(R.leadHasMatchKey({ business_name: 'N', city: 'C', state: 'TX' }), true);
    assert.equal(R.leadHasMatchKey({ business_name: 'N', city: 'C' }), false);
    assert.equal(R.leadHasMatchKey({}), false);
  });
});

describe('matchKeyFor (report-only mirror of the engine)', () => {
  const index = [
    R.toIndexRow(PLACE('gers-1', { name: 'Alpha HVAC', phone: '5125550131' })),
    R.toIndexRow(PLACE('gers-2', { name: 'Beta Plumbing', website: 'https://www.beta.example' })),
    R.toIndexRow(PLACE('gers-3', { name: 'Gamma Roofing' })),
    R.toIndexRow(PLACE('gers-4', { name: 'Gamma Roofing 2' })),
  ];

  it('phone wins over website when both match', () => {
    const key = R.matchKeyFor({ phone: '(512) 555-0131', website: 'beta.example' }, index);
    assert.equal(key, 'phone');
  });

  it('falls through to website when the lead phone does not match', () => {
    const key = R.matchKeyFor({ phone: '5120000000', website: 'beta.example' }, index);
    assert.equal(key, 'website');
  });

  it('resolves name+city+state exact and fuzzy', () => {
    assert.equal(R.matchKeyFor({ business_name: 'Gamma Roofing', city: 'Austin', state: 'TX' }, index), 'name_exact');
    assert.equal(R.matchKeyFor({ business_name: 'Gamma Roofin', city: 'Austin', state: 'TX' }, index), 'name_fuzzy');
    assert.equal(R.matchKeyFor({ business_name: 'Nope Corp', city: 'Austin', state: 'TX' }, index), 'no_match');
  });

  it('returns no_match when nothing resolves', () => {
    assert.equal(R.matchKeyFor({}, index), 'no_match');
  });
});

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

describe('preflight', () => {
  it('fails on an unconfigured env even with a client', async () => {
    const r = await R.preflight({}, { namespace: NS }, { client: makeVerifiedMock() });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.checks.some((c) => c.label === 'A config present' && !c.ok));
    assert.ok(r.checks.some((c) => c.label === 'B sheet auth' && !c.ok));
  });

  it('FAILs when an enrichment column is missing and names the letter + expected column', async () => {
    const grid = verifiedGrid([leadRow({ lead_id: `${NS}-001`, phone: '5125550131' })]);
    grid[0] = grid[0].filter((c) => c !== 'enrichment_last_run');
    const mock = makeVerifiedMock();
    mock.addTab(R.VERIFIED_TAB, grid);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock, readParquet: async () => [PLACE('gers-1')] });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'C Verified Leads columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('AB') && d.detail.includes('enrichment_last_run'), d.detail);
  });

  it('FAILs when AA/AB are swapped and names both positions', async () => {
    const grid = verifiedGrid([leadRow({ lead_id: `${NS}-001` })]);
    [grid[0][26], grid[0][27]] = [grid[0][27], grid[0][26]];
    const mock = makeVerifiedMock();
    mock.addTab(R.VERIFIED_TAB, grid);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock, readParquet: async () => [PLACE('gers-1')] });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'C Verified Leads columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('AA') && d.detail.includes('enrichment_gers_id'), d.detail);
  });

  it('FAILs on an empty Verified grid and on a missing client', async () => {
    const mock = new MockSheets();
    mock.addTab(R.VERIFIED_TAB, []);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock, readParquet: async () => [PLACE('gers-1')] });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'C Verified Leads columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('empty'), d.detail);

    const r2 = await R.preflight(ENV_READY, { namespace: NS }, {});
    assert.equal(r2.status, 'FAIL');
    assert.ok(r2.checks.some((c) => c.label === 'C Verified Leads columns' && !c.ok));
  });

  it('FAILs when the parquet probe returns no rows', async () => {
    const mock = makeVerifiedMock([leadRow({ lead_id: `${NS}-001` })]);
    const mock2 = mock;
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock2, readParquet: async () => [] });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'D Overture parquet readable');
    assert.equal(d.ok, false);
  });

  it('reports an adversarial namespace as informational only', async () => {
    const mock = makeVerifiedMock([leadRow({ lead_id: `${NS}-001` })]);
    const r = await R.preflight(ENV_READY, { namespace: 'PRODUCTION' }, { client: mock, readParquet: async () => [PLACE('gers-1')] });
    assert.equal(r.status, 'PASS');
    const e = r.checks.find((c) => c.label === 'E namespace well-formed');
    assert.equal(e.informational, true);
  });

  it('passes with full 28-column headers, configured env, and a readable parquet', async () => {
    const mock = makeVerifiedMock([leadRow({ lead_id: `${NS}-001`, phone: '5125550131' })]);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock, readParquet: async () => [PLACE('gers-1')] });
    assert.equal(r.status, 'PASS');
    for (const c of r.checks) assert.ok(c.ok, `${c.label}: ${c.detail}`);
    assert.ok(r.checks.every((c) => typeof c.label === 'string' && typeof c.detail === 'string'));
  });
});

/* ------------------------------------------------------------------ */
/* Dry-run pipeline                                                    */
/* ------------------------------------------------------------------ */

const MIXED_ROWS = [
  leadRow({ lead_id: `${NS}-001`, business_name: 'Alpha HVAC', city: 'Austin', state: 'TX', phone: '(512) 555-0131', website: 'https://example.com' }),
  leadRow({ lead_id: `${NS}-002`, business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
  leadRow({ lead_id: `${NS}-003`, business_name: 'Gamma Roofing', city: 'Austin', state: 'TX' }),
  leadRow({ lead_id: `${NS}-004`, business_name: 'Delta Corp', city: 'Austin', state: 'TX', phone: '512-555-0199', enrichment_business_status: 'open' }),
  leadRow({ lead_id: `${NS}-005` }),
];

const MIXED_INDEX = [
  PLACE('gers-1', { name: 'Alpha HVAC', phone: '5125550131' }),
  PLACE('gers-2', { name: 'Beta Plumbing', website: 'https://www.beta.example' }),
  PLACE('gers-3', { name: 'Gamma Roofing' }),
];

describe('dry-run pipeline (no --execute)', () => {
  it('enriches matched leads, excludes the rest, writes nothing', async () => {
    const mock = makeVerifiedMock(MIXED_ROWS);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'DRY_RUN');
    const r = out.report;
    assert.equal(r.mode, 'DRY_RUN');
    assert.equal(r.stages.preflight, 'PASS');
    assert.equal(r.stages.report, 'PASS');
    assert.equal(r.stats.total, 5);
    assert.equal(r.stats.eligible, 3);
    assert.equal(r.stats.excluded, 2);
    assert.equal(r.stats.matched, 3);
    assert.equal(r.stats.unmatched, 0);
    assert.equal(r.stats.index_rows, 3);
    assert.equal(r.would_write, 12); // 3 matched leads x 4 cells (Y/Z/AA/AB)
    assert.equal(r.wrote, 0);
    assert.equal(r.cells_changed, 12);

    assert.deepEqual(
      r.exclusions.sort((a, b) => a.lead_id.localeCompare(b.lead_id)),
      [
        { lead_id: `${NS}-004`, reason: 'already_enriched' },
        { lead_id: `${NS}-005`, reason: 'no_match_key' },
      ],
    );

    const byLead = Object.fromEntries(r.per_lead_outcomes.map((o) => [o.lead_id, o]));
    assert.equal(byLead[`${NS}-001`].matched, true);
    assert.equal(byLead[`${NS}-001`].match_key_type, 'phone');
    assert.equal(byLead[`${NS}-001`].y, 'open');
    assert.equal(byLead[`${NS}-001`].z, '1');
    assert.equal(byLead[`${NS}-001`].aa, 'gers-1');
    assert.equal(byLead[`${NS}-002`].match_key_type, 'website');
    assert.equal(byLead[`${NS}-002`].z, '1');
    assert.equal(byLead[`${NS}-003`].match_key_type, 'name_exact');
    assert.equal(byLead[`${NS}-003`].z, '0.7');
    assert.equal(byLead[`${NS}-003`].aa, 'gers-3');

    // nothing written: no transport calls, sheet untouched, no stamps on the grid
    assert.equal(calls.length, 0);
    const grid = mock.listRows(R.VERIFIED_TAB);
    assert.equal(grid[1][24], '');
    assert.equal(grid[2][24], '');
    assert.equal(grid[3][24], '');

    assert.ok(r.run_id.startsWith('BIZ-ENRICH-LIVE-00aa11bb22cc-'));
    assert.ok(fs.readdirSync(dir).some((f) => f === `${RUN_ID}.json`));
  });

  it('restricts scope via --lead-ids', async () => {
    const mock = makeVerifiedMock(MIXED_ROWS.slice(0, 3));
    const dir = tmpDir();
    const d = buildDeps(MIXED_INDEX, { client: mock });
    const out = await R.runBusinessEnrichment(
      ENV_READY,
      { namespace: NS, runId: RUN_ID, reportsDir: dir, leadIds: [`${NS}-001`, `${NS}-002`] },
      d,
    );
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.stats.eligible, 2);
    assert.equal(out.report.stats.matched, 2);
    assert.equal(out.report.exclusions.filter((e) => e.reason === 'out_of_scope').length, 1);
  });

  it('applies --limit deterministically on the sorted scope', async () => {
    const mock = makeVerifiedMock([MIXED_ROWS[0], MIXED_ROWS[1], MIXED_ROWS[2]]);
    const dir = tmpDir();
    const d = buildDeps(MIXED_INDEX, { client: mock });
    const out = await R.runBusinessEnrichment(
      ENV_READY,
      { namespace: NS, runId: RUN_ID, reportsDir: dir, limit: 2 },
      d,
    );
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.stats.eligible, 2);
    assert.deepEqual(
      out.report.per_lead_outcomes.map((o) => o.lead_id),
      [`${NS}-001`, `${NS}-002`],
    );
  });

  it('is deterministic across identical runs', async () => {
    const runOnce = async () => {
      const d = buildDeps(MIXED_INDEX, { client: makeVerifiedMock(MIXED_ROWS) });
      const dir = tmpDir();
      return R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, reportsDir: dir }, d);
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.deepEqual(a.report.per_lead_outcomes, b.report.per_lead_outcomes);
    assert.deepEqual(a.report.stats, b.report.stats);
    assert.deepEqual(a.report.stages, b.report.stages);
  });

  it('Reports carry no secrets, raw PII, or unmasked sheet ids', async () => {
    const mock = makeVerifiedMock(MIXED_ROWS);
    const dir = tmpDir();
    const d = buildDeps(MIXED_INDEX, { client: mock });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, reportsDir: dir }, d);
    const txt = JSON.stringify(out.report);
    assert.equal(txt.includes('test-token'), false);
    assert.equal(txt.includes('Alpha HVAC'), false);
    assert.equal(txt.includes(SPREADSHEET_ID), false);
    assert.equal(out.report.sheet.id, '1KN-mA…lHFQ');
    assert.equal(out.report.sheet.verified_tab, 'Verified Leads');
    assert.equal(out.report.parquet.basename, 'overture-austin.parquet');
    assert.equal(out.report.parquet.index_rows, 3);
  });
});

/* ------------------------------------------------------------------ */
/* buildWriteBlock                                                     */
/* ------------------------------------------------------------------ */

describe('buildWriteBlock', () => {
  const preRows = MIXED_ROWS.slice(0, 3);
  const grid = verifiedGrid(preRows);
  const scoped = preRows.map((row) => ({
    lead_id: row[0],
    business_name: row[1],
    city: row[3],
    state: row[4],
    phone: row[7],
    website: row[8],
  }));
  const matchedById = {
    [`${NS}-001`]: { y: 'open', z: '1', aa: 'gers-1', ab: NOW },
    [`${NS}-002`]: { y: 'open', z: '1', aa: 'gers-2', ab: NOW },
  };

  it('unguarded: stamps every matched row and preserves unmatched', () => {
    const { rangeSuffix, values } = R.buildWriteBlock({ grid, scopedRows: scoped, matchedById, namespacedOnly: false });
    assert.equal(rangeSuffix, 'Y2:AB4');
    assert.equal(values.length, 3);
    assert.deepEqual(values[0], ['open', '1', 'gers-1', NOW]);
    assert.deepEqual(values[1], ['open', '1', 'gers-2', NOW]);
    assert.deepEqual(values[2], ['', '', '', '']); // unmatched preserved (stays blank)
  });

  it('namespaced (EXECUTE): preserves non-namespaced matched rows verbatim', () => {
    const grid2 = verifiedGrid([...preRows, leadRow({ lead_id: 'LEAD-REAL-77', enrichment_business_status: 'open', enrichment_confidence: '1', enrichment_gers_id: 'gers-old', enrichment_last_run: 'prev-run' })]);
    const scoped2 = [...scoped, { lead_id: 'LEAD-REAL-77', business_name: 'X', city: 'Austin', state: 'TX', phone: '', website: 'prod.example' }];
    const matched2 = {
      [`${NS}-001`]: { y: 'open', z: '1', aa: 'gers-1', ab: NOW },
      [`${NS}-002`]: { y: 'open', z: '1', aa: 'gers-2', ab: NOW },
      'LEAD-REAL-77': { y: 'open', z: '1', aa: 'gers-77', ab: NOW },
    };
    const { rangeSuffix, values } = R.buildWriteBlock({ grid: grid2, scopedRows: scoped2, matchedById: matched2, namespacedOnly: true });
    assert.equal(rangeSuffix, 'Y2:AB5');
    assert.equal(values.length, 4);
    assert.deepEqual(values[0], ['open', '1', 'gers-1', NOW]);
    assert.deepEqual(values[1], ['open', '1', 'gers-2', NOW]);
    assert.deepEqual(values[2], ['', '', '', '']); // NS-003 unmatched preserved (blank)
    assert.deepEqual(values[3], ['open', '1', 'gers-old', 'prev-run']); // LEAD-REAL-77 preserved VERBATIM despite being matched
    assert.equal(R.countChangedCells(grid2, values), 8); // only the two namespaced leads change
  });
});

/* ------------------------------------------------------------------ */
/* Execute pipeline                                                    */
/* ------------------------------------------------------------------ */

describe('execute pipeline (--execute)', () => {
  it('writes only Y/Z/AA/AB for namespaced matched leads; preserves everything else', async () => {
    const rows = [
      leadRow({ lead_id: `${NS}-001`, business_name: 'Alpha HVAC', city: 'Austin', state: 'TX', phone: '(512) 555-0131', website: 'https://example.com' }),
      leadRow({ lead_id: 'LEAD-REAL-77', business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
      leadRow({ lead_id: `${NS}-088`, business_name: 'Old Co', city: 'Austin', state: 'TX', enrichment_business_status: 'open', enrichment_confidence: '1', enrichment_gers_id: 'gers-old', enrichment_last_run: 'prev-run' }),
      leadRow({ lead_id: `${NS}-002`, business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
    ];
    const mock = makeVerifiedMock(rows);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'PASS');
    const r = out.report;
    assert.equal(r.mode, 'EXECUTE');
    assert.equal(r.stats.eligible, 3);
    assert.equal(r.stats.matched, 3);
    assert.equal(r.would_write, 12); // all three matched would change without the guard
    assert.equal(r.wrote, 8);        // only the two namespaced leads (8 cells) actually changed
    assert.equal(r.cells_changed, 8);

    const byLead = Object.fromEntries(r.per_lead_outcomes.map((o) => [o.lead_id, o]));
    assert.equal(byLead['LEAD-REAL-77'].matched, true);
    assert.equal(byLead['LEAD-REAL-77'].match_key_type, 'website');

    assert.equal(calls.length, 1);
    const put = calls[0];
    assert.equal(put.method, 'PUT');
    assert.equal(put.headers.Authorization, 'Bearer test-token');
    const url = decodeURIComponent(put.url);
    assert.ok(url.includes(`'Verified Leads'!Y2:AB5`), url);
    assert.ok(url.includes('valueInputOption=USER_ENTERED'), url);
    const values = JSON.parse(put.body).values;
    assert.equal(values.length, 4);
    assert.deepEqual(values[0], ['open', '1', 'gers-1', NOW]);                    // NS-001 (grid row 0) stamped
    assert.deepEqual(values[1], ['', '', '', '']);                                // LEAD-REAL-77 preserved blank
    assert.deepEqual(values[2], ['open', '1', 'gers-old', 'prev-run']);           // pre-enriched row preserved
    assert.deepEqual(values[3], ['open', '1', 'gers-2', NOW]);                    // NS-002 stamped
    const rangePart = url.split('!')[1].split('?')[0]; // e.g. Y2:AB5
    const colOf = (side) => side.replace(/\d+$/, '');
    const [colFrom, colTo] = rangePart.split(':').map(colOf);
    const allowedCols = ['Y', 'Z', 'AA', 'AB'];
    assert.equal(allowedCols.includes(colFrom), true, `range starts in a write-safe column: ${url}`);
    assert.equal(allowedCols.includes(colTo), true, `range ends in a write-safe column: ${url}`);

    // the sheet itself is never mutated (the write went through the transport)
    const grid = mock.listRows(R.VERIFIED_TAB);
    assert.equal(grid[1][24], '');
    assert.equal(grid[4][24], '');
  });

  it('leaves production-only matched leads untouched in test scope: stage NO_ELIGIBLE, no transport', async () => {
    const rows = [
      leadRow({ lead_id: `${NS}-001`, business_name: 'Miss', city: 'Austin', state: 'TX', website: 'https://miss.example' }),
      leadRow({ lead_id: 'LEAD-REAL-77', business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
    ];
    const mock = makeVerifiedMock(rows);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'NO_ELIGIBLE'); // no namespaced lead changed
    assert.equal(out.report.mode, 'EXECUTE');
    assert.equal(out.report.requested_scope, 'test');
    assert.equal(out.report.effective_scope, 'test');
    assert.equal(out.report.stats.matched, 1);
    assert.equal(out.report.wrote, 0);
    assert.equal(calls.length, 0);
  });

  it('refuses production scope without BIZ_ENRICH_ALLOW_PRODUCTION: stage REFUSED, no transport', async () => {
    const rows = [
      leadRow({ lead_id: `${NS}-001`, business_name: 'Miss', city: 'Austin', state: 'TX', website: 'https://miss.example' }),
      leadRow({ lead_id: 'LEAD-REAL-77', business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
    ];
    const mock = makeVerifiedMock(rows);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    // no BIZ_ENRICH_ALLOW_PRODUCTION in env
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.equal(out.stages.write, 'REFUSED');
    assert.equal(out.report.mode, 'EXECUTE');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'production');
    assert.equal(out.report.production_confirmed, false);
    assert.equal(out.report.wrote, 0);
    assert.equal(calls.length, 0);
    const txt = JSON.stringify(out.report);
    assert.ok(txt.includes('refusing production write'), txt);
  });

  it('allows production scope only with BIZ_ENRICH_ALLOW_PRODUCTION=1: writes matched leads', async () => {
    const rows = [
      leadRow({ lead_id: `${NS}-001`, business_name: 'Miss', city: 'Austin', state: 'TX', website: 'https://miss.example' }),
      leadRow({ lead_id: 'LEAD-REAL-77', business_name: 'Beta Plumbing', city: 'Austin', state: 'TX', website: 'https://beta.example' }),
    ];
    const mock = makeVerifiedMock(rows);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(
      { ...ENV_READY, BIZ_ENRICH_ALLOW_PRODUCTION: '1' },
      { namespace: NS, runId: RUN_ID, execute: true, scope: 'production', reportsDir: dir },
      d
    );
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'PASS');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'production');
    assert.equal(out.report.production_confirmed, true);
    assert.equal(out.report.wrote, 4); // LEAD-REAL-77 matched, Y/Z/AA/AB stamped
    assert.equal(calls.length, 1);
    const put = calls[0];
    const values = JSON.parse(put.body).values;
    assert.equal(values.length, 2); // grid rows 0 (NS-001) and 1 (LEAD-REAL-77)
    assert.deepEqual(values[0], ['', '', '', '']);   // NS-001 unmatched, preserved
    assert.deepEqual(values[1], ['open', '1', 'gers-2', NOW]); // LEAD-REAL-77 written
  });

  it('reports production scope requested in DRY_RUN mode as effective_scope dry_run, no write', async () => {
    const mock = makeVerifiedMock(MIXED_ROWS.slice(0, 3));
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, execute: false, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'DRY_RUN');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'dry_run');
    assert.equal(out.report.production_confirmed, false); // guard never consulted in dry run
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown --scope value via scopeForArgs', () => {
    const args = R.parseArgs(['--scope=bogus']);
    assert.throws(() => R.scopeForArgs(args), /unknown --scope value "bogus"/);
  });

  it('defaults parseArgs scope to test and parses --scope=production', () => {
    assert.equal(R.parseArgs([]).scope, 'test');
    assert.equal(R.parseArgs(['--execute']).scope, 'test');
    assert.equal(R.parseArgs(['--scope=production']).scope, 'production');
    assert.equal(R.parseArgs(['--scope=test']).scope, 'test');
  });

  it('refuses to execute under a non-TEST-ENRICH-LIVE namespace', async () => {
    const mock = makeVerifiedMock(MIXED_ROWS.slice(0, 3));
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const d = buildDeps(MIXED_INDEX, { client: mock, transport });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: 'PRODUCTION', runId: RUN_ID, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.equal(out.stages.write, 'FAIL');
    assert.ok(out.report.failure_info.some((f) => f.includes('refuse to execute')), out.report.failure_info.join(' | '));
    assert.equal(calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Run report + stage aggregation                                      */
/* ------------------------------------------------------------------ */

describe('run report, redaction, and exit codes', () => {
  it('redacts sensitive keys and secret-shaped strings', () => {
    const o = R.redact({
      business_name: 'Alpha',
      website: 'https://alpha.example',
      phone: '5125550131',
      access_token: 'tok',
      api_key: 'k',
      authorization: 'Bearer xyz',
      keep: 'value',
      nested: { private_key: 'x', notes: 'n2' },
    });
    assert.equal(o.keep, 'value');
    assert.equal(o.business_name, '<redacted>');
    assert.equal(o.website, '<redacted>');
    assert.equal(o.phone, '<redacted>');
    assert.equal(o.access_token, '<redacted>');
    assert.equal(o.api_key, '<redacted>');
    assert.equal(o.authorization, '<redacted>');
    assert.equal(o.nested.private_key, '<redacted>');

    const s = R.redact('token sk-live-1234567890abcdefghij secret AIzaSyB5T-6gB_qKbWAbR1234567890123456 ya29.abcdefghij AKIAIOSFODNN7EXAMPLE');
    assert.equal(s.includes('sk-live-1234567890abcdefghij'), false);
    assert.equal(s.includes('AIzaSyB5T-6gB_qKbWAbR1234567890123456'), false);
    assert.equal(s.includes('ya29.abcdefghij'), false);
    assert.equal(s.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });

  it('the run report never contains configured keys', () => {
    const env = { ...ENV_READY, GOOGLE_ACCESS_TOKEN: 'SECRET-ELEPHANT', GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/keys/sec.json' };
    const report = R.buildRunReport({
      args: { execute: true, namespace: NS },
      env,
      outcomes: { stages: { preflight: 'PASS', write: 'PASS', report: 'PASS' } },
      startedAt: 's',
      completedAt: 'c',
      ns: NS,
      runId: RUN_ID,
      overture: 'C:/idx/o.parquet',
      indexCount: 1,
      stats: { total: 1, matched: 1 },
      perLeadOutcomes: [{ lead_id: `${NS}-001`, matched: true, match_key_type: 'phone' }],
      exclusions: [],
      writeOutcome: { would_write: 4, wrote: 4 },
      changedCells: 4,
    }).redacted;
    const txt = JSON.stringify(report);
    assert.equal(txt.includes('SECRET-ELEPHANT'), false);
    assert.equal(report.mode, 'EXECUTE');
    assert.equal(report.namespace, NS);
  });

  it('preflight FAIL propagates into the report and failure_info names the check', async () => {
    const grid = verifiedGrid([leadRow({ lead_id: `${NS}-001` })]);
    grid[0] = grid[0].filter((c) => c !== 'enrichment_last_run');
    const mock = new MockSheets();
    mock.addTab(R.VERIFIED_TAB, grid);
    const dir = tmpDir();
    const d = buildDeps([PLACE('gers-1')], { client: mock });
    const out = await R.runBusinessEnrichment(ENV_READY, { namespace: NS, runId: RUN_ID, reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.equal(out.stages.preflight, 'FAIL');
    assert.ok(
      out.report.failure_info.some((f) => f.includes('C Verified Leads columns') && f.includes('AB')),
      out.report.failure_info.join(' | '),
    );
    const check = out.report.preflight_detail.find((c) => c.name === 'C Verified Leads columns');
    assert.equal(check.ok, false);
  });

  it('overallStatusOf collapses stages correctly', () => {
    const all = { preflight: 'PASS', read: 'PASS', filter: 'PASS', build_index: 'PASS', enrich: 'PASS', write: 'DRY_RUN', report: 'PASS' };
    assert.equal(R.overallStatusOf(all), 'PASS');
    assert.equal(R.overallStatusOf({ ...all, enrich: 'FAIL' }), 'FAIL');
    assert.equal(R.overallStatusOf({ ...all, preflight: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED');
  });

  it('exitCodeForStatus maps PASS/FAIL/NOT_CONFIGURED/unknown', () => {
    assert.equal(R.exitCodeForStatus('PASS'), 0);
    assert.equal(R.exitCodeForStatus('FAIL'), 1);
    assert.equal(R.exitCodeForStatus('NOT_CONFIGURED'), 3);
    assert.equal(R.exitCodeForStatus('BOGUS'), 2);
  });
});

/* ------------------------------------------------------------------ */
/* run() + CLI wiring                                                  */
/* ------------------------------------------------------------------ */

describe('run() and CLI wiring', () => {
  it('run() with empty env returns NOT_CONFIGURED and writes a report', async () => {
    const dir = tmpDir();
    const out = await R.run({}, { namespace: NS, reportsDir: dir });
    assert.equal(out.status, 'NOT_CONFIGURED');
    assert.equal(out.stages.preflight, 'NOT_CONFIGURED');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const back = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(back.preflight_status, 'NOT_CONFIGURED');
    assert.equal(back.run_id, out.report.run_id);
  });

  const runCli = (args, env = {}) => {
    const extra = { ...env };
    for (const k of Object.keys(extra)) {
      if (extra[k] === undefined) delete extra[k];
    }
    try {
      const out = execFileSync(process.execPath, ['scripts/run-business-enrichment-live.js', ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...extra },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 2, out: String(e.stdout || '') + (e.stderr ? `\n${e.stderr}` : '') };
    }
  };

  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.out.toLowerCase().includes('usage'));
    assert.ok(r.out.toLowerCase().includes('dry_run'));
  });

  it('bare invocation with an unconfigured env exits 3 (NOT_CONFIGURED)', () => {
    const r = runCli(
      ['--no-interactive', `--reports-dir=${tmpDir()}`],
      { GOOGLE_SHEET_ID: undefined, GOOGLE_ACCESS_TOKEN: undefined },
    );
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('RESULT: NOT_CONFIGURED'));
    assert.ok(!r.out.includes('RESULT: PASS'));
  });

  it('main() delegates run() and returns its exit code', async () => {
    const dir = tmpDir();
    const code = await R.main(['--no-interactive', `--reports-dir=${dir}`], {});
    assert.equal(code, 3);
  });
});

/* ------------------------------------------------------------------ */
/* H.9 security-gate literal scan                                      */
/* ------------------------------------------------------------------ */

describe('H.9 security-gate literal scan', () => {
  it('runner source has no random ids or secret-looking literals', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'run-business-enrichment-live.js'), 'utf8');
    for (const banned of ['Math.random(', 'randomUUID']) {
      assert.ok(!src.includes(banned), `banned literal ${banned}`);
    }
    for (const pattern of [/sk-[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{20,}/, /ya29\.[0-9A-Za-z_-]{10,}/]) {
      assert.equal(pattern.test(src), false, `banned secret-shaped value ${pattern}`);
    }
  });
});