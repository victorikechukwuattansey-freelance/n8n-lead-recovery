'use strict';

/*
 * Outreach Response Capture V1 — controlled inbound-response ingestion engine.
 *
 * This artifact CAPTURES INBOUND responses only. It never sends messages, never
 * replies, never schedules follow-ups, never interprets intent, never qualifies,
 * and never syncs to a CRM. It reads a batch of normalized inbound events, dedupes
 * them against the durable Response Log, resolves identity deterministically
 * (no fuzzy matching), and either stages durable rows (REAL mode) or demonstrates
 * what would be staged (DRY_RUN mode).
 *
 * Canonical normalized inbound event contract:
 *   { event_id, source, channel, provider_message_id, lead_id, outreach_id,
 *     sender, recipient, received_at, response_text, raw_reference }
 *
 * Durable response identity is the idempotency key:
 *   idempotency_key = `${provider_message_id || event_id}::${source}`
 *   response_id    = 'RESP-' + FNV-1a hex of idempotency_key
 *
 * This is a WRITE-CAPABLE artifact, but the only durable write surface is the
 * Response Log tab. DRY_RUN is the default mode and writes nothing. A response
 * log read failure yields FAILED with null metrics — never a false zero — and
 * refuses to process or persist anything.
 */

const SUPPORTED_CHANNELS = ['email', 'call'];

const RUN_LABEL = 'RESPCAP';

const STATUS = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
};

const RESPONSE_STATUS = {
  CAPTURED: 'CAPTURED',
  UNMATCHED: 'UNMATCHED',
  INVALID: 'INVALID',
  DUPLICATE: 'DUPLICATE',
};

const ERROR_CODE = {
  MISSING_EVENT_ID: 'MISSING_EVENT_ID',
  MISSING_CHANNEL: 'MISSING_CHANNEL',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  INVALID_TIMESTAMP: 'INVALID_TIMESTAMP',
  MISSING_RESPONSE: 'MISSING_RESPONSE',
  UNMATCHED_IDENTITY: 'UNMATCHED_IDENTITY',
  DUPLICATE_EVENT: 'DUPLICATE_EVENT',
  SOURCE_READ_FAILURE: 'SOURCE_READ_FAILURE',
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARNING: 'WARNING',
};

const ERROR_CODE_SEVERITY = {
  [ERROR_CODE.MISSING_EVENT_ID]: SEVERITY.ERROR,
  [ERROR_CODE.MISSING_CHANNEL]: SEVERITY.ERROR,
  [ERROR_CODE.INVALID_CHANNEL]: SEVERITY.ERROR,
  [ERROR_CODE.INVALID_TIMESTAMP]: SEVERITY.ERROR,
  [ERROR_CODE.MISSING_RESPONSE]: SEVERITY.ERROR,
  [ERROR_CODE.UNMATCHED_IDENTITY]: SEVERITY.WARNING,
  [ERROR_CODE.DUPLICATE_EVENT]: SEVERITY.WARNING,
  [ERROR_CODE.SOURCE_READ_FAILURE]: SEVERITY.ERROR,
};

const ERROR_CODE_REASON = {
  [ERROR_CODE.MISSING_EVENT_ID]: 'Event is missing event_id; it cannot be tracked or deduped.',
  [ERROR_CODE.MISSING_CHANNEL]: 'Event is missing channel; the response channel is unknown.',
  [ERROR_CODE.INVALID_CHANNEL]: 'Channel value is not a supported response channel.',
  [ERROR_CODE.INVALID_TIMESTAMP]: 'received_at could not be parsed as a timestamp.',
  [ERROR_CODE.MISSING_RESPONSE]: 'Event carries no response text; there is nothing to capture.',
  [ERROR_CODE.UNMATCHED_IDENTITY]: 'No lead identity could be resolved for the event; it is captured without a lead.',
  [ERROR_CODE.DUPLICATE_EVENT]: 'Event idempotency key already exists; a durable row was never created again.',
  [ERROR_CODE.SOURCE_READ_FAILURE]: 'The Response Log could not be read; capture is refused because dedupe cannot be trusted.',
};

const RESPONSE_COLUMNS = [
  'response_id',
  'idempotency_key',
  'lead_id',
  'outreach_id',
  'channel',
  'provider_message_id',
  'received_at',
  'response_text',
  'response_status',
  'source',
  'matched',
  'notes',
];

const EX_OUTREACH_REGEX = /^EX-(.+)-(email|call)$/;
const PHONE_REGEX = /^\+?[\d\s\-().]+$/;

function str(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function digitsOnly(value) {
  return str(value).replace(/\D/g, '');
}

function digits14(value) {
  const s = digitsOnly(value);
  return s.slice(0, 14).padEnd(14, '0');
}

function looksLikePhone(value) {
  const s = str(value).trim();
  return s !== '' && PHONE_REGEX.test(s);
}

function toIsoUtc(value) {
  const s = str(value).trim();
  if (s === '') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * FNV-1a 32-bit hash, hex-encoded (8 lowercase hex digits). Identical in the
 * engine and in the embedded n8n code so response_id is deterministic.
 */
function fnv1a32Hex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function idempotencyKeyFor(event) {
  const providerId = str(event.provider_message_id).trim();
  const eventId = str(event.event_id).trim();
  const source = str(event.source).trim();
  return `${providerId || eventId}::${source}`;
}

function responseIdFor(event) {
  return `RESP-${fnv1a32Hex(idempotencyKeyFor(event))}`;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') event = {};
  const normalized = {};
  for (const field of [
    'event_id', 'source', 'channel', 'provider_message_id', 'lead_id',
    'outreach_id', 'sender', 'recipient', 'received_at', 'response_text',
    'raw_reference',
  ]) {
    normalized[field] = str(event[field]).trim();
  }
  return normalized;
}

/**
 * Build exact + digit lookup indexes over operator-supplied verified contact
 * keys. Digit keys are registered only for phone-shaped keys so email keys can
 * never collide through digit stripping.
 */
function buildLookupIndex(identityLookup) {
  const exact = new Map();
  const digit = new Map();
  const lookup = identityLookup && typeof identityLookup === 'object' ? identityLookup : {};
  for (const key of Object.keys(lookup)) {
    const contact = str(key).trim();
    const leadId = str(lookup[key]).trim();
    if (contact === '' || leadId === '') continue;
    exact.set(contact, leadId);
    if (looksLikePhone(contact)) digit.set(digitsOnly(contact), leadId);
  }
  return { exact, digit };
}

function parsedOutreachLead(outreachId, channel) {
  const s = str(outreachId).trim();
  if (s === '') return null;
  const match = EX_OUTREACH_REGEX.exec(s);
  if (!match) return null;
  const leadId = match[1];
  const parsedChannel = match[2];
  if (leadId === '' || parsedChannel !== channel) return null;
  return leadId;
}

function resolveIdentity(event, index) {
  const explicitLead = str(event.lead_id).trim();
  if (explicitLead !== '') return { lead_id: explicitLead };

  const fromOutreach = parsedOutreachLead(event.outreach_id, event.channel);
  if (fromOutreach) return { lead_id: fromOutreach };

  const sender = str(event.sender).trim();
  const recipient = str(event.recipient).trim();

  if (sender !== '' && index.exact.has(sender)) return { lead_id: index.exact.get(sender) };
  if (sender !== '' && looksLikePhone(sender) && index.digit.has(digitsOnly(sender))) {
    return { lead_id: index.digit.get(digitsOnly(sender)) };
  }
  if (recipient !== '' && index.exact.has(recipient)) return { lead_id: index.exact.get(recipient) };
  if (recipient !== '' && looksLikePhone(recipient) && index.digit.has(digitsOnly(recipient))) {
    return { lead_id: index.digit.get(digitsOnly(recipient)) };
  }

  return null;
}

function responseRowFor(event, resolved, idemKey) {
  const leadId = resolved ? resolved.lead_id : '';
  return {
    response_id: `RESP-${fnv1a32Hex(idemKey)}`,
    idempotency_key: idemKey,
    lead_id: leadId,
    outreach_id: resolved ? `EX-${leadId}-${event.channel}` : '',
    channel: event.channel,
    provider_message_id: event.provider_message_id,
    received_at: event.received_at_iso,
    response_text: event.response_text,
    response_status: resolved ? RESPONSE_STATUS.CAPTURED : RESPONSE_STATUS.UNMATCHED,
    source: event.source,
    matched: resolved ? true : false,
    notes: '',
  };
}

function exceptionFor(code, event, evidence) {
  return {
    category: code,
    severity: ERROR_CODE_SEVERITY[code],
    event_id: str(event && event.event_id),
    channel: str(event && event.channel),
    lead_id: str(event && event.lead_id),
    outreach_id: str(event && event.outreach_id),
    response_id: responseIdFor(event || {}),
    reason: ERROR_CODE_REASON[code],
    evidence: evidence || {},
  };
}

function sortedExceptions(exceptions) {
  return exceptions
    .map((e) => Object.assign({}, e))
    .sort((a, b) => {
      for (const key of ['category', 'event_id', 'channel', 'lead_id', 'reason']) {
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

function buildFailedReport(runId, runAt, mode, readError) {
  const exception = exceptionFor(ERROR_CODE.SOURCE_READ_FAILURE, {}, {
    source: 'response log',
    error: readError,
  });
  const reported = sortedExceptions([exception]).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runId }),
  );
  return {
    run_id: runId,
    run_at: runAt,
    mode,
    status: STATUS.FAILED,
    sources: {
      response_log_ok: false,
      response_log_read_error: readError,
    },
    summary: {
      events_processed: null,
      captured: null,
      unmatched: null,
      invalid: null,
      duplicate: null,
      staged: null,
      persisted: null,
      exception_count: reported.length,
    },
    results: [],
    response_rows: [],
    exceptions: reported,
  };
}

function buildReport({ runId, runAt, mode, events, results, responseRows, stagedRows, exceptions }) {
  const sortedResults = sortedBy(results, ['event_id', 'source', 'channel']);
  const sortedRows = sortedBy(stagedRows, ['idempotency_key']);
  const reportedExceptions = sortedExceptions(exceptions).map((e) =>
    Object.assign({}, e, { detected_at: runAt, run_id: runId }),
  );

  const captured = results.filter((r) => r.status === RESPONSE_STATUS.CAPTURED).length;
  const unmatched = results.filter((r) => r.status === RESPONSE_STATUS.UNMATCHED).length;
  const invalid = results.filter((r) => r.status === RESPONSE_STATUS.INVALID).length;
  const duplicate = results.filter((r) => r.status === RESPONSE_STATUS.DUPLICATE).length;
  const staged = captured + unmatched;
  const persisted = mode === 'REAL' ? staged : 0;

  return {
    run_id: runId,
    run_at: runAt,
    mode,
    status: STATUS.COMPLETED,
    sources: {
      response_log_ok: true,
      response_log_read_error: '',
    },
    summary: {
      events_processed: events.length,
      captured,
      unmatched,
      invalid,
      duplicate,
      staged,
      persisted,
      exception_count: reportedExceptions.length,
    },
    results: sortedResults,
    response_rows: mode === 'REAL' ? sortedRows : [],
    exceptions: reportedExceptions,
  };
}

/**
 * Pure response capture entry point.
 *
 * @param {Object} options
 * @param {Array}  [options.events]               normalized inbound response events.
 * @param {Array}  [options.responseRows]         durable Response Log rows (for dedupe).
 * @param {Object} [options.identityLookup]       verified contact keys -> lead_id.
 * @param {string} [options.mode]                 'DRY_RUN' (default) | 'REAL'.
 * @param {string} [options.responseLogReadError] Response Log read failure message.
 * @param {Date|number|string} [options.now]      injected clock for determinism.
 * @param {string} [options.runId]                optional explicit run id override.
 */
function captureFromEvents({
  events,
  responseRows,
  identityLookup,
  mode,
  responseLogReadError,
  now,
  runId: runIdOverride,
} = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const runAt = new Date(nowMs).toISOString();
  const runMode = str(mode).toUpperCase() === 'REAL' ? 'REAL' : 'DRY_RUN';
  const runId = runIdOverride || `${RUN_LABEL}-${digits14(String(nowMs))}`;

  const readError = str(responseLogReadError).trim();
  if (readError !== '') {
    return buildFailedReport(runId, runAt, runMode, readError);
  }

  const inputEvents = Array.isArray(events) ? events : [];
  const index = buildLookupIndex(identityLookup);
  const seenKeys = new Set(
    (Array.isArray(responseRows) ? responseRows : [])
      .map((row) => str(row && row.idempotency_key).trim())
      .filter(Boolean),
  );

  const results = [];
  const stagedRows = [];
  const exceptions = [];

  for (const raw of inputEvents) {
    const event = normalizeEvent(raw);

    const result = {
      event_id: event.event_id,
      source: event.source,
      channel: event.channel,
      status: RESPONSE_STATUS.INVALID,
      status_reason: '',
      matched: false,
      idempotency_key: idempotencyKeyFor(event),
      would_persist: false,
    };
    results.push(result);
    const resultStatus = (status, reason, extra) => {
      result.status = status;
      result.status_reason = reason;
      Object.assign(result, extra || {});
    };

    if (event.event_id === '') {
      resultStatus(RESPONSE_STATUS.INVALID, ERROR_CODE.MISSING_EVENT_ID);
      exceptions.push(exceptionFor(ERROR_CODE.MISSING_EVENT_ID, event, { source: event.source, error_code: ERROR_CODE.MISSING_EVENT_ID }));
      continue;
    }

    if (event.channel === '') {
      resultStatus(RESPONSE_STATUS.INVALID, ERROR_CODE.MISSING_CHANNEL);
      exceptions.push(exceptionFor(ERROR_CODE.MISSING_CHANNEL, event, { source: event.source, error_code: ERROR_CODE.MISSING_CHANNEL }));
      continue;
    }

    if (!SUPPORTED_CHANNELS.includes(event.channel)) {
      resultStatus(RESPONSE_STATUS.INVALID, ERROR_CODE.INVALID_CHANNEL);
      exceptions.push(exceptionFor(ERROR_CODE.INVALID_CHANNEL, event, { source: event.source, error_code: ERROR_CODE.INVALID_CHANNEL, channel: event.channel }));
      continue;
    }

    const receivedAtIso = toIsoUtc(event.received_at);
    if (receivedAtIso === null) {
      resultStatus(RESPONSE_STATUS.INVALID, ERROR_CODE.INVALID_TIMESTAMP);
      exceptions.push(exceptionFor(ERROR_CODE.INVALID_TIMESTAMP, event, { source: event.source, error_code: ERROR_CODE.INVALID_TIMESTAMP, received_at: event.received_at }));
      continue;
    }
    event.received_at_iso = receivedAtIso;

    if (event.response_text === '') {
      resultStatus(RESPONSE_STATUS.INVALID, ERROR_CODE.MISSING_RESPONSE);
      exceptions.push(exceptionFor(ERROR_CODE.MISSING_RESPONSE, event, { source: event.source, error_code: ERROR_CODE.MISSING_RESPONSE }));
      continue;
    }

    const idemKey = idempotencyKeyFor(event);
    if (seenKeys.has(idemKey)) {
      resultStatus(RESPONSE_STATUS.DUPLICATE, ERROR_CODE.DUPLICATE_EVENT);
      result.idempotency_key = idemKey;
      exceptions.push(exceptionFor(ERROR_CODE.DUPLICATE_EVENT, event, { source: event.source, error_code: ERROR_CODE.DUPLICATE_EVENT, idempotency_key: idemKey }));
      continue;
    }
    seenKeys.add(idemKey);

    const resolved = resolveIdentity(event, index);
    result.idempotency_key = idemKey;
    result.response_id = `RESP-${fnv1a32Hex(idemKey)}`;
    result.matched = resolved ? true : false;
    result.lead_id = resolved ? resolved.lead_id : '';
    result.outreach_id = resolved ? `EX-${resolved.lead_id}-${event.channel}` : '';

    if (!resolved) {
      resultStatus(RESPONSE_STATUS.UNMATCHED, ERROR_CODE.UNMATCHED_IDENTITY, {
        response_id: result.response_id,
        would_persist: true,
      });
      exceptions.push(exceptionFor(ERROR_CODE.UNMATCHED_IDENTITY, event, { source: event.source, error_code: ERROR_CODE.UNMATCHED_IDENTITY }));
      stagedRows.push(responseRowFor(event, null, idemKey));
      continue;
    }

    resultStatus(RESPONSE_STATUS.CAPTURED, '', {
      response_id: result.response_id,
      would_persist: true,
    });
    stagedRows.push(responseRowFor(event, resolved, idemKey));
  }

  return buildReport({
    runId,
    runAt,
    mode: runMode,
    events: inputEvents,
    results,
    responseRows,
    stagedRows,
    exceptions,
  });
}

module.exports = {
  SUPPORTED_CHANNELS,
  RUN_LABEL,
  STATUS,
  RESPONSE_STATUS,
  ERROR_CODE,
  SEVERITY,
  ERROR_CODE_SEVERITY,
  ERROR_CODE_REASON,
  RESPONSE_COLUMNS,
  str,
  digitsOnly,
  digits14,
  looksLikePhone,
  toIsoUtc,
  fnv1a32Hex,
  idempotencyKeyFor,
  responseIdFor,
  normalizeEvent,
  buildLookupIndex,
  parsedOutreachLead,
  resolveIdentity,
  captureFromEvents,
};