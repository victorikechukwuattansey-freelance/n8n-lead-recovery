'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENRICHMENT_LOG_COLUMNS,
  PROVIDERS,
  ENRICHMENT_ID_PREFIX,
  DEFAULT_TTL_DAYS,
  GENERIC_EMAIL_PATTERNS,
  HUNTER_MIN_SCORE,
  US_COUNTRIES,
  normalize,
  isGenericEmail,
  isUsCountry,
} = require('../src/enrichment-schema');

test('enrichment log contract: exactly 14 columns A–N in order', () => {
  assert.equal(ENRICHMENT_LOG_COLUMNS.length, 14);
  assert.deepEqual(ENRICHMENT_LOG_COLUMNS, [
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
  ]);
});

test('providers vocabulary is closed and includes hunter/oss/manual', () => {
  assert.deepEqual(PROVIDERS, ['hunter', 'oss', 'manual']);
});

test('id prefix and default TTL constants', () => {
  assert.equal(ENRICHMENT_ID_PREFIX, 'ENRICH-');
  assert.equal(DEFAULT_TTL_DAYS, 60);
});

test('hunter acceptance threshold constant', () => {
  assert.equal(HUNTER_MIN_SCORE, 50);
});

test('generic email patterns cover the standard boilerplate set', () => {
  for (const pattern of ['info', 'contact', 'sales', 'support', 'admin', 'hello']) {
    assert.ok(GENERIC_EMAIL_PATTERNS.has(pattern), `missing generic pattern ${pattern}`);
  }
  assert.ok(isGenericEmail('info'));
  assert.ok(isGenericEmail(' contact '));
  assert.ok(isGenericEmail('OFFICE'));
  assert.ok(!isGenericEmail('ada'));
  assert.ok(!isGenericEmail('derrick'));
});

test('US country filter matches the stored vocabulary', () => {
  for (const value of ['USA', 'US', 'United States']) {
    assert.ok(isUsCountry(value), `expected ${value} to be US`);
  }
  assert.ok(!isUsCountry('Mexico'));
  assert.ok(!isUsCountry(''));
  assert.ok(US_COUNTRIES.has('USA'));
});

test('normalize trims and null-coalesces', () => {
  assert.equal(normalize('  hi  '), 'hi');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(''), '');
});