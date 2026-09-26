'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RUN_LABEL,
  INTERPRETATION_VERSION,
  SUPPORTED_CHANNELS,
  RESPONSE_STATUSES,
  STATUS,
  INTERPRETATION_STATUS,
  INTENT_LABELS,
  ACTIONABILITY,
  CONFIDENCE,
  CONFIDENCE_THRESHOLDS,
  EXCEPTION_TYPE,
  SEVERITY,
  TIE_BREAK_ORDER,
  RULES,
  fnv1a32Hex,
  interpretationIdFor,
  classifyIntent,
  confidenceBandFor,
  isInterpretable,
  actionabilityFor,
  buildCard,
  normalizeReconciliation,
  interpretResponses,
} = require('../src/response-interpretation');

const { reconcileResponses } = require('../src/response-reconcile');

const FIXED_NOW = new Date('2026-09-12T09:00:00.000Z').getTime();
const FIXED_RUN_ID = `RESPINT-${String(FIXED_NOW).replace(/\D/g, '').slice(0, 14).padEnd(14, '0')}`;

/* ------------------------------------------------------------------ */
/* Row / evidence builders                                            */
/* ------------------------------------------------------------------ */

function row(overrides = {}) {
  return {
    response_id: 'RES-001',
    idempotency_key: 'msg-001::email',
    lead_id: 'L-001',
    outreach_id: 'EX-L-001-email',
    channel: 'email',
    response_status: 'CAPTURED',
    response_text: 'Yes, sounds good!',
    ...overrides,
  };
}

function reconCard(overrides = {}) {
  return {
    response_id: 'RES-001',
    lead_id: 'L-001',
    outreach_id: 'EX-L-001-email',
    channel: 'email',
    response_status: 'CAPTURED',
    reconciliation_status: 'VERIFIED',
    relationship: 'outreach_id resolves to exactly one confirmed Outreach Log attempt',
    reason: 'Response references an Outreach Log attempt whose OUTREACH identifier resolves exactly.',
    ...overrides,
  };
}

function reconcileReport(results, overrides = {}) {
  return {
    run_id: 'RESPRECON-00000000000000',
    run_at: new Date(FIXED_NOW).toISOString(),
    detected_at: new Date(FIXED_NOW).toISOString(),
    status: 'COMPLETED',
    sources: {
      response_log_ok: true,
      response_log_read_error: '',
      outreach_log_ok: true,
      outreach_log_read_error: '',
    },
    summary: {},
    results,
    exceptions: [],
    ...overrides,
  };
}

function run(rows, report, overrides = {}) {
  return interpretResponses({
    responseRows: rows,
    reconciliationReport: report,
    now: FIXED_NOW,
    ...overrides,
  });
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

/* ------------------------------------------------------------------ */
/* Contract surface                                                    */
/* ------------------------------------------------------------------ */

test('engine exports the interpretation vocabulary and versioning', () => {
  assert.equal(RUN_LABEL, 'RESPINT');
  assert.equal(INTERPRETATION_VERSION, 'RESP-INT-V1');
  assert.deepEqual(SUPPORTED_CHANNELS, ['email', 'call']);
  assert.deepEqual(RESPONSE_STATUSES, ['CAPTURED', 'UNMATCHED']);
  assert.equal(STATUS.COMPLETED, 'COMPLETED');
  assert.equal(STATUS.INCOMPLETE, 'INCOMPLETE');
  assert.equal(INTERPRETATION_STATUS.INTERPRETED, 'INTERPRETED');
  assert.equal(INTERPRETATION_STATUS.SKIPPED, 'SKIPPED');
  assert.deepEqual(INTENT_LABELS, [
    'RESPOND', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED', 'OPT_OUT',
    'UNDELIVERABLE', 'SPAM_OR_AUTOMATED', 'NO_INTENT',
  ]);
  for (const value of ['HARD_STOP', 'AUTO_REPLY', 'MANUAL_REVIEW', 'NO_ACTION']) {
    assert.equal(ACTIONABILITY[value], value);
  }
  for (const value of ['HIGH', 'MEDIUM', 'LOW']) {
    assert.equal(CONFIDENCE[value], value);
  }
  assert.equal(CONFIDENCE_THRESHOLDS.HIGH, 0.7);
  assert.equal(CONFIDENCE_THRESHOLDS.MEDIUM, 0.4);
  assert.equal(EXCEPTION_TYPE.INVALID_RESPONSE_RECORD, 'INVALID_RESPONSE_RECORD');
  assert.equal(EXCEPTION_TYPE.MISSING_RECONCILIATION_EVIDENCE, 'MISSING_RECONCILIATION_EVIDENCE');
  assert.equal(EXCEPTION_TYPE.READ_FAILURE, 'READ_FAILURE');
  assert.equal(SEVERITY.ERROR, 'ERROR');
  assert.equal(SEVERITY.WARNING, 'WARNING');
  assert.deepEqual(TIE_BREAK_ORDER, ['NOT_INTERESTED', 'QUESTION', 'OBJECTION', 'RESPOND']);
});

test('rule table is ordered, named, versionable, and each rule carries the evidence contract', () => {
  assert.ok(RULES.length >= 8, 'at least one rule per label');
  const clauses = new Set(RULES.map((r) => r.clause));
  for (const label of INTENT_LABELS.slice(0, 7)) {
    assert.ok(clauses.has(label), 'no rule for clause ' + label);
  }
  for (const rule of RULES) {
    assert.match(rule.id, /^[A-Z-]+-\d{2}$/, rule.id + ' must be a versioned rule id');
    assert.ok(Number.isInteger(rule.weight) && rule.weight > 0, rule.id + ': positive integer weight');
    assert.ok(['positive', 'negative', 'question', 'mechanical', 'opt_out'].includes(rule.polarity), rule.id + ': polarity');
    assert.ok((Array.isArray(rule.phrases) && rule.phrases.length > 0) || rule.regex, rule.id + ': phrases or regex');
    if (rule.regex) {
      assert.equal(typeof rule.regex, 'string', rule.id + ': regex pattern string');
      assert.equal(typeof rule.regexPhrase, 'string', rule.id + ': regexPhrase label for safe evidence');
    }
    for (const phrase of rule.phrases || []) {
      assert.ok(phrase.length > 2, rule.id + ': phrase "' + phrase + '" is too short to be safe');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Classification — one label per intent                               */
/* ------------------------------------------------------------------ */

test('every locked label is reachable by classification', () => {
  const cases = [
    ['RESPOND', 'yes, please send me the details right away'],
    ['QUESTION', 'can you tell me what the pricing is for 2026?'],
    ['OBJECTION', 'too expensive for us right now, no budget this quarter'],
    ['NOT_INTERESTED', 'not interested, no thanks'],
    ['OPT_OUT', 'please unsubscribe me from all mailing lists'],
    ['UNDELIVERABLE', 'delivery status notification: message could not be delivered'],
    ['SPAM_OR_AUTOMATED', 'you are receiving this email because you subscribed to our newsletter'],
    ['NO_INTENT', 'lorem ipsum dolor sit amet consectetur'],
  ];
  for (const [expected, text] of cases) {
    const parsed = classifyIntent(text);
    assert.equal(parsed.label, expected, text + ': expected ' + expected + ', got ' + parsed.label);
    assert.ok(parsed.confidence >= 0 && parsed.confidence <= 1, text + ': confidence in [0,1]');
  }
});

test('OPT_OUT takes precedence over every conversational clause', () => {
  const parsed = classifyIntent("I'm actually not interested, please unsubscribe me immediately");
  assert.equal(parsed.label, 'OPT_OUT');
  const sw = classifyIntent('yes sounds good but take me off the list');
  assert.equal(sw.label, 'OPT_OUT');
});

test('mechanical clauses (UNDELIVERABLE, SPAM) precede conversational evidence', () => {
  assert.equal(classifyIntent('undeliverable: mailbox full. yes I am interested').label, 'UNDELIVERABLE');
  assert.equal(classifyIntent('This is a sponsored message. yes please send details').label, 'SPAM_OR_AUTOMATED');
});

test('conflicting positive and negative evidence resolves to NO_INTENT with conflict flag', () => {
  const parsed = classifyIntent('sounds good but not interested');
  assert.equal(parsed.label, 'NO_INTENT');
  assert.equal(parsed.decidingClause, 'CONFLICT');
  assert.equal(parsed.conflict, true);
});

test('NO_INTENT is a classification, not a failure: zero confidence and LOW band', () => {
  const parsed = classifyIntent('zxqwsomething unrelated');
  assert.equal(parsed.label, 'NO_INTENT');
  assert.equal(parsed.decidingClause, 'NO_INTENT');
  assert.equal(parsed.conflict, false);
  assert.equal(parsed.confidence, 0);
  assert.equal(parsed.band, 'LOW');
});

test('confidence bands follow the locked thresholds', () => {
  assert.equal(confidenceBandFor(0.99), 'HIGH');
  assert.equal(confidenceBandFor(0.7), 'HIGH');
  assert.equal(confidenceBandFor(0.69), 'MEDIUM');
  assert.equal(confidenceBandFor(0.4), 'MEDIUM');
  assert.equal(confidenceBandFor(0.39), 'LOW');
  assert.equal(confidenceBandFor(0), 'LOW');
  assert.equal(confidenceBandFor(NaN), 'LOW');
});

test('matched regex questions and phrase weights compose deterministically', () => {
  const one = classifyIntent('what?');
  assert.equal(one.label, 'QUESTION');
  assert.equal(one.clauseHits.QUESTION, 2, "regex '?' plus 'what' phrase");
  assert.equal(one.matchedTermsTotal, 2);
  assert.equal(one.evidence[0].weight, 2);
  assert.ok(one.evidence.some((e) => e.rule_id === 'CSQ-02' && e.phrase === '?'));
});

/* ------------------------------------------------------------------ */
/* Actionability and status mapping                                    */
/* ------------------------------------------------------------------ */

test('OPT_OUT maps to HARD_STOP with stop_contact true and HIGH priority', () => {
  const report = run([row({ response_text: 'please unsubscribe me' })], reconcileReport([reconCard()]));
  assert.equal(report.status, 'COMPLETED');
  const card = report.results[0];
  assert.equal(card.intent_label, 'OPT_OUT');
  assert.equal(card.actionability, 'HARD_STOP');
  assert.equal(card.stop_contact, true);
  assert.equal(card.priority, 'HIGH');
  assert.equal(report.summary.stop_contact_count, 1);
});

test('LOW confidence forces MANUAL_REVIEW regardless of label', () => {
  const lowText = 'what and when? yes go ahead, budget, no time, maybe later';
  const parsed = classifyIntent(lowText);
  assert.equal(parsed.band, 'LOW', 'fixture must reach LOW band by construction (got ' + parsed.band + ')');
  const card = actionabilityFor({
    label: parsed.label,
    band: parsed.band,
    reconciliationStatus: 'VERIFIED',
  });
  assert.equal(card.actionability, 'MANUAL_REVIEW');
});

test('VIOLATION maps to MANUAL_REVIEW with HIGH priority', () => {
  const report = run(
    [row({ response_id: 'RES-V', response_text: 'yes please send details' })],
    reconcileReport([reconCard({ response_id: 'RES-V', reconciliation_status: 'VIOLATION' })]),
  );
  const card = report.results[0];
  assert.equal(card.reconciliation_status, 'VIOLATION');
  assert.equal(card.actionability, 'MANUAL_REVIEW');
  assert.equal(card.priority, 'HIGH');
});

test('NOT_VERIFIABLE maps to MANUAL_REVIEW', () => {
  const report = run(
    [row({ response_id: 'RES-NV', response_text: 'yes please send details' })],
    reconcileReport([reconCard({ response_id: 'RES-NV', reconciliation_status: 'NOT_VERIFIABLE' })]),
  );
  const card = report.results[0];
  assert.equal(card.actionability, 'MANUAL_REVIEW');
  assert.equal(card.priority, 'MEDIUM');
});

test('UNMATCHED responses are interpreted but never actionable', () => {
  const report = run(
    [row({ response_id: 'RES-U', response_status: 'UNMATCHED', response_text: 'yes sounds good' })],
    reconcileReport([reconCard({ response_id: 'RES-U', response_status: 'UNMATCHED', reconciliation_status: 'NOT_VERIFIABLE' })]),
  );
  assert.equal(report.status, 'COMPLETED');
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'INTERPRETED');
  assert.equal(card.intent_label, 'RESPOND');
  assert.equal(card.actionable, false);
  assert.ok(card.notes.includes('unmatched response'));
});

test('VERIFIED HIGH conversational labels map to AUTO_REPLY / NO_ACTION', () => {
  const cases = [
    ['RESPOND', 'yes please send details', 'AUTO_REPLY', true],
    ['QUESTION', 'what are the next steps?', 'AUTO_REPLY', true],
    ['OBJECTION', 'too expensive, what is the budget?', 'AUTO_REPLY', true],
    ['NOT_INTERESTED', 'not interested, no thanks', 'NO_ACTION', true],
    ['SPAM_OR_AUTOMATED', 'you are receiving this email because you subscribed', 'NO_ACTION', true],
  ];
  const rows = cases.map(([label, text], i) => ({
    response_id: `RES-A${i}`,
    idempotency_key: `k-a${i}::email`,
    lead_id: `L-A${i}`,
    outreach_id: `EX-L-A${i}-email`,
    channel: 'email',
    response_status: 'CAPTURED',
    response_text: text,
  }));
  const report = run(rows, reconcileReport(rows.map((r) => reconCard({ response_id: r.response_id }))));
  assert.equal(report.status, 'COMPLETED');
  for (let i = 0; i < cases.length; i += 1) {
    const [expectedLabel, , expectedAction, expectedActionable] = cases[i];
    const card = report.results.find((c) => c.response_id === `RES-A${i}`);
    assert.equal(card.intent_label, expectedLabel, `RES-A${i}: label`);
    assert.equal(card.actionability, expectedAction, `RES-A${i}: actionability`);
    assert.equal(card.actionable, expectedActionable, `RES-A${i}: actionable`);
    assert.equal(card.reconciliation_status, 'VERIFIED', `RES-A${i}: verified`);
  }
  assert.equal(report.summary.manual_review_count, 0, 'no verified high band row requires review');
});

/* ------------------------------------------------------------------ */
/* Skipping and eligibility                                            */
/* ------------------------------------------------------------------ */

test('empty response_text rows are SKIPPED, never classified', () => {
  const report = run([row({ response_id: 'RES-E', response_text: '   ' })], reconcileReport([reconCard({ response_id: 'RES-E' })]));
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'SKIPPED');
  assert.equal(card.intent_label, '');
  assert.equal(card.intent_confidence, null);
  assert.equal(card.confidence_band, '');
  assert.equal(card.actionability, '');
  assert.equal(report.summary.skipped_records, 1);
  assert.equal(report.summary.interpreted_records, 0);
});

test('missing response_id rows are SKIPPED with an INVALID_RESPONSE_RECORD exception', () => {
  const report = run([row({ response_id: '' })], reconcileReport([]));
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'SKIPPED');
  assert.equal(card.reason, 'skipped: missing response_id');
  const e = report.exceptions.find((x) => x.category === 'INVALID_RESPONSE_RECORD');
  assert.ok(e);
  assert.equal(e.severity, 'WARNING');
});

test('non-canonical response_status rows are SKIPPED (never force-classified)', () => {
  const report = run(
    [row({ response_id: 'RES-XX', response_status: 'PENDING' })],
    reconcileReport([reconCard({ response_id: 'RES-XX', response_status: 'PENDING' })]),
  );
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'SKIPPED');
  assert.ok(card.reason.includes('invalid response_status'));
});

test('unsupported channel rows are SKIPPED', () => {
  const report = run([row({ response_id: 'RES-SMS', channel: 'sms' })], reconcileReport([]));
  assert.equal(report.results[0].interpretation_status, 'SKIPPED');
});

test('missing reconciliation evidence treats the row as NOT_VERIFIABLE with warning', () => {
  const report = run([row({ response_id: 'RES-MISS', response_text: 'yes please send details' })], reconcileReport([]));
  const card = report.results[0];
  assert.equal(card.reconciliation_status, 'NOT_VERIFIABLE');
  assert.equal(card.interpretation_status, 'INTERPRETED');
  assert.equal(card.actionability, 'MANUAL_REVIEW');
  const e = report.exceptions.find((x) => x.category === 'MISSING_RECONCILIATION_EVIDENCE');
  assert.ok(e, 'missing reconciliation evidence must surface an exception');
  assert.equal(e.severity, 'WARNING');
  assert.equal(e.response_id, 'RES-MISS');
});

/* ------------------------------------------------------------------ */
/* Interpretation identity and determinism                             */
/* ------------------------------------------------------------------ */

test('interpretation_id is derived from response_id + interpretation_version', () => {
  const expected = `INTERP-${fnv1a32Hex('RES-001::RESP-INT-V1')}`;
  assert.equal(interpretationIdFor('RES-001'), expected);
  assert.match(expected, /^INTERP-[0-9a-f]{8}$/);
  const report = run([row()], reconcileReport([reconCard()]));
  assert.equal(report.results[0].interpretation_id, expected);
  assert.equal(report.results[0].interpretation_version, 'RESP-INT-V1');
});

test('interpretation is deterministic for identical inputs', () => {
  const rows = [
    row({ response_id: 'RES-D1', response_text: 'yes please send details' }),
    row({ response_id: 'RES-D2', response_text: 'not interested, no thanks' }),
    row({ response_id: 'RES-D3', response_text: 'please unsubscribe me' }),
  ];
  const rep = reconcileReport([
    reconCard({ response_id: 'RES-D1' }),
    reconCard({ response_id: 'RES-D2' }),
    reconCard({ response_id: 'RES-D3' }),
  ]);
  const a = run(rows, rep);
  const b = run(rows, rep);
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(stripRuntime(a.results[i]), stripRuntime(b.results[i]), 'row ' + i + ' deterministic');
  }
});

test('interpretation is order-independent on response rows and evidence', () => {
  const rows = [
    row({ response_id: 'RES-O1', response_text: 'yes please send details' }),
    row({ response_id: 'RES-O2', response_text: 'not interested' }),
  ];
  const rep = reconcileReport([reconCard({ response_id: 'RES-O1' }), reconCard({ response_id: 'RES-O2' })]);
  const forward = run(rows, rep);
  const backward = run(rows.slice().reverse(), reconcileReport(rep.results.slice().reverse()));
  assert.deepEqual(stripRuntime(forward), stripRuntime(backward));
});

test('different runId alters only run-identity fields, never interpretation identity', () => {
  const a = run([row()], reconcileReport([reconCard()]), { runId: 'RESPINT-MANUAL-1' });
  const b = run([row()], reconcileReport([reconCard()]), { runId: 'RESPINT-MANUAL-2' });
  assert.equal(a.results[0].interpretation_id, b.results[0].interpretation_id);
  assert.equal(a.results[0].response_id, b.results[0].response_id);
  assert.equal(a.run_id, 'RESPINT-MANUAL-1');
  assert.equal(b.run_id, 'RESPINT-MANUAL-2');
  const strippedA = stripRuntime(a.results);
  const strippedB = stripRuntime(b.results);
  assert.deepEqual(strippedA, strippedB);
});

test('run_id follows the RESPINT label with 14-digit second granularity', () => {
  const report = run([row()], reconcileReport([reconCard()]));
  assert.match(report.run_id, /^RESPINT-\d{14}$/);
  assert.equal(report.run_id, FIXED_RUN_ID);
  assert.equal(report.run_at, new Date(FIXED_NOW).toISOString());
  assert.equal(report.detected_at, new Date(FIXED_NOW).toISOString());
});

/* ------------------------------------------------------------------ */
/* Duplicates — no engine-level dedup                                  */
/* ------------------------------------------------------------------ */

test('duplicate idempotency keys are each interpreted from their own evidence (no engine dedup)', () => {
  const rows = [
    row({ response_id: 'RES-DUP1', idempotency_key: 'k-dup::email', response_text: 'yes please send details' }),
    row({ response_id: 'RES-DUP2', idempotency_key: 'k-dup::email', response_text: 'not interested, no thanks' }),
  ];
  const rep = reconcileReport([
    reconCard({ response_id: 'RES-DUP1', reconciliation_status: 'VERIFIED' }),
    reconCard({ response_id: 'RES-DUP2', reconciliation_status: 'VIOLATION' }),
  ]);
  const report = run(rows, rep);
  assert.equal(report.results.length, 2, 'the engine must never collapse duplicate rows');
  assert.deepEqual(
    report.results.map((c) => c.interpretation_status),
    ['INTERPRETED', 'INTERPRETED'],
  );
  assert.deepEqual(
    report.results.map((c) => c.intent_label),
    ['RESPOND', 'NOT_INTERESTED'],
  );
  assert.deepEqual(
    report.results.map((c) => c.reconciliation_status),
    ['VERIFIED', 'VIOLATION'],
  );
  assert.deepEqual(
    report.results.map((c) => c.actionability),
    ['AUTO_REPLY', 'MANUAL_REVIEW'],
  );
});

/* ------------------------------------------------------------------ */
/* Card contract and evidence safety                                   */
/* ------------------------------------------------------------------ */

const CARD_KEYS = [
  'interpretation_id', 'response_id', 'lead_id', 'outreach_id', 'channel',
  'response_status', 'reconciliation_status', 'interpretation_status', 'intent_label',
  'intent_confidence', 'confidence_band', 'actionability', 'recommended_action',
  'stop_contact', 'priority', 'actionable', 'matched_terms_total', 'clause_hits',
  'deciding_clause', 'conflict_detected', 'interpretation_version', 'evidence',
  'text_preview', 'reason', 'notes',
];

test('every card carries the complete canonical key set with stable defaults', () => {
  const rows = [
    row({ response_id: 'RES-C1', response_text: 'yes please send details' }),
    row({ response_id: 'RES-C2', response_text: '' }),
  ];
  const report = run(rows, reconcileReport([reconCard({ response_id: 'RES-C1' })]));
  assert.equal(report.results.length, 2);
  for (const card of report.results) {
    assert.deepEqual(Object.keys(card).sort(), CARD_KEYS.slice().sort(), card.response_id + ': card keys');
  }
  const skipped = report.results.find((c) => c.response_id === 'RES-C2');
  assert.equal(skipped.text_preview, '');
  assert.equal(skipped.interpretation_version, 'RESP-INT-V1');
  assert.equal(skipped.recommended_action, '');
  assert.equal(skipped.evidence.length, 0);
});

test('evidence carries only the safe static keys — never raw response material', () => {
  const text = 'yes please send details, and my email is agent@example.com (PII-MARKER-9F3A)';
  const report = run(
    [row({ response_id: 'RES-P', response_text: text })],
    reconcileReport([reconCard({ response_id: 'RES-P' })]),
  );
  const card = report.results[0];
  assert.ok(card.evidence.length > 0);
  for (const entry of card.evidence) {
    assert.deepEqual(Object.keys(entry).sort(), ['clause', 'phrase', 'polarity', 'rule_id', 'weight'].sort());
  }
});

test('raw response text, provider ids, and emails never leak into output', () => {
  const text = 'yes please send details for agent@example.com (PII-MARKER-9F3A) with important secret note';
  const report = run(
    [row({ response_id: 'RES-P', response_text: text })],
    reconcileReport([reconCard({ response_id: 'RES-P' })]),
  );
  const raw = JSON.stringify(report);
  assert.ok(raw.includes('RESPOND'), 'the static intent label must appear in the report');
  assert.ok(!raw.includes('PII-MARKER-9F3A'), 'raw example text must not leak');
  assert.ok(!raw.includes('agent@example.com'), 'email addresses must not leak');
  assert.ok(!raw.includes('important secret note'), 'raw response body must not leak');
  assert.ok(!raw.includes('response_text'), 'response_text key must not appear in cards/report');
  assert.ok(!raw.includes('provider_message_id'), 'provider_message_id must not appear');
});

test('exceptions carry the canonical envelope and never raw response text', () => {
  const report = run([row({ response_id: '' })], reconcileReport([]));
  assert.ok(report.exceptions.length > 0);
  for (const e of report.exceptions) {
    assert.deepEqual(
      Object.keys(e).sort(),
      ['category', 'channel', 'detected_at', 'evidence', 'lead_id', 'outreach_id', 'reason', 'response_id', 'run_id', 'severity'].sort(),
    );
    assert.ok(!JSON.stringify(e).includes('response_text'));
  }
});

/* ------------------------------------------------------------------ */
/* Report summary                                                      */
/* ------------------------------------------------------------------ */

test('summary aggregates by intent, confidence band, and actionability', () => {
  const rows = [
    row({ response_id: 'RES-S1', response_text: 'yes please send details' }),
    row({ response_id: 'RES-S2', response_text: 'yes sounds good, good luck' }),
    row({ response_id: 'RES-S3', response_text: 'what are the next steps?' }),
    row({ response_id: 'RES-S4', response_text: 'not interested, no thanks' }),
    row({ response_id: 'RES-S5', response_text: 'please unsubscribe me' }),
    row({ response_id: 'RES-S6', response_text: 'lorem ipsum whatever' }),
    row({ response_id: 'RES-S7', response_text: '   ' }),
  ];
  const rep = reconcileReport(
    rows.filter((r) => r.response_id !== 'RES-S7').map((r) => reconCard({ response_id: r.response_id })),
  );
  const report = run(rows, rep);
  const s = report.summary;
  assert.equal(s.response_records, 7);
  assert.equal(s.interpreted_records, 6);
  assert.equal(s.skipped_records, 1);
  assert.equal(s.by_intent.RESPOND, 2);
  assert.equal(s.by_intent.QUESTION, 1);
  assert.equal(s.by_intent.NOT_INTERESTED, 1);
  assert.equal(s.by_intent.OPT_OUT, 1);
  assert.equal(s.by_intent.NO_INTENT, 1);
  assert.equal(s.by_intent.UNDELIVERABLE, 0);
  assert.equal(s.by_intent.SPAM_OR_AUTOMATED, 0);
  assert.equal(s.by_intent.OBJECTION, 0);
  for (const label of INTENT_LABELS) {
    assert.equal(typeof s.by_intent[label], 'number', 'by_intent must expose every label: ' + label);
  }
  assert.ok(s.by_confidence_band.HIGH >= s.interpreted_records - 2);
  assert.equal(typeof s.by_confidence_band.MEDIUM, 'number');
  assert.equal(typeof s.by_confidence_band.LOW, 'number');
  assert.equal(s.by_actionability.HARD_STOP, 1);
  assert.equal(s.by_actionability.AUTO_REPLY, 3);
  assert.equal(s.by_actionability.MANUAL_REVIEW, 1);
  assert.equal(s.by_actionability.NO_ACTION, 1);
  assert.equal(s.stop_contact_count, 1);
  assert.equal(s.manual_review_count, 1);
  assert.equal(s.conflict_count, 0);
  assert.equal(s.coverage_rate, Number((6 / 7).toFixed(4)));
  assert.equal(s.exception_count, report.exceptions.length);
});

test('every by_confidence_band and by_actionability bucket is zero-initialized', () => {
  const report = run([], reconcileReport([]));
  assert.deepEqual(report.summary.by_confidence_band, { HIGH: 0, MEDIUM: 0, LOW: 0 });
  assert.deepEqual(report.summary.by_actionability, {
    HARD_STOP: 0, AUTO_REPLY: 0, MANUAL_REVIEW: 0, NO_ACTION: 0,
  });
  assert.equal(report.summary.coverage_rate, null, 'zero responses yields null coverage, never 0/0');
});

/* ------------------------------------------------------------------ */
/* Input safety                                                        */
/* ------------------------------------------------------------------ */

test('interpretResponses never mutates its inputs', () => {
  const rows = [
    row({ response_id: 'RES-M1', response_text: 'yes please send details' }),
    row({ response_id: 'RES-M2', response_text: 'please unsubscribe me' }),
  ];
  const rep = reconcileReport([reconCard({ response_id: 'RES-M1' }), reconCard({ response_id: 'RES-M2' })]);
  const rowsCopy = JSON.parse(JSON.stringify(rows));
  const repCopy = JSON.parse(JSON.stringify(rep));
  const frozenRows = rows.map((r) => Object.freeze(r));
  const frozenRep = Object.freeze(rep);
  const report = run(frozenRows, frozenRep);
  assert.deepEqual(rows, rowsCopy);
  assert.deepEqual(rep, repCopy);
  assert.equal(report.results.length, 2);
});

test('non-array / missing response rows are tolerated and yield a valid zero report', () => {
  const report = run(undefined, reconcileReport([]));
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.response_records, 0);
  assert.equal(report.summary.coverage_rate, null);
  assert.equal(report.results.length, 0);
});

/* ------------------------------------------------------------------ */
/* Read failure semantics                                              */
/* ------------------------------------------------------------------ */

test('a response log read error yields INCOMPLETE with null summary and READ_FAILURE', () => {
  const report = interpretResponses({
    responseRows: [row()],
    reconciliationReport: reconcileReport([reconCard()]),
    responseLogReadError: 'SheetNotFound',
    now: FIXED_NOW,
  });
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.results.length, 0);
  assert.equal(report.sources.response_log_ok, false);
  assert.equal(report.sources.response_log_read_error, 'SheetNotFound');
  for (const field of [
    'response_records', 'interpreted_records', 'skipped_records', 'by_intent',
    'by_confidence_band', 'by_actionability', 'stop_contact_count',
    'manual_review_count', 'conflict_count', 'coverage_rate',
  ]) {
    assert.equal(report.summary[field], null, field + ' must be null on read failure');
  }
  assert.equal(report.summary.exception_count, 1, 'exception_count is never nulled');
  const e = report.exceptions[0];
  assert.equal(e.category, 'READ_FAILURE');
  assert.equal(e.severity, 'ERROR');
  assert.match(JSON.stringify(e.evidence), /response log/);
});

test('an explicit reconciliation read error yields INCOMPLETE with READ_FAILURE', () => {
  const report = run([row()], reconcileReport([reconCard()]), { reconciliationReadError: 'SheetNotFound' });
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.results.length, 0);
  assert.equal(report.summary.exception_count, 1);
  assert.match(JSON.stringify(report.exceptions[0].evidence), /reconciliation report/);
});

test('an upstream INCOMPLETE reconciliation report propagates as a read-failure-equivalent', () => {
  const report = run(
    [row()],
    reconcileReport([], { status: 'INCOMPLETE', summary: { response_records: null } }),
  );
  assert.equal(report.status, 'INCOMPLETE');
  assert.equal(report.sources.reconciliation_ok, false);
  assert.ok(report.sources.reconciliation_read_error.includes('INCOMPLETE'));
  assert.equal(report.summary.response_records, null);
  assert.equal(report.summary.exception_count, 1);
  assert.equal(report.exceptions[0].category, 'READ_FAILURE');
});

/* ------------------------------------------------------------------ */
/* Integration: real reconcile evidence drives VERIFIED interpretation */
/* ------------------------------------------------------------------ */

test('integration: real response-reconcile VERIFIED evidence interprets normally', () => {
  const responseRows = [{
    response_id: 'RES-INT-A',
    idempotency_key: 'msg-int::email',
    lead_id: 'L-INT',
    outreach_id: 'EX-L-INT-email',
    channel: 'email',
    provider_message_id: 'pmsg-int',
    received_at: '2026-09-12T08:45:00.000Z',
    response_text: 'yes please send me the full details',
    response_status: 'CAPTURED',
    source: 'gmail',
    matched: true,
    notes: '',
  }];
  const outreachRows = [{
    outreach_id: 'EX-L-INT-email',
    lead_id: 'L-INT',
    channel: 'email',
    sent_at: '2026-09-11T14:00:00.000Z',
  }];

  const recon = reconcileResponses({ responseRows, outreachRows, now: FIXED_NOW });
  assert.equal(recon.status, 'COMPLETED');
  assert.equal(recon.results[0].reconciliation_status, 'VERIFIED');

  const report = run(
    responseRows.map((r) => ({
      response_id: r.response_id,
      idempotency_key: r.idempotency_key,
      lead_id: r.lead_id,
      outreach_id: r.outreach_id,
      channel: r.channel,
      response_status: r.response_status,
      response_text: r.response_text,
    })),
    reconcileReport(recon.results),
  );

  assert.equal(report.status, 'COMPLETED');
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'INTERPRETED');
  assert.equal(card.reconciliation_status, 'VERIFIED');
  assert.equal(card.intent_label, 'RESPOND');
  assert.equal(card.actionable, true);
  assert.equal(card.actionability, 'AUTO_REPLY');
  assert.equal(card.interpretation_id, interpretationIdFor('RES-INT-A'));
  assert.equal(report.summary.interpreted_records, 1);
});

test('a capture-level UNMATCHED row flows through real reconcile to a non-actionable interpretation', () => {
  const responseRows = [{
    response_id: 'RES-INT-U',
    idempotency_key: 'msg-int-u::email',
    lead_id: '',
    outreach_id: '',
    channel: 'email',
    provider_message_id: '',
    received_at: '2026-09-12T08:45:00.000Z',
    response_text: 'yes sounds good!',
    response_status: 'UNMATCHED',
    source: 'gmail',
    matched: false,
    notes: '',
  }];
  const recon = reconcileResponses({ responseRows, outreachRows: [], now: FIXED_NOW });
  assert.equal(recon.results[0].reconciliation_status, 'NOT_VERIFIABLE');
  const report = run(
    responseRows.map((r) => ({
      response_id: r.response_id,
      idempotency_key: r.idempotency_key,
      lead_id: r.lead_id,
      outreach_id: r.outreach_id,
      channel: r.channel,
      response_status: r.response_status,
      response_text: r.response_text,
    })),
    reconcileReport(recon.results),
  );
  const card = report.results[0];
  assert.equal(card.interpretation_status, 'INTERPRETED');
  assert.equal(card.intent_label, 'RESPOND');
  assert.equal(card.actionable, false);
  assert.equal(card.actionability, 'MANUAL_REVIEW');
});