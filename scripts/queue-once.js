'use strict';

const { buildQueueFromSheets, APPROVED_COLUMNS, OUTREACH_COLUMNS } = require('../src/queue');
const { GoogleSheetsClient } = require('../src/google-sheets-client');

(async () => {
  if (!process.env.GOOGLE_SHEET_ID) {
    console.error('GOOGLE_SHEET_ID is required');
    process.exit(3);
  }
  if (!process.env.GOOGLE_ACCESS_TOKEN && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.error('GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON is required');
    process.exit(3);
  }

  const client = GoogleSheetsClient.fromEnv(process.env);

  const toObjects = (cols, rows) =>
    rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ''])));

  const approvedRaw = (await client.listRows('Approved Outreach')).slice(1); // drop header row
  const outreachRaw = (await client.listRows('Outreach Log')).slice(1); // drop header row

  console.log('[debug] approvedRaw rows:', approvedRaw.length);
  console.log('[debug] outreachRaw rows:', outreachRaw.length);

  const approvedRows = toObjects(APPROVED_COLUMNS, approvedRaw);
  const outreachRows = toObjects(OUTREACH_COLUMNS, outreachRaw);

  const result = buildQueueFromSheets({
    approvedRows,
    outreachRows,
    approvedError: '',
    outreachError: '',
    runId: 'QUEUE-' + Date.now(),
    now: new Date().toISOString(),
  });

  console.log('[debug] result keys:', Object.keys(result));

  console.log(JSON.stringify({
    status: result.status,
    queue_total: result.queue_total,
    ready_count: result.ready_count,
    call_ready_count: result.call_ready_count,
    email_ready_count: result.email_ready_count,
    not_ready_count: result.not_ready_count,
    blocked_count: result.blocked_count,
    exception_count: result.exception_count,
    queue: (result.queue || []).map((q) => ({
      lead_id: q.lead_id,
      business_name: q.business_name,
      channel: q.available_channel,
      readiness: q.readiness_status,
      priority: q.priority,
      reason: q.reason,
    })),
    exceptions: result.exceptions,
  }, null, 2));
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
