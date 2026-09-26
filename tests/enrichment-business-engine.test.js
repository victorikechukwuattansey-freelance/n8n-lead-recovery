'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichBusinessLeads,
  normalizePhone,
  normalizeDomain,
  normalizeName,
  operatingStatusOf,
  levenshtein,
} = require('../src/enrichment-business');
const { loadEnrichmentFixtures } = require('../fixtures/enrichment-fixtures.js');

const fixtures = loadEnrichmentFixtures();

function stripLead(row) {
  const out = {};
  for (const key of [
    'lead_id',
    'business_name',
    'city',
    'state',
    'country',
    'website',
    'phone',
    'enrichment_business_status',
    'enrichment_confidence',
    'enrichment_gers_id',
    'enrichment_last_run',
  ]) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

/* ------------------------- helper units ------------------------- */

test('normalizePhone: digits-only with 11-digit leading-1 collapse', () => {
  assert.equal(normalizePhone('(210) 555-0131'), '2105550131');
  assert.equal(normalizePhone('+1 210 555 0131'), '2105550131');
  assert.equal(normalizePhone('2105550131'), '2105550131');
  assert.equal(normalizePhone(''), '');
});

test('normalizeDomain: scheme, www, path and query stripped, lowercase', () => {
  assert.equal(normalizeDomain('https://AlamoAir.example.com/contact'), 'alamoair.example.com');
  assert.equal(normalizeDomain('WWW.greattexashvac.example.com'), 'greattexashvac.example.com');
  assert.equal(normalizeDomain('alamoair.example.com?x=1'), 'alamoair.example.com');
  assert.equal(normalizeDomain(''), '');
});

test('operatingStatusOf: maps Overture vocabulary to open|closed|empty', () => {
  assert.equal(operatingStatusOf('operating'), 'open');
  assert.equal(operatingStatusOf('closed'), 'closed');
  assert.equal(operatingStatusOf('permanently closed'), 'closed');
  assert.equal(operatingStatusOf(''), '');
  assert.equal(operatingStatusOf(null), '');
});

test('levenshtein: classic edit distance with fuzzy threshold', () => {
  assert.equal(levenshtein('old town cooling', 'old town cooling — closed'), 9);
  assert.equal(levenshtein('old town coolng', 'old town cooling'), 1);
  assert.equal(levenshtein('abc', 'abc'), 0);
});

/* ------------------------- engine behavior ------------------------- */

for (const fx of fixtures) {
  test(`${fx.id} ${fx.name}`, () => {
    const result = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now, runId: fx.runId });
    assert.deepEqual(result.stats, fx.expected.stats, 'stats');

    assert.equal(result.enriched.length, fx.expected.enriched.length, 'enriched length');
    for (const expected of fx.expected.enriched) {
      const row = result.enriched.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing enriched row ${expected.lead_id}`);
      assert.equal(row.enrichment_gers_id, expected.enrichment_gers_id, `${expected.lead_id} gers_id`);
      assert.equal(row.enrichment_confidence, expected.enrichment_confidence, `${expected.lead_id} confidence`);
      assert.equal(row.enrichment_business_status, expected.enrichment_business_status, `${expected.lead_id} status`);
      assert.equal(row.enrichment_last_run, fx.now, `${expected.lead_id} last_run`);
      if ('website' in expected) assert.equal(row.website, expected.website, `${expected.lead_id} website`);
      if ('phone' in expected) assert.equal(row.phone, expected.phone, `${expected.lead_id} phone`);
    }

    assert.equal(result.unmatched.length, fx.expected.unmatched.length, 'unmatched length');
    for (const expected of fx.expected.unmatched) {
      const row = result.unmatched.find((r) => r.lead_id === expected.lead_id);
      assert.ok(row, `missing unmatched row ${expected.lead_id}`);
      assert.equal(row.enrichment_gers_id, expected.enrichment_gers_id, `${expected.lead_id} gers_id`);
      assert.equal(row.enrichment_confidence, expected.enrichment_confidence, `${expected.lead_id} confidence`);
      assert.equal(row.enrichment_business_status, expected.enrichment_business_status, `${expected.lead_id} status`);
      assert.equal(row.enrichment_last_run, fx.now, `${expected.lead_id} last_run`);
    }
  });
}

test('enriched and unmatched are sorted by lead_id ascending', () => {
  for (const fx of fixtures) {
    const result = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now });
    for (const list of [result.enriched, result.unmatched]) {
      for (let i = 1; i < list.length; i += 1) {
        assert.ok(list[i - 1].lead_id <= list[i].lead_id, `${fx.id}: ${list[i].lead_id} out of order`);
      }
    }
  }
});

test('engine never clobbers provider data (pre-filled values stable on matched leads)', () => {
  for (const fx of fixtures) {
    const result = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now });
    for (const row of result.enriched) {
      const input = fx.leads.find((l) => l.lead_id === row.lead_id);
      assert.ok(input, `matched row must trace to a lead: ${row.lead_id}`);
      if (String(input.website || '').trim() !== '') {
        assert.equal(row.website, input.website, `${row.lead_id} website must stay untouched when populated`);
      }
      if (String(input.phone || '').trim() !== '') {
        assert.equal(row.phone, input.phone, `${row.lead_id} phone must stay untouched when populated`);
      }
    }
  }
});

test('engine is deterministic: repeated runs produce identical output', () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-006');
  const a = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now, runId: fx.runId });
  const b = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now, runId: fx.runId });
  assert.deepEqual(a, b);
});

test('engine preserves unknown lead columns (raw sheet passthrough)', () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-001');
  const lead = Object.assign({}, fx.leads[0], { custom_field: 'keep-me' });
  const result = enrichBusinessLeads({ leads: [lead], index: fx.index, now: fx.now });
  assert.equal(result.enriched[0].custom_field, 'keep-me');
  assert.equal(JSON.stringify(result.unmatched), '[]');
});

test('empty leads and empty index produce zero stats safely', () => {
  const emptyIndex = enrichBusinessLeads({ leads: [], index: fxIndex(), now: '2026-09-16T12:00:00.000Z' });
  assert.deepEqual(emptyIndex.stats, {
    total: 0,
    matched: 0,
    unmatched: 0,
    filled_website: 0,
    filled_phone: 0,
    filled_operating_status: 0,
    closed_businesses_flagged: 0,
  });
  assert.deepEqual(emptyIndex.enriched, []);
  assert.deepEqual(emptyIndex.unmatched, []);

  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-001');
  const emptyLeads = enrichBusinessLeads({ leads: [], index: fx.index, now: fx.now });
  assert.equal(emptyLeads.stats.total, 0);
  assert.deepEqual(emptyLeads.enriched, []);
  assert.deepEqual(emptyLeads.unmatched, []);
});

function fxIndex(fx) {
  return fx && fx.index ? fx.index : [];
}

test('website fill is only applied when the target website is empty', () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-006');
  const row = enrichBusinessLeads({ leads: fx.leads, index: fx.index, now: fx.now }).enriched.find(
    (r) => r.lead_id === 'RWL-0006-B',
  );
  assert.equal(row.website, 'old-provider-value.example.com', 'pre-filled website must not be replaced');
});