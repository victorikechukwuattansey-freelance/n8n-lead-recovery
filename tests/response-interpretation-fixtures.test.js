'use strict';

/*
 * Phase 2 — Response Interpretation V1 fixture corpus test suite.
 *
 * Loads every fixture, derives reconciliation evidence by running the REAL
 * reconciliation engine over the fixture rows (or models the declared
 * read-failure / INCOMPLETE input directly), executes the REAL interpretation
 * engine, and asserts:
 *   - golden fidelity: actual (minus run identity fields) deep-equals the fixture
 *     `expected` block (status, summary, sources, sorted results, exceptions);
 *   - derived invariants: deterministic interpretation_id per response_id,
 *     canonical card/evidence keys, empty text_preview, interpretation version;
 *   - corpus coverage: every locked intent label, actionability, and confidence
 *     band is exercised, with strict-winner precedence, conflict, tie-break, and
 *     no-match semantics proven on specific fixtures;
 *   - confidence boundaries: exactly 0.40 (MEDIUM) and 0.70 (HIGH) are locked;
 *   - determinism: fixed clock, no dedup, order-independent results;
 *   - PII quarantine: raw response text, provider ids, emails, and phones never
 *     leak into any interpretation output.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadResponseInterpretationFixtures } = require('../src/response-interpretation-fixtures');
const {
  interpretResponses,
  interpretationIdFor,
  INTENT_LABELS,
  ACTIONABILITY,
  CONFIDENCE,
  INTERPRETATION_STATUS,
  EXCEPTION_TYPE,
  RULES,
} = require('../src/response-interpretation');
const { reconcileResponses } = require('../src/response-reconcile');

const FIXTURES = loadResponseInterpretationFixtures();

const FIXED_NOW = new Date('2026-09-12T09:00:00.000Z').getTime();
const FIXED_RUN_ID = `RESPINT-${String(FIXED_NOW).replace(/\D/g, '').slice(0, 14).padEnd(14, '0')}`;

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

function byId(id) {
  const fixture = FIXTURES.find((x) => x.id === id);
  assert.ok(fixture, `fixture ${id} must be loaded`);
  return fixture;
}

/**
 * Reconstructs the interpretation report exactly as the fixture golden expects:
 * reconciliation evidence comes from the real reconcileResponses over the
 * fixture's reconcile rows; read-failure / upstream-INCOMPLETE inputs are
 * modeled directly.
 */
function produceReport(fixture) {
  const base = {
    responseRows: fixture.initialResponseRows,
    responseLogReadError: fixture.responseReadError,
    reconciliationReadError: fixture.reconciliationReadError,
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  };

  if (fixture.upstreamIncomplete) {
    return interpretResponses({
      ...base,
      reconciliationReport: { status: 'INCOMPLETE', results: [] },
    });
  }

  if (fixture.responseReadError || fixture.reconciliationReadError) {
    return interpretResponses({
      ...base,
      reconciliationReport: { status: 'COMPLETED', results: [] },
    });
  }

  const recon = reconcileResponses({
    responseRows: fixture.reconcileResponseRows,
    outreachRows: fixture.reconcileOutreachRows,
    now: FIXED_NOW,
    runId: 'RESPRECON-FIXED',
  });
  return interpretResponses({ ...base, reconciliationReport: recon });
}

/* ------------------------------------------------------------------ */
/* Corpus / loader integrity                                           */
/* ------------------------------------------------------------------ */

test('fixture corpus loads with contiguous ids in the TEST-RESP-INT namespace', () => {
  assert.ok(FIXTURES.length >= 20, 'corpus should target ~24 fixtures; got ' + FIXTURES.length);
  FIXTURES.forEach((fixture, index) => {
    assert.equal(fixture.id, `TEST-RESP-INT-${String(index + 1).padStart(3, '0')}`, 'ids must be contiguous');
    assert.match(fixture.id, /^TEST-RESP-INT-\d+$/);
  });
  const ids = new Set(FIXTURES.map((f) => f.id));
  assert.equal(ids.size, FIXTURES.length, 'fixture ids must be unique');
});

test('every fixture carries response + outreach rows and a golden expected block', () => {
  for (const fixture of FIXTURES) {
    assert.ok(fixture.name, fixture.id + ': name');
    assert.ok(Array.isArray(fixture.initialResponseRows), fixture.id + ': initialResponseRows');
    assert.ok(Array.isArray(fixture.initialOutreachRows), fixture.id + ': initialOutreachRows');
    assert.ok(fixture.initialResponseRows.length > 0, fixture.id + ': at least one response row');
    assert.equal(typeof fixture.expected, 'object', fixture.id + ': expected');
    assert.equal(typeof fixture.expected.status, 'string', fixture.id + ': expected.status');
  }
});

/* ------------------------------------------------------------------ */
/* Golden fidelity — one report per fixture, full deep compare         */
/* ------------------------------------------------------------------ */

for (const fixture of FIXTURES) {
  test(`${fixture.id} ${fixture.name} — golden output matches the engine byte-for-byte`, () => {
    const report = produceReport(fixture);

    assert.equal(report.status, fixture.expected.status, 'status');
    assert.deepEqual(stripRuntime(report.summary), fixture.expected.summary, 'summary');
    assert.deepEqual(stripRuntime(report.sources), fixture.expected.sources, 'sources');
    assert.deepEqual(stripRuntime(report.exceptions), fixture.expected.exceptions, 'exceptions');
    assert.deepEqual(stripRuntime(report.results), fixture.expected.results, 'results');
    assert.equal(report.exceptions.length, fixture.expected.exceptions.length);

    const card = report.results[0];
    if (card && card.interpretation_status === INTERPRETATION_STATUS.INTERPRETED) {
      assert.equal(card.interpretation_id, interpretationIdFor(card.response_id));
      assert.equal(card.interpretation_version, 'RESP-INT-V1');
      assert.equal(card.text_preview, '');
      assert.ok(
        Number.isFinite(card.intent_confidence) && card.intent_confidence >= 0 && card.intent_confidence <= 1,
        'confidence in [0,1]',
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* Derived card invariants                                             */
/* ------------------------------------------------------------------ */

test('every card exposes only the canonical safe keys with empty text_preview', () => {
  const canonical = [
    'interpretation_id', 'response_id', 'lead_id', 'outreach_id', 'channel',
    'response_status', 'reconciliation_status', 'interpretation_status', 'intent_label',
    'intent_confidence', 'confidence_band', 'actionability', 'recommended_action',
    'stop_contact', 'priority', 'actionable', 'matched_terms_total', 'clause_hits',
    'deciding_clause', 'conflict_detected', 'interpretation_version', 'evidence',
    'text_preview', 'reason', 'notes',
  ];
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    for (const card of report.results) {
      assert.deepEqual(Object.keys(card).sort(), canonical.slice().sort(), `${fixture.id}:${card.response_id} card keys`);
      assert.equal(card.text_preview, '', `${fixture.id}:${card.response_id} text_preview`);
      assert.equal(card.interpretation_version, 'RESP-INT-V1', `${fixture.id}:${card.response_id} version`);
      for (const entry of card.evidence) {
        assert.deepEqual(
          Object.keys(entry).sort(),
          ['clause', 'phrase', 'polarity', 'rule_id', 'weight'].sort(),
          `${fixture.id}:${card.response_id} evidence keys`,
        );
        assert.ok(RULES.some((r) => r.id === entry.rule_id), `${fixture.id}: unknown rule id ${entry.rule_id}`);
      }
    }
  }
});

test('interpretation_id is deterministic and derived from response_id + version', () => {
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    for (const card of report.results) {
      if (card.interpretation_status !== INTERPRETATION_STATUS.INTERPRETED) {
        assert.equal(card.interpretation_id, '', `${fixture.id}:${card.response_id} skipped has no id`);
        continue;
      }
      assert.equal(card.interpretation_id, interpretationIdFor(card.response_id), fixture.id + ':' + card.response_id);
      assert.match(card.interpretation_id, /^INTERP-[0-9a-f]{8}$/);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Corpus coverage: taxonomy, actionability, confidence bands          */
/* ------------------------------------------------------------------ */

test('every locked intent label is reachable, with at least one unambiguous non-conflict example', () => {
  const seen = new Set();
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    for (const card of report.results) {
      if (card.interpretation_status === INTERPRETATION_STATUS.INTERPRETED && card.intent_label) {
        if (!card.conflict_detected) seen.add(card.intent_label);
      }
    }
  }
  for (const label of INTENT_LABELS) {
    assert.ok(seen.has(label), 'taxonomy label not exercised unambiguously: ' + label);
  }
});

test('every actionability value and every confidence band is exercised', () => {
  const actions = new Set();
  const bands = new Set();
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    for (const card of report.results) {
      if (card.interpretation_status === INTERPRETATION_STATUS.INTERPRETED) {
        if (card.actionability) actions.add(card.actionability);
        if (card.confidence_band) bands.add(card.confidence_band);
      }
    }
  }
  for (const action of Object.values(ACTIONABILITY)) {
    assert.ok(actions.has(action), 'actionability not exercised: ' + action);
  }
  for (const band of Object.values(CONFIDENCE)) {
    assert.ok(bands.has(band), 'confidence band not exercised: ' + band);
  }
});

test('the corpus exercises every interpretation exception category together', () => {
  const categories = new Set();
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    for (const e of report.exceptions) categories.add(e.category);
  }
  for (const type of Object.values(EXCEPTION_TYPE)) {
    assert.ok(categories.has(type), 'exception category not exercised: ' + type);
  }
});

/* ------------------------------------------------------------------ */
/* Precedence, conflict, and tie-break proofs                          */
/* ------------------------------------------------------------------ */

test('OPT_OUT outranks positive conversational evidence even when outscored (009)', () => {
  const card = produceReport(byId('TEST-RESP-INT-009')).results[0];
  assert.equal(card.intent_label, 'OPT_OUT');
  assert.equal(card.deciding_clause, 'OPT_OUT');
  assert.equal(card.stop_contact, true);
  assert.equal(card.actionability, 'HARD_STOP');
  assert.equal(card.priority, 'HIGH');
  assert.ok(card.evidence.some((e) => e.rule_id === 'OPT-OUT-01'));
  assert.ok(card.evidence.some((e) => e.rule_id === 'INST-01'));
});

test('mechanical UNDELIVERABLE outranks conversational evidence (010)', () => {
  const card = produceReport(byId('TEST-RESP-INT-010')).results[0];
  assert.equal(card.intent_label, 'UNDELIVERABLE');
  assert.equal(card.deciding_clause, 'UNDELIVERABLE');
  assert.ok(card.evidence.some((e) => e.rule_id === 'UNDELIVERABLE-01'));
  assert.ok(card.evidence.some((e) => e.rule_id === 'INST-01'));
  assert.equal(card.confidence_band, 'MEDIUM');
});

test('mechanical SPAM outranks conversational and LOW band forces MANUAL_REVIEW (011)', () => {
  const card = produceReport(byId('TEST-RESP-INT-011')).results[0];
  assert.equal(card.intent_label, 'SPAM_OR_AUTOMATED');
  assert.equal(card.deciding_clause, 'SPAM_OR_AUTOMATED');
  assert.ok(card.evidence.some((e) => e.rule_id === 'SPAM-01'));
  assert.ok(card.evidence.some((e) => e.rule_id === 'INST-01'));
  assert.equal(card.confidence_band, 'LOW');
  assert.equal(card.actionability, 'MANUAL_REVIEW', 'LOW band outranks label-driven NO_ACTION');
});

test('positive + negative conversational evidence resolves to NO_INTENT conflict (012)', () => {
  const card = produceReport(byId('TEST-RESP-INT-012')).results[0];
  assert.equal(card.intent_label, 'NO_INTENT');
  assert.equal(card.deciding_clause, 'CONFLICT');
  assert.equal(card.conflict_detected, true);
  assert.equal(card.actionability, 'MANUAL_REVIEW');
  assert.ok(card.notes.includes('conflicting conversational clauses'));
});

test('weak multi-signal tie resolves deterministically via tie-break order (013)', () => {
  const card = produceReport(byId('TEST-RESP-INT-013')).results[0];
  assert.equal(card.intent_label, 'OBJECTION', 'tie-break order locks OBJECTION over RESPOND');
  assert.equal(card.deciding_clause, 'OBJECTION');
  assert.equal(card.confidence_band, 'LOW');
});

test('no matched rules is NO_INTENT classification, never an error (008)', () => {
  const card = produceReport(byId('TEST-RESP-INT-008')).results[0];
  assert.equal(card.intent_label, 'NO_INTENT');
  assert.equal(card.deciding_clause, 'NO_INTENT');
  assert.equal(card.conflict_detected, false);
  assert.equal(card.intent_confidence, 0);
  assert.equal(card.actionability, 'MANUAL_REVIEW');
});

/* ------------------------------------------------------------------ */
/* Confidence boundary locks                                           */
/* ------------------------------------------------------------------ */

test('confidence boundaries 0.40 (MEDIUM) and 0.70 (HIGH) are locked exactly', () => {
  const medium = produceReport(byId('TEST-RESP-INT-014')).results[0];
  assert.equal(medium.intent_confidence, 0.4);
  assert.equal(medium.confidence_band, 'MEDIUM');
  assert.equal(medium.intent_label, 'QUESTION');

  const mechanicalMedium = produceReport(byId('TEST-RESP-INT-010')).results[0];
  assert.equal(mechanicalMedium.intent_confidence, 0.4);
  assert.equal(mechanicalMedium.confidence_band, 'MEDIUM');

  const high = produceReport(byId('TEST-RESP-INT-015')).results[0];
  assert.equal(high.intent_confidence, 0.7);
  assert.equal(high.confidence_band, 'HIGH');
  assert.equal(high.intent_label, 'QUESTION');

  const low = produceReport(byId('TEST-RESP-INT-013')).results[0];
  assert.ok(low.intent_confidence < 0.4, 'LOW boundary is strictly below 0.40');
  assert.equal(low.confidence_band, 'LOW');
});

/* ------------------------------------------------------------------ */
/* Reconciliation-state coverage                                       */
/* ------------------------------------------------------------------ */

test('reconciliation states drive the locked actionability mapping', () => {
  const verified = produceReport(byId('TEST-RESP-INT-001')).results[0];
  assert.equal(verified.reconciliation_status, 'VERIFIED');
  assert.equal(verified.actionability, 'AUTO_REPLY');

  const violation = produceReport(byId('TEST-RESP-INT-018')).results[0];
  assert.equal(violation.reconciliation_status, 'VIOLATION');
  assert.equal(violation.actionability, 'MANUAL_REVIEW');
  assert.equal(violation.priority, 'HIGH');

  const notVerifiable = produceReport(byId('TEST-RESP-INT-019')).results[0];
  assert.equal(notVerifiable.reconciliation_status, 'NOT_VERIFIABLE');
  assert.equal(notVerifiable.actionability, 'MANUAL_REVIEW');
  assert.equal(notVerifiable.priority, 'MEDIUM');

  const unmatched = produceReport(byId('TEST-RESP-INT-017')).results[0];
  assert.equal(unmatched.reconciliation_status, 'NOT_VERIFIABLE');
  assert.equal(unmatched.actionable, false, 'UNMATCHED responses are never actionable');
  assert.ok(unmatched.notes.includes('unmatched response'));

  const missing = produceReport(byId('TEST-RESP-INT-020'));
  assert.equal(missing.results[0].reconciliation_status, 'NOT_VERIFIABLE');
  assert.ok(missing.exceptions.some((e) => e.category === 'MISSING_RECONCILIATION_EVIDENCE'));
});

/* ------------------------------------------------------------------ */
/* Skip edges and read failures                                        */
/* ------------------------------------------------------------------ */

test('empty text and non-canonical status rows are SKIPPED, never classified', () => {
  for (const id of ['TEST-RESP-INT-022', 'TEST-RESP-INT-023']) {
    const fixture = byId(id);
    const report = produceReport(fixture);
    const card = report.results[0];
    assert.equal(card.interpretation_status, 'SKIPPED', id);
    assert.equal(card.intent_label, '', id);
    assert.equal(card.intent_confidence, null, id);
    assert.equal(card.evidence.length, 0, id);
    assert.equal(report.summary.interpreted_records, 0, id);
    assert.equal(report.summary.skipped_records, 1, id);
    assert.equal(report.summary.exception_count, 1, id);
    assert.ok(report.exceptions.some((e) => e.category === 'INVALID_RESPONSE_RECORD'), id);
  }
});

test('read failure paths yield INCOMPLETE with null metrics and READ_FAILURE', () => {
  for (const id of ['TEST-RESP-INT-024', 'TEST-RESP-INT-025', 'TEST-RESP-INT-026']) {
    const report = produceReport(byId(id));
    assert.equal(report.status, 'INCOMPLETE', id);
    assert.equal(report.results.length, 0, id);
    assert.equal(report.summary.exception_count, 1, id);
    assert.equal(report.exceptions[0].category, 'READ_FAILURE', id);
    assert.equal(report.exceptions[0].severity, 'ERROR', id);
    for (const field of ['response_records', 'interpreted_records', 'coverage_rate']) {
      assert.equal(report.summary[field], null, `${id}: ${field} null`);
    }
    assert.ok(!report.sources.response_log_ok || !report.sources.reconciliation_ok, id);
  }
});

/* ------------------------------------------------------------------ */
/* Duplicates and determinism                                          */
/* ------------------------------------------------------------------ */

test('duplicate idempotency keys are never deduped by interpretation (021)', () => {
  const report = produceReport(byId('TEST-RESP-INT-021'));
  assert.equal(report.results.length, 2);
  assert.deepEqual(
    report.results.map((c) => c.interpretation_status),
    ['INTERPRETED', 'INTERPRETED'],
  );
  assert.deepEqual(
    report.results.map((c) => c.intent_label),
    ['RESPOND', 'NOT_INTERESTED'],
  );
  assert.equal(report.summary.interpreted_records, 2);
});

test('interpretation output is deterministic for repeated identical input', () => {
  const a = produceReport(byId('TEST-RESP-INT-001'));
  const b = produceReport(byId('TEST-RESP-INT-001'));
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('row order never changes interpretation output (027 vs 016)', () => {
  const reversed = byId('TEST-RESP-INT-027');
  const forwardFixture = byId('TEST-RESP-INT-016');
  assert.equal(reversed.reorder_of, 'TEST-RESP-INT-016');
  const forward = produceReport(forwardFixture);
  const backward = produceReport(reversed);
  assert.deepEqual(stripRuntime(forward), stripRuntime(backward));
  assert.equal(reversed.initialResponseRows.length, forwardFixture.initialResponseRows.length);
});

test('results are always sorted by response_id ascending', () => {
  for (const fixture of FIXTURES) {
    if (produceReport(fixture).results.length < 2) continue;
    const ids = produceReport(fixture).results.map((c) => c.response_id);
    const sorted = ids.slice().sort();
    assert.deepEqual(ids, sorted, fixture.id + ' result ordering');
  }
});

/* ------------------------------------------------------------------ */
/* PII / safety quarantine                                             */
/* ------------------------------------------------------------------ */

test('no raw response text, provider ids, emails, or phones leak into any report', () => {
  for (const fixture of FIXTURES) {
    const report = produceReport(fixture);
    const raw = JSON.stringify(report);

    assert.ok(!raw.includes('"response_text":'), `${fixture.id}: response_text data key`);
    assert.ok(!raw.includes('"provider_message_id":'), `${fixture.id}: provider_message_id data key`);
    assert.ok(!raw.includes('pmsg-'), `${fixture.id}: provider message id value`);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(raw), `${fixture.id}: email address`);
    assert.ok(!raw.includes('+1555'), `${fixture.id}: phone number`);
    assert.ok(!raw.includes('gmail'), `${fixture.id}: source provider value`);
    assert.ok(!raw.includes('secret note'), `${fixture.id}: raw body text`);

    const keyUsages = raw.split('response_text').length - 1;
    if (keyUsages > 0) {
      assert.ok(
        raw.includes('empty response_text'),
        `${fixture.id}: the only allowed 'response_text' text is the locked skip reason`,
      );
    }

    for (const card of report.results) {
      assert.equal(card.text_preview, '', `${fixture.id}:${card.response_id} text_preview`);
    }
  }
});