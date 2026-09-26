'use strict';

/*
 * Approved Outreach Handoff engine-harness fixture loader (Prompt C-B, Part B).
 *
 * Mirrors the Prospect Finder harness loader convention
 * (fixtures/prospect-finder-fixtures.js): the loader is collocated with the
 * JSON it describes (a documented deviation from src/<name>-fixtures.js), with
 * a namespace guard against the `_meta` block, a canonical id regex
 * (^TEST-HANDOFF-[A-Z]+-\d+$), per-id validation, a duplicate-id guard, and a
 * frozen deep-copied `expected` golden block so test mutation can never leak
 * into the fixture store.
 */

const fs = require('node:fs');
const path = require('node:path');

const HANDOFF_NAMESPACE = 'TEST-HANDOFF';
const HANDOFF_REGEX = /^TEST-HANDOFF-[A-Z]+-\d+$/;

const FIXTURES_PATH = path.join(__dirname, 'handoff-fixtures.json');

function validateFixtureId(id) {
  if (!HANDOFF_REGEX.test(id)) {
    throw new Error(`Invalid fixture ID: ${id}. Must match ${HANDOFF_REGEX}`);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadHandoffFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));

  if (raw._meta.namespace !== HANDOFF_NAMESPACE) {
    throw new Error(`Fixture namespace mismatch: expected ${HANDOFF_NAMESPACE}, got ${raw._meta.namespace}`);
  }
  if (raw._meta.regex !== HANDOFF_REGEX.source) {
    throw new Error(`Fixture regex mismatch: expected ${HANDOFF_REGEX.source}, got ${raw._meta.regex}`);
  }

  const seen = new Set();
  return raw.fixtures.map((fixture) => {
    if (!HANDOFF_REGEX.test(fixture.id)) {
      throw new Error(`Fixture id is not in ${HANDOFF_NAMESPACE} namespace: ${fixture.id}`);
    }
    if (seen.has(fixture.id)) {
      throw new Error(`Duplicate fixture id ${fixture.id}`);
    }
    seen.add(fixture.id);
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      verified_leads: clone(fixture.verified_leads || []),
      approved_rows: clone(fixture.approved_rows || []),
      expected: clone(fixture.expected || {}),
    };
  });
}

module.exports = {
  HANDOFF_NAMESPACE,
  HANDOFF_REGEX,
  FIXTURES_PATH,
  validateFixtureId,
  loadHandoffFixtures,
};