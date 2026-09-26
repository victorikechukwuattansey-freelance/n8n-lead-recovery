'use strict';

/*
 * Embedded code for the Response-Interpretation V1 n8n workflow.
 *
 * These strings are assembled into Response-Interpretation V1.json by
 * scripts/build-response-interpretation-workflow.js. The Interpret Responses
 * node embeds a synchronous mirror of src/response-interpretation.js; the Read
 * Reconciliation Report node embeds a read-only relay that surface the
 * per-run reconciliation report artifact (injected as workflow input — n8n
 * cannot read the runner-local artifact) to the interpretation stage. The
 * workflow test suite asserts the embedded code stays in sync with the engine
 * on every fixture (parity test).
 *
 * This is a READ-ONLY interpretation workflow: it performs no writes, no
 * provider calls, no execution, and no schedule. It consumes the durable
 * Response Log (Response Capture V1 output) and the Response Reconciliation V1
 * report artifact, and produces a structured, deterministic interpretation
 * report. The Manual Trigger node carries optional operator metadata
 * ("response_log_read_error" / "reconciliation_read_error") so a failed read
 * is reported honestly as an INCOMPLETE run instead of a false-healthy
 * COMPLETED run. Empty successful reads yield COMPLETED with valid zero
 * metrics (both code nodes set alwaysOutputData so the chain always executes).
 *
 * The mirror joins exclusively by response_id and consumes the reconciliation
 * report as authoritative evidence — reconciliation is NEVER recomputed here.
 * Raw response_text never leaves this node as data: cards/reports/exceptions
 * carry static phrase evidence only.
 */

const relaySource = `'use strict';

const triggerItems = $('Manual Trigger').all();

let responseLogReadError = '';
let reconciliationReadError = '';
let injectedReport = null;
for (const item of triggerItems) {
  const j = (item && item.json) || {};
  if (typeof j.response_log_read_error === 'string' && j.response_log_read_error !== '') {
    responseLogReadError = j.response_log_read_error;
  }
  if (typeof j.reconciliation_read_error === 'string' && j.reconciliation_read_error !== '') {
    reconciliationReadError = j.reconciliation_read_error;
  }
  if (injectedReport === null && j.reconciliation_report !== undefined && j.reconciliation_report !== null) {
    injectedReport = j.reconciliation_report;
  }
}

const report = injectedReport !== null ? injectedReport : { status: 'COMPLETED', results: [] };
const payload =
  reconciliationReadError === ''
    ? report
    : Object.assign({}, report, { reconciliation_read_error: reconciliationReadError });

return [{ json: payload }];
`;

const interpretSource = `'use strict';

const triggerItems = $('Manual Trigger').all();
const responseLogItems = $('Read Response Log').all();
const reportItems = $('Read Reconciliation Report').all();

const str = (value) => (value === undefined || value === null ? '' : String(value));
const digits14 = (value) => String(value).replace(/\\D/g, '').slice(0, 14).padEnd(14, '0');
const RUN_LABEL = 'RESPINT';
const INTERPRETATION_VERSION = 'RESP-INT-V1';
const SUPPORTED_CHANNELS = ['email', 'call'];
const RESPONSE_STATUSES = ['CAPTURED', 'UNMATCHED'];
const STATUS = { COMPLETED: 'COMPLETED', INCOMPLETE: 'INCOMPLETE' };
const INTERPRETATION_STATUS = { INTERPRETED: 'INTERPRETED', SKIPPED: 'SKIPPED' };
const INTENT_LABELS = [
  'RESPOND',
  'QUESTION',
  'OBJECTION',
  'NOT_INTERESTED',
  'OPT_OUT',
  'UNDELIVERABLE',
  'SPAM_OR_AUTOMATED',
  'NO_INTENT',
];
const ACTIONABILITY = {
  HARD_STOP: 'HARD_STOP',
  AUTO_REPLY: 'AUTO_REPLY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NO_ACTION: 'NO_ACTION',
};
const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
const CONFIDENCE_THRESHOLDS = { HIGH: 0.7, MEDIUM: 0.4 };
const EXCEPTION_TYPE = {
  INVALID_RESPONSE_RECORD: 'INVALID_RESPONSE_RECORD',
  MISSING_RECONCILIATION_EVIDENCE: 'MISSING_RECONCILIATION_EVIDENCE',
  READ_FAILURE: 'READ_FAILURE',
};
const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING' };
const EXCEPTION_SEVERITY = {};
EXCEPTION_SEVERITY[EXCEPTION_TYPE.INVALID_RESPONSE_RECORD] = SEVERITY.WARNING;
EXCEPTION_SEVERITY[EXCEPTION_TYPE.MISSING_RECONCILIATION_EVIDENCE] = SEVERITY.WARNING;
EXCEPTION_SEVERITY[EXCEPTION_TYPE.READ_FAILURE] = SEVERITY.ERROR;
const EXCEPTION_REASON = {};
EXCEPTION_REASON[EXCEPTION_TYPE.INVALID_RESPONSE_RECORD] = 'Response Log row is missing required identity fields, carries a non-canonical response_status, or has no response text.';
EXCEPTION_REASON[EXCEPTION_TYPE.MISSING_RECONCILIATION_EVIDENCE] = 'No reconciliation evidence for response_id; treated as NOT_VERIFIABLE.';
EXCEPTION_REASON[EXCEPTION_TYPE.READ_FAILURE] = 'A required interpretation source could not be read.';
const TIE_BREAK_ORDER = ['NOT_INTERESTED', 'QUESTION', 'OBJECTION', 'RESPOND'];
const REPORT_SUMMARY_FIELDS = [
  'response_records',
  'interpreted_records',
  'skipped_records',
  'by_intent',
  'by_confidence_band',
  'by_actionability',
  'stop_contact_count',
  'manual_review_count',
  'conflict_count',
  'coverage_rate',
  'exception_count',
];

const fnv1a32Hex = (input) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const interpretationIdFor = (responseId) => 'INTERP-' + fnv1a32Hex(responseId + '::' + INTERPRETATION_VERSION);

const isSupportedChannel = (channel) => channel !== '' && SUPPORTED_CHANNELS.indexOf(channel) !== -1;

const RULES = [
  {
    id: 'OPT-OUT-01',
    clause: 'OPT_OUT',
    polarity: 'opt_out',
    weight: 10,
    phrases: [
      'unsubscribe',
      'opt out',
      'opt-out',
      'do not contact',
      'do not email',
      'do not call',
      'remove me',
      'stop sending',
      'stop emailing',
      'take me off',
    ],
  },
  {
    id: 'UNDELIVERABLE-01',
    clause: 'UNDELIVERABLE',
    polarity: 'mechanical',
    weight: 4,
    phrases: [
      'mailer-daemon',
      'undeliverable',
      'delivery status notification',
      'delivery failure',
      'message could not be delivered',
      'failure notice',
      'out of office',
      'automatic reply',
      'auto-reply',
      'autoreply',
    ],
  },
  {
    id: 'SPAM-01',
    clause: 'SPAM_OR_AUTOMATED',
    polarity: 'mechanical',
    weight: 4,
    phrases: [
      'newsletter',
      'you are receiving this email',
      'email preferences',
      'no-reply',
      'do not reply',
      'unsolicited',
      'bulk mail',
      'this is a sponsored message',
    ],
  },
  {
    id: 'CSQ-01',
    clause: 'QUESTION',
    polarity: 'question',
    weight: 2,
    phrases: [
      'what',
      'when',
      'how',
      'why',
      'where',
      'which',
      'can you',
      'could you',
      'do you',
      'have you',
      'is it',
      'is this',
      'are you',
      'how much',
      'how long',
      'whats',
      'when is',
    ],
  },
  {
    id: 'CSQ-02',
    clause: 'QUESTION',
    polarity: 'question',
    weight: 1,
    regex: '\\\\?',
    regexPhrase: '?',
  },
  {
    id: 'INST-01',
    clause: 'RESPOND',
    polarity: 'positive',
    weight: 3,
    phrases: [
      'yes',
      'sounds good',
      'looks good',
      'sounds great',
      'please send',
      'send details',
      'send me',
      'go ahead',
      'lets talk',
      'count me in',
      'would like',
      'very interested',
      'definitely interested',
      'great',
      'perfect',
    ],
  },
  {
    id: 'NINT-01',
    clause: 'NOT_INTERESTED',
    polarity: 'negative',
    weight: 3,
    phrases: [
      'not interested',
      'no thanks',
      'no thank you',
      'thanks but',
      'thank you but',
      'do not need',
      'dont need',
      'not for us',
      'no longer',
      'not now',
      'already have',
      'we are good',
      'not necessary',
      'hard pass',
      'not needed',
    ],
  },
  {
    id: 'OBJ-01',
    clause: 'OBJECTION',
    polarity: 'negative',
    weight: 2,
    phrases: [
      'too expensive',
      'expensive',
      'price',
      'cost',
      'budget',
      'no budget',
      'too busy',
      'not enough time',
      'no time',
      'we already use',
      'already using',
      'have a solution',
      'need to think',
      'let me think',
      'think about it',
      'maybe later',
      'too early',
      'wrong time',
      'not the right time',
      'too much',
    ],
  },
];

const escapeRegExp = (value) =>
  String(value).replace(new RegExp('[.*+?^' + String.fromCharCode(36) + '{}()|[\\]\\\\]', 'g'), '\\\\$&');

const boundaryRegExp = (phrase) =>
  new RegExp('(?:^|[^a-z0-9])' + escapeRegExp(phrase) + '(?:$|[^a-z0-9])', 'gi');

const zeroLabelCounts = () => Object.fromEntries(INTENT_LABELS.map((label) => [label, 0]));

const zeroObject = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

const evaluateRules = (text) => {
  const hits = [];
  for (const rule of RULES) {
    const phrases = [];
    let count = 0;
    for (const phrase of rule.phrases || []) {
      const matches = text.match(boundaryRegExp(phrase)) || [];
      if (matches.length > 0) {
        phrases.push(phrase);
        count += matches.length;
      }
    }
    if (rule.regex) {
      const matches = text.match(new RegExp(rule.regex, 'gi')) || [];
      if (matches.length > 0) {
        phrases.push(rule.regexPhrase || rule.regex);
        count += matches.length;
      }
    }
    if (count > 0) {
      hits.push({ rule, count, phrases });
    }
  }
  return hits;
};

const resolveConversational = (scores) => {
  const entries = INTENT_LABELS.filter((label) =>
    ['RESPOND', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED'].includes(label),
  )
    .map((label) => [label, scores[label] || 0])
    .filter((entry) => entry[1] > 0);

  if (entries.length === 0) {
    return { label: 'NO_INTENT', decidingClause: 'NO_INTENT', conflict: false };
  }

  let best = entries[0];
  for (const entry of entries) {
    if (entry[1] > best[1]) best = entry;
  }
  const tied = entries.filter((entry) => entry[1] === best[1]);
  let winner;
  if (tied.length === 1) {
    winner = best[0];
  } else {
    winner = TIE_BREAK_ORDER.find((label) => tied.some((entry) => entry[0] === label));
    winner = winner || best[0];
  }
  return { label: winner, decidingClause: winner, conflict: false };
};

const buildEvidence = (hits) => {
  const entries = [];
  for (const hit of hits) {
    for (const phrase of hit.phrases) {
      entries.push({
        rule_id: hit.rule.id,
        phrase,
        weight: hit.rule.weight,
        polarity: hit.rule.polarity,
        clause: hit.rule.clause,
      });
    }
  }
  entries.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.clause !== b.clause) return a.clause < b.clause ? -1 : 1;
    if (a.rule_id !== b.rule_id) return a.rule_id < b.rule_id ? -1 : 1;
    if (a.phrase !== b.phrase) return a.phrase < b.phrase ? -1 : 1;
    return 0;
  });
  const clauseHits = {};
  for (const entry of entries) {
    clauseHits[entry.clause] = (clauseHits[entry.clause] || 0) + 1;
  }
  return { evidence: entries, clauseHits };
};

const confidenceBandFor = (confidence) => {
  const value = Number(confidence);
  if (!Number.isFinite(value) || value < CONFIDENCE_THRESHOLDS.MEDIUM) return CONFIDENCE.LOW;
  if (value >= CONFIDENCE_THRESHOLDS.HIGH) return CONFIDENCE.HIGH;
  return CONFIDENCE.MEDIUM;
};

const classifyIntent = (text) => {
  const normalized = str(text).toLowerCase();
  const hits = evaluateRules(normalized);

  const scores = Object.fromEntries(INTENT_LABELS.map((label) => [label, 0]));
  let totalWeight = 0;
  for (const hit of hits) {
    scores[hit.rule.clause] += hit.rule.weight * hit.count;
    totalWeight += hit.rule.weight * hit.count;
  }

  let label;
  let decidingClause;
  let conflict = false;

  if (scores.OPT_OUT > 0) {
    label = 'OPT_OUT';
    decidingClause = 'OPT_OUT';
  } else if (scores.UNDELIVERABLE > 0) {
    label = 'UNDELIVERABLE';
    decidingClause = 'UNDELIVERABLE';
  } else if (scores.SPAM_OR_AUTOMATED > 0) {
    label = 'SPAM_OR_AUTOMATED';
    decidingClause = 'SPAM_OR_AUTOMATED';
  } else {
    const conversational = resolveConversational(scores);
    if (scores.RESPOND > 0 && scores.NOT_INTERESTED > 0) {
      conflict = true;
      conversational.label = 'NO_INTENT';
      conversational.decidingClause = 'CONFLICT';
    }
    label = conversational.label;
    decidingClause = conversational.decidingClause;
  }

  const topScore =
    label === 'NO_INTENT' ? Math.max(0, ...Object.values(scores)) : scores[label];
  const confidence = totalWeight > 0 ? topScore / totalWeight : 0;
  const band = confidenceBandFor(confidence);

  const evidenceBag = buildEvidence(hits);

  return {
    label,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    band,
    evidence: evidenceBag.evidence,
    clauseHits: evidenceBag.clauseHits,
    matchedTermsTotal: evidenceBag.evidence.length,
    decidingClause,
    conflict,
  };
};

const normalizeResponseRows = (rows) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    response_id: str(row.response_id),
    idempotency_key: str(row.idempotency_key),
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    response_status: str(row.response_status).toUpperCase(),
    response_text: str(row.response_text),
  }));

const normalizeReconciliation = (report) => {
  if (report === undefined || report === null) return { status: STATUS.COMPLETED, results: [] };
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const results = Array.isArray(source.results) ? source.results : [];
  return { status: str(source.status).toUpperCase() || STATUS.COMPLETED, results };
};

const indexReconciliation = (results) => {
  const index = new Map();
  for (const card of results) {
    const responseId = str(card && card.response_id);
    if (responseId && !index.has(responseId)) index.set(responseId, card);
  }
  return index;
};

const isInterpretable = (row) =>
  str(row.response_id) !== '' &&
  str(row.idempotency_key) !== '' &&
  isSupportedChannel(row.channel) &&
  RESPONSE_STATUSES.includes(row.response_status) &&
  str(row.response_text).trim() !== '';

const skipReason = (row) => {
  if (str(row.response_id) === '') return 'missing response_id';
  if (str(row.idempotency_key) === '') return 'missing idempotency_key';
  if (!isSupportedChannel(row.channel)) return 'unsupported channel';
  if (!RESPONSE_STATUSES.includes(row.response_status)) return 'invalid response_status';
  if (str(row.response_text).trim() === '') return 'empty response_text';
  return 'invalid response record';
};

const actionabilityFor = (input) => {
  const label = input.label;
  const band = input.band;
  const reconciliationStatus = input.reconciliationStatus;
  if (label === 'OPT_OUT') {
    return { actionability: ACTIONABILITY.HARD_STOP, recommendedAction: 'stop-contact: suppress future outreach', priority: 'HIGH' };
  }
  if (band === CONFIDENCE.LOW) {
    return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'MEDIUM' };
  }
  if (reconciliationStatus === 'VIOLATION') {
    return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'HIGH' };
  }
  if (reconciliationStatus === 'NOT_VERIFIABLE') {
    return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'MEDIUM' };
  }
  if (label === 'NO_INTENT') {
    return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'MEDIUM' };
  }
  if (label === 'RESPOND' || label === 'QUESTION' || label === 'OBJECTION') {
    return { actionability: ACTIONABILITY.AUTO_REPLY, recommendedAction: 'auto-draft reply permitted; send owned by a later stage', priority: 'LOW' };
  }
  if (label === 'NOT_INTERESTED' || label === 'UNDELIVERABLE' || label === 'SPAM_OR_AUTOMATED') {
    return { actionability: ACTIONABILITY.NO_ACTION, recommendedAction: 'no action: close/archive', priority: 'LOW' };
  }
  return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'MEDIUM' };
};

const exception = (type, record, evidence) => {
  const src = record || {};
  return {
    category: type,
    severity: EXCEPTION_SEVERITY[type] || SEVERITY.WARNING,
    response_id: str(src.response_id),
    lead_id: str(src.lead_id),
    outreach_id: str(src.outreach_id),
    channel: str(src.channel),
    reason: EXCEPTION_REASON[type],
    evidence: evidence || {},
  };
};

const sortedBy = (list, keys) =>
  list.slice().sort((a, b) => {
    for (const key of keys) {
      const av = a[key] || '';
      const bv = b[key] || '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });

const sortedExceptions = (exceptions) =>
  exceptions
    .map((entry) => Object.assign({}, entry))
    .sort((a, b) => {
      const keys = ['category', 'response_id', 'lead_id', 'outreach_id', 'channel', 'reason'];
      for (const key of keys) {
        const av = a[key];
        const bv = b[key];
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return JSON.stringify(a.evidence || {}).localeCompare(JSON.stringify(b.evidence || {}));
    });

const buildCard = (input) => {
  const row = input.row;
  const reconciliationEvidence = input.reconciliationEvidence;
  const exceptions = input.exceptions;
  const reconciliationStatus = reconciliationEvidence
    ? str(reconciliationEvidence.reconciliation_status).toUpperCase()
    : 'NOT_VERIFIABLE';

  const card = {
    interpretation_id: '',
    response_id: row.response_id,
    lead_id: row.lead_id,
    outreach_id: row.outreach_id,
    channel: row.channel,
    response_status: row.response_status,
    reconciliation_status: reconciliationStatus,
    interpretation_status: '',
    intent_label: '',
    intent_confidence: null,
    confidence_band: '',
    actionability: '',
    recommended_action: '',
    stop_contact: false,
    priority: '',
    actionable: false,
    matched_terms_total: 0,
    clause_hits: {},
    deciding_clause: '',
    conflict_detected: false,
    interpretation_version: INTERPRETATION_VERSION,
    evidence: [],
    text_preview: '',
    reason: '',
    notes: '',
  };

  if (!isInterpretable(row)) {
    const reason = skipReason(row);
    card.interpretation_status = INTERPRETATION_STATUS.SKIPPED;
    card.reason = 'skipped: ' + reason;
    exceptions.push(exception(EXCEPTION_TYPE.INVALID_RESPONSE_RECORD, row, { reason }));
    return card;
  }

  if (!reconciliationEvidence) {
    exceptions.push(exception(EXCEPTION_TYPE.MISSING_RECONCILIATION_EVIDENCE, row, {}));
  }

  const classified = classifyIntent(row.response_text);
  const unmatched = row.response_status === 'UNMATCHED';
  const action = actionabilityFor({
    label: classified.label,
    band: classified.band,
    reconciliationStatus,
  });

  card.interpretation_status = INTERPRETATION_STATUS.INTERPRETED;
  card.interpretation_id = interpretationIdFor(row.response_id);
  card.intent_label = classified.label;
  card.intent_confidence = classified.confidence;
  card.confidence_band = classified.band;
  card.matched_terms_total = classified.matchedTermsTotal;
  card.clause_hits = classified.clauseHits;
  card.deciding_clause = classified.decidingClause;
  card.conflict_detected = classified.conflict;
  card.evidence = classified.evidence;
  card.actionability = action.actionability;
  card.recommended_action = action.recommendedAction;
  card.stop_contact = classified.label === 'OPT_OUT';
  card.priority = action.priority;
  card.actionable = !unmatched;
  card.reason = classified.label + ' with ' + classified.band + ' confidence';

  const notes = [];
  if (unmatched) notes.push('unmatched response; not actionable');
  if (!reconciliationEvidence)
    notes.push('no reconciliation evidence for response_id; treated as NOT_VERIFIABLE');
  if (classified.conflict) notes.push('conflicting conversational clauses resolved to NO_INTENT');
  card.notes = notes.join('; ');

  return card;
};

const computeSummary = (input) => {
  const rows = input.rows;
  const cards = input.cards;
  const reported = input.reported;
  const interpreted = cards.filter((c) => c.interpretation_status === INTERPRETATION_STATUS.INTERPRETED);
  const byIntent = zeroLabelCounts();
  const byBand = zeroObject([CONFIDENCE.HIGH, CONFIDENCE.MEDIUM, CONFIDENCE.LOW]);
  const byAction = zeroObject([
    ACTIONABILITY.HARD_STOP,
    ACTIONABILITY.AUTO_REPLY,
    ACTIONABILITY.MANUAL_REVIEW,
    ACTIONABILITY.NO_ACTION,
  ]);

  let stopContactCount = 0;
  let manualReviewCount = 0;
  let conflictCount = 0;

  for (const card of interpreted) {
    byIntent[card.intent_label] = (byIntent[card.intent_label] || 0) + 1;
    byBand[card.confidence_band] += 1;
    byAction[card.actionability] += 1;
    if (card.stop_contact) stopContactCount += 1;
    if (card.actionability === ACTIONABILITY.MANUAL_REVIEW) manualReviewCount += 1;
    if (card.conflict_detected) conflictCount += 1;
  }

  return {
    response_records: rows.length,
    interpreted_records: interpreted.length,
    skipped_records: rows.length - interpreted.length,
    by_intent: byIntent,
    by_confidence_band: byBand,
    by_actionability: byAction,
    stop_contact_count: stopContactCount,
    manual_review_count: manualReviewCount,
    conflict_count: conflictCount,
    coverage_rate: rows.length > 0 ? Number((interpreted.length / rows.length).toFixed(4)) : null,
    exception_count: reported.length,
  };
};

const buildReport = (input) => {
  const rows = input.rows;
  const cards = input.cards;
  const exceptions = input.exceptions;
  const now = input.now;
  const runId = input.runId;
  const runAt = new Date(now).toISOString();
  const reported = sortedExceptions(exceptions).map((entry) =>
    Object.assign({}, entry, { detected_at: runAt, run_id: runId }),
  );

  return {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    status: STATUS.COMPLETED,
    sources: {
      response_log_ok: true,
      response_log_read_error: '',
      reconciliation_ok: true,
      reconciliation_read_error: '',
    },
    summary: computeSummary({ rows, cards, reported }),
    results: sortedBy(cards, ['response_id', 'lead_id', 'outreach_id', 'channel']),
    exceptions: reported,
  };
};

const buildReadFailureReport = (input) => {
  const responseLogReadError = input.responseLogReadError;
  const reconciliationReadError = input.reconciliationReadError;
  const now = input.now;
  const runId = input.runId;
  const runAt = new Date(now).toISOString();
  const failures = [];
  if (responseLogReadError) {
    failures.push(
      exception(EXCEPTION_TYPE.READ_FAILURE, {}, { source: 'response log', error: responseLogReadError }),
    );
  }
  if (reconciliationReadError) {
    failures.push(
      exception(EXCEPTION_TYPE.READ_FAILURE, {}, { source: 'reconciliation report', error: reconciliationReadError }),
    );
  }
  const reported = sortedExceptions(failures).map((entry) =>
    Object.assign({}, entry, { detected_at: runAt, run_id: runId }),
  );
  const nulledSummary = Object.fromEntries(
    REPORT_SUMMARY_FIELDS.filter((field) => field !== 'exception_count').map((field) => [field, null]),
  );
  return {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    status: STATUS.INCOMPLETE,
    sources: {
      response_log_ok: !responseLogReadError,
      response_log_read_error: responseLogReadError,
      reconciliation_ok: !reconciliationReadError,
      reconciliation_read_error: reconciliationReadError,
    },
    summary: Object.assign({}, nulledSummary, { exception_count: reported.length }),
    results: [],
    exceptions: reported,
  };
};

let responseReadError = '';
let reconciliationReadError = '';
for (const item of triggerItems) {
  const j = (item && item.json) || {};
  if (typeof j.response_log_read_error === 'string' && j.response_log_read_error !== '')
    responseReadError = j.response_log_read_error;
  if (typeof j.reconciliation_read_error === 'string' && j.reconciliation_read_error !== '')
    reconciliationReadError = j.reconciliation_read_error;
}

const responseRows = responseLogItems.map((item) => (item && item.json) || {});
const nowMs = Date.now();
const runIdFinal = RUN_LABEL + '-' + digits14(String(nowMs));

const reportItemJson = reportItems.length > 0 ? reportItems[0].json : null;
const reconciliationInput = normalizeReconciliation(reportItemJson);

let responseErr = str(responseReadError);
let reconErr = str(reconciliationReadError);
if (!responseErr && reconciliationInput.status === STATUS.INCOMPLETE) {
  reconErr = reconErr || 'reconciliation upstream state INCOMPLETE';
}

let report;
if (responseErr || reconErr) {
  report = buildReadFailureReport({
    responseLogReadError: responseErr,
    reconciliationReadError: reconErr,
    now: nowMs,
    runId: runIdFinal,
  });
} else {
  const rows = normalizeResponseRows(responseRows);
  const reconciliationIndex = indexReconciliation(reconciliationInput.results);
  const exceptions = [];
  const cards = rows.map((row) =>
    buildCard({
      row,
      reconciliationEvidence: reconciliationIndex.get(row.response_id),
      exceptions,
    }),
  );
  report = buildReport({ rows, cards, exceptions, now: nowMs, runId: runIdFinal });
}

return [
  { json: report },
  { json: { run_id: report.run_id, exception_count: report.summary.exception_count, exceptions: report.exceptions } },
];
`;

const interpretCode = interpretSource;
const relayCode = relaySource;
const embeddedSource = interpretSource;

module.exports = { interpretCode, relayCode, embeddedSource };