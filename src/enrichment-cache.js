'use strict';

/*
 * Contact Enrichment V1 cache primitives (Prompt H.3).
 *
 * The Contact Enrichment Log tab is the sheet-backed cache. Rows are durable
 * (never trusted to in-memory state between runs): every run re-reads the log,
 * consults it before any provider call, appends new rows, and write-backs hit
 * counts. All identifiers must therefore be deterministic — a re-run of the
 * same input must reproduce the same enrichment_id, TTL and ordering with zero
 * dependence on Date.now()/Math.random().
 *
 * Primitives:
 *   - enrichmentIdFor(enrichmentKey, enrichedAt) → ENRICH-<8-hex> via FNV-1a32
 *   - ttlExpiresAt(enrichedAt, ttlDays)          → enriched_at + TTL (ISO)
 *   - lookupCache(rows, key, { now })            → first non-expired row for a
 *     key (cache hit) or null (miss). A row is a hit only when its
 *     ttl_expires_at is strictly after `now`. When `now` is omitted the first
 *     matching row is returned (lenient, used by isolated tests).
 *   - upsertCache(entries, entry)                → entries with `entry`
 *     inserted (replace-by-enrichment_key when present), re-sorted.
 *   - incrementCacheHit(logRows, entry)          → logRows with the matching
 *     row's cache_hit_count +1 (write-back), re-sorted.
 *
 * Rows are sorted by (enrichment_key, enriched_at, lead_id) ascending so the
 * append order is a pure function of content. FNV-1a32 is implemented inline
 * (32-bit unsigned wrap via Math.imul + >>>) so no crypto dependency is needed
 * and the same value is reproducible in the embedded copies.
 */

const { ENRICHMENT_ID_PREFIX, DEFAULT_TTL_DAYS } = require('./enrichment-schema');

const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const text = normalize(input);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function enrichmentIdFor(enrichmentKey, enrichedAt) {
  const digest = fnv1a32(`${normalize(enrichmentKey)}::${normalize(enrichedAt)}`);
  return `${ENRICHMENT_ID_PREFIX}${digest.toString(16).padStart(8, '0')}`;
}

function ttlExpiresAt(enrichedAt, ttlDays) {
  const base = Date.parse(normalize(enrichedAt));
  const days = ttlDays === undefined || ttlDays === null ? DEFAULT_TTL_DAYS : Number(ttlDays);
  if (!Number.isFinite(base) || !Number.isFinite(days) || days <= 0) {
    throw new Error(`enrichment-cache: invalid ttl input enriched_at=${enrichedAt} ttlDays=${ttlDays}`);
  }
  return new Date(base + days * DAY_MS).toISOString();
}

function compareStrings(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortLogRows(rows) {
  return rows
    .slice()
    .map((row) => (row && typeof row === 'object' ? row : {}))
    .sort((x, y) => {
      const byKey = compareStrings(x.enrichment_key, y.enrichment_key);
      if (byKey !== 0) return byKey;
      const byAt = compareStrings(x.enriched_at, y.enriched_at);
      if (byAt !== 0) return byAt;
      return compareStrings(x.lead_id, y.lead_id);
    });
}

function lookupCache(rows, key, options) {
  const opts = options || {};
  const target = normalize(key);
  const now = opts.now ? Date.parse(normalize(opts.now)) : 0;
  const strict = opts.now !== undefined && opts.now !== null && opts.now !== '';
  for (const row of rows || []) {
    if (normalize(row && row.enrichment_key) !== target) continue;
    if (!strict) return row;
    const expires = row && row.ttl_expires_at ? Date.parse(normalize(row.ttl_expires_at)) : Number.NaN;
    if (Number.isFinite(now) && Number.isFinite(expires) && expires > now) return row;
  }
  return null;
}

function upsertCache(entries, entry) {
  const target = normalize(entry && entry.enrichment_key);
  const next = [];
  let replaced = false;
  for (const row of entries || []) {
    if (normalize(row && row.enrichment_key) === target) {
      next.push(entry);
      replaced = true;
    } else {
      next.push(row);
    }
  }
  if (!replaced) next.push(entry);
  return sortLogRows(next);
}

function incrementCacheHit(logRows, entry) {
  const target = normalize(entry && entry.enrichment_key);
  let bumped = false;
  const next = (logRows || []).map((row) => {
    if (!bumped && normalize(row && row.enrichment_key) === target) {
      bumped = true;
      const current = Number.parseInt(normalize(row.cache_hit_count), 10);
      return Object.assign({}, row, {
        cache_hit_count: String(Number.isFinite(current) ? current + 1 : 1),
      });
    }
    return row;
  });
  return sortLogRows(next);
}

module.exports = {
  DAY_MS,
  fnv1a32,
  enrichmentIdFor,
  ttlExpiresAt,
  sortLogRows,
  lookupCache,
  upsertCache,
  incrementCacheHit,
  normalize,
};