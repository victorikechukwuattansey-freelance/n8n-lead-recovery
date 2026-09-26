'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  captureFromEvents,
  RESPONSE_COLUMNS,
  SUPPORTED_CHANNELS,
  RUN_LABEL,
  STATUS,
  RESPONSE_STATUS,
  ERROR_CODE,
  SEVERITY,
  ERROR_CODE_SEVERITY,
} = require('../src/response-capture');
const { loadResponseCaptureFixtures, RESP_REGEX } = require('../src/response-capture-fixtures');

const FIXED_NOW = new Date('2026-09-11T09:00:00.000Z').getTime();

const fixtures = loadResponseCaptureFixtures();

function fixtureById(id) {
  const fx = fixtures.find((f) => f.id === id);
  if (!fx) throw new Error('fixture not found: ' + id);
  return fx;
}

function runFixture(fx, overrides = {}) {
  return captureFromEvents({
    events: fx.events,
    responseRows: fx.initialResponseRows,
    identityLookup: fx.identity_lookup,
    mode: fx.mode,
    now: FIXED_NOW,
    ...overrides,
  });
}

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

function categoriesOf(report) {
  return [...new Set(report.exceptions.map((e) => e.category))].sort();
}

/* ------------------------------------------------------------------ */
/* Contract surface                                                    */
/* ------------------------------------------------------------------ */

test('engine exports the full status, severity, and error vocabulary', () => {
  assert.equal(RUN_LABEL, 'RESPCAP');
  assert.deepEqual(SUPPORTED_CHANNELS, ['email', 'call']);
  assert.equal(STATUS.COMPLETED, 'COMPLETED');
  assert.equal(STATUS.FAILED, 'FAILED');
  for (const code of [
    'MISSING_EVENT_ID', 'MISSING_CHANNEL', 'INVALID_CHANNEL', 'INVALID_TIMESTAMP',
    'MISSING_RESPONSE', 'UNMATCHED_IDENTITY', 'DUPLICATE_EVENT', 'SOURCE_READ_FAILURE',
  ]) {
    assert.equal(ERROR_CODE[code], code);
    assert.ok(ERROR_CODE_SEVERITY[code], 'missing severity for ' + code);
  }
  assert.equal(ERROR_CODE_SEVERITY[ERROR_CODE.UNMATCHED_IDENTITY], SEVERITY.WARNING);
  assert.equal(ERROR_CODE_SEVERITY[ERROR_CODE.DUPLICATE_EVENT], SEVERITY.WARNING);
  assert.equal(ERROR_CODE_SEVERITY[ERROR_CODE.SOURCE_READ_FAILURE], SEVERITY.ERROR);
  assert.equal(RESPONSE_STATUS.CAPTURED, 'CAPTURED');
  assert.equal(RESPONSE_STATUS.UNMATCHED, 'UNMATCHED');
  assert.equal(RESPONSE_STATUS.INVALID, 'INVALID');
  assert.equal(RESPONSE_STATUS.DUPLICATE, 'DUPLICATE');
});

test('canonical RESPONSE_COLUMNS order is fixed and does not regress', () => {
  assert.deepEqual(RESPONSE_COLUMNS, [
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
  ]);
});

test('fixture set covers the full TEST-RESP-001..018 range', () => {
  const ids = new Set(fixtures.map((f) => f.id));
  for (let i = 1; i <= 18; i += 1) {
    const id = `TEST-RESP-${String(i).padStart(3, '0')}`;
    assert.ok(ids.has(id), 'missing fixture ' + id);
  }
  assert.equal(fixtures.length, 18);
});

/* ------------------------------------------------------------------ */
/* Fixture expectations                                                */
/* ------------------------------------------------------------------ */

test('every fixture captures to its documented summary and exceptions', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    const exp = fx.expected;
    assert.equal(report.status, exp.status, fx.id + ': status');
    assert.equal(report.mode, exp.mode, fx.id + ': mode');
    for (const field of ['captured', 'unmatched', 'invalid', 'duplicate', 'staged', 'persisted', 'exception_count']) {
      assert.equal(report.summary[field], exp[field], fx.id + ': summary.' + field);
    }
    assert.deepEqual(categoriesOf(report), exp.exception_categories, fx.id + ': exception categories');
    assert.equal(report.summary.events_processed, fx.events.length, fx.id + ': events_processed');
  }
});

test('run_id follows the RESPCAP label with 14-digit second granularity', () => {
  const report = runFixture(fixtureById('TEST-RESP-016'));
  assert.match(report.run_id, /^RESPCAP-\d{14}$/);
  const digits = String(new Date(FIXED_NOW).getTime()).replace(/\D/g, '').slice(0, 14).padEnd(14, '0');
  assert.equal(report.run_id, `RESPCAP-${digits}`);
  assert.equal(report.run_at, new Date(FIXED_NOW).toISOString());
});

/* ------------------------------------------------------------------ */
/* Idempotency determinism                                             */
/* ------------------------------------------------------------------ */

test('capture is deterministic for identical inputs', () => {
  const fx = fixtureById('TEST-RESP-001');
  const a = runFixture(fx);
  const b = runFixture(fx);
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('capture is order-independent: reversing events and ledger rows yields an identical report', () => {
  for (const id of ['TEST-RESP-001', 'TEST-RESP-003', 'TEST-RESP-005']) {
    const fx = fixtureById(id);
    const normal = runFixture(fx);
    const reordered = captureFromEvents({
      events: fx.events.slice().reverse(),
      responseRows: fx.initialResponseRows.slice().reverse(),
      identityLookup: fx.identity_lookup,
      mode: fx.mode,
      now: FIXED_NOW,
    });
    assert.deepEqual(stripRuntime(normal), stripRuntime(reordered), id + ': order-independent');
  }
});

test('reorder fixture 018 is identical to TEST-RESP-001 (row position is never identity)', () => {
  const a = runFixture(fixtureById('TEST-RESP-001'));
  const b = runFixture(fixtureById('TEST-RESP-018'));
  assert.deepEqual(stripRuntime(a), stripRuntime(b));
});

test('deterministic response_id and idempotency_key (FNV-1a)', () => {
  const fx = fixtureById('TEST-RESP-001');
  const report = runFixture(fx);
  const row = report.response_rows[0];
  const event = fx.events[0];
  const key = `${event.provider_message_id}::${event.source}`;
  assert.equal(row.idempotency_key, key);
  assert.match(row.response_id, /^RESP-[0-9a-f]{8}$/);
  const again = runFixture(fx);
  assert.equal(again.response_rows[0].response_id, row.response_id, 'response_id must be reproducible');
});

test('in-batch duplicate (fixture 002): one durable row, one DUPLICATE_EVENT, key added after staging', () => {
  const report = runFixture(fixtureById('TEST-RESP-002'));
  assert.equal(report.summary.captured, 1);
  assert.equal(report.summary.duplicate, 1);
  assert.equal(report.response_rows.length, 1);
  assert.deepEqual(categoriesOf(report), ['DUPLICATE_EVENT']);
});

test('pre-existing ledger keys suppress re-ingestion (fixture 017)', () => {
  const report = runFixture(fixtureById('TEST-RESP-017'));
  assert.equal(report.summary.duplicate, 1);
  assert.equal(report.summary.captured, 0);
  assert.equal(report.summary.staged, 0);
  assert.equal(report.summary.persisted, 0);
  assert.equal(report.response_rows.length, 0);
});

test('DRY_RUN persists zero rows but stages its capture', () => {
  const report = runFixture(fixtureById('TEST-RESP-015'));
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.summary.staged, 1);
  assert.equal(report.summary.persisted, 0);
  assert.deepEqual(report.response_rows, []);
  assert.ok(report.results[0].would_persist === true);
});

test('REAL mode returns exactly the staged durable rows', () => {
  const report = runFixture(fixtureById('TEST-RESP-016'));
  assert.equal(report.mode, 'REAL');
  assert.equal(report.response_rows.length, 1);
  assert.equal(report.summary.persisted, 1);
  const row = report.response_rows[0];
  assert.equal(row.response_status, 'CAPTURED');
  assert.equal(row.matched, true);
  assert.equal(row.lead_id, 'TEST-RESP-016');
});

/* ------------------------------------------------------------------ */
/* Identity resolution                                                 */
/* ------------------------------------------------------------------ */

test('explicit lead_id is taken verbatim (fixture 006)', () => {
  const report = runFixture(fixtureById('TEST-RESP-006'));
  assert.equal(report.response_rows[0].lead_id, 'TEST-RESP-006-lead');
  assert.equal(report.response_rows[0].outreach_id, 'EX-TEST-RESP-006-lead-email');
  assert.equal(report.response_rows[0].response_status, 'CAPTURED');
});

test('outreach_id EX-<lead_id>-<channel> parses with multi-dash lead ids (fixture 007)', () => {
  const report = runFixture(fixtureById('TEST-RESP-007'));
  assert.equal(report.response_rows[0].lead_id, 'TEST-RESP-007-core');
  assert.equal(report.response_rows[0].outreach_id, 'EX-TEST-RESP-007-core-email');
});

test('sender exact lookup resolves identity (fixture 008)', () => {
  const report = runFixture(fixtureById('TEST-RESP-008'));
  assert.equal(report.response_rows[0].lead_id, 'TEST-RESP-008-lead');
  assert.equal(report.response_rows[0].matched, true);
});

test('phone sender is normalized to digits for lookup (fixture 009)', () => {
  const report = runFixture(fixtureById('TEST-RESP-009'));
  assert.equal(report.response_rows[0].lead_id, 'TEST-RESP-009-lead');
  assert.equal(report.response_rows[0].channel, 'call');
});

test('unknown sender yields UNMATCHED with no fabricated lead (fixture 005)', () => {
  const report = runFixture(fixtureById('TEST-RESP-005'));
  assert.equal(report.summary.unmatched, 1);
  const row = report.response_rows[0];
  assert.equal(row.lead_id, '');
  assert.equal(row.outreach_id, '');
  assert.equal(row.matched, false);
  assert.equal(row.response_status, 'UNMATCHED');
  assert.deepEqual(categoriesOf(report), ['UNMATCHED_IDENTITY']);
});

test('phone-gated digit lookup never matches non-phone keys via digit stripping', () => {
  const report = captureFromEvents({
    events: [{
      event_id: 'evt-lo-1',
      source: 'mock-provider',
      channel: 'email',
      provider_message_id: 'mock:LO-1',
      lead_id: '',
      outreach_id: '',
      sender: 'grow@acme.example',   // not phone-shaped
      recipient: 'ops@jarvis.example',
      received_at: '2026-09-11T09:05:00.000Z',
      response_text: 'Not a phone lookup.',
      raw_reference: 'thread-lo',
    }],
    responseRows: [],
    identityLookup: { 'growacmeexample': 'TEST-RESP-NOPE' },
    mode: 'REAL',
    now: FIXED_NOW,
  });
  assert.equal(report.summary.unmatched, 1, 'digit-truncated email must never match');
  assert.equal(report.response_rows[0].lead_id, '');
});

/* ------------------------------------------------------------------ */
/* Validation cascade                                                  */
/* ------------------------------------------------------------------ */

test('invalid events cascade first-failure-wins and persist nothing', () => {
  const expected = [
    ['TEST-RESP-010', 'MISSING_EVENT_ID'],
    ['TEST-RESP-011', 'MISSING_CHANNEL'],
    ['TEST-RESP-012', 'INVALID_CHANNEL'],
    ['TEST-RESP-013', 'INVALID_TIMESTAMP'],
    ['TEST-RESP-014', 'MISSING_RESPONSE'],
  ];
  for (const [id, category] of expected) {
    const report = runFixture(fixtureById(id));
    assert.equal(report.status, 'COMPLETED', id);
    assert.equal(report.summary.invalid, 1, id + ': invalid');
    assert.equal(report.summary.staged, 0, id + ': staged');
    assert.equal(report.summary.persisted, 0, id + ': persisted');
    assert.deepEqual(report.response_rows, [], id + ': no rows');
    assert.deepEqual(categoriesOf(report), [category], id);
    assert.equal(report.results[0].status, 'INVALID', id + ': result status');
    assert.equal(report.results[0].would_persist, false, id + ': not persisting');
  }
});

test('unsupported channels are INVALID even with otherwise valid content (fixture 012 sms)', () => {
  const report = runFixture(fixtureById('TEST-RESP-012'));
  assert.equal(report.results[0].status, 'INVALID');
  assert.equal(report.results[0].status_reason, 'INVALID_CHANNEL');
});

test('response text is preserved verbatim in durable rows, recipients excluded from cards', () => {
  const report = runFixture(fixtureById('TEST-RESP-001'));
  const row = report.response_rows[0];
  assert.equal(row.response_text, 'This looks interesting - please send details.');
  assert.equal(row.received_at, '2026-09-11T09:05:00.000Z');
  assert.equal(report.results[0].status, 'CAPTURED');
  assert.equal(report.results[0].response_id, row.response_id);
  assert.equal(report.results[0].lead_id, 'TEST-RESP-001');
});

test('result cards never carry response text, sender, recipient, or raw references', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    if (report.status === 'FAILED') continue;
    for (const card of report.results) {
      const raw = JSON.stringify(card);
      assert.ok(!raw.includes('response_text'), fx.id + ': card must not carry response_text');
      assert.ok(!/sender|recipient|raw_reference/.test(raw), fx.id + ': card must not carry sender/recipient/raw_reference');
      assert.ok(!raw.includes('@example.com'), fx.id + ': card must not carry email addresses');
    }
  }
});

/* ------------------------------------------------------------------ */
/* Read failure semantics                                              */
/* ------------------------------------------------------------------ */

test('response-log read failure yields FAILED with null metrics and refuses processing', () => {
  for (const readError of ['Response Log sheet unavailable', 'network failure', 'auth expired']) {
    const report = captureFromEvents({
      events: fixtureById('TEST-RESP-016').events,
      responseRows: [],
      identityLookup: {},
      mode: 'REAL',
      responseLogReadError: readError,
      now: FIXED_NOW,
    });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.sources.response_log_ok, false);
    assert.equal(report.sources.response_log_read_error, readError);
    for (const field of ['events_processed', 'captured', 'unmatched', 'invalid', 'duplicate', 'staged', 'persisted']) {
      assert.equal(report.summary[field], null, field + ' must be null on read failure');
    }
    assert.equal(report.summary.exception_count, 1);
    assert.deepEqual(report.response_rows, []);
    assert.deepEqual(report.results, []);
    assert.deepEqual(categoriesOf(report), ['SOURCE_READ_FAILURE']);
    assert.equal(report.exceptions[0].severity, 'ERROR');
  }
});

test('empty input is COMPLETED with valid zero metrics', () => {
  const report = captureFromEvents({ events: [], responseRows: [], mode: 'REAL', now: FIXED_NOW });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.summary.events_processed, 0);
  assert.equal(report.summary.captured, 0);
  assert.equal(report.summary.persisted, 0);
  assert.equal(report.summary.exception_count, 0);
});

/* ------------------------------------------------------------------ */
/* Envelope hygiene and consistency                                    */
/* ------------------------------------------------------------------ */

test('exception envelope contains no secrets, response text, emails, or raw provider ids', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    for (const e of report.exceptions) {
      assert.deepEqual(
        Object.keys(e).sort(),
        ['category', 'channel', 'detected_at', 'evidence', 'event_id', 'lead_id', 'outreach_id', 'reason', 'response_id', 'run_id', 'severity'].sort(),
        fx.id + ': exception envelope keys',
      );
      const raw = JSON.stringify(e);
      assert.ok(!raw.includes('response_text'), fx.id + ': no response text in exceptions');
      assert.ok(!raw.includes('@example.com'), fx.id + ': no email addresses in exceptions');
      assert.ok(!raw.includes('+1'), fx.id + ': no phone payloads in exceptions');
    }
  }
});

test('summary counts derive consistently from staged rows and results', () => {
  for (const fx of fixtures) {
    const report = runFixture(fx);
    if (report.status === 'FAILED') continue;
    assert.equal(report.summary.exception_count, report.exceptions.length, fx.id);
    assert.equal(report.summary.staged, report.summary.captured + report.summary.unmatched, fx.id + ': staged = captured + unmatched');
    assert.equal(report.summary.persisted, report.mode === 'REAL' ? report.summary.staged : 0, fx.id + ': persisted');
    assert.equal(report.response_rows.length, report.mode === 'REAL' ? report.summary.staged : 0, fx.id + ': response_rows');
    assert.deepEqual(categoriesOf(report), fx.expected.exception_categories, fx.id);
  }
});

test('results, rows, and exceptions are deterministically sorted', () => {
  const report = runFixture(fixtureById('TEST-RESP-003'));
  const keys = report.results.map((r) => [r.event_id, r.source, r.channel]);
  assert.deepEqual(keys, [...keys].sort(), 'results sorted by event_id/source/channel');
  const rowKeys = report.response_rows.map((r) => r.idempotency_key);
  assert.deepEqual(rowKeys, [...rowKeys].sort(), 'rows sorted by idempotency_key');
});

test('fixture ids are strictly within the TEST-RESP namespace', () => {
  for (const fx of fixtures) {
    assert.ok(RESP_REGEX.test(fx.id), fx.id + ' must match ' + RESP_REGEX);
  }
});