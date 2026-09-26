'use strict';

/* Response Interpretation V1 — Phase 5 live runner.
 *
 * Validates the SHIPPED Response-Interpretation V1 workflow against the
 * canonical Response Interpretation V1 engine using the repository's
 * namespace-guarded live-harness conventions (mirrors
 * scripts/run-response-reconciliation-live.js).
 *
 * Live-boundary rules this module enforces:
 *  - No secrets or credentials are accepted as code; runtime config comes only
 *    from env (--no-interactive) or interactive prompts.
 *  - Seeding/cleanup touch ONLY the Response Log tab and ONLY rows whose
 *    lead_id belongs to the Phase 5 namespace (TEST-RESP-INT-LIVE-<hex tag>).
 *  - The reconciliation artifact is injected through the workflow's OWN input
 *    boundary (Manual Trigger fields reconciliation_report /
 *    response_log_read_error / reconciliation_read_error) — never by editing
 *    the workflow, never by fs in n8n, never via a new sheets path.
 *  - "Live" output must come from the actual n8n execution; without a
 *    configured n8n API the runner reports NOT_CONFIGURED and prints MANUAL
 *    steps. It NEVER invents, simulates, or fabricates a live PASS.
 *  - The expected output is computed by the frozen canonical engine from the
 *    exact rows this runner projects into the namespace, with fixed Phase 3/4
 *    inputs (interpretation FIXED_NOW), which keeps the comparison
 *    deterministic and reproducible across runs and machines.
 *
 *  Phase 5 revision (2026-09-12): the n8n execution mechanism is now backend-
 *  selectable. cli (default) spawns `docker exec -u node -e
 *  N8N_RUNNERS_BROKER_PORT=<port> <container> n8n execute --id <workflow>` inside
 *  the running n8n container, because the Community REST API cannot trigger
 *  manual-trigger workflows; http keeps the previous POST path for instances that
 *  expose a run endpoint. The CLI's temporary task broker must bind to a port
 *  other than the running server's 5679 (RESP_INT_EXEC_BROKER_PORT).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { RESPONSE_COLUMNS } = require('./response-capture');
const { rowToObject, objectToRow } = require('./schema');
const { reconcileResponses } = require('./response-reconcile');
const { loadResponseInterpretationFixtures } = require('./response-interpretation-fixtures');
const {
  WORKFLOW_NAME,
  ARTIFACT,
  RESPONSE_LOG_SHEET,
  SPREADSHEET_ID,
  EXPECTED_NODES,
  BANNED_NODE_TYPES,
  FIXED_NOW,
  stripRuntime,
  engineBehaviorFor,
  assertWorkflowContract,
  assertCleanSource,
} = require('./response-interpretation-workflow-contract');
const { GoogleSheetsClient } = require('./google-sheets-client');
const { buildScenarioPayload } = require('./response-interpretation-scenario-payloads');
const {
  HARNESS_ARTIFACT,
  HARNESS_WEBHOOK_PATH,
  HARNESS_WEBHOOK_MODE_PRODUCTION,
  HARNESS_WEBHOOK_MODE_TEST,
  HARNESS_WORKFLOW_ID,
  harnessWebhookUrl,
  harnessWorkflowPath,
  checkHarnessContract,
} = require('./response-interpretation-test-harness-contract');

const RESPONSE_TAB = 'Response Log';
const RESPONSE_LEAD_INDEX = 2;

const RESP_INT_LIVE_NAMESPACE = 'TEST-RESP-INT-LIVE';
const RUN_TOKEN_REGEX = /^[0-9a-f]{8,32}$/i;
const RESP_INT_LIVE_NAMESPACE_REGEX = /^TEST-RESP-INT-LIVE-[0-9a-f]{8,32}$/i;
const RESP_INT_LIVE_LEAD_REGEX = /^TEST-RESP-INT-LIVE-[0-9a-f]{8,32}-\d+$/;

const DEFAULT_SCENARIO = 'TEST-RESP-INT-001';
const FIXTURE_REPORT_RUN_ID = 'RESPRECON-LIVE-FIXED';

const SCENARIO_FAILURE_KEYS = [
  'empty',
  'response-log-failure',
  'reconciliation-failure',
  'upstream-incomplete',
  'double-failure',
];

const STAGE_STATUSES = ['PASS', 'FAIL', 'NOT_CONFIGURED', 'SKIPPED', 'CLEANUP_NOT_PERFORMED'];

const SENSITIVE_KEY_RE =
  /(access_?token|refresh_?token|api[_-]?key|secret|password|credential|authorization|private[_-]?key|provider_message_id|response_text|sender|recipient|raw_response|from_?address)/i;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ya29\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
];

const VALID_EXEC_BACKENDS = ['cli', 'http', 'harness'];
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const EXEC_WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BROKER_PORT_RE = /^[0-9]{1,5}$/;
const SERVER_BROKER_PORT = 5679;

function pad3(n) {
  return String(n).padStart(3, '0');
}

function defaultRunToken() {
  return Date.now().toString(16);
}

function runTokenFor(args, env) {
  const explicit = (args && args.runToken) || (env && env.RESP_INT_LIVE_RUN_TOKEN);
  return String(explicit || '').trim() || defaultRunToken();
}

function namespaceFromRunToken(runToken) {
  return `${RESP_INT_LIVE_NAMESPACE}-${String(runToken).trim()}`;
}

function namespaceForArgs(args, env) {
  return namespaceFromRunToken(runTokenFor(args, env));
}

/** Rows whose lead_id column (index) belongs to the given namespace. */
function rowsForNamespace(grid, columns, index, ns) {
  const out = [];
  for (let i = 0; i < grid.length; i += 1) {
    const lead = String(grid[i][index] || '').trim();
    if (lead.startsWith(`${ns}-`)) {
      out.push({ index: i, row: grid[i], obj: rowToObject(grid[i], columns) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Config (env-only, never code)                                       */
/* ------------------------------------------------------------------ */

function readConfig(env) {
  const googlesheetId = String(env.GOOGLE_SHEET_ID || '').trim();
  const accessToken = String(env.GOOGLE_ACCESS_TOKEN || '').trim();
  const serviceAccount = String(env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  const n8nBaseUrl = String(env.N8N_BASE_URL || '').trim().replace(/\/+$/, '');
  const n8nApiKey = String(env.N8N_API_KEY || '').trim();
  const n8nWorkflowId = String(env.N8N_WORKFLOW_ID || '').trim();
  /* Phase 6.5 harness backend — dedicated env vars. RESP_INT_HARNESS_WORKFLOW_ID
   * is REQUIRED and never falls back to N8N_WORKFLOW_ID (the production id must
   * not leak into the test surface). Base URL falls back to N8N_BASE_URL. */
  const harnessBaseUrl = String(env.RESP_INT_HARNESS_BASE_URL || env.N8N_BASE_URL || '').trim().replace(/\/+$/, '');
  const harnessWorkflowId = String(env.RESP_INT_HARNESS_WORKFLOW_ID || '').trim();
  const harnessWebhookPathRaw = String(env.RESP_INT_HARNESS_WEBHOOK_PATH || '').trim();
  const harnessWebhookPath = harnessWebhookPathRaw || HARNESS_WEBHOOK_PATH;
  const harnessWebhookModeRaw = String(env.RESP_INT_HARNESS_WEBHOOK_MODE || '').trim().toLowerCase();
  const harnessWebhookMode = harnessWebhookModeRaw === HARNESS_WEBHOOK_MODE_TEST ? HARNESS_WEBHOOK_MODE_TEST : HARNESS_WEBHOOK_MODE_PRODUCTION;
  const execBackendRaw = String(env.RESP_INT_EXEC_BACKEND || '').trim();
  const execBackend = normalizeExecBackend(execBackendRaw);
  const container = String(env.RESP_INT_EXEC_CONTAINER || '').trim();
  const brokerPort = String(env.RESP_INT_EXEC_BROKER_PORT || '').trim();
  return {
    googlesheetId,
    tab: RESPONSE_LOG_SHEET,
    pinnedSpreadsheetId: SPREADSHEET_ID,
    spreadsheetMatchesPinned: googlesheetId === SPREADSHEET_ID,
    auth: {
      mode: accessToken ? 'token' : serviceAccount ? 'service-account' : 'none',
      ready: !!(accessToken || serviceAccount),
    },
    n8n: {
      baseUrl: n8nBaseUrl || '',
      apiKey: n8nApiKey || '',
      workflowId: n8nWorkflowId || '',
      ready: !!(n8nBaseUrl && n8nApiKey && n8nWorkflowId),
    },
    exec: {
      backend: execBackend,
      backendRaw: execBackendRaw,
      cli: {
        container,
        brokerPort,
        workflowId: n8nWorkflowId,
        ready: !!(container && brokerPort && n8nWorkflowId),
      },
      http: {
        baseUrl: n8nBaseUrl || '',
        apiKey: n8nApiKey || '',
        workflowId: n8nWorkflowId || '',
        ready: !!(n8nBaseUrl && n8nApiKey && n8nWorkflowId),
      },
      harness: {
        baseUrl: harnessBaseUrl || '',
        workflowId: harnessWorkflowId || '',
        webhookPath: harnessWebhookPath,
        webhookMode: harnessWebhookMode,
        ready: !!(harnessBaseUrl && harnessWorkflowId),
      },
      ready: execBackend === 'http'
        ? !!(n8nBaseUrl && n8nApiKey && n8nWorkflowId)
        : execBackend === 'harness'
          ? !!(harnessBaseUrl && harnessWorkflowId)
          : !!(container && brokerPort && n8nWorkflowId),
    },
    runToken: runTokenFor({}, env),
  };
}

/* ---------------- execution backend (cli / http) -------------------- */

function normalizeExecBackend(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'http' ? 'http' : v === 'harness' ? 'harness' : 'cli';
}

/**
 * Effective execution backend for an invocation: `--inject-scenario` (or env
 * RESP_INT_EXEC_BACKEND=harness) selects the webhook payload-injection harness;
 * everything else keeps the cli/http behavior verbatim.
 */
function effectiveExecBackend(args, config) {
  if (args && args.injectScenario) return 'harness';
  return config.exec.backend;
}

function validateExecParams(cli) {
  const errs = [];
  if (!cli.container) errs.push('RESP_INT_EXEC_CONTAINER is required for cli mode');
  else if (!CONTAINER_NAME_RE.test(cli.container)) {
    errs.push('RESP_INT_EXEC_CONTAINER must match the docker container-name charset (letters, digits, _ . -)');
  }
  if (!cli.brokerPort) errs.push('RESP_INT_EXEC_BROKER_PORT is required for cli mode');
  else if (!BROKER_PORT_RE.test(cli.brokerPort)) errs.push('RESP_INT_EXEC_BROKER_PORT must be a numeric port');
  else {
    const p = Number(cli.brokerPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errs.push('RESP_INT_EXEC_BROKER_PORT must be an integer in 1..65535');
    else if (p === SERVER_BROKER_PORT) {
      errs.push(`RESP_INT_EXEC_BROKER_PORT=${SERVER_BROKER_PORT} collides with the running n8n server's task broker; choose a different port (e.g. 5677)`);
    }
  }
  if (!cli.workflowId) errs.push('N8N_WORKFLOW_ID is required for cli mode');
  else if (!EXEC_WORKFLOW_ID_RE.test(cli.workflowId)) errs.push('N8N_WORKFLOW_ID must match [A-Za-z0-9_-]{1,64}');
  return errs;
}

function buildCliCommand(cli) {
  const errs = validateExecParams(cli);
  if (errs.length) throw new Error(`invalid cli execution config: ${errs.join('; ')}`);
  return [
    'docker',
    'exec',
    '-u',
    'node',
    '-e',
    `N8N_RUNNERS_BROKER_PORT=${cli.brokerPort}`,
    cli.container,
    'n8n',
    'execute',
    '--id',
    cli.workflowId,
  ];
}

function runCommand(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function parseExecuteStdout(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') return v;
  } catch (err) {
    /* fall through to embedded extraction */
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    if (v && typeof v === 'object') return v;
  } catch (err) {
    return null;
  }
  return null;
}

function executionIdFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  for (const key of ['id', 'executionId', 'execution_id']) {
    const v = payload[key];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return '';
}

function mapCliExitCode(code) {
  if (code === 0) return { status: 'PASS', detail: 'n8n execute finished (exit 0)' };
  if (code == null) return { status: 'FAIL', detail: 'n8n execute did not exit cleanly (terminated by signal or never started)' };
  return { status: 'FAIL', detail: `n8n execute failed (exit code ${code})` };
}

async function clientFor(env) {
  const config = readConfig(env);
  if (!config.googlesheetId) return null;
  if (config.auth.mode === 'token') {
    return new GoogleSheetsClient({
      spreadsheetId: config.googlesheetId,
      accessToken: env.GOOGLE_ACCESS_TOKEN,
    });
  }
  if (config.auth.mode === 'service-account') {
    return new GoogleSheetsClient({
      spreadsheetId: config.googlesheetId,
      serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    });
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

function syntheticFixture(scenario) {
  const base = {
    id: scenario,
    name: scenario,
    note: 'Phase 5 live-runner scenario (no rows seeded)',
    upstreamIncomplete: false,
    responseReadError: '',
    reconciliationReadError: '',
    initialResponseRows: [],
    initialOutreachRows: [],
    reconcileResponseRows: [],
    reconcileOutreachRows: [],
  };
  if (scenario === 'empty') return base;
  const readErr = 'simulated live response-log read failure';
  const reconErr = 'simulated live reconciliation-report read failure';
  if (scenario === 'response-log-failure') return { ...base, responseReadError: readErr };
  if (scenario === 'reconciliation-failure') return { ...base, reconciliationReadError: reconErr };
  if (scenario === 'upstream-incomplete') return { ...base, upstreamIncomplete: true };
  if (scenario === 'double-failure') return { ...base, responseReadError: readErr, reconciliationReadError: reconErr };
  throw new Error(`unknown failure scenario: ${scenario}`);
}

function validScenarioIds() {
  return loadResponseInterpretationFixtures().map((f) => f.id);
}

function resolveScenario(scenario) {
  const key = String(scenario || '').trim();
  if (SCENARIO_FAILURE_KEYS.includes(key)) {
    return { kind: 'failure', key, fixture: syntheticFixture(key) };
  }
  const fx = loadResponseInterpretationFixtures().find((f) => f.id === key);
  if (!fx) {
    throw new Error(
      `unknown scenario "${key}"; expected one of the 27 fixture ids (TEST-RESP-INT-001..027) or ` +
        SCENARIO_FAILURE_KEYS.join(', '),
    );
  }
  return { kind: 'fixture', key, fixture: fx };
}

/* ------------------------------------------------------------------ */
/* Namespaced projection (pure bijection on ids)                       */
/* ------------------------------------------------------------------ */

function buildIdMaps(fx, ns) {
  const respMap = new Map();
  let respSeq = 0;
  const rememberResponse = (orig) => {
    if (respMap.has(orig)) return respMap.get(orig);
    respSeq += 1;
    const ref = { seq: respSeq, newId: `RESPI-${ns}-${pad3(respSeq)}` };
    respMap.set(orig, ref);
    return ref;
  };
  for (const r of fx.initialResponseRows || []) rememberResponse(String(r.response_id || '').trim());
  for (const r of fx.reconcileResponseRows || []) rememberResponse(String(r.response_id || '').trim());

  const outreachMap = new Map();
  let outreachSeq = 0;
  for (const r of fx.reconcileOutreachRows || []) {
    const orig = String(r.outreach_id || '').trim();
    if (!orig || outreachMap.has(orig)) continue;
    outreachSeq += 1;
    outreachMap.set(orig, { seq: outreachSeq, newId: `EX-${ns}-${pad3(outreachSeq)}-${r.channel || 'email'}` });
  }
  return { respMap, outreachMap };
}

function projectResponseRow(row, ns, maps) {
  const orig = String(row.response_id || '').trim();
  let ref = maps.respMap.get(orig);
  if (!ref) {
    const freshSeq = maps.respMap.size + 1;
    ref = { seq: freshSeq, newId: `RESPI-${ns}-${pad3(freshSeq)}` };
    maps.respMap.set(orig, ref);
  }
  const channel = row.channel || '';
  const outreachRef = maps.outreachMap.get(String(row.outreach_id || '').trim());
  const newOutreach = outreachRef
    ? outreachRef.newId
    : `EX-${ns}-${pad3(ref.seq)}-${channel}`;
  return {
    ...row,
    response_id: ref.newId,
    idempotency_key: `${ref.newId}::${channel}`,
    lead_id: `${ns}-${pad3(ref.seq)}`,
    outreach_id: newOutreach,
  };
}

function projectOutreachRow(row, ns, maps) {
  const orig = String(row.outreach_id || '').trim();
  const ref = maps.outreachMap.get(orig);
  const seq = ref ? ref.seq : maps.outreachMap.size + 1;
  return {
    ...row,
    lead_id: `${ns}-${pad3(seq)}`,
    outreach_id: ref ? ref.newId : `EX-${ns}-${pad3(seq)}-${row.channel || 'email'}`,
  };
}

function projectedFixtureFor(resolved, ns) {
  const fx = resolved.fixture;
  const maps = buildIdMaps(fx, ns);
  return {
    ...fx,
    initialResponseRows: (fx.initialResponseRows || []).map((r) => projectResponseRow(r, ns, maps)),
    initialOutreachRows: (fx.initialOutreachRows || []).map((r) => projectOutreachRow(r, ns, maps)),
    reconcileResponseRows: (fx.reconcileResponseRows || []).map((r) => projectResponseRow(r, ns, maps)),
    reconcileOutreachRows: (fx.reconcileOutreachRows || []).map((r) => projectOutreachRow(r, ns, maps)),
  };
}

/** External-input rows to seed into the Response Log (Response Log schema only). */
function seedRowsFor(resolved, ns) {
  return projectedFixtureFor(resolved, ns).initialResponseRows;
}

function rowArraysFor(rows) {
  return rows.map((r) => objectToRow(r, RESPONSE_COLUMNS));
}

/* ------------------------------------------------------------------ */
/* Reconciliation artifact + deterministic expected output              */
/* ------------------------------------------------------------------ */

function injectedReportFor(resolved, ns) {
  const fx = resolved.fixture;
  if (fx.upstreamIncomplete) return { status: 'INCOMPLETE', results: [] };
  if (fx.responseReadError || fx.reconciliationReadError) return { status: 'COMPLETED', results: [] };
  const projected = projectedFixtureFor(resolved, ns);
  return reconcileResponses({
    responseRows: projected.reconcileResponseRows,
    outreachRows: projected.reconcileOutreachRows,
    now: FIXED_NOW,
    runId: FIXTURE_REPORT_RUN_ID,
  });
}

function injectedTriggerInputFor(resolved, ns) {
  const fx = resolved.fixture;
  return {
    event: '',
    reconciliation_report: injectedReportFor(resolved, ns),
    response_log_read_error: fx.responseReadError || '',
    reconciliation_read_error: fx.reconciliationReadError || '',
  };
}

function expectedReportFor(resolved, ns) {
  return stripRuntime(engineBehaviorFor(projectedFixtureFor(resolved, ns)));
}

function scopeCollectedToNamespace(report, ns) {
  if (!report || typeof report !== 'object') return report;
  const copy = JSON.parse(JSON.stringify(report));
  if (Array.isArray(copy.results)) {
    copy.results = copy.results.filter((r) => String(r && r.response_id || '').startsWith(`RESPI-${ns}-`));
  }
  return copy;
}

function compareCollected(collected, expected, ns) {
  const actual = stripRuntime(scopeCollectedToNamespace(collected, ns));
  return {
    equal: JSON.stringify(actual) === JSON.stringify(expected),
    actual,
    expected,
  };
}

/* ------------------------------------------------------------------ */
/* Shipped workflow precondition validation                            */
/* ------------------------------------------------------------------ */

function shippedWorkflowPath() {
  return path.join(__dirname, '..', `${ARTIFACT}.json`);
}

function checkShippedWorkflow(wf) {
  const checks = [];
  try {
    assertWorkflowContract(wf);
    checks.push({ label: 'workflow contract', ok: true, detail: 'assertWorkflowContract passed' });
  } catch (err) {
    checks.push({ label: 'workflow contract', ok: false, detail: err.message });
  }
  let codeNodes = 0;
  for (const node of (wf && wf.nodes) || []) {
    if (node && node.type === 'n8n-nodes-base.code') {
      codeNodes += 1;
      try {
        assertCleanSource(String((node.parameters && node.parameters.jsCode) || ''));
      } catch (err) {
        checks.push({ label: `clean source: ${node.name}`, ok: false, detail: err.message });
      }
    }
  }
  checks.push({ label: 'code nodes (relay + interpret)', ok: codeNodes === 2, detail: `${codeNodes} code nodes` });
  checks.push({ label: 'node count', ok: (wf && wf.nodes && wf.nodes.length) === EXPECTED_NODES.length, detail: `${(wf && wf.nodes && wf.nodes.length) || 0}/${EXPECTED_NODES.length}` });
  const active = !!(wf && wf.active);
  checks.push({ label: 'inactive before test', ok: !active, detail: active ? 'workflow must be shipped inactive' : 'inactive' });

  const sheetNodes = ((wf && wf.nodes) || []).filter((n) => n && n.type === 'n8n-nodes-base.googleSheets');
  const readOps = sheetNodes.filter((n) => (n.parameters && n.parameters.operation) === 'read');
  const writeOps = sheetNodes.filter((n) =>
    ['append', 'appendOrUpdate', 'update', 'upsert', 'delete'].includes((n.parameters && n.parameters.operation) || ''),
  );
  checks.push({ label: 'one Response Log read', ok: readOps.length === 1, detail: `${readOps.length} read node(s)` });
  checks.push({ label: 'zero sheets write nodes', ok: writeOps.length === 0, detail: `${writeOps.length} write node(s)` });

  const banned = ((wf && wf.nodes) || []).filter((n) => n && BANNED_NODE_TYPES.includes(n.type));
  checks.push({ label: 'no provider/AI/webhook/scheduler nodes', ok: banned.length === 0, detail: banned.length ? banned.map((n) => n.type).join(', ') : 'none' });

  const names = ((wf && wf.nodes) || []).map((n) => n && n.name);
  checks.push({ label: 'node names exactly the Phase 4 set', ok: JSON.stringify(names) === JSON.stringify(EXPECTED_NODES), detail: names.join(' > ') });
  return checks;
}

function assertShippedWorkflow(wf) {
  const failures = checkShippedWorkflow(wf).filter((c) => !c.ok);
  if (failures.length) throw new Error(`shipped workflow precondition failed: ${failures.map((f) => f.label).join('; ')}`);
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

function manualExecutionSteps(scenario, ns) {
  return [
    `MANUAL step required (scenario ${scenario}, namespace ${ns}):`,
    '  1. Open n8n and open the WORKFLOW artifact "Response-Interpretation V1" (keep it INACTIVE in n8n too).',
    '  2. Use Execute Workflow with the Manual Trigger input set to:',
    `       {"event":"","reconciliation_report": <report>, "response_log_read_error":"", "reconciliation_read_error":""}`,
    '     where <report> is the reconciliation artifact this run prepared (see the runner-report file).',
    '  3. Let the execution finish (Interpret Responses then Response Interpretation Complete).',
    '  4. Save the finished execution and provide its output for collection (--collect with --execution-id).',
    '  No LIVE pass is ever claimed until a real execution result is collected and compared.',
  ];
}

async function preflight(env, args = {}, deps = {}) {
  const config = readConfig(env);
  const ns = namespaceForArgs(args, env);
  const checks = [];
  const defaultReportsDir =
    (args && args.reportsDir) || path.join(__dirname, '..', 'reports');

  let shippedWf = null;
  try {
    shippedWf = JSON.parse(fs.readFileSync(shippedWorkflowPath(), 'utf8'));
    checks.push({ label: 'A shipped workflow parses', ok: true, detail: ARTIFACT });
  } catch (err) {
    checks.push({ label: 'A shipped workflow parses', ok: false, detail: err.message });
  }

  if (shippedWf) {
    checks.push(...checkShippedWorkflow(shippedWf));
  }

  const token = runTokenFor(args, env);
  const tokenOk = RUN_TOKEN_REGEX.test(token);
  checks.push({
    label: 'D namespace well-formed (unique per run)',
    ok: tokenOk,
    detail: tokenOk ? ns : `run token must match ${RUN_TOKEN_REGEX}`,
  });

  const client = (deps && deps.client) || null;
  if (client && tokenOk) {
    try {
      const grid = await client.listRows(RESPONSE_LOG_SHEET);
      const existing = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns);
      checks.push({
        label: 'D2 namespace unique in target tab',
        ok: existing.length === 0,
        detail: `${existing.length} pre-existing namespace row(s)`,
      });
    } catch (err) {
      checks.push({ label: 'D2 namespace unique in target tab', ok: false, detail: err.message });
    }
  } else {
    checks.push({
      label: 'D2 namespace unique in target tab',
      ok: !tokenOk,
      detail: tokenOk ? 'no client supplied here — uniqueness is re-verified at seed time (no network during preflight)' : 'malformed token',
      informational: tokenOk,
    });
  }

  checks.push({ label: 'E required sheet config present', ok: !!config.googlesheetId, detail: config.googlesheetId || 'GOOGLE_SHEET_ID required' });
  if (config.googlesheetId) {
    checks.push({
      label: 'E2 sheet matches pinned engine spreadsheet',
      ok: config.spreadsheetMatchesPinned || (args && args.allowNonPinnedSheet),
      detail: config.spreadsheetMatchesPinned
        ? SPREADSHEET_ID
        : (args && args.allowNonPinnedSheet
          ? 'dedicated sheet via --allow-non-pinned-sheet (not live-equivalent to the pinned engine sheet)'
          : `DIFFERENT sheet ${config.googlesheetId} — require --allow-non-pinned-sheet to proceed`),
    });
  }
  checks.push({
    label: 'E3 auth configured',
    ok: config.auth.ready || (args && args.noInteractive === false),
    detail: config.auth.ready ? `auth=${config.auth.mode}` : 'no sheets auth configured (prompts will ask unless --no-interactive)',
  });
  checks.push({ label: 'F target spreadsheet/tab explicit', ok: !!(config.googlesheetId && config.tab), detail: `${config.googlesheetId || '<missing>'} :: ${config.tab}` });

  const fixtures = loadResponseInterpretationFixtures();
  checks.push({ label: 'H fixture count 27', ok: fixtures.length === 27, detail: `${fixtures.length}/27` });
  const contiguous =
    fixtures.length === 27 &&
    fixtures.every((fx, i) => fx.id === `TEST-RESP-INT-${pad3(i + 1)}`);
  checks.push({ label: 'I fixture ids contiguous TEST-RESP-INT-001..027', ok: contiguous, detail: contiguous ? 'contiguous' : 'gap found' });

  if (config.exec.backendRaw && !VALID_EXEC_BACKENDS.includes(config.exec.backendRaw.toLowerCase())) {
    checks.push({
      label: 'exec backend value recognized',
      ok: false,
      detail: `RESP_INT_EXEC_BACKEND=${config.exec.backendRaw} is not recognized (cli|http|harness); fell back to the cli default`,
      informational: true,
    });
  }

  checks.push({
    label: 'n8n execution configured (informational)',
    ok: config.exec.ready,
    detail: config.exec.ready
      ? (config.exec.backend === 'http'
        ? `backend=http · ${config.exec.http.baseUrl} · workflow ${config.exec.http.workflowId}`
        : config.exec.backend === 'harness'
          ? `backend=harness · ${config.exec.harness.baseUrl} · webhook workflow ${config.exec.harness.workflowId}`
          : `backend=cli · container ${config.exec.cli.container} · broker port ${config.exec.cli.brokerPort} · workflow ${config.exec.cli.workflowId}`)
      : `backend=${config.exec.backend} — absent; execute/collect report NOT_CONFIGURED + MANUAL steps (never a fabricated PASS)`,
    informational: true,
  });
  if (effectiveExecBackend(args, config) === 'harness') {
    let hwf = null;
    try {
      hwf = JSON.parse(fs.readFileSync(harnessWorkflowPath(), 'utf8'));
      checks.push({ label: 'J harness webhook artifact parses', ok: true, detail: HARNESS_ARTIFACT, informational: true });
    } catch (err) {
      checks.push({ label: 'J harness webhook artifact parses', ok: false, detail: err.message, informational: true });
    }
    if (hwf) {
      const hc = checkHarnessContract(hwf);
      checks.push({
        label: 'K harness contract',
        ok: hc.every((c) => c.ok),
        detail: hc.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`).join('; ') || 'assertHarnessContract passed',
        informational: true,
      });
    }
  }

  const hard = checks.filter((c) => !c.informational && !c.ok);
  const status = hard.length ? 'FAIL' : 'PASS';
  return { status, checks, config, ns, reportsDir: defaultReportsDir };
}

async function seed(env, client, args = {}) {
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const ns = namespaceForArgs(args, env);
  if (resolved.kind === 'failure') {
    console.log(`[seed] failure scenario ${resolved.key}: no rows required; trigger metadata is injected at execution time.`);
    return 'SKIPPED';
  }
  if (!client) {
    console.warn('[seed] NOT_CONFIGURED: no Google Sheets client (GOOGLE_SHEET_ID + auth).');
    return 'NOT_CONFIGURED';
  }
  const rows = seedRowsFor(resolved, ns);
  const grid = await client.listRows(RESPONSE_LOG_SHEET);
  const present = new Set(
    rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns).map((o) => o.obj.response_id),
  );
  const toAppend = rows.filter((r) => !present.has(r.response_id));
  console.log(`[seed] scenario ${resolved.key} namespace ${ns}: response rows=${rows.length} (append ${toAppend.length})`);
  args._lastSeed = { ns, preGrid: grid };
  if (!args.execute) {
    console.warn('[seed] DRY-RUN: pass --execute to actually write. Nothing written.');
    return 'SKIPPED';
  }
  if (toAppend.length) await client.appendRows(RESPONSE_LOG_SHEET, rowArraysFor(toAppend));
  console.log('[seed] done (Response Log only; no other tab is ever touched)');
  return 'PASS';
}

async function verifySeed(env, client, args = {}) {
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const ns = namespaceForArgs(args, env);
  if (resolved.kind === 'failure') {
    return { status: 'SKIPPED', checks: [{ label: 'nothing seeded for failure scenario', ok: true }] };
  }
  if (!client) {
    return { status: 'NOT_CONFIGURED', checks: [{ label: 'sheet client available', ok: false, detail: 'GOOGLE_SHEET_ID + auth required' }], seededCount: 0 };
  }
  const expectedIds = seedRowsFor(resolved, ns)
    .map((r) => r.response_id)
    .sort();
  const grid = await client.listRows(RESPONSE_LOG_SHEET);
  const found = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns);
  const foundIds = found.map((o) => o.obj.response_id);
  const checks = [];
  checks.push({ label: 'namespace row count', ok: found.length === expectedIds.length, detail: `expected ${expectedIds.length}, found ${found.length}` });
  const missing = expectedIds.filter((id) => !foundIds.includes(id));
  checks.push({ label: 'expected response ids present', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' });
  const dupes = foundIds.filter((id, i) => foundIds.indexOf(id) !== i);
  checks.push({ label: 'no duplicate response ids', ok: dupes.length === 0, detail: dupes.length ? `duplicates: ${dupes.join(', ')}` : 'none' });
  const malformed = found.filter((o) => !RESPONSE_COLUMNS.every((c) => c in o.obj));
  checks.push({ label: 'response log schema intact (12 canonical columns)', ok: malformed.length === 0, detail: `${malformed.length} malformed row(s)` });
  const pre = args._lastSeed && args._lastSeed.preGrid;
  if (pre) {
    const beforeWithout = pre.slice(1);
    const afterOutside = grid.slice(1).filter((r) => !String(r[RESPONSE_LEAD_INDEX] || '').startsWith(`${ns}-`));
    checks.push({
      label: 'rows outside namespace unchanged',
      ok: JSON.stringify(beforeWithout) === JSON.stringify(afterOutside),
      detail: `before ${beforeWithout.length} non-header rows, outside-after ${afterOutside.length}`,
    });
  } else {
    checks.push({ label: 'pre-seed snapshot unavailable (live)', ok: true, detail: 'use full-run so the snapshot is captured before seeding' });
  }
  const status = checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
  return { status, checks, seededCount: expectedIds.length };
}

/* ------------------------- n8n execution --------------------------- */

async function executeShipped(env, args = {}, deps = {}) {
  const config = readConfig(env);
  const backend = effectiveExecBackend(args, config);
  if (backend === 'harness') {
    if (!config.exec.harness.workflowId) {
      return {
        status: 'NOT_CONFIGURED',
        detail: 'harness backend: RESP_INT_HARNESS_WORKFLOW_ID is unset and is NEVER derived from N8N_WORKFLOW_ID (the production id must not leak into the test surface); export RESP_INT_HARNESS_WORKFLOW_ID=<harness workflow id> and re-run',
        executionId: null,
        checks: [],
      };
    }
    if (!config.exec.harness.baseUrl) {
      return {
        status: 'NOT_CONFIGURED',
        detail: 'harness backend: RESP_INT_HARNESS_BASE_URL (or N8N_BASE_URL) is unset; export the n8n base URL (e.g. http://localhost:5678) and re-run',
        executionId: null,
        checks: [],
      };
    }
    return executeHarness(env, args, deps, config);
  }
  if (!config.exec.ready) {
    return { status: 'NOT_CONFIGURED', detail: manualExecutionSteps(args.scenario || DEFAULT_SCENARIO, namespaceForArgs(args, env)), executionId: null, checks: [] };
  }
  const wf = JSON.parse(fs.readFileSync(shippedWorkflowPath(), 'utf8'));
  assertShippedWorkflow(wf); // precondition — FAIL, never auto-repair
  if (backend === 'http') {
    return executeHttp(env, args, deps, config, wf);
  }
  return executeCli(env, args, deps, config);
}

async function executeHttp(env, args, deps, config, wf) {
  const ns = namespaceForArgs(args, env);
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const injected = injectedTriggerInputFor(resolved, ns);
  const transport = (deps && deps.transport) || ((...a) => fetch(...a));
  const payload = {
    workflowData: wf,
    data: {
      event: '',
      reconciliation_report: injected.reconciliation_report,
      response_log_read_error: injected.response_log_read_error,
      reconciliation_read_error: injected.reconciliation_read_error,
      phase5: { scenario: resolved.key, namespace: ns, artifact: ARTIFACT },
    },
  };
  let res;
  try {
    res = await transport(`${config.exec.http.baseUrl}/api/v1/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-N8N-API-KEY': config.exec.http.apiKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { status: 'FAIL', detail: `n8n API attempt failed: ${err.message}`, executionId: null, checks: [] };
  }
  if (!res.ok) {
    const text = await res.text();
    return { status: 'FAIL', detail: `n8n execution create failed (${res.status}): ${String(text).slice(0, 300)}`, executionId: null, checks: [] };
  }
  const json = await res.json();
  const id = String(json.id || json.executionId || '').trim();
  if (!id) return { status: 'FAIL', detail: 'n8n did not return an execution id; no live pass claimed', executionId: null, checks: [] };
  return {
    status: 'PASS',
    detail: `execution created: ${id} — confirm completion of Interpret Responses + Complete nodes in the n8n UI; then --collect with that id`,
    executionId: id,
    checks: [],
  };
}

/**
 * Phase 6.5: normalize the versioned-webhook lastNode response. `responseMode:
 * lastNode` returns the last node's output items in n8n 2.x as a bare object
 * (proven in §0: `{"saw":{...}}`); a single-item array is accepted and unwrapped
 * so the comparison treats both shapes identically. Anything else is NULL (no
 * live claim).
 */
function normalizeHarnessResponse(body) {
  if (Array.isArray(body)) {
    if (body.length === 1 && body[0] && typeof body[0] === 'object') return body[0];
    return null;
  }
  if (body && typeof body === 'object') return body;
  return null;
}

/**
 * Phase 6.5 harness backend: POST the scenario's trigger input to the test
 * harness workflow's versioned webhook. The request is unauthenticated by
 * design (webhooks have no API key); the workflow itself is inactive-between-
 * runs and only the running container registers the webhook on activation. The
 * webhook response IS the Interpret report, reused by collect.
 */
async function executeHarness(env, args, deps, config) {
  const wf = JSON.parse(fs.readFileSync(harnessWorkflowPath(), 'utf8'));
  const contractFailures = checkHarnessContract(wf).filter((c) => !c.ok);
  if (contractFailures.length) {
    return {
      status: 'FAIL',
      detail: `harness workflow precondition failed: ${contractFailures.map((f) => f.label).join('; ')}`,
      executionId: null,
      checks: [],
    };
  }
  const ns = namespaceForArgs(args, env);
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const payload = buildScenarioPayload(resolved.key, ns);
  const url = harnessWebhookUrl(config.exec.harness.baseUrl, config.exec.harness.webhookPath, config.exec.harness.webhookMode);
  const transport = (deps && deps.transport) || ((...a) => fetch(...a));
  let res;
  try {
    res = await transport(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { status: 'FAIL', detail: `harness webhook request failed: ${err.message}`, executionId: null, checks: [] };
  }
  if (!res.ok) {
    const text = await res.text();
    return { status: 'FAIL', detail: `harness webhook failed (${res.status}): ${String(text).slice(0, 300)}`, executionId: null, checks: [] };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  const collected = normalizeHarnessResponse(body);
  if (!collected) {
    args._harnessCollected = null;
    return {
      status: 'NOT_CONFIGURED',
      detail: 'harness webhook returned no Interpret report; no comparison claimed',
      executionId: null,
      checks: [],
    };
  }
  args._harnessCollected = collected;
  return {
    status: 'PASS',
    detail: `harness webhook executed (scenario ${resolved.key}, namespace ${ns}); Interpret report captured — collect reuses it`,
    executionId: '',
    collected,
    checks: [],
  };
}

/**
 * Phase 5.4: extract the raw n8n execution error surfaced by `n8n execute` so
 * the runner's failure_info carries the real runtime failure instead of only
 * an opaque exit-code message. Returns:
 *   - null when stdout is empty (nothing to diagnose);
 *   - a structured entry from payload.data.resultData.error (generated by the
 *     n8n CLI's execute reporter) that is SUBSET-ONLY — name, message,
 *     nodeCause / lastNodeExecuted from error.context — and NEVER persists the
 *     stack trace or runData;
 *   - { stage: 'execute', name: 'UnparseableOutput', message: ... } when stdout
 *     is not JSON (truncated to 300 chars, itself secret-redacted downstream).
 */
function executeFailureInfo(stdout) {
  const text = String(stdout || '');
  if (text.trim() === '') return null;
  const payload = parseExecuteStdout(text);
  if (!payload) {
    return {
      stage: 'execute',
      name: 'UnparseableOutput',
      message: `n8n execute stdout is not JSON (first 300 chars): ${text.slice(0, 300)}`,
    };
  }
  const error =
    payload && payload.data && payload.data.resultData && payload.data.resultData.error;
  if (!error) return null;
  const context = (error && error.context) || {};
  return {
    stage: 'execute',
    name: String(error.name || 'ExecutionError'),
    message: String(error.message || error.description || '').slice(0, 300),
    nodeCause: String(context.nodeCause || ''),
    lastNodeExecuted: String(context.lastNodeExecuted || ''),
  };
}

async function executeCli(env, args, deps, config) {
  const cli = config.exec.cli;
  let argv;
  try {
    argv = buildCliCommand(cli);
  } catch (err) {
    args._cliCollected = null;
    return { status: 'NOT_CONFIGURED', detail: `${err.message}; MANUAL execution steps apply`, executionId: null, checks: [] };
  }
  const exec = (deps && deps.exec) || runCommand;
  let res;
  try {
    res = await exec(argv);
  } catch (err) {
    return { status: 'FAIL', detail: `docker exec spawn failed: ${err.message}`, executionId: null, checks: [] };
  }
  const mapped = mapCliExitCode(res && res.code);
  if (mapped.status !== 'PASS') {
    const failure = executeFailureInfo(res && res.stdout);
    const tail = res && res.stderr ? `; stderr: ${String(res.stderr).slice(0, 300)}` : '';
    return { status: 'FAIL', detail: `${mapped.detail}${tail}`, executionId: null, checks: [], failure };
  }
  const payload = parseExecuteStdout(res && res.stdout);
  const collected = payload ? extractInterpretReport(payload) : null;
  const executionId = payload ? executionIdFromPayload(payload) : '';
  if (!collected) {
    args._cliCollected = null;
    return {
      status: 'NOT_CONFIGURED',
      detail: 'n8n execute exited 0 but the Interpret Responses output was not located in stdout; no comparison claimed (see PHASE-6-ENVIRONMENT-RUNBOOK.md)',
      executionId,
      checks: [],
    };
  }
  args._cliCollected = collected;
  return {
    status: 'PASS',
    detail: `n8n execute completed${executionId ? ` (execution ${executionId})` : ''}; Interpret report captured from CLI stdout — collect reuses it`,
    executionId,
    collected,
    checks: [],
  };
}

function extractInterpretReport(execPayload) {
  if (!execPayload || typeof execPayload !== 'object') return null;
  const runData = execPayload.data && execPayload.data.resultData && execPayload.data.resultData.runData;
  if (!runData || typeof runData !== 'object') return null;
  const items = runData['Interpret Responses'];
  if (!Array.isArray(items) || items.length === 0) return null;
  const main = items[items.length - 1] && items[items.length - 1].data && items[items.length - 1].data.main;
  if (!Array.isArray(main)) return null;
  for (const branch of main) {
    for (const item of branch || []) {
      if (item && item.json && typeof item.json === 'object') return item.json;
    }
  }
  return null;
}

async function collectExecution(env, args = {}, deps = {}) {
  const config = readConfig(env);
  if (effectiveExecBackend(args, config) === 'harness') {
    const harnessCollected = (deps && deps.harnessCollected && deps.harnessCollected.collected) || args._harnessCollected;
    if (harnessCollected) {
      return { status: 'PASS', detail: 'collected Interpret report from the harness webhook (execute phase capture)', collected: harnessCollected };
    }
    return {
      status: 'NOT_CONFIGURED',
      detail: 'harness backend: webhook executed but captured no Interpret report; no comparison claimed',
      collected: null,
    };
  }
  if (config.exec.backend === 'cli') {
    const cliCollected = (deps && deps.cliCollected) || args._cliCollected;
    if (cliCollected) {
      return { status: 'PASS', detail: 'collected report from the execute phase (CLI stdout capture)', collected: cliCollected };
    }
    return {
      status: 'NOT_CONFIGURED',
      detail: 'cli backend: no Interpret report captured during execute; re-run --execute-stage or use backend=http (REST) to collect a prior execution by id',
      collected: null,
    };
  }
  const executionId = String(args.executionId || (deps && deps.executionId) || '').trim();
  if (!config.n8n.ready || !executionId) {
    return {
      status: 'NOT_CONFIGURED',
      detail: 'no n8n config / execution id — execute first or provide --execution-id; nothing collected, no comparison claimed',
      collected: null,
    };
  }
  const transport = (deps && deps.transport) || ((...a) => fetch(...a));
  let res;
  try {
    res = await transport(`${config.n8n.baseUrl}/api/v1/executions/${encodeURIComponent(executionId)}`, {
      headers: { 'X-N8N-API-KEY': config.n8n.apiKey },
    });
  } catch (err) {
    return { status: 'FAIL', detail: `n8n execution fetch failed: ${err.message}`, collected: null };
  }
  if (!res.ok) {
    const text = await res.text();
    return { status: 'FAIL', detail: `n8n execution fetch failed (${res.status}): ${String(text).slice(0, 300)}`, collected: null };
  }
  const json = await res.json();
  const collected = extractInterpretReport(json);
  if (!collected) {
    return {
      status: 'NOT_CONFIGURED',
      detail: 'execution payload present but Interpret Responses output not located (execution may still be running or output shape unknown); no comparison claimed',
      collected: null,
    };
  }
  return { status: 'PASS', detail: `collected Interpret report from execution ${executionId}`, collected };
}

/* --------------------------- verify-input -------------------------- */

function failureInfoFor(collected, expected, ns) {
  const scoped = scopeCollectedToNamespace(collected, ns);
  const info = [];
  const eLen = (expected && expected.results ? expected.results.length : 0);
  const cLen = (scoped && scoped.results ? scoped.results.length : 0);
  if (eLen !== cLen) info.push(`row count mismatch: expected ${eLen}, collected ${cLen}`);
  const byId = new Map((scoped && scoped.results ? scoped.results : []).map((r) => [r.response_id, r]));
  for (const er of (expected && expected.results) || []) {
    const cr = byId.get(er.response_id);
    if (!cr) {
      info.push(`missing row ${er.response_id}`);
      continue;
    }
    const diff = [];
    for (const key of Object.keys(er)) {
      if (JSON.stringify(er[key]) !== JSON.stringify(cr[key])) diff.push(key);
    }
    if (diff.length) info.push(`row ${er.response_id} differs on: ${diff.join(', ')}`);
  }
  if (info.length === 0) info.push('structural mismatch not further broken down');
  return info;
}

function verifyInput(expected, collectedOutcome, ns) {
  if (!collectedOutcome || !collectedOutcome.collected) {
    return {
      status: 'NOT_CONFIGURED',
      detail: 'collected execution output absent — verify-input cannot claim PASS/FAIL on live data (Phase 6 owns run-level verification)',
      checks: [{ label: 'live collected output present', ok: false }],
      comparisonReady: false,
    };
  }
  const cmp = compareCollected(collectedOutcome.collected, expected, ns);
  const checks = [
    { label: 'live collected output present', ok: true, detail: 'collection produced a report' },
    { label: 'expected built from canonical engine', ok: true, detail: 'interpretResponses via engineBehaviorFor @ FIXED_NOW, runtime fields stripped' },
    { label: 'namespace-scoped structural equivalence', ok: cmp.equal, detail: cmp.equal ? 'identical' : `MISMATCH (expected ${expected.results ? expected.results.length : 0} rows)` },
  ];
  return {
    status: cmp.equal ? 'PASS' : 'FAIL',
    detail: cmp.equal ? 'namespace-scoped output matches canonical expectation' : 'namespace-scoped output differs from canonical expectation',
    checks,
    comparisonReady: true,
    reference: '',
    failure_info: cmp.equal ? [] : failureInfoFor(collectedOutcome.collected, expected, ns),
  };
}

/* ------------------------- cleanup ---------------------------------- */

async function cleanup(env, client, args = {}) {
  const ns = namespaceForArgs(args, env);
  if (!client) return 'NOT_CONFIGURED';
  let grid;
  try {
    grid = await client.listRows(RESPONSE_LOG_SHEET);
  } catch (err) {
    return 'CLEANUP_NOT_PERFORMED';
  }
  const found = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns);
  if (found.length === 0) {
    console.log(`[cleanup] no ${ns} rows present; nothing to delete`);
    return 'PASS';
  }
  if (!args.execute) {
    console.warn('[cleanup] DRY-RUN: pass --execute to delete. Nothing deleted.');
    return 'SKIPPED';
  }
  const unsafe = found.filter((o) => !RESP_INT_LIVE_LEAD_REGEX.test(String(o.obj.lead_id).trim()));
  if (unsafe.length > 0) {
    console.warn(`[cleanup] ${unsafe.length} non-namespaced row(s) found — refusing to delete; CLEANUP_NOT_PERFORMED`);
    return 'CLEANUP_NOT_PERFORMED';
  }
  try {
    await client.deleteRows(RESPONSE_LOG_SHEET, found.map((o) => o.index));
    const after = await client.listRows(RESPONSE_LOG_SHEET);
    const remaining = rowsForNamespace(after, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns);
    if (remaining.length > 0) return 'CLEANUP_NOT_PERFORMED';
  } catch (err) {
    return 'CLEANUP_NOT_PERFORMED';
  }
  console.log(`[cleanup] deleted ${found.length} ${ns} row(s)`);
  return 'PASS';
}

async function verifyCleanup(env, client, args = {}) {
  const ns = namespaceForArgs(args, env);
  if (!client) return { status: 'NOT_CONFIGURED', checks: [{ label: 'sheet client available', ok: false, detail: 'GOOGLE_SHEET_ID + auth required' }] };
  let grid;
  try {
    grid = await client.listRows(RESPONSE_LOG_SHEET);
  } catch (err) {
    return { status: 'FAIL', checks: [{ label: 'namespace cleared', ok: false, detail: err.message }] };
  }
  const found = rowsForNamespace(grid, RESPONSE_COLUMNS, RESPONSE_LEAD_INDEX, ns);
  const checks = [{ label: 'no namespace rows remain', ok: found.length === 0, detail: `${found.length} remain` }];
  const pre = args._lastSeed && args._lastSeed.preGrid;
  if (pre && grid.length) {
    const headerOk = JSON.stringify(grid[0]) === JSON.stringify(pre[0]);
    checks.push({ label: 'response log header unchanged', ok: headerOk, detail: headerOk ? 'intact' : 'header changed' });
  }
  return { status: checks.every((c) => c.ok) ? 'PASS' : 'FAIL', checks };
}

/* ------------------------- report ----------------------------------- */

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '<redacted>' : redact(value[key]);
    }
    return out;
  }
  if (typeof value === 'string') {
    let s = value;
    for (const re of SECRET_PATTERNS) s = s.replace(re, '<redacted>');
    return s;
  }
  return value;
}

function buildRunReport({ args = {}, env = {}, outcomes = {}, executionId = '', startedAt, completedAt }) {
  const config = readConfig(env);
  const ns = namespaceForArgs(args, env);
  const token = runTokenFor(args, env);
  const stages = outcomes.stages || {};
  const collectOutcome = outcomes.collect || {};
  const collectedCount =
    collectOutcome.collected && Array.isArray(collectOutcome.collected.results)
      ? collectOutcome.collected.results.length
      : 0;
  const reference = outcomes.verify && outcomes.verify.reference ? outcomes.verify.reference : '';
  const report = {
    artifact: 'Response Interpretation V1 — Phase 5 live runner',
    run_id: `RESPINT-LIVE-${token}`,
    runner_run_id: executionId || '',
    started_at: startedAt,
    completed_at: completedAt,
    mode: args.execute ? 'EXECUTE' : 'DRY_RUN',
    execution: {
      backend: config.exec.backend,
      workflow_id: config.exec.backend === 'harness' ? (config.exec.harness.workflowId || '') : (config.exec.http.workflowId || ''),
      base_url: config.exec.backend === 'http' || config.exec.backend === 'harness'
        ? (config.exec.backend === 'harness' ? (config.exec.harness.baseUrl || '') : (config.exec.http.baseUrl || ''))
        : '',
      webhook_path: config.exec.backend === 'harness' ? (config.exec.harness.webhookPath || HARNESS_WEBHOOK_PATH) : '',
      webhook_mode: config.exec.backend === 'harness' ? (config.exec.harness.webhookMode || HARNESS_WEBHOOK_MODE_PRODUCTION) : '',
      container: config.exec.backend === 'cli' ? config.exec.cli.container : '',
      broker_port: config.exec.backend === 'cli' ? config.exec.cli.brokerPort : '',
    },
    workflow: {
      name: WORKFLOW_NAME,
      artifact: ARTIFACT,
      pinned_spreadsheet_id: config.pinnedSpreadsheetId,
      tab: config.tab,
      expected_node_count: EXPECTED_NODES.length,
      nodes: EXPECTED_NODES,
    },
    test_namespace: ns,
    scenario: args.scenario || DEFAULT_SCENARIO,
    stages: {
      preflight: stages.preflight || 'SKIPPED',
      seed: stages.seed || 'SKIPPED',
      verify_seed: stages.verify_seed || 'SKIPPED',
      execute: stages.execute || 'SKIPPED',
      collect: stages.collect || 'SKIPPED',
      verify_input: stages.verify_input || 'SKIPPED',
      cleanup: stages.cleanup || 'SKIPPED',
      verify_cleanup: stages.verify_cleanup || 'SKIPPED',
    },
    seeded_count: stages.verify_seed && outcomes.seed && outcomes.seed.seededCount != null ? outcomes.seed.seededCount : (outcomes.seed && outcomes.seed.seededCount) || 0,
    collected_count: collectedCount,
    failure_info: outcomes.failures || [],
    comparison_ready_output: reference,
  };
  return redact(report);
}

function writeRunReport(report, args) {
  const dir = (args && args.reportsDir) || path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${report.run_id}-response-interpretation-live.json`);
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[report] ${target}`);
  return target;
}

/* ------------------------- orchestration ---------------------------- */

function overallStatusOf(stages) {
  const sev = stages || {};
  const hard = ['preflight', 'seed', 'verify_seed', 'execute', 'collect', 'verify_input', 'verify_cleanup'];
  if (hard.some((k) => sev[k] === 'FAIL')) return 'FAIL';
  const verifyInput = sev.verify_input || 'SKIPPED';
  if (verifyInput === 'PASS') return 'PASS';
  if (verifyInput === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  if (sev.execute === 'NOT_CONFIGURED' || sev.collect === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  return 'FAIL';
}

async function fullRun(env, args = {}, deps = {}) {
  const startedAt = new Date().toISOString();
  const outcomes = { stages: {}, failures: [] };
  const config = readConfig(env);
  const ns = namespaceForArgs(args, env);

  const pre = await preflight(env, args, deps);
  outcomes.stages.preflight = pre.status;
  if (pre.status === 'FAIL') {
    outcomes.failures.push('preflight failed');
    const report = buildRunReport({ args, env, outcomes, startedAt, completedAt: new Date().toISOString() });
    writeRunReport(report, args);
    return { status: 'FAIL', stages: outcomes.stages, report: redact(report) };
  }

  const client = (deps && deps.client) || (await clientFor(env));
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const expected = expectedReportFor(resolved, ns);

  if (!args.skipSeed) {
    const s = await seed(env, client, args);
    outcomes.stages.seed = s;
    const sr = await verifySeed(env, client, args);
    outcomes.seed = { ...sr, seededCount: sr.seededCount != null ? sr.seededCount : 0 };
    outcomes.stages.verify_seed = sr.status;
    if (sr.status === 'FAIL') outcomes.failures.push(`verify-seed failed: ${sr.checks.map((c) => c.label).join(', ')}`);
  }

  let executionId = '';
  if (!args.skipRun) {
    const ex = await executeShipped(env, args, deps);
    outcomes.stages.execute = ex.status;
    executionId = ex.executionId || '';
    args.executionId = executionId;
    if (ex.status === 'FAIL') {
      outcomes.failures.push(ex.failure || `execute failed: ${ex.detail}`);
    }
  }

  let collected = null;
  if (!args.skipCollect && (args.execute || executionId || args._cliCollected)) {
    const col = await collectExecution(env, args, deps);
    outcomes.stages.collect = col.status;
    collected = col.collected;
    outcomes.collect = col;
    if (col.status === 'FAIL') outcomes.failures.push(`collect failed: ${col.detail}`);
  } else {
    outcomes.stages.collect = executionId ? 'SKIPPED' : 'NOT_CONFIGURED';
    outcomes.collect = { status: outcomes.stages.collect, detail: 'no execution id available', collected: null };
  }

  if (!args.skipVerify) {
    const v = verifyInput(expected, outcomes.collect, ns);
    outcomes.stages.verify_input = v.status;
    outcomes.verify = v;
    if (v.status === 'FAIL') outcomes.failures.push('verify-input failed');
  }

  const partialReport = buildRunReport({ args, env, outcomes, executionId, startedAt, completedAt: new Date().toISOString() });
  if (outcomes.verify && outcomes.verify.comparisonReady) {
    const ref = path.join(args.reportsDir || partialReport.comparison_ready_output || '', 'response-interpretation-live-output.json');
    fs.mkdirSync(path.dirname(ref), { recursive: true });
    fs.writeFileSync(ref, `${JSON.stringify(redact(outcomes.collect.collected), null, 2)}\n`);
    outcomes.verify.reference = ref;
  }

  if (!args.skipCleanup) {
    const c = await cleanup(env, client, args);
    outcomes.stages.cleanup = c;
    if (c === 'FAIL') outcomes.failures.push('cleanup failed');
    if (c === 'CLEANUP_NOT_PERFORMED') outcomes.failures.push('cleanup not performed (safe deletion could not be established)');
    const vc = await verifyCleanup(env, client, args);
    outcomes.stages.verify_cleanup = vc.status;
    if (vc.status === 'FAIL') outcomes.failures.push('verify-cleanup failed');
  }

  const report = buildRunReport({ args, env, outcomes, executionId, startedAt, completedAt: new Date().toISOString() });
  writeRunReport(report, args);
  const status = overallStatusOf(outcomes.stages);
  return { status, stages: outcomes.stages, report: redact(report) };
}

async function runSelectedPhases(env, args = {}, deps = {}) {
  const startedAt = new Date().toISOString();
  const outcomes = { stages: {}, failures: [] };
  const client = (deps && deps.client) || (await clientFor(env));
  const resolved = resolveScenario(args.scenario || DEFAULT_SCENARIO);
  const ns = namespaceForArgs(args, env);
  const expected = expectedReportFor(resolved, ns);

  for (const phase of args.phases || []) {
    if (phase === 'preflight') {
      const r = await preflight(env, args, deps);
      outcomes.stages.preflight = r.status;
      for (const c of r.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}: ${c.detail}`);
    } else if (phase === 'seed') {
      const s = await seed(env, client, args);
      outcomes.stages.seed = s;
      const sr = await verifySeed(env, client, args);
      outcomes.seed = { ...sr, seededCount: sr.seededCount != null ? sr.seededCount : 0 };
      outcomes.stages.verify_seed = sr.status;
    } else if (phase === 'execute') {
      const ex = await executeShipped(env, args, deps);
      outcomes.stages.execute = ex.status;
      args.executionId = ex.executionId || '';
      for (const line of Array.isArray(ex.detail) ? ex.detail : [ex.detail]) console.log(`  [${ex.status}] ${line}`);
      if (ex.status === 'FAIL') outcomes.failures.push(ex.failure || `execute failed: ${ex.detail}`);
    } else if (phase === 'collect') {
      const col = await collectExecution(env, args, deps);
      outcomes.stages.collect = col.status;
      outcomes.collect = col;
    } else if (phase === 'verify') {
      const v = verifyInput(expected, outcomes.collect, ns);
      outcomes.stages.verify_input = v.status;
      outcomes.verify = v;
      for (const c of v.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? ': ' + c.detail : ''}`);
    } else if (phase === 'cleanup') {
      const c = await cleanup(env, client, args);
      outcomes.stages.cleanup = c;
      const vc = await verifyCleanup(env, client, args);
      outcomes.stages.verify_cleanup = vc.status;
    }
  }

  const report = buildRunReport({ args, env, outcomes, executionId: args.executionId, startedAt, completedAt: new Date().toISOString() });
  if (!args.noReport) writeRunReport(report, args);
  const status = overallStatusOf(outcomes.stages);
  return { status, stages: outcomes.stages, report: redact(report) };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const ALL_PHASES = ['preflight', 'seed', 'verify-seed', 'execute', 'collect', 'verify', 'cleanup', 'verify-cleanup'];

function parseArgs(argv) {
  const args = {
    execute: false,
    noInteractive: false,
    help: false,
    allowNonPinnedSheet: false,
    noReport: false,
    phases: [],
    scenario: DEFAULT_SCENARIO,
    reportsDir: path.join(__dirname, '..', 'reports'),
    runToken: '',
    executionId: '',
    skipSeed: false,
    skipRun: false,
    skipCollect: false,
    skipVerify: false,
    skipCleanup: false,
    injectScenario: false,
  };
  const add = (p) => {
    if (!args.phases.includes(p)) args.phases.push(p);
  };
  for (const arg of argv) {
    if (arg === '--execute') args.execute = true;
    else if (arg === '--no-interactive') args.noInteractive = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--allow-non-pinned-sheet') args.allowNonPinnedSheet = true;
    else if (arg === '--no-report') args.noReport = true;
    else if (arg === '--preflight') add('preflight');
    else if (arg === '--seed') add('seed');
    else if (arg === '--verify-seed') add('verify-seed');
    else if (arg === '--execute-stage') add('execute');
    else if (arg === '--collect') add('collect');
    else if (arg === '--verify') add('verify');
    else if (arg === '--cleanup') add('cleanup');
    else if (arg === '--verify-cleanup') add('verify-cleanup');
    else if (arg === '--run') { add('execute'); add('collect'); }
    else if (arg === '--all' || arg === '--full') { args.phases = ALL_PHASES.slice(); }
    else if (arg.startsWith('--scenario=')) args.scenario = arg.split('=')[1].trim();
    else if (arg.startsWith('--reports-dir=')) args.reportsDir = arg.split('=')[1].trim();
    else if (arg.startsWith('--run-token=')) args.runToken = arg.split('=')[1].trim();
    else if (arg.startsWith('--execution-id=')) args.executionId = arg.split('=')[1].trim();
    else if (arg === '--skip-seed') args.skipSeed = true;
    else if (arg === '--skip-run') args.skipRun = true;
    else if (arg === '--skip-collect') args.skipCollect = true;
    else if (arg === '--skip-verify') args.skipVerify = true;
    else if (arg === '--skip-cleanup') args.skipCleanup = true;
    else if (arg === '--inject-scenario') args.injectScenario = true;
  }
  return args;
}

function usage() {
  return `
Usage: node scripts/run-response-interpretation-live.js [phases] [flags]

Run the SHIPPED Response-Interpretation V1 workflow against the canonical
engine, using the namespace-guarded Phase 5 harness (seed -> execute ->
collect -> verify -> cleanup). Default (no phases): full run.

Phases (overridable individually):
  --preflight         validate shipped workflow + env before doing anything
  --seed              seed fixture rows into TEST-RESP-INT-LIVE-* namespace
  --verify-seed       read back and validate the seeded namespace rows
  --run               --execute-stage + --collect (needs n8n execution backend)
  --execute-stage     execute the shipped workflow (backend cli or http)
  --collect           fetch the execution result (needs --execution-id)
  --verify            compare collected output vs canonical expectation
  --cleanup           delete TEST-RESP-INT-LIVE-* rows (namespace-guarded)
  --verify-cleanup    confirm the namespace is clear again
  --all               every phase in order; --full is an alias

Flags:
  --execute                    allow actual spreadsheet writes (seeding/deletes)
  --no-interactive             never prompt; fail instead of surfacing MANUAL steps
  --scenario=<id>              fixture id TEST-RESP-INT-001..027 or empty /
                               response-log-failure / reconciliation-failure /
                               upstream-incomplete / double-failure
  --run-token=<hex>            namespace tag (default: runtime hex time tag)
  --execution-id=<id>          n8n execution id to collect
  --reports-dir=<dir>          report output directory (default <repo>/reports)
  --allow-non-pinned-sheet     target a dedicated sheet (NOT live-equivalent)
  --no-report                  skip writing the local run report
  --inject-scenario            use the Phase 6.5 harness backend: POST this
                               scenario's trigger input to the test harness
                               webhook workflow (implies RESP_INT_EXEC_BACKEND
                               =harness for the run)
  --help                       this message

Env (see .env.example): GOOGLE_SHEET_ID, GOOGLE_ACCESS_TOKEN or
GOOGLE_SERVICE_ACCOUNT_JSON, RESP_INT_LIVE_RUN_TOKEN (optional), and the n8n
execution backend RESP_INT_EXEC_BACKEND=cli|http|harness (default cli):
  cli  - RESP_INT_EXEC_CONTAINER + RESP_INT_EXEC_BROKER_PORT + N8N_WORKFLOW_ID;
         spawns \`docker exec -u node -e N8N_RUNNERS_BROKER_PORT=<port> <container>
         n8n execute --id <workflow>\`; the broker port MUST differ from the running
         n8n server's 5679 (the shipped default is 5677).
  http - N8N_BASE_URL + N8N_API_KEY + N8N_WORKFLOW_ID; REST POST path for
         instances that expose a run endpoint.
  harness - RESP_INT_HARNESS_BASE_URL (or N8N_BASE_URL) + RESP_INT_HARNESS_WORKFLOW_ID
         (required) + optional RESP_INT_HARNESS_WEBHOOK_PATH (default:
         test/resp-int-harness) + optional RESP_INT_HARNESS_WEBHOOK_MODE
         (default: production; use "test" for one-shot webhook-test endpoints).
         RESP_INT_HARNESS_WORKFLOW_ID is never derived from N8N_WORKFLOW_ID; if it
         is unset the backend reports NOT_CONFIGURED. The harness artifact is
         generated by scripts/build-response-interpretation-test-harness.js and
         activates the Webhook->Manual Trigger bridge, so the frozen 4-node chain
         executes against an injected scenario payload — no API key required.
Without the backend, execute/collect report NOT_CONFIGURED and print MANUAL
steps; no fake PASS.
Exit codes: 0 PASS, 1 FAIL, 3 NOT_CONFIGURED, 4 CLEANUP_NOT_PERFORMED.
`;
}

function exitCodeForStatus(status) {
  if (status === 'PASS') return 0;
  if (status === 'FAIL') return 1;
  if (status === 'NOT_CONFIGURED') return 3;
  if (status === 'CLEANUP_NOT_PERFORMED') return 4;
  return 2;
}

async function main(argv, env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.phases.length === 0) {
    args.phases = ALL_PHASES.slice();
  }
  if (args.skipSeed) args.phases = args.phases.filter((p) => !['seed', 'verify-seed'].includes(p));
  if (args.skipRun) args.phases = args.phases.filter((p) => !['execute', 'collect'].includes(p));
  if (args.skipCollect) args.phases = args.phases.filter((p) => p !== 'collect');
  if (args.skipVerify) args.phases = args.phases.filter((p) => p !== 'verify');
  if (args.skipCleanup) args.phases = args.phases.filter((p) => !['cleanup', 'verify-cleanup'].includes(p));
  if (JSON.stringify(args.phases) === JSON.stringify(ALL_PHASES) || args.phases.includes('verify')) {
    const out = await fullRun(env, args);
    printSummary(out);
    return exitCodeForStatus(out.status);
  }
  const out = await runSelectedPhases(env, args);
  printSummary(out);
  return exitCodeForStatus(out.status);
}

function printSummary(out) {
  const stages = out.stages || {};
  console.log('---');
  console.log(`RESULT: ${out.status}`);
  console.log(`stages: ${Object.entries(stages).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const failures = (out.report && out.report.failure_info && out.report.failure_info.length) ? out.report.failure_info.slice() : [];
  for (const f of failures) console.log(`  failure: ${typeof f === 'string' ? f : JSON.stringify(f)}`);
}

module.exports = {
  // constants
  RESPONSE_TAB,
  RESPONSE_LEAD_INDEX,
  RESPONSE_COLUMNS,
  RESP_INT_LIVE_NAMESPACE,
  RUN_TOKEN_REGEX,
  RESP_INT_LIVE_NAMESPACE_REGEX,
  RESP_INT_LIVE_LEAD_REGEX,
  DEFAULT_SCENARIO,
  SCENARIO_FAILURE_KEYS,
  STAGE_STATUSES,
  ALL_PHASES,
  FIXTURE_REPORT_RUN_ID,
  // config / namespace
  readConfig,
  normalizeExecBackend,
  clientFor,
  // cli execution backend
  validateExecParams,
  buildCliCommand,
  runCommand,
  mapCliExitCode,
  parseExecuteStdout,
  executionIdFromPayload,
  executeFailureInfo,
  executeCli,
  defaultRunToken,
  runTokenFor,
  namespaceFromRunToken,
  namespaceForArgs,
  // scenarios / projection
  validScenarioIds,
  resolveScenario,
  projectedFixtureFor,
  seedRowsFor,
  rowArraysFor,
  injectedReportFor,
  injectedTriggerInputFor,
  expectedReportFor,
  scopeCollectedToNamespace,
  compareCollected,
  failureInfoFor,
  // precondition
  shippedWorkflowPath,
  checkShippedWorkflow,
  assertShippedWorkflow,
  // phases
  manualExecutionSteps,
  preflight,
  seed,
  verifySeed,
  executeShipped,
  execute: executeShipped,
  extractInterpretReport,
  collectExecution,
  collect: collectExecution,
  verifyInput,
  cleanup,
  verifyCleanup,
  // report
  redact,
  buildRunReport,
  writeRunReport,
  // orchestration
  overallStatusOf,
  fullRun,
  runSelectedPhases,
  // cli
  parseArgs,
  usage,
  exitCodeForStatus,
  // Phase 6.5 harness backend
  effectiveExecBackend,
  executeHarness,
  normalizeHarnessResponse,
  HARNESS_WEBHOOK_PATH,
  HARNESS_WORKFLOW_ID,
  harnessWebhookUrl,
  harnessWorkflowPath,
  checkHarnessContract,
  buildScenarioPayload,
  main,
};