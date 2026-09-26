'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fnv1a32,
  enrichmentIdFor,
  ttlExpiresAt,
  sortLogRows,
  lookupCache,
  upsertCache,
  incrementCacheHit,
} = require('../src/enrichment-cache');

const NOW = '2026-09-16T12:00:00.000Z';
const AFTER = '2026-11-15T12:00:00.000Z';

function logRow(overrides) {
  return Object.assign(
    {
      enrichment_id: 'ENRICH-00000000',
      enrichment_key: 'example.com::hunter',
      lead_id: 'RWL-0001',
      provider: 'hunter',
      query_input: 'example.com',
      result_email: 'owner@example.com',
      result_contact_name: 'Ada Owner',
      result_contact_title: 'Owner',
      result_verified: 'TRUE',
      credits_consumed: '1',
      enriched_at: NOW,
      ttl_expires_at: AFTER,
      cache_hit_count: '0',
      notes: '',
    },
    overrides,
  );
}

/* ------------------------- fnv1a32 ------------------------- */

test('fnv1a32: empty string yields the FNV-1a offset basis', () => {
  assert.equal(fnv1a32(''), 0x811c9dc5 >>> 0);
});

test('fnv1a32: deterministic and distinct across inputs', () => {
  assert.equal(fnv1a32('example.com::hunter'), fnv1a32('example.com::hunter'));
  assert.notEqual(fnv1a32('sample.com::hunter'), fnv1a32('example.com::hunter'));
  assert.equal(fnv1a32('lead'), fnv1a32('lead'));
});

test('fnv1a32: wraps a 32-bit unsigned value', () => {
  const value = fnv1a32('a fairly long input string '.repeat(40));
  assert.ok(value >= 0);
  assert.ok(value <= 0xffffffff);
});

/* ------------------------- enrichmentIdFor ------------------------- */

test('enrichmentIdFor: ENRICH- + 8 hex, deterministic per key+time', () => {
  const id = enrichmentIdFor('example.com::hunter', NOW);
  assert.match(id, /^ENRICH-[0-9a-f]{8}$/);
  assert.equal(id, enrichmentIdFor('example.com::hunter', NOW));
  assert.notEqual(
    enrichmentIdFor('example.com::hunter', NOW),
    enrichmentIdFor('example.com::hunter', '2026-09-16T13:00:00.000Z'),
  );
  const digest = fnv1a32('example.com::hunter::2026-09-16T12:00:00.000Z');
  assert.equal(id, `ENRICH-${digest.toString(16).padStart(8, '0')}`);
});

/* ------------------------- ttlExpiresAt ------------------------- */

test('ttlExpiresAt: default 60-day TTL is a pure function of enriched_at', () => {
  assert.equal(ttlExpiresAt(NOW), AFTER);
  assert.equal(ttlExpiresAt(NOW, 60), AFTER);
  assert.equal(ttlExpiresAt('2026-09-16T12:00:00.000Z'), ttlExpiresAt(NOW));
});

test('ttlExpiresAt: custom TTL honored', () => {
  assert.equal(ttlExpiresAt(NOW, 1), '2026-09-17T12:00:00.000Z');
});

test('ttlExpiresAt: rejects invalid inputs', () => {
  assert.throws(() => ttlExpiresAt('not-a-date', 60), /invalid ttl input/);
  assert.throws(() => ttlExpiresAt(NOW, 0), /invalid ttl input/);
});

/* ------------------------- sortLogRows ------------------------- */

test('sortLogRows: deterministic (enrichment_key, enriched_at, lead_id)', () => {
  const a = logRow({ enrichment_key: 'a.com::hunter', enriched_at: NOW, lead_id: '1' });
  const b = logRow({ enrichment_key: 'b.com::hunter', enriched_at: NOW, lead_id: '1' });
  const c = logRow({ enrichment_key: 'a.com::hunter', enriched_at: '2026-09-17T00:00:00.000Z', lead_id: '1' });
  const d = logRow({ enrichment_key: 'a.com::hunter', enriched_at: NOW, lead_id: '2' });
  const sorted = sortLogRows([d, c, b, a]);
  assert.deepEqual(sorted, [a, d, c, b]);
});

/* ------------------------- lookupCache ------------------------- */

test('lookupCache: hit within TTL returns the row', () => {
  const rows = [logRow()];
  const hit = lookupCache(rows, 'example.com::hunter', { now: '2026-10-01T00:00:00.000Z' });
  assert.equal(hit.enrichment_key, 'example.com::hunter');
});

test('lookupCache: expired row is a miss', () => {
  const rows = [logRow({ ttl_expires_at: '2026-09-01T00:00:00.000Z' })];
  const hit = lookupCache(rows, 'example.com::hunter', { now: NOW });
  assert.equal(hit, null);
});

test('lookupCache: unknown key and empty log are misses', () => {
  assert.equal(lookupCache([], 'example.com::hunter', { now: NOW }), null);
  assert.equal(lookupCache([logRow()], 'other.com::hunter', { now: NOW }), null);
});

test('lookupCache: lenient mode (no now) returns the first matching row', () => {
  const rows = [logRow()];
  assert.equal(lookupCache(rows, 'example.com::hunter'), rows[0]);
  assert.equal(lookupCache(rows, 'other.com::hunter'), null);
});

/* ------------------------- upsertCache ------------------------- */

test('upsertCache: appends a new key and keeps deterministic order', () => {
  const a = logRow();
  const b = logRow({ enrichment_key: 'b.com::hunter' });
  const next = upsertCache([a], b);
  assert.deepEqual(next, sortLogRows([a, b]));
  assert.equal(next.length, 2);
});

test('upsertCache: replaces an existing key instead of duplicating', () => {
  const a = logRow({ cache_hit_count: '1' });
  const replacement = logRow({ cache_hit_count: '0', result_email: 'new@example.com' });
  const next = upsertCache([a], replacement);
  assert.equal(next.length, 1);
  assert.equal(next[0].result_email, 'new@example.com');
  assert.deepEqual(next, sortLogRows([replacement]));
});

/* ------------------------- incrementCacheHit ------------------------- */

test('incrementCacheHit: bumps cache_hit_count on the matching row only', () => {
  const a = logRow({ enrichment_key: 'a.com::hunter', cache_hit_count: '2' });
  const b = logRow({ enrichment_key: 'b.com::hunter', cache_hit_count: '5' });
  const next = incrementCacheHit([a, b], a);
  const rowA = next.find((r) => r.enrichment_key === 'a.com::hunter');
  const rowB = next.find((r) => r.enrichment_key === 'b.com::hunter');
  assert.equal(rowA.cache_hit_count, '3');
  assert.equal(rowB.cache_hit_count, '5');
  assert.equal(next.length, 2);
});

test('incrementCacheHit: starts from 1 on missing count', () => {
  const a = logRow({ cache_hit_count: '' });
  const next = incrementCacheHit([a], a);
  assert.equal(next[0].cache_hit_count, '1');
});

test('incrementCacheHit: unknown key leaves the log untouched', () => {
  const a = logRow();
  const next = incrementCacheHit([a], { enrichment_key: 'missing.com::hunter' });
  assert.equal(next[0].cache_hit_count, '0');
});