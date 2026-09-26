'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const R = require('../scripts/run-enrichment-live');
const { MockSheets } = require('../src/mock-sheets');
const { APPROVED_COLUMNS, APPROVED_COLUMN_INDEX, objectToRow } = require('../src/schema');
const { ENRICHMENT_LOG_COLUMNS } = require('../src/enrichment-schema');
const { enrichmentIdFor } = require('../src/enrichment-cache');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';
const NS = 'TEST-ENRICH-LIVE-00aa11bb22cc';
const NOW = '2026-09-18T12:00:00.000Z';
const PAST = '2026-09-01T00:00:00.000Z';

const ENV_READY = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
  AGENTDATA_API_KEY: 'ad-test-key',
};

function leadRow({ lead_id, country = 'US', website = '', email = '', contact_blocked = '' }) {
  return APPROVED_COLUMNS.map((c) => {
    if (c === 'lead_id') return lead_id;
    if (c === 'country') return country;
    if (c === 'website') return website;
    if (c === 'email') return email;
    if (c === 'contact_blocked') return contact_blocked;
    return '';
  });
}

function approvedGrid(rows = []) {
  return [APPROVED_COLUMNS.slice(), ...rows];
}

function logRowObject({ enrichment_key, lead_id, provider = 'agentdata', query_input = '', result_email = '', result_contact_name = '', result_contact_title = '', result_verified = 'FALSE', credits_consumed = '', enriched_at = PAST, ttl_expires_at = '2027-01-01T00:00:00.000Z', cache_hit_count = '0', notes = '' }) {
  return { enrichment_id: enrichmentIdFor(enrichment_key, enriched_at), enrichment_key, lead_id, provider, query_input, result_email, result_contact_name, result_contact_title, result_verified, credits_consumed, enriched_at, ttl_expires_at, cache_hit_count, notes };
}

function logGrid(rows = []) {
  return [ENRICHMENT_LOG_COLUMNS.slice(), ...rows.map((r) => objectToRow(r, ENRICHMENT_LOG_COLUMNS))];
}

function makeMock(leadRows, cacheRows = []) {
  const mock = new MockSheets();
  mock.addTab(R.APPROVED_TAB, approvedGrid(leadRows));
  mock.addTab(R.LOG_TAB, logGrid(cacheRows));
  return mock;
}

function fakeProvider(byDomain) {
  const calls = [];
  return {
    provider: 'agentdata',
    calls,
    domainSearch: async (domain) => {
      calls.push(domain);
      if (byDomain[domain] && byDomain[domain].reason) {
        throw Object.assign(new Error(byDomain[domain].reason), byDomain[domain]);
      }
      return byDomain[domain] || { ok: true, emails: [], source: 'agentdata', creditsUsed: 0 };
    },
  };
}

function captureTransport() {
  const calls = [];
  const transport = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    return { ok: true, status: 200 };
  };
  return { transport, calls };
}

function buildDeps({ byDomain = {}, resolver, transport, client, namespace = NS } = {}) {
  const provider = fakeProvider(byDomain);
  const d = {
    client: client || makeMock(),
    clientWrapper: { createContactClient: () => provider },
    now: NOW,
    transport,
    authConfig: { auth: { mode: 'token' }, googlesheetId: SPREADSHEET_ID },
  };
  if (resolver) d.resolver = resolver;
  return { d, provider };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-live-'));
}

const emailResult = (email, extra = {}) => ({
  ok: true,
  emails: [{ email, value: email, score: 95, confidence: 95, first_name: 'John', last_name: 'Doe', position: 'CEO', verification_status: 'valid', verification_date: '2026-01-01', ...extra }],
  source: 'agentdata',
  creditsUsed: 1,
});

describe('enrichment-live-runner export surface', () => {
  it('exposes the expected runner API', () => {
    for (const name of [
      'readConfig', 'isConfigured', 'providerForArgs', 'namespaceForArgs', 'defaultRunToken', 'isNamespacedLead',
      'clientFor', 'surfaceFor', 'updateValues', '_tokenForAuth', 'liveProviderTransport', 'loadEnrichPackage', 'resolverFor', 'resolveOssEmail',
      'classifyLead', 'buildReportRows', 'buildRunOutcomes', 'diffCacheBumps', 'diffNewLogRows', 'approvedVwCells', 'sortByLeadId',
      'preflight', 'runEnrichment', 'run', 'redact', 'buildRunReport', 'writeRunReport', 'overallStatusOf',
      'parseArgs', 'usage', 'exitCodeForStatus', 'main',
    ]) assert.equal(typeof R[name], 'function', `${name} exported as function`);
  });

  it('declares canonical schema constants', () => {
    assert.equal(R.APPROVED_TAB, 'Approved Outreach');
    assert.equal(R.LOG_TAB, 'Contact Enrichment Log');
    assert.equal(R.TEST_NAMESPACE_PREFIX, 'TEST-ENRICH-LIVE');
    assert.equal(R.DEFAULT_PROVIDER, 'agentdata');
    assert.deepEqual(R.VALID_PROVIDERS, ['agentdata', 'hunter']);
    assert.equal(R.DEFAULT_LIMIT, 5);
  });
});

describe('Approved column orientation (H.8b.2 → H.8c)', () => {
  const LIVE_APPROVED_HEADER = [
    'approval_id', 'lead_id', 'business_name', 'contact_name', 'niche', 'city', 'state',
    'phone', 'email', 'website', 'verification_source', 'score', 'channel', 'campaign_name',
    'message_variant', 'approval_stage', 'approved_by', 'approved_at', 'scheduled_date',
    'status', 'notes', 'contact_source_provider', 'contact_blocked', 'country',
  ];

  it('pins the live sheet orientation: V=contact_source_provider (21), W=contact_blocked (22), X=country (23)', () => {
    assert.deepEqual(APPROVED_COLUMNS, LIVE_APPROVED_HEADER);
    assert.equal(APPROVED_COLUMNS.length, 24);
    assert.equal(APPROVED_COLUMN_INDEX.lead_id, 1);
    assert.equal(APPROVED_COLUMN_INDEX.contact_source_provider, 21);
    assert.equal(APPROVED_COLUMN_INDEX.contact_blocked, 22);
    assert.equal(APPROVED_COLUMN_INDEX.country, 23);
    assert.equal(APPROVED_COLUMNS[21], 'contact_source_provider');
    assert.equal(APPROVED_COLUMNS[22], 'contact_blocked');
    assert.equal(APPROVED_COLUMNS[23], 'country');
  });

  it('a V/W-swapped Approved header fails the D check positionally', async () => {
    const swapped = LIVE_APPROVED_HEADER.slice();
    swapped[21] = 'contact_blocked';
    swapped[22] = 'contact_source_provider';
    const mock = new MockSheets();
    mock.addTab(R.APPROVED_TAB, [swapped, leadRow({ lead_id: `${NS}-001` })]);
    mock.addTab(R.LOG_TAB, logGrid([]));
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'D Approved Outreach columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('V') && d.detail.includes('contact_source_provider'), d.detail);
    assert.ok(d.detail.includes('W') && d.detail.includes('contact_blocked'), d.detail);
  });

  it('a renamed enrichment-owned column fails the D check and names the position', async () => {
    const renamed = LIVE_APPROVED_HEADER.slice();
    renamed[22] = 'blocked_flag';
    const mock = new MockSheets();
    mock.addTab(R.APPROVED_TAB, [renamed, leadRow({ lead_id: `${NS}-001` })]);
    mock.addTab(R.LOG_TAB, logGrid([]));
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'D Approved Outreach columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('W') && d.detail.includes('blocked_flag'), d.detail);
  });

  it('an enrichment column in the wrong position fails the D check', async () => {
    const shifted = LIVE_APPROVED_HEADER.slice();
    shifted.splice(21, 1);               // drop V-ish column, leaving W at the wrong slot
    shifted.splice(21, 0, 'contact_blocked'); // now W carries the blocked value in V's place
    const mock = new MockSheets();
    mock.addTab(R.APPROVED_TAB, [shifted, leadRow({ lead_id: `${NS}-001` })]);
    mock.addTab(R.LOG_TAB, logGrid([]));
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'D Approved Outreach columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('contact_blocked'), d.detail);
  });
});

describe('parseArgs', () => {
  it('applies defaults and parses every flag', () => {
    const a = R.parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.help, false);
    assert.equal(a.limit, 5);
    assert.deepEqual(a.leadIds, []);
    assert.equal(a.provider, '');
    assert.equal(a.namespace, '');
    const b = R.parseArgs([
      '--execute',
      '--limit=3',
      '--lead-ids=a,b, c',
      '--provider=hunter',
      '--namespace=TEST-ENRICH-LIVE-deadbeef',
      '--reports-dir=C:/tmp/x',
      '--no-interactive',
      '--help',
    ]);
    assert.equal(b.execute, true);
    assert.equal(b.limit, 3);
    assert.deepEqual(b.leadIds, ['a', 'b', 'c']);
    assert.equal(b.provider, 'hunter');
    assert.equal(b.namespace, 'TEST-ENRICH-LIVE-deadbeef');
    assert.equal(b.reportsDir, 'C:/tmp/x');
    assert.equal(b.noInteractive, true);
    assert.equal(b.help, true);
  });

  it('falls back to defaults on malformed limit', () => {
    assert.equal(R.parseArgs(['--limit=banana']).limit, 5);
    assert.equal(R.parseArgs(['--limit=-4']).limit, 5);
  });
});

describe('readConfig', () => {
  it('empty env is NOT_CONFIGURED and lists every missing var', () => {
    const c = R.readConfig({});
    assert.equal(c.status, 'NOT_CONFIGURED');
    assert.equal(c.auth.ready, false);
    assert.equal(c.auth.mode, 'none');
    assert.ok(c.missing.includes('GOOGLE_SHEET_ID'));
    assert.ok(c.missing.some((m) => m.includes('GOOGLE_ACCESS_TOKEN')));
    assert.ok(c.missing.includes('AGENTDATA_API_KEY'));
  });

  it('full agentdata env is CONFIGURED with token auth', () => {
    const c = R.readConfig(ENV_READY);
    assert.equal(c.status, 'CONFIGURED');
    assert.equal(c.auth.ready, true);
    assert.equal(c.auth.mode, 'token');
    assert.equal(c.provider, 'agentdata');
    assert.equal(c.ttlDays, 60);
    assert.equal(c.minScore, 50);
    assert.deepEqual(c.missing, []);
  });

  it('hunter env is CONFIGURED and needs only the hunter key', () => {
    const c = R.readConfig({ GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_ACCESS_TOKEN: 't', ENRICHMENT_PROVIDER: 'hunter', HUNTER_API_KEY: 'hk' });
    assert.equal(c.status, 'CONFIGURED');
    assert.equal(c.provider, 'hunter');
    assert.deepEqual(c.missing, []);
    const hunterOnly = R.readConfig({ GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_ACCESS_TOKEN: 't', ENRICHMENT_PROVIDER: 'hunter' });
    assert.equal(hunterOnly.status, 'NOT_CONFIGURED');
    assert.ok(hunterOnly.missing.some((m) => m.includes('HUNTER_API_KEY')));
  });

  it('service-account auth without token is CONFIGURED', () => {
    const c = R.readConfig({ GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/keys/sa.json', AGENTDATA_API_KEY: 'k' });
    assert.equal(c.status, 'CONFIGURED');
    assert.equal(c.auth.mode, 'service-account');
    assert.equal(c.auth.ready, true);
  });

  it('honours TTL and min-score overrides', () => {
    const c = R.readConfig({ ...ENV_READY, ENRICHMENT_TTL_DAYS: '90', ENRICHMENT_MIN_SCORE: '72' });
    assert.equal(c.ttlDays, 90);
    assert.equal(c.minScore, 72);
  });

  it('defaults country policy to US-only when no vars are set', () => {
    const c = R.readConfig(ENV_READY);
    assert.deepEqual(c.countries, { allow: ['US'], deny: [] });
  });

  it('parses allow/deny into normalized lists; empty or * allow all; deny wins', () => {
    assert.deepEqual(R.readConfig({ ...ENV_READY, ENRICHMENT_COUNTRIES_ALLOW: 'us, CA , mx' }).countries, { allow: ['US', 'CA', 'MX'], deny: [] });
    assert.deepEqual(R.readConfig({ ...ENV_READY, ENRICHMENT_COUNTRIES_ALLOW: '*' }).countries, { allow: ['*'], deny: [] });
    assert.deepEqual(R.readConfig({ ...ENV_READY, ENRICHMENT_COUNTRIES_ALLOW: '' }).countries, { allow: [], deny: [] });
    assert.deepEqual(R.readConfig({ ...ENV_READY, ENRICHMENT_COUNTRIES_ALLOW: 'US', ENRICHMENT_COUNTRIES_DENY: 'ca, MX' }).countries, { allow: ['US'], deny: ['CA', 'MX'] });
  });
});

describe('namespace helpers', () => {
  it('default run token is hex, namespace matches the prefix regex', () => {
    assert.match(R.defaultRunToken(), /^[0-9a-f]{8,32}$/i);
    assert.match(R.namespaceForArgs({}), /^TEST-ENRICH-LIVE-[0-9a-f]{8,32}$/i);
  });

  it('explicit namespace wins and namespace stays identical', () => {
    assert.equal(R.namespaceForArgs({ namespace: NS }), NS);
  });

  it('isNamespacedLead splits test leads from production leads', () => {
    assert.equal(R.isNamespacedLead(`${NS}-001`), true);
    assert.equal(R.isNamespacedLead('LEAD-REAL-77'), false);
    assert.equal(R.isNamespacedLead('TEST-ENRICH-NOPE-001'), false);
  });

  it('providerForArgs prefers arg over env over default, rejects unknown', () => {
    assert.equal(R.providerForArgs({ provider: 'hunter' }, {}), 'hunter');
    assert.equal(R.providerForArgs({}, { ENRICHMENT_PROVIDER: 'hunter' }), 'hunter');
    assert.equal(R.providerForArgs({}, {}), 'agentdata');
    assert.equal(R.providerForArgs({ provider: 'nonsense' }, {}), null);
  });
});

describe('classifyLead', () => {
  it('labels every exclusion reason in priority order', () => {
    const lead = { lead_id: 'a', country: 'US', website: 'x.com', email: '', contact_blocked: '' };
    assert.equal(R.classifyLead(lead, { countryInScope: true, domain: 'x.com' }).reason, null);
    assert.equal(R.classifyLead(lead, { countryInScope: false, domain: 'x.com' }).reason, 'non_us');
    assert.equal(R.classifyLead(lead, { countryInScope: true, domain: '' }).reason, 'no_domain');
    assert.equal(R.classifyLead({ ...lead, email: 'x@x.com' }, { countryInScope: true, domain: 'x.com' }).reason, 'already_enriched');
    assert.equal(R.classifyLead({ ...lead, contact_blocked: 'TRUE' }, { countryInScope: true, domain: 'x.com' }).reason, 'blocked');
    assert.equal(R.classifyLead(lead, { countryInScope: true, domain: 'x.com', leadIds: new Set(['other']) }).reason, 'out_of_scope');
  });
});

describe('isCountryInScope (H.8c country policy)', () => {
  const scope = (country, allow, deny) => R.isCountryInScope(country, { allow, deny: deny || [] });

  it('fail-closes on a missing or blank country', () => {
    assert.equal(scope('', ['US']), false);
    assert.equal(scope(undefined, ['US']), false);
    assert.equal(scope(null, ['US']), false);
    assert.equal(scope('   ', ['*']), false);
  });

  it('default allow list admits the listed countries case-insensitively', () => {
    assert.equal(scope('us', ['US']), true);
    assert.equal(scope('CA', ['US', 'CA']), true);
    assert.equal(scope('MX', ['US']), false);
  });

  it('H.9.2 normalizes common variants to their alpha-2 equivalent before matching', () => {
    assert.equal(scope('USA', ['US']), true);
    assert.equal(scope('united states', ['US']), true);
    assert.equal(scope('UNITED STATES OF AMERICA', ['US']), true);
    assert.equal(scope('  USA  ', ['US']), true);
    assert.equal(scope('U.S.A.', ['US']), true);
    assert.equal(scope('U.S.', ['US']), true);
    assert.equal(scope('UK', ['GB']), true);
    assert.equal(scope('CANADA', ['US', 'CA']), true);
  });

  it('variants do not leak into unrelated markets', () => {
    assert.equal(scope('Canada', ['US']), false);   // aliased to CA, not in allow
    assert.equal(scope('Canada', ['US', 'CA']), true);
    assert.equal(scope('UNITED STATES', ['CA']), false);
  });

  it('H.9.2 normalizes deny entries and applies them to aliased input', () => {
    assert.equal(scope('USA', ['US', 'CA'], ['USA']), false);
    assert.equal(scope('UK', ['GB', 'US'], ['UNITED KINGDOM']), false);
    assert.equal(scope('GB', ['GB', 'US'], ['uk']), false);
  });

  it('valid alpha-2 codes keep their existing behaviour', () => {
    assert.equal(scope('US', ['US']), true);
    assert.equal(scope('CA', ['CA']), true);
    assert.equal(scope('GB', ['GB']), true);
    assert.equal(scope('FR', ['US']), false);
  });

  it('deny always wins, even when allow contains the country', () => {
    assert.equal(scope('US', ['US'], ['US']), false);
    assert.equal(scope('CA', ['US', 'CA'], ['CA']), false);
  });

  it('empty allow list = allow all; "*" = allow all', () => {
    assert.equal(scope('FR', []), true);
    assert.equal(scope('FR', ['*']), true);
    assert.equal(scope('FR', ['US', '*']), true);
  });

  it('survives messy values: mixed case, whitespace, deny listed trimmed', () => {
    assert.equal(scope(' ca ', ['US', 'ca']), true);
    assert.equal(scope('ca', ['CA'], [' ca ']), false);
  });
});

describe('preflight', () => {
  it('fails on an unconfigured env even with a client', async () => {
    const r = await R.preflight({}, { namespace: NS }, { client: makeMock([]) });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.checks.some((c) => c.label === 'B config present' && !c.ok));
    assert.ok(r.checks.some((c) => c.label === 'C sheet auth' && !c.ok));
  });

  it('fails fast listing the exact missing column names', async () => {
    const approved = approvedGrid([leadRow({ lead_id: `${NS}-001` })]);
    approved[0] = approved[0].filter((c) => c !== 'contact_blocked');
    const mock = new MockSheets();
    mock.addTab(R.APPROVED_TAB, approved);
    mock.addTab(R.LOG_TAB, logGrid([]));
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'FAIL');
    const d = r.checks.find((c) => c.label === 'D Approved Outreach columns');
    assert.equal(d.ok, false);
    assert.ok(d.detail.includes('contact_blocked'), d.detail);

    const mock2 = new MockSheets();
    mock2.addTab(R.APPROVED_TAB, approvedGrid([leadRow({ lead_id: `${NS}-001` })]));
    mock2.addTab(R.LOG_TAB, [ENRICHMENT_LOG_COLUMNS.slice().filter((c) => c !== 'notes')]);
    const r2 = await R.preflight(ENV_READY, { namespace: NS }, { client: mock2 });
    assert.equal(r2.status, 'FAIL');
    const e = r2.checks.find((c) => c.label === 'E Contact Enrichment Log columns');
    assert.equal(e.ok, false);
    assert.ok(e.detail.includes('notes'), e.detail);
  });

  it('passes with full headers, configured env and a populated client', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'PASS');
    for (const c of r.checks) assert.ok(c.ok, `${c.label}: ${c.detail}`);
  });

  it('passes for hunter env with the hunter key', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const env = { GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_ACCESS_TOKEN: 't', ENRICHMENT_PROVIDER: 'hunter', HUNTER_API_KEY: 'hk' };
    const r = await R.preflight(env, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'PASS');
    assert.ok(r.checks.some((c) => c.label === 'G HUNTER_API_KEY' && c.ok));
  });

  it('reports namespace trouble as informational only', async () => {
    const mock = makeMock([leadRow({ lead_id: 'LEAD-PROD-1', website: 'https://acme.example' })]);
    const r = await R.preflight(ENV_READY, { namespace: 'PRODUCTION' }, { client: mock });
    assert.equal(r.status, 'PASS');
    const h = r.checks.find((c) => c.label === 'H namespace well-formed');
    assert.equal(h.informational, true);
  });

  it('FAILs when no Sheets client is available', async () => {
    const r = await R.preflight(ENV_READY, { namespace: NS }, {});
    assert.equal(r.status, 'FAIL');
    assert.ok(r.checks.some((c) => c.label === 'D/E sheet reads' && !c.ok));
  });
});

describe('preflight observability (H.8b.1)', () => {
  it('returns named per-check results on every check', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001` })]);
    const r = await R.preflight(ENV_READY, { namespace: NS }, { client: mock });
    assert.equal(r.status, 'PASS');
    assert.ok(r.checks.length >= 6);
    for (const c of r.checks) {
      assert.ok(typeof c.label === 'string' && c.label.length > 0, `label present for ${c.label}`);
      assert.equal(typeof c.ok, 'boolean', `ok boolean for ${c.label}`);
      assert.equal(typeof c.detail, 'string', `detail string for ${c.label}`);
    }
  });

  it('a bad ENRICHMENT_PROVIDER fails the F provider check by name', async () => {
    const r = await R.preflight({ ...ENV_READY, ENRICHMENT_PROVIDER: 'bogus' }, { namespace: NS }, { client: makeMock() });
    assert.equal(r.status, 'FAIL');
    const f = r.checks.find((c) => c.label === 'F provider');
    assert.equal(f.ok, false);
    assert.ok(f.detail.includes('bogus') && f.detail.includes('agentdata'), f.detail);
  });

  it('runEnrichment report failure_info names the failing check', async () => {
    const dir = tmpDir();
    const { d } = buildDeps({ client: makeMock() });
    const out = await R.runEnrichment({ ...ENV_READY, ENRICHMENT_PROVIDER: 'bogus' }, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.ok(out.report.failure_info.some((f) => f.includes('F provider')), out.report.failure_info.join(' | '));
    const check = out.report.preflight_detail.find((c) => c.name === 'F provider');
    assert.equal(check.ok, false);
    assert.equal(typeof check.detail, 'string');
  });

  it('a missing Approved column fails preflight and the report names it', async () => {
    const approved = approvedGrid([leadRow({ lead_id: `${NS}-001` })]);
    approved[0] = approved[0].filter((c) => c !== 'contact_blocked');
    const mock = new MockSheets();
    mock.addTab(R.APPROVED_TAB, approved);
    mock.addTab(R.LOG_TAB, logGrid([]));
    const dir = tmpDir();
    const { d } = buildDeps({ client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.ok(out.report.failure_info.some((f) => f.includes('D Approved Outreach columns') && f.includes('contact_blocked')), out.report.failure_info.join(' | '));
    const check = out.report.preflight_detail.find((c) => c.name === 'D Approved Outreach columns');
    assert.equal(check.ok, false);
    assert.ok(check.detail.includes('contact_blocked'), check.detail);
  });

  it('PASS reports carry preflight_detail with every check ok', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const dir = tmpDir();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('j@acme.example') }, client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.ok(Array.isArray(out.report.preflight_detail) && out.report.preflight_detail.length > 0);
    for (const c of out.report.preflight_detail) {
      assert.ok(typeof c.name === 'string' && c.name.length > 0, c.name);
      assert.equal(typeof c.ok, 'boolean');
      assert.equal(typeof c.detail, 'string');
      assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
    }
  });

  it('a client-construction failure is named as the D/E sheet reads check', async () => {
    const dir = tmpDir();
    const env = { GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_ACCESS_TOKEN: '', GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/nope/does-not-exist.json', AGENTDATA_API_KEY: 'k' };
    const out = await R.runEnrichment(env, { namespace: NS, reportsDir: dir }, {});
    assert.equal(out.status, 'FAIL');
    assert.ok(out.report.failure_info.some((f) => f.includes('D/E sheet reads')), out.report.failure_info.join(' | '));
    const check = out.report.preflight_detail.find((c) => c.name === 'D/E sheet reads');
    assert.equal(check.ok, false);
    assert.ok(check.detail.length > 0, check.detail);
  });
});

describe('dry-run pipeline (no --execute)', () => {
  it('enriches the single eligible lead, excludes everything else, writes nothing', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' }),
      leadRow({ lead_id: `${NS}-002` }),
      leadRow({ lead_id: `${NS}-003`, country: 'Canada', website: 'https://c.example' }),
      leadRow({ lead_id: `${NS}-004`, website: 'https://d.example', email: 'x@d.example' }),
      leadRow({ lead_id: `${NS}-005`, website: 'https://e.example', contact_blocked: 'TRUE' }),
    ]);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const { d, provider } = buildDeps({ byDomain: { 'acme.example': emailResult('john@acme.example') }, client: mock, transport });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'DRY_RUN');
    const r = out.report;
    assert.equal(r.mode, 'DRY_RUN');
    assert.equal(r.write_attempted, false);
    assert.equal(r.stats.total, 5);
    assert.equal(r.stats.eligible, 1);
    assert.equal(r.stats.enriched, 1);
    assert.equal(r.stats.credits_consumed, 1);
    assert.equal(r.stats.cache_hits, 0);
    assert.deepEqual(r.stats.excluded, { no_domain: 1, non_us: 1, already_enriched: 1, blocked: 1 });
    assert.equal(r.outcomes.enriched.length, 1);
    assert.equal(r.outcomes.enriched[0].lead_id, `${NS}-001`);
    assert.equal(r.outcomes.enriched[0].email_filled, true);
    assert.equal(r.outcomes.enriched[0].provider, 'agentdata');
    assert.equal(r.log_rows_appended, 0);
    assert.equal(r.log_rows_would_append, 1);
    assert.equal(r.cache_hits_would_bump, 0);
    assert.equal(mock.listRows(R.LOG_TAB).length, 1); // header only, nothing appended
    assert.equal(provider.calls.length, 1);
    assert.equal(calls.length, 0);
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('john@acme.example'), false); // no PII past lead_id
    assert.equal(r.sheet.id, SPREADSHEET_ID);
    assert.ok(r.run_id.startsWith(`ENRICH-LIVE-${NS.replace('TEST-ENRICH-LIVE-', '')}-`));
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('-enrichment-live.json')));
  });

  it('restricts scope via --lead-ids', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' }),
      leadRow({ lead_id: `${NS}-002` }),
      leadRow({ lead_id: `${NS}-003`, country: 'Canada', website: 'https://c.example' }),
    ]);
    const dir = tmpDir();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('john@acme.example') }, client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir, leadIds: [`${NS}-001`, `${NS}-002`] }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.stats.eligible, 1);
    assert.equal(out.report.stats.excluded.out_of_scope, 1);
  });

  it('reads country from column X: US default admits US, excludes Canada', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, country: 'US', website: 'https://us.example' }),
      leadRow({ lead_id: `${NS}-002`, country: 'Canada', website: 'https://ca.example' }),
    ]);
    const dir = tmpDir();
    const { d } = buildDeps({ byDomain: { 'us.example': emailResult('us@us.example') }, client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.stats.eligible, 1);
    assert.equal(out.report.stats.excluded.non_us, 1);
    assert.equal(out.report.outcomes.enriched.length, 1);
    assert.equal(out.report.outcomes.enriched[0].lead_id, `${NS}-001`);
    assert.deepEqual(out.report.country_policy, { allow: ['US'], deny: [] });
  });

  it('reads country from column X: allow=CA admits Canada, excludes US', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, country: 'US', website: 'https://us.example' }),
      leadRow({ lead_id: `${NS}-002`, country: 'CA', website: 'https://ca.example' }),
    ]);
    const dir = tmpDir();
    const env = { ...ENV_READY, ENRICHMENT_COUNTRIES_ALLOW: 'CA' };
    const { d } = buildDeps({ byDomain: { 'ca.example': emailResult('ca@ca.example') }, client: mock });
    const out = await R.runEnrichment(env, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.stats.eligible, 1);
    assert.equal(out.report.stats.excluded.non_us, 1);
    assert.equal(out.report.outcomes.enriched[0].lead_id, `${NS}-002`);
    assert.deepEqual(out.report.country_policy, { allow: ['CA'], deny: [] });
  });

  it('cache hit consumes no credits and bumps the hit count (dry)', async () => {
    const cached = logRowObject({ enrichment_key: 'acme.example::agentdata', lead_id: `${NS}-010`, query_input: 'acme.example', result_email: 'ceo@acme.example', result_contact_name: 'A B', result_verified: 'TRUE', credits_consumed: '1', cache_hit_count: '2' });
    const mock = makeMock([leadRow({ lead_id: `${NS}-010`, website: 'https://acme.example' })], [cached]);
    const dir = tmpDir();
    const { d, provider } = buildDeps({ byDomain: { 'acme.example': emailResult('should-not-run@acme.example') }, client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(provider.calls.length, 0); // provider never called
    const r = out.report;
    assert.equal(r.stats.cache_hits, 1);
    assert.equal(r.stats.credits_consumed, 0);
    assert.equal(r.outcomes.enriched[0].email_filled, true);
    assert.equal(r.cache_hits_would_bump, 1);
    assert.equal(r.log_rows_would_append, 0);
    const logRow = mock.listRows(R.LOG_TAB)[1];
    const obj = Object.fromEntries(ENRICHMENT_LOG_COLUMNS.map((c, i) => [c, logRow[i]]));
    assert.equal(obj.result_email, 'ceo@acme.example');
    assert.equal(obj.cache_hit_count, '2'); // dry run: bump only reported, not written
  });

  it('is deterministic across identical runs', async () => {
    const lead = leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' });
    const runOnce = async () => {
      const mock = makeMock([lead]);
      const dir = tmpDir();
      const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('john@acme.example') }, client: mock });
      return R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.deepEqual(a.report.per_lead_outcomes, b.report.per_lead_outcomes);
    assert.deepEqual(a.report.outcomes, b.report.outcomes);
    assert.deepEqual(a.report.stats, b.report.stats);
  });
});

describe('H.9.3 — live transport default + per_lead_outcomes buckets', () => {
  it('buildRunOutcomes merges enriched/skipped/failed buckets sorted by lead_id, redaction-safe keys', () => {
    const rows = R.buildRunOutcomes({
      enrichedRows: [
        { lead_id: `${NS}-002`, email_source: 'oss', email: 's@beta.example', email_verified: 'Y', contact_source_provider: 'oss' },
        { lead_id: `${NS}-001`, email_source: 'agentdata', email: 'john@acme.example', email_verified: '', contact_source_provider: 'agentdata' },
      ],
      skippedRows: [{ lead_id: `${NS}-003`, enrichment_skip_reason: 'no_domain' }],
      failedRows: [{ lead_id: `${NS}-004`, enrichment_failure_reason: 'AgentData: rate limited' }],
      provider: 'agentdata',
    });
    assert.deepEqual(rows.map((r) => r.lead_id), [`${NS}-001`, `${NS}-002`, `${NS}-003`, `${NS}-004`]);
    assert.equal(rows[0].outcome, 'enriched');
    assert.equal(rows[0].email_source, 'agentdata');
    assert.equal(rows[0].result_email, 'john@acme.example');
    assert.equal(rows[0].result_verified, 'FALSE');
    assert.equal(rows[0].wrote_vw, false);
    assert.equal(rows[1].outcome, 'enriched');
    assert.equal(rows[1].email_source, 'oss');
    assert.equal(rows[1].result_email, 's@beta.example');
    assert.equal(rows[1].result_verified, 'TRUE');
    assert.equal(rows[2].outcome, 'skipped');
    assert.equal(rows[2].enrichment_skip_reason, 'no_domain');
    assert.equal(rows[3].outcome, 'failed');
    assert.equal(rows[3].enrichment_failure_reason, 'AgentData: rate limited');
    assert.ok(!('wrote_vw' in rows[2]), 'skipped entries carry no write-stage flags');
    assert.ok(!('wrote_vw' in rows[3]), 'failed entries carry no write-stage flags');
    assert.ok(['lead_id', 'outcome', 'email_source', 'result_email', 'result_verified'].every((k) => k in rows[0]));
  });

  it('liveProviderTransport mirrors the client fetchTransport contract', async () => {
    const calls = [];
    const original = global.fetch;
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return { status: 404, json: async () => ({ ok: false }) };
    };
    try {
      const out = await R.liveProviderTransport('https://agentdata/api', { headers: { Authorization: 'Bearer k' } });
      assert.deepEqual(out, { status: 404, body: { ok: false } });
    } finally {
      global.fetch = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://agentdata/api');
    assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer k' });
  });

  it('liveProviderTransport omits empty headers entirely', async () => {
    const original = global.fetch;
    global.fetch = async (url, init) => ({ status: 200, json: async () => ({ ok: true }) });
    try {
      const out = await R.liveProviderTransport('https://agentdata/api', {});
      assert.equal(out.status, 200);
    } finally {
      global.fetch = original;
    }
  });

  it('the fallback contact client (no clientWrapper) reaches the provider over an injected transport; 404 is an empty result, not a failure', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const calls = [];
    const transport = async (url, opts = {}) => {
      calls.push({ url, headers: opts.headers || {} });
      return { status: 404, body: {} };
    };
    const resolver = async () => ({ emails: [], blocked: false, notes: '' });
    const dir = tmpDir();
    const d = {
      client: mock,
      now: NOW,
      transport,
      resolver,
      sleep: async () => {},
      clock: () => Date.now(),
      authConfig: { auth: { mode: 'token' }, googlesheetId: SPREADSHEET_ID },
    };
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.enrich, 'PASS');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.Authorization, 'Bearer ad-test-key');
    const r = out.report;
    assert.equal(r.stats.failed, 0);
    assert.equal(r.stats.credits_consumed, 0);
    assert.equal(r.outcomes.enriched.length, 1);
    assert.equal(r.outcomes.enriched[0].lead_id, `${NS}-001`);
    assert.equal(r.outcomes.enriched[0].email_filled, false);
    const outcome = r.per_lead_outcomes.find((o) => o.lead_id === `${NS}-001`);
    assert.equal(outcome.outcome, 'enriched');
    assert.equal(outcome.email_source, 'oss'); // OSS supersedes the provider-empty result
    assert.equal(outcome.result_email, '<redacted>'); // result_email matches SENSITIVE_KEY_RE
    assert.equal(outcome.result_verified, 'FALSE');
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('-enrichment-live.json')));
  });

  it('the fallback contact client defaults to the live fetch transport (root-cause fix), so a 404 yields an empty lead instead of transport-unavailable failure', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const original = global.fetch;
    global.fetch = async () => ({ status: 404, body: null, json: async () => ({}) });
    try {
      const resolver = async () => ({ emails: [], blocked: false, notes: '' });
      const dir = tmpDir();
      const d = {
        client: mock,
        now: NOW,
        resolver,
        sleep: async () => {},
        clock: () => Date.now(),
        authConfig: { auth: { mode: 'token' }, googlesheetId: SPREADSHEET_ID },
      };
      const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
      assert.equal(out.status, 'PASS');
      const r = out.report;
      assert.equal(r.stats.failed, 0);
      assert.equal(r.stats.credits_consumed, 0);
      assert.equal(r.outcomes.enriched.length, 1);
      assert.ok(!r.failure_info.some((f) => /transport/i.test(String(f))), `no transport failure: ${r.failure_info.join(' | ')}`);
    } finally {
      global.fetch = original;
    }
  });

  it('per_lead_outcomes reports enriched and failed buckets in a full dry-run pipeline', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://ok.example' }),
      leadRow({ lead_id: `${NS}-002`, website: 'https://boom.example' }),
    ]);
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'ok.example': emailResult('j@ok.example'), 'boom.example': { reason: 'AgentData: rate limited' } },
      client: mock,
    });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const outcomes = out.report.per_lead_outcomes;
    assert.deepEqual(outcomes.map((o) => o.lead_id), [`${NS}-001`, `${NS}-002`]);
    assert.equal(outcomes[0].outcome, 'enriched');
    assert.equal(outcomes[0].result_verified, 'TRUE');
    assert.equal(outcomes[1].outcome, 'failed');
    assert.equal(outcomes[1].enrichment_failure_reason, 'AgentData: rate limited');
  });
});

describe('execute pipeline (--execute)', () => {
  it('appends log rows and updates only V/W, via provider + OSS fallback + manual block', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' }),
      leadRow({ lead_id: `${NS}-002`, website: 'https://beta.example' }),
      leadRow({ lead_id: `${NS}-003`, website: 'https://gamma.example' }),
    ]);
    const empty = () => ({ ok: true, emails: [], source: 'agentdata', creditsUsed: 1 });
    const resolver = async (domain) => {
      if (domain === 'beta.example') return { emails: [{ value: 's@beta.example', score: 75, verified: true, first_name: 'S', last_name: 'B', position: '' }], blocked: false, notes: '' };
      if (domain === 'gamma.example') return { emails: [], blocked: true, notes: 'oss_no_results' };
      return { emails: [], blocked: false, notes: '' };
    };
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('john@acme.example'), 'beta.example': empty(), 'gamma.example': empty() },
      resolver,
      client: mock,
      transport,
    });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'PASS');
    const r = out.report;
    assert.equal(r.mode, 'EXECUTE');
    assert.equal(r.write_attempted, true);

    // appended log rows: agentdata rows for the 3 domains + oss rows for beta and gamma
    assert.equal(r.log_rows_appended, 5);
    const logRows = mock.listRows(R.LOG_TAB).slice(1);
    assert.equal(logRows.length, 5);
    const keys = logRows.map((row) => String(row[1]));
    for (const k of ['acme.example::agentdata', 'beta.example::agentdata', 'beta.example::oss', 'gamma.example::agentdata', 'gamma.example::oss']) {
      assert.ok(keys.includes(k), k);
    }

    // OSS fallback invoked for the two provider-empty leads; credits only from provider
    assert.equal(r.stats.oss_fallback_invoked, 2);
    assert.equal(r.stats.credits_consumed, 3);

    // results: acme=provider, beta=oss, gamma=manual-blocked
    const byLead = Object.fromEntries(r.outcomes.enriched.map((e) => [e.lead_id, e]));
    assert.equal(byLead[`${NS}-001`].provider, 'agentdata');
    assert.equal(byLead[`${NS}-002`].provider, 'oss');
    assert.equal(byLead[`${NS}-003`].provider, 'manual');
    assert.equal(byLead[`${NS}-003`].blocked, true);
    assert.equal(byLead[`${NS}-001`].email_filled, true);
    assert.equal(byLead[`${NS}-002`].email_filled, true);
    assert.equal(byLead[`${NS}-003`].email_filled, false);

    // V/W cell updates: provider (V) for all three, blocked (W) for the manual block only
    assert.equal(r.approved_outreach_updated_vw, 4);
    assert.equal(r.approved_outreach_would_update_vw, 4);
    const putUrls = calls.map((c) => c.url);
    const refs = putUrls.map((u) => (u.match(/!([A-Z])(\d+)/) || [])[0]).sort();
    assert.deepEqual(refs, ['!V2', '!V3', '!V4', '!W4']);
    for (const u of putUrls) {
      assert.ok(u.includes('Approved'), u);
      assert.ok(!/(!([A-U])\d)/.test(u), `never writes A-U on Approved Outreach: ${u}`);
    }
    for (const c of calls) assert.equal(c.method, 'PUT');
  });

  it('writes provider to V and blocked to W, matching the live sheet columns', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' }),
      leadRow({ lead_id: `${NS}-002`, website: 'https://gamma.example' }),
    ]);
    const empty = () => ({ ok: true, emails: [], source: 'agentdata', creditsUsed: 1 });
    const resolver = async (domain) => {
      if (domain === 'gamma.example') return { emails: [], blocked: true, notes: 'oss_no_results' };
      return { emails: [], blocked: false, notes: '' };
    };
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('j@acme.example'), 'gamma.example': empty() },
      resolver,
      client: mock,
      transport,
    });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const byRef = {};
    for (const c of calls) {
      const m = c.url.match(/!([A-Z])(\d+)/);
      byRef[`${m[1]}${m[2]}`] = JSON.parse(c.body).values[0][0];
    }
    assert.equal(byRef.V2, 'agentdata'); // row 2: acme provider on contact_source_provider (V)
    assert.equal(byRef.V3, 'manual');    // row 3: gamma OSS block still stamps provider on V
    assert.equal(byRef.W3, 'TRUE');      // row 3: gamma blocked flag on contact_blocked (W)
    assert.ok(!('W2' in byRef), 'provider-only rows never touch W');
    assert.ok(!Object.values(byRef).includes('TRUE') || byRef.W3 === 'TRUE', 'TRUE is only ever written to W');
  });

  it('never writes non-namespaced production leads', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-020`, website: 'https://acme.example' }),
      leadRow({ lead_id: 'LEAD-REAL-77', website: 'https://real.example' }),
    ]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('john@acme.example'), 'real.example': emailResult('j@real.example') },
      client: mock,
      transport,
    });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const r = out.report;
    assert.equal(r.log_rows_appended, 1); // only namespaced acme row appended
    assert.equal(r.log_rows_would_append, 2);
    const namespaced = mock.listRows(R.LOG_TAB).slice(1).map((row) => String(row[1]));
    assert.deepEqual(namespaced, ['acme.example::agentdata']);
    assert.equal(r.approved_outreach_updated_vw, 1);
    assert.equal(r.approved_outreach_would_update_vw, 2);
    const urls = calls.map((c) => c.url);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('!V2'), urls[0]); // provider cell (contact_source_provider = V)
  });

  it('write-backs cache hit counts on the log tab only', async () => {
    const cached = logRowObject({ enrichment_key: 'acme.example::agentdata', lead_id: `${NS}-030`, query_input: 'acme.example', result_email: 'ceo@acme.example', result_verified: 'TRUE', credits_consumed: '1', cache_hit_count: '2' });
    const mock = makeMock([leadRow({ lead_id: `${NS}-030`, website: 'https://acme.example' })], [cached]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('never@acme.example') }, client: mock, transport });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const r = out.report;
    assert.equal(r.cache_hits_bumped, 1);
    assert.equal(r.log_rows_appended, 0);
    const urls = calls.map((c) => c.url);
    const bump = urls.filter((u) => u.includes('!M'));
    assert.equal(bump.length, 1); // cache_hit_count column is the log M column
    assert.ok(bump[0].includes('Contact'), bump[0]);
    // cache-hit leads are enriched from cache with provider set, so the provider
    // cell (V) is still written for the namespaced lead — never any A-U columns
    const vwUrls = urls.filter((u) => u.includes('Approved'));
    assert.equal(vwUrls.length, 1);
    assert.ok(vwUrls[0].includes('!V2'), vwUrls[0]);
  });
});

describe('updateValues', () => {
  it('throws without any Google auth', async () => {
    await assert.rejects(
      () => R.updateValues({ spreadsheetId: 'x' }, 'Tab', [{ dataRow: 1, colIndex: 0, value: 'v' }], { auth: { mode: 'none' } }, {}, undefined),
      /requires/,
    );
  });

  it('PUTs each cell via the injected transport with a bearer header', async () => {
    const { transport, calls } = captureTransport();
    const cells = [
      { dataRow: 2, colIndex: 21, value: 'agentdata' },
      { dataRow: 3, colIndex: 22, value: 'TRUE' },
    ];
    const out = await R.updateValues({ spreadsheetId: SPREADSHEET_ID }, 'Approved Outreach', cells, { auth: { mode: 'token' } }, { GOOGLE_ACCESS_TOKEN: 'tok-1' }, transport);
    assert.equal(out.updated, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.includes("!V3"));
    assert.ok(calls[1].url.includes("!W4"));
    assert.deepEqual(
      calls.map((c) => JSON.parse(c.body).values[0][0]),
      ['agentdata', 'TRUE'],
    );
    for (const c of calls) {
      assert.equal(c.headers.Authorization, 'Bearer tok-1');
    }
  });
});

describe('OSS resolver', () => {
  it('returns an unavailable envelope for a broken package', () => {
    const out = R.resolveOssEmail(null, 'x.com', { contact_name: 'A B' });
    assert.equal(out.blocked, true);
    assert.equal(out.notes, 'oss_unavailable');
    const noFn = R.resolveOssEmail({}, 'x.com', { contact_name: 'A B' });
    assert.equal(noFn.blocked, true);
  });

  it('no contact name BLOCKS the lead — never an envelope, never a fabricated address', () => {
    const out = R.resolveOssEmail({ findEmail: () => ({ email: 'a@b.c', confidence: 90 }) }, 'b.c', {});
    assert.equal(out.blocked, true);
    assert.equal(out.notes, 'oss_no_name');
    assert.deepEqual(out.envelopes, []);
  });

  it('maps a findEmail result onto the OSS envelope shape', () => {
    const pkg = { findEmail: () => ({ email: 'john@acme.example', confidence: 40, status: 'unknown' }) };
    const out = R.resolveOssEmail(pkg, 'acme.example', { contact_name: 'John Doe' });
    assert.equal(out.envelopes.length, 1);
    assert.equal(out.envelopes[0].value, 'john@acme.example');
    assert.equal(out.envelopes[0].verified, false);
    assert.equal(out.envelopes[0].first_name, 'John');
  });

  it('the installed @absolutejs/enrich package is resolution-only and never scores above minScore', () => {
    const pkg = R.loadEnrichPackage();
    if (!pkg.usable) {
      const out = R.resolverFor({})('acme.example', { contact_name: 'John Doe' });
      assert.equal(out.blocked, true);
      assert.equal(out.notes, 'oss_unavailable');
      return;
    }
    for (const name of ['John Doe', 'Jane Smith', 'Michael Johnson']) {
      const out = R.resolveOssEmail(pkg.module, 'microsoft.com', { contact_name: name });
      assert.equal(typeof out.blocked, 'boolean');
      for (const env of out.envelopes) {
        assert.ok(env.score < R.readConfig(ENV_READY).minScore, `confidence ${env.score} is discovery-only`);
      }
    }
  });
});

describe('diff helpers', () => {
  it('diffNewLogRows yields only keys absent from the cache', () => {
    const a = { enrichment_key: 'x::agentdata' };
    const b = { enrichment_key: 'y::agentdata' };
    assert.deepEqual(R.diffNewLogRows([a], [a, b]), [b]);
    assert.deepEqual(R.diffNewLogRows([], [a]), [a]);
  });

  it('diffCacheBumps emits a cell per increased hit count', () => {
    const before = [{ enrichment_key: 'x::agentdata', cache_hit_count: '2', lead_id: 'L1' }];
    const after = [{ enrichment_key: 'x::agentdata', cache_hit_count: '4', lead_id: 'L1' }];
    const cells = R.diffCacheBumps(before, after, null);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].value, '4');
    assert.equal(cells[0].dataRow, 1);
  });

  it('approvedVwCells writes only V and W for enriched scope leads', () => {
    const approvedRows = [Object.fromEntries(APPROVED_COLUMNS.map((c) => [c, '']))];
    approvedRows[0].lead_id = `${NS}-004`;
    const enriched = [
      { lead_id: `${NS}-004`, contact_source_provider: 'oss', contact_blocked: '' },
      { lead_id: 'NOT-IN-SCOPE', contact_source_provider: 'agentdata', contact_blocked: '' },
    ];
    const cells = R.approvedVwCells(approvedRows, enriched, [enriched[0]]);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].colIndex, APPROVED_COLUMN_INDEX.contact_source_provider);
    assert.equal(cells[0].value, 'oss');
  });

  it('approvedVwCells writes W only for manual blocks', () => {
    const approvedRows = [Object.fromEntries(APPROVED_COLUMNS.map((c) => [c, '']))];
    approvedRows[0].lead_id = `${NS}-005`;
    const enriched = [{ lead_id: `${NS}-005`, contact_source_provider: 'manual', contact_blocked: 'TRUE' }];
    const cells = R.approvedVwCells(approvedRows, enriched, [enriched[0]]);
    assert.equal(cells.length, 2);
    assert.ok(cells.some((c) => c.colIndex === APPROVED_COLUMN_INDEX.contact_source_provider && c.value === 'manual'));
    assert.ok(cells.some((c) => c.colIndex === APPROVED_COLUMN_INDEX.contact_blocked && c.value === 'TRUE'));
  });
});

describe('redaction and run report safety', () => {
  it('redacts sensitive keys and secret-shaped strings', () => {
    const o = R.redact({
      result_email: 'john@acme.example',
      contact_name: 'John',
      notes: 'n',
      access_token: 'tok',
      api_key: 'k',
      authorization: 'Bearer xyz',
      keep: 'value',
      nested: { private_key: 'x', notes: 'n2' },
    });
    assert.equal(o.keep, 'value');
    assert.equal(o.result_email, '<redacted>');
    assert.equal(o.contact_name, '<redacted>');
    assert.equal(o.notes, '<redacted>');
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

  it('the run report never contains configured secrets or raw emails', () => {
    const env = { ...ENV_READY, GOOGLE_ACCESS_TOKEN: 'SECRET-ELEPHANT', GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/keys/sec.json', AGENTDATA_API_KEY: 'SECRET-AGENT-KEY' };
    const report = R.buildRunReport({
      args: { execute: true, namespace: NS },
      env,
      outcomes: { stages: { preflight: 'PASS', write: 'PASS', report: 'PASS' } },
      startedAt: 's',
      completedAt: 'c',
      ns: NS,
      provider: 'agentdata',
      reportRows: { enriched: [{ lead_id: `${NS}-001`, provider: 'agentdata', blocked: false, email_filled: true }], skipped: [], failed: [], excluded: {} },
    }).redacted;
    const txt = JSON.stringify(report);
    assert.equal(txt.includes('SECRET-ELEPHANT'), false);
    assert.equal(txt.includes('SECRET-AGENT-KEY'), false);
    assert.equal(report.mode, 'EXECUTE');
    assert.equal(report.namespace, NS);
  });
});

describe('stage aggregation and exit codes', () => {
  it('exitCodeForStatus maps PASS/FAIL/NOT_CONFIGURED/unknown', () => {
    assert.equal(R.exitCodeForStatus('PASS'), 0);
    assert.equal(R.exitCodeForStatus('FAIL'), 1);
    assert.equal(R.exitCodeForStatus('NOT_CONFIGURED'), 3);
    assert.equal(R.exitCodeForStatus('BOGUS'), 2);
  });

  it('overallStatusOf collapses stages correctly', () => {
    const all = { preflight: 'PASS', read: 'PASS', filter: 'PASS', enrich: 'PASS', write: 'DRY_RUN', report: 'PASS' };
    assert.equal(R.overallStatusOf(all), 'PASS');
    assert.equal(R.overallStatusOf({ ...all, enrich: 'FAIL' }), 'FAIL');
    assert.equal(R.overallStatusOf({ ...all, preflight: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED');
  });
});

describe('run() and CLI wiring', () => {
  it('run() with empty env returns NOT_CONFIGURED and writes a proper report', async () => {
    const dir = tmpDir();
    const out = await R.run({}, { namespace: NS, reportsDir: dir });
    assert.equal(out.status, 'NOT_CONFIGURED');
    assert.equal(out.stages.preflight, 'NOT_CONFIGURED');
    assert.deepEqual(out.report.stages, { preflight: 'NOT_CONFIGURED', read: 'SKIPPED', filter: 'SKIPPED', enrich: 'SKIPPED', write: 'SKIPPED', report: 'SKIPPED' });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('-enrichment-live.json'));
    assert.equal(files.length, 1);
    const back = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(back.preflight_status, 'NOT_CONFIGURED');
    assert.equal(back.run_id, out.report.run_id);
  });

  const runCli = (args, env = {}) => {
    const extra = { ...env };
    for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
    try {
      const out = execFileSync(process.execPath, ['scripts/run-enrichment-live.js', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 2, out: e.stdout ? String(e.stdout) : '' + (e.stderr ? '\n' + String(e.stderr) : '') };
    }
  };

  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.out.toLowerCase().includes('usage'));
    assert.ok(r.out.toLowerCase().includes('dry_run'));
  });

  it('bare invocation with unconfigured env exits 3 (NOT_CONFIGURED)', () => {
    const r = runCli(['--no-interactive', `--reports-dir=${tmpDir()}`], { GOOGLE_SHEET_ID: undefined, GOOGLE_ACCESS_TOKEN: undefined, AGENTDATA_API_KEY: undefined });
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('RESULT: NOT_CONFIGURED'));
    assert.ok(!r.out.includes('RESULT: PASS'));
    assert.ok(!r.out.includes('RESULT: FAIL'));
  });

  it('bare invocation with only google creds still exits 3 (provider key missing)', () => {
    const r = runCli(['--no-interactive', `--reports-dir=${tmpDir()}`], { GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_ACCESS_TOKEN: 't' });
    assert.equal(r.code, 3);
    assert.ok(r.out.includes('RESULT: NOT_CONFIGURED'));
  });
});

describe('H.9.4 — write scope guard, write labels, and report fields', () => {
  it('parseArgs: --scope=production sets args.scope', () => {
    assert.equal(R.parseArgs(['--scope=production']).scope, 'production');
    assert.equal(R.parseArgs(['--scope=test']).scope, 'test');
  });

  it('parseArgs: default scope is "test"', () => {
    assert.equal(R.parseArgs([]).scope, 'test');
    assert.equal(R.parseArgs(['--execute']).scope, 'test');
    assert.equal(R.parseArgs(['--reports-dir=/tmp/x']).scope, 'test');
  });

  it('parseArgs: unknown scope throws via scopeForArgs', () => {
    const args = R.parseArgs(['--scope=bogus']);
    assert.throws(() => R.scopeForArgs(args), /unknown scope "bogus" \(valid: test\|production\)/);
  });

  it('--execute + production + no BIZ_ENRICH_ALLOW_PRODUCTION → REFUSED, exit 1', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('j@acme.example') }, client: mock, transport });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'FAIL');
    assert.equal(R.exitCodeForStatus(out.status), 1);
    assert.equal(out.stages.write, 'REFUSED');
    assert.equal(out.report.mode, 'EXECUTE');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'production');
    assert.equal(out.report.production_confirmed, false);
    assert.equal(calls.length, 0, 'guard returns before any transport/sheet call');
    assert.ok(JSON.stringify(out.report).includes('refusing production write'), 'failure recorded in report');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('-enrichment-live.json')).length, 1, 'a report is still written');
  });

  it('--execute + production + BIZ_ENRICH_ALLOW_PRODUCTION=1 → proceeds', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('j@acme.example') }, client: mock, transport });
    const out = await R.runEnrichment({ ...ENV_READY, BIZ_ENRICH_ALLOW_PRODUCTION: '1' }, { namespace: NS, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'PASS');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'production');
    assert.equal(out.report.production_confirmed, true);
    assert.ok(calls.length > 0, 'write reached the Sheets transport');
  });

  it('--scope=production without --execute → DRY_RUN, effective_scope dry_run', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('j@acme.example') }, client: mock, transport });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'DRY_RUN');
    assert.equal(out.report.requested_scope, 'production');
    assert.equal(out.report.effective_scope, 'dry_run');
    assert.equal(out.report.production_confirmed, false); // guard never consulted in dry run
    assert.equal(calls.length, 0);
  });

  it('--execute with an empty write set → NO_ELIGIBLE', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001` })]); // no website → NO_DOMAIN, nothing eligible
    const dir = tmpDir();
    const { transport, calls } = captureTransport();
    const { d } = buildDeps({ client: mock, transport });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'NO_ELIGIBLE');
    assert.equal(out.report.effective_scope, 'test');
    assert.equal(calls.length, 0);
  });

  it('report fields present and correct on the dry-run happy path, persisted too', async () => {
    const mock = makeMock([leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' })]);
    const dir = tmpDir();
    const { d } = buildDeps({ byDomain: { 'acme.example': emailResult('j@acme.example') }, client: mock });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.report.requested_scope, 'test');
    assert.equal(out.report.effective_scope, 'dry_run');
    assert.equal(out.report.production_confirmed, false);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('-enrichment-live.json'));
    assert.equal(files.length, 1);
    const back = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(back.requested_scope, 'test');
    assert.equal(back.effective_scope, 'dry_run');
    assert.equal(back.production_confirmed, false);
  });

  it('CLI --execute --scope=production without confirmation exits 1 (REFUSED)', () => {
    const runCli = (args, env = {}) => {
      const extra = { ...env };
      for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
      try {
        const out = execFileSync(process.execPath, ['scripts/run-enrichment-live.js', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status ?? 2, out: e.stdout ? String(e.stdout) : '' + (e.stderr ? '\n' + String(e.stderr) : '') };
      }
    };
    const dir = tmpDir();
    const r = runCli(['--execute', '--scope=production', '--no-interactive', `--reports-dir=${dir}`], ENV_READY);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('RESULT: FAIL'), r.out);
    assert.ok(r.out.includes('write=REFUSED'), r.out);
  });
});

describe('H.9.4c — scope-aware write filter', () => {
  it('test scope + --execute keeps the isNamespacedLead filter (production lead skipped)', async () => {
    const mock = makeMock([
      leadRow({ lead_id: `${NS}-001`, website: 'https://acme.example' }),
      leadRow({ lead_id: 'FSQ-PHONE-001', website: 'https://real.example' }),
    ]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('j@acme.example'), 'real.example': emailResult('r@real.example') },
      client: mock,
      transport,
    });
    const out = await R.runEnrichment(ENV_READY, { namespace: NS, execute: true, scope: 'test', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const r = out.report;
    assert.equal(r.effective_scope, 'test');
    assert.equal(r.log_rows_appended, 1); // only the namespaced acme row appended
    assert.equal(r.log_rows_would_append, 2);
    assert.equal(r.approved_outreach_updated_vw, 1);
    assert.equal(r.approved_outreach_would_update_vw, 2);
    const logLeadIds = mock.listRows(R.LOG_TAB).slice(1).map((row) => String(row[2]));
    assert.deepEqual(logLeadIds, [`${NS}-001`]);
    const urls = calls.map((c) => c.url);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('!V2'), urls[0]);
  });

  it('production scope + --execute + confirmed env writes production lead_ids', async () => {
    const mock = makeMock([
      leadRow({ lead_id: 'FSQ-PHONE-001', website: 'https://acme.example' }),
      leadRow({ lead_id: 'FSQ-PHONE-002', website: 'https://beta.example' }),
    ]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('j@acme.example'), 'beta.example': emailResult('k@beta.example') },
      client: mock,
      transport,
    });
    const out = await R.runEnrichment({ ...ENV_READY, BIZ_ENRICH_ALLOW_PRODUCTION: '1' }, { namespace: NS, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    assert.equal(out.stages.write, 'PASS');
    const r = out.report;
    assert.equal(r.production_confirmed, true);
    const logRows = mock.listRows(R.LOG_TAB).slice(1);
    assert.equal(logRows.length, 2);
    const keys = logRows.map((row) => String(row[1]));
    assert.ok(keys.includes('acme.example::agentdata'), keys);
    assert.ok(keys.includes('beta.example::agentdata'), keys);
    const logLeadIds = logRows.map((row) => String(row[2]));
    assert.deepEqual(logLeadIds.sort(), ['FSQ-PHONE-001', 'FSQ-PHONE-002']);
    assert.ok(calls.some((c) => c.url.includes('!V')), 'V cells written for production leads');
  });

  it('production scope + --execute writes BOTH test and production lead_ids; count == eligible', async () => {
    const mock = makeMock([
      leadRow({ lead_id: 'FSQ-PHONE-001', website: 'https://acme.example' }),
      leadRow({ lead_id: `${NS}-002`, website: 'https://beta.example' }),
    ]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: { 'acme.example': emailResult('j@acme.example'), 'beta.example': emailResult('k@beta.example') },
      client: mock,
      transport,
    });
    const out = await R.runEnrichment({ ...ENV_READY, BIZ_ENRICH_ALLOW_PRODUCTION: '1' }, { namespace: NS, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const r = out.report;
    assert.equal(r.stats.eligible, 2);
    assert.equal(r.log_rows_appended, 2, 'write count equals the total eligible lead count');
    assert.equal(r.log_rows_appended, r.stats.eligible);
    assert.equal(r.approved_outreach_updated_vw, 2);
    const logLeadIds = mock.listRows(R.LOG_TAB).slice(1).map((row) => String(row[2]));
    assert.deepEqual(logLeadIds.sort(), ['FSQ-PHONE-001', `${NS}-002`]);
    const namespacedWrites = calls.filter((c) => c.url.includes('Approved'));
    assert.ok(namespacedWrites.length > 0, 'both leads flow through the write block');
  });

  it('H.9.4c regression — 3 production leads in production scope are all written (was empty pre-fix)', async () => {
    const mock = makeMock([
      leadRow({ lead_id: 'FSQ-PHONE-011', website: 'https://acme.example' }),
      leadRow({ lead_id: 'FSQ-PHONE-012', website: 'https://beta.example' }),
      leadRow({ lead_id: 'FSQ-PHONE-013', website: 'https://gamma.example' }),
    ]);
    const { transport, calls } = captureTransport();
    const dir = tmpDir();
    const { d } = buildDeps({
      byDomain: {
        'acme.example': emailResult('a@acme.example'),
        'beta.example': emailResult('b@beta.example'),
        'gamma.example': emailResult('c@gamma.example'),
      },
      client: mock,
      transport,
    });
    const out = await R.runEnrichment({ ...ENV_READY, BIZ_ENRICH_ALLOW_PRODUCTION: '1' }, { namespace: NS, execute: true, scope: 'production', reportsDir: dir }, d);
    assert.equal(out.status, 'PASS');
    const r = out.report;
    assert.equal(r.write_attempted, true);
    assert.ok(r.log_rows_appended > 0, 'write block must not be empty (production scope)');
    assert.equal(r.log_rows_appended, 3, 'all three production log rows appended');
    assert.equal(r.approved_outreach_updated_vw, 3, 'all three V cells updated');
    // appends are local to the mock; transport sees only the V/W PUT cells
    assert.equal(calls.length, 3, 'one V update per production lead');
    for (const c of calls) assert.equal(c.method, 'PUT');
  });
});

describe('Phase 5 security-gate literal scan', () => {
  it('runner source has no random ids or secret-looking literals', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'run-enrichment-live.js'), 'utf8');
    for (const banned of ['Math.random(', 'randomUUID']) {
      assert.ok(!src.includes(banned), `banned literal ${banned}`);
    }
    for (const pattern of [/sk-[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{20,}/, /ya29\.[0-9A-Za-z_-]{10,}/]) {
      assert.equal(pattern.test(src), false, `banned secret-shaped value ${pattern}`);
    }
  });
});