'use strict';

/*
 * Execution Reconciliation V1 — read-only consistency engine.
 *
 * Reconciles the durable Outreach Log against the transient execution evidence
 * produced by Outreach-Execution-and-Delivery V1. THIS ARTIFACT NEVER WRITES:
 * it consumes source records and produces a structured, deterministic report.
 *
 * Evidence contract (established in the execution artifact):
 *   - A report carries mode (DRY_RUN|REAL), provider (SUCCESS|FAILURE|
 *     NOT_CONFIGURED), provider_configured, and per-candidate result cards.
 *   - A log row is appended ONLY for a provider-confirmed, REAL-mode send.
 *     DRY_RUN, NOT_CONFIGURED, and provider FAILURE never write a log row.
 *   - provider_message_id exists only inside a report, never in the sheet.
 *   - The canonical idempotency identity is (lead_id, channel).
 *
 * Every category is verbalized honestly:
 *   - LOG_WITHOUT_EXECUTION means "unable to establish independently", never
 *     "the log is wrong" when there is no execution evidence to compare.
 *   - DRY_RUN / NOT_CONFIGURED runs cannot be proven after the fact unless
 *     execution evidence was persisted at run time.
 *   - A source read failure yields FAILED with null metrics — never false zero.
 */

const SUPPORTED_CHANNELS = ['email', 'call'];

const RUN_LABEL = 'EXECRECON';

const STATUS = {
  COMPLETED: 'COMPLETED',
  INCOMPLETE: 'INCOMPLETE',
  FAILED: 'FAILED',
};

const CATEGORY = {
  EXECUTION_WITHOUT_LOG: 'EXECUTION_WITHOUT_LOG',
  LOG_WITHOUT_EXECUTION: 'LOG_WITHOUT_EXECUTION',
  DUPLICATE_EXECUTION: 'DUPLICATE_EXECUTION',
  DUPLICATE_LOG: 'DUPLICATE_LOG',
  FAILED_AS_SUCCESS: 'FAILED_AS_SUCCESS',
  NON_READY_EXECUTION: 'NON_READY_EXECUTION',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  DRY_RUN_PERSISTENCE: 'DRY_RUN_PERSISTENCE',
  NOT_CONFIGURED_PERSISTENCE: 'NOT_CONFIGURED_PERSISTENCE',
  MALFORMED_RECORD: 'MALFORMED_RECORD',
  SOURCE_READ_FAILURE: 'SOURCE_READ_FAILURE',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const CATEGORY_SEVERITY = {
  [CATEGORY.EXECUTION_WITHOUT_LOG]: SEVERITY.WARNING,
  [CATEGORY.LOG_WITHOUT_EXECUTION]: SEVERITY.WARNING,
  [CATEGORY.DUPLICATE_EXECUTION]: SEVERITY.ERROR,
  [CATEGORY.DUPLICATE_LOG]: SEVERITY.ERROR,
  [CATEGORY.FAILED_AS_SUCCESS]: SEVERITY.ERROR,
  [CATEGORY.NON_READY_EXECUTION]: SEVERITY.ERROR,
  [CATEGORY.INVALID_CHANNEL]: SEVERITY.WARNING,
  [CATEGORY.DRY_RUN_PERSISTENCE]: SEVERITY.ERROR,
  [CATEGORY.NOT_CONFIGURED_PERSISTENCE]: SEVERITY.ERROR,
  [CATEGORY.MALFORMED_RECORD]: SEVERITY.WARNING,
  [CATEGORY.SOURCE_READ_FAILURE]: SEVERITY.ERROR,
};

const VIOLATION_CATEGORIES = [
  CATEGORY.DUPLICATE_EXECUTION,
  CATEGORY.DUPLICATE_LOG,
  CATEGORY.FAILED_AS_SUCCESS,
  CATEGORY.NON_READY_EXECUTION,
  CATEGORY.DRY_RUN_PERSISTENCE,
  CATEGORY.NOT_CONFIGURED_PERSISTENCE,
];

const ATTEMPTED_STATUSES = ['EXECUTION_SUCCEEDED', 'EXECUTION_FAILED'];

const CATEGORY_REASON = {
  [CATEGORY.EXECUTION_WITHOUT_LOG]: 'Succeeded execution exists with no matching durable Outreach Log row.',
  [CATEGORY.LOG_WITHOUT_EXECUTION]: 'Outreach Log row has no matching execution evidence; provenance cannot be fully established.',
  [CATEGORY.DUPLICATE_EXECUTION]: 'More than one confirmed execution recorded for the same (lead_id, channel) identity.',
  [CATEGORY.DUPLICATE_LOG]: 'More than one Outreach Log row recorded for the same (lead_id, channel) identity.',
  [CATEGORY.FAILED_AS_SUCCESS]: 'Outreach Log row records activity whose only execution evidence is a provider failure; it must not be treated as a confirmed send.',
  [CATEGORY.NON_READY_EXECUTION]: 'Execution was attempted for a candidate whose readiness at execution time was not READY.',
  [CATEGORY.INVALID_CHANNEL]: 'Channel value is not a supported outreach channel.',
  [CATEGORY.DRY_RUN_PERSISTENCE]: 'Durable outreach activity exists for an identity whose execution evidence is DRY_RUN only; dry-run must not persist activity.',
  [CATEGORY.NOT_CONFIGURED_PERSISTENCE]: 'Durable outreach activity exists for an identity whose execution evidence is NOT_CONFIGURED only; nothing could have been sent.',
  [CATEGORY.MALFORMED_RECORD]: 'Record is missing required identity or state fields and could not be reconciled.',
  [CATEGORY.SOURCE_READ_FAILURE]: 'A required reconciliation source could not be read.',
};

function str(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function identityFor(leadId, channel) {
  return `${leadId}\u0000${channel}`;
}

function digits14(value) {
  const s = value.replace(/\D/g, '');
  return s.slice(0, 14).padEnd(14, '0');
}

/**
 * Flatten execution reports into one record per result card. Records carry the
 * run-level context (mode/provider/config) captured at execution time.
 */
function flattenExecutionRecords(reports) {
  const records = [];
  for (const report of Array.isArray(reports) ? reports : []) {
    if (!report || typeof report !== 'object') continue;
    const runId = str(report.run_id);
    const runAt = str(report.run_at);
    const mode = str(report.mode).toUpperCase();
    const provider = str(report.provider).toUpperCase();
    const providerConfigured = Boolean(report.provider_configured);
    for (const card of Array.isArray(report.results) ? report.results : []) {
      if (!card || typeof card !== 'object') continue;
      const providerCall = card.provider_call && typeof card.provider_call === 'object' ? card.provider_call : {};
      records.push({
        execution_id: runId,
        run_at: runAt,
        mode,
        provider,
        provider_configured: providerConfigured,
        lead_id: str(card.lead_id),
        outreach_id: str(card.outreach_id),
        channel: str(card.channel).toLowerCase(),
        status: str(card.status).toUpperCase(),
        reason: str(card.reason),
        readiness_status: str(card.readiness_status),
        sent_at: str(card.sent_at || runAt),
        provider_success: providerCall.success === true,
        provider_message_id: str(providerCall.provider_message_id),
        row_index: null,
      });
    }
  }
  return records;
}

function normalizeLogRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    lead_id: str(row.lead_id),
    outreach_id: str(row.outreach_id),
    channel: str(row.channel).toLowerCase(),
    sent_at: str(row.sent_at),
    email: str(row.email),
    phone: str(row.phone),
    source: 'outreach_log',
    row_index: index,
  }));
}

function isRecordValid(record) {
  return record.lead_id !== '' && record.channel !== '';
}

function isLogRowValid(row) {
  return row.lead_id !== '' && row.channel !== '' && row.sent_at !== '';
}

function isSupportedChannel(channel) {
  return channel !== '' && SUPPORTED_CHANNELS.includes(channel);
}

function exception(category, record, evidence) {
  return {
    category,
    severity: CATEGORY_SEVERITY[category],
    lead_id: record.lead_id || '',
    execution_id: record.execution_id || '',
    channel: record.channel || '',
    outreach_id: record.outreach_id || '',
    reason: CATEGORY_REASON[category],
    evidence,
  };
}

function sortedExceptions(exceptions) {
  return exceptions
    .map((e) => Object.assign({}, e))
    .sort((a, b) => {
      const keys = ['category', 'lead_id', 'channel', 'execution_id', 'outreach_id'];
      for (const key of keys) {
        const av = a[key];
        const bv = b[key];
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      const ae = JSON.stringify(a.evidence || {});
      const be = JSON.stringify(b.evidence || {});
      if (ae < be) return -1;
      if (ae > be) return 1;
      return 0;
    });
}

function sortedBy(list, keys) {
  return list
    .map((item) => item)
    .sort((a, b) => {
      for (const key of keys) {
        const av = a[key] || '';
        const bv = b[key] || '';
        if (av < bv) return -1;
        if (av > bv) return 1;
      }
      return 0;
    });
}

/**
 * Pair SUCCEEDED records with log rows by (lead_id, channel, sent_at). Greedy,
 * index-free, deterministic. Returns { matched, usedExecution, matchedLogs }.
 */
function pairBySentAt(succeededRecords, logRows) {
  const used = new Set();
  const matched = [];
  const matchedLogs = new Set();
  const sortedSucceeded = sortedBy(succeededRecords, ['sent_at', 'execution_id']);
  const sortedLogs = sortedBy(logRows, ['sent_at', 'outreach_id', 'lead_id']);
  const bySentAt = new Map();
  for (const log of sortedLogs) {
    if (!bySentAt.has(log.sent_at)) bySentAt.set(log.sent_at, []);
    bySentAt.get(log.sent_at).push(log);
  }
  for (const exec of sortedSucceeded) {
    const candidates = bySentAt.get(exec.sent_at) || [];
    const target = candidates.find((log) => !matchedLogs.has(log.row_index));
    if (target && !used.has(exec.row_index)) {
      used.add(exec.row_index);
      matchedLogs.add(target.row_index);
      matched.push({
        lead_id: target.lead_id,
        channel: target.channel,
        execution_id: exec.execution_id,
        outreach_id: target.outreach_id,
        sent_at: target.sent_at,
      });
    }
  }
  return { matched, used, matchedLogs, sortedSucceeded, sortedLogs };
}

function analyzeBucket(bucket, evidenceAvailable) {
  const result = {
    matched: [],
    unmatchedExecution: [],
    unmatchedLog: [],
    exceptions: [],
    duplicatesExecution: 0,
    duplicatesLog: 0,
  };
  const execs = bucket.executions;
  const logs = bucket.logs;
  const succeeded = execs.filter((r) => r.status === 'EXECUTION_SUCCEEDED');
  const failed = execs.filter((r) => r.status === 'EXECUTION_FAILED');
  const dryRunProducers = execs.filter((r) => r.mode === 'DRY_RUN');
  const notConfiguredProducers = execs.filter(
    (r) => r.provider === 'NOT_CONFIGURED' || r.provider_configured === false,
  );

  if (execs.length > 0 && evidenceAvailable) {
    for (const exec of execs) {
      if (
        ATTEMPTED_STATUSES.includes(exec.status) &&
        exec.readiness_status !== '' &&
        exec.readiness_status !== 'READY'
      ) {
        result.exceptions.push(
          exception(
            CATEGORY.NON_READY_EXECUTION,
            exec,
            { sent_at: exec.sent_at, readiness_status: exec.readiness_status, mode: exec.mode },
          ),
        );
      }
    }
  }

  if (logs.length > 1) {
    const sortedLogs = sortedBy(logs, ['sent_at', 'outreach_id', 'lead_id']);
    for (const log of sortedLogs.slice(1)) {
      result.exceptions.push(
        exception(
          CATEGORY.DUPLICATE_LOG,
          log,
          { sent_at: log.sent_at, outreach_id: log.outreach_id },
        ),
      );
      result.duplicatesLog += 1;
    }
  }

  if (!evidenceAvailable) return result;

  if (succeeded.length > 1) {
    const sortedSucceeded = sortedBy(succeeded, ['sent_at', 'execution_id', 'lead_id']);
    for (const exec of sortedSucceeded.slice(1)) {
      result.exceptions.push(
        exception(
          CATEGORY.DUPLICATE_EXECUTION,
          exec,
          { sent_at: exec.sent_at, execution_id: exec.execution_id, mode: exec.mode, provider: exec.provider },
        ),
      );
      result.duplicatesExecution += 1;
    }
  }

  const pairing = pairBySentAt(succeeded, logs);
  result.matched = pairing.matched;

  const unmatchedExecution = succeeded.filter((exec) => {
    if (pairing.used.has(exec.row_index)) return false;
    const extras = sortedBy(succeeded, ['sent_at', 'execution_id', 'lead_id']).slice(1);
    return !extras.some((extra) => extra.row_index === exec.row_index);
  });
  for (const exec of unmatchedExecution) {
    result.exceptions.push(
      exception(
        CATEGORY.EXECUTION_WITHOUT_LOG,
        exec,
        { sent_at: exec.sent_at, execution_id: exec.execution_id, mode: exec.mode, provider: exec.provider },
      ),
    );
    result.unmatchedExecution.push({
      lead_id: exec.lead_id,
      channel: exec.channel,
      execution_id: exec.execution_id,
      status: exec.status,
      sent_at: exec.sent_at,
      reason: exec.reason,
    });
  }

  const sortedLogs = sortedBy(logs, ['sent_at', 'outreach_id', 'lead_id']);
  const unmatchedLogs = sortedLogs.filter((log) => !pairing.matchedLogs.has(log.row_index));
  for (const log of unmatchedLogs) {
    let category;
    if (succeeded.length === 0 && dryRunProducers.length > 0) {
      category = CATEGORY.DRY_RUN_PERSISTENCE;
    } else if (succeeded.length === 0 && notConfiguredProducers.length > 0) {
      category = CATEGORY.NOT_CONFIGURED_PERSISTENCE;
    } else if (
      failed.some((f) => f.sent_at === log.sent_at) ||
      (succeeded.length === 0 && failed.length > 0)
    ) {
      category = CATEGORY.FAILED_AS_SUCCESS;
    } else {
      category = CATEGORY.LOG_WITHOUT_EXECUTION;
    }
    result.exceptions.push(
      exception(
        category,
        log,
        {
          sent_at: log.sent_at,
          outreach_id: log.outreach_id,
          mode: dryRunProducers.length > 0 ? 'DRY_RUN' : (notConfiguredProducers.length > 0 ? 'NOT_CONFIGURED' : undefined),
        },
      ),
    );
    result.unmatchedLog.push({
      lead_id: log.lead_id,
      channel: log.channel,
      outreach_id: log.outreach_id,
      sent_at: log.sent_at,
      category,
    });
  }

  return result;
}

function buildReport({
  executionRecords,
  logRows,
  normalizedLogs,
  evidenceAvailable,
  exceptions,
  sourceResults,
  now,
  failedSources,
}) {
  const runAt = new Date(now).toISOString();
  const runId = `${RUN_LABEL}-${digits14(String(now))}`;

  const hasReadFailure = Boolean(failedSources.evidence || failedSources.outreach);

  if (hasReadFailure) {
    const failureExceptions = [];
    if (failedSources.evidence) {
      failureExceptions.push(
        exception(
          CATEGORY.SOURCE_READ_FAILURE,
          {},
          { source: 'execution evidence', error: failedSources.evidence },
        ),
      );
    }
    if (failedSources.outreach) {
      failureExceptions.push(
        exception(
          CATEGORY.SOURCE_READ_FAILURE,
          {},
          { source: 'outreach log', error: failedSources.outreach },
        ),
      );
    }
    const sorted = sortedExceptions(failureExceptions).map((e) =>
      Object.assign({}, e, { detected_at: runAt, run_id: runId }),
    );
    return {
      run_id: runId,
      run_at: runAt,
      detected_at: runAt,
      evidence_available: evidenceAvailable,
      status: STATUS.FAILED,
      sources: {
        evidence_ok: !failedSources.evidence,
        outreach_ok: !failedSources.outreach,
        evidence_read_error: failedSources.evidence || '',
        outreach_read_error: failedSources.outreach || '',
        evidence_available: evidenceAvailable,
      },
      summary: {
        execution_records: null,
        log_records: null,
        matched: null,
        unmatched_execution: null,
        unmatched_log: null,
        duplicate_execution: null,
        duplicate_log: null,
        invalid_execution: null,
        invalid_log: null,
        violations: null,
        coverage_rate: null,
        exception_count: sorted.length,
      },
      matched: [],
      unmatched_execution: [],
      unmatched_log: [],
      exceptions: sorted,
    };
  }

  const bucketMap = new Map();
  const invalidExecution = [];
  const invalidLogs = [];
  const invalidChannelExecution = [];
  const invalidChannelLogs = [];

  for (const record of executionRecords) {
    if (!isRecordValid(record)) {
      invalidExecution.push(record);
      continue;
    }
    if (!isSupportedChannel(record.channel)) {
      invalidChannelExecution.push(record);
      continue;
    }
    record.row_index = executionRecords.indexOf(record);
    const key = identityFor(record.lead_id, record.channel);
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { lead_id: record.lead_id, channel: record.channel, executions: [], logs: [] });
    }
    bucketMap.get(key).executions.push(record);
  }

  for (const row of normalizedLogs) {
    if (!isLogRowValid(row)) {
      invalidLogs.push(row);
      continue;
    }
    if (!isSupportedChannel(row.channel)) {
      invalidChannelLogs.push(row);
      continue;
    }
    const key = identityFor(row.lead_id, row.channel);
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { lead_id: row.lead_id, channel: row.channel, executions: [], logs: [] });
    }
    bucketMap.get(key).logs.push(row);
  }

  const allExceptions = [];
  const matched = [];
  const unmatchedExecution = [];
  const unmatchedLog = [];
  let duplicatesExecution = 0;
  let duplicatesLog = 0;

  for (const record of invalidExecution) {
    allExceptions.push(exception(CATEGORY.MALFORMED_RECORD, record, { source: 'execution evidence', reason: 'missing lead_id or channel' }));
  }
  for (const record of invalidChannelExecution) {
    allExceptions.push(exception(CATEGORY.INVALID_CHANNEL, record, { source: 'execution evidence', channel: record.channel }));
  }
  for (const row of invalidLogs) {
    allExceptions.push(exception(CATEGORY.MALFORMED_RECORD, row, { source: 'outreach log', reason: 'missing lead_id, channel or sent_at' }));
  }
  for (const row of invalidChannelLogs) {
    allExceptions.push(exception(CATEGORY.INVALID_CHANNEL, row, { source: 'outreach log', channel: row.channel }));
  }

  for (const bucket of bucketMap.values()) {
    const analysis = analyzeBucket(bucket, evidenceAvailable);
    allExceptions.push(...analysis.exceptions);
    matched.push(...analysis.matched);
    unmatchedExecution.push(...analysis.unmatchedExecution);
    unmatchedLog.push(...analysis.unmatchedLog);
    duplicatesExecution += analysis.duplicatesExecution;
    duplicatesLog += analysis.duplicatesLog;
  }

  const reportedExceptions = sortedExceptions(allExceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runId }),
  );

  const matchingAllowed = evidenceAvailable && !hasReadFailure;
  const matchedLogs = matched.length;
  const logRecords = normalizedLogs.length;
  const executionRecordsCount = executionRecords.length;

  const summary = {
    execution_records: matchingAllowed ? executionRecordsCount : null,
    log_records: logRecords,
    matched: matchingAllowed ? matchedLogs : null,
    unmatched_execution: matchingAllowed ? unmatchedExecution.length : null,
    unmatched_log: matchingAllowed ? unmatchedLog.length : null,
    duplicate_execution: matchingAllowed ? duplicatesExecution : null,
    duplicate_log: duplicatesLog,
    invalid_execution: matchingAllowed ? invalidExecution.length : null,
    invalid_log: invalidLogs.length,
    violations: reportedExceptions.filter((e) => VIOLATION_CATEGORIES.includes(e.category)).length,
    coverage_rate: matchingAllowed && logRecords > 0 ? Number((matchedLogs / logRecords).toFixed(4)) : null,
    exception_count: reportedExceptions.length,
  };

  return {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    evidence_available: evidenceAvailable,
    status: evidenceAvailable ? STATUS.COMPLETED : STATUS.INCOMPLETE,
    sources: {
      evidence_ok: true,
      outreach_ok: true,
      evidence_read_error: '',
      outreach_read_error: '',
      evidence_available: evidenceAvailable,
    },
    summary,
    matched: sortedBy(matched, ['lead_id', 'channel', 'sent_at', 'execution_id']),
    unmatched_execution: sortedBy(unmatchedExecution, ['lead_id', 'channel', 'sent_at']),
    unmatched_log: sortedBy(unmatchedLog, ['lead_id', 'channel', 'sent_at']),
    exceptions: reportedExceptions,
  };
}

/**
 * Pure reconciliation entry point.
 *
 * @param {Object} options
 * @param {Array}  [options.executionReports] raw execution reports (source-of-truth contract).
 * @param {Array}  [options.logRows]          normalized Outreach Log rows.
 * @param {boolean}[options.evidenceAvailable] true when the report set is a complete,
 *      successfully-read evidence source (default true).
 * @param {Object} [options.readErrors]       { evidence, outreach } read failures.
 * @param {Date|number|string} [options.now]  injected clock for determinism.
 */
function reconcileExecution({ executionReports, logRows, evidenceAvailable, readErrors, now } = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const evidenceAvailableFlag = evidenceAvailable === undefined ? true : Boolean(evidenceAvailable);
  const failedSources = {
    evidence: str(readErrors && readErrors.evidence),
    outreach: str(readErrors && readErrors.outreach),
  };

  const executionRecords = flattenExecutionRecords(executionReports);
  const normalizedLogs = normalizeLogRows(logRows);

  return buildReport({
    executionRecords,
    logRows,
    normalizedLogs,
    evidenceAvailable: evidenceAvailableFlag,
    exceptions: [],
    sourceResults: {},
    now: nowMs,
    failedSources,
  });
}

module.exports = {
  SUPPORTED_CHANNELS,
  RUN_LABEL,
  STATUS,
  CATEGORY,
  SEVERITY,
  CATEGORY_SEVERITY,
  VIOLATION_CATEGORIES,
  CATEGORY_REASON,
  flattenExecutionRecords,
  normalizeLogRows,
  reconcileExecution,
};