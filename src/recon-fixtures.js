'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { APPROVED_COLUMNS } = require('./schema');
const { OUTREACH_COLUMNS } = require('./reconcile');

const RECON_NAMESPACE = 'TEST-RECON';
const RECON_REGEX = /^TEST-RECON-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'recon-fixtures.json');

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function loadReconFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== RECON_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${RECON_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!RECON_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${RECON_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      approvedRows: (fixture.approved || []).map((partial) => rowWithDefaults(APPROVED_COLUMNS, partial)),
      outreachRows: (fixture.outreach || []).map((partial) => rowWithDefaults(OUTREACH_COLUMNS, partial)),
      expected: fixture.expected || {},
    };
  });
}

module.exports = { RECON_NAMESPACE, RECON_REGEX, FIXTURES_PATH, loadReconFixtures, rowWithDefaults };