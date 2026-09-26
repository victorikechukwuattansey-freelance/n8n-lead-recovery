'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { APPROVED_COLUMNS } = require('./schema');
const { OUTREACH_COLUMNS } = require('./reconcile');

const EXECUTION_NAMESPACE = 'TEST-EXEC';
const EXECUTION_REGEX = /^TEST-EXEC-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'execution-fixtures.json');

const DEFAULT_EXPECTED = {
  status: 'COMPLETED',
  approved_total: 0,
  queue_total: 0,
  ready_candidates: 0,
  executed_attempted: 0,
  executed_succeeded: 0,
  executed_failed: 0,
  executed_skipped: 0,
  executed_rejected: 0,
  duplicate_suppressed: 0,
  log_rows_written: 0,
  provider_calls: 0,
};

const DEFAULT_RUN = {
  mode: 'DRY_RUN',
  provider: 'NOT_CONFIGURED',
};

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function runWithDefaults(run) {
  return { mode: DEFAULT_RUN.mode, provider: DEFAULT_RUN.provider, ...(run || {}) };
}

function loadExecutionFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== EXECUTION_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${EXECUTION_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!EXECUTION_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${EXECUTION_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      run: runWithDefaults(fixture.run),
      read_errors: fixture.read_errors || {},
      message_variants: fixture.message_variants || {},
      approvedRows: (fixture.approved || []).map((partial) => rowWithDefaults(APPROVED_COLUMNS, partial)),
      outreachRows: (fixture.outreach || []).map((partial) => rowWithDefaults(OUTREACH_COLUMNS, partial)),
      expected: Object.assign({}, DEFAULT_EXPECTED, fixture.expected || {}),
    };
  });
}

module.exports = { EXECUTION_NAMESPACE, EXECUTION_REGEX, FIXTURES_PATH, loadExecutionFixtures, rowWithDefaults };