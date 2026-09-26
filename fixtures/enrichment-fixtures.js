'use strict';

/*
 * Contact Enrichment V1 offline fixture loader (Prompts H.2–H.5).
 *
 * Follows the established fixture-loading conventions (Prospect Finder,
 * Response Interpretation): namespace guard against the `_meta` block, a
 * canonical id regex (^TEST-ENRICH-\d+$), per-id validation, a duplicate-id
 * guard, and a frozen deep-copied `expected` golden block so test mutation can
 * never leak into the fixture store.
 *
 * Fixture shape:
 *   now / runId           deterministic timestamps injected into engines
 *   provider              provider for the contact engine (defaults matched by
 *                         the client stub; used to label keys/seams)
 *   leads[]               Raw Leads rows (arbitrary columns — engines preserve
 *                         unknown fields)
 *   index[]               Overture places rows (business engine index)
 *   cacheRows[]           Contact Enrichment Log rows (cache primitives)
 *   domainResults         stub domain-search map for the contact engine:
 *                         { "<domain>": { emails: [...], creditsUsed } | fatal |
 *                           error }
 *   ossResults            stub OSS fallback output per domain
 *   expected              golden assertions (stats + per-lead expectations)
 *
 * `expected` is deep-frozen-cloned so test mutation is impossible.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENRICH_NAMESPACE = 'TEST-ENRICH';
const ENRICH_REGEX = /^TEST-ENRICH-\d+$/;

const FIXTURES_PATH = path.join(__dirname, 'enrichment-fixtures.json');
const CONTACT_FIXTURES_PATH = path.join(__dirname, 'enrichment-contact-fixtures.json');
const AGENTDATA_CONTACT_FIXTURES_PATH = path.join(__dirname, 'enrichment-contact-agentdata.json');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadEnrichmentFixtures(pathOverride) {
  const filePath = pathOverride || FIXTURES_PATH;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  if (raw._meta.namespace !== ENRICH_NAMESPACE) {
    throw new Error(`Fixture namespace mismatch: expected ${ENRICH_NAMESPACE}, got ${raw._meta.namespace}`);
  }
  if (raw._meta.regex !== ENRICH_REGEX.source) {
    throw new Error(`Fixture regex mismatch: expected ${ENRICH_REGEX.source}, got ${raw._meta.regex}`);
  }

  const seen = new Set();
  return raw.fixtures.map((fixture) => {
    if (!ENRICH_REGEX.test(fixture.id)) {
      throw new Error(`Fixture id is not in ${ENRICH_NAMESPACE} namespace: ${fixture.id}`);
    }
    if (seen.has(fixture.id)) {
      throw new Error(`Duplicate fixture id ${fixture.id}`);
    }
    seen.add(fixture.id);
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      now: fixture.now || '',
      runId: fixture.runId || '',
      provider: fixture.provider || '',
      leads: clone(fixture.leads || []),
      index: clone(fixture.index || []),
      cacheRows: clone(fixture.cacheRows || []),
      domainResults: clone(fixture.domainResults || {}),
      ossResults: clone(fixture.ossResults || {}),
      expected: clone(fixture.expected || {}),
    };
  });
}

module.exports = {
  ENRICH_NAMESPACE,
  ENRICH_REGEX,
  FIXTURES_PATH,
  CONTACT_FIXTURES_PATH,
  AGENTDATA_CONTACT_FIXTURES_PATH,
  loadEnrichmentFixtures,
};