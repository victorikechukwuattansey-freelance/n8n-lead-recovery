'use strict';

const { APPROVED_COLUMNS, normalize } = require('./schema');
const { OUTREACH_COLUMNS } = require('./reconcile');

/*
 * Outreach-Queue-and-Planning V1 — read-first, deterministic planning projection.
 *
 * Consumes the persisted Approved Outreach approval ledger (source of truth for
 * approval) and the Outreach Log activity history, and produces:
 *   - queue: exactly one planning record per approved lead_id (identity = lead_id)
 *   - readiness: READY | NOT_READY | BLOCKED
 *   - available_channel: email | call | none
 *   - priority rank (score desc, then approved_at asc, then lead_id)
 *   - outreach history (count, last sent_at, latest channel/outcome)
 *   - exceptions: orphans, malformed approvals, malformed outreach
 *
 * Contract:
 *   - read-only. No outreach, no scheduling, no follow-ups, no enrichment and no
 *     mutation of Approved Outreach / Outreach Log / Verified Leads.
 *   - The queue is a projection only: READY means "sufficient information for a
 *     future execution step", never "outreach was sent". Only Outreach Log can
 *     establish actual outreach activity.
 *   - Readiness vocabulary (queue-level, distinct from Approved status):
 *     READY | NOT_READY | BLOCKED. BLOCKED is used only for the one canonical
 *     blocking condition in the repository's status vocabulary: `suppressed`.
 *   - Channel determination (Approved `channel` column is authoritative when set,
 *     then inference fallback when it is empty):
 *       1. Approved `channel` = 'email'  -> email  (requires a non-empty email)
 *       2. Approved `channel` = 'call'   -> call   (requires a usable phone)
 *       3. channel empty -> inference:
 *            a. non-empty email_verified        -> email (legacy evidence field)
 *            b. phone with >= 7 digits          -> call
 *            c. otherwise                       -> none (NOT_READY)
 *     Verified email is only established by `email_verified` (legacy, no longer on
 *     the live Approved sheet) or by the Approved `channel` column. contact_form is NOT
 *     treated as an outreach channel (no repository evidence).
 *   - Outreach Log rows imply history only when both lead_id and sent_at are
 *     present. Malformed rows cannot imply activity.
 *   - A source read failure yields status QUEUE_INCOMPLETE with null metrics and
 *     an empty queue — never a false healthy queue.
 *   - Identical sheet contents produce an identical queue projection.
 *
 * Mirrors the reconciliation engine's concepts (OUTREACH_WITHOUT_APPROVAL /
 * MALFORMED_* / error-or-incomplete semantics) without duplicating its algorithm.
 */

const QUEUE_FIELDS = [
  'queue_id',
  'lead_id',
  'business_name',
  'niche',
  'city',
  'state',
  'country',
  'score',
  'available_channel',
  'readiness_status',
  'priority',
  'approved_at',
  'queued_at',
  'last_outreach_at',
  'outreach_count',
  'latest_channel',
  'latest_outcome',
  'enrichment_required',
  'reason',
  'notes',
];

const RUN_LABEL = 'QUEUE';

const READINESS = {
  READY: 'READY',
  NOT_READY: 'NOT_READY',
  BLOCKED: 'BLOCKED',
};

const CHANNEL = {
  EMAIL: 'email',
  CALL: 'call',
  NONE: 'none',
};

const SUPPORTED_CHANNELS = [CHANNEL.EMAIL, CHANNEL.CALL];

const MIN_PHONE_DIGITS = 7;

const EXCEPTION_TYPE = {
  OUTREACH_WITHOUT_APPROVAL: 'OUTREACH_WITHOUT_APPROVAL',
  MALFORMED_OUTREACH: 'MALFORMED_OUTREACH',
  MALFORMED_APPROVAL: 'MALFORMED_APPROVAL',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const REPORT_FIELDS = [
  'approved_total',
  'queue_total',
  'ready_count',
  'not_ready_count',
  'blocked_count',
  'email_ready_count',
  'call_ready_count',
  'outreach_total',
  'duplicate_approval_ids',
  'malformed_approvals',
  'orphan_outreach',
  'malformed_outreach',
  'history_attached',
  'exception_count',
];

function countDigits(value) {
  return String(value).replace(/\D+/g, '').length;
}

function parseScore(value) {
  const n = Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

function isVerifiedEmail(record) {
  return normalize(record.email_verified) !== '';
}

function isUsablePhone(record) {
  const phone = normalize(record.phone);
  return phone !== '' && countDigits(phone) >= MIN_PHONE_DIGITS;
}

function isSuppressed(record) {
  return normalize(record.status) === 'suppressed';
}

/**
 * Readiness + channel for one approved record. BLOCKED applies only to the
 * canonical `suppressed` status; otherwise the record is READY when the channel
 * model can be satisfied from current data, else NOT_READY.
 */
function readinessFor(record) {
  if (isSuppressed(record)) {
    return { available_channel: CHANNEL.NONE, readiness_status: READINESS.BLOCKED, reason: 'suppressed' };
  }
  const requested = normalize(record.channel);
  if (requested === 'email') {
    if (normalize(record.email) !== '') {
      return { available_channel: CHANNEL.EMAIL, readiness_status: READINESS.READY, reason: 'channel email with address' };
    }
    return { available_channel: CHANNEL.NONE, readiness_status: READINESS.NOT_READY, reason: 'channel email but no email address' };
  }
  if (requested === 'call') {
    if (isUsablePhone(record)) {
      return { available_channel: CHANNEL.CALL, readiness_status: READINESS.READY, reason: 'channel call with usable phone' };
    }
    return { available_channel: CHANNEL.NONE, readiness_status: READINESS.NOT_READY, reason: 'channel call but phone not usable' };
  }
  if (isVerifiedEmail(record)) {
    return { available_channel: CHANNEL.EMAIL, readiness_status: READINESS.READY, reason: 'verified email available' };
  }
  if (isUsablePhone(record)) {
    return { available_channel: CHANNEL.CALL, readiness_status: READINESS.READY, reason: 'phone available' };
  }
  return { available_channel: CHANNEL.NONE, readiness_status: READINESS.NOT_READY, reason: 'no available channel' };
}

/**
 * Index Approved Outreach rows by lead_id. First occurrence is canonical;
 * duplicates and malformed rows (missing lead_id or approved_at) are surfaced.
 */
function buildApprovalIndex(rows) {
  const index = new Map();
  const malformed = [];
  const duplicates = [];
  rows.forEach((row, i) => {
    const leadId = normalize(row.lead_id);
    const approvedAt = normalize(row.approved_at);
    if (!leadId || !approvedAt) {
      malformed.push({ lead_id: leadId, business_name: normalize(row.business_name), status: normalize(row.status), approved_at: approvedAt });
      return;
    }
    if (index.has(leadId)) {
      duplicates.push({ lead_id: leadId, business_name: normalize(row.business_name), approved_at: approvedAt });
      return;
    }
    index.set(leadId, { row: Object.assign({}, row), index: i, leadId, approvedAt });
  });
  return { index, malformed, duplicates };
}

/**
 * Index Outreach Log rows by lead_id, limited to rows that can imply activity
 * (lead_id + sent_at present), sorted by sent_at (row order breaks ties).
 */
function buildHistoryIndex(rows) {
  const malformed = [];
  const byLead = new Map();
  rows.forEach((row, i) => {
    const leadId = normalize(row.lead_id);
    const sentAt = normalize(row.sent_at);
    if (!leadId || !sentAt) {
      malformed.push({ lead_id: leadId, outreach_id: normalize(row.outreach_id), business_name: normalize(row.business_name) });
      return;
    }
    if (!byLead.has(leadId)) byLead.set(leadId, []);
    byLead.get(leadId).push({
      leadId,
      sentAt,
      channel: normalize(row.channel),
      outcome: normalize(row.outcome),
      outreach_id: normalize(row.outreach_id),
      rowIndex: i,
    });
  });
  for (const records of byLead.values()) {
    records.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.rowIndex - b.rowIndex));
  }
  return { index: byLead, malformed };
}

function buildHistory(records) {
  if (!records || records.length === 0) {
    return { outreach_count: 0, last_outreach_at: '', latest_channel: '', latest_outcome: '' };
  }
  const latest = records[records.length - 1];
  return {
    outreach_count: records.length,
    last_outreach_at: latest.sentAt,
    latest_channel: latest.channel,
    latest_outcome: latest.outcome,
  };
}

/**
 * Orphans: Outreach Log records for leads with no Approved Outreach row. Reported
 * as exceptions; never silently treated as approved or attached to history.
 */
function findOrphans(historyIndex, approvalIndex) {
  const orphans = [];
  for (const [leadId, records] of historyIndex) {
    if (approvalIndex.has(leadId)) continue;
    for (const record of records) {
      orphans.push({ lead_id: record.leadId, outreach_id: record.outreach_id, sent_at: record.sentAt, channel: record.channel });
    }
  }
  orphans.sort((a, b) => (a.lead_id < b.lead_id ? -1 : a.lead_id > b.lead_id ? 1 : a.sent_at < b.sent_at ? -1 : 1));
  return orphans;
}

function sortLeads(a, b) {
  const scoreDiff = parseScore(b.row.score) - parseScore(a.row.score);
  if (scoreDiff !== 0) return scoreDiff;
  if (a.approvedAt < b.approvedAt) return -1;
  if (a.approvedAt > b.approvedAt) return 1;
  return a.leadId < b.leadId ? -1 : a.leadId > b.leadId ? 1 : 0;
}

/**
 * Build the deterministic queue projection: one record per approved lead,
 * ordered by priority rank. Ranks are assigned independent of sheet row order.
 */
function buildQueue(approvalIndex, historyIndex, queuedAt) {
  const sortedForQueue = [...approvalIndex.values()].sort(sortLeads);
  return sortedForQueue.map((entry, i) => {
    const row = entry.row;
    const readiness = readinessFor(row);
    const history = buildHistory(historyIndex.get(entry.leadId));
    return {
      queue_id: entry.leadId,
      lead_id: entry.leadId,
      business_name: normalize(row.business_name),
      niche: normalize(row.niche),
      city: normalize(row.city),
      state: normalize(row.state),
      country: normalize(row.country),
      score: normalize(row.score),
      available_channel: readiness.available_channel,
      readiness_status: readiness.readiness_status,
      priority: i + 1,
      approved_at: entry.approvedAt,
      queued_at: queuedAt,
      last_outreach_at: history.last_outreach_at,
      outreach_count: history.outreach_count,
      latest_channel: history.latest_channel,
      latest_outcome: history.latest_outcome,
      enrichment_required: readiness.available_channel === CHANNEL.NONE && readiness.readiness_status === READINESS.NOT_READY,
      reason: readiness.reason,
      notes: normalize(row.notes),
    };
  });
}

function sortExceptions(a, b) {
  const ka = [a.exception_type || '', a.lead_id || '', a.details || ''];
  const kb = [b.exception_type || '', b.lead_id || '', b.details || ''];
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function buildExceptions({ runId, orphans, malformedApprovals, malformedOutreach }) {
  const list = [];
  for (const o of orphans) {
    list.push({
      run_id: runId,
      lead_id: o.lead_id,
      outreach_id: o.outreach_id,
      exception_type: EXCEPTION_TYPE.OUTREACH_WITHOUT_APPROVAL,
      severity: SEVERITY.ERROR,
      details: 'Outreach Log has a record but no matching Approved Outreach row',
    });
  }
  for (const m of malformedOutreach) {
    list.push({
      run_id: runId,
      lead_id: m.lead_id,
      outreach_id: m.outreach_id,
      exception_type: EXCEPTION_TYPE.MALFORMED_OUTREACH,
      severity: SEVERITY.ERROR,
      details: 'outreach record missing lead_id or sent_at',
    });
  }
  for (const m of malformedApprovals) {
    list.push({
      run_id: runId,
      lead_id: m.lead_id,
      business_name: m.business_name,
      approved_status: m.status,
      exception_type: EXCEPTION_TYPE.MALFORMED_APPROVAL,
      severity: SEVERITY.ERROR,
      details: 'approved row missing lead_id or approved_at',
    });
  }
  list.sort(sortExceptions);
  return list;
}

function computeMetrics({ approvedRows, outreachRows, queue, orphans, malformedApprovals, malformedOutreach, duplicateCount, exceptionCount }) {
  return {
    approved_total: approvedRows.length,
    queue_total: queue.length,
    ready_count: queue.filter((q) => q.readiness_status === READINESS.READY).length,
    not_ready_count: queue.filter((q) => q.readiness_status === READINESS.NOT_READY).length,
    blocked_count: queue.filter((q) => q.readiness_status === READINESS.BLOCKED).length,
    email_ready_count: queue.filter((q) => q.available_channel === CHANNEL.EMAIL).length,
    call_ready_count: queue.filter((q) => q.available_channel === CHANNEL.CALL).length,
    outreach_total: outreachRows.length,
    duplicate_approval_ids: duplicateCount,
    malformed_approvals: malformedApprovals.length,
    orphan_outreach: orphans.length,
    malformed_outreach: malformedOutreach.length,
    history_attached: queue.filter((q) => q.outreach_count > 0).length,
    exception_count: exceptionCount,
  };
}

function incompleteQueue({ runId, runAt, queuedAt, approvedError, outreachError }) {
  const nullFields = Object.fromEntries(REPORT_FIELDS.map((f) => [f, null]));
  return {
    run_id: runId,
    status: 'QUEUE_INCOMPLETE',
    run_at: runAt,
    queued_at: queuedAt,
    ...nullFields,
    queue: [],
    exceptions: [],
    sources: {
      approved_ok: !approvedError,
      outreach_ok: !outreachError,
      approved_read_error: approvedError || '',
      outreach_read_error: outreachError || '',
    },
  };
}

/**
 * Build the queue projection from the two source row sets.
 * runId/now are injectable so tests can hold the output deterministic.
 */
function buildQueueFromSheets({ approvedRows, outreachRows, approvedError, outreachError, runId, now }) {
  const runAt = now || new Date().toISOString();
  const queuedAt = runAt;
  const finalRunId = runId || `${RUN_LABEL}-${Date.now()}`;

  if (approvedError || outreachError) {
    const report = incompleteQueue({ runId: finalRunId, runAt, queuedAt, approvedError, outreachError });
    return { report, exceptions: [], queue: [] };
  }

  const approved = buildApprovalIndex(approvedRows);
  const history = buildHistoryIndex(outreachRows);
  const orphans = findOrphans(history.index, approved.index);
  const queue = buildQueue(approved.index, history.index, queuedAt);
  const exceptions = buildExceptions({
    runId: finalRunId,
    orphans,
    malformedApprovals: approved.malformed,
    malformedOutreach: history.malformed,
  });

  const metrics = computeMetrics({
    approvedRows,
    outreachRows,
    queue,
    orphans,
    malformedApprovals: approved.malformed,
    malformedOutreach: history.malformed,
    duplicateCount: approved.duplicates.length,
    exceptionCount: exceptions.length,
  });

  const report = {
    run_id: finalRunId,
    status: 'COMPLETED',
    run_at: runAt,
    queued_at: queuedAt,
    ...metrics,
    queue,
    exceptions,
    sources: { approved_ok: true, outreach_ok: true, approved_read_error: '', outreach_read_error: '' },
  };

  return { report, exceptions, queue };
}

module.exports = {
  APPROVED_COLUMNS,
  OUTREACH_COLUMNS,
  QUEUE_FIELDS,
  RUN_LABEL,
  READINESS,
  CHANNEL,
  SUPPORTED_CHANNELS,
  MIN_PHONE_DIGITS,
  EXCEPTION_TYPE,
  SEVERITY,
  REPORT_FIELDS,
  countDigits,
  parseScore,
  isVerifiedEmail,
  isUsablePhone,
  isSuppressed,
  readinessFor,
  buildApprovalIndex,
  buildHistoryIndex,
  buildHistory,
  findOrphans,
  buildQueue,
  buildExceptions,
  computeMetrics,
  buildQueueFromSheets,
  incompleteQueue,
};