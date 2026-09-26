'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeGooglePlacesResponse } = require('./google-places');

const PROSPECT_GPL_LIVE_FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'prospect-finder-gpl-live-fixtures.json');
const LIVE_NAMESPACE = 'TEST-GPL-LIVE';
const LIVE_REGEX = /^TEST-GPL-LIVE-(001|ISO-00[1-4])$/;
const RUNTIME_FIELDS = ['raw_captured_at', 'verified_at'];

function loadLiveFixtures() {
  const raw = fs.readFileSync(PROSPECT_GPL_LIVE_FIXTURES_PATH, 'utf8');
  const data = JSON.parse(raw);

  if (data._meta?.namespace !== LIVE_NAMESPACE) {
    throw new Error(`Fixture namespace mismatch: expected ${LIVE_NAMESPACE}, got ${data._meta?.namespace}`);
  }
  if (data._meta?.regex !== LIVE_REGEX.source) {
    throw new Error(`Fixture regex mismatch: expected ${LIVE_REGEX.source}, got ${data._meta?.regex}`);
  }

  return data.fixtures;
}

function validateLiveFixtureId(id) {
  if (!LIVE_REGEX.test(id)) {
    throw new Error(`Invalid fixture ID: ${id}. Must match ${LIVE_REGEX}`);
  }
}

function isLiveSearchInput(inputId) {
  return LIVE_REGEX.test(String(inputId || ''));
}

function fixtureById(id) {
  const fixtures = loadLiveFixtures();
  const fixture = fixtures.find(f => f.id === id);
  if (!fixture) throw new Error(`Unknown live fixture: ${id}`);
  return fixture;
}

function searchInputRowFor(fixture) {
  const input = fixture.search_input;
  return {
    input_id: input.input_id,
    niche: input.niche,
    city: input.city,
    state: input.state,
    country: input.country,
    search_query: String(input.search_query || ''),
    target_count: String(input.target_count),
    status: String(input.status || 'Pending'),
    priority: String(input.priority || 'Live-Validation'),
    created_at: String(input.created_at || ''),
    notes: String(input.notes || '')
  };
}

function gplEnvelopeFor(fixture) {
  const envelope = fixture.gpl_full_response?.envelope;
  if (!envelope) throw new Error(`Live fixture ${fixture.id} is missing gpl_full_response.envelope`);
  return envelope;
}

function gplBodyFor(fixture) {
  const body = fixture.gpl_full_response?.gpl_response;
  if (!body) throw new Error(`Live fixture ${fixture.id} is missing gpl_full_response.gpl_response`);
  return body;
}

function expectedRawLeadsFor(fixture, staticData) {
  const result = normalizeGooglePlacesResponse(gplBodyFor(fixture), fixture.search_input, staticData);
  if (result.error) {
    return { error: result, leads: [] };
  }
  return { error: false, leads: result.leads };
}

function getFixturesByOutcome(outcome) {
  return loadLiveFixtures().filter(f => (f.flow?.gpl_outcome || 'success') === outcome);
}

module.exports = {
  PROSPECT_GPL_LIVE_FIXTURES_PATH,
  LIVE_NAMESPACE,
  LIVE_REGEX,
  RUNTIME_FIELDS,
  loadLiveFixtures,
  validateLiveFixtureId,
  isLiveSearchInput,
  fixtureById,
  searchInputRowFor,
  gplEnvelopeFor,
  gplBodyFor,
  expectedRawLeadsFor,
  getFixturesByOutcome
};