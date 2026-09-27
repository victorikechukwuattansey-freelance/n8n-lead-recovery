"use strict";

const {
  buildQueueFromSheets,
  APPROVED_COLUMNS,
  OUTREACH_COLUMNS,
} = require("../src/queue");
const { GoogleSheetsClient } = require("../src/google-sheets-client");
const {
  executeFromSheets,
  MODE,
  EXECUTION_STATUS,
} = require("../src/execution");

(async () => {
  if (!process.env.GOOGLE_SHEET_ID) {
    console.error("GOOGLE_SHEET_ID is required");
    process.exit(3);
  }
  if (
    !process.env.GOOGLE_ACCESS_TOKEN &&
    !process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ) {
    console.error(
      "GOOGLE_ACCESS_TOKEN or GOOGLE_SERVICE_ACCOUNT_JSON is required",
    );
    process.exit(3);
  }

  const client = GoogleSheetsClient.fromEnv(process.env);

  const toObjects = (cols, rows) =>
    rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));

  const approvedRaw = (await client.listRows("Approved Outreach")).slice(1); // drop header row
  const outreachRaw = (await client.listRows("Outreach Log")).slice(1); // drop header row

  console.log("[debug] approvedRaw rows:", approvedRaw.length);
  console.log("[debug] outreachRaw rows:", outreachRaw.length);

  const approvedRows = toObjects(APPROVED_COLUMNS, approvedRaw);
  const outreachRows = toObjects(OUTREACH_COLUMNS, outreachRaw);

  const result = await executeFromSheets({
    approvedRows,
    outreachRows,
    mode: MODE.DRY_RUN,
    provider: null,
    runId: "EXEC-" + Date.now(),
    now: new Date().toISOString(),
  });

  console.log("[debug] result keys:", Object.keys(result));

  const results = result.results || result.items || result.queue || [];
  console.log("--- execution projection (DRY_RUN) ---");
  for (const r of results) {
    console.log(
      JSON.stringify({
        lead_id: r.lead_id ?? r.leadId ?? r.lead,
        status: r.status,
        reason: r.reason,
        channel: r.channel,
        to: r.payload?.phone ?? r.payload?.email ?? null,
        detail: r.detail,
      }),
    );
  }

  console.log("--- report ---");
  console.log(JSON.stringify(result.report ?? {}, null, 2));

  const r = result.report || {};
  const mustBeZero = [
    "executed_attempted",
    "executed_succeeded",
    "executed_failed",
    "log_rows_written",
    "provider_calls",
    "duplicate_suppressed",
    "executed_rejected",
  ];
  for (const k of mustBeZero) {
    if (r[k] !== 0) {
      console.error(`ASSERT FAILED: report.${k} = ${r[k]}, expected 0`);
      process.exit(1);
    }
  }
  if (r.mode !== "DRY_RUN") {
    console.error(`ASSERT FAILED: mode = ${r.mode}`);
    process.exit(1);
  }
  const accounted =
    r.executed_attempted +
    r.executed_skipped +
    r.executed_rejected +
    r.duplicate_suppressed;
  if (accounted !== r.queue_total) {
    console.error(
      `ASSERT FAILED: buckets sum to ${accounted}, queue_total = ${r.queue_total}`,
    );
    process.exit(1);
  }

  const logRows = result.logRows || [];
  if (logRows.length !== 0) {
    console.error("ASSERT FAILED: expected 0 log rows, got " + logRows.length);
    process.exit(1);
  }
  if (results.some((r) => r.status === EXECUTION_STATUS.SUCCEEDED)) {
    console.error("ASSERT FAILED: SUCCEEDED in DRY_RUN");
    process.exit(1);
  }
  if (results.length && !results.every((r) => r.reason === "DRY_RUN")) {
    console.error("ASSERT FAILED: not all reasons are DRY_RUN");
    process.exit(1);
  }
  console.log("OK: " + results.length + " item(s) gated, 0 sent, 0 logged.");
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
