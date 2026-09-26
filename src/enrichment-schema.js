'use strict';

/*
 * Contact Enrichment V1 shared constants (Prompt H.3).
 *
 * Defines the Contact Enrichment Log column contract (the sheet-backed cache),
 * the provider vocabulary, the TTL policy, and the generic-email patterns that
 * the enrichment engines (business + contact) share. This module is consumed by
 * src/enrichment-cache.js, src/enrichment-contact.js and the embedded mirrors;
 * it is intentionally dependency-free so the embedded copies stay in sync.
 *
 * The Contact Enrichment Log is a NEW tab in the production sheet (decision
 * D-C0). It is the durable cache: reads during a run never consult Hunter for a
 * key that already has a non-expired log row, and a hit increments
 * cache_hit_count (write-back). One row per (enrichment_key, provider) — the
 * cache is keyed by enrichment_key (domain::provider) alone.
 *
 * Columns (A–N, in order):
 *   A enrichment_id        deterministic ENRICH-<fnv1a32-8hex> of the entry
 *   B enrichment_key       domain::provider
 *   C lead_id              source Raw Leads / Approved Outreach lead
 *   D provider             hunter | oss | manual
 *   E query_input          domain queried
 *   F result_email         best email returned ('' when none, manual op may
 *                          record a placeholder decision)
 *   G result_contact_name  best-match contact name ('' when none)
 *   H result_contact_title best-match contact title ('' when none)
 *   I result_verified      'TRUE' | 'FALSE' — Hunter's own verification for
 *                          accepted emails; manual rows set 'FALSE' unless the
 *                          operator verified independently
 *   J credits_consumed     integer credits charged by the provider ('' for 0)
 *   K enriched_at          ISO-8601 timestamp of the enrichment
 *   L ttl_expires_at       enriched_at + DEFAULT_TTL_DAYS (cache validity)
 *   M cache_hit_count      how many times this key was served from cache
 *   N notes                operator notes (OSS fallback / manual decisions)
 */

const ENRICHMENT_LOG_COLUMNS = [
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
];

const PROVIDERS = ['hunter', 'oss', 'manual'];

const ENRICHMENT_ID_PREFIX = 'ENRICH-';

const DEFAULT_TTL_DAYS = 60;

const GENERIC_EMAIL_PATTERNS = new Set([
  'info',
  'contact',
  'sales',
  'support',
  'admin',
  'hello',
  'mail',
  'office',
  'help',
  'service',
  'enquiries',
  'inquiries',
  'bookings',
  'careers',
  'jobs',
  'recruit',
]);

const HUNTER_MIN_SCORE = 50;

const US_COUNTRIES = new Set(['USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA']);

function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isGenericEmail(localPart) {
  return GENERIC_EMAIL_PATTERNS.has(normalize(localPart).toLowerCase());
}

function isUsCountry(value) {
  return US_COUNTRIES.has(normalize(value).toUpperCase());
}

module.exports = {
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
};