'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const {
  GoogleSheetsClient,
  GoogleSheetsError,
  quotedRange,
  columnLetter,
  cellRange,
  normalizeSpreadsheetId,
} = require('../src/google-sheets-client');

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const EXAMPLE_ID = 'AbCdEf123456-_AbCdEf123456-_Ab';

function makeClient() {
  return new GoogleSheetsClient({ spreadsheetId: EXAMPLE_ID, accessToken: 'test-token' });
}

test('updateRow: issues PUT to values/range with valueInputOption=USER_ENTERED', async () => {
  const captured = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    captured.push({ url, init });
    return new Response(JSON.stringify({ updatedRange: `'Outreach Log'!U7:V7`, updatedRows: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const client = makeClient();
  const result = await client.updateRow('Outreach Log', 'U7:V7', ['sent', 'msg_123']);

  assert.equal(captured.length, 1);
  const { url, init } = captured[0];
  const expectedRange = encodeURIComponent(quotedRange('Outreach Log', 'U7:V7'));
  assert.equal(url, `${SHEETS_API}/${EXAMPLE_ID}/values/${expectedRange}?valueInputOption=USER_ENTERED`);
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, 'Bearer test-token');
});

test('updateRow: sends { values: [values] } in the body', async () => {
  let body = null;
  mock.method(globalThis, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ updatedRows: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const client = makeClient();
  await client.updateRow('Outreach Log', 'U7:V7', ['sent', 'msg_123']);
  assert.deepEqual(body, { values: [['sent', 'msg_123']] });
});

test('updateRow: returns the parsed JSON response', async () => {
  const responseJson = { updatedRange: `'Outreach Log'!U7:V7`, updatedRows: 1, updatedColumns: 2 };
  mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

  const client = makeClient();
  const result = await client.updateRow('Outreach Log', 'U7:V7', ['sent', 'msg_123']);
  assert.deepEqual(result, responseJson);
});

test('columnLetter: 0 -> A, 25 -> Z, 26 -> AA, 701 -> ZZ, 702 -> AAA', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
  assert.equal(columnLetter(702), 'AAA');
});

test('cellRange composes a single-row range from row + column letter indices', () => {
  assert.equal(cellRange(7, 20, 21), 'U7:V7');
  assert.equal(cellRange(7, 0, 21), 'A7:V7');
  assert.equal(cellRange(7, 20), 'U7:U7');
});

test('normalizeSpreadsheetId still accepts a bare id (updateRow round-trip helper sanity)', () => {
  assert.equal(normalizeSpreadsheetId(EXAMPLE_ID), EXAMPLE_ID);
});

test('updateRow: response parse failure still surfaces via _request as GoogleSheetsError', async () => {
  mock.method(globalThis, 'fetch', async () =>
    new Response('<html>gateway error</html>', { status: 502 }),
  );

  const client = makeClient();
  await assert.rejects(
    () => client.updateRow('Outreach Log', 'U7:V7', ['sent']),
    (err) => err instanceof GoogleSheetsError && err.status === 502,
  );
});