'use strict';

/*
 * Outreach Response Reconciliation V1 — read-only reconciliation/reporting engine.
 *
 * Reconciles the durable Response Log (produced by the capture-only
 * OUTREACH-RESPONSE-CAPTURE-V1 artifact) against the durable Outreach Log
 * (the sole outbound-history ledger, written by Outreach Execution & Delivery
 * V1). THIS ARTIFACT NEVER WRITES: it consumes source records and produces a
 * structured, deterministic report. It never sends, never replies, never
 * schedules follow-ups, never interprets response intent, never qualifies,
 * never syncs to a CRM, and never calls a provider.
 *
 * Evidence contract (established by the upstream artifacts):
 *   - Response Log identity: idempotency_key = (provider_message_id || event_id)
 *     ::source; response_id = RESP-<fnv1a32hex>; a durable row persists
 *     outreach_id = EX-<lead_id>-<channel> when identity resolved.
 *   - Outreach Log identity: durable outreach_id = EX-<lead_id>-<channel>;
 *     a confirmed attempt requires sent_at (non-empty). The idempotency key of
 *     the execution boundary is (lead_id, channel); the log row's canonical
 *     identity is its outreach_id.
 *   - provider_message_id is inbound-only (never written by the outbound
 *     boundary) and can never establish an outbound/inbound relationship.
 *   - Outreach Log reply_status/reply_date are presentational fields, NOT
 *     authoritative proof that a response was captured. This artifact never
 *     treats them as a capture ledger (no REPLY_STATE comparison).
 *
 * Reconciliation taxonomy — every durable response row gets exactly one
 * RECONCILIATION_STATUS from { VERIFIED, VIOLATION, NOT_VERIFIABLE }:
 *   - VERIFIED      : response.outreach_id resolves to exactly one confirmed
 *                     Outreach Log attempt (sent_at present).
 *   - VIOLATION     : a provable inconsistency — the referenced outreach_id
 *                     does not exist (lead may still have other history);
 *                     the lead has NO outbound history at all; the
 *                     id-parsed channel contradicts the response channel;
 *                     or the response identity key is duplicated.
 *   - NOT_VERIFIABLE: the system cannot establish a relationship either way —
 *                     lead-only linkage, malformed reference, ambiguous
 *                     duplicate outreach id, an echoed attempt that was never
 *                     confirmed (no sent_at), or a capture-level UNMATCHED
 *                     row. Missing evidence is never converted into PASS/FAIL.
 *
 * Read-failure semantics: a failed source read yields INCOMPLETE with null
 * dependent metrics, results [], and exactly one SOURCE_READ_FAILURE exception
 * per failed source — never a false-healthy report. Two empty-but-readable
 * sources yield COMPLETED with valid zero metrics.
 *
 * coverage_rate = linked_records / eligible_response_records when the
 * denominator is meaningful; a zero denominator yields null — never 100%.
 */

const SUPPORTED_CHANNELS = ['email', 'call'];

const RUN_LABEL = 'RESPRECON';

const STATUS = {
  COMPLETED: 'COMPLETED',
  INCOMPLETE: 'INCOMPLETE',
};

const RECONCILIATION_STATUS = {
  VERIFIED: 'VERIFIED',
  VIOLATION: 'VIOLATION',
  NOT_VERIFIABLE: 'NOT_VERIFIABLE',
};

const CATEGORY = {
  RESPONSE_WITH_VALID_OUTREACH: 'RESPONSE_WITH_VALID_OUTREACH',
  RESPONSE_OUTREACH_NOT_FOUND: 'RESPONSE_OUTREACH_NOT_FOUND',
  RESPONSE_LEAD_NOT_FOUND: 'RESPONSE_LEAD_NOT_FOUND',
  RESPONSE_WITHOUT_OUTREACH_ID: 'RESPONSE_WITHOUT_OUTREACH_ID',
  CHANNEL_MISMATCH: 'CHANNEL_MISMATCH',
  OUTREACH_ID_FORMAT_INVALID: 'OUTREACH_ID_FORMAT_INVALID',
  DUPLICATE_RESPONSE: 'DUPLICATE_RESPONSE',
  DUPLICATE_OUTREACH_ID: 'DUPLICATE_OUTREACH_ID',
  INVALID_RESPONSE_RECORD: 'INVALID_RESPONSE_RECORD',
  INVALID_OUTREACH_RECORD: 'INVALID_OUTREACH_RECORD',
  READ_FAILURE: 'READ_FAILURE',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const CATEGORY_SEVERITY = {
  [CATEGORY.RESPONSE_WITH_VALID_OUTREACH]: SEVERITY.WARNING,
  [CATEGORY.RESPONSE_OUTREACH_NOT_FOUND]: SEVERITY.ERROR,
  [CATEGORY.RESPONSE_LEAD_NOT_FOUND]: SEVERITY.ERROR,
  [CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID]: SEVERITY.WARNING,
  [CATEGORY.CHANNEL_MISMATCH]: SEVERITY.ERROR,
  [CATEGORY.OUTREACH_ID_FORMAT_INVALID]: SEVERITY.WARNING,
  [CATEGORY.DUPLICATE_RESPONSE]: SEVERITY.ERROR,
  [CATEGORY.DUPLICATE_OUTREACH_ID]: SEVERITY.ERROR,
  [CATEGORY.INVALID_RESPONSE_RECORD]: SEVERITY.WARNING,
  [CATEGORY.INVALID_OUTREACH_RECORD]: SEVERITY.WARNING,
  [CATEGORY.READ_FAILURE]: SEVERITY.ERROR,
};

const VIOLATION_CATEGORIES = [
  CATEGORY.RESPONSE_OUTREACH_NOT_FOUND,
  CATEGORY.RESPONSE_LEAD_NOT_FOUND,
  CATEGORY.CHANNEL_MISMATCH,
  CATEGORY.DUPLICATE_RESPONSE,
  CATEGORY.DUPLICATE_OUTREACH_ID,
];

const CATEGORY_REASON = {
  [CATEGORY.RESPONSE_WITH_VALID_OUTREACH]: 'Response references an Outreach Log attempt whose OUTREACH identifier resolves exactly.',
  [CATEGORY.RESPONSE_OUTREACH_NOT_FOUND]: 'Response references an outreach_id that has no matching attempt in the Outreach Log; the claimed attempt cannot be proven.',
  [CATEGORY.RESPONSE_LEAD_NOT_FOUND]: 'Response references a lead_id with no outbound history at all in the Outreach Log.',
  [CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID]: 'Response carries only a lead-level reference; no specific outbound attempt is referenced.',
  [CATEGORY.CHANNEL_MISMATCH]: 'Channel parsed from the response outreach_id contradicts the response channel.',
  [CATEGORY.OUTREACH_ID_FORMAT_INVALID]: 'Response outreach_id is not in the canonical EX-<lead_id>-<channel> format.',
  [CATEGORY.DUPLICATE_RESPONSE]: 'More than one durable Response Log row shares the same canonical inbound idempotency key.',
  [CATEGORY.DUPLICATE_OUTREACH_ID]: 'More than one Outreach Log row shares the same canonical outreach_id; the echoed attempt is ambiguous.',
  [CATEGORY.INVALID_RESPONSE_RECORD]: 'Response Log row is missing required identity fields or carries a non-canonical response_status.',
  [CATEGORY.INVALID_OUTREACH_RECORD]: 'Outreach Log row is missing required identity fields, lacks a confirmed sent_at, or carries a malformed outreach_id.',
  [CATEGORY.READ_FAILURE]: 'A required reconciliation source could not be read.',
};

const OUTREACH_ID_REGEX = /^EX-(.+)-(email|call)$/;

const RESPONSE_STATUSES = ['CAPTURED', 'UNMATCHED'];

function str(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function digits14(value) {
  const s = value.replace(/\D/g, '');
  return s.slice(0, 14).padEnd(14, '0');
}

function isSupportedChannel(channel) {
  return channel !== '' && SUPPORTED_CHANNELS.includes(channel);
}

function exception(category, record, evidence) {
  return {
    category,
    severity: CATEGORY_SEVERITY[category] || SEVERITY.WARNING,
    response_id: record.response_id || '',
    lead_id: record.lead_id || '',
    outreach_id: record.outreach_id || '',
    channel: record.channel || '',
    reason: CATEGORY_REASON[category],
    evidence: evidence || {},
  };
}

function card(record, reconciliationStatus, relationship, reason) {
  return {
    response_id: record.response_id,
    lead_id: record.lead_id,
    outreach_id: record.outreach_id,
    channel: record.channel,
    response_status: record.response_status,
    reconciliation_status: reconciliationStatus,
    relationship,
    reason,
  };
}

/**
 * Normalize durable Response Log rows to the minimal reconciliation projection.
 * Deliberately excludes response_text, provider_message_id, source, sender and
 * recipient material so report cards and exceptions can never leak them.
 */
function normalizeResponseRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    response_id: str(row.response_id),
    idempotency_key: str(row.idempotency_key),
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    response_status: str(row.response_status).toUpperCase(),
    received_at: str(row.received_at),
    matched: row.matched === true || str(row.matched) === 'true',
  }));
}

function normalizeOutreachRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    sent_at: str(row.sent_at),
  }));
}

function isResponseRecordValid(record) {
  return (
    record.response_id !== '' &&
    record.idempotency_key !== '' &&
    isSupportedChannel(record.channel) &&
    RESPONSE_STATUSES.includes(record.response_status)
  );
}

function isOutreachRowValid(row) {
  return (
    row.lead_id !== '' &&
    row.outreach_id !== '' &&
    OUTREACH_ID_REGEX.test(row.outreach_id) &&
    isSupportedChannel(row.channel) &&
    row.sent_at !== ''
  );
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
    .map((e) => Object.assign({}, e))
    .sort((a, b) => {
      const keys = ['category', 'response_id', 'outreach_id', 'channel', 'lead_id', 'reason'];
      for (const key of keys) {
        const av = a[key];
        const bv = b[key];
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return JSON.stringify(a.evidence || {}).localeCompare(JSON.stringify(b.evidence || {}));
    });
}

/**
 * Classify every durable response row into exactly one reconciliation status.
 * Deterministic and input-order independent:
 *   - rows are processed in sorted order;
 *   - the canonically-first occurrence of an idempotency key is the match's
 *     carrier; later occurrences are DUPLICATE_RESPONSE;
 *   - the Outreach Log is indexed by outreach_id (valid rows only), so row
 *     positions never influence identity.
 */
function classifyResponses(rows, context) {
  const sortedRows = sortedBy(rows, ['response_id', 'idempotency_key', 'lead_id', 'outreach_id', 'channel']);
  const seenKeys = new Set();
  const canonicalKeyId = new Map();
  const results = [];
  const rowExceptions = [];

  let matched = 0;
  let unmatched = 0;
  let notVerifiable = 0;
  let invalid = 0;
  let duplicate = 0;
  let violationRows = 0;
  let linked = 0;
  let eligible = 0;

  for (const rec of sortedRows) {
    if (!isResponseRecordValid(rec)) {
      invalid += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.NOT_VERIFIABLE,
          'invalid durable response record',
          CATEGORY_REASON[CATEGORY.INVALID_RESPONSE_RECORD],
        ),
      );
      rowExceptions.push(
        exception(CATEGORY.INVALID_RESPONSE_RECORD, rec, {
          source: 'response log',
          reason: 'missing response_id, idempotency_key, channel, or non-canonical response_status',
        }),
      );
      continue;
    }

    if (seenKeys.has(rec.idempotency_key)) {
      duplicate += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.VIOLATION,
          'duplicate inbound message identity',
          CATEGORY_REASON[CATEGORY.DUPLICATE_RESPONSE],
        ),
      );
      rowExceptions.push(
        exception(CATEGORY.DUPLICATE_RESPONSE, rec, {
          canonical_response_id: canonicalKeyId.get(rec.idempotency_key),
        }),
      );
      continue;
    }
    seenKeys.add(rec.idempotency_key);
    canonicalKeyId.set(rec.idempotency_key, rec.response_id);

    if (rec.response_status === 'UNMATCHED' || rec.lead_id === '') {
      notVerifiable += 1;
      if (rec.response_status === 'UNMATCHED') unmatched += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.NOT_VERIFIABLE,
          'capture-level unmatched; no identity to reconcile',
          'Response was recorded UNMATCHED at capture; it carries no reconcilable identity.',
        ),
      );
      continue;
    }

    eligible += 1;
    if (context.leadSet.has(rec.lead_id)) linked += 1;

    const outreachId = rec.outreach_id;
    if (outreachId === '') {
      if (context.leadSet.has(rec.lead_id)) {
        notVerifiable += 1;
        results.push(
          card(
            rec,
            RECONCILIATION_STATUS.NOT_VERIFIABLE,
            'lead-level relationship only; no specific attempt referenced',
            CATEGORY_REASON[CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID],
          ),
        );
        rowExceptions.push(
          exception(CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID, rec, {
            log_rows_for_lead: context.leadRowCounts.get(rec.lead_id) || 0,
          }),
        );
      } else {
        violationRows += 1;
        results.push(
          card(
            rec,
            RECONCILIATION_STATUS.VIOLATION,
            'lead has no outbound history at all',
            CATEGORY_REASON[CATEGORY.RESPONSE_LEAD_NOT_FOUND],
          ),
        );
        rowExceptions.push(exception(CATEGORY.RESPONSE_LEAD_NOT_FOUND, rec, {}));
      }
      continue;
    }

    const parsed = OUTREACH_ID_REGEX.exec(outreachId);
    if (!parsed) {
      notVerifiable += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.NOT_VERIFIABLE,
          'malformed outreach reference; cannot verify',
          CATEGORY_REASON[CATEGORY.OUTREACH_ID_FORMAT_INVALID],
        ),
      );
      rowExceptions.push(
        exception(CATEGORY.OUTREACH_ID_FORMAT_INVALID, rec, { outreach_id: outreachId }),
      );
      continue;
    }

    const referencedChannel = parsed[2];
    if (referencedChannel !== rec.channel) {
      violationRows += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.VIOLATION,
          'channel mismatch between response and referenced attempt',
          CATEGORY_REASON[CATEGORY.CHANNEL_MISMATCH],
        ),
      );
      rowExceptions.push(
        exception(CATEGORY.CHANNEL_MISMATCH, rec, {
          referenced_channel: referencedChannel,
          response_channel: rec.channel,
        }),
      );
      continue;
    }

    const bucket = context.indexByOutreach.get(outreachId) || { rows: [], ambiguous: false };
    if (bucket.rows.length > 0) {
      if (bucket.ambiguous) {
        notVerifiable += 1;
        results.push(
          card(
            rec,
            RECONCILIATION_STATUS.NOT_VERIFIABLE,
            'duplicate outreach id; echoed attempt is ambiguous',
            CATEGORY_REASON[CATEGORY.DUPLICATE_OUTREACH_ID],
          ),
        );
      } else {
        matched += 1;
        results.push(
          card(
            rec,
            RECONCILIATION_STATUS.VERIFIED,
            'outreach_id resolves to exactly one confirmed Outreach Log attempt',
            CATEGORY_REASON[CATEGORY.RESPONSE_WITH_VALID_OUTREACH],
          ),
        );
      }
      continue;
    }

    const raw = context.rawByOutreach.get(outreachId) || [];
    if (raw.length > 0) {
      notVerifiable += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.NOT_VERIFIABLE,
          'outreach row found; send not confirmed (no sent_at)',
          'An Outreach Log row exists for the referenced attempt but has no confirmed sent_at.',
        ),
      );
      continue;
    }

    if (context.leadSet.has(rec.lead_id)) {
      violationRows += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.VIOLATION,
          'specific outreach attempt not found; lead has other outbound history',
          CATEGORY_REASON[CATEGORY.RESPONSE_OUTREACH_NOT_FOUND],
        ),
      );
      rowExceptions.push(exception(CATEGORY.RESPONSE_OUTREACH_NOT_FOUND, rec, {}));
    } else {
      violationRows += 1;
      results.push(
        card(
          rec,
          RECONCILIATION_STATUS.VIOLATION,
          'lead has no outbound history at all',
          CATEGORY_REASON[CATEGORY.RESPONSE_LEAD_NOT_FOUND],
        ),
      );
      rowExceptions.push(exception(CATEGORY.RESPONSE_LEAD_NOT_FOUND, rec, {}));
    }
  }

  return {
    results,
    rowExceptions,
    matched,
    unmatched,
    notVerifiable,
    invalid,
    duplicate,
    violationRows,
    linked,
    eligible,
  };
}

function indexOutreach(rows) {
  const leadSet = new Set();
  const leadRowCounts = new Map();
  const indexByOutreach = new Map();
  const rawByOutreach = new Map();
  const outreachExceptions = [];
  let invalidOutreach = 0;
  let duplicatesOutreach = 0;

  for (const row of rows) {
    if (row.outreach_id !== '') {
      if (!rawByOutreach.has(row.outreach_id)) rawByOutreach.set(row.outreach_id, []);
      rawByOutreach.get(row.outreach_id).push(row);
    }
    if (!isOutreachRowValid(row)) {
      invalidOutreach += 1;
      outreachExceptions.push(
        exception(CATEGORY.INVALID_OUTREACH_RECORD, row, {
          source: 'outreach log',
          outreach_id: row.outreach_id,
          reason: 'missing lead_id/outreach_id/channel/sent_at or malformed outreach_id',
        }),
      );
      continue;
    }
    leadSet.add(row.lead_id);
    leadRowCounts.set(row.lead_id, (leadRowCounts.get(row.lead_id) || 0) + 1);
    if (!indexByOutreach.has(row.outreach_id)) {
      indexByOutreach.set(row.outreach_id, { rows: [], ambiguous: false });
    }
    indexByOutreach.get(row.outreach_id).rows.push(row);
  }

  // Emit one DUPLICATE_OUTREACH_ID violation per duplicated valid row beyond
  // the canonical first occurrence (canonical = lowest facial sort key).
  for (const bucket of indexByOutreach.values()) {
    if (bucket.rows.length <= 1) continue;
    bucket.ambiguous = true;
    const ordered = sortedBy(bucket.rows, ['lead_id', 'sent_at', 'channel']);
    for (const extra of ordered.slice(1)) {
      duplicatesOutreach += 1;
      outreachExceptions.push(
        exception(CATEGORY.DUPLICATE_OUTREACH_ID, extra, {
          source: 'outreach log',
          outreach_id: extra.outreach_id,
          row_count: ordered.length,
        }),
      );
    }
  }

  return {
    leadSet,
    leadRowCounts,
    indexByOutreach,
    rawByOutreach,
    outreachExceptions,
    invalidOutreach,
    duplicatesOutreach,
  };
}

function buildReadFailureReport({ responseReadError, outreachReadError, now, runId }) {
  const runAt = new Date(now).toISOString();
  const failureExceptions = [];
  if (responseReadError) {
    failureExceptions.push(
      exception(CATEGORY.READ_FAILURE, {}, { source: 'response log', error: responseReadError }),
    );
  }
  if (outreachReadError) {
    failureExceptions.push(
      exception(CATEGORY.READ_FAILURE, {}, { source: 'outreach log', error: outreachReadError }),
    );
  }
  const reported = sortedExceptions(failureExceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runId }),
  );
  return {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    status: STATUS.INCOMPLETE,
    sources: {
      response_log_ok: !responseReadError,
      response_log_read_error: responseReadError,
      outreach_log_ok: !outreachReadError,
      outreach_log_read_error: outreachReadError,
    },
    summary: {
      response_records: null,
      matched_records: null,
      unmatched_records: null,
      linked_records: null,
      not_verifiable: null,
      invalid_records: null,
      duplicate_records: null,
      violations: null,
      coverage_rate: null,
      exception_count: reported.length,
    },
    results: [],
    exceptions: reported,
  };
}

function buildReport({ responseRows, outreachRows, context, classification, outreachContext, now, runId }) {
  const runAt = new Date(now).toISOString();

  const rowExceptions = classification.rowExceptions;
  const allExceptions = rowExceptions.concat(outreachContext.outreachExceptions);
  const reported = sortedExceptions(allExceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runId }),
  );

  const {
    matched, unmatched, notVerifiable, invalid, duplicate, violationRows, linked, eligible,
  } = classification;

  const coverageRate = eligible > 0 ? Number((linked / eligible).toFixed(4)) : null;

  const summary = {
    response_records: responseRows.length,
    matched_records: matched,
    unmatched_records: unmatched,
    linked_records: linked,
    not_verifiable: notVerifiable,
    invalid_records: invalid,
    duplicate_records: duplicate,
    violations: reported.filter((e) => VIOLATION_CATEGORIES.includes(e.category)).length,
    coverage_rate: coverageRate,
    exception_count: reported.length,
  };

  return {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    status: STATUS.COMPLETED,
    sources: {
      response_log_ok: true,
      response_log_read_error: '',
      outreach_log_ok: true,
      outreach_log_read_error: '',
    },
    summary,
    results: sortedBy(classification.results, ['response_id', 'lead_id', 'outreach_id', 'channel']),
    exceptions: reported,
  };
}

/**
 * Pure reconciliation entry point.
 *
 * @param {Object}   [options]
 * @param {Array}    [options.responseRows]      durable Response Log rows.
 * @param {Array}    [options.outreachRows]      durable Outreach Log rows.
 * @param {string}   [options.responseReadError] non-empty when the Response Log
 *                                               could not be read.
 * @param {string}   [options.outreachReadError] non-empty when the Outreach Log
 *                                               could not be read.
 * @param {Date|number|string} [options.now]     injected clock for determinism.
 * @param {string}   [options.runId]             explicit run id override.
 */
function reconcileResponses({ responseRows, outreachRows, responseReadError, outreachReadError, now, runId } = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const runIdFinal = runId && str(runId) ? str(runId) : `${RUN_LABEL}-${digits14(String(nowMs))}`;
  const responseErr = str(responseReadError);
  const outreachErr = str(outreachReadError);

  if (responseErr || outreachErr) {
    return buildReadFailureReport({
      responseReadError: responseErr,
      outreachReadError: outreachErr,
      now: nowMs,
      runId: runIdFinal,
    });
  }

  const responseRowsFinal = normalizeResponseRows(responseRows);
  const outreachRowsFinal = normalizeOutreachRows(outreachRows);
  const outreachContext = indexOutreach(outreachRowsFinal);
  const classification = classifyResponses(responseRowsFinal, outreachContext);

  return buildReport({
    responseRows: responseRowsFinal,
    outreachRows: outreachRowsFinal,
    context: outreachContext,
    classification,
    outreachContext,
    now: nowMs,
    runId: runIdFinal,
  });
}

module.exports = {
  SUPPORTED_CHANNELS,
  RUN_LABEL,
  STATUS,
  RECONCILIATION_STATUS,
  CATEGORY,
  SEVERITY,
  CATEGORY_SEVERITY,
  VIOLATION_CATEGORIES,
  CATEGORY_REASON,
  OUTREACH_ID_REGEX,
  normalizeResponseRows,
  normalizeOutreachRows,
  isResponseRecordValid,
  isOutreachRowValid,
  indexOutreach,
  classifyResponses,
  reconcileResponses,
};