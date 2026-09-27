'use strict';

/*
 * Column ownership contract (Enrichment V1, H.6 → H.8c):
 *   - Approved Outreach has 24 columns; the handoff workflow owns the FIRST 21
 *     (approval_id … notes) and the enrichment workflow owns the LAST 3
 *     (contact_source_provider, contact_blocked, country). Live-sheet
 *     orientation, H.8b.2/H.8c: V (index 21) = contact_source_provider,
 *     W (index 22) = contact_blocked, X (index 23) = country. Enrichment writes
 *     those via its update node; the handoff append must NEVER write them.
 *   - Verified Leads has 28 columns; the last 4 (enrichment_business_status,
 *     enrichment_confidence, enrichment_gers_id, enrichment_last_run) are the
 *     business-half enrichment write surface and start out empty.
 */

const VERIFIED_COLUMNS = [
  'lead_id',
  'business_name',
  'niche',
  'city',
  'state',
  'country',
  'address',
  'phone',
  'website',
  'rating',
  'review_count',
  'google_maps_url',
  'business_type',
  'source',
  'search_input_id',
  'dedupe_key',
  'has_website',
  'has_phone',
  'target_niche',
  'score',
  'qualification_status',
  'verified_at',
  'notes',
  'manual_review_notes',
  'enrichment_business_status',
  'enrichment_confidence',
  'enrichment_gers_id',
  'enrichment_last_run',
];

const APPROVED_COLUMNS = [
  'approval_id',
  'lead_id',
  'business_name',
  'contact_name',
  'niche',
  'city',
  'state',
  'phone',
  'email',
  'website',
  'verification_source',
  'score',
  'channel',
  'campaign_name',
  'message_variant',
  'approval_stage',
  'approved_by',
  'approved_at',
  'scheduled_date',
  'status',
  'notes',
  'contact_source_provider',
  'contact_blocked',
  'country',
];

const VERIFIED_COLUMN_INDEX = Object.fromEntries(VERIFIED_COLUMNS.map((c, i) => [c, i]));
const APPROVED_COLUMN_INDEX = Object.fromEntries(APPROVED_COLUMNS.map((c, i) => [c, i]));

const VERIFIED_FORMULA_COLUMNS = [
  'has_website',
  'has_phone',
  'target_niche',
  'score',
  'qualification_status',
];

const FORMULA_COLUMN_SET = new Set(VERIFIED_FORMULA_COLUMNS);

const SOURCE_INTEGRITY_FIELDS = [
  'lead_id',
  'business_name',
  'qualification_status',
  'score',
  'dedupe_key',
  'verified_at',
];

const CLEANUP_NAMESPACE = 'TEST-AOH';
const CLEANUP_REGEX = /^TEST-AOH-\d+$/;

const CONTROL_FIELD_NAMES = ['_control', '_noNewApproved'];

function rowToObject(row, columns) {
  const obj = {};
  for (let i = 0; i < columns.length; i += 1) {
    obj[columns[i]] = row[i] === undefined || row[i] === null ? '' : String(row[i]);
  }
  return obj;
}

function objectToRow(obj, columns) {
  return columns.map((c) => (obj[c] === undefined || obj[c] === null ? '' : String(obj[c])));
}

function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isHeaderRow(row) {
  return row[0] === 'lead_id' || row[0] === 'approval_id';
}

function isControlName(name) {
  return CONTROL_FIELD_NAMES.includes(name);
}

/*
 * Email shape check (FINDING-020). Deliberately a pragmatic production
 * heuristic, NOT an RFC 5322 implementation: it requires a non-empty local
 * part, an '@', and a dotted domain, and rejects embedded whitespace. It
 * therefore rejects some technically-valid RFC 5322 addresses (quoted local
 * parts, IP-literal domains, address literals) which do not occur in real
 * home-services lead data, in exchange for being auditable at a glance and
 * free of catastrophic backtracking. Mirrors the shape documented by the
 * major transactional mailers. Syntax only: no MX lookup, no SMTP probe.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isWellFormedEmail(value) {
  return EMAIL_RE.test(normalize(value));
}

module.exports = {
  VERIFIED_COLUMNS,
  APPROVED_COLUMNS,
  VERIFIED_COLUMN_INDEX,
  APPROVED_COLUMN_INDEX,
  VERIFIED_FORMULA_COLUMNS,
  FORMULA_COLUMN_SET,
  SOURCE_INTEGRITY_FIELDS,
  CLEANUP_NAMESPACE,
  CLEANUP_REGEX,
  CONTROL_FIELD_NAMES,
  rowToObject,
  objectToRow,
  normalize,
  isHeaderRow,
  isControlName,
  EMAIL_RE,
  isWellFormedEmail,
};