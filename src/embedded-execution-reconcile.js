'use strict';

/*
 * Embedded code for the Execution-Reconciliation V1 n8n workflow.
 *
 * These strings are assembled into Execution-Reconciliation V1.json by
 * scripts/build-execution-reconciliation-workflow.js. The Reconcile Execution
 * Records node embeds a synchronous mirror of src/execution-reconcile.js.
 * The workflow test suite asserts the embedded code stays in sync with the
 * engine on every fixture (parity test).
 *
 * This is a READ-ONLY workflow: it performs no writes, no provider calls, no
 * execution, and no scheduling. The execution evidence is supplied by an
 * operator into the Initialize Execution Evidence node (execution V1 does not
 * persist evidence to any sheet; pasting the run's captured report is the only
 * way a real instance of this workflow can verify provenance).
 */

const embeddedSource = `'use strict';

const evidenceItems = $('Initialize Execution Evidence').all();
const logItems = $('Read Outreach Log').all();

const str = (value) => (value === undefined || value === null ? '' : String(value));
const RUN_LABEL = 'EXECRECON';
const SUPPORTED_CHANNELS = ['email', 'call'];
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
const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING' };
const CATEGORY_SEVERITY = {};
CATEGORY_SEVERITY[CATEGORY.EXECUTION_WITHOUT_LOG] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.LOG_WITHOUT_EXECUTION] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.DUPLICATE_EXECUTION] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.DUPLICATE_LOG] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.FAILED_AS_SUCCESS] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.NON_READY_EXECUTION] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.INVALID_CHANNEL] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.DRY_RUN_PERSISTENCE] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.NOT_CONFIGURED_PERSISTENCE] = SEVERITY.ERROR;
CATEGORY_SEVERITY[CATEGORY.MALFORMED_RECORD] = SEVERITY.WARNING;
CATEGORY_SEVERITY[CATEGORY.SOURCE_READ_FAILURE] = SEVERITY.ERROR;
const VIOLATION_CATEGORIES = [
  CATEGORY.DUPLICATE_EXECUTION, CATEGORY.DUPLICATE_LOG, CATEGORY.FAILED_AS_SUCCESS,
  CATEGORY.NON_READY_EXECUTION, CATEGORY.DRY_RUN_PERSISTENCE, CATEGORY.NOT_CONFIGURED_PERSISTENCE,
];
const ATTEMPTED_STATUSES = ['EXECUTION_SUCCEEDED', 'EXECUTION_FAILED'];
const CATEGORY_REASON = {};
CATEGORY_REASON[CATEGORY.EXECUTION_WITHOUT_LOG] = 'Succeeded execution exists with no matching durable Outreach Log row.';
CATEGORY_REASON[CATEGORY.LOG_WITHOUT_EXECUTION] = 'Outreach Log row has no matching execution evidence; provenance cannot be fully established.';
CATEGORY_REASON[CATEGORY.DUPLICATE_EXECUTION] = 'More than one confirmed execution recorded for the same (lead_id, channel) identity.';
CATEGORY_REASON[CATEGORY.DUPLICATE_LOG] = 'More than one Outreach Log row recorded for the same (lead_id, channel) identity.';
CATEGORY_REASON[CATEGORY.FAILED_AS_SUCCESS] = 'Outreach Log row records activity whose only execution evidence is a provider failure; it must not be treated as a confirmed send.';
CATEGORY_REASON[CATEGORY.NON_READY_EXECUTION] = 'Execution was attempted for a candidate whose readiness at execution time was not READY.';
CATEGORY_REASON[CATEGORY.INVALID_CHANNEL] = 'Channel value is not a supported outreach channel.';
CATEGORY_REASON[CATEGORY.DRY_RUN_PERSISTENCE] = 'Durable outreach activity exists for an identity whose execution evidence is DRY_RUN only; dry-run must not persist activity.';
CATEGORY_REASON[CATEGORY.NOT_CONFIGURED_PERSISTENCE] = 'Durable outreach activity exists for an identity whose execution evidence is NOT_CONFIGURED only; nothing could have been sent.';
CATEGORY_REASON[CATEGORY.MALFORMED_RECORD] = 'Record is missing required identity or state fields and could not be reconciled.';
CATEGORY_REASON[CATEGORY.SOURCE_READ_FAILURE] = 'A required reconciliation source could not be read.';

const exceptionRow = (category, record) => ({
  category,
  severity: CATEGORY_SEVERITY[category],
  lead_id: str(record.lead_id),
  execution_id: str(record.execution_id),
  channel: str(record.channel),
  outreach_id: str(record.outreach_id),
  reason: CATEGORY_REASON[category],
  evidence: {},
});

const sortedExceptions = (exceptions) =>
  exceptions.slice().sort((a, b) => {
    for (const key of ['category', 'lead_id', 'channel', 'execution_id', 'outreach_id']) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return JSON.stringify(a.evidence).localeCompare(JSON.stringify(b.evidence));
  });

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

const identityFor = (leadId, channel) => leadId + '\\u0000' + channel;

let execution_reports = [];
let evidence_available = true;
const read_errors = {};
for (const item of evidenceItems) {
  const j = (item && item.json) || {};
  if (Array.isArray(j.execution_reports)) execution_reports = execution_reports.concat(j.execution_reports);
  else if (str(j.run_id)) execution_reports.push(j);
  if (typeof j.evidence_available === 'boolean') evidence_available = j.evidence_available;
  if (j.read_errors && typeof j.read_errors === 'object') {
    if (typeof j.read_errors.evidence === 'string' && j.read_errors.evidence) read_errors.evidence = j.read_errors.evidence;
    if (typeof j.read_errors.outreach === 'string' && j.read_errors.outreach) read_errors.outreach = j.read_errors.outreach;
  }
}
const logRows = logItems.map((item) => (item && item.json) || {});

const readFailureEvidence = read_errors.evidence || '';
const readFailureOutreach = read_errors.outreach || '';
const runAt = new Date().toISOString();
const runId = RUN_LABEL + '-' + String(runAt).replace(/\\D/g, '').slice(0, 14).padEnd(14, '0');

if (readFailureEvidence || readFailureOutreach) {
  const failureExceptions = [];
  if (readFailureEvidence) {
    const e = exceptionRow(CATEGORY.SOURCE_READ_FAILURE, {});
    e.evidence = { source: 'execution evidence', error: readFailureEvidence };
    failureExceptions.push(e);
  }
  if (readFailureOutreach) {
    const e = exceptionRow(CATEGORY.SOURCE_READ_FAILURE, {});
    e.evidence = { source: 'outreach log', error: readFailureOutreach };
    failureExceptions.push(e);
  }
  const failedReport = {
    run_id: runId,
    run_at: runAt,
    detected_at: runAt,
    evidence_available,
    status: 'FAILED',
    sources: {
      evidence_ok: !readFailureEvidence,
      outreach_ok: !readFailureOutreach,
      evidence_read_error: readFailureEvidence,
      outreach_read_error: readFailureOutreach,
      evidence_available,
    },
    summary: {
      execution_records: null, log_records: null, matched: null, unmatched_execution: null,
      unmatched_log: null, duplicate_execution: null, duplicate_log: null,
      invalid_execution: null, invalid_log: null, violations: null, coverage_rate: null,
      exception_count: failureExceptions.length,
    },
    matched: [],
    unmatched_execution: [],
    unmatched_log: [],
    exceptions: sortedExceptions(failureExceptions),
  };
  return [
    { json: failedReport },
    { json: { run_id: failedReport.run_id, exception_count: failureExceptions.length, exceptions: failedReport.exceptions } },
  ];
}

const records = [];
for (const report of execution_reports) {
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
      execution_id: runId, run_at: runAt, mode, provider, provider_configured: providerConfigured,
      lead_id: str(card.lead_id), outreach_id: str(card.outreach_id), channel: str(card.channel).toLowerCase(),
      status: str(card.status).toUpperCase(), reason: str(card.reason), readiness_status: str(card.readiness_status),
      sent_at: str(card.sent_at || runAt), provider_success: providerCall.success === true,
      provider_message_id: str(providerCall.provider_message_id), row_index: null,
    });
  }
}
const logs = logRows.map((row, index) => ({
  lead_id: str(row.lead_id), outreach_id: str(row.outreach_id), channel: str(row.channel).toLowerCase(),
  sent_at: str(row.sent_at), email: str(row.email), phone: str(row.phone), source: 'outreach_log', row_index: index,
}));

const isRecordValid = (r) => r.lead_id !== '' && r.channel !== '';
const isLogRowValid = (r) => r.lead_id !== '' && r.channel !== '' && r.sent_at !== '';
const isSupportedChannel = (ch) => ch !== '' && SUPPORTED_CHANNELS.indexOf(ch) !== -1;

const bucketMap = new Map();
const invalidExecution = [];
const invalidLogs = [];
const invalidChannelExecution = [];
const invalidChannelLogs = [];

for (const record of records) {
  if (!isRecordValid(record)) { invalidExecution.push(record); continue; }
  if (!isSupportedChannel(record.channel)) { invalidChannelExecution.push(record); continue; }
  record.row_index = records.indexOf(record);
  const key = identityFor(record.lead_id, record.channel);
  if (!bucketMap.has(key)) bucketMap.set(key, { lead_id: record.lead_id, channel: record.channel, executions: [], logs: [] });
  bucketMap.get(key).executions.push(record);
}
for (const row of logs) {
  if (!isLogRowValid(row)) { invalidLogs.push(row); continue; }
  if (!isSupportedChannel(row.channel)) { invalidChannelLogs.push(row); continue; }
  const key = identityFor(row.lead_id, row.channel);
  if (!bucketMap.has(key)) bucketMap.set(key, { lead_id: row.lead_id, channel: row.channel, executions: [], logs: [] });
  bucketMap.get(key).logs.push(row);
}

function analyzeBucket(bucket, evidenceAvailable) {
  const result = { matched: [], unmatchedExecution: [], unmatchedLog: [], exceptions: [], duplicatesExecution: 0, duplicatesLog: 0 };
  const execs = bucket.executions;
  const logs = bucket.logs;
  const succeeded = execs.filter((r) => r.status === 'EXECUTION_SUCCEEDED');
  const failed = execs.filter((r) => r.status === 'EXECUTION_FAILED');
  const dryRunProducers = execs.filter((r) => r.mode === 'DRY_RUN');
  const notConfiguredProducers = execs.filter((r) => r.provider === 'NOT_CONFIGURED' || r.provider_configured === false);

  if (execs.length > 0 && evidenceAvailable) {
    for (const exec of execs) {
      if (ATTEMPTED_STATUSES.indexOf(exec.status) !== -1 && exec.readiness_status !== '' && exec.readiness_status !== 'READY') {
        const e = exceptionRow(CATEGORY.NON_READY_EXECUTION, exec);
        e.evidence = { sent_at: exec.sent_at, readiness_status: exec.readiness_status, mode: exec.mode };
        result.exceptions.push(e);
      }
    }
  }

  if (logs.length > 1) {
    const sorted = sortedBy(logs, ['sent_at', 'outreach_id', 'lead_id']);
    for (const log of sorted.slice(1)) {
      const e = exceptionRow(CATEGORY.DUPLICATE_LOG, log);
      e.evidence = { sent_at: log.sent_at, outreach_id: log.outreach_id };
      result.exceptions.push(e);
      result.duplicatesLog += 1;
    }
  }

  if (!evidenceAvailable) return result;

  if (succeeded.length > 1) {
    const sortedSucceeded = sortedBy(succeeded, ['sent_at', 'execution_id', 'lead_id']);
    for (const exec of sortedSucceeded.slice(1)) {
      const e = exceptionRow(CATEGORY.DUPLICATE_EXECUTION, exec);
      e.evidence = { sent_at: exec.sent_at, execution_id: exec.execution_id, mode: exec.mode, provider: exec.provider };
      result.exceptions.push(e);
      result.duplicatesExecution += 1;
    }
  }

  const used = new Set();
  const matchedLogs = new Set();
  const sortedSucceeded = sortedBy(succeeded, ['sent_at', 'execution_id']);
  const sortedLogs = sortedBy(logs, ['sent_at', 'outreach_id', 'lead_id']);
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
      result.matched.push({ lead_id: target.lead_id, channel: target.channel, execution_id: exec.execution_id, outreach_id: target.outreach_id, sent_at: target.sent_at });
    }
  }

  const extras = sortedBy(succeeded, ['sent_at', 'execution_id', 'lead_id']).slice(1);
  for (const exec of succeeded) {
    if (used.has(exec.row_index)) continue;
    if (extras.some((extra) => extra.row_index === exec.row_index)) continue;
    const e = exceptionRow(CATEGORY.EXECUTION_WITHOUT_LOG, exec);
    e.evidence = { sent_at: exec.sent_at, execution_id: exec.execution_id, mode: exec.mode, provider: exec.provider };
    result.exceptions.push(e);
    result.unmatchedExecution.push({ lead_id: exec.lead_id, channel: exec.channel, execution_id: exec.execution_id, status: exec.status, sent_at: exec.sent_at, reason: exec.reason });
  }

  for (const log of sortedLogs) {
    if (matchedLogs.has(log.row_index)) continue;
    let category;
    if (succeeded.length === 0 && dryRunProducers.length > 0) category = CATEGORY.DRY_RUN_PERSISTENCE;
    else if (succeeded.length === 0 && notConfiguredProducers.length > 0) category = CATEGORY.NOT_CONFIGURED_PERSISTENCE;
    else if (failed.some((f) => f.sent_at === log.sent_at) || (succeeded.length === 0 && failed.length > 0)) category = CATEGORY.FAILED_AS_SUCCESS;
    else category = CATEGORY.LOG_WITHOUT_EXECUTION;
    const e = exceptionRow(category, log);
    e.evidence = { sent_at: log.sent_at, outreach_id: log.outreach_id, mode: dryRunProducers.length > 0 ? 'DRY_RUN' : (notConfiguredProducers.length > 0 ? 'NOT_CONFIGURED' : undefined) };
    result.exceptions.push(e);
    result.unmatchedLog.push({ lead_id: log.lead_id, channel: log.channel, outreach_id: log.outreach_id, sent_at: log.sent_at, category });
  }

  return result;
}

const allExceptions = [];
const matched = [];
const unmatchedExecution = [];
const unmatchedLog = [];
let duplicatesExecution = 0;
let duplicatesLog = 0;

for (const record of invalidExecution) {
  const e = exceptionRow(CATEGORY.MALFORMED_RECORD, record);
  e.evidence = { source: 'execution evidence', reason: 'missing lead_id or channel' };
  allExceptions.push(e);
}
for (const record of invalidChannelExecution) {
  const e = exceptionRow(CATEGORY.INVALID_CHANNEL, record);
  e.evidence = { source: 'execution evidence', channel: record.channel };
  allExceptions.push(e);
}
for (const row of invalidLogs) {
  const e = exceptionRow(CATEGORY.MALFORMED_RECORD, row);
  e.evidence = { source: 'outreach log', reason: 'missing lead_id, channel or sent_at' };
  allExceptions.push(e);
}
for (const row of invalidChannelLogs) {
  const e = exceptionRow(CATEGORY.INVALID_CHANNEL, row);
  e.evidence = { source: 'outreach log', channel: row.channel };
  allExceptions.push(e);
}

for (const bucket of bucketMap.values()) {
  const analysis = analyzeBucket(bucket, evidence_available);
  allExceptions.push.apply(allExceptions, analysis.exceptions);
  matched.push.apply(matched, analysis.matched);
  unmatchedExecution.push.apply(unmatchedExecution, analysis.unmatchedExecution);
  unmatchedLog.push.apply(unmatchedLog, analysis.unmatchedLog);
  duplicatesExecution += analysis.duplicatesExecution;
  duplicatesLog += analysis.duplicatesLog;
}

const reportedExceptions = sortedExceptions(allExceptions);

const matchingAllowed = evidence_available;
const matchedLogs = matched.length;
const logRecords = logs.length;
const executionRecordsCount = records.length;
const violationCount = reportedExceptions.filter((e) => VIOLATION_CATEGORIES.indexOf(e.category) !== -1).length;
const invalidExecutionCount = invalidExecution.length;
const invalidLogCount = invalidLogs.length;

const report = {
  run_id: runId,
  run_at: runAt,
  detected_at: runAt,
  evidence_available,
  status: evidence_available ? 'COMPLETED' : 'INCOMPLETE',
  sources: { evidence_ok: true, outreach_ok: true, evidence_read_error: '', outreach_read_error: '', evidence_available },
  summary: {
    execution_records: matchingAllowed ? executionRecordsCount : null,
    log_records: logRecords,
    matched: matchingAllowed ? matchedLogs : null,
    unmatched_execution: matchingAllowed ? unmatchedExecution.length : null,
    unmatched_log: matchingAllowed ? unmatchedLog.length : null,
    duplicate_execution: matchingAllowed ? duplicatesExecution : null,
    duplicate_log: duplicatesLog,
    invalid_execution: matchingAllowed ? invalidExecutionCount : null,
    invalid_log: invalidLogCount,
    violations: violationCount,
    coverage_rate: matchingAllowed && logRecords > 0 ? Number((matchedLogs / logRecords).toFixed(4)) : null,
    exception_count: reportedExceptions.length,
  },
  matched: sortedBy(matched, ['lead_id', 'channel', 'sent_at', 'execution_id']),
  unmatched_execution: sortedBy(unmatchedExecution, ['lead_id', 'channel', 'sent_at']),
  unmatched_log: sortedBy(unmatchedLog, ['lead_id', 'channel', 'sent_at']),
  exceptions: reportedExceptions,
};

return [
  { json: report },
  { json: { run_id: report.run_id, exception_count: report.exception_count === undefined ? report.summary.exception_count : report.exception_count, exceptions: report.exceptions } },
];
`;

const initEvidenceCode = [
  "const execution_reports = $json && Array.isArray($json.execution_reports) ? $json.execution_reports : [];",
  "const evidence_available = $json && typeof $json.evidence_available === 'boolean' ? $json.evidence_available : true;",
  "return [{ json: { execution_reports, evidence_available } }];",
].join('\n');

const reconcileCode = embeddedSource.replace(/\\u0000/g, '\u0000');

module.exports = { initEvidenceCode, reconcileCode, embeddedSource };