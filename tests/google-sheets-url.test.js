'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GoogleSheetsClient, GoogleSheetsError, quotedRange, normalizeSpreadsheetId } = require('../src/google-sheets-client');
const { clientFor } = require('../src/response-interpretation-live-runner');

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const EXAMPLE_ID = 'AbCdEf123456-_AbCdEf123456-_Ab';
const EXAMPLE_URL = `https://docs.google.com/spreadsheets/d/${EXAMPLE_ID}/edit#gid=0`;
const RANGE = "'Response Log'!A1:AZ";
const ENCODED_RANGE = encodeURIComponent(RANGE);

test('urls: normalizeSpreadsheetId passes a bare id through unchanged', () => {
  assert.equal(normalizeSpreadsheetId(EXAMPLE_ID), EXAMPLE_ID);
});

test('urls: normalizeSpreadsheetId trims surrounding whitespace on a bare id', () => {
  assert.equal(normalizeSpreadsheetId(`  ${EXAMPLE_ID}  `), EXAMPLE_ID);
});

test('urls: normalizeSpreadsheetId extracts id from a full /edit URL', () => {
  assert.equal(
    normalizeSpreadsheetId(`https://docs.google.com/spreadsheets/d/${EXAMPLE_ID}/edit`),
    EXAMPLE_ID,
  );
});

test('urls: normalizeSpreadsheetId extracts id from a URL with no suffix', () => {
  assert.equal(
    normalizeSpreadsheetId(`https://docs.google.com/spreadsheets/d/${EXAMPLE_ID}`),
    EXAMPLE_ID,
  );
});

test('urls: normalizeSpreadsheetId extracts id from a URL with a #gid= fragment', () => {
  assert.equal(
    normalizeSpreadsheetId(`https://docs.google.com/spreadsheets/d/${EXAMPLE_ID}#gid=0`),
    EXAMPLE_ID,
  );
});

test('urls: normalizeSpreadsheetId rejects empty and invalid inputs', () => {
  for (const bad of ['', '   ', undefined, null, 'https://example.com/foo', 'not a sheet id!!', '123.45']) {
    assert.throws(
      () => normalizeSpreadsheetId(bad),
      (err) => err instanceof GoogleSheetsError && err.status === 400,
      `expected GoogleSheetsError for input ${JSON.stringify(bad)}`,
    );
  }
});

test('urls: quotedRange emits "!" separator, not "."', () => {
  assert.equal(quotedRange('Response Log'), "'Response Log'!A1:AZ");
  assert.ok(!quotedRange('Response Log').includes('.A1'));
});

test('urls: quotedRange preserves the current range span (A1:AZ)', () => {
  assert.equal(quotedRange('Response Log'), "'Response Log'!A1:AZ");
  assert.equal(quotedRange('Response Log', 'A1:AZ'), "'Response Log'!A1:AZ");
});

test('urls: quotedRange escapes single quotes inside tab names', () => {
  assert.equal(quotedRange("It's Done"), "'It''s Done'!A1:AZ");
});

test('urls: client constructed with a full URL normalizes spreadsheetId to the bare id', () => {
  const client = new GoogleSheetsClient({ spreadsheetId: EXAMPLE_URL, accessToken: 't' });
  assert.equal(client.spreadsheetId, EXAMPLE_ID);
});

test('urls: client constructed with a bare id keeps it unchanged', () => {
  const client = new GoogleSheetsClient({ spreadsheetId: EXAMPLE_ID, accessToken: 't' });
  assert.equal(client.spreadsheetId, EXAMPLE_ID);
});

test('urls: runner clientFor with --allow-non-pinned-sheet URL builds a bare-id values URL (offline)', async () => {
  const client = await clientFor({
    GOOGLE_SHEET_ID: EXAMPLE_URL,
    GOOGLE_ACCESS_TOKEN: 'test-token',
  });
  assert.ok(client, 'clientFor should return a client for a token-authed non-pinned URL');
  assert.equal(client.spreadsheetId, EXAMPLE_ID);

  const captured = [];
  client._request = async (init) => {
    captured.push(init.url);
    return { values: [['a']] };
  };

  const rows = await client.listRows('Response Log');
  assert.ok(Array.isArray(rows), 'listRows resolves rows offline');
  assert.equal(captured[0], `${SHEETS_API}/${EXAMPLE_ID}/values/${ENCODED_RANGE}`);
});

test('urls: runner client appendRows builds a bare-id :append URL (offline)', async () => {
  const client = await clientFor({
    GOOGLE_SHEET_ID: EXAMPLE_URL,
    GOOGLE_ACCESS_TOKEN: 'test-token',
  });
  assert.equal(client.spreadsheetId, EXAMPLE_ID);

  let appendUrl = '';
  client._request = async (init) => {
    appendUrl = init.url;
    return { updates: { updatedRange: RANGE } };
  };

  await client.appendRows('Response Log', [['a']]);
  assert.ok(appendUrl.startsWith(`${SHEETS_API}/${EXAMPLE_ID}/values/${ENCODED_RANGE}:append?`));
  assert.ok(appendUrl.includes('valueInputOption=USER_ENTERED'));
});

test('urls: regression — the captured malformed URL pattern cannot be produced', async () => {
  const client = await clientFor({
    GOOGLE_SHEET_ID: EXAMPLE_URL,
    GOOGLE_ACCESS_TOKEN: 'test-token',
  });
  let readUrl = '';
  client._request = async (init) => {
    readUrl = init.url;
    return { values: [] };
  };
  await client.listRows('Response Log');

  assert.ok(!readUrl.includes('/spreadsheets/https://'), 'no nested full URL inside the path');
  assert.ok(!readUrl.includes('docs.google.com'), 'no docs.google.com URL embedded after the API root');
  assert.ok(!readUrl.includes("'.A1"), 'no "." separator between tab name and range');
  assert.equal(readUrl, `${SHEETS_API}/${EXAMPLE_ID}/values/${ENCODED_RANGE}`);
});