'use strict';

/*
 * Open-source contact enrichment engine (Prompt H.5) — zero-credit fallback for
 * Hunter-empty domains, keyed `domain::oss` (provider 'oss'). Mirrors the
 * contact engine (src/enrichment-contact.js) shape so the workflow, fixtures
 * and parity tests stay symmetric:
 *
 * Contract:
 *   inputs  leads[]       Raw/Approved rows (same eligibility gate as contact)
 *           logRows[]     Contact Enrichment Log rows (cache)
 *           resolver      (domain, lead) → { emails:[…] } | null | promise
 *           now / ttlDays / minScore   injected (determinism)
 *   outputs { enriched, skipped, failed, stats, log }
 *           stats  total, enriched, skipped, failed, credits_consumed, cache_hits
 *
 * Provider seam: `resolver` is injected so the tests + fixture VM never touch
 * @absolutejs/enrich / coldreach / theHarvester (host-run, sometimes Python).
 * The resolver returns email candidates shaped like Hunter emails
 * ({value, score, verified, first_name, last_name, position}); the SAME
 * acceptance policy applies (generic local part rejected, score >= minScore).
 * OSS costs zero credits, so credits_consumed stays 0 and log rows carry ''.
 *
 * Fallback semantics (H.5): a resolver 'empty + blocked' envelope
 * ({ emails: [], blocked: true, notes }) stamps the lead via markManualBlock —
 * a deterministic lead-side flag the operator owns (contact_blocked='TRUE',
 * contact_source_provider='manual', notes appended). The engine never blocks
 * on its own: blocking is the resolver's explicit decision.
 *
 * Output bucket policy mirrors the contact engine:
 *   - resolver result (even when empty) → `enriched` after the log write-back
 *     (the domain was genuinely queried and will not be re-billed); no accepted
 *     email still records a no_emails_found / no_accepted_email log row
 *   - blocked result → `enriched` with the manual-block stamps
 *   - provider absence only when no resolver is injected
 */

const {
  lookupCache,
  incrementCacheHit,
  upsertCache,
  sortLogRows,
  enrichmentIdFor,
  ttlExpiresAt,
} = require('./enrichment-cache');
const {
  isUsCountry,
  normalize,
} = require('./enrichment-schema');
const {
  pickBestEmail,
  logRowFor,
  fieldsForBest,
  cachedFieldsOf,
  normalizeDomain,
  sortLeads,
  SKIP_REASONS,
  NO_EMAILS_FOUND,
  NO_ACCEPTED_EMAIL,
} = require('./enrichment-contact');

const PROVIDER_OSS = 'oss';
const PROVIDER_MANUAL = 'manual';

const OSS_NO_RESULTS = 'oss_no_results';

function applyOssFields(lead, fields) {
  const out = Object.assign({}, lead || {});
  for (const key of ['email', 'contact_name', 'contact_title', 'email_verified', 'email_source']) {
    if (fields[key] !== undefined && normalize(out[key]) === '') out[key] = fields[key];
  }
  out.contact_source_provider = PROVIDER_OSS;
  return out;
}

function markManualBlock(lead, options) {
  const opts = options || {};
  const base = normalize(lead && lead.notes);
  const note = normalize(opts.notes);
  const notes = base === '' ? note : note === '' ? base : `${base} | ${note}`;
  return Object.assign({}, lead || {}, {
    contact_blocked: 'TRUE',
    contact_source_provider: PROVIDER_MANUAL,
    notes,
  });
}

function noteFor(emails, best) {
  if (best) return '';
  if ((emails || []).length > 0) return NO_ACCEPTED_EMAIL;
  return NO_EMAILS_FOUND;
}

async function enrichContactOss(options) {
  const opts = options || {};
  const leads = opts.leads || [];
  const resolver = typeof opts.resolver === 'function' ? opts.resolver : null;
  const now = normalize(opts.now);
  const countryInScope =
    typeof opts.countryInScope === 'function' ? opts.countryInScope : isUsCountry;

  const stats = {
    total: leads.length,
    enriched: 0,
    skipped: 0,
    failed: 0,
    credits_consumed: 0,
    cache_hits: 0,
  };

  const enriched = [];
  const skipped = [];
  const failed = [];
  let log = sortLogRows(opts.logRows || []);

  for (const rawLead of leads || []) {
    const lead = rawLead || {};
    const domain = normalizeDomain(lead.website);

    if (!countryInScope(lead.country)) {
      skipped.push(Object.assign({}, lead, { enrichment_skip_reason: SKIP_REASONS.NON_US }));
      stats.skipped += 1;
      continue;
    }
    if (domain === '') {
      skipped.push(Object.assign({}, lead, { enrichment_skip_reason: SKIP_REASONS.NO_DOMAIN }));
      stats.skipped += 1;
      continue;
    }
    if (normalize(lead.email) !== '') {
      skipped.push(Object.assign({}, lead, { enrichment_skip_reason: SKIP_REASONS.ALREADY_ENRICHED }));
      stats.skipped += 1;
      continue;
    }

    const key = `${domain}::${PROVIDER_OSS}`;
    const cached = lookupCache(log, key, { now });
    if (cached) {
      log = incrementCacheHit(log, { enrichment_key: key });
      enriched.push(applyOssFields(lead, cachedFieldsOf(cached)));
      stats.enriched += 1;
      stats.cache_hits += 1;
      continue;
    }

    if (!resolver) {
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: 'oss_no_resolver_configured' }));
      stats.failed += 1;
      continue;
    }

    let result = null;
    try {
      result = await resolver(domain, lead);
    } catch (err) {
      result = null;
    }

    const emails = result && Array.isArray(result.emails) ? result.emails : [];
    const blocked = Boolean(result && result.blocked === true);
    const best = pickBestEmail(emails, { minScore: opts.minScore });
    const notes = blocked
      ? normalize(result && result.notes) || OSS_NO_RESULTS
      : noteFor(emails, best);

    log = upsertCache(
      log,
      logRowFor({
        enrichmentKey: key,
        leadId: lead.lead_id,
        domain,
        result: best,
        credits: 0,
        now,
        ttlDays: opts.ttlDays,
        provider: blocked ? PROVIDER_MANUAL : PROVIDER_OSS,
        notes,
      }),
    );

    let out = applyOssFields(lead, best ? fieldsForBest(best) : {});
    if (best) {
      out.email_source = PROVIDER_OSS;
    }
    if (blocked) {
      out = markManualBlock(out, { notes });
      out.enrichment_fallback = OSS_NO_RESULTS;
    }
    if (!best && !blocked) {
      out.enrichment_fallback = notes;
    }

    enriched.push(out);
    stats.enriched += 1;
  }

  const output = {
    enriched: sortLeads(enriched),
    skipped: sortLeads(skipped),
    failed: sortLeads(failed),
    stats,
    log: sortLogRows(log),
  };
  return output;
}

module.exports = {
  enrichContactOss,
  markManualBlock,
  applyOssFields,
  noteFor,
  PROVIDER_OSS,
  PROVIDER_MANUAL,
  OSS_NO_RESULTS,
};