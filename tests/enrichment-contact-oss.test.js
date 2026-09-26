'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichContactOss,
  markManualBlock,
  applyOssFields,
  noteFor,
  PROVIDER_OSS,
  PROVIDER_MANUAL,
  OSS_NO_RESULTS,
} = require('../src/enrichment-contact-oss');
const { embeddedContactOssSource } = require('../src/embedded-enrichment-contact-oss');
const { loadEnrichmentFixtures, CONTACT_FIXTURES_PATH } = require('../fixtures/enrichment-fixtures.js');

const fixtures = loadEnrichmentFixtures(CONTACT_FIXTURES_PATH)
  .filter((f) => f.expected && f.expected.oss)
  .map((f) => Object.assign({}, f, { expected: f.expected.oss }));

function resolverFor(fx) {
  return async (domain) => (fx.ossResults || {})[domain] || {};
}

/* ------------------------- helper units ------------------------- */

test('applyOssFields: fills empty contact columns and stamps provider oss', () => {
  const out = applyOssFields(
    { lead_id: 'RWL-X-1', email: '', contact_name: '' },
    { email: 'a@x.example.com', contact_name: 'Ada', contact_title: 'CEO', email_verified: 'Y', email_source: 'oss' },
  );
  assert.equal(out.email, 'a@x.example.com');
  assert.equal(out.contact_name, 'Ada');
  assert.equal(out.contact_title, 'CEO');
  assert.equal(out.email_verified, 'Y');
  assert.equal(out.email_source, 'oss');
  assert.equal(out.contact_source_provider, PROVIDER_OSS);
});

test('applyOssFields: never overwrites an existing non-empty column', () => {
  const out = applyOssFields(
    { lead_id: 'RWL-X-1', email: 'keep@x.example.com', contact_name: 'Keep Me' },
    { email: 'replace@x.example.com', contact_name: 'Nope' },
  );
  assert.equal(out.email, 'keep@x.example.com');
  assert.equal(out.contact_name, 'Keep Me');
});

test('markManualBlock: stamps blocked/provider manual and appends the note', () => {
  const out = markManualBlock({ lead_id: 'RWL-X-1', notes: 'existing note' }, { notes: 'operator decision' });
  assert.equal(out.contact_blocked, 'TRUE');
  assert.equal(out.contact_source_provider, PROVIDER_MANUAL);
  assert.equal(out.notes, 'existing note | operator decision');
});

test('markManualBlock: survives empty or missing options', () => {
  const out = markManualBlock({ lead_id: 'RWL-X-1' }, {});
  assert.equal(out.contact_blocked, 'TRUE');
  assert.equal(out.contact_source_provider, PROVIDER_MANUAL);
  assert.equal(out.notes, '');
});

test('noteFor: empty results detail why no email was accepted', () => {
  assert.equal(noteFor([], null), 'no_emails_found');
  assert.equal(noteFor([{ value: 'a@x.example.com' }], null), 'no_accepted_email');
  assert.equal(noteFor([{ value: 'a@x.example.com' }], { value: 'b@x.example.com' }), '');
});

/* ------------------------- engine behavior ------------------------- */

for (const fx of fixtures) {
  test(`${fx.id} ${fx.name}`, async () => {
    const result = await enrichContactOss({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      resolver: resolverFor(fx),
      now: fx.now,
      runId: fx.runId,
    });

    assert.deepEqual(result.stats, fx.expected.stats, 'stats');
    assert.equal(result.enriched.length, fx.expected.enriched.length, 'enriched length');
    assert.equal(result.skipped.length, fx.expected.skipped.length, 'skipped length');
    assert.equal(result.failed.length, fx.expected.failed.length, 'failed length');

    for (const expected of fx.expected.enriched) {
      const row = result.enriched.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing enriched row ${expected.lead_id}`);
      for (const key of [
        'email',
        'contact_name',
        'contact_title',
        'email_verified',
        'email_source',
        'contact_source_provider',
        'contact_blocked',
        'notes',
        'enrichment_fallback',
      ]) {
        if (key in expected) {
          assert.equal(row[key], expected[key], `${expected.lead_id} ${key}`);
        }
      }
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

test('OSS engine reuses an eligible gate: skips non-US / no-domain / already-email leads', async () => {
  const leads = [
    { lead_id: 'RWL-O-1', website: 'toronto.example.com', country: 'Canada', email: '' },
    { lead_id: 'RWL-O-2', website: '', country: 'USA', email: '' },
    { lead_id: 'RWL-O-3', website: 'hasemail.example.com', country: 'USA', email: 'a@b.example.com' },
  ];
  const result = await enrichContactOss({ leads, logRows: [], resolver: resolverFor({}), now: '2026-09-16T12:00:00.000Z' });
  assert.deepEqual(
    result.skipped.map((r) => [r.lead_id, r.enrichment_skip_reason]),
    [
      ['RWL-O-1', 'non_us'],
      ['RWL-O-2', 'no_domain'],
      ['RWL-O-3', 'already_enriched'],
    ],
  );
  assert.equal(result.stats.skipped, 3);
  assert.equal(result.stats.total, 3);
});

test('OSS engine without a resolver fails every eligible lead (no provider absence silently)', async () => {
  const result = await enrichContactOss({
    leads: [{ lead_id: 'RWL-O-1', website: 'x.example.com', country: 'USA', email: '' }],
    logRows: [],
    resolver: null,
    now: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.failed[0].enrichment_failure_reason, 'oss_no_resolver_configured');
  assert.equal(result.stats.failed, 1);
  assert.equal(result.stats.enriched, 0);
});

test('OSS engine serves a non-expired domain::oss cache row at zero credit', async () => {
  const leads = [{ lead_id: 'RWL-O-1', website: 'cacheoss.example.com', country: 'USA', email: '' }];
  const cacheRows = [
    {
      enrichment_id: 'ENRICH-cacheosssample',
      enrichment_key: 'cacheoss.example.com::oss',
      lead_id: 'RWL-O-1',
      provider: 'oss',
      query_input: 'cacheoss.example.com',
      result_email: 'founder@cacheoss.example.com',
      result_contact_name: 'Pat Reyes',
      result_contact_title: 'Founder',
      result_verified: 'TRUE',
      credits_consumed: '',
      enriched_at: '2026-09-01T10:00:00.000Z',
      ttl_expires_at: '2026-11-01T10:00:00.000Z',
      cache_hit_count: '4',
      notes: '',
    },
  ];
  let resolverCalls = 0;
  const result = await enrichContactOss({
    leads,
    logRows: cacheRows,
    resolver: async () => {
      resolverCalls += 1;
      return {};
    },
    now: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(resolverCalls, 0, 'resolver must not run on a cache hit');
  assert.equal(result.stats.cache_hits, 1);
  assert.equal(result.stats.credits_consumed, 0);
  assert.equal(result.enriched[0].email, 'founder@cacheoss.example.com');
  assert.equal(result.enriched[0].email_source, 'oss');
  assert.equal(result.log[0].cache_hit_count, '5');
});

test('OSS resolver throw is contained: the lead stays enriched with an empty-result log row', async () => {
  const result = await enrichContactOss({
    leads: [{ lead_id: 'RWL-O-1', website: 'throw.example.com', country: 'USA', email: '' }],
    logRows: [],
    resolver: async () => {
      throw new Error('boom');
    },
    now: '2026-09-16T12:00:00.000Z',
  });
  assert.equal(result.stats.failed, 0);
  assert.equal(result.stats.enriched, 1);
  assert.equal(result.enriched[0].email, '');
  assert.equal(result.log[0].notes, 'no_emails_found');
});

test('OSS engine is deterministic across runs', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-013');
  const options = { leads: fx.leads, logRows: [], resolver: resolverFor(fx), now: fx.now, runId: fx.runId };
  const a = await enrichContactOss(options);
  const b = await enrichContactOss(options);
  assert.deepEqual(a, b);
});

test('empty leads produce zero OSS stats safely', async () => {
  const result = await enrichContactOss({ leads: [], logRows: [], resolver: resolverFor({}), now: '2026-09-16T12:00:00.000Z' });
  assert.deepEqual(result.stats, { total: 0, enriched: 0, skipped: 0, failed: 0, credits_consumed: 0, cache_hits: 0 });
  assert.deepEqual(result.log, []);
});

/* ------------------------- embedded parity ------------------------- */

test('embedded Enrich Contact (OSS) source evaluates to the module output on every fixture', async () => {
  for (const fx of fixtures) {
    const moduleOut = await enrichContactOss({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      resolver: resolverFor(fx),
      now: fx.now,
      runId: fx.runId,
    });

    const refs = { 'Read Contact Enrichment Log': (fx.cacheRows || []).map((json) => ({ json })) };
    const items = fx.leads.map((json) => ({ json: Object.assign({}, json) }));
    if (items[0]) {
      items[0].json.now = fx.now;
      items[0].json.runId = fx.runId;
      items[0].json.ossResults = fx.ossResults || {};
    }
    const $input = { all: () => items };
    const $ = (name) => ({ all: () => refs[name] || [] });
    const body = '"use strict";\nreturn (async function () {\n' + embeddedContactOssSource + '\n})();';
    const fn = new Function('$input', '$json', '$', body);
    const out = await fn($input, {}, $);
    assert.equal(out.length, 1, `${fx.id}: exactly one output item`);
    const embedded = out[0].json;

    const seamKeys = ['now', 'runId', 'ossResults'];
    assert.deepEqual(scrub(embedded.enriched, seamKeys), scrub(moduleOut.enriched, seamKeys), `${fx.id}: enriched parity`);
    assert.deepEqual(scrub(embedded.skipped, seamKeys), scrub(moduleOut.skipped, seamKeys), `${fx.id}: skipped parity`);
    assert.deepEqual(scrub(embedded.failed, seamKeys), scrub(moduleOut.failed, seamKeys), `${fx.id}: failed parity`);
    assert.deepEqual(embedded.stats, moduleOut.stats, `${fx.id}: stats parity`);
    assert.deepEqual(embedded.log, moduleOut.log, `${fx.id}: log parity`);
  }
});

function scrub(rows, keys) {
  return (rows || []).map((row) => {
    const out = Object.assign({}, row);
    for (const key of keys) delete out[key];
    return out;
  });
}

test('embedded Enrich Contact (OSS) source is self-contained (no requires, no transport)', () => {
  const banned = [/\brequire\s*\(/, /process\.env/, /Date\.now/, /Math\.random/, /https?:\/\//];
  for (const re of banned) {
    assert.equal(re.test(embeddedContactOssSource), false, `banned token ${re}`);
  }
});