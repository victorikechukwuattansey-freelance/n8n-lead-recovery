'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { RESPONSE_COLUMNS } = require('./response-capture');

const RESP_NAMESPACE = 'TEST-RESP';
const RESP_REGEX = /^TEST-RESP-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'response-capture-fixtures.json');

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function loadResponseCaptureFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== RESP_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${RESP_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!RESP_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${RESP_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      mode: fixture.mode || 'DRY_RUN',
      events: fixture.events || [],
      identity_lookup: fixture.identity_lookup || {},
      reorder_of: fixture.reorder_of || '',
      initialResponseRows: (fixture.initialResponseRows || []).map((partial) =>
        rowWithDefaults(RESPONSE_COLUMNS, partial),
      ),
      expected: Object.assign({}, fixture.expected || {}),
    };
  });
}

module.exports = { RESP_NAMESPACE, RESP_REGEX, FIXTURES_PATH, loadResponseCaptureFixtures, rowWithDefaults };