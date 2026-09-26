'use strict';

const { APPROVED_COLUMNS, normalize } = require('./schema');
const { OUTREACH_COLUMNS } = require('./reconcile');
const { buildQueueFromSheets, READINESS, CHANNEL, SUPPORTED_CHANNELS } = require('./queue');
const { NOT_CONFIGURED_PROVIDER } = require('./provider');
const { resolveMessage } = require('./message-body');
const { cellRange, rowNumberFromRange } = require('./google-sheets-client');

/*
 * Outreach-Execution-and-Delivery V1 — conservative execution/delivery boundary.
 *
 * Consumes the READY records produced by the Outreach Queue & Planning V1
 * projection (via buildQueueFromSheets) and, ONLY on a real, confirmed provider
 * success, stages durable Outreach Log attempt rows. Everything else stays
 * read-only. This artifact does NOT invent a real external provider: callers
 * pass an adapter implementing { execute(channel, payload) } (see src/provider.js);
 * the repository's safe default refuses execution (PROVIDER_NOT_CONFIGURED).
 *
 * Contract (Outreach-Execution-and-Delivery v1):
 *   - DRY_RUN is the default mode and must make zero provider calls and zero
 *     Outreach Log writes. REAL mode requires explicit activation.
 *   - The engine never re-derives a channel: it consumes the queue's explicit
 *     available_channel as-is (no email->call fallback, no contact_form, no
 *     unverified email).
 *   - Payload validation only (channel contract is satisfied by the queue):
 *       email -> non-empty email AND non-empty message_variant (explicit)
 *       call  -> non-empty phone (message_variant optional)
 *     Reject, never silently drop.
 *   - Idempotency identity is (lead_id, channel): an existing Outreach Log row
 *     with a non-empty sent_at for the same identity suppresses a repeat attempt
 *     (DUPLICATE_SUPPRESSED). A row with a known lead identity but no sent_at
 *     holds the lead (LOG_INCONSISTENT) until the outreach log is reconciled; a
 *     row with no lead_id is unattributable and never suppresses. No reliance on
 *     random UUIDs.
 *   - outreach_id is a stable identity EX-<lead_id>-<channel>, staged only when
 *     the log row is actually written.
 *   - sent_at is the run timestamp of the run that received provider confirmation;
 *     reply/outcome/pain/call/paid-pilot fields stay canonical-empty forever here.
 *   - A source read failure yields EXECUTION_INCOMPLETE with null metrics — never
 *     a false healthy run.
 *   - The provider is the only boundary that may report success. Nothing is ever
 *     marked sent/fabricated. A provider throw is contained as EXECUTION_FAILED.
 */

const RUN_LABEL = 'EXECUTION';

const DEFAULT_MESSAGE_VARIANT = 'cold-outreach-v1';

const MODE = {
  DRY_RUN: 'DRY_RUN',
  REAL: 'REAL',
};

const EXECUTION_STATUS = {
  SKIPPED: 'EXECUTION_SKIPPED',
  REJECTED: 'EXECUTION_REJECTED',
  FAILED: 'EXECUTION_FAILED',
  SUCCEEDED: 'EXECUTION_SUCCEEDED',
  DUPLICATE_SUPPRESSED: 'DUPLICATE_SUPPRESSED',
};

const REASON = {
  NOT_READY: 'NOT_READY',
  BLOCKED: 'BLOCKED',
  NO_CHANNEL: 'NO_CHANNEL',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  DRY_RUN: 'DRY_RUN',
  DUPLICATE: 'DUPLICATE',
  LOG_INCONSISTENT: 'LOG_INCONSISTENT',
  LOG_APPEND_FAILED: 'LOG_APPEND_FAILED',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  EXECUTION_SUCCESS: 'EXECUTION_SUCCESS',
};

const PROVIDER_THREW = 'PROVIDER_THREW';

const REPORT_FIELDS = [
  'approved_total',
  'queue_total',
  'ready_candidates',
  'executed_attempted',
  'executed_succeeded',
  'executed_failed',
  'executed_skipped',
  'executed_rejected',
  'duplicate_suppressed',
  'ambiguous_log_rows',
  'log_rows_written',
  'provider_calls',
  'pending_rows_appended',
  'ack_updates_attempted',
  'ack_updates_succeeded',
  'failure_updates_attempted',
  'log_append_failures',
];

function outreachIdFor(leadId, channel) {
  return `EX-${normalize(leadId)}-${normalize(channel) || '?'}`;
}

/**
 * Index committed Outreach Log rows by the (lead_id, channel) idempotency key.
 * A row suppresses only when it actually implies an attempt (lead_id + sent_at
 * present). Identity-known malformed rows (lead_id present, sent_at empty) are
 * held LOG_INCONSISTENT by the gate, not dropped silently. Rows with no lead_id
 * are unattributable and surfaced by the queue layer, never suppressing.
 * Channel "" keys never collide with a real channel so an empty-channel row
 * cannot accidentally block an email/call.
 */
function buildSentIndex(outreachRows) {
  const index = new Map();
  (outreachRows || []).forEach((obj) => {
    const row = obj || {};
    const leadId = normalize(row.lead_id);
    const sentAt = normalize(row.sent_at);
    if (!leadId || !sentAt) return;
    const channel = normalize(row.channel);
    index.set(`${leadId}\u0000${channel}`, { lead_id: leadId, channel, sent_at: sentAt });
  });
  return index;
}

/**
 * Classify Outreach Log rows into the three-bucket sent scope used by the gate.
 * Per-row precedence is confirmed > pending > ambiguous:
 *   - confirmed: rows with lead_id + sent_at present (identical to buildSentIndex).
 *   - pending:   rows with lead_id + status === 'pending' and empty sent_at —
 *     explicitly in flight (Resend pending/ack cycle); a re-attempt is allowed.
 *   - ambiguous: identity-known malformed rows (lead_id present, sent_at empty,
 *     status !== 'pending') — the lead is held LOG_INCONSISTENT.
 * A row that is both status === 'pending' and sent_at non-empty is malformed;
 * sent_at wins (confirmed) because a real sent_at is stronger evidence.
 * Unattributable rows (no lead_id) fall out of all three buckets and never
 * suppress or hold; the queue layer surfaces them as MALFORMED_OUTREACH.
 */
function buildSentScope(outreachRows) {
  const confirmed = new Map();
  const ambiguous = new Map();
  const pending = new Map();
  (outreachRows || []).forEach((obj) => {
    const row = obj || {};
    const leadId = normalize(row.lead_id);
    const sentAt = normalize(row.sent_at);
    const status = normalize(row.status);
    if (!leadId) return;
    const channel = normalize(row.channel);
    if (sentAt) {
      confirmed.set(`${leadId}\u0000${channel}`, { lead_id: leadId, channel, sent_at: sentAt });
      return;
    }
    if (status === 'pending') {
      pending.set(`${leadId}\u0000${channel}`, { lead_id: leadId, channel, status });
      return;
    }
    ambiguous.set(`${leadId}\u0000${channel}`, { lead_id: leadId, channel });
  });
  return { confirmed, pending, ambiguous };
}

/**
 * Attach Approved contact fields + the explicitly supplied message_variant to
 * each queue record. The queue carries no contact payloads; this is a read-side
 * join, never a source mutation.
 */
function mergeQueueWithApproved(queue, approvedRows, messageVariants) {
  const byLead = new Map();
  (approvedRows || []).forEach((obj) => {
    const row = obj || {};
    const leadId = normalize(row.lead_id);
    if (!leadId || byLead.has(leadId)) return;
    byLead.set(leadId, row);
  });
  return (queue || []).map((q) => {
    const approved = byLead.get(q.lead_id) || {};
    const variant = messageVariants && messageVariants[q.lead_id] !== undefined
      ? normalize(messageVariants[q.lead_id])
      : '';
    const merged = Object.assign({}, q, {
      email: normalize(approved.email),
      phone: normalize(approved.phone),
      contact_name: normalize(approved.contact_name),
      message_variant: !variant && normalize(q.available_channel) === CHANNEL.EMAIL
        ? DEFAULT_MESSAGE_VARIANT
        : variant,
    });
    merged.outreach_id = outreachIdFor(merged.lead_id, merged.available_channel);
    return merged;
  });
}

/**
 * Channel-aware payload contract check. The available channel comes from the
 * queue projection; this only validates that the contact payload can satisfy it.
 */
function validatePayload(item) {
  if (item.available_channel === CHANNEL.EMAIL) {
    if (!item.email || !item.message_variant) {
      return {
        ok: false,
        reason: REASON.INVALID_PAYLOAD,
        detail: 'email channel requires a non-empty email and an explicit message_variant',
      };
    }
  } else if (item.available_channel === CHANNEL.CALL) {
    if (!item.phone) {
      return {
        ok: false,
        reason: REASON.INVALID_PAYLOAD,
        detail: 'call channel requires a non-empty phone',
      };
    }
  }
  return { ok: true, detail: '' };
}

/**
 * Envelope handed to the provider adapter. Contains only queue/approved-sourced
 * values plus a stable execution_id; nothing fabricated.
 */
function buildPayload(item, executionId) {
  const payload = {
    execution_id: executionId,
    outreach_id: item.outreach_id,
    lead_id: item.lead_id,
    business_name: item.business_name,
    contact_name: item.contact_name,
    channel: item.available_channel,
    message_variant: item.message_variant,
  };
  if (item.available_channel === CHANNEL.EMAIL) {
    payload.email = item.email;
    try {
      const message = resolveMessage({ lead: item, variant: item.message_variant });
      payload.from = message.from;
      payload.to = message.to;
      payload.subject = message.subject;
      payload.text = message.text;
      payload.html = message.html;
    } catch (err) {
      payload.resolve_error = err && err.message ? String(err.message) : 'message-body: resolve failed';
    }
  }
  if (item.available_channel === CHANNEL.CALL) payload.phone = item.phone;
  return payload;
}

/**
 * Deterministic view of a provider result (all keys always present).
 */
function providerResultView(result) {
  return {
    success: Boolean(result && result.success),
    provider_status: (result && result.provider_status) || '',
    provider_message_id: (result && result.provider_message_id) || '',
    error_code: (result && result.error_code) || '',
    error_message: (result && result.error_message) || '',
  };
}

/**
 * Outreach Log row for a confirmed attempt. reply/outcome/pain/call/paid-pilot
 * fields are canonical-empty: this artifact never fabricates engagement.
 */
function buildLogRow({ item, runAt }) {
  return {
    outreach_id: item.outreach_id,
    lead_id: item.lead_id,
    business_name: item.business_name,
    contact_name: item.contact_name,
    channel: item.available_channel,
    email: item.available_channel === CHANNEL.EMAIL ? item.email : '',
    phone: item.available_channel === CHANNEL.CALL ? item.phone : '',
    message_variant: item.message_variant,
    sent_at: runAt,
    follow_up_date: '',
    follow_up_number: '',
    reply_status: '',
    reply_date: '',
    pain_admitted: '',
    call_booked: '',
    call_date: '',
    paid_pilot_interest: '',
    objection: '',
    outcome: '',
    notes: '',
    status: '',
    provider_message_id: '',
  };
}

function logRowToArray(row) {
  return OUTREACH_COLUMNS.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c])));
}

/**
 * Projection-level gates applied per READY candidate, in order:
 * readiness -> channel support -> confirmed dedup -> pending re-attempt -> malformed-row hold -> payload -> mode.
 *
 * Branch order (values preserved from Doc 2; pending inserted between dedup and
 * the malformed-row hold):
 *   1. readiness BLOCKED / NOT_READY  -> skip
 *   2. unsupported channel            -> reject
 *   3. confirmed send (sent bucket)   -> DUPLICATE_SUPPRESSED
 *   4. pending row (pending bucket)   -> { ok: true, pending_retry: true }
 *   5. ambiguous log row              -> LOG_INCONSISTENT hold
 *   6. fall through                   -> { ok: true }
 *
 * Rationale for placement: a confirmed send wins over a pending row (already sent),
 * but buildSentScope precedence (confirmed > pending > ambiguous) prevents a row
 * from being in both buckets anyway. Pending sits above ambiguous so a lead with
 * both an in-flight pending row and a stray malformed row is treated as a
 * re-attempt (optimistic: we started sending, metadata may still arrive via ack)
 * rather than being held for reconciliation.
 *
 * @param {object} item          Queue-merged candidate.
 * @param {Map}    sentIndex     Confirmed-only identity index (buildSentIndex).
 * @param {Map}    [ambiguous]   Identity-known malformed rows (buildSentScope).
 *                               Defaults to empty so callers that never opt into
 *                               fail-closed behavior keep their current contract.
 * @param {Map}    [pending]     In-flight rows, status === 'pending' (buildSentScope).
 *                               Defaults to empty so existing callers keep their
 *                               current contract; the executor passes the bucket
 *                               to label re-attempts.
 */
function gateExecution(item, sentIndex, ambiguous = new Map(), pending = new Map()) {
  if (item.readiness_status === READINESS.BLOCKED) {
    return { ok: false, status: EXECUTION_STATUS.SKIPPED, reason: REASON.BLOCKED, detail: 'blocked: suppressed lead; no execution' };
  }
  if (item.readiness_status === READINESS.NOT_READY) {
    return { ok: false, status: EXECUTION_STATUS.SKIPPED, reason: REASON.NOT_READY, detail: `not ready: ${item.reason || 'no available channel'}` };
  }
  if (!SUPPORTED_CHANNELS.includes(item.available_channel)) {
    return { ok: false, status: EXECUTION_STATUS.REJECTED, reason: REASON.NO_CHANNEL, detail: 'queue record has no supported channel' };
  }
  if (sentIndex.has(`${item.lead_id}\u0000${item.available_channel}`)) {
    return { ok: false, status: EXECUTION_STATUS.DUPLICATE_SUPPRESSED, reason: REASON.DUPLICATE, detail: 'existing committed outreach log row for lead_id+channel; suppressed' };
  }
  if (pending.has(`${item.lead_id}\u0000${item.available_channel}`)) {
    return { ok: true, pending_retry: true };
  }
  if (ambiguous.has(`${item.lead_id}\u0000${item.available_channel}`)) {
    return { ok: false, status: EXECUTION_STATUS.SKIPPED, reason: REASON.LOG_INCONSISTENT, detail: 'outreach log row for lead_id+channel holds no sent_at; held for reconciliation' };
  }
  return { ok: true };
}

function resultCard(item, partial) {
  return Object.assign(
    {
      lead_id: item.lead_id,
      outreach_id: item.outreach_id,
      business_name: item.business_name,
      channel: item.available_channel,
      readiness_status: item.readiness_status,
      status: '',
      reason: '',
      detail: '',
      payload: null,
      provider_call: null,
      sent_at: '',
    },
    partial,
  );
}

function computeMetrics({ approvedRows, queue, results, logRows, attempts, ambiguousCount, writerCounts }) {
  const w = writerCounts || {};
  return {
    approved_total: (approvedRows || []).length,
    queue_total: (queue || []).length,
    ready_candidates: (queue || []).filter((q) => q.readiness_status === READINESS.READY).length,
    executed_attempted: attempts,
    executed_succeeded: results.filter((r) => r.status === EXECUTION_STATUS.SUCCEEDED).length,
    executed_failed: results.filter((r) => r.status === EXECUTION_STATUS.FAILED).length,
    executed_skipped: results.filter((r) => r.status === EXECUTION_STATUS.SKIPPED).length,
    executed_rejected: results.filter((r) => r.status === EXECUTION_STATUS.REJECTED).length,
    duplicate_suppressed: results.filter((r) => r.status === EXECUTION_STATUS.DUPLICATE_SUPPRESSED).length,
    ambiguous_log_rows: ambiguousCount,
    log_rows_written: (logRows || []).length + (w.pending_rows_appended || 0),
    provider_calls: attempts,
    pending_rows_appended: w.pending_rows_appended || 0,
    ack_updates_attempted: w.ack_updates_attempted || 0,
    ack_updates_succeeded: w.ack_updates_succeeded || 0,
    failure_updates_attempted: w.failure_updates_attempted || 0,
    log_append_failures: w.log_append_failures || 0,
  };
}

function incompleteExecution({ runId, runAt, mode, providerLabel, providerConfigured, approvedError, outreachError }) {
  const nullFields = Object.fromEntries(REPORT_FIELDS.map((f) => [f, null]));
  return {
    run_id: runId,
    status: 'EXECUTION_INCOMPLETE',
    run_at: runAt,
    mode,
    provider: providerLabel,
    provider_configured: providerConfigured,
    ...nullFields,
    results: [],
    log_rows: [],
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
 * Orchestrate one execution run.
 *
 * @param {object} opts
 * @param {object[]} [opts.approvedRows]       Approved Outreach rows (objects).
 * @param {object[]} [opts.outreachRows]       Outreach Log rows (objects).
 * @param {object} [opts.messageVariants]      lead_id -> explicit message_variant.
 * @param {string} [opts.mode]                 'DRY_RUN' (default) | 'REAL'.
 * @param {object} [opts.provider]             Adapter: { isConfigured(), execute(channel, payload) }.
 * @param {string} [opts.approvedError]        Read error for Approved Outreach.
 * @param {string} [opts.outreachError]        Read error for Outreach Log.
 * @param {string} [opts.runId]                Deterministic run id (tests inject).
 * @param {string|number|Date} [opts.now]      Clock injection for run_at/sent_at.
 * @param {object} [opts.sheetsWriter]         Optional Google Sheets writer. When
 *                                             present in REAL mode the engine owns
 *                                             the Outreach Log write: it appends a
 *                                             pending row (status 'pending') before
 *                                             calling the provider, then ack-updates
 *                                             it to 'sent' on provider success or
 *                                             fail-updates it to 'failed' on provider
 *                                             failure (Doc 1E part 2). Requires
 *                                             { appendRows(tab, rows), updateRow(tab, range, values) }.
 * @param {string} [opts.outreachTabName]      Outreach Log tab name for sheetsWriter.
 *                                             Defaults to 'Outreach Log'.
 * @returns {Promise<{ report: object, logRows: object[], results: object[] }>}
 */
async function executeFromSheets({
  approvedRows = [],
  outreachRows = [],
  messageVariants,
  mode,
  provider,
  approvedError,
  outreachError,
  runId,
  now,
  sheetsWriter,
  outreachTabName = 'Outreach Log',
} = {}) {
  const runAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const finalRunId = runId || `${RUN_LABEL}-${runAt.replace(/[^\d]/g, '').slice(0, 14)}`;
  const resolvedMode = mode === MODE.REAL ? MODE.REAL : MODE.DRY_RUN;
  const providerInstance = provider || NOT_CONFIGURED_PROVIDER;
  const providerLabel = providerInstance.label || providerInstance.mode || 'NOT_CONFIGURED';
  const providerConfigured = typeof providerInstance.isConfigured === 'function'
    ? Boolean(providerInstance.isConfigured())
    : true;

  const approvedErr = normalize(approvedError);
  const outreachErr = normalize(outreachError);

  if (approvedErr || outreachErr) {
    const report = incompleteExecution({
      runId: finalRunId,
      runAt,
      mode: resolvedMode,
      providerLabel,
      providerConfigured,
      approvedError: approvedErr,
      outreachError: outreachErr,
    });
    return { report, logRows: [], results: [] };
  }

  const queueResult = buildQueueFromSheets({
    approvedRows,
    outreachRows,
    runId: finalRunId,
    now: runAt,
  });
  const queue = queueResult.queue;
  const exceptions = queueResult.exceptions;

  const sentScope = buildSentScope(outreachRows);
  const sentIndex = sentScope.confirmed;
  const merged = mergeQueueWithApproved(queue, approvedRows, messageVariants);

  const writerActive = resolvedMode === MODE.REAL
    && sheetsWriter
    && typeof sheetsWriter.appendRows === 'function'
    && typeof sheetsWriter.updateRow === 'function';
  const SENT_AT_COL = OUTREACH_COLUMNS.indexOf('sent_at');
  const STATUS_COL = OUTREACH_COLUMNS.indexOf('status');
  const PROVIDER_MESSAGE_ID_COL = OUTREACH_COLUMNS.indexOf('provider_message_id');
  const NOTES_COL = OUTREACH_COLUMNS.indexOf('notes');

  const executionId = finalRunId;
  const results = [];
  const logRows = [];
  let attempts = 0;
  const writerCounts = {
    pending_rows_appended: 0,
    ack_updates_attempted: 0,
    ack_updates_succeeded: 0,
    failure_updates_attempted: 0,
    log_append_failures: 0,
  };

  for (const item of merged) {
    const gate = gateExecution(item, sentIndex, sentScope.ambiguous, sentScope.pending);
    if (!gate.ok) {
      results.push(resultCard(item, { status: gate.status, reason: gate.reason, detail: gate.detail }));
      continue;
    }

    const payloadCheck = validatePayload(item);
    if (!payloadCheck.ok) {
      results.push(resultCard(item, {
        status: EXECUTION_STATUS.REJECTED,
        reason: payloadCheck.reason,
        detail: payloadCheck.detail,
        payload: buildPayload(item, executionId),
      }));
      continue;
    }

    const payload = buildPayload(item, executionId);

    if (payload.resolve_error) {
      results.push(resultCard(item, {
        status: EXECUTION_STATUS.REJECTED,
        reason: REASON.INVALID_PAYLOAD,
        detail: payload.resolve_error,
        payload,
      }));
      continue;
    }

    if (resolvedMode === MODE.DRY_RUN) {
      results.push(resultCard(item, {
        status: EXECUTION_STATUS.SKIPPED,
        reason: REASON.DRY_RUN,
        detail: 'dry run: provider not called, no Outreach Log write',
        payload,
      }));
      continue;
    }

    let appendedRowNumber = 0;
    if (writerActive) {
      const pendingRow = buildLogRow({ item, runAt });
      pendingRow.sent_at = '';
      pendingRow.status = 'pending';
      pendingRow.provider_message_id = '';
      pendingRow.notes = '';
      let appendResp;
      try {
        appendResp = await sheetsWriter.appendRows(outreachTabName, [logRowToArray(pendingRow)]);
        writerCounts.pending_rows_appended += 1;
      } catch (err) {
        writerCounts.log_append_failures += 1;
        results.push(resultCard(item, {
          status: EXECUTION_STATUS.FAILED,
          reason: REASON.LOG_APPEND_FAILED,
          detail: 'outreach log pending-row append failed; provider not called',
          payload,
        }));
        continue;
      }
      appendedRowNumber = rowNumberFromRange(appendResp && appendResp.updates && appendResp.updates.updatedRange);
    }

    attempts += 1;
    let result;
    try {
      result = await providerInstance.execute(item.available_channel, payload);
    } catch (err) {
      result = { success: false, error_code: PROVIDER_THREW, error_message: err && err.message ? String(err.message) : 'provider threw' };
    }
    const view = providerResultView(result);

    if (view.success) {
      if (writerActive) {
        writerCounts.ack_updates_attempted += 1;
        let ackOk = true;
        if (appendedRowNumber > 0) {
          try {
            await sheetsWriter.updateRow(outreachTabName, cellRange(appendedRowNumber, SENT_AT_COL, SENT_AT_COL), [runAt]);
            await sheetsWriter.updateRow(outreachTabName, cellRange(appendedRowNumber, STATUS_COL, PROVIDER_MESSAGE_ID_COL), ['sent', view.provider_message_id]);
          } catch (err) {
            ackOk = false;
          }
        } else {
          ackOk = false;
        }
        if (ackOk) writerCounts.ack_updates_succeeded += 1;
        results.push(resultCard(item, {
          status: EXECUTION_STATUS.SUCCEEDED,
          reason: REASON.EXECUTION_SUCCESS,
          detail: ackOk
            ? 'provider confirmed the attempt; Outreach Log row ack-updated to sent'
            : 'provider confirmed the attempt; Outreach Log ack-update failed (row may remain pending)',
          payload,
          provider_call: view,
          sent_at: runAt,
          ...(ackOk ? {} : { ack_update_failed: true }),
        }));
      } else {
        const row = buildLogRow({ item, runAt });
        logRows.push(row);
        results.push(resultCard(item, {
          status: EXECUTION_STATUS.SUCCEEDED,
          reason: REASON.EXECUTION_SUCCESS,
          detail: 'provider confirmed the attempt; Outreach Log row staged',
          payload,
          provider_call: view,
          sent_at: runAt,
        }));
      }
    } else {
      if (writerActive && appendedRowNumber > 0) {
        writerCounts.failure_updates_attempted += 1;
        const failureNotes = [view.provider_status, view.error_message].filter(Boolean).join(': ').slice(0, 200);
        try {
          await sheetsWriter.updateRow(outreachTabName, cellRange(appendedRowNumber, STATUS_COL, STATUS_COL), ['failed']);
          await sheetsWriter.updateRow(outreachTabName, cellRange(appendedRowNumber, NOTES_COL, NOTES_COL), [failureNotes]);
        } catch (err) {
          // failure-ack is best effort; the pending row may need a later ack
        }
      }
      const notConfigured = view.error_code === REASON.PROVIDER_NOT_CONFIGURED;
      results.push(resultCard(item, {
        status: EXECUTION_STATUS.FAILED,
        reason: notConfigured ? REASON.PROVIDER_NOT_CONFIGURED : REASON.PROVIDER_FAILURE,
        detail: notConfigured
          ? 'provider is not configured; execution refused, nothing was sent'
          : `provider reported failure (${view.error_code || 'unknown'}); nothing was sent`,
        payload,
        provider_call: view,
      }));
    }
  }

  const metrics = computeMetrics({ approvedRows, queue, results, logRows, attempts, ambiguousCount: sentScope.ambiguous.size, writerCounts });

  const report = {
    run_id: finalRunId,
    status: 'COMPLETED',
    run_at: runAt,
    mode: resolvedMode,
    provider: providerLabel,
    provider_configured: providerConfigured,
    ...metrics,
    results,
    log_rows: logRows,
    exceptions,
    sources: { approved_ok: true, outreach_ok: true, approved_read_error: '', outreach_read_error: '' },
  };

  return { report, logRows, results };
}

module.exports = {
  APPROVED_COLUMNS,
  OUTREACH_COLUMNS,
  RUN_LABEL,
  MODE,
  EXECUTION_STATUS,
  REASON,
  REPORT_FIELDS,
  PROVIDER_THREW,
  outreachIdFor,
  buildSentIndex,
  buildSentScope,
  mergeQueueWithApproved,
  validatePayload,
  buildPayload,
  providerResultView,
  buildLogRow,
  logRowToArray,
  gateExecution,
  computeMetrics,
  incompleteExecution,
  executeFromSheets,
};