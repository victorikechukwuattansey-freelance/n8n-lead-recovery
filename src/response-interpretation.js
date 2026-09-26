'use strict';

/*
 * Outreach Response Interpretation V1 — pure deterministic interpretation engine.
 *
 * The intent layer between Response Reconciliation V1 and a future Plan stage.
 * This is the FIRST artifact allowed to read `response_text` from the durable
 * Response Log. It classifies each eligible response into exactly one of 8
 * locked intent labels, scores a deterministic confidence, builds a safe
 * evidence object, and recommends actionability. It NEVER sends, NEVER replies,
 * NEVER schedules, NEVER writes to any sheet, NEVER calls a provider, and NEVER
 * invokes an AI model.
 *
 * Contract (OUTREACH-RESPONSE-INTERPRETATION-v1.md):
 *   - Pure function boundary. interpretResponses accepts response records and
 *     reconciliation evidence plus deterministic options (now/runId). It does
 *     not read files, call the network, touch env vars, access n8n APIs /
 *     staticData / credentials, or mutate its inputs.
 *   - Join exclusively by response_id. Reconciliation logic is never re-run;
 *     the reconciliation report is evidence, not recomputation.
 *   - Rules are ordered, named, versionable, and deterministic. V1 is
 *     English-only, rule-based phrase classification — no NLP framework, no LLM.
 *   - Evidence carries safe metadata only (rule_id / static phrase / weight /
 *     polarity / clause). Raw response_text never enters cards, reports, or
 *     exceptions.
 *   - interpretation_id = INTERP-<fnv1a32hex(response_id + "::" + version)>,
 *     version RESPRINT... INTERPRETATION_VERSION is 'RESP-INT-V1'.
 *   - A source read failure yields status INCOMPLETE with nulled summary metrics
 *     and READ_FAILURE exceptions — never a false-healthy run.
 *   - Classifier no-match is NO_INTENT (not a failure). Classifier misbehavior
 *     throws; NO_INTENT is an intentional, distinguishable classification.
 */

const RUN_LABEL = 'RESPINT';
const INTERPRETATION_VERSION = 'RESP-INT-V1';

const SUPPORTED_CHANNELS = ['email', 'call'];
const RESPONSE_STATUSES = ['CAPTURED', 'UNMATCHED'];

const STATUS = {
  COMPLETED: 'COMPLETED',
  INCOMPLETE: 'INCOMPLETE',
};

const INTERPRETATION_STATUS = {
  INTERPRETED: 'INTERPRETED',
  SKIPPED: 'SKIPPED',
};

/*
 * Locked taxonomy — exactly 8 primary labels, exactly one per response.
 * Order here is the report's by_intent key order (stable).
 */
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

const INTENT_LABEL_SET = new Set(INTENT_LABELS);

const ACTIONABILITY = {
  HARD_STOP: 'HARD_STOP',
  AUTO_REPLY: 'AUTO_REPLY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NO_ACTION: 'NO_ACTION',
};

const CONFIDENCE = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.7,
  MEDIUM: 0.4,
};

const EXCEPTION_TYPE = {
  INVALID_RESPONSE_RECORD: 'INVALID_RESPONSE_RECORD',
  MISSING_RECONCILIATION_EVIDENCE: 'MISSING_RECONCILIATION_EVIDENCE',
  READ_FAILURE: 'READ_FAILURE',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const EXCEPTION_SEVERITY = {
  INVALID_RESPONSE_RECORD: SEVERITY.WARNING,
  MISSING_RECONCILIATION_EVIDENCE: SEVERITY.WARNING,
  READ_FAILURE: SEVERITY.ERROR,
};

const EXCEPTION_REASON = {
  INVALID_RESPONSE_RECORD:
    'Response Log row is missing required identity fields, carries a non-canonical response_status, or has no response text.',
  MISSING_RECONCILIATION_EVIDENCE:
    'No reconciliation evidence for response_id; treated as NOT_VERIFIABLE.',
  READ_FAILURE:
    'A required interpretation source could not be read.',
};

/* Arbitrated ties among conversational clauses (first in this list wins). */
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

function str(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function digits14(value) {
  return str(value).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
}

/**
 * FNV-1a 32-bit hex (same derivation style as the Response Capture engine).
 */
function fnv1a32Hex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isSupportedChannel(channel) {
  return channel !== '' && SUPPORTED_CHANNELS.indexOf(channel) !== -1;
}

/**
 * Deterministic interpretation identity: response_id + interpretation_version.
 * No random IDs, no time inputs, stable across runs for the same response.
 */
function interpretationIdFor(responseId) {
  return `INTERP-${fnv1a32Hex(`${responseId}::${INTERPRETATION_VERSION}`)}`;
}

/* ------------------------------------------------------------------ */
/* Rule table (ordered, named, versionable).                           */
/* Each rule: named, clause label, polarity, weight, phrases +/or regex. */
/* ------------------------------------------------------------------ */

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
    regex: '\\?',
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boundaryRegExp(phrase) {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(phrase)}(?:$|[^a-z0-9])`, 'gi');
}

function zeroLabelCounts() {
  return Object.fromEntries(INTENT_LABELS.map((label) => [label, 0]));
}

function zeroObject(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

/**
 * Evaluate every rule against the normalized (lowercased) text.
 * Returns evaluated hits with per-match counts and distinct matched phrases.
 * Strictly deterministic; no global/state.
 */
function evaluateRules(text) {
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
}

function resolveConversational(scores) {
  const entries = INTENT_LABELS.filter((label) =>
    ['RESPOND', 'QUESTION', 'OBJECTION', 'NOT_INTERESTED'].includes(label),
  ).map((label) => [label, scores[label] || 0]).filter(([, s]) => s > 0);

  if (entries.length === 0) {
    return { label: 'NO_INTENT', decidingClause: 'NO_INTENT', conflict: false };
  }

  let best = entries[0];
  for (const entry of entries) {
    if (entry[1] > best[1]) best = entry;
  }
  const tied = entries.filter(([, s]) => s === best[1]);
  let winner;
  if (tied.length === 1) {
    winner = best[0];
  } else {
    winner = TIE_BREAK_ORDER.find((label) => tied.some(([l]) => l === label));
    winner = winner || best[0];
  }
  return { label: winner, decidingClause: winner, conflict: false };
}

/**
 * Convert matched rules into the safe evidence array and clause_hits map.
 * Evidence is sorted byte-stable (weight desc, clause asc, rule id asc, phrase asc).
 * Only static phrase metadata — never raw response text.
 */
function buildEvidence(hits) {
  const entries = [];
  for (const { rule, phrases } of hits) {
    for (const phrase of phrases) {
      entries.push({
        rule_id: rule.id,
        phrase,
        weight: rule.weight,
        polarity: rule.polarity,
        clause: rule.clause,
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
}

/**
 * Pure classification of one text into (label, confidence, band, evidence).
 * Precedence (locked): OPT_OUT > mechanical (UNDELIVERABLE, SPAM_OR_AUTOMATED)
 * > conversational. Conflicting conversational evidence (positive AND negative
 * decline both matched) resolves to NO_INTENT.
 */
function classifyIntent(text) {
  const normalized = str(text).toLowerCase();
  const hits = evaluateRules(normalized);

  const scores = Object.fromEntries(INTENT_LABELS.map((label) => [label, 0]));
  let totalWeight = 0;
  for (const { rule, count } of hits) {
    scores[rule.clause] += rule.weight * count;
    totalWeight += rule.weight * count;
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

  const topScore = label === 'NO_INTENT' ? Math.max(0, ...Object.values(scores)) : scores[label];
  const confidence = totalWeight > 0 ? topScore / totalWeight : 0;
  const band = confidenceBandFor(confidence);

  const { evidence, clauseHits } = buildEvidence(hits);

  return {
    label,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    band,
    evidence,
    clauseHits,
    matchedTermsTotal: evidence.length,
    decidingClause,
    conflict,
  };
}

function confidenceBandFor(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value) || value < CONFIDENCE_THRESHOLDS.MEDIUM) return CONFIDENCE.LOW;
  if (value >= CONFIDENCE_THRESHOLDS.HIGH) return CONFIDENCE.HIGH;
  return CONFIDENCE.MEDIUM;
}

/* ------------------------------------------------------------------ */
/* Regression helpers                                                  */
/* ------------------------------------------------------------------ */

function normalizeResponseRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    response_id: str(row.response_id),
    idempotency_key: str(row.idempotency_key),
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    response_status: str(row.response_status).toUpperCase(),
    response_text: str(row.response_text),
  }));
}

function normalizeReconciliation(report) {
  if (report == null) return { status: STATUS.COMPLETED, results: [] };
  const source =
    report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const results = Array.isArray(source.results) ? source.results : [];
  return {
    status: str(source.status).toUpperCase() || STATUS.COMPLETED,
    results,
  };
}

function indexReconciliation(results) {
  const index = new Map();
  for (const card of results) {
    const responseId = str(card && card.response_id);
    if (responseId && !index.has(responseId)) index.set(responseId, card);
  }
  return index;
}

/**
 * Structural interpretation eligibility (locked):
 * response_id + idempotency_key + supported channel + canonical response_status
 * + non-empty response_text. Mirrors reconciliation's validity definition so
 * reconcile-INVALID rows are never normally interpreted (they are SKIPPED).
 */
function isInterpretable(row) {
  return (
    str(row.response_id) !== '' &&
    str(row.idempotency_key) !== '' &&
    isSupportedChannel(row.channel) &&
    RESPONSE_STATUSES.includes(row.response_status) &&
    str(row.response_text).trim() !== ''
  );
}

function skipReason(row) {
  if (str(row.response_id) === '') return 'missing response_id';
  if (str(row.idempotency_key) === '') return 'missing idempotency_key';
  if (!isSupportedChannel(row.channel)) return 'unsupported channel';
  if (!RESPONSE_STATUSES.includes(row.response_status)) return 'invalid response_status';
  if (str(row.response_text).trim() === '') return 'empty response_text';
  return 'invalid response record';
}

/**
 * Locked actionability rules. NEVER executes anything — pure recommendation.
 * Order: OPT_OUT => HARD_STOP; LOW => MANUAL_REVIEW; VIOLATION =>
 * MANUAL_REVIEW; NOT_VERIFIABLE => MANUAL_REVIEW; NO_INTENT => MANUAL_REVIEW;
 * then label-driven AUTO_REPLY / NO_ACTION.
 */
function actionabilityFor({ label, band, reconciliationStatus }) {
  if (label === 'OPT_OUT') {
    return {
      actionability: ACTIONABILITY.HARD_STOP,
      recommendedAction: 'stop-contact: suppress future outreach',
      priority: 'HIGH',
    };
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
  if (
    label === 'NOT_INTERESTED' ||
    label === 'UNDELIVERABLE' ||
    label === 'SPAM_OR_AUTOMATED'
  ) {
    return { actionability: ACTIONABILITY.NO_ACTION, recommendedAction: 'no action: close/archive', priority: 'LOW' };
  }
  return { actionability: ACTIONABILITY.MANUAL_REVIEW, recommendedAction: 'manual review required', priority: 'MEDIUM' };
}

function exception(type, record, evidence) {
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
}

function sortedBy(list, keys) {
  return list.slice().sort((a, b) => {
    for (const key of keys) {
      const av = a[key] || '';
      const bv = b[key] || '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });
}

function sortedExceptions(exceptions) {
  return exceptions
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
}

/* ------------------------------------------------------------------ */
/* Card + report builders                                              */
/* ------------------------------------------------------------------ */

function buildCard({ row, reconciliationEvidence, exceptions }) {
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
    card.reason = `skipped: ${reason}`;
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
  card.reason = `${classified.label} with ${classified.band} confidence`;

  const notes = [];
  if (unmatched) notes.push('unmatched response; not actionable');
  if (!reconciliationEvidence) notes.push('no reconciliation evidence for response_id; treated as NOT_VERIFIABLE');
  if (classified.conflict) notes.push('conflicting conversational clauses resolved to NO_INTENT');
  card.notes = notes.join('; ');

  return card;
}

function computeSummary({ rows, cards, reported }) {
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
}

function buildReport({ rows, cards, exceptions, now, runId }) {
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
}

function buildReadFailureReport({ responseLogReadError, reconciliationReadError, now, runId }) {
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
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Pure interpretation entry point — no reads, no network, no env, no n8n APIs,
 * no AI, no input mutation.
 *
 * @param {Object}   [input]
 * @param {Array}    [input.responseRows]             full durable Response Log rows.
 * @param {Object|Array} [input.reconciliationReport] Reconciliation V1 report
 *                                                    (results cards) or an array
 *                                                    of cards.
 * @param {string}   [input.responseLogReadError]     non-empty when the Response Log
 *                                                    could not be read.
 * @param {string}   [input.reconciliationReadError]  non-empty when reconciliation
 *                                                    evidence is unavailable.
 * @param {Date|number|string} [input.now]            injected clock for determinism.
 * @param {string}   [input.runId]                    explicit run id override.
 */
function interpretResponses({
  responseRows,
  reconciliationReport,
  responseLogReadError,
  reconciliationReadError,
  now,
  runId,
} = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const finalRunId = runId && str(runId) ? str(runId) : `${RUN_LABEL}-${digits14(String(nowMs))}`;

  const responseErr = str(responseLogReadError);
  let reconErr = str(reconciliationReadError);

  const report = normalizeReconciliation(reconciliationReport);
  if (!responseErr && report.status === STATUS.INCOMPLETE) {
    reconErr = reconErr || 'reconciliation upstream state INCOMPLETE';
  }

  if (responseErr || reconErr) {
    return buildReadFailureReport({
      responseLogReadError: responseErr,
      reconciliationReadError: reconErr,
      now: nowMs,
      runId: finalRunId,
    });
  }

  const rows = normalizeResponseRows(responseRows);
  const reconciliationIndex = indexReconciliation(report.results);

  const exceptions = [];
  const cards = rows.map((row) =>
    buildCard({
      row,
      reconciliationEvidence: reconciliationIndex.get(row.response_id),
      exceptions,
    }),
  );

  return buildReport({ rows, cards, exceptions, now: nowMs, runId: finalRunId });
}

module.exports = {
  RUN_LABEL,
  INTERPRETATION_VERSION,
  SUPPORTED_CHANNELS,
  RESPONSE_STATUSES,
  STATUS,
  INTERPRETATION_STATUS,
  INTENT_LABELS,
  INTENT_LABEL_SET,
  ACTIONABILITY,
  CONFIDENCE,
  CONFIDENCE_THRESHOLDS,
  EXCEPTION_TYPE,
  SEVERITY,
  EXCEPTION_SEVERITY,
  EXCEPTION_REASON,
  TIE_BREAK_ORDER,
  REPORT_SUMMARY_FIELDS,
  RULES,
  str,
  digits14,
  fnv1a32Hex,
  interpretationIdFor,
  isSupportedChannel,
  boundaryRegExp,
  zeroLabelCounts,
  evaluateRules,
  resolveConversational,
  buildEvidence,
  classifyIntent,
  confidenceBandFor,
  normalizeResponseRows,
  normalizeReconciliation,
  indexReconciliation,
  isInterpretable,
  skipReason,
  actionabilityFor,
  exception,
  sortedBy,
  sortedExceptions,
  buildCard,
  computeSummary,
  buildReport,
  buildReadFailureReport,
  interpretResponses,
};