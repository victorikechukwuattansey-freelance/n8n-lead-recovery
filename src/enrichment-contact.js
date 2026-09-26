'use strict';

/*
 * Contact enrichment engine (Prompt H.4-rev) — Contact Enrichment V1 · contact
 * half. Enriches US qualified leads with an email + contact metadata using a
 * domain-search PROVIDER (AgentData by default, Hunter selectable — injected
 * through a client seam) and the sheet-backed Contact Enrichment Log as the
 * durable cache.
 *
 * Offline-only: OWASP-style, this engine never performs network I/O itself. The
 * provider client is injected (`client.domainSearch(domain)`, contract in
 * src/enrichment-contact-client.js); fixtures stub it. Deterministic: `now` is
 * injected, no Date.now/Math.random, provider calls happen in lead order. The
 * engine NEVER reads process.env (the embedded mirror composed from this module
 * is shipped inside the workflow, where the clean-source scanner bans it);
 * provider selection is an explicit `provider` option or `client.provider`.
 *
 * Per-lead flow:
 *   1. eligibility gate — skip unless US (D-C8), website non-empty, email empty
 *   2. enrichment_key = domain::provider   (provider = opts.provider ||
 *      client.provider || 'agentdata')
 *   3. cache lookup — hit (non-expired log row) → fill from cache, increment
 *      cache_hit_count (write-back), do NOT call the provider, no credit
 *   4. miss/expired → client.domainSearch(domain) → best email selected
 *      (confidence >= minScore, never auto-accept a generic local part) → fill
 *      only EMPTY Approved columns (email, contact_name, contact_title,
 *      email_verified, email_source) → append a deterministic log row; credits
 *      recorded (defaults to DOMAIN_SEARCH_CREDITS when the client omits them)
 *   5. provider failures: the client THROWS. err.fatal === true → batch halt,
 *      every remaining lead failed; any other throw (or a malformed non-array
 *      result) → non-fatal lead failure (deferred, retried next cycle, no log
 *      row).
 *
 * Acceptance policy (D-C5): no unverified/generic/sub-threshold address is ever
 * auto-written. A verified accepted email sets email_verified='Y'; unverified
 * accepted emails stay on the call path (email_verified ''), never marked
 * deliverable. Provider-empty domains are logged (no_emails_found) so the
 * domain is not re-billed, and the lead remains call/NOT_READY.
 *
 * Contract:
 *   inputs  leads[]            Raw/Approved rows (id, website, country, email,
 *                              contact_name, contact_title, email_source,
 *                              email_verified + …)
 *           logRows[]          Contact Enrichment Log rows (cache)
 *           client             { provider?, domainSearch(domain) →
 *                              { emails, source, creditsUsed } | throws }
 *           now / runId        injected (determinism)
 *           provider           explicit override (else client.provider, else
 *                              'agentdata')
 *   outputs { provider, enriched, skipped, failed, stats, fatal?, log }
 *     provider    the provider used for the run (labels provider_runs)
 *     enriched[]  — completed rows (cache-provider or provider decision), sorted
 *                   by lead_id; skipped[]/failed[] likewise, each carrying an
 *                   enrichment_skip_reason / enrichment_failure_reason
 *     stats       total, enriched, skipped, failed, credits_consumed, cache_hits
 *     fatal       { reason, status } when the batch halted (else absent)
 *     log         the updated Contact Enrichment Log rows (write-back payload)
 *
 * The engine tolerates BOTH email shapes — the provider canonical
 * { email, first_name, last_name, position, confidence, verification_status }
 * and the OSS resolver legacy { value, score, verified, … } — because the OSS
 * fallback engine (src/enrichment-contact-oss.js, unmodified) reuses these
 * helpers with its own resolver output. verification_status 'valid' (or
 * 'catch-all', normalized by the client) means verified; legacy `verified`
 * booleans/'TRUE'/'1' also qualify.
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
  HUNTER_MIN_SCORE,
  DEFAULT_TTL_DAYS,
  isUsCountry,
  isGenericEmail,
  normalize,
} = require('./enrichment-schema');

const PROVIDER_AGENTDATA = 'agentdata';
const PROVIDER_HUNTER = 'hunter';

const DOMAIN_SEARCH_CREDITS = 1;

const SKIP_REASONS = Object.freeze({
  NON_US: 'non_us',
  NO_DOMAIN: 'no_domain',
  ALREADY_ENRICHED: 'already_enriched',
});

const NO_EMAILS_FOUND = 'no_emails_found';
const NO_ACCEPTED_EMAIL = 'no_accepted_email';

function normalizeDomain(value) {
  let url = normalize(value).toLowerCase();
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  url = url.replace(/^www\./, '');
  url = url.split('/')[0];
  url = url.split('?')[0];
  url = url.split('#')[0];
  return url.replace(/[.:]+$/, '');
}

function emailOf(email) {
  const value = email && email.email !== undefined && email.email !== null ? email.email : email && email.value;
  return normalize(value);
}

function scoreOf(email) {
  const raw = email && email.confidence !== undefined && email.confidence !== null ? email.confidence : email && email.score;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function verifiedOf(email) {
  const status = normalize(email && email.verification_status);
  if (status === 'valid') return true;
  const v = email && email.verified;
  if (v === true || v === 'TRUE' || v === 'true' || v === 'Y' || v === 'y' || v === '1') return true;
  return false;
}

function contactNameFrom(email) {
  const first = normalize(email && email.first_name);
  const last = normalize(email && email.last_name);
  return [first, last].filter((part) => part !== '').join(' ');
}

function pickBestEmail(emails, options) {
  const opts = options || {};
  const rawMin = opts.minScore === undefined || opts.minScore === null ? HUNTER_MIN_SCORE : opts.minScore;
  const minScore = Number.isFinite(Number(rawMin)) ? Number(rawMin) : HUNTER_MIN_SCORE;
  const candidates = (emails || [])
    .filter((email) => emailOf(email).indexOf('@') !== -1)
    .filter((email) => !isGenericEmail(emailOf(email).split('@')[0]))
    .filter((email) => scoreOf(email) >= minScore)
    .slice()
    .sort((a, b) => {
      const byScore = scoreOf(b) - scoreOf(a);
      if (byScore !== 0) return byScore;
      const byVerified = verifiedOf(b) ? 1 : 0;
      const aVerified = verifiedOf(a) ? 1 : 0;
      if (byVerified !== aVerified) return byVerified - aVerified;
      return emailOf(a).localeCompare(emailOf(b));
    });
  return candidates[0] || null;
}

function logRowFor(options) {
  const best = options.result || null;
  return {
    enrichment_id: enrichmentIdFor(options.enrichmentKey, options.now),
    enrichment_key: normalize(options.enrichmentKey),
    lead_id: String(options.leadId || ''),
    provider: normalize(options.provider) || PROVIDER_AGENTDATA,
    query_input: normalize(options.domain),
    result_email: best ? emailOf(best) : '',
    result_contact_name: best ? contactNameFrom(best) : '',
    result_contact_title: best ? normalize(best.position) : '',
    result_verified: best && verifiedOf(best) ? 'TRUE' : 'FALSE',
    credits_consumed: Number.isFinite(Number(options.credits)) && Number(options.credits) > 0 ? String(Number(options.credits)) : '',
    enriched_at: normalize(options.now),
    ttl_expires_at: ttlExpiresAt(options.now, options.ttlDays),
    cache_hit_count: '0',
    notes: normalize(options.notes),
  };
}

function fieldsForBest(best, provider) {
  if (!best) return {};
  return {
    email: emailOf(best),
    contact_name: contactNameFrom(best),
    contact_title: normalize(best.position),
    email_verified: verifiedOf(best) ? 'Y' : '',
    email_source: normalize(provider) || PROVIDER_AGENTDATA,
  };
}

function cachedFieldsOf(row) {
  const email = normalize(row && row.result_email);
  return {
    email,
    contact_name: normalize(row && row.result_contact_name),
    contact_title: normalize(row && row.result_contact_title),
    email_verified: normalize(row && row.result_verified) === 'TRUE' ? 'Y' : '',
    email_source: email !== '' ? normalize(row && row.provider) : '',
  };
}

function applyContactFields(lead, fields, provider) {
  const out = Object.assign({}, lead || {});
  for (const key of ['email', 'contact_name', 'contact_title', 'email_verified', 'email_source']) {
    if (normalize(out[key]) === '' && fields[key] !== undefined) out[key] = fields[key];
  }
  out.contact_source_provider = normalize(provider) || PROVIDER_AGENTDATA;
  return out;
}

function sortLeads(rows) {
  return rows
    .slice()
    .map((row) => (row && typeof row === 'object' ? row : {}))
    .sort((x, y) => String(x.lead_id || '').localeCompare(String(y.lead_id || '')));
}

async function enrichContactLeads(options) {
  const opts = options || {};
  const leads = opts.leads || [];
  const client = opts.client || null;
  const now = normalize(opts.now);
  const provider =
    normalize(opts.provider) || (client && normalize(client.provider)) || PROVIDER_AGENTDATA;
  const countryInScope =
    typeof opts.countryInScope === 'function' ? opts.countryInScope : isUsCountry;
  let log = sortLogRows(opts.logRows || []);

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
  let fatal;

  const lookup =
    client && typeof client.domainSearch === 'function'
      ? client.domainSearch
      : client && typeof client.search === 'function'
        ? client.search
        : null;

  for (const rawLead of leads || []) {
    const lead = rawLead || {};

    if (fatal) {
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: fatal.reason }));
      stats.failed += 1;
      continue;
    }

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

    const key = `${domain}::${provider}`;
    const cached = lookupCache(log, key, { now });
    if (cached) {
      log = incrementCacheHit(log, { enrichment_key: key });
      enriched.push(applyContactFields(lead, cachedFieldsOf(cached), provider));
      stats.enriched += 1;
      stats.cache_hits += 1;
      continue;
    }

    if (!lookup) {
      fatal = { reason: 'no_client_configured', status: null };
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: fatal.reason }));
      stats.failed += 1;
      continue;
    }

    let result;
    try {
      result = await lookup(domain);
    } catch (err) {
      const reason = normalize(err && err.reason) || normalize(err && err.message) || 'provider_error';
      if (err && err.fatal === true) {
        fatal = { reason, status: err.status || null };
        failed.push(Object.assign({}, lead, { enrichment_failure_reason: fatal.reason }));
        stats.failed += 1;
        continue;
      }
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: reason }));
      stats.failed += 1;
      continue;
    }

    if (result && result.ok === false) {
      const reason = normalize(result.reason) || 'provider_error';
      if (result.fatal === true) {
        fatal = { reason, status: result.status || null };
        failed.push(Object.assign({}, lead, { enrichment_failure_reason: fatal.reason }));
        stats.failed += 1;
        continue;
      }
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: reason }));
      stats.failed += 1;
      continue;
    }

    if (!result || typeof result !== 'object' || !Array.isArray(result.emails)) {
      failed.push(Object.assign({}, lead, { enrichment_failure_reason: 'provider_error' }));
      stats.failed += 1;
      continue;
    }

    const credits = Number.isFinite(Number(result.creditsUsed)) ? Number(result.creditsUsed) : DOMAIN_SEARCH_CREDITS;
    const best = pickBestEmail(result.emails, { minScore: opts.minScore });
    const notes = best ? '' : (result.emails && result.emails.length ? NO_ACCEPTED_EMAIL : NO_EMAILS_FOUND);

    log = upsertCache(
      log,
      logRowFor({
        enrichmentKey: key,
        leadId: lead.lead_id,
        domain,
        result: best,
        credits,
        now,
        ttlDays: opts.ttlDays,
        provider,
        notes,
      }),
    );

    enriched.push(applyContactFields(lead, fieldsForBest(best, provider), provider));
    stats.enriched += 1;
    stats.credits_consumed += credits;
  }

  const output = {
    provider,
    enriched: sortLeads(enriched),
    skipped: sortLeads(skipped),
    failed: sortLeads(failed),
    stats,
    log: sortLogRows(log),
  };
  if (fatal) output.fatal = fatal;
  return output;
}

module.exports = {
  enrichContactLeads,
  pickBestEmail,
  logRowFor,
  fieldsForBest,
  cachedFieldsOf,
  applyContactFields,
  normalizeDomain,
  emailOf,
  contactNameFrom,
  scoreOf,
  verifiedOf,
  sortLeads,
  PROVIDER_AGENTDATA,
  PROVIDER_HUNTER,
  DOMAIN_SEARCH_CREDITS,
  SKIP_REASONS,
  NO_EMAILS_FOUND,
  NO_ACCEPTED_EMAIL,
};