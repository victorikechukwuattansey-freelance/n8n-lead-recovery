'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeGooglePlacesResponse, buildDedupeKey } = require('./google-places');

const GPL_FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'gpl-fixtures.json');
const GPL_NAMESPACE = 'TEST-GPL';
const GPL_REGEX = /^TEST-GPL-\d+$/;

function loadGplFixtures() {
  const raw = fs.readFileSync(GPL_FIXTURES_PATH, 'utf8');
  const data = JSON.parse(raw);

  if (data._meta?.namespace !== GPL_NAMESPACE) {
    throw new Error(`Fixture namespace mismatch: expected ${GPL_NAMESPACE}, got ${data._meta?.namespace}`);
  }
  if (data._meta?.regex !== GPL_REGEX.source) {
    throw new Error(`Fixture regex mismatch: expected ${GPL_REGEX.source}, got ${data._meta?.regex}`);
  }

  return data.fixtures;
}

function validateFixtureId(id) {
  if (!GPL_REGEX.test(id)) {
    throw new Error(`Invalid fixture ID: ${id}. Must match ${GPL_REGEX}`);
  }
}

function buildRawLeadRow(fixture, leadIndex = 0) {
  const expected = fixture.expected_raw_leads?.[leadIndex];
  if (!expected) return null;

  const staticData = { MAX_RESULTS_PER_SEARCH: 20 };
  const result = normalizeGooglePlacesResponse(fixture.gpl_response, fixture.search_input, staticData);
  if (result.error) return null;

  const lead = result.leads[leadIndex];
  if (!lead) return null;

  // Verify against expected
  return lead;
}

function getFixturesByCategory(category) {
  const fixtures = loadGplFixtures();
  switch (category) {
    case 'success':
      return fixtures.filter(f => f.expected_raw_leads && f.expected_raw_leads.length > 0 && !f.error_expected);
    case 'empty':
      return fixtures.filter(f => (!f.expected_raw_leads || f.expected_raw_leads.length === 0) && !f.error_expected);
    case 'error':
      return fixtures.filter(f => f.error_expected);
    case 'dedupe':
      return fixtures.filter(f => f.name.toLowerCase().includes('duplicate') || f.name.toLowerCase().includes('variation'));
    default:
      return fixtures;
  }
}

module.exports = {
  GPL_FIXTURES_PATH,
  GPL_NAMESPACE,
  GPL_REGEX,
  loadGplFixtures,
  validateFixtureId,
  buildRawLeadRow,
  getFixturesByCategory
};