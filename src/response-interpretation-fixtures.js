'use strict';

/*
 * Response Interpretation V1 fixture loader.
 *
 * Mirrors the established fixture-loading conventions (Response Capture,
 * Response Reconciliation): namespace guard, canonical id regex, row defaults
 * via the shared RESPONSE_COLUMNS / OUTREACH_COLUMNS contracts, and a frozen
 * deep-copied `expected` golden block. Adds interpretation-specific fields:
 *   - reconcileResponseRows / reconcileOutreachRows  evidence overrides used to
 *     generate the reconciliation report that feeds interpretation (default to
 *     the initial rows when absent).
 *   - responseReadError / reconciliationReadError     read-failure fixtures.
 *   - upstreamIncomplete                              reconciliation INCOMPLETE
 *     input fixture (read-failure-equivalent).
 */

const fs = require('node:fs');
const path = require('node:path');

const { RESPONSE_COLUMNS } = require('./response-capture');
const { OUTREACH_COLUMNS } = require('./reconcile');

const RESP_INT_NAMESPACE = 'TEST-RESP-INT';
const RESP_INT_REGEX = /^TEST-RESP-INT-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'response-interpretation-fixtures.json');

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function loadResponseInterpretationFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== RESP_INT_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${RESP_INT_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!RESP_INT_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${RESP_INT_NAMESPACE} namespace: ${fixture.id}`);
    }
    const initialResponseRows = (fixture.initialResponseRows || []).map((partial) =>
      rowWithDefaults(RESPONSE_COLUMNS, partial),
    );
    const initialOutreachRows = (fixture.initialOutreachRows || []).map((partial) =>
      rowWithDefaults(OUTREACH_COLUMNS, partial),
    );
    const reconcileResponseRows = (fixture.reconcileResponseRows || fixture.initialResponseRows || []).map((partial) =>
      rowWithDefaults(RESPONSE_COLUMNS, partial),
    );
    const reconcileOutreachRows = (fixture.reconcileOutreachRows || fixture.initialOutreachRows || []).map((partial) =>
      rowWithDefaults(OUTREACH_COLUMNS, partial),
    );
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      reorder_of: fixture.reorder_of || '',
      responseReadError: fixture.responseReadError || '',
      reconciliationReadError: fixture.reconciliationReadError || '',
      upstreamIncomplete: fixture.upstreamIncomplete || false,
      initialResponseRows,
      initialOutreachRows,
      reconcileResponseRows,
      reconcileOutreachRows,
      expected: JSON.parse(JSON.stringify(fixture.expected || {})),
    };
  });
}

module.exports = {
  RESP_INT_NAMESPACE,
  RESP_INT_REGEX,
  FIXTURES_PATH,
  loadResponseInterpretationFixtures,
  rowWithDefaults,
};