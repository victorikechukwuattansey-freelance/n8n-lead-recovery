'use strict';

/*
 * Prospect Finder offline engine-harness fixture loader.
 *
 * Named path per the C-A prompt ("Loader: fixtures/prospect-finder-fixtures.js");
 * the repo convention otherwise places loaders in src/<name>-fixtures.js — a
 * deliberate, documented deviation so the harness files stay collocated with
 * the JSON data they describe.
 *
 * Mirrors the established fixture-loading conventions (Response Capture,
 * Response Interpretation, GPL): namespace guard against the `_meta` block, a
 * canonical id regex (^TEST-PF-\d+$), per-id validation, a duplicate-id guard,
 * and a frozen deep-copied `expected` golden block so test mutation can never
 * leak into the fixture store.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROSPECT_FINDER_NAMESPACE = 'TEST-PF';
const PROSPECT_FINDER_REGEX = /^TEST-PF-[A-Z]+(?:-[A-Z]+)*-\d+$/;

const FIXTURES_PATH = path.join(__dirname, 'prospect-finder-fixtures.json');

function validateFixtureId(id) {
  if (!PROSPECT_FINDER_REGEX.test(id)) {
    throw new Error(`Invalid fixture ID: ${id}. Must match ${PROSPECT_FINDER_REGEX}`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadProspectFinderFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

  if (raw._meta.namespace !== PROSPECT_FINDER_NAMESPACE) {
    throw new Error(`Fixture namespace mismatch: expected ${PROSPECT_FINDER_NAMESPACE}, got ${raw._meta.namespace}`);
  }
  if (raw._meta.regex !== PROSPECT_FINDER_REGEX.source) {
    throw new Error(`Fixture regex mismatch: expected ${PROSPECT_FINDER_REGEX.source}, got ${raw._meta.regex}`);
  }

  const seen = new Set();
  return raw.fixtures.map((fixture) => {
    if (!PROSPECT_FINDER_REGEX.test(fixture.id)) {
      throw new Error(`Fixture id is not in ${PROSPECT_FINDER_NAMESPACE} namespace: ${fixture.id}`);
    }
    if (seen.has(fixture.id)) {
      throw new Error(`Duplicate fixture id ${fixture.id}`);
    }
    seen.add(fixture.id);
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      search_input: clone(fixture.search_input || {}),
      foursquare_response: clone(fixture.foursquare_response),
      osm_response: clone(fixture.osm_response),
      gpl_envelope: clone(fixture.gpl_envelope),
      empty: clone(fixture.empty),
      errors: clone(fixture.errors),
      expected: clone(fixture.expected || {}),
    };
  });
}

module.exports = {
  PROSPECT_FINDER_NAMESPACE,
  PROSPECT_FINDER_REGEX,
  FIXTURES_PATH,
  validateFixtureId,
  loadProspectFinderFixtures,
};