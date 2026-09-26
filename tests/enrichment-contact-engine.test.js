'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichContactLeads,
  pickBestEmail,
  normalizeDomain,
  scoreOf,
  verifiedOf,
  SKIP_REASONS,
  NO_EMAILS_FOUND,
  NO_ACCEPTED_EMAIL,
} = require('../src/enrichment-contact');
const { embeddedContactSource } = require('../src/embedded-enrichment-contact');
const {
  loadEnrichmentFixtures,
  CONTACT_FIXTURES_PATH,
  AGENTDATA_CONTACT_FIXTURES_PATH,
} = require('../fixtures/enrichment-fixtures.js');

const fixtures = [
  ...loadEnrichmentFixtures(CONTACT_FIXTURES_PATH),
  ...loadEnrichmentFixtures(AGENTDATA_CONTACT_FIXTURES_PATH),
]
  .filter((f) => f.expected && f.expected.contact)
  .map((f) => Object.assign({}, f, { expected: f.expected.contact }));

/*
 * Stub client derived from a fixture's domainResults map, implementing the
 * client contract (client.domainSearch throwing on failures):
 *   { "<domain>": { emails: […], creditsUsed } }      → ok provider result
 *   { "<domain>": { fatal: true, reason, status } }   → FATAL client throw
 *   { "<domain>": { error: true, reason, status } }   → non-fatal client throw
 * Domains absent from the map resolve to ok with zero emails at zero credit.
 * `provider` is taken from the fixture so enrichment keys/seams are labelled
 * by the same provider the live client would report.
 */
function stubClientFor(fixture) {
  const provider = fixture.provider || 'agentdata';
  return {
    provider,
    domainSearch: async (domain) => {
      const entry = (fixture.domainResults || {})[domain];
      if (entry == null) return { emails: [], source: provider, creditsUsed: 0 };
      if (entry.fatal === true) {
        const err = new Error(entry.reason || 'stub_fatal');
        err.fatal = true;
        err.reason = entry.reason || 'stub_fatal';
        err.status = entry.status || null;
        throw err;
      }
      if (entry.error === true) {
        const err = new Error(entry.reason || 'stub_error');
        err.fatal = false;
        err.reason = entry.reason || 'stub_error';
        err.status = entry.status || null;
        throw err;
      }
      return { emails: entry.emails || [], source: provider, creditsUsed: entry.creditsUsed || 0 };
    },
  };
}

/* ------------------------- helper units ------------------------- */

test('normalizeDomain: scheme, www, path, query and fragment stripped, lowercase', () => {
  assert.equal(normalizeDomain('https://Example.com/contact?x=1#top'), 'example.com');
  assert.equal(normalizeDomain('WWW.mydomain.example.net'), 'mydomain.example.net');
  assert.equal(normalizeDomain('domain.example.org.'), 'domain.example.org');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
});

test('scoreOf / verifiedOf: tolerant numeric and boolean coercion across provider shapes', () => {
  assert.equal(scoreOf({ score: 95 }), 95);
  assert.equal(scoreOf({ score: '0' }), 0);
  assert.equal(scoreOf({ confidence: 97 }), 97, 'canonical confidence field');
  assert.equal(scoreOf({ confidence: '0' }), 0);
  assert.equal(scoreOf(null), 0);
  assert.equal(scoreOf({}), 0);
  assert.equal(verifiedOf({ verified: true }), true);
  assert.equal(verifiedOf({ verified: 'TRUE' }), true);
  assert.equal(verifiedOf({ verified: 'Y' }), true);
  assert.equal(verifiedOf({ verified: '1' }), true);
  assert.equal(verifiedOf({ verified: 1 }), false, 'only string markers qualify');
  assert.equal(verifiedOf({ verified: false }), false);
  assert.equal(verifiedOf({ verification_status: 'valid' }), true, 'canonical status field');
  assert.equal(verifiedOf({ verification_status: 'unknown' }), false);
  assert.equal(verifiedOf(null), false);
});

test('pickBestEmail: generic local parts and low scores are never accepted', () => {
  const emails = [
    { value: 'info@acme.example.com', score: 99, verified: true },
    { value: 'sales@acme.example.com', score: 98, verified: true },
    { value: 'jane@acme.example.com', score: 40, verified: true },
    { value: 'john@acme.example.com', score: 80, verified: true },
  ];
  const best = pickBestEmail(emails, { minScore: 50 });
  assert.equal(best.value, 'john@acme.example.com');
});

test('pickBestEmail: accepts canonical provider email items', () => {
  const emails = [
    { email: 'info@acme.example.com', confidence: 99, verification_status: 'valid' },
    { email: 'jane.doe@acme.example.com', confidence: 92, verification_status: 'valid', first_name: 'Jane', last_name: 'Doe' },
    { email: 'john.smith@acme.example.com', confidence: 98, verification_status: 'valid', first_name: 'John', last_name: 'Smith' },
  ];
  const best = pickBestEmail(emails, { minScore: 90 });
  assert.equal(best.email, 'john.smith@acme.example.com');
});

test('pickBestEmail: score desc, then verified, then value asc', () => {
  const emails = [
    { value: 'b@x.example.com', score: 90, verified: false },
    { value: 'a@x.example.com', score: 90, verified: false },
    { value: 'v@x.example.com', score: 90, verified: true },
  ];
  assert.equal(pickBestEmail(emails).value, 'v@x.example.com');
  assert.equal(pickBestEmail([{ value: 'c@x.example.com', score: 60 }]).value, 'c@x.example.com');
});

/* ------------------------- engine behavior ------------------------- */

for (const fx of fixtures) {
  test(`${fx.id} ${fx.name}`, async () => {
    const result = await enrichContactLeads({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      client: stubClientFor(fx),
      now: fx.now,
      runId: fx.runId,
    });

    assert.deepEqual(result.stats, fx.expected.stats, 'stats');
    assert.equal(result.provider, fx.provider || 'agentdata', 'provider label');
    assert.equal(result.enriched.length, fx.expected.enriched.length, 'enriched length');
    assert.equal(result.skipped.length, fx.expected.skipped.length, 'skipped length');
    assert.equal(result.failed.length, fx.expected.failed.length, 'failed length');

    for (const expected of fx.expected.enriched) {
      const row = result.enriched.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing enriched row ${expected.lead_id}`);
      for (const key of ['email', 'contact_name', 'contact_title', 'email_verified', 'email_source', 'contact_source_provider']) {
        if (key in expected) {
          assert.equal(row[key], expected[key], `${expected.lead_id} ${key}`);
        }
      }
    }

    for (const expected of fx.expected.skipped) {
      const row = result.skipped.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing skipped row ${expected.lead_id}`);
      assert.equal(row.enrichment_skip_reason, expected.enrichment_skip_reason, `${expected.lead_id} skip reason`);
    }

    for (const expected of fx.expected.failed) {
      const row = result.failed.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing failed row ${expected.lead_id}`);
      assert.equal(row.enrichment_failure_reason, expected.enrichment_failure_reason, `${expected.lead_id} failure reason`);
    }

    if (fx.expected.fatal) {
      assert.deepEqual(result.fatal, fx.expected.fatal, 'fatal');
    } else {
      assert.equal('fatal' in result, false, 'fatal must be absent');
    }

    assert.deepEqual(
      result.log.map((row) => canonicalLogRow(row)),
      fx.expected.log.map((row) => canonicalLogRow(row)),
      'log rows',
    );
  });
}

function canonicalLogRow(row) {
  const out = {};
  for (const key of [
    'enrichment_id',
    'enrichment_key',
    'lead_id',
    'provider',
    'query_input',
    'result_email',
    'result_contact_name',
    'result_contact_title',
    'result_verified',
    'credits_consumed',
    'enriched_at',
    'ttl_expires_at',
    'cache_hit_count',
    'notes',
  ]) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

test('enriched, skipped and failed are sorted by lead_id ascending', async () => {
  for (const fx of fixtures) {
    const result = await enrichContactLeads({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      client: stubClientFor(fx),
      now: fx.now,
    });
    for (const list of [result.enriched, result.skipped, result.failed]) {
      for (let i = 1; i < list.length; i += 1) {
        assert.ok(list[i - 1].lead_id <= list[i].lead_id, `${fx.id}: ${list[i].lead_id} out of order`);
      }
    }
  }
});

test('engine preserves unknown lead columns (raw sheet passthrough)', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-007');
  const lead = Object.assign({}, fx.leads[0], { custom_field: 'keep-me' });
  const result = await enrichContactLeads({
    leads: [lead],
    logRows: [],
    client: stubClientFor(fx),
    now: fx.now,
  });
  assert.equal(result.enriched[0].custom_field, 'keep-me');
});

test('engine is deterministic: repeated runs produce identical output', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-007');
  const options = { leads: fx.leads, logRows: [], client: stubClientFor(fx), now: fx.now, runId: fx.runId };
  const a = await enrichContactLeads(options);
  const b = await enrichContactLeads(options);
  assert.deepEqual(a, b);
});

test('empty leads produce zero stats safely', async () => {
  const result = await enrichContactLeads({ leads: [], logRows: [], client: stubClientFor({}), now: '2026-09-16T12:00:00.000Z' });
  assert.deepEqual(result.stats, { total: 0, enriched: 0, skipped: 0, failed: 0, credits_consumed: 0, cache_hits: 0 });
  assert.deepEqual(result.enriched, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.log, []);
});

test('engine without a client marks the batch fatal and fails every lead', async () => {
  const result = await enrichContactLeads({
    leads: [{ lead_id: 'RWL-X-1', website: 'x.example.com', country: 'USA' }],
    logRows: [],
    client: null,
    now: '2026-09-16T12:00:00.000Z',
  });
  assert.deepEqual(result.fatal, { reason: 'no_client_configured', status: null });
  assert.equal(result.failed[0].enrichment_failure_reason, 'no_client_configured');
  assert.equal(result.stats.failed, 1);
});

test('an explicit provider option overrides the client-provider default for keys and labels', async () => {
  const client = {
    provider: 'hunter',
    domainSearch: async () => ({
      emails: [
        { email: 'override@over.example.com', confidence: 96, verification_status: 'valid', first_name: 'O', last_name: 'Ve', position: '' },
      ],
      source: 'hunter',
      creditsUsed: 1,
    }),
  };
  const result = await enrichContactLeads({
    leads: [{ lead_id: 'RWL-OV-1', website: 'over.example.com', country: 'USA', email: '' }],
    logRows: [],
    client,
    provider: 'agentdata',
    now: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.provider, 'agentdata');
  assert.equal(result.enriched[0].contact_source_provider, 'agentdata');
  assert.equal(result.enriched[0].email_source, 'agentdata');
  assert.equal(result.log[0].enrichment_key, 'over.example.com::agentdata');
});

/* ------------------------- embedded parity ------------------------- */

test('embedded Enrich Contact source evaluates to the module output on every fixture', async () => {
  for (const fx of fixtures) {
    const moduleOut = await enrichContactLeads({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      client: stubClientFor(fx),
      now: fx.now,
      runId: fx.runId,
    });

    const refs = { 'Read Contact Enrichment Log': (fx.cacheRows || []).map((json) => ({ json })) };
    const items = fx.leads.map((json) => ({ json: Object.assign({}, json) }));
    if (items[0]) {
      items[0].json.now = fx.now;
      items[0].json.runId = fx.runId;
      items[0].json.provider = fx.provider || 'agentdata';
      Object.assign(items[0].json, seamsOf(fx));
    }
    const $input = { all: () => items };
    const $ = (name) => ({ all: () => refs[name] || [] });
    const body = '"use strict";\nreturn (async function () {\n' + embeddedContactSource + '\n})();';
    const fn = new Function('$input', '$json', '$', body);
    const out = await fn($input, {}, $);
    assert.equal(out.length, 1, `${fx.id}: exactly one output item`);
    const embedded = out[0].json;

    const seamKeys = ['now', 'runId', 'provider', 'agentdataResults', 'agentdataFailures', 'hunterResults', 'hunterFailures'];
    assert.deepEqual(scrub(embedded.enriched, seamKeys), scrub(moduleOut.enriched, seamKeys), `${fx.id}: enriched parity`);
    assert.deepEqual(scrub(embedded.skipped, seamKeys), scrub(moduleOut.skipped, seamKeys), `${fx.id}: skipped parity`);
    assert.deepEqual(scrub(embedded.failed, seamKeys), scrub(moduleOut.failed, seamKeys), `${fx.id}: failed parity`);
    assert.deepEqual(embedded.stats, moduleOut.stats, `${fx.id}: stats parity`);
    assert.deepEqual(embedded.log, moduleOut.log, `${fx.id}: log parity`);
    assert.equal(embedded.provider, moduleOut.provider, `${fx.id}: provider parity`);
    if (moduleOut.fatal) {
      assert.deepEqual(embedded.fatal, moduleOut.fatal, `${fx.id}: fatal parity`);
    } else {
      assert.equal('fatal' in embedded, false, `${fx.id}: fatal absent`);
    }
  }
});

function scrub(rows, keys) {
  return (rows || []).map((row) => {
    const out = Object.assign({}, row);
    for (const key of keys) delete out[key];
    return out;
  });
}

/*
 * Build the provider-aware seam maps an input item carries for the embedded
 * mirror: hunter fixtures hand over hunterResults/hunterFailures, anything else
 * agentdataResults/agentdataFailures — keyed by domain, preserving fatal vs
 * deferred semantics exactly as the stub client delivers them to the engine.
 */
function seamsOf(fx) {
  const provider = fx.provider || 'agentdata';
  const results = {};
  const failures = {};
  for (const [domain, entry] of Object.entries(fx.domainResults || {})) {
    if (entry.fatal === true || entry.error === true) {
      failures[domain] = {
        fatal: entry.fatal === true,
        reason: entry.reason || '',
        status: entry.status === undefined || entry.status === null ? null : entry.status,
      };
    } else {
      results[domain] = {
        emails: entry.emails || [],
        source: entry.source || provider,
        creditsUsed: entry.creditsUsed === undefined || entry.creditsUsed === null ? 0 : entry.creditsUsed,
      };
    }
  }
  if (provider === 'hunter') {
    return { hunterResults: results, hunterFailures: failures };
  }
  return { agentdataResults: results, agentdataFailures: failures };
}

test('embedded Enrich Contact source is self-contained (no requires, no transport, no env)', () => {
  const banned = [/\brequire\s*\(/, /process\.env/, /Date\.now/, /Math\.random/, /https?:\/\//];
  for (const re of banned) {
    assert.equal(re.test(embeddedContactSource), false, `banned token ${re}`);
  }
});

test('embedded Enrich Contact source defaults to agentdata when the payload carries no provider', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-007');
  const refs = { 'Read Contact Enrichment Log': [] };
  const items = fx.leads.map((json) => ({ json: Object.assign({}, json) }));
  items[0].json.now = fx.now;
  items[0].json.runId = fx.runId;
  const $input = { all: () => items };
  const $ = (name) => ({ all: () => refs[name] || [] });
  const body = '"use strict";\nreturn (async function () {\n' + embeddedContactSource + '\n})();';
  const fn = new Function('$input', '$json', '$', body);
  const out = await fn($input, {}, $);
  assert.equal(out[0].json.provider, 'agentdata', 'provider defaults to agentdata');
  assert.equal(out[0].json.enriched.length, 1);
  assert.equal(out[0].json.enriched[0].contact_source_provider, 'agentdata');
  assert.equal(out[0].json.enriched[0].email, '', 'no agentdata seam entries for 007 domain -> empty result');
});