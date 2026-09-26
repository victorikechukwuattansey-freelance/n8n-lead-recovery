import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost, onRequestGet } from '../functions/unsubscribe.js';

const POST_URL = 'https://www.viaaiautomation.work.gd/unsubscribe';

function postRequest(body, headers = {}) {
  return new Request(POST_URL, {
    method: 'POST',
    body,
    headers,
  });
}

function kvSpy() {
  const calls = [];
  return {
    calls,
    logs: { put: async (key, value) => calls.push([key, value]) },
  };
}

test('POST with valid body returns 200 Unsubscribed', async () => {
  const req = postRequest('List-Unsubscribe=One-Click');
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Unsubscribed');
});

test('POST with missing or malformed body returns 400', async () => {
  const req = postRequest('something else');
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'Invalid unsubscribe request');
});

test('POST with no KV binding still returns 200 and logs to console', async (t) => {
  let logged = 0;
  t.mock.method(console, 'log', () => {
    logged += 1;
  });
  const req = postRequest('List-Unsubscribe=One-Click');
  const res = await onRequestPost({ request: req, env: {} });
  assert.equal(res.status, 200);
  assert.equal(logged, 1);
});

test('POST with KV binding writes exactly one KV record parses as JSON', async () => {
  const spy = kvSpy();
  const req = postRequest('List-Unsubscribe=One-Click');
  const res = await onRequestPost({ request: req, env: { UNSUB_LOGS: spy.logs } });
  assert.equal(res.status, 200);
  assert.equal(spy.calls.length, 1);
  const [key, value] = spy.calls[0];
  assert.match(key, /^unsub:[0-9]+:[a-z0-9]{6}$/);
  const record = JSON.parse(value);
  assert.ok(record.ts);
  assert.equal(record.ip, '');
  assert.equal(record.ua, '');
  assert.equal(record.url, POST_URL);
});

test('POST captures cf-connecting-ip from request headers', async () => {
  const spy = kvSpy();
  const req = postRequest('List-Unsubscribe=One-Click', {
    'cf-connecting-ip': '203.0.113.9',
    'user-agent': 'Mozilla/5.0 TestAgent',
  });
  await onRequestPost({ request: req, env: { UNSUB_LOGS: spy.logs } });
  const record = JSON.parse(spy.calls[0][1]);
  assert.equal(record.ip, '203.0.113.9');
  assert.equal(record.ua, 'Mozilla/5.0 TestAgent');
});

test('GET returns 200 with POST-only message', async () => {
  const res = await onRequestGet();
  assert.equal(res.status, 200);
  assert.match(await res.text(), /POST only/);
});

test('GET never writes to KV', async () => {
  const spy = kvSpy();
  const req = postRequest('List-Unsubscribe=One-Click');
  await onRequestGet({ request: req, env: { UNSUB_LOGS: spy.logs } });
  assert.equal(spy.calls.length, 0);
});