'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createContactClient,
  createAgentDataClient,
  createHunterClient,
  parseDomainSearch,
  parseAgentDataDomainSearch,
  buildSearchUrl,
  buildAgentDataUrl,
  emailDomainOf,
  delayForAttempt,
  delayForSchedule,
  paceDelayFor,
  normalizeVerificationStatus,
  isConfigured,
  AGENTDATA_NOT_CONFIGURED,
  AGENTDATA_AUTH_FAILED,
  AGENTDATA_RATE_LIMITED,
  AGENTDATA_SERVER_ERROR,
  AGENTDATA_NETWORK_ERROR,
  AGENTDATA_TRANSPORT_UNAVAILABLE,
  AGENTDATA_UNKNOWN_RESPONSE,
  AGENTDATA_MIN_PACING_MS,
  RETRY_DELAYS,
  HUNTER_NOT_CONFIGURED,
  HUNTER_AUTH_FAILED,
  HUNTER_RATE_LIMITED,
  HUNTER_SERVER_ERROR,
  HUNTER_NETWORK_ERROR,
  HUNTER_TRANSPORT_UNAVAILABLE,
  HUNTER_UNKNOWN_RESPONSE,
} = require('../src/enrichment-contact-client');

function transportFor(statuses) {
  const queue = statuses.slice();
  return async (url, options) => {
    const current = queue.shift();
    return { status: current.status, body: current.body || null };
  };
}

function transportAware(options) {
  const calls = [];
  return {
    calls,
    transport: async (url, opts) => {
      calls.push({ url, options: opts || null });
      const current = (options.queue || []).shift();
      if (!current) return { status: 200, body: null };
      return { status: current.status, body: current.body || null };
    },
  };
}

function searchBody(emails) {
  return { data: { emails } };
}

function hunterEmail(value, confidence, verificationStatus) {
  return {
    value,
    confidence,
    verification: { status: verificationStatus },
    first_name: 'Ada',
    last_name: 'Lovelace',
    position: 'Engineer',
  };
}

function agentDataItem(email, confidence, verificationStatus, name) {
  return {
    email,
    confidence,
    verification_status: verificationStatus,
    first_name: name && name.first || '',
    last_name: name && name.last || '',
    position: 'Operations',
  };
}

/* ------------------------- helpers ------------------------- */

test('parseDomainSearch: maps Hunter fields to the canonical shape and filters to the requested domain', () => {
  const body = searchBody([
    hunterEmail('ada@example.com', 98, 'valid'),
    hunterEmail('ada@other-domain.com', 100, 'valid'),
    hunterEmail('info@example.com', 99, 'unknown'),
  ]);
  const result = parseDomainSearch(body, 'example.com');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'hunter');
  assert.equal(result.creditsUsed, 1);
  assert.deepEqual(
    result.emails.map((e) => e.email),
    ['ada@example.com', 'info@example.com'],
  );
  const ada = result.emails[0];
  assert.equal(ada.confidence, 98);
  assert.equal(ada.verification_status, 'valid');
  assert.equal(ada.first_name, 'Ada');
  assert.equal(ada.position, 'Engineer');
  const info = result.emails[1];
  assert.equal(info.verification_status, 'unknown', 'unknown verification maps to unverified');
});

test('parseDomainSearch: tolerates malformed/empty bodies', () => {
  assert.deepEqual(parseDomainSearch(null, 'x.example.com').emails, []);
  assert.deepEqual(parseDomainSearch({}, 'x.example.com').emails, []);
  assert.deepEqual(parseDomainSearch({ data: {} }, 'x.example.com').emails, []);
  assert.deepEqual(parseDomainSearch({ data: { emails: [{ value: 'a@b' }] } }, 'other.example.com').emails, []);
});

test('parseAgentDataDomainSearch: maps the wire shape and enforces the requested domain', () => {
  const body = {
    emails: [
      agentDataItem('gina@agentx.example.com', 97, 'valid', { first: 'Gina', last: 'Merri' }),
      agentDataItem('gina@other-domain.com', 100, 'valid', { first: 'Gina', last: 'Merri' }),
      agentDataItem('support@agentx.example.com', 99, 'unknown', { first: '', last: '' }),
    ],
  };
  const result = parseAgentDataDomainSearch(body, 'agentx.example.com');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'agentdata');
  assert.equal(result.creditsUsed, 1);
  assert.deepEqual(
    result.emails.map((e) => e.email),
    ['gina@agentx.example.com', 'support@agentx.example.com'],
  );
  assert.equal(result.emails[0].first_name, 'Gina');
  assert.equal(result.emails[0].last_name, 'Merri');
  assert.equal(result.emails[0].verification_status, 'valid');
  assert.equal(result.emails[1].verification_status, 'unknown');
});

test('parseAgentDataDomainSearch: accepts emails.data and data shapes', () => {
  const inner = [agentDataItem('a@known.example.com', 90, 'valid', { first: 'A', last: 'B' })];
  assert.deepEqual(
    parseAgentDataDomainSearch({ emails: { data: inner } }, 'known.example.com').emails.map((e) => e.email),
    ['a@known.example.com'],
  );
  assert.deepEqual(
    parseAgentDataDomainSearch({ data: inner }, 'known.example.com').emails.map((e) => e.email),
    ['a@known.example.com'],
  );
});

test('parseAgentDataDomainSearch: name split keeps last-word surname and tolerates single-token/absent names', () => {
  const split = (full) =>
    parseAgentDataDomainSearch(
      { emails: [{ email: 'x@n.example.com', confidence: 90, name: full, verification_status: 'valid' }] },
      'n.example.com',
    ).emails[0];
  assert.deepEqual([split('Ada Lovelace').first_name, split('Ada Lovelace').last_name], ['Ada', 'Lovelace']);
  assert.deepEqual([split('Madonna').first_name, split('Madonna').last_name], ['Madonna', '']);
  assert.deepEqual([split('').first_name, split('').last_name], ['', '']);
  assert.deepEqual([split(undefined).first_name, split(undefined).last_name], ['', '']);
});

test('parseAgentDataDomainSearch: verification normalization', () => {
  const norm = (status) =>
    parseAgentDataDomainSearch(
      { emails: [{ email: 'x@n.example.com', confidence: 90, first_name: '', last_name: '', verification_status: status }] },
      'n.example.com',
    ).emails[0].verification_status;
  assert.equal(norm('valid'), 'valid');
  assert.equal(norm('catch-all'), 'valid');
  assert.equal(norm('catch-all-unknown'), 'unknown');
  assert.equal(norm('unknown'), 'unknown');
  assert.equal(norm('unverified'), 'unknown');
  assert.equal(norm(''), 'unknown');
});

test('buildSearchUrl: appends domain, api_key and limit to the baseUrl', () => {
  const url = buildSearchUrl({ apiKey: 'k', domain: 'example.com' });
  assert.match(url, /^https:\/\/api\.hunter\.io\/v2\/domain-search\?/);
  assert.match(url, /domain=example\.com/);
  assert.match(url, /api_key=k/);
  assert.match(url, /limit=10/);
});

test('buildAgentDataUrl: appends domain, min_confidence and verification_status, strips a trailing slash', () => {
  const url = buildAgentDataUrl({ domain: 'example.com' });
  assert.match(url, /^https:\/\/agentdata\.run\/api\/v1\/lookup\?/);
  assert.match(url, /domain=example\.com/);
  assert.match(url, /min_confidence=90/);
  assert.match(url, /verification_status=valid%2Ccatch-all/);
  const custom = buildAgentDataUrl({ baseUrl: 'https://agentdata.example.test/', domain: 'x.com' });
  assert.match(custom, /^https:\/\/agentdata\.example\.test\/api\/v1\/lookup\?/);
});

test('emailDomainOf: extracts the host part after the last @', () => {
  assert.equal(emailDomainOf('ada@example.com'), 'example.com');
  assert.equal(emailDomainOf(''), '');
  assert.equal(emailDomainOf('no-at-sign'), '');
});

test('delayForAttempt: exponential backoff from a base millisecond floor', () => {
  assert.equal(delayForAttempt(0, 100), 100);
  assert.equal(delayForAttempt(1, 100), 200);
  assert.equal(delayForAttempt(2, 100), 400);
  assert.equal(delayForAttempt(2, 50), 200);
  assert.equal(delayForAttempt(2), 400, 'defaults to 100ms base');
});

test('delayForSchedule: indexes the injectable backoff list, clamps past the end', () => {
  assert.equal(delayForSchedule([500, 1500, 4500], 0), 500);
  assert.equal(delayForSchedule([500, 1500, 4500], 1), 1500);
  assert.equal(delayForSchedule([500, 1500, 4500], 44), 4500);
  assert.equal(delayForSchedule(undefined, 1), RETRY_DELAYS[1]);
});

test('paceDelayFor: no pacing on the first call, full gap when under spacing, zero when at/over spacing', () => {
  assert.equal(paceDelayFor(Number.NaN, 1000, 200), 0, 'first call is immediate');
  assert.equal(paceDelayFor(800, 1000, 200), 0, 'gap of 200 already met');
  assert.equal(paceDelayFor(700, 1000, 200), 0, 'gap of 300 exceeds the window');
  assert.equal(paceDelayFor(900, 1000, 200), 100, 'needs 100 more ms');
  assert.equal(paceDelayFor(940, 1000, 200), 140, 'needs 140 more ms');
  assert.equal(paceDelayFor(700, 1000, 0), 0, 'pacing disabled at 0');
});

test('normalizeVerificationStatus: valid/catch-all accepted, everything else unknown', () => {
  assert.equal(normalizeVerificationStatus('valid'), 'valid');
  assert.equal(normalizeVerificationStatus('catch-all'), 'valid');
  assert.equal(normalizeVerificationStatus('Catch-All'), 'valid');
  assert.equal(normalizeVerificationStatus('unknown'), 'unknown');
  assert.equal(normalizeVerificationStatus(''), 'unknown');
});

test('isConfigured: true only for a non-empty key', () => {
  assert.equal(isConfigured('abc'), true);
  assert.equal(isConfigured(''), false);
  assert.equal(isConfigured(null), false);
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured('   '), false);
});

/* ------------------------- provider dispatch ------------------------- */

test('createContactClient: defaults to the agentdata provider', () => {
  const client = createContactClient({});
  assert.equal(client.provider, 'agentdata');
});

test('createContactClient: respects an explicit provider option', () => {
  assert.equal(createContactClient({ provider: 'hunter' }).provider, 'hunter');
  assert.equal(createContactClient({ provider: 'agentdata' }).provider, 'agentdata');
  assert.equal(createContactClient({ provider: 'Hunter' }).provider, 'hunter', 'provider names normalize');
});

test('createContactClient: unknown provider throws a fatal error', () => {
  assert.throws(
    () => createContactClient({ provider: 'bogus' }),
    (err) => err.fatal === true && /unknown provider/.test(err.message),
  );
});

test('createContactClient: reads the ENRICHMENT_PROVIDER default from the environment', () => {
  const previous = process.env.ENRICHMENT_PROVIDER;
  try {
    process.env.ENRICHMENT_PROVIDER = 'hunter';
    assert.equal(createContactClient({}).provider, 'hunter');
    process.env.ENRICHMENT_PROVIDER = 'bogus';
    assert.throws(() => createContactClient({}), (err) => err.fatal === true);
  } finally {
    if (previous === undefined) delete process.env.ENRICHMENT_PROVIDER;
    else process.env.ENRICHMENT_PROVIDER = previous;
  }
});

test('createAgentDataClient: falls back to AGENTDATA_API_KEY from the environment', () => {
  const previous = process.env.AGENTDATA_API_KEY;
  try {
    process.env.AGENTDATA_API_KEY = 'env-key';
    const client = createAgentDataClient({});
    assert.equal(client.isConfigured(), true);
    const before = createAgentDataClient({ apiKey: '' });
    assert.equal(before.isConfigured(), true, 'explicitly-empty falls back to env');
  } finally {
    if (previous === undefined) delete process.env.AGENTDATA_API_KEY;
    else process.env.AGENTDATA_API_KEY = previous;
  }
});

/* ------------------------- AgentData client ------------------------- */

test('agentdata: no key is a fatal not-configured error before any transport call', async () => {
  let called = false;
  const previous = process.env.AGENTDATA_API_KEY;
  try {
    delete process.env.AGENTDATA_API_KEY;
    const client = createAgentDataClient({
      apiKey: '',
      transport: async () => {
        called = true;
        return { status: 200, body: { emails: [] } };
      },
    });
    await assert.rejects(
      client.domainSearch('example.com'),
      (err) => err.fatal === true && err.reason === AGENTDATA_NOT_CONFIGURED,
    );
    assert.equal(called, false, 'transport must never be invoked without a key');
  } finally {
    if (previous === undefined) delete process.env.AGENTDATA_API_KEY;
    else process.env.AGENTDATA_API_KEY = previous;
  }
});

test('agentdata: no injected transport is a non-fatal transport-unavailable error', async () => {
  const client = createAgentDataClient({ apiKey: 'k' });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === AGENTDATA_TRANSPORT_UNAVAILABLE,
  );
});

test('agentdata: 200 parses the response through parseAgentDataDomainSearch', async () => {
  const client = createAgentDataClient({
    apiKey: 'k',
    transport: transportFor([{ status: 200, body: { emails: [agentDataItem('gina@agentx.example.com', 97, 'valid', { first: 'Gina', last: 'Merri' })] } }]),
  });
  const result = await client.domainSearch('agentx.example.com');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'agentdata');
  assert.equal(result.creditsUsed, 1);
  assert.equal(result.emails[0].email, 'gina@agentx.example.com');
  assert.equal(result.emails[0].verification_status, 'valid');
});

test('agentdata: sends the API key as a Bearer header and never leaks it in errors', async () => {
  const aware = transportAware({ queue: [{ status: 401, body: {} }] });
  const client = createAgentDataClient({ apiKey: 'SUPER-SECRET-KEY', transport: aware.transport });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => {
      assert.equal(err.fatal, true);
      assert.equal(err.reason, AGENTDATA_AUTH_FAILED);
      assert.equal(err.message.includes('SUPER-SECRET-KEY'), false, 'key must not leak into the message');
      return true;
    },
  );
  assert.ok(aware.calls.length >= 1, 'transport invoked');
  assert.equal(aware.calls[0].options.headers.Authorization, 'Bearer SUPER-SECRET-KEY');
});

test('agentdata: 401 and 403 are fatal and are never retried', async () => {
  let calls = 0;
  const client = createAgentDataClient({
    apiKey: 'k',
    transport: async () => {
      calls += 1;
      return { status: 401, body: {} };
    },
  });
  await assert.rejects(client.domainSearch('example.com'), (err) => err.fatal === true && err.status === 401);
  assert.equal(calls, 1);
});

test('agentdata: 429 then 200 retries on the injectable backoff schedule and succeeds', async () => {
  const sleeps = [];
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 0,
    retryDelays: [10, 20, 30],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    transport: transportFor([
      { status: 429, body: {} },
      { status: 200, body: { emails: [agentDataItem('ada@retry.example.com', 95, 'valid', { first: 'Ada', last: 'Lovelace' })] } },
    ]),
  });
  const result = await client.domainSearch('retry.example.com');
  assert.equal(result.ok, true);
  assert.equal(result.emails.length, 1);
  assert.deepEqual(sleeps, [10]);
});

test('agentdata: 500 then 503 then 200 retries twice and succeeds', async () => {
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 0,
    retryDelays: [10, 20],
    sleep: async () => {},
    transport: transportFor([
      { status: 500, body: {} },
      { status: 503, body: {} },
      { status: 200, body: { emails: [] } },
    ]),
  });
  const result = await client.domainSearch('retry.example.com');
  assert.equal(result.ok, true);
});

test('agentdata: exhausted 429 is a non-fatal rate-limit error', async () => {
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 0,
    maxRetries: 2,
    retryDelays: [10, 10, 10],
    sleep: async () => {},
    transport: transportFor([{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]),
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === AGENTDATA_RATE_LIMITED && err.status === 429,
  );
});

test('agentdata: exhausted 500 is a non-fatal server-error error', async () => {
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 0,
    maxRetries: 1,
    retryDelays: [10, 10],
    sleep: async () => {},
    transport: transportFor([{ status: 500, body: {} }, { status: 500, body: {} }]),
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === AGENTDATA_SERVER_ERROR && err.status === 500,
  );
});

test('agentdata: other 4xx codes return an empty zero-credit result and are not retried', async () => {
  let calls = 0;
  const client = createAgentDataClient({
    apiKey: 'k',
    maxRetries: 3,
    transport: async () => {
      calls += 1;
      return { status: 404, body: {} };
    },
  });
  const result = await client.domainSearch('gone.example.com');
  assert.equal(calls, 1, '4xx is terminal, not retried');
  assert.deepEqual(result, { ok: true, emails: [], source: 'agentdata', creditsUsed: 0 });
});

test('agentdata: transport throw is retried then reported as a network error', async () => {
  const sleeps = [];
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 0,
    maxRetries: 1,
    retryDelays: [10, 10],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    transport: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === AGENTDATA_NETWORK_ERROR && err.status == null,
  );
  assert.equal(sleeps.length, 1, 'backoff happened between retries');
});

test('agentdata: zero-status bodyless response is an unknown-response error', async () => {
  const client = createAgentDataClient({
    apiKey: 'k',
    transport: async () => ({ status: 0, body: null }),
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === AGENTDATA_UNKNOWN_RESPONSE,
  );
});

test('agentdata: paces requests at the minimum spacing across calls of the same client', async () => {
  const times = [1000, 1200];
  const state = { index: 0 };
  const sleeps = [];
  const client = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: AGENTDATA_MIN_PACING_MS,
    clock: () => times[state.index],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    transport: async () => {
      state.index += 1;
      return { status: 200, body: { emails: [] } };
    },
  });
  await client.domainSearch('one.example.com');
  await client.domainSearch('two.example.com');
  assert.deepEqual(sleeps, [], 'gap of 200 already met -> no sleep on the second call');
  const clamped = [1000, 1050];
  const state2 = { index: 0 };
  const sleeps2 = [];
  const client2 = createAgentDataClient({
    apiKey: 'k',
    minPacingMs: 200,
    clock: () => clamped[state2.index],
    sleep: async (ms) => {
      sleeps2.push(ms);
    },
    transport: async () => {
      state2.index += 1;
      return { status: 200, body: { emails: [] } };
    },
  });
  await client2.domainSearch('one.example.com');
  await client2.domainSearch('two.example.com');
  assert.deepEqual(sleeps2, [150], '50ms elapsed into the 200ms window -> wait 150ms');
});

/* ------------------------- Hunter client ------------------------- */

test('hunter: no key is a fatal not-configured error before any transport call', async () => {
  let called = false;
  const previous = process.env.HUNTER_API_KEY;
  try {
    delete process.env.HUNTER_API_KEY;
    const client = createHunterClient({
      apiKey: '',
      transport: async () => {
        called = true;
        return { status: 200, body: searchBody([]) };
      },
    });
    assert.equal(client.isConfigured(), false);
    await assert.rejects(
      client.domainSearch('example.com'),
      (err) => err.fatal === true && err.reason === HUNTER_NOT_CONFIGURED,
    );
    assert.equal(called, false, 'transport must never be invoked without a key');
  } finally {
    if (previous === undefined) delete process.env.HUNTER_API_KEY;
    else process.env.HUNTER_API_KEY = previous;
  }
});

test('hunter: no injected transport is a non-fatal transport-unavailable error', async () => {
  const client = createHunterClient({ apiKey: 'k' });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === HUNTER_TRANSPORT_UNAVAILABLE,
  );
});

test('hunter: 200 parses the body into the canonical shape', async () => {
  const client = createHunterClient({
    apiKey: 'k',
    transport: transportFor([{ status: 200, body: searchBody([hunterEmail('ada@example.com', 98, 'valid')]) }]),
  });
  const result = await client.domainSearch('example.com');
  assert.equal(result.ok, true);
  assert.equal(result.source, 'hunter');
  assert.equal(result.creditsUsed, 1);
  assert.equal(result.emails[0].email, 'ada@example.com');
  assert.equal(result.emails[0].verification_status, 'valid');
  assert.equal(result.emails[0].confidence, 98);
});

test('hunter: 401 and 403 are fatal and are not retried', async () => {
  let calls = 0;
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 3,
    transport: async () => {
      calls += 1;
      return { status: 403, body: {} };
    },
  });
  await assert.rejects(client.domainSearch('example.com'), (err) => err.fatal === true && err.status === 403);
  assert.equal(calls, 1);
});

test('hunter: 429 then 200 retries and succeeds', async () => {
  const sleeps = [];
  const client = createHunterClient({
    apiKey: 'k',
    minDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    transport: transportFor([
      { status: 429, body: {} },
      { status: 200, body: searchBody([hunterEmail('ada@example.com', 90, 'valid')]) },
    ]),
  });
  const result = await client.domainSearch('example.com');
  assert.equal(result.ok, true);
  assert.equal(result.emails.length, 1);
  assert.deepEqual(sleeps, [10]);
});

test('hunter: exhausted 429 is a non-fatal rate-limit error', async () => {
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 2,
    minDelayMs: 5,
    sleep: async () => {},
    transport: transportFor([{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]),
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === HUNTER_RATE_LIMITED && err.status === 429,
  );
});

test('hunter: exhausted 500 is a non-fatal server-error error', async () => {
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 1,
    minDelayMs: 5,
    sleep: async () => {},
    transport: transportFor([{ status: 500, body: {} }, { status: 500, body: {} }]),
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === HUNTER_SERVER_ERROR && err.status === 500,
  );
});

test('hunter: other 4xx codes return an empty zero-credit result and are not retried', async () => {
  let calls = 0;
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 3,
    transport: async () => {
      calls += 1;
      return { status: 404, body: {} };
    },
  });
  const result = await client.domainSearch('gone.example.com');
  assert.equal(calls, 1, '4xx is terminal, not retried');
  assert.deepEqual(result, { ok: true, emails: [], source: 'hunter', creditsUsed: 0 });
});

test('hunter: transport throw is retried then reported as a network error', async () => {
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 1,
    minDelayMs: 5,
    sleep: async () => {},
    transport: async () => {
      throw new Error('ECONNRESET');
    },
  });
  await assert.rejects(
    client.domainSearch('example.com'),
    (err) => err.fatal === false && err.reason === HUNTER_NETWORK_ERROR && err.status == null,
  );
});

test('hunter: retries honor `maxRetries` for identical server errors then give up', async () => {
  let calls = 0;
  const client = createHunterClient({
    apiKey: 'k',
    maxRetries: 2,
    minDelayMs: 5,
    sleep: async () => {},
    transport: async () => {
      calls += 1;
      return { status: 503, body: {} };
    },
  });
  await assert.rejects(client.domainSearch('example.com'), (err) => err.fatal === false && err.reason === HUNTER_SERVER_ERROR);
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});