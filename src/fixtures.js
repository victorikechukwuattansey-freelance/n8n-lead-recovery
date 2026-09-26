'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { VERIFIED_COLUMNS, CLEANUP_REGEX } = require('./schema');

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'aoh-fixtures.json');

function toCell(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function buildVerifiedRow(entry) {
  const leadId = entry.lead_id;
  const website = entry.website || '';
  const phone = entry.phone || '';
  const score = entry.score === undefined || entry.score === null ? '80' : String(entry.score);

  const row = {
    lead_id: leadId,
    business_name: entry.business_name || `Fixture Business ${leadId}`,
    niche: entry.niche || 'HVAC',
    city: entry.city || 'Austin',
    state: entry.state || 'Texas',
    country: entry.country || 'USA',
    address: entry.address || '100 Fixture Ave',
    phone,
    website,
    rating: entry.rating === undefined ? '4.0' : String(entry.rating),
    review_count: entry.review_count === undefined ? '8' : String(entry.review_count),
    google_maps_url: entry.google_maps_url || '',
    business_type: entry.business_type || 'Service business',
    source: entry.source || 'FIXTURE',
    search_input_id: entry.search_input_id || `FIXTURE-${leadId}`,
    dedupe_key: entry.dedupe_key || `fixture:${leadId}`,
    has_website: website ? 'TRUE' : 'FALSE',
    has_phone: phone ? 'TRUE' : 'FALSE',
    target_niche: entry.target_niche || 'HVAC',
    score,
    qualification_status: entry.qualification_status || 'QUALIFIED',
    verified_at: entry.verified_at || '2026-09-10T00:00:00.000Z',
    notes: entry.notes || 'FIXTURE',
    manual_review_notes: entry.manual_review_notes || '',
  };

  for (const col of VERIFIED_COLUMNS) {
    if (!(col in row)) row[col] = '';
  }
  return row;
}

function buildApprovedRow(entry) {
  const leadId = entry.lead_id;
  return {
    lead_id: leadId,
    business_name: entry.business_name || `Fixture Business ${leadId}`,
    niche: entry.niche || '',
    city: entry.city || '',
    state: entry.state || '',
    country: entry.country || '',
    website: entry.website || '',
    phone: entry.phone || '',
    email: entry.email || '',
    contact_name: entry.contact_name || '',
    score: entry.score === undefined
      ? (entry.lead_score === undefined ? '' : String(entry.lead_score))
      : String(entry.score),
    status: entry.status === undefined
      ? (entry.outreach_status || 'not_ready')
      : (entry.status || 'not_ready'),
    approved_at: entry.approved_at || '',
    notes: entry.notes || '',
  };
}

function loadFixtures(filePath = FIXTURES_PATH) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const verifiedSeeds = (raw.verified_leads_seed || []).map(buildVerifiedRow);
  const approvedPreseed = (raw.approved_outreach_preseed || []).map(buildApprovedRow);

  for (const row of verifiedSeeds) {
    if (!CLEANUP_REGEX.test(row.lead_id)) {
      throw new Error(`Fixture lead_id does not match namespaced regex: ${row.lead_id}`);
    }
  }

  const ids = verifiedSeeds.map((r) => r.lead_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate fixture lead_ids detected in verified_leads_seed');
  }

  const expectedInsert = new Set(raw.expected.insert || []);
  const expectedSkip = new Set(raw.expected.skip || []);
  const preseedIds = new Set(approvedPreseed.map((r) => r.lead_id));

  const allIds = new Set([...ids, ...preseedIds]);
  for (const expectedId of [...expectedInsert, ...expectedSkip]) {
    if (!allIds.has(expectedId)) {
      throw new Error(`Expected outcome references unknown fixture id: ${expectedId}`);
    }
  }

  return {
    verifiedSeeds,
    approvedPreseed,
    expectedInsert,
    expectedSkip,
    preseedIds,
    meta: raw._meta || {},
  };
}

module.exports = { loadFixtures, buildVerifiedRow, buildApprovedRow, FIXTURES_PATH };