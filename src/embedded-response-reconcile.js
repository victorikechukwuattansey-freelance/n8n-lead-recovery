'use strict';

/*
 * Embedded code for the Response-Reconciliation V1 n8n workflow.
 *
 * These strings are assembled into Response-Reconciliation V1.json by
 * scripts/build-response-reconciliation-workflow.js. The Reconcile Responses
 * node embeds a synchronous mirror of src/response-reconcile.js. The workflow
 * test suite asserts the embedded code stays in sync with the engine on every
 * fixture (parity test).
 *
 * This is a READ-ONLY reconciliation workflow: it performs no writes, no
 * provider calls, no execution, and no schedule. It consumes the durable
 * Response Log (Response Capture V1 output) and the durable Outreach Log, and
 * produces a structured, deterministic reconciliation report. The Manual
 * Trigger node carries optional operator metadata ("response_log_read_error"
 * / "outreach_log_read_error") so a failed read is reported honestly as an
 * INCOMPLETE run instead of a false-healthy COMPLETED run. Empty successful
 * reads yield COMPLETED with valid zero metrics (the Reconcile node is built
 * with alwaysOutputData so it executes even when both reads return zero rows).
 */

const embeddedSource = `'use strict';

const triggerItems = $('Manual Trigger').all();
const responseLogItems = $('Read Response Log').all();
const outreachLogItems = $('Read Outreach Log').all();

const str = (value) => (value === undefined || value === null ? '' : String(value));
const digits14 = (value) => String(value).replace(/\\D/g, '').slice(0, 14).padEnd(14, '0');
const RUN_LABEL = 'RESPRECON';
const SUPPORTED_CHANNELS = ['email', 'call'];
const STATUS = { COMPLETED: 'COMPLETED', INCOMPLETE: 'INCOMPLETE' };
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
const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING' };
const CATEGORY_SEVERITY = {};
CATEGORY_SEVERITY[CATEGORY.RESPONSE_WITH_VALID_OUTREACH] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.RESPONSE_OUTREACH_NOT_FOUND] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.RESPONSE_LEAD_NOT_FOUND] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.CHANNEL_MISMATCH] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.OUTREACH_ID_FORMAT_INVALID] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.DUPLICATE_RESPONSE] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.DUPLICATE_OUTREACH_ID] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.INVALID_RESPONSE_RECORD] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.INVALID_OUTREACH_RECORD] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.READ_FAILURE] = SEVERITY.ERROR;
const VIOLATION_CATEGORIES = [
  CATEGORY.RESPONSE_OUTREACH_NOT_FOUND,
  CATEGORY.RESPONSE_LEAD_NOT_FOUND,
  CATEGORY.CHANNEL_MISMATCH,
  CATEGORY.DUPLICATE_RESPONSE,
  CATEGORY.DUPLICATE_OUTREACH_ID,
];
const CATEGORY_REASON = {};
CATEGORY_REASON[CATEGORY.RESPONSE_WITH_VALID_OUTREACH] = 'Response references an Outreach Log attempt whose OUTREACH identifier resolves exactly.';
CATEGORY_REASON[CATEGORY.RESPONSE_OUTREACH_NOT_FOUND] = 'Response references an outreach_id that has no matching attempt in the Outreach Log; the claimed attempt cannot be proven.';
CATEGORY_REASON[CATEGORY.RESPONSE_LEAD_NOT_FOUND] = 'Response references a lead_id with no outbound history at all in the Outreach Log.';
CATEGORY_REASON[CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID] = 'Response carries only a lead-level reference; no specific outbound attempt is referenced.';
CATEGORY_REASON[CATEGORY.CHANNEL_MISMATCH] = 'Channel parsed from the response outreach_id contradicts the response channel.';
CATEGORY_REASON[CATEGORY.OUTREACH_ID_FORMAT_INVALID] = 'Response outreach_id is not in the canonical EX-<lead_id>-<channel> format.';
CATEGORY_REASON[CATEGORY.DUPLICATE_RESPONSE] = 'More than one durable Response Log row shares the same canonical inbound idempotency key.';
CATEGORY_REASON[CATEGORY.DUPLICATE_OUTREACH_ID] = 'More than one Outreach Log row shares the same canonical outreach_id; the echoed attempt is ambiguous.';
CATEGORY_REASON[CATEGORY.INVALID_RESPONSE_RECORD] = 'Response Log row is missing required identity fields or carries a non-canonical response_status.';
CATEGORY_REASON[CATEGORY.INVALID_OUTREACH_RECORD] = 'Outreach Log row is missing required identity fields, lacks a confirmed sent_at, or carries a malformed outreach_id.';
CATEGORY_REASON[CATEGORY.READ_FAILURE] = 'A required reconciliation source could not be read.';
const OUTREACH_ID_REGEX = /^EX-(.+)-(email|call)$/;
const RESPONSE_STATUSES = ['CAPTURED', 'UNMATCHED'];

const isSupportedChannel = (channel) => channel !== '' && SUPPORTED_CHANNELS.indexOf(channel) !== -1;

const exception = (category, record, evidence) => ({
  category,
  severity: CATEGORY_SEVERITY[category] || SEVERITY.WARNING,
  response_id: record.response_id || '',
  lead_id: record.lead_id || '',
  outreach_id: record.outreach_id || '',
  channel: record.channel || '',
  reason: CATEGORY_REASON[category],
  evidence: evidence || {},
});

const card = (record, reconciliationStatus, relationship, reason) => ({
  response_id: record.response_id,
  lead_id: record.lead_id,
  outreach_id: record.outreach_id,
  channel: record.channel,
  response_status: record.response_status,
  reconciliation_status: reconciliationStatus,
  relationship,
  reason,
});

const normalizeResponseRows = (rows) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    response_id: str(row.response_id),
    idempotency_key: str(row.idempotency_key),
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    response_status: str(row.response_status).toUpperCase(),
    received_at: str(row.received_at),
    matched: row.matched === true || str(row.matched) === 'true',
  }));

const normalizeOutreachRows = (rows) =>
  (Array.isArray(rows) ? rows : []).map((row) => ({
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    sent_at: str(row.sent_at),
  }));

const isResponseRecordValid = (record) =>
  record.response_id !== '' &&
  record.idempotency_key !== '' &&
  isSupportedChannel(record.channel) &&
  RESPONSE_STATUSES.indexOf(record.response_status) !== -1;

const isOutreachRowValid = (row) =>
  row.lead_id !== '' &&
  row.outreach_id !== '' &&
  OUTREACH_ID_REGEX.test(row.outreach_id) &&
  isSupportedChannel(row.channel) &&
  row.sent_at !== '';

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

const classifyResponses = (rows, context) => {
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
        card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'invalid durable response record', CATEGORY_REASON[CATEGORY.INVALID_RESPONSE_RECORD]),
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
        card(rec, RECONCILIATION_STATUS.VIOLATION, 'duplicate inbound message identity', CATEGORY_REASON[CATEGORY.DUPLICATE_RESPONSE]),
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
        card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'capture-level unmatched; no identity to reconcile', 'Response was recorded UNMATCHED at capture; it carries no reconcilable identity.'),
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
          card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'lead-level relationship only; no specific attempt referenced', CATEGORY_REASON[CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID]),
        );
        rowExceptions.push(
          exception(CATEGORY.RESPONSE_WITHOUT_OUTREACH_ID, rec, {
            log_rows_for_lead: context.leadRowCounts.get(rec.lead_id) || 0,
          }),
        );
      } else {
        violationRows += 1;
        results.push(
          card(rec, RECONCILIATION_STATUS.VIOLATION, 'lead has no outbound history at all', CATEGORY_REASON[CATEGORY.RESPONSE_LEAD_NOT_FOUND]),
        );
        rowExceptions.push(exception(CATEGORY.RESPONSE_LEAD_NOT_FOUND, rec, {}));
      }
      continue;
    }

    const parsed = OUTREACH_ID_REGEX.exec(outreachId);
    if (!parsed) {
      notVerifiable += 1;
      results.push(
        card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'malformed outreach reference; cannot verify', CATEGORY_REASON[CATEGORY.OUTREACH_ID_FORMAT_INVALID]),
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
        card(rec, RECONCILIATION_STATUS.VIOLATION, 'channel mismatch between response and referenced attempt', CATEGORY_REASON[CATEGORY.CHANNEL_MISMATCH]),
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
          card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'duplicate outreach id; echoed attempt is ambiguous', CATEGORY_REASON[CATEGORY.DUPLICATE_OUTREACH_ID]),
        );
      } else {
        matched += 1;
        results.push(
          card(rec, RECONCILIATION_STATUS.VERIFIED, 'outreach_id resolves to exactly one confirmed Outreach Log attempt', CATEGORY_REASON[CATEGORY.RESPONSE_WITH_VALID_OUTREACH]),
        );
      }
      continue;
    }

    const raw = context.rawByOutreach.get(outreachId) || [];
    if (raw.length > 0) {
      notVerifiable += 1;
      results.push(
        card(rec, RECONCILIATION_STATUS.NOT_VERIFIABLE, 'outreach row found; send not confirmed (no sent_at)', 'An Outreach Log row exists for the referenced attempt but has no confirmed sent_at.'),
      );
      continue;
    }

    if (context.leadSet.has(rec.lead_id)) {
      violationRows += 1;
      results.push(
        card(rec, RECONCILIATION_STATUS.VIOLATION, 'specific outreach attempt not found; lead has other outbound history', CATEGORY_REASON[CATEGORY.RESPONSE_OUTREACH_NOT_FOUND]),
      );
      rowExceptions.push(exception(CATEGORY.RESPONSE_OUTREACH_NOT_FOUND, rec, {}));
    } else {
      violationRows += 1;
      results.push(
        card(rec, RECONCILIATION_STATUS.VIOLATION, 'lead has no outbound history at all', CATEGORY_REASON[CATEGORY.RESPONSE_LEAD_NOT_FOUND]),
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
};

const indexOutreach = (rows) => {
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
};

let responseReadError = '';
let outreachReadError = '';
for (const item of triggerItems) {
  const j = (item && item.json) || {};
  if (typeof j.response_log_read_error === 'string' && j.response_log_read_error !== '') responseReadError = j.response_log_read_error;
  if (typeof j.outreach_log_read_error === 'string' && j.outreach_log_read_error !== '') outreachReadError = j.outreach_log_read_error;
}

const responseRows = responseLogItems.map((item) => (item && item.json) || {});
const outreachRows = outreachLogItems.map((item) => (item && item.json) || {});
const nowMs = Date.now();
const runIdFinal = RUN_LABEL + '-' + digits14(String(nowMs));

const buildReadFailureReport = (responseReadError, outreachReadError, runAt) => {
  const failureExceptions = [];
  if (responseReadError) {
    failureExceptions.push(exception(CATEGORY.READ_FAILURE, {}, { source: 'response log', error: responseReadError }));
  }
  if (outreachReadError) {
    failureExceptions.push(exception(CATEGORY.READ_FAILURE, {}, { source: 'outreach log', error: outreachReadError }));
  }
  const reported = sortedExceptions(failureExceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runIdFinal }),
  );
  return {
    run_id: runIdFinal,
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
};

const buildReport = (responseRows, outreachContext, classification, runAt) => {
  const allExceptions = classification.rowExceptions.concat(outreachContext.outreachExceptions);
  const reported = sortedExceptions(allExceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runIdFinal }),
  );

  const coverageRate = classification.eligible > 0 ? Number((classification.linked / classification.eligible).toFixed(4)) : null;

  const summary = {
    response_records: responseRows.length,
    matched_records: classification.matched,
    unmatched_records: classification.unmatched,
    linked_records: classification.linked,
    not_verifiable: classification.notVerifiable,
    invalid_records: classification.invalid,
    duplicate_records: classification.duplicate,
    violations: reported.filter((e) => VIOLATION_CATEGORIES.indexOf(e.category) !== -1).length,
    coverage_rate: coverageRate,
    exception_count: reported.length,
  };

  return {
    run_id: runIdFinal,
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
};

const responseErr = str(responseReadError);
const outreachErr = str(outreachReadError);
const runAt = new Date(nowMs).toISOString();

let report;
if (responseErr || outreachErr) {
  report = buildReadFailureReport(responseErr, outreachErr, runAt);
} else {
  const responseRowsFinal = normalizeResponseRows(responseRows);
  const outreachRowsFinal = normalizeOutreachRows(outreachRows);
  const outreachContext = indexOutreach(outreachRowsFinal);
  const classification = classifyResponses(responseRowsFinal, outreachContext);
  report = buildReport(responseRowsFinal, outreachContext, classification, runAt);
}

return [
  { json: report },
  { json: { run_id: report.run_id, exception_count: report.summary.exception_count, exceptions: report.exceptions } },
];
`;

const reconcileCode = embeddedSource;

module.exports = { reconcileCode, embeddedSource };