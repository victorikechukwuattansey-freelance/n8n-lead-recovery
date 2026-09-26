'use strict';

/*
 * Embedded code for the Response-Capture V1 n8n workflow.
 *
 * These strings are assembled into Response-Capture V1.json by
 * scripts/build-response-capture-workflow.js. The Capture Inbound Responses
 * node embeds a synchronous mirror of src/response-capture.js. The workflow
 * test suite asserts the embedded code stays in sync with the engine on every
 * fixture (parity test).
 *
 * This artifact CAPTURES INBOUND responses only. It never sends, never replies,
 * never schedules, never interprets intent, never qualifies, and never syncs to
 * a CRM. DRY_RUN is the default mode and writes nothing; the only durable write
 * surface in the workflow is the Response Log append, gated behind a REAL-mode
 * branch.
 */

const RESPONSE_COLUMNS_EMBEDDED = [
  'response_id', 'idempotency_key', 'lead_id', 'outreach_id', 'channel',
  'provider_message_id', 'received_at', 'response_text', 'response_status',
  'source', 'matched', 'notes',
];

const initCaptureCode = [
  "const input = $json || {};",
  "const mode = typeof input.mode === 'string' && input.mode.toUpperCase() === 'REAL' ? 'REAL' : 'DRY_RUN';",
  "const events = Array.isArray(input.events) ? input.events : [];",
  "const identity_lookup = input.identity_lookup && typeof input.identity_lookup === 'object' ? input.identity_lookup : {};",
  "const response_log_read_error = typeof input.response_log_read_error === 'string' ? input.response_log_read_error : '';",
  'return [{ json: { mode, events, identity_lookup, response_log_read_error } }];',
].join('\n');

const captureCode = `'use strict';

const initItems = $('Initialize Response Capture').all();
const logItems = $('Read Response Log').all();

const str = (value) => (value === undefined || value === null ? '' : String(value));
const RUN_LABEL = 'RESPCAP';
const SUPPORTED_CHANNELS = ['email', 'call'];
const RESPONSE_STATUS = { CAPTURED: 'CAPTURED', UNMATCHED: 'UNMATCHED', INVALID: 'INVALID', DUPLICATE: 'DUPLICATE' };
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
const SEVERITY = { ERROR: 'ERROR', WARNING: 'WARNING' };
const ERROR_CODE_SEVERITY = {};
ERROR_CODE_SEVERITY[ERROR_CODE.MISSING_EVENT_ID] = SEVERITY.ERROR;
ERROR_CODE_SEVERITY[ERROR_CODE.MISSING_CHANNEL] = SEVERITY.ERROR;
ERROR_CODE_SEVERITY[ERROR_CODE.INVALID_CHANNEL] = SEVERITY.ERROR;
ERROR_CODE_SEVERITY[ERROR_CODE.INVALID_TIMESTAMP] = SEVERITY.ERROR;
ERROR_CODE_SEVERITY[ERROR_CODE.MISSING_RESPONSE] = SEVERITY.ERROR;
ERROR_CODE_SEVERITY[ERROR_CODE.UNMATCHED_IDENTITY] = SEVERITY.WARNING;
ERROR_CODE_SEVERITY[ERROR_CODE.DUPLICATE_EVENT] = SEVERITY.WARNING;
ERROR_CODE_SEVERITY[ERROR_CODE.SOURCE_READ_FAILURE] = SEVERITY.ERROR;
const ERROR_CODE_REASON = {};
ERROR_CODE_REASON[ERROR_CODE.MISSING_EVENT_ID] = 'Event is missing event_id; it cannot be tracked or deduped.';
ERROR_CODE_REASON[ERROR_CODE.MISSING_CHANNEL] = 'Event is missing channel; the response channel is unknown.';
ERROR_CODE_REASON[ERROR_CODE.INVALID_CHANNEL] = 'Channel value is not a supported response channel.';
ERROR_CODE_REASON[ERROR_CODE.INVALID_TIMESTAMP] = 'received_at could not be parsed as a timestamp.';
ERROR_CODE_REASON[ERROR_CODE.MISSING_RESPONSE] = 'Event carries no response text; there is nothing to capture.';
ERROR_CODE_REASON[ERROR_CODE.UNMATCHED_IDENTITY] = 'No lead identity could be resolved for the event; it is captured without a lead.';
ERROR_CODE_REASON[ERROR_CODE.DUPLICATE_EVENT] = 'Event idempotency key already exists; a durable row was never created again.';
ERROR_CODE_REASON[ERROR_CODE.SOURCE_READ_FAILURE] = 'The Response Log could not be read; capture is refused because dedupe cannot be trusted.';

const digitsOnly = (value) => str(value).replace(/\\D/g, '');
const digits14 = (value) => digitsOnly(value).slice(0, 14).padEnd(14, '0');
const looksLikePhone = (value) => {
  const s = str(value).trim();
  return s !== '' && /^\\+?[\\d\\s\\-().]+$/.test(s);
};
const toIsoUtc = (value) => {
  const s = str(value).trim();
  if (s === '') return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
};
const fnv1a32Hex = (input) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const idempotencyKeyFor = (event) => {
  const providerId = str(event.provider_message_id).trim();
  const eventId = str(event.event_id).trim();
  const source = str(event.source).trim();
  return (providerId || eventId) + '::' + source;
};
const responseIdFor = (event) => 'RESP-' + fnv1a32Hex(idempotencyKeyFor(event));

const normalizeEvent = (event) => {
  const src = (event && typeof event === 'object') ? event : {};
  const normalized = {};
  for (const field of [
    'event_id', 'source', 'channel', 'provider_message_id', 'lead_id',
    'outreach_id', 'sender', 'recipient', 'received_at', 'response_text', 'raw_reference',
  ]) {
    normalized[field] = str(src[field]).trim();
  }
  return normalized;
};

const buildLookupIndex = (identityLookup) => {
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
};

const parsedOutreachLead = (outreachId, channel) => {
  const s = str(outreachId).trim();
  if (s === '') return null;
  const match = /^EX-(.+)-(email|call)$/.exec(s);
  if (!match) return null;
  if (match[1] === '' || match[2] !== channel) return null;
  return match[1];
};

const resolveIdentity = (event, index) => {
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
};

const responseRowFor = (event, resolved, idemKey) => {
  const leadId = resolved ? resolved.lead_id : '';
  return {
    response_id: 'RESP-' + fnv1a32Hex(idemKey),
    idempotency_key: idemKey,
    lead_id: leadId,
    outreach_id: resolved ? 'EX-' + leadId + '-' + event.channel : '',
    channel: event.channel,
    provider_message_id: event.provider_message_id,
    received_at: event.received_at_iso,
    response_text: event.response_text,
    response_status: resolved ? RESPONSE_STATUS.CAPTURED : RESPONSE_STATUS.UNMATCHED,
    source: event.source,
    matched: resolved ? true : false,
    notes: '',
  };
};

const exceptionFor = (code, event, evidence) => ({
  category: code,
  severity: ERROR_CODE_SEVERITY[code],
  event_id: str(event && event.event_id),
  channel: str(event && event.channel),
  lead_id: str(event && event.lead_id),
  outreach_id: str(event && event.outreach_id),
  response_id: responseIdFor(event || {}),
  reason: ERROR_CODE_REASON[code],
  evidence: evidence || {},
});

const sortedExceptions = (exceptions) =>
  exceptions.slice().sort((a, b) => {
    for (const key of ['category', 'event_id', 'channel', 'lead_id', 'reason']) {
      const av = a[key];
      const bv = b[key];
      if (av < bv) return -1;
      if (av > bv) return 1;
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

let mode = 'DRY_RUN';
let events = [];
let identity_lookup = {};
let response_log_read_error = '';
for (const item of initItems) {
  const j = (item && item.json) || {};
  if (typeof j.mode === 'string') mode = j.mode.toUpperCase() === 'REAL' ? 'REAL' : 'DRY_RUN';
  if (Array.isArray(j.events)) events = j.events;
  if (j.identity_lookup && typeof j.identity_lookup === 'object') identity_lookup = j.identity_lookup;
  if (typeof j.response_log_read_error === 'string') response_log_read_error = j.response_log_read_error;
}
const logRows = logItems.map((item) => (item && item.json) || {});

const runAt = new Date().toISOString();
const runId = RUN_LABEL + '-' + digits14(runAt);

if (str(response_log_read_error).trim() !== '') {
  const e = exceptionFor(ERROR_CODE.SOURCE_READ_FAILURE, {}, { source: 'response log', error: response_log_read_error });
  const reported = sortedExceptions([e]).map((ex) => Object.assign({}, ex, { detected_at: runAt, run_id: runId }));
  return [{
    json: {
      run_id: runId,
      run_at: runAt,
      mode,
      status: 'FAILED',
      sources: { response_log_ok: false, response_log_read_error },
      summary: {
        events_processed: null, captured: null, unmatched: null, invalid: null,
        duplicate: null, staged: null, persisted: null, exception_count: reported.length,
      },
      results: [],
      response_rows: [],
      exceptions: reported,
    },
  }];
}

const index = buildLookupIndex(identity_lookup);
const seenKeys = new Set(logRows.map((row) => str(row && row.idempotency_key).trim()).filter(Boolean));

const results = [];
const stagedRows = [];
const exceptions = [];

for (const raw of events) {
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

  if (SUPPORTED_CHANNELS.indexOf(event.channel) === -1) {
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
  result.response_id = 'RESP-' + fnv1a32Hex(idemKey);
  result.matched = resolved ? true : false;
  result.lead_id = resolved ? resolved.lead_id : '';
  result.outreach_id = resolved ? 'EX-' + resolved.lead_id + '-' + event.channel : '';

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

const sortedResults = sortedBy(results, ['event_id', 'source', 'channel']);
const sortedRows = sortedBy(stagedRows, ['idempotency_key']);
const reportedExceptions = sortedExceptions(exceptions).map((e) => Object.assign({}, e, { detected_at: runAt, run_id: runId }));

const captured = results.filter((r) => r.status === RESPONSE_STATUS.CAPTURED).length;
const unmatched = results.filter((r) => r.status === RESPONSE_STATUS.UNMATCHED).length;
const invalid = results.filter((r) => r.status === RESPONSE_STATUS.INVALID).length;
const duplicate = results.filter((r) => r.status === RESPONSE_STATUS.DUPLICATE).length;
const staged = captured + unmatched;
const persisted = mode === 'REAL' ? staged : 0;

const report = {
  run_id: runId,
  run_at: runAt,
  mode,
  status: 'COMPLETED',
  sources: { response_log_ok: true, response_log_read_error: '' },
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

return [{ json: report }];
`;

const prepareWriteCode = [
  "const report = $('Capture Inbound Responses').item || {};",
  'const rows = Array.isArray(report.response_rows) ? report.response_rows : [];',
  `const out = ${JSON.stringify(RESPONSE_COLUMNS_EMBEDDED)};`,
  'return rows.map((row) => {',
  '  const item = {};',
  "  for (const c of out) item[c] = row[c] === undefined || row[c] === null ? '' : String(row[c]);",
  '  return { json: item };',
  '});',
].join('\n');

module.exports = { initCaptureCode, captureCode, prepareWriteCode, RESPONSE_COLUMNS_EMBEDDED };