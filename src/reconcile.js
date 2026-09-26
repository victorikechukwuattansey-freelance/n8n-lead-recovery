'use strict';

const { APPROVED_COLUMNS, normalize } = require('./schema');

/*
 * Run-Reconciliation-and-Reporting V1 — read-first, deterministic reconciliation engine.
 *
 * Reconciles the Approved Outreach approval ledger against the Outreach Log activity
 * log. Produces a structured report (spec §22) plus a deterministic exception list.
 * This module is the reference implementation used by the live harness and the
 * offline tests. The n8n workflow embeds a self-contained copy of the same algorithm
 * (see "Reconcile Records" node in Run-Reconciliation-and-Reporting V1.json); the
 * workflow test suite asserts the embedded code and this module stay in sync.
 *
 * Contract (Run-Reconciliation-and-Reporting v1):
 *   - read-first: no outreach, no enrichment, no source mutation, no auto-repair.
 *   - status vocabulary: '' | not_ready | queued | prepared | contacted |
 *     follow_up_due | replied | qualified | demo | pilot | won | lost | suppressed.
 *   - a source read failure yields RECONCILIATION_INCOMPLETE, never a false zero/
 *     healthy report.
 *   - identical sheet contents produce identical classification and metrics.
 */

const OUTREACH_COLUMNS = [
  'outreach_id',
  'lead_id',
  'business_name',
  'contact_name',
  'channel',
  'email',
  'phone',
  'message_variant',
  'sent_at',
  'follow_up_date',
  'follow_up_number',
  'reply_status',
  'reply_date',
  'pain_admitted',
  'call_booked',
  'call_date',
  'paid_pilot_interest',
  'objection',
  'outcome',
  'notes',
  'status',
  'provider_message_id',
];

const RECONCILE_STATUSES = [
  '',
  'not_ready',
  'queued',
  'prepared',
  'contacted',
  'follow_up_due',
  'replied',
  'qualified',
  'demo',
  'pilot',
  'won',
  'lost',
  'suppressed',
];

const STATUS_PRE_SEND = new Set(['', 'not_ready', 'queued', 'prepared']);
const STATUS_POST_SEND = new Set([
  'contacted',
  'follow_up_due',
  'replied',
  'qualified',
  'demo',
  'pilot',
  'won',
  'lost',
]);
const STATUS_SUPPRESSED = new Set(['suppressed']);
const KNOWN_STATUS_SET = new Set(RECONCILE_STATUSES);

const CATEGORY = {
  APPROVED_NO_OUTREACH: 'APPROVED_NO_OUTREACH',
  APPROVED_WITH_OUTREACH: 'APPROVED_WITH_OUTREACH',
  MULTIPLE_OUTREACH: 'MULTIPLE_OUTREACH',
};

const EXCEPTION_TYPE = {
  OUTREACH_WITHOUT_APPROVAL: 'OUTREACH_WITHOUT_APPROVAL',
  MALFORMED_OUTREACH: 'MALFORMED_OUTREACH',
  MALFORMED_APPROVAL: 'MALFORMED_APPROVAL',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const REPORT_FIELDS = [
  'approved_total',
  'approved_with_outreach',
  'approved_no_outreach',
  'approval_duplicates',
  'coverage_rate',
  'outreach_total',
  'unique_leads_with_outreach',
  'multiple_outreach_leads',
  'orphan_outreach',
  'malformed_approvals',
  'malformed_outreach',
  'status_mismatches',
  'non_canonical_statuses',
  'healthy_records',
  'exception_count',
];

const RUN_LABEL = 'RECONCILIATION';

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Index the Approved Outreach ledger rows (objects). A row with an empty lead_id or
 * approved_at is malformed and is surfaced as-is; duplicate lead_ids keep the first
 * row as canonical and are tallied separately. Nothing is mutated.
 */
function buildApprovedIndex(approvedObjects) {
  const index = new Map();
  const malformed = [];
  const duplicates = [];
  (approvedObjects || []).forEach((obj, i) => {
    const row = obj || {};
    const leadId = normalize(row.lead_id);
    const approvedAt = normalize(row.approved_at);
    if (!leadId || !approvedAt) {
      malformed.push({
        lead_id: leadId,
        business_name: normalize(row.business_name),
        status: normalize(row.status),
        approved_at: approvedAt,
        reason: leadId ? 'missing approved_at' : 'missing lead_id',
        index: i,
        row,
      });
      return;
    }
    if (index.has(leadId)) {
      duplicates.push({
        lead_id: leadId,
        business_name: normalize(row.business_name),
        approved_at: approvedAt,
        index: i,
        row,
      });
      return;
    }
    index.set(leadId, {
      lead_id: leadId,
      business_name: normalize(row.business_name),
      niche: normalize(row.niche),
      status: normalize(row.status),
      approved_at: approvedAt,
      index: i,
      row,
    });
  });
  return { index, malformed, duplicates };
}

function latestRecord(records) {
  let latest = null;
  for (const record of records) {
    if (!latest) {
      latest = record;
      continue;
    }
    if (
      record.sentAt > latest.sentAt ||
      (record.sentAt === latest.sentAt && record.index > latest.index)
    ) {
      latest = record;
    }
  }
  return latest;
}

function firstRecord(records) {
  let first = null;
  for (const record of records) {
    if (!first) {
      first = record;
      continue;
    }
    if (
      record.sentAt < first.sentAt ||
      (record.sentAt === first.sentAt && record.index < first.index)
    ) {
      first = record;
    }
  }
  return first;
}

/**
 * Group the Outreach Log rows (objects) by lead_id. A row with an empty lead_id or
 * sent_at is malformed and is surfaced as-is (never discarded).
 */
function buildOutreachIndex(outreachObjects) {
  const byLead = new Map();
  const malformed = [];
  (outreachObjects || []).forEach((obj, i) => {
    const row = obj || {};
    const leadId = normalize(row.lead_id);
    const sentAt = normalize(row.sent_at);
    if (!leadId || !sentAt) {
      malformed.push({
        outreach_id: normalize(row.outreach_id),
        lead_id: leadId,
        business_name: normalize(row.business_name),
        sent_at: sentAt,
        reason: leadId ? 'missing sent_at' : 'missing lead_id',
        index: i,
        row,
      });
      return;
    }
    if (!byLead.has(leadId)) byLead.set(leadId, []);
    byLead.get(leadId).push({ index: i, sentAt, row });
  });

  const index = new Map();
  for (const [leadId, records] of byLead) {
    const first = firstRecord(records);
    const latest = latestRecord(records);
    const latestRow = latest.row;
    const channels = [...new Set(records.map((r) => normalize(r.row.channel)).filter(Boolean))].sort();
    index.set(leadId, {
      lead_id: leadId,
      business_name: normalize(latestRow.business_name),
      count: records.length,
      first_sent_at: first.sentAt,
      latest_sent_at: latest.sentAt,
      channels,
      latest_reply_status: normalize(latestRow.reply_status),
      latest_outcome: normalize(latestRow.outcome),
      latest_call_booked: normalize(latestRow.call_booked),
      latest_paid_pilot_interest: normalize(latestRow.paid_pilot_interest),
      references: records,
    });
  }
  return { index, malformed };
}

function classifyApprovals(approvedIndex, outreachIndex) {
  const results = [];
  for (const entry of approvedIndex.values()) {
    const oEntry = outreachIndex.get(entry.lead_id);
    const outreachCount = oEntry ? oEntry.count : 0;
    let category;
    if (outreachCount === 0) category = CATEGORY.APPROVED_NO_OUTREACH;
    else if (outreachCount === 1) category = CATEGORY.APPROVED_WITH_OUTREACH;
    else category = CATEGORY.MULTIPLE_OUTREACH;
    results.push({
      lead_id: entry.lead_id,
      business_name: entry.business_name,
      category,
      outreach_count: outreachCount,
      first_sent_at: oEntry ? oEntry.first_sent_at : '',
      latest_sent_at: oEntry ? oEntry.latest_sent_at : '',
      channels: oEntry ? oEntry.channels : [],
      status: entry.status,
    });
  }
  results.sort(sortByLeadId);
  return results;
}

function findStatusMismatches(approvedIndex, outreachIndex) {
  const mismatches = [];
  for (const entry of approvedIndex.values()) {
    const oEntry = outreachIndex.get(entry.lead_id);
    const outreachCount = oEntry ? oEntry.count : 0;
    const hasActivity = outreachCount > 0;
    const status = entry.status;
    let reason = '';
    if (STATUS_POST_SEND.has(status) && !hasActivity) {
      reason = `status "${status}" implies outreach activity but none is logged in Outreach Log`;
    } else if (hasActivity && STATUS_PRE_SEND.has(status)) {
      reason = `outreach activity is logged in Outreach Log while status remains "${status}"`;
    }
    if (!reason) continue;
    mismatches.push({
      lead_id: entry.lead_id,
      business_name: entry.business_name,
      status,
      outreach_count: outreachCount,
      first_sent_at: oEntry ? oEntry.first_sent_at : '',
      latest_sent_at: oEntry ? oEntry.latest_sent_at : '',
      reason,
    });
  }
  mismatches.sort(sortByLeadId);
  return mismatches;
}

function findOrphans(outreachIndex, approvedIndex) {
  const orphans = [];
  for (const [leadId, oEntry] of outreachIndex) {
    if (approvedIndex.has(leadId)) continue;
    orphans.push({
      lead_id: leadId,
      business_name: oEntry.business_name,
      outreach_count: oEntry.count,
      first_sent_at: oEntry.first_sent_at,
      latest_sent_at: oEntry.latest_sent_at,
    });
  }
  orphans.sort(sortByLeadId);
  return orphans;
}

function countNonCanonicalStatuses(approvedIndex) {
  let n = 0;
  for (const entry of approvedIndex.values()) {
    if (!KNOWN_STATUS_SET.has(entry.status)) n += 1;
  }
  return n;
}

function sortByLeadId(a, b) {
  if (a.lead_id < b.lead_id) return -1;
  if (a.lead_id > b.lead_id) return 1;
  return 0;
}

function sortExceptions(a, b) {
  const ka = [a.exception_type, a.lead_id || '', a.details || ''];
  const kb = [b.exception_type, b.lead_id || '', b.details || ''];
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

/**
 * Build the deterministic exception list. One entry per orphan / malformed record /
 * malformed approval / status mismatch. APPROVED_NO_OUTREACH is reported as an
 * informational classification, not an exception row.
 */
function buildExceptions({ runId, detectedAt, mismatches, orphans, malformedApprovals, malformedOutreach }) {
  const exceptions = [];
  for (const m of mismatches) {
    exceptions.push({
      run_id: runId,
      lead_id: m.lead_id,
      business_name: m.business_name,
      exception_type: EXCEPTION_TYPE.STATUS_MISMATCH,
      severity: SEVERITY.WARNING,
      approved_status: m.status,
      outreach_count: m.outreach_count,
      first_sent_at: m.first_sent_at,
      latest_sent_at: m.latest_sent_at,
      outreach_id: '',
      details: m.reason,
      detected_at: detectedAt,
    });
  }
  for (const o of orphans) {
    exceptions.push({
      run_id: runId,
      lead_id: o.lead_id,
      business_name: o.business_name,
      exception_type: EXCEPTION_TYPE.OUTREACH_WITHOUT_APPROVAL,
      severity: SEVERITY.ERROR,
      approved_status: '',
      outreach_count: o.outreach_count,
      first_sent_at: o.first_sent_at,
      latest_sent_at: o.latest_sent_at,
      outreach_id: '',
      details: 'Outreach Log has records but no matching Approved Outreach row',
      detected_at: detectedAt,
    });
  }
  for (const m of malformedOutreach) {
    exceptions.push({
      run_id: runId,
      lead_id: m.lead_id,
      business_name: m.business_name,
      exception_type: EXCEPTION_TYPE.MALFORMED_OUTREACH,
      severity: SEVERITY.ERROR,
      approved_status: '',
      outreach_count: 1,
      first_sent_at: '',
      latest_sent_at: '',
      outreach_id: m.outreach_id || '',
      details: m.reason,
      detected_at: detectedAt,
    });
  }
  for (const m of malformedApprovals) {
    exceptions.push({
      run_id: runId,
      lead_id: m.lead_id,
      business_name: m.business_name,
      exception_type: EXCEPTION_TYPE.MALFORMED_APPROVAL,
      severity: SEVERITY.ERROR,
      approved_status: m.status || '',
      outreach_count: 0,
      first_sent_at: '',
      latest_sent_at: '',
      outreach_id: '',
      details: m.reason,
      detected_at: detectedAt,
    });
  }
  exceptions.sort(sortExceptions);
  return exceptions;
}

function computeMetrics({ approvedRows, outreachRows, approvals, orphans, mismatches, malformedApprovals, malformedOutreach, duplicateCount, nonCanonicalStatuses, outreachIndex }) {
  const approvedWith = approvals.filter((a) => a.category !== CATEGORY.APPROVED_NO_OUTREACH).length;
  const approvedWithout = approvals.filter((a) => a.category === CATEGORY.APPROVED_NO_OUTREACH).length;
  const classifiable = approvedWith + approvedWithout;
  const mismatchLeadIds = new Set(mismatches.map((m) => m.lead_id));
  const healthy = approvals.filter((a) => a.outreach_count > 0 && !mismatchLeadIds.has(a.lead_id)).length;
  return {
    approved_total: (approvedRows || []).length,
    approved_with_outreach: approvedWith,
    approved_no_outreach: approvedWithout,
    approval_duplicates: duplicateCount,
    coverage_rate: classifiable > 0 ? round4(approvedWith / classifiable) : null,
    outreach_total: (outreachRows || []).length,
    unique_leads_with_outreach: outreachIndex.size,
    multiple_outreach_leads: approvals.filter((a) => a.outreach_count > 1).length,
    orphan_outreach: orphans.length,
    malformed_approvals: malformedApprovals.length,
    malformed_outreach: malformedOutreach.length,
    status_mismatches: mismatches.length,
    non_canonical_statuses: nonCanonicalStatuses,
    healthy_records: healthy,
    exception_count: orphans.length + malformedApprovals.length + malformedOutreach.length + mismatches.length,
  };
}

function incompleteReport({ runId, runAt, detectedAt, approvedError, outreachError }) {
  const nullMetrics = Object.fromEntries(REPORT_FIELDS.map((field) => [field, null]));
  return {
    run_id: runId,
    status: 'RECONCILIATION_INCOMPLETE',
    run_at: runAt,
    detected_at: detectedAt,
    ...nullMetrics,
    approvals: [],
    exceptions: [],
    sources: {
      approved_ok: !approvedError,
      outreach_ok: !outreachError,
      approved_read_error: approvedError,
      outreach_read_error: outreachError,
    },
  };
}

/**
 * Orchestrate one reconciliation run.
 *
 * @param {object} opts
 * @param {object[]} opts.approvedRows             Approved Outreach rows (objects).
 * @param {object[]} opts.outreachRows             Outreach Log rows (objects).
 * @param {object} [opts.sourceErrors]             { approved?, outreach? } read errors.
 * @param {string} [opts.runId]                    Deterministic run id (tests inject).
 * @param {string|number|Date} [opts.now]          Clock injection for run_at/detected_at.
 * @returns {{ report: object, exceptions: object[] }}
 */
function reconcileFromSheets({ approvedRows = [], outreachRows = [], sourceErrors = {}, runId, now } = {}) {
  const detectedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const runAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const finalRunId = runId || `${RUN_LABEL}-${detectedAt.replace(/[^\d]/g, '').slice(0, 14)}`;

  const approvedError = normalize(sourceErrors.approved);
  const outreachError = normalize(sourceErrors.outreach);

  if (approvedError || outreachError) {
    const report = incompleteReport({
      runId: finalRunId,
      runAt,
      detectedAt,
      approvedError,
      outreachError,
    });
    return { report, exceptions: [] };
  }

  const approved = buildApprovedIndex(approvedRows);
  const outreach = buildOutreachIndex(outreachRows);

  const approvals = classifyApprovals(approved.index, outreach.index);
  const mismatches = findStatusMismatches(approved.index, outreach.index);
  const orphans = findOrphans(outreach.index, approved.index);
  const nonCanonicalStatuses = countNonCanonicalStatuses(approved.index);

  const metrics = computeMetrics({
    approvedRows,
    outreachRows,
    approvals,
    orphans,
    mismatches,
    malformedApprovals: approved.malformed,
    malformedOutreach: outreach.malformed,
    duplicateCount: approved.duplicates.length,
    nonCanonicalStatuses,
    outreachIndex: outreach.index,
  });

  const exceptions = buildExceptions({
    runId: finalRunId,
    detectedAt,
    mismatches,
    orphans,
    malformedApprovals: approved.malformed,
    malformedOutreach: outreach.malformed,
  });

  const report = {
    run_id: finalRunId,
    status: 'COMPLETED',
    run_at: runAt,
    detected_at: detectedAt,
    ...metrics,
    approvals,
    exceptions,
    sources: { approved_ok: true, outreach_ok: true, approved_read_error: '', outreach_read_error: '' },
  };

  return { report, exceptions };
}

module.exports = {
  OUTREACH_COLUMNS,
  APPROVED_COLUMNS,
  RECONCILE_STATUSES,
  STATUS_PRE_SEND,
  STATUS_POST_SEND,
  STATUS_SUPPRESSED,
  KNOWN_STATUS_SET,
  CATEGORY,
  EXCEPTION_TYPE,
  SEVERITY,
  REPORT_FIELDS,
  RUN_LABEL,
  round4,
  buildApprovedIndex,
  buildOutreachIndex,
  classifyApprovals,
  findStatusMismatches,
  findOrphans,
  countNonCanonicalStatuses,
  buildExceptions,
  computeMetrics,
  reconcileFromSheets,
};