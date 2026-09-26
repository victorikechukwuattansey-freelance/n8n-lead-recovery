'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { RESPONSE_COLUMNS } = require('./response-capture');
const { OUTREACH_COLUMNS } = require('./reconcile');

const RESP_RECON_NAMESPACE = 'TEST-RESP-RECON';
const RESP_RECON_REGEX = /^TEST-RESP-RECON-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'response-reconcile-fixtures.json');

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function loadResponseReconcileFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== RESP_RECON_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${RESP_RECON_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!RESP_RECON_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${RESP_RECON_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      reorder_of: fixture.reorder_of || '',
      response_read_error: fixture.response_read_error || '',
      outreach_read_error: fixture.outreach_read_error || '',
      initialResponseRows: (fixture.initialResponseRows || []).map((partial) =>
        rowWithDefaults(RESPONSE_COLUMNS, partial),
      ),
      initialOutreachRows: (fixture.initialOutreachRows || []).map((partial) =>
        rowWithDefaults(OUTREACH_COLUMNS, partial),
      ),
      expected: Object.assign({}, fixture.expected || {}),
    };
  });
}

module.exports = {
  RESP_RECON_NAMESPACE,
  RESP_RECON_REGEX,
  FIXTURES_PATH,
  loadResponseReconcileFixtures,
  rowWithDefaults,
};