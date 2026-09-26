'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { APPROVED_COLUMNS } = require('./schema');
const { OUTREACH_COLUMNS } = require('./reconcile');

const QUEUE_NAMESPACE = 'TEST-QUEUE';
const QUEUE_REGEX = /^TEST-QUEUE-\d+$/;

const FIXTURES_PATH = path.join(__dirname, '..', 'fixtures', 'queue-fixtures.json');

const DEFAULT_EXPECTED = {
  status: 'COMPLETED',
  approved_total: 0,
  queue_total: 0,
  ready_count: 0,
  not_ready_count: 0,
  blocked_count: 0,
  email_ready_count: 0,
  call_ready_count: 0,
  outreach_total: 0,
  duplicate_approval_ids: 0,
  malformed_approvals: 0,
  orphan_outreach: 0,
  malformed_outreach: 0,
  history_attached: 0,
  exception_count: 0,
};

function rowWithDefaults(columns, partial) {
  const row = Object.fromEntries(columns.map((column) => [column, '']));
  Object.assign(row, partial || {});
  return row;
}

function cleanTransition(transition) {
  if (!transition || (!transition.approved && !transition.outreach && !transition.expected)) return null;
  return {
    approvedRows: (transition.approved || []).map((partial) => rowWithDefaults(APPROVED_COLUMNS, partial)),
    outreachRows: (transition.outreach || []).map((partial) => rowWithDefaults(OUTREACH_COLUMNS, partial)),
    expected: transition.expected || {},
  };
}

function loadQueueFixtures() {
  const raw = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  if (raw._meta.namespace !== QUEUE_NAMESPACE) {
    throw new Error(`fixture namespace mismatch: expected ${QUEUE_NAMESPACE}`);
  }
  return raw.fixtures.map((fixture) => {
    if (!QUEUE_REGEX.test(fixture.id)) {
      throw new Error(`fixture id is not in ${QUEUE_NAMESPACE} namespace: ${fixture.id}`);
    }
    return {
      id: fixture.id,
      name: fixture.name,
      note: fixture.note || '',
      approvedRows: (fixture.approved || []).map((partial) => rowWithDefaults(APPROVED_COLUMNS, partial)),
      outreachRows: (fixture.outreach || []).map((partial) => rowWithDefaults(OUTREACH_COLUMNS, partial)),
      expected: Object.assign({}, DEFAULT_EXPECTED, fixture.expected || {}),
      transition: cleanTransition(fixture.transition),
    };
  });
}

module.exports = { QUEUE_NAMESPACE, QUEUE_REGEX, FIXTURES_PATH, loadQueueFixtures, rowWithDefaults };