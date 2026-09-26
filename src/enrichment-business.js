'use strict';

/*
 * Business enrichment engine (Prompt H.2) — Contact Enrichment V1 · business
 * half. Matches Raw Leads against an Overture Places business index and fills
 * empty target fields without ever clobbering provider data.
 *
 * Offline-only: consumes an in-memory `index` (built from
 * scripts/overture-load-places.js output) and returns deterministic output.
 * No Date.now/Math.random — `now` / `runId` are injected so identical inputs
 * produce identical results.
 *
 * Contract:
 *   inputs  leads[]   Raw Leads rows (lead_id, business_name, city, state,
 *                     country, website, phone + whatever columns the sheet has)
 *           index[]   Overture places (gers_id, primary_name, website, phone,
 *                     city, state_code, country, operating_status, confidence)
 *   outputs { enriched, unmatched, stats }
 *     enriched[]   matched leads + enrichment_* fields (sorted by lead_id, tie
 *                  by gers_id ascending)
 *     unmatched[]  leads with no candidate (confidence 0) — same sort
 *     stats        total, matched, unmatched, filled_website, filled_phone,
 *                  filled_operating_status, closed_businesses_flagged
 *
 * Match priority:
 *   1. phone — normalized phone equality (A.12 normalizePhone: digits only,
 *      11-digit leading 1 collapses to 10)
 *   2. website — normalized domain equality (scheme/www/path stripped, lowercase)
 *   3. name+city+state — same city + same state code, and normalized name exact
 *      (0.7) or Levenshtein <= 2 (0.4)
 *
 * Enrichment policy: write only when the target field is currently empty/null,
 * never clobber provider data. enrichment_business_status / _confidence /
 * _gers_id / _last_run are stamped on EVERY processed lead (enriched + unmatched)
 * for operator visibility. operating_status → 'open' | 'closed' | ''.
 */

function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizePhone(value) {
  const digits = normalize(value).replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return digits;
}

function normalizeDomain(value) {
  let url = normalize(value).toLowerCase();
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  url = url.replace(/^www\./, '');
  url = url.split('/')[0];
  url = url.split('?')[0];
  url = url.split('#')[0];
  return url.replace(/[.:]+$/, '');
}

function normalizeName(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeState(value) {
  return normalize(value).toUpperCase();
}

function levenshtein(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const curr = new Array(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function operatingStatusOf(raw) {
  const status = normalize(raw).toLowerCase();
  if (status === '') return '';
  if (status.includes('closed')) return 'closed';
  return 'open';
}

function sortLeads(rows, gersFirst) {
  return rows.slice().sort((x, y) => {
    const byId = String(x.lead_id || '').localeCompare(String(y.lead_id || ''));
    if (byId !== 0) return byId;
    return String(x.enrichment_gers_id || '').localeCompare(String(y.enrichment_gers_id || ''));
  });
}

function enrichBusinessLeads({ leads = [], index = [], now, runId = '' }) {
  const timestamp = normalize(now);
  const candidates = (index || []).map((place) => ({
    gersId: normalize(place.gers_id),
    name: normalizeName(place.primary_name),
    website: normalizeDomain(place.website),
    phone: normalizePhone(place.phone),
    city: normalize(place.city).toLowerCase(),
    stateCode: normalizeState(place.state_code),
    operatingStatus: operatingStatusOf(place.operating_status),
    confidence: Number.isFinite(Number(place.confidence)) ? Number(place.confidence) : 0,
  })).sort((a, b) => String(a.gersId).localeCompare(String(b.gersId)));

  const stats = {
    total: leads.length,
    matched: 0,
    unmatched: 0,
    filled_website: 0,
    filled_phone: 0,
    filled_operating_status: 0,
    closed_businesses_flagged: 0,
  };

  const enriched = [];
  const unmatched = [];

  for (const rawLead of leads || []) {
    const leadPhone = normalizePhone(rawLead.phone);
    const leadWebsite = normalizeDomain(rawLead.website);
    const leadCity = normalize(rawLead.city).toLowerCase();
    const leadState = normalizeState(rawLead.state);
    const leadName = normalizeName(rawLead.business_name);

    let best = null;

    if (leadPhone !== '') {
      best = candidates.find((c) => c.phone !== '' && c.phone === leadPhone);
      if (best) best.level = 'phone';
    }
    if (!best && leadWebsite !== '') {
      best = candidates.find((c) => c.website !== '' && c.website === leadWebsite);
      if (best) best.level = 'website';
    }
    if (!best && leadName !== '' && leadCity !== '' && leadState !== '') {
      const cityMatches = candidates.filter(
        (c) => c.city !== '' && c.city === leadCity && c.stateCode !== '' && c.stateCode === leadState,
      );
      const exact = cityMatches.find((c) => c.name === leadName);
      if (exact) {
        best = exact;
        best.level = 'name_exact';
      } else {
        const fuzzy = cityMatches.find((c) => c.name !== '' && levenshtein(c.name, leadName) <= 2);
        if (fuzzy) {
          best = fuzzy;
          best.level = 'name_fuzzy';
        }
      }
    }

    if (!best) {
      unmatched.push(
        Object.assign({}, rawLead, {
          enrichment_business_status: '',
          enrichment_confidence: 0,
          enrichment_gers_id: '',
          enrichment_last_run: timestamp,
        }),
      );
      stats.unmatched += 1;
      continue;
    }

    const out = Object.assign({}, rawLead, {
      enrichment_business_status: best.operatingStatus,
      enrichment_confidence: best.level === 'phone' || best.level === 'website' ? 1.0 : best.level === 'name_exact' ? 0.7 : 0.4,
      enrichment_gers_id: best.gersId,
      enrichment_last_run: timestamp,
    });

    const hadWebsite = normalize(out.website) !== '';
    const hadPhone = normalize(out.phone) !== '';
    if (!hadWebsite && best.website !== '') {
      out.website = best.website;
      stats.filled_website += 1;
    }
    if (!hadPhone && best.phone !== '') {
      out.phone = best.phone;
      stats.filled_phone += 1;
    }
    if (best.operatingStatus !== '') {
      stats.filled_operating_status += 1;
      if (best.operatingStatus === 'closed') stats.closed_businesses_flagged += 1;
    }

    enriched.push(out);
    stats.matched += 1;
  }

  return {
    enriched: sortLeads(enriched),
    unmatched: sortLeads(unmatched),
    stats,
  };
}

module.exports = {
  enrichBusinessLeads,
  normalizePhone,
  normalizeDomain,
  normalizeName,
  normalizeState,
  operatingStatusOf,
  levenshtein,
};