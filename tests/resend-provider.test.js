'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { providerFor, PROVIDER_MODE, NOT_CONFIGURED_PROVIDER } = require('../src/provider');
const { ResendAdapter } = require('../src/providers/resend');

const API_URL = 'https://api.resend.com/emails';

const BASE_PAYLOAD = {
  lead_id: 'LEAD-001',
  outreach_id: 'EX-LEAD-001-email',
  from: 'sender@example.com',
  to: 'lead@example.com',
  subject: 'Quick question',
  text: 'Hello',
};

function fakeResponse({ status, body, headers = {} }) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

test('successful send maps response id to provider_message_id', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.deepEqual(
    {
      success: result.success,
      provider_status: result.provider_status,
      provider_message_id: result.provider_message_id,
    },
    { success: true, provider_status: 'SENT', provider_message_id: 're_test_123' }
  );
  assert.equal(calls.length, 1);
});

test('Idempotent-Replayed true header is captured', async () => {
  const fetchImpl = async () =>
    fakeResponse({ status: 200, body: { id: 're_test_123' }, headers: { 'Idempotent-Replayed': 'true' } });
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, true);
  assert.equal(result.idempotent_replayed, true);
});

test('Idempotent-Replayed absent defaults to false', async () => {
  const fetchImpl = async () => fakeResponse({ status: 200, body: { id: 're_test_123' } });
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.idempotent_replayed, false);
});

test('channel gate rejects non-email without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse({ status: 200, body: { id: 'x' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const result = await adapter.execute('call', BASE_PAYLOAD);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, 'REJECTED_CHANNEL');
  assert.equal(called, false);
});

test('payload gate rejects missing to without calling fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse({ status: 200, body: { id: 'x' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const payload = { ...BASE_PAYLOAD };
  delete payload.to;
  const result = await adapter.execute('email', payload);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, 'REJECTED_PAYLOAD');
  assert.equal(called, false);
});

test('400 from Resend fails immediately with no retry', async () => {
  const calls = [];
  const fetchImpl = async () => {
    calls.push(1);
    return fakeResponse({ status: 400, body: { message: 'bad request' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, '400');
  assert.equal(calls.length, 1);
});

test('429 then 200 succeeds via one retry', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1
      ? fakeResponse({ status: 429, body: { message: 'rate limited' } })
      : fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, backoffMs: 1, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, true);
  assert.equal(result.provider_message_id, 're_test_123');
  assert.equal(call, 2);
});

test('500 twice fails after exactly two calls', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return fakeResponse({ status: 500, body: { message: 'oops' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, backoffMs: 1, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, '500');
  assert.equal(call, 2);
});

test('Idempotency-Key header is EX-<lead_id>-<channel> and stable across retries', async () => {
  const keys = [];
  let call = 0;
  const fetchImpl = async (_url, opts) => {
    call += 1;
    keys.push(opts.headers['Idempotency-Key']);
    return call === 1
      ? fakeResponse({ status: 429, body: { message: 'rate limited' } })
      : fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, backoffMs: 1, pacingMs: 0 });
  await adapter.execute('email', { ...BASE_PAYLOAD, outreach_id: 'EX-LEAD-001-email' });
  assert.deepEqual(keys, ['EX-LEAD-001-email', 'EX-LEAD-001-email']);
});

test('List-Unsubscribe headers sent in body when both URL and mailto are set', async () => {
  const requests = [];
  const fetchImpl = async (_url, opts) => {
    requests.push(opts);
    return fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({
    apiKey: 're_test_key',
    fetchImpl,
    pacingMs: 0,
    unsubscribeUrl: 'https://example.com/unsub',
    unsubscribeMailto: 'unsubscribe@example.com',
  });
  await adapter.execute('email', BASE_PAYLOAD);
  const body = JSON.parse(requests[0].body);
  assert.equal(
    body.headers['List-Unsubscribe'],
    '<https://example.com/unsub>, <mailto:unsubscribe@example.com>'
  );
  assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(requests[0].headers['List-Unsubscribe'], undefined);
});

test('List-Unsubscribe-Post is omitted in body when only mailto is set', async () => {
  const requests = [];
  const fetchImpl = async (_url, opts) => {
    requests.push(opts);
    return fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({
    apiKey: 're_test_key',
    fetchImpl,
    pacingMs: 0,
    unsubscribeMailto: 'unsubscribe@example.com',
  });
  await adapter.execute('email', BASE_PAYLOAD);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.headers['List-Unsubscribe'], '<mailto:unsubscribe@example.com>');
  assert.equal(body.headers['List-Unsubscribe-Post'], undefined);
});

test('no List-Unsubscribe headers field when neither option is set', async () => {
  const requests = [];
  const fetchImpl = async (_url, opts) => {
    requests.push(opts);
    return fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, pacingMs: 0 });
  await adapter.execute('email', BASE_PAYLOAD);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.headers, undefined);
});

test('List-Unsubscribe is never sent as an HTTP request header', async () => {
  const requests = [];
  const fetchImpl = async (_url, opts) => {
    requests.push(opts);
    return fakeResponse({ status: 200, body: { id: 're_test_123' } });
  };
  const adapter = new ResendAdapter({
    apiKey: 're_test_key',
    fetchImpl,
    pacingMs: 0,
    unsubscribeUrl: 'https://example.com/unsub',
    unsubscribeMailto: 'unsubscribe@example.com',
  });
  await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(requests[0].headers['List-Unsubscribe'], undefined);
  assert.equal(requests[0].headers['List-Unsubscribe-Post'], undefined);
});

test('network error retries once then fails', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    throw new Error('ECONNRESET');
  };
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, backoffMs: 1, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, 'NETWORK_ERROR');
  assert.equal(call, 2);
});

test('timeout aborts and fails (shortened timeout override)', async () => {
  let call = 0;
  const fetchImpl = (_url, opts) =>
    new Promise((_resolve, reject) => {
      call += 1;
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const adapter = new ResendAdapter({ apiKey: 're_test_key', fetchImpl, timeoutMs: 30, backoffMs: 1, pacingMs: 0 });
  const result = await adapter.execute('email', BASE_PAYLOAD);
  assert.equal(result.success, false);
  assert.equal(result.provider_status, 'TIMEOUT');
  assert.equal(call, 2);
});

test('providerFor(REAL) returns the Resend adapter when RESEND_API_KEY is set', () => {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  try {
    const provider = providerFor(PROVIDER_MODE.REAL);
    assert.ok(provider instanceof ResendAdapter);
    assert.equal(provider.isConfigured(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previous;
    }
  }
});

test('providerFor(REAL) returns NOT_CONFIGURED sentinel when env unset', () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const provider = providerFor(PROVIDER_MODE.REAL);
    assert.equal(provider, NOT_CONFIGURED_PROVIDER);
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previous;
    }
  }
});

test('providerFor(DRY_RUN) is unchanged (NOT_CONFIGURED sentinel)', () => {
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 're_test_key';
  try {
    const provider = providerFor('DRY_RUN');
    assert.equal(provider, NOT_CONFIGURED_PROVIDER);
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = previous;
    }
  }
});