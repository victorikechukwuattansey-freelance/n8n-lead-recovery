'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { OUTREACH_COLUMNS } = require('./reconcile');

const EXEC_RECON_NAMESPACE = 'TEST-EXEC-RECON';
const EXEC_RECON_REGEX = /^TEST-EXEC-RECON-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'execution-recon-fixtures.json');

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function loadExecutionReconFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== EXEC_RECON_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${EXEC_RECON_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!EXEC_RECON_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${EXEC_RECON_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      evidence_available: fixture.evidence_available === undefined ? true : Boolean(fixture.evidence_available),
      read_errors: fixture.read_errors || {},
      evidence: fixture.evidence || [],
      reorder_of: fixture.reorder_of || '',
      outreachRows: (fixture.outreach || []).map((partial) => rowWithDefaults(OUTREACH_COLUMNS, partial)),
      expected: Object.assign({}, fixture.expected || {}),
    };
  });
}

module.exports = { EXEC_RECON_NAMESPACE, EXEC_RECON_REGEX, FIXTURES_PATH, loadExecutionReconFixtures, rowWithDefaults };