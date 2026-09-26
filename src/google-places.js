'use strict';

/**
 * Google Places (New) API normalization for the Lead Recovery Engine.
 * Pure functions — no n8n dependencies, no side effects.
 * Used by the Process GPL n8n Code node and by tests.
 */

const MAX_RESULTS_PER_SEARCH = 20;

/*
 * Business-relevance rejection patterns (provider neutral, mirrored from the
 * Foursquare Process FSQ branch, Prompt C-A / GPL business-logic gate A).
 * A place whose display name OR types text matches any of these is not a
 * direct HVAC contractor prospect and is dropped before it becomes a Raw Lead.
 * Applied against business name + types joined text only; no positive-pattern
 * gating (a legit HVAC name containing the niche term is never rejected).
 */
const rejectPatterns = [
  /\bcredit\b/i,
  /\broofing\b/i,
  /\bplumbing\b/i,
  /\bflooring\b/i,
  /\bpainting\b/i,
  /\binsulation\b/i,
  /\bfoundation\b/i,
  /\bconcrete\b/i,
  /\bcarpet\b/i,
  /\bdryer\s+vents?\b/i,
  /\bducts?\s*cleaning\b/i,
  /\bpower\s+cleaning\b/i,
  /\bsupply\b/i,
  /\bwholesale\b/i,
  /\bhardware\b/i,
  /\brental\b/i,
  /\bconstruction\s+supply\b/i,
];

/*
 * US state normalizer for the Google Places geographic gate (business-logic
 * gate B). Recognizes the 50 states + DC by abbreviation or full name and
 * collapses either form to the 2-letter code. Anything else normalizes to ''
 * so the geographic gate fails closed on unrecognized location evidence.
 */
const STATE_ALIASES = {
  'alabama': 'al', 'alaska': 'ak', 'arizona': 'az', 'arkansas': 'ar',
  'california': 'ca', 'colorado': 'co', 'connecticut': 'ct', 'delaware': 'de',
  'district of columbia': 'dc', 'florida': 'fl', 'georgia': 'ga',
  'hawaii': 'hi', 'idaho': 'id', 'illinois': 'il', 'indiana': 'in',
  'iowa': 'ia', 'kansas': 'ks', 'kentucky': 'ky', 'louisiana': 'la',
  'maine': 'me', 'maryland': 'md', 'massachusetts': 'ma', 'michigan': 'mi',
  'minnesota': 'mn', 'mississippi': 'ms', 'missouri': 'mo', 'montana': 'mt',
  'nebraska': 'ne', 'nevada': 'nv', 'new hampshire': 'nh', 'new jersey': 'nj',
  'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc',
  'north dakota': 'nd', 'ohio': 'oh', 'oklahoma': 'ok', 'oregon': 'or',
  'pennsylvania': 'pa', 'rhode island': 'ri', 'south carolina': 'sc',
  'south dakota': 'sd', 'tennessee': 'tn', 'texas': 'tx', 'utah': 'ut',
  'vermont': 'vt', 'virginia': 'va', 'washington': 'wa',
  'west virginia': 'wv', 'wisconsin': 'wi', 'wyoming': 'wy',
};

const STATE_CODE_REGEX = /^(al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)$/;

function normalizeState(value) {
  const state = clean(value).toLowerCase();
  if (STATE_CODE_REGEX.test(state)) return state;
  return STATE_ALIASES[state] || '';
}

/*
 * Extracts { city, state } from a Google Places formattedAddress (US format).
 * Only the address text itself is evidence — the field mask is NOT expanded.
 * Expects a comma-separated segment ending "<state> <zip>" (optionally
 * "<state> <zip+4>"), where the state token is a recognized US state. The
 * city is the text before the state token in that segment, falling back to the
 * preceding segment when the state segment carries no city. Returns null when
 * no recognized state segment exists — the geographic gate then fails closed.
 */
function extractGeo(formattedAddress) {
  const address = clean(formattedAddress);
  if (!address) return null;

  const segments = address.split(',').map((s) => clean(s)).filter(Boolean);
  const STATE_SEGMENT = /^([A-Za-z][\w.' ]*?)\s+(\d{5})(?:[-\s]\d{4})?$/;

  for (let idx = 0; idx < segments.length; idx++) {
    const match = segments[idx].match(STATE_SEGMENT);
    if (!match) continue;

    const tokens = match[1].trim().split(/\s+/);
    const state = normalizeState(tokens[tokens.length - 1]);
    if (!state) continue; // unrecognized state token — keep scanning

    const cityInSegment = tokens.slice(0, -1).join(' ').toLowerCase();
    const city = cityInSegment || (idx > 0 ? segments[idx - 1].toLowerCase() : '');
    return { city, state };
  }

  return null;
}

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeWebsite(value) {
  const raw = clean(value);
  if (!raw) return '';
  // Strip protocol, www, trailing slash — matches existing pipeline convention
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return '';
  // Keep international format with + but strip non-digits except leading +
  // Matches existing pipeline: digits only for phone dedupe key
  return raw.replace(/[^\d+]/g, '');
}

function buildDedupeKey(lead) {
  // Matches existing dedupe algorithm exactly:
  // website: → phone: → ncs:name|city|state
  if (lead.website) {
    return 'website:' + normalizeWebsite(lead.website).toLowerCase();
  }
  if (lead.phone) {
    return 'phone:' + normalizePhone(lead.phone);
  }
  if (lead.business_name && lead.city && lead.state) {
    return 'ncs:' + [
      clean(lead.business_name).toLowerCase(),
      clean(lead.city).toLowerCase(),
      clean(lead.state).toLowerCase()
    ].join('|');
  }
  return '';
}

function generateLeadId(placeId, index) {
  // Deterministic lead ID from place ID + index
  // Uses first 8 chars of a simple hash of placeId
  const str = String(placeId || '') + ':' + index;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // 32-bit int
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return 'GP-' + hex;
}

function normalizeGooglePlace(place, searchInput, index, capturedAt) {
  const displayName = place?.displayName?.text ?? '';
  if (!displayName) return null; // Skip malformed places with empty names

  const formattedAddress = clean(place?.formattedAddress);
  const phone = normalizePhone(place?.internationalPhoneNumber);
  const website = normalizeWebsite(place?.websiteUri);
  const rating = place?.rating !== undefined && place?.rating !== null
    ? String(place.rating)
    : '';
  const reviewCount = place?.userRatingCount !== undefined && place?.userRatingCount !== null
    ? String(place.userRatingCount)
    : '';
  const googleMapsUrl = clean(place?.googleMapsUri);
  const types = place?.types || [];
  const businessType = types[0] || 'establishment';
  const placeId = place?.id || '';

  const lead = {
    business_name: displayName,
    niche: clean(searchInput?.niche),
    city: clean(searchInput?.city),
    state: clean(searchInput?.state),
    country: clean(searchInput?.country),
    address: formattedAddress,
    phone,
    website,
    rating,
    review_count: reviewCount,
    google_maps_url: googleMapsUrl,
    business_type: businessType,
    source: 'google_places',
    search_input_id: clean(searchInput?.input_id),
    raw_captured_at: capturedAt
  };

  lead.dedupe_key = buildDedupeKey(lead);
  lead.lead_id = generateLeadId(placeId, index);
  lead.notes = `Google Places: ${clean(searchInput?.search_query || (lead.niche + ' in ' + lead.city + ', ' + lead.state))}; gp_place_id:${placeId}`;

  return lead;
}

/**
 * Normalizes a Google Places API (New) searchText response into Raw Leads rows.
 * @param {Object} gplResponse - The raw JSON response from places:searchText
 * @param {Object} searchInput - The Search Input row that triggered this query
 * @param {Object} staticData - Workflow staticData for MAX_RESULTS_PER_SEARCH
 * @returns {Array} Array of Raw Leads objects (max MAX_RESULTS_PER_SEARCH)
 */
function normalizeGooglePlacesResponse(gplResponse, searchInput, staticData) {
  const capturedAt = new Date().toISOString();
  const places = gplResponse?.places || [];

  // Handle API error responses
  if (gplResponse?.error) {
    return {
      error: true,
      statusCode: gplResponse.error.code || 0,
      errorMessage: gplResponse.error.message || gplResponse.error.status || 'Unknown API error',
      rawResponse: gplResponse
    };
  }

  const maxResults = Math.min(
    Number(searchInput?.target_count || 1) * 3,
    20,
    Number(staticData?.MAX_RESULTS_PER_SEARCH) || 20
  );

  const targetCity = clean(searchInput?.city).toLowerCase();
  const targetState = normalizeState(clean(searchInput?.state || ''));

  const leads = [];
  let relevanceRejected = 0;
  let geoRejected = 0;
  let noContact = 0;

  for (let i = 0; i < Math.min(places.length, maxResults); i++) {
    const place = places[i];
    const displayName = place?.displayName?.text ?? '';
    if (!displayName) continue; // Skip malformed places with empty names

    // Gate A — business relevance (suppliers / parts-wholesale / rental / non-HVAC trades).
    const types = place?.types || [];
    if (
      rejectPatterns.some((pattern) => pattern.test(displayName)) ||
      rejectPatterns.some((pattern) => pattern.test(types.join(' ')))
    ) {
      relevanceRejected++;
      continue;
    }

    // Gate B — geography: only formattedAddress is evidence; fail closed.
    const geo = extractGeo(place?.formattedAddress);
    if (!geo || !geo.state) {
      geoRejected++;
      continue;
    }
    let geoOk = false;
    if (geo.city) {
      if (targetCity && geo.city === targetCity) geoOk = true;
      else if (targetCity) {
        geoRejected++;
        continue;
      }
    }
    if (geo.state) {
      if (targetState && geo.state === targetState) geoOk = true;
      else if (targetState) {
        geoRejected++;
        continue;
      }
    }
    if (!geoOk) {
      geoRejected++;
      continue;
    }

    const lead = normalizeGooglePlace(place, searchInput, i, capturedAt);
    if (!lead) continue;

    // Gate C — verification semantics: a record with neither phone nor website
    // cannot be contact-verified. Keep it in Raw Leads but neutralize the
    // dedupe key so Dedup & Prepare Verified's `if (!key) continue` can never
    // promote it to Verified, and mark it for visibility in notes.
    if (!lead.phone && !lead.website) {
      lead.dedupe_key = '';
      lead.notes += '; no_contact=true';
      noContact++;
    }

    leads.push(lead);
  }

  if (staticData) {
    staticData.gplRelevanceRejected = (staticData.gplRelevanceRejected || 0) + relevanceRejected;
    staticData.gplGeoRejected = (staticData.gplGeoRejected || 0) + geoRejected;
    staticData.gplNoContact = (staticData.gplNoContact || 0) + noContact;
  }

  return { leads, error: false };
}

module.exports = {
  clean,
  normalizeWebsite,
  normalizePhone,
  buildDedupeKey,
  generateLeadId,
  normalizeGooglePlace,
  normalizeGooglePlacesResponse,
  rejectPatterns,
  normalizeState,
  extractGeo,
  MAX_RESULTS_PER_SEARCH
};