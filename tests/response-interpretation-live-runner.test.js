'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const R = require('../src/response-interpretation-live-runner');
const { MockSheets } = require('../src/mock-sheets');
const { SPREADSHEET_ID } = require('../src/response-interpretation-workflow-contract');
const { loadResponseInterpretationFixtures } = require('../src/response-interpretation-fixtures');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKEN = '00aa11bb22cc';
const NS = 'TEST-RESP-INT-LIVE-00aa11bb22cc';
const NS2 = 'TEST-RESP-INT-LIVE-00aa11bb22dd';
const SHIPPED = path.join(REPO_ROOT, 'Response-Interpretation V1.json');

const ENV_READY = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
  RESP_INT_LIVE_RUN_TOKEN: TOKEN,
  RESP_INT_EXEC_BACKEND: 'http',
  N8N_BASE_URL: 'https://n8n.example.local',
  N8N_API_KEY: 'test-n8n-key',
  N8N_WORKFLOW_ID: 'wf-001',
};

function makeMock() {
  const mock = new MockSheets();
  mock.addTab(R.RESPONSE_TAB, [R.RESPONSE_COLUMNS.slice()]);
  return mock;
}

function appendMockRow(mock, partial, index = R.RESPONSE_LEAD_INDEX) {
  const rows = mock.listRows(R.RESPONSE_TAB);
  const arr = R.RESPONSE_COLUMNS.map((c) => (partial[c] === undefined || partial[c] === null ? '' : String(partial[c])));
  arr[index] = arr[index] || `LEAD-${Math.random()}`;
  mock.appendRows(R.RESPONSE_TAB, [arr]);
}

describe('response-interpretation-live-runner export surface', () => {
  it('exposes the expected runner API', () => {
    for (const name of [
      'readConfig', 'clientFor', 'runTokenFor', 'namespaceForArgs', 'resolveScenario',
      'seedRowsFor', 'projectedFixtureFor', 'injectedReportFor', 'injectedTriggerInputFor',
      'expectedReportFor', 'preflight', 'seed', 'verifySeed', 'execute', 'collect', 'verifyInput',
      'cleanup', 'verifyCleanup', 'redact', 'buildRunReport', 'overallStatusOf', 'fullRun',
      'runSelectedPhases', 'parseArgs', 'usage', 'exitCodeForStatus', 'main',
      'assertShippedWorkflow', 'checkShippedWorkflow', 'scopeCollectedToNamespace', 'compareCollected',
    ]) assert.equal(typeof R[name], 'function', `${name} exported as function`);
  });

  it('declares canonical schema constants', () => {
    assert.equal(R.RESPONSE_TAB, 'Response Log');
    assert.equal(R.RESPONSE_LEAD_INDEX, 2);
    assert.equal(R.RESPONSE_COLUMNS.length, 12);
    assert.deepEqual(R.RESPONSE_COLUMNS.slice(0, 6), ['response_id', 'idempotency_key', 'lead_id', 'outreach_id', 'channel', 'provider_message_id']);
    assert.ok(R.STAGE_STATUSES.includes('CLEANUP_NOT_PERFORMED'));
    for (const p of ['preflight', 'seed', 'verify-seed', 'execute', 'collect', 'verify', 'cleanup', 'verify-cleanup']) {
      assert.ok(R.ALL_PHASES.includes(p), `phase ${p} declared`);
    }
  });
});

describe('namespace and run-token generation', () => {
  it('default run token is hex and matches the regex', () => {
    assert.match(R.defaultRunToken(), /^[0-9a-f]{8,32}$/i);
    for (const ok of ['00aa11bb22cc', 'deadbeef', 'ABCDEF0123456789']) assert.match(ok, R.RUN_TOKEN_REGEX);
    for (const bad of ['abc', '00aa11bb22cc!', '00aa11bb22gg']) assert.doesNotMatch(bad, R.RUN_TOKEN_REGEX);
  });

  it('composes the namespaced identifiers', () => {
    assert.equal(R.namespaceFromRunToken(TOKEN), NS);
    assert.match(NS, R.RESP_INT_LIVE_NAMESPACE_REGEX);
    assert.equal(R.RESP_INT_LIVE_NAMESPACE, 'TEST-RESP-INT-LIVE');
    assert.match(`${NS}-001`, R.RESP_INT_LIVE_LEAD_REGEX);
    assert.doesNotMatch(`${NS}-abc`, R.RESP_INT_LIVE_LEAD_REGEX);
    assert.doesNotMatch(`TEST-RESP-INT-001`, R.RESP_INT_LIVE_LEAD_REGEX);
  });

  it('runTokenFor prefers explicit arg over env over default', async () => {
    const t = '1122334455667788';
    assert.equal(R.runTokenFor({ runToken: t }, {}), t);
    assert.equal(R.runTokenFor({}, { RESP_INT_LIVE_RUN_TOKEN: t }), t);
    assert.equal(R.runTokenFor({}, { RESP_INT_LIVE_RUN_TOKEN: 'deadbeef' }), 'deadbeef');
    const d = R.runTokenFor({}, {});
    assert.match(d, /^[0-9a-f]{8,32}$/i);
  });

  it('namespaceForArgs picks env token when no arg token', () => {
    assert.equal(R.namespaceForArgs({ scenario: 'TEST-RESP-INT-001' }, { RESP_INT_LIVE_RUN_TOKEN: TOKEN }), NS);
    assert.equal(R.namespaceForArgs({ scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {}), NS);
  });
});

describe('readConfig validation', () => {
  it('empty env is not configured and never matches pinned sheet', () => {
    const c = R.readConfig({});
    assert.equal(c.googlesheetId, '');
    assert.equal(c.tab, 'Response Log');
    assert.equal(c.pinnedSpreadsheetId, SPREADSHEET_ID);
    assert.equal(c.spreadsheetMatchesPinned, false);
    assert.equal(c.auth.ready, false);
    assert.equal(c.auth.mode, 'none');
    assert.equal(c.n8n.ready, false);
  });

  it('ready env reports pinned match, auth, and n8n readiness', () => {
    const c = R.readConfig(ENV_READY);
    assert.equal(c.spreadsheetMatchesPinned, true);
    assert.equal(c.auth.ready, true);
    assert.equal(c.auth.mode, 'token');
    assert.equal(c.n8n.ready, true);
    assert.equal(c.n8n.baseUrl, 'https://n8n.example.local');
  });

  it('service-account auth without token', () => {
    const c = R.readConfig({ GOOGLE_SHEET_ID: SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/tmp/sa.json', N8N_BASE_URL: 'x', N8N_API_KEY: 'y', N8N_WORKFLOW_ID: 'z' });
    assert.equal(c.auth.ready, true);
    assert.equal(c.auth.mode, 'service-account');
    assert.equal(c.n8n.ready, true);
  });

  it('partial n8n config is never ready', () => {
    assert.equal(R.readConfig({ N8N_BASE_URL: 'x', N8N_API_KEY: 'y' }).n8n.ready, false);
    assert.equal(R.readConfig({ N8N_BASE_URL: 'x' }).n8n.ready, false);
  });
});

describe('scenario resolution', () => {
  it('accepts every shipped fixture id including all 27', () => {
    const ids = R.validScenarioIds();
    assert.equal(ids.length, 27);
    for (const id of ids) {
      const r = R.resolveScenario(id);
      assert.equal(r.kind, 'fixture');
      assert.equal(r.key, id);
    }
  });

  it('resolves the failure scenarios to trigger-metadata only', () => {
    for (const key of ['empty', 'response-log-failure', 'reconciliation-failure', 'upstream-incomplete', 'double-failure']) {
      const r = R.resolveScenario(key);
      assert.equal(r.kind, 'failure', key);
      assert.equal(r.key, key);
      assert.ok(r.fixture.initialResponseRows.length === 0);
    }
  });

  it('rejects unknown scenarios', () => {
    for (const bad of ['TEST-RESP-INT-028', 'TEST-RESP-INT-000', 'nonsense', '']) {
      assert.throws(() => R.resolveScenario(bad), /unknown/i);
    }
  });
});

describe('fixture discovery', () => {
  it('loads 27 contiguous fixtures from the canonical fixtures module', () => {
    const fixtures = loadResponseInterpretationFixtures();
    assert.equal(fixtures.length, 27);
    for (let i = 0; i < 27; i++) assert.equal(fixtures[i].id, `TEST-RESP-INT-${String(i + 1).padStart(3, '0')}`);
  });
});

describe('row projection and determinism', () => {
  it('projects a fixture into the live namespace with canonical columns only', () => {
    const rows = R.seedRowsFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    assert.equal(rows.length, 1);
    const cols = Object.keys(rows[0]).sort();
    assert.deepEqual(cols, R.RESPONSE_COLUMNS.slice().sort());
    assert.ok(rows[0].response_id.startsWith(`RESPI-${NS}-`), rows[0].response_id);
    assert.ok(rows[0].lead_id.startsWith(`${NS}-`), rows[0].lead_id);
    assert.match(rows[0].outreach_id, /^EX-TEST-RESP-INT-LIVE-[0-9a-f]{12}-\d{3}-(email|call)$/);
  });

  it('projection is deterministic across calls', () => {
    const a = JSON.stringify(R.seedRowsFor(R.resolveScenario('TEST-RESP-INT-021'), NS));
    const b = JSON.stringify(R.seedRowsFor(R.resolveScenario('TEST-RESP-INT-021'), NS));
    assert.equal(a, b);
  });

  it('two namespaces differ only by remapped ids', () => {
    const a = R.seedRowsFor(R.resolveScenario('TEST-RESP-INT-021'), NS);
    const b = R.seedRowsFor(R.resolveScenario('TEST-RESP-INT-021'), NS2);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      const ka = a[i], kb = b[i];
      assert.notEqual(ka.response_id, kb.response_id);
      assert.equal(ka.lead_id.replace(NS, ''), kb.lead_id.replace(NS2, ''));
      assert.equal(ka.channel, kb.channel);
      assert.equal(ka.received_at, kb.received_at);
    }
  });

  it('keeps reconcile feed rows joined to the seeded ids', () => {
    const fx = R.resolveScenario('TEST-RESP-INT-001');
    const proj = R.projectedFixtureFor(fx, NS);
    assert.equal(proj.initialResponseRows.length, 1);
    assert.equal(proj.reconcileResponseRows.length, 1);
    assert.equal(proj.reconcileOutreachRows.length, 1);
    assert.equal(proj.initialResponseRows[0].response_id, `RESPI-${NS}-001`);
    assert.equal(proj.reconcileResponseRows[0].response_id, `RESPI-${NS}-001`);
    assert.ok(proj.reconcileOutreachRows[0].outreach_id.startsWith('EX-'));
  });
});

describe('reconciliation artifact injection', () => {
  it('healthy fixture injects a COMPLETED verification report keyed by response_id', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    assert.equal(input.reconciliation_report.status, 'COMPLETED');
    assert.equal(input.reconciliation_report.results.length, 1);
    assert.equal(input.reconciliation_report.results[0].response_id, `RESPI-${NS}-001`);
    assert.equal(input.response_log_read_error, '');
    assert.equal(input.reconciliation_read_error, '');
  });

  it('multi-row fixture injects a report for every row', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('TEST-RESP-INT-021'), NS);
    assert.equal(input.reconciliation_report.results.length, 2);
  });

  it('upstream-incomplete mirrors the Phase 4 INCOMPLETE contract', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('upstream-incomplete'), NS);
    assert.equal(input.reconciliation_report.status, 'INCOMPLETE');
    assert.equal(input.reconciliation_report.results.length, 0);
    assert.equal(input.response_log_read_error, '');
    assert.equal(input.reconciliation_read_error, '');
  });

  it('response-log-failure sets the response_log_read_error carrier key', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('response-log-failure'), NS);
    assert.equal(input.response_log_read_error.includes('response-log'), true);
    assert.equal(input.reconciliation_read_error, '');
    assert.equal(input.reconciliation_report.status, 'COMPLETED');
    assert.equal(input.reconciliation_report.results.length, 0);
  });

  it('reconciliation-failure sets the reconciliation_read_error carrier key', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('reconciliation-failure'), NS);
    assert.equal(input.reconciliation_read_error.includes('reconciliation'), true);
    assert.equal(input.response_log_read_error, '');
  });

  it('double-failure sets both carrier keys', () => {
    const input = R.injectedTriggerInputFor(R.resolveScenario('double-failure'), NS);
    assert.notEqual(input.response_log_read_error, '');
    assert.notEqual(input.reconciliation_read_error, '');
    assert.equal(input.reconciliation_report.status, 'COMPLETED');
    assert.equal(input.reconciliation_report.results.length, 0);
  });
});

describe('expected output (canonical engine equivalence)', () => {
  it('derives the exact engine output for a seeded fixture (no runtime fields)', () => {
    const exp = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    assert.equal(exp.status, 'COMPLETED');
    assert.equal(exp.results.length, 1);
    const row = exp.results[0];
    assert.equal(row.response_id, `RESPI-${NS}-001`);
    assert.equal(row.reconciliation_status, 'VERIFIED');
    assert.equal(row.interpretation_status, 'INTERPRETED');
    assert.equal(row.intent_label, 'RESPOND');
    assert.equal(row.actionable, true);
    assert.equal('run_id' in exp, false);
    assert.equal('run_at' in exp, false);
    for (const r of exp.results) assert.equal('detected_at' in r, false);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-021'), NS));
    const b = JSON.stringify(R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-021'), NS));
    assert.equal(a, b);
  });
});

describe('seed lifecycle against the mock sheets client', () => {
  it('dry-run writes nothing', async () => {
    const mock = makeMock();
    const s = await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: false });
    assert.equal(s, 'SKIPPED');
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, 1);
  });

  it('executing seed writes only namespaced rows in the Response Log tab', async () => {
    const mock = makeMock();
    mock.appendRows(R.RESPONSE_TAB, [R.RESPONSE_COLUMNS.map((c) => (c === 'response_id' ? 'RESPI-PRODUCTION-1' : c === 'lead_id' ? 'LEAD-REAL' : ''))]);
    const s = await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    assert.equal(s, 'PASS');
    const rows = mock.listRows(R.RESPONSE_TAB).slice(1);
    assert.equal(rows.length, 3); // production 1 + seeded 2
    const seeded = rows.filter((r) => r[2] && r[2].startsWith(`${NS}-`));
    assert.equal(seeded.length, 2);
    assert.ok(rows.some((r) => r[2] === 'LEAD-REAL'));
    for (const r of seeded) assert.equal(r.length, 12);
  });

  it('re-seeding appends nothing (dedup by namespaced response_id)', async () => {
    const mock = makeMock();
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    const after = mock.listRows(R.RESPONSE_TAB).length;
    const s = await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    assert.equal(s, 'PASS');
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, after);
  });

  it('failure scenarios seed nothing', async () => {
    const mock = makeMock();
    const s = await R.seed(ENV_READY, mock, { scenario: 'response-log-failure', execute: true });
    assert.equal(s, 'SKIPPED');
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, 1);
  });

  it('seed without a sheet client is NOT_CONFIGURED, never a crash', async () => {
    assert.equal(await R.seed({}, null, { scenario: 'TEST-RESP-INT-001', execute: true }), 'NOT_CONFIGURED');
  });
});

describe('verifySeed', () => {
  it('passes on a correctly seeded namespace', async () => {
    const mock = makeMock();
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    const v = await R.verifySeed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021' });
    assert.equal(v.status, 'PASS');
    assert.equal(v.seededCount, 2);
    for (const c of v.checks) assert.ok(c.ok, `${c.label} ok`);
  });

  it('fails when a namespaced row is missing', async () => {
    const mock = makeMock();
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    mock.deleteRows(R.RESPONSE_TAB, [2]);
    const v = await R.verifySeed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021' });
    assert.equal(v.status, 'FAIL');
    assert.ok(v.checks.some((c) => c.label.includes('count') && !c.ok));
  });

  it('fails on duplicate namespaced response ids', async () => {
    const mock = makeMock();
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-001', execute: true });
    const rows = mock.listRows(R.RESPONSE_TAB);
    mock.appendRows(R.RESPONSE_TAB, [rows[1].slice()]);
    const v = await R.verifySeed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-001' });
    assert.equal(v.status, 'FAIL');
    assert.ok(v.checks.some((c) => c.label.includes('duplicate') && !c.ok));
  });

  it('is SKIPPED for failure scenarios and NOT_CONFIGURED without a client', async () => {
    const mock = makeMock();
    const v = await R.verifySeed(ENV_READY, mock, { scenario: 'empty' });
    assert.equal(v.status, 'SKIPPED');
    const v2 = await R.verifySeed({}, null, { scenario: 'TEST-RESP-INT-001' });
    assert.equal(v2.status, 'NOT_CONFIGURED');
  });
});

describe('cleanup', () => {
  it('dry-run removes nothing, execute removes only the namespace, verifyCleanup confirms', async () => {
    const mock = makeMock();
    mock.appendRows(R.RESPONSE_TAB, [R.RESPONSE_COLUMNS.map((c) => (c === 'response_id' ? 'RESPI-PRODUCTION-1' : c === 'lead_id' ? 'LEAD-REAL' : ''))]);
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-021', execute: true });
    const before = mock.listRows(R.RESPONSE_TAB).length;
    assert.equal(await R.cleanup(ENV_READY, mock, { execute: false }), 'SKIPPED');
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, before);
    assert.equal(await R.cleanup(ENV_READY, mock, { execute: true }), 'PASS');
    const after = mock.listRows(R.RESPONSE_TAB);
    assert.equal(after.length, 2); // header + production
    assert.ok(after.some((r) => r[2] === 'LEAD-REAL'));
    const vc = await R.verifyCleanup(ENV_READY, mock, {});
    assert.equal(vc.status, 'PASS');
    for (const c of vc.checks) assert.ok(c.ok);
  });

  it('refuses (CLEANUP_NOT_PERFORMED) when a namespace-prefixed row is not verifiably ours', async () => {
    const mock = makeMock();
    await R.seed(ENV_READY, mock, { scenario: 'TEST-RESP-INT-001', execute: true });
    appendMockRow(mock, { response_id: `RESPI-${NS}-999`, lead_id: `${NS}-nope` });
    assert.equal(await R.cleanup(ENV_READY, mock, { execute: true }), 'CLEANUP_NOT_PERFORMED');
  });

  it('refuses (CLEANUP_NOT_PERFORMED) when the tab cannot be enumerated', async () => {
    const mock = new MockSheets();
    assert.equal(await R.cleanup(ENV_READY, mock, { execute: true }), 'CLEANUP_NOT_PERFORMED');
  });

  it('is NOT_CONFIGURED without a client', async () => {
    assert.equal(await R.cleanup({}, null, { execute: true }), 'NOT_CONFIGURED');
  });
});

describe('preflight', () => {
  it('passes the A-I gates against the shipped workflow with pinned sheet', async () => {
    const mock = makeMock();
    const r = await R.preflight(ENV_READY, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, { client: mock });
    assert.equal(r.status, 'PASS');
    const labels = r.checks.filter((c) => !c.informational).map((c) => c.label);
    for (const req of ['shipped workflow parses', 'code nodes', 'namespace well-formed', 'required sheet config present', 'sheet matches pinned engine spreadsheet', 'fixture count 27', 'fixture ids contiguous']) {
      assert.ok(labels.some((l) => l.includes(req)), req);
    }
  });

  it('runs offline (no client) with D2 informational and still passes', async () => {
    const r = await R.preflight(ENV_READY, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {});
    assert.equal(r.status, 'PASS');
    const d2 = r.checks.find((c) => c.label.includes('D2'));
    assert.ok(d2.informational === true);
  });

  it('fails fast on missing sheet config and on non-pinned sheets', async () => {
    const mock = makeMock();
    assert.equal((await R.preflight({ RESP_INT_LIVE_RUN_TOKEN: TOKEN }, { runToken: TOKEN }, { client: mock })).status, 'FAIL');
    const lost = { ...ENV_READY, GOOGLE_SHEET_ID: 'NotThePinnedOne' };
    assert.equal((await R.preflight(lost, { runToken: TOKEN }, { client: mock })).status, 'FAIL');
    const allowed = R.preflight(lost, { runToken: TOKEN, allowNonPinnedSheet: true }, { client: mock });
    assert.equal((await allowed).status, 'PASS');
  });

  it('fails on a malformed namespace token', async () => {
    const r = await R.preflight({ ...ENV_READY, RESP_INT_LIVE_RUN_TOKEN: 'short' }, { runToken: 'short' }, { client: makeMock() });
    assert.equal(r.status, 'FAIL');
  });
});

describe('shipped workflow precondition checks', () => {
  const load = () => JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));

  it('the shipped artifact exists and passes every precondition', () => {
    assert.equal(fs.existsSync(SHIPPED), true);
    const checks = R.checkShippedWorkflow(load());
    for (const c of checks) assert.ok(c.ok, c.label);
    assert.doesNotThrow(() => R.assertShippedWorkflow(load()));
  });

  it('rejects an active workflow, writes, banned nodes, wrong node sets and dirty source', () => {
    const tamper = (fn) => fn(load());

    assert.throws(() => R.assertShippedWorkflow(tamper((wf) => { wf.active = true; return wf; })), /active/i);

    const withWrite = () => {
      const wf = load();
      wf.nodes.push({ id: 'x-write', name: 'Write Something', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [0, 500], parameters: { operation: 'append', tabName: 'Response Log', columns: {}, options: {} } });
      return wf;
    };
    assert.throws(() => R.assertShippedWorkflow(withWrite()), /write/i);

    const withBanned = () => {
      const wf = load();
      wf.nodes.push({ id: 'x-webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 500], parameters: {} });
      return wf;
    };
    assert.throws(() => R.assertShippedWorkflow(withBanned()), /banned|provider|webhook/i);

    const missingNode = () => {
      const wf = load();
      wf.nodes = wf.nodes.filter((n) => n.name !== 'Response Interpretation Complete');
      return wf;
    };
    assert.throws(() => R.assertShippedWorkflow(missingNode()), /node count/);

    const reordered = () => {
      const wf = load();
      const idx = wf.nodes.findIndex((n) => n.name === 'Read Reconciliation Report');
      const [n] = wf.nodes.splice(idx, 1);
      wf.nodes.push(n);
      return wf;
    };
    assert.throws(() => R.assertShippedWorkflow(reordered()));

    const dirtySource = () => {
      const wf = load();
      wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode = 'eval(process.env.GOOGLE_ACCESS_TOKEN)';
      return wf;
    };
    // contract-level clean-source scanning (assertCleanSource runs inside assertWorkflowContract)
    assert.throws(() => R.assertShippedWorkflow(dirtySource()), /precondition failed/);
    const cs = R.checkShippedWorkflow(dirtySource());
    assert.equal(cs[0].ok, false); // 'workflow contract' check reports the violation
    assert.match(cs[0].detail, /code-node violation/i);
  });

  it('shipment contains exactly two code nodes and no live-trigger node types', () => {
    const wf = load();
    const code = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
    assert.equal(code.length, 2);
    assert.equal(wf.active, false);
  });
});

describe('verifyInput / compare / scoping', () => {
  const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);

  it('NOT_CONFIGURED when nothing was collected', () => {
    assert.equal(R.verifyInput(expected, null, NS).status, 'NOT_CONFIGURED');
    assert.equal(R.verifyInput(expected, {}, NS).status, 'NOT_CONFIGURED');
  });

  it('PASS when collected equals the canonical expectation', () => {
    const v = R.verifyInput(expected, { collected: JSON.parse(JSON.stringify(expected)) }, NS);
    assert.equal(v.status, 'PASS');
  });

  it('PASS even when collected carries runtime fields (stripped before comparison)', () => {
    const withRuntime = JSON.parse(JSON.stringify(expected));
    withRuntime.run_id = 'RESPINT-irrelevant';
    withRuntime.run_at = '2026-09-12T09:00:01.000Z';
    withRuntime.detected_at = '2026-09-12T09:00:01.000Z';
    const v = R.verifyInput(expected, { collected: withRuntime }, NS);
    assert.equal(v.status, 'PASS');
  });

  it('PASS after scoping out production rows that are not ours', () => {
    const withProd = JSON.parse(JSON.stringify(expected));
    withProd.results.push({ interpretation_id: 'INTERP-00000001', response_id: 'RESPI-PRODUCTION-1', lead_id: 'LEAD-REAL', interpretation_status: 'INTERPRETED', reconciliation_status: 'VERIFIED' });
    const v = R.verifyInput(expected, { collected: withProd }, NS);
    assert.equal(v.status, 'PASS');
    const scoped = R.scopeCollectedToNamespace(withProd, NS);
    assert.equal(scoped.results.length, 1);
  });

  it('FAIL on a real mismatch with failure_info', () => {
    const mismatch = JSON.parse(JSON.stringify(expected));
    mismatch.results[0].intent_label = 'AGENT_ESCALATION';
    const v = R.verifyInput(expected, { collected: mismatch }, NS);
    assert.equal(v.status, 'FAIL');
    assert.ok(Array.isArray(v.failure_info) && v.failure_info.length > 0);
    assert.ok(v.failure_info.some((f) => f.includes('intent_label')), JSON.stringify(v.failure_info));
  });

  it('FAIL when another namespace contaminated the collected output', () => {
    const other = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS2);
    const v = R.verifyInput(expected, { collected: other }, NS);
    assert.equal(v.status, 'FAIL');
  });

  it('compareCollected strips runtime fields and compares deeply', () => {
    const rid = `RESPI-${NS}-001`;
    // collected side may carry runtime fields; expected side is already clean (engineBehaviorFor + stripRuntime)
    const collected = { status: 'COMPLETED', results: [{ interpretation_id: 'INTERP-1', response_id: rid, run_id: 'x', run_at: 'y', detected_at: 'z' }] };
    const clean = { status: 'COMPLETED', results: [{ interpretation_id: 'INTERP-1', response_id: rid }] };
    assert.equal(R.compareCollected(collected, clean, NS).equal, true);
    clean.results[0].intent_label = 'AGENT_ESCALATION';
    assert.equal(R.compareCollected(collected, clean, NS).equal, false);
  });
});

describe('redaction and run report safety', () => {
  it('redacts sensitive nested keys and secret-shaped strings', () => {
    const o = R.redact({ provider_message_id: 'p-1', response_text: 'secret text', sender: 'a@b.c', access_token: 'tok', response_log_read_error: 'err', keep: 'value', nested: { access_token: 'x', notes: 'n' } });
    assert.equal(o.keep, 'value');
    assert.equal(o.provider_message_id, '<redacted>');
    assert.equal(o.response_text, '<redacted>');
    assert.equal(o.sender, '<redacted>');
    assert.equal(o.access_token, '<redacted>');
    assert.equal(o.nested.access_token, '<redacted>');
    assert.equal(o.nested.notes, 'n');

    const s = R.redact('token sk-live-1234567890abcdefghij secret AIzaSyB5T-6gB_qKbWAbR1234567890123456 ya29.abcdefghij AKIAIOSFODNN7EXAMPLE xoxb-1234567890');
    assert.equal(s.includes('sk-live-1234567890abcdefghij'), false);
    assert.equal(s.includes('AIzaSyB5T-6gB_qKbWAbR1234567890123456'), false);
    assert.equal(s.includes('ya29.abcdefghij'), false);
    assert.equal(s.includes('AKIAIOSFODNN7EXAMPLE'), false);
  });

  it('the run report never contains configured secrets', () => {
    const env = { ...ENV_READY, GOOGLE_ACCESS_TOKEN: 'SECRET-ELEPHANT', GOOGLE_SERVICE_ACCOUNT_JSON: 'C:/keys/sec.json', N8N_API_KEY: 'SECRET-N8N-KEY' };
    const report = R.buildRunReport({
      args: { execute: true, scenario: 'TEST-RESP-INT-001', runToken: TOKEN },
      env,
      outcomes: {
        stages: { preflight: 'PASS', seed: 'PASS', verify_seed: 'PASS', execute: 'PASS', collect: 'PASS', verify_input: 'PASS', cleanup: 'PASS', verify_cleanup: 'PASS' },
        collect: { collected: { status: 'COMPLETED', results: [{ provider_message_id: 'p', response_text: 'secret' }] } },
        seed: { seededCount: 1 },
      },
      executionId: 'EX-1',
      startedAt: 's',
      completedAt: 'c',
    });
    const txt = JSON.stringify(report);
    assert.equal(txt.includes('SECRET-ELEPHANT'), false);
    assert.equal(txt.includes('SECRET-N8N-KEY'), false);
    assert.equal(report.test_namespace, NS);
    assert.equal(report.run_id, `RESPINT-LIVE-${TOKEN}`);
    assert.equal(report.mode, 'EXECUTE');
    assert.equal(report.stages.preflight, 'PASS');
    assert.equal(report.collected_count, 1);
  });

  it('writeRunReport writes under the reports dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-int-reports-'));
    const report = { ...R.buildRunReport({ args: { runToken: TOKEN }, env: {}, outcomes: {}, startedAt: 's', completedAt: 'c' }), run_id: `RESPINT-LIVE-${TOKEN}` };
    const target = R.writeRunReport(report, { reportsDir: dir });
    assert.equal(fs.existsSync(target), true);
    const back = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(back.run_id, report.run_id);
    assert.equal(back.started_at, 's');
    assert.equal(back.completed_at, 'c');
    assert.deepEqual(back, report);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('stage aggregation and exit codes', () => {
  it('exitCodeForStatus maps PASS/FAIL/NOT_CONFIGURED/CLEANUP_NOT_PERFORMED/unknown', () => {
    assert.equal(R.exitCodeForStatus('PASS'), 0);
    assert.equal(R.exitCodeForStatus('FAIL'), 1);
    assert.equal(R.exitCodeForStatus('NOT_CONFIGURED'), 3);
    assert.equal(R.exitCodeForStatus('CLEANUP_NOT_PERFORMED'), 4);
    assert.equal(R.exitCodeForStatus('BOGUS'), 2);
  });

  it('overallStatusOf collapses stages correctly', () => {
    const all = { preflight: 'PASS', seed: 'PASS', verify_seed: 'PASS', execute: 'PASS', collect: 'PASS', verify_input: 'PASS', cleanup: 'PASS', verify_cleanup: 'PASS' };
    assert.equal(R.overallStatusOf(all), 'PASS');
    assert.equal(R.overallStatusOf({ ...all, verify_input: 'FAIL' }), 'FAIL');
    assert.equal(R.overallStatusOf({ ...all, verify_input: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED');
    assert.equal(R.overallStatusOf({ ...all, cleanup: 'CLEANUP_NOT_PERFORMED' }), 'PASS');
    assert.equal(R.overallStatusOf({ preflight: 'PASS', seed: 'SKIPPED', execute: 'NOT_CONFIGURED', collect: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED');
    // any hard FAIL wins even if verify would later pass
    assert.equal(R.overallStatusOf({ ...all, seed: 'FAIL' }), 'FAIL');
  });
});

describe('runSelectedPhases sampling (no network)', () => {
  it('verify phase only: samples the canonical compare with a mock transport', async () => {
    const resolved = R.resolveScenario('TEST-RESP-INT-001');
    const expected = R.expectedReportFor(resolved, NS);
    const r = await R.runSelectedPhases(ENV_READY, { phases: ['verify'], scenario: 'TEST-RESP-INT-001', runToken: TOKEN, noReport: true, reportsDir: os.tmpdir() }, {
      client: makeMock(),
      transport: async () => ({ ok: true, text: async () => JSON.stringify({ done: true }) }),
    });
    assert.equal(r.stages.verify_input, 'NOT_CONFIGURED'); // nothing collected in this sample
    assert.equal(r.status, 'NOT_CONFIGURED');
  });

  it('execute/collect without n8n config is NOT_CONFIGURED and never PASS/FAIL', async () => {
    const r = await R.runSelectedPhases({ GOOGLE_ACCESS_TOKEN: 't', RESP_INT_LIVE_RUN_TOKEN: TOKEN }, { phases: ['execute', 'collect'], scenario: 'TEST-RESP-INT-001', runToken: TOKEN, noReport: true, reportsDir: os.tmpdir() }, {});
    assert.equal(r.stages.execute, 'NOT_CONFIGURED');
    assert.equal(r.stages.collect, 'NOT_CONFIGURED');
    assert.equal(r.status, 'NOT_CONFIGURED');
  });

  it('full pass pipeline through phases with a mocked transport', async () => {
    const mock = makeMock();
    const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    const transport = async (url, opts) => {
      if (String(url).includes('/api/v1/executions/EX-77')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              resultData: {
                runData: { 'Interpret Responses': [{ data: { main: [[{ json: expected }]] } }] },
              },
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'EX-77' }) };
    };
    const r = await R.runSelectedPhases(
      ENV_READY,
      { phases: ['seed', 'execute', 'collect', 'verify', 'cleanup'], scenario: 'TEST-RESP-INT-001', runToken: TOKEN, execute: true, noReport: true, reportsDir: os.tmpdir() },
      { client: mock, transport },
    );
    assert.equal(r.stages.seed, 'PASS');
    assert.equal(r.stages.execute, 'PASS');
    assert.equal(r.stages.collect, 'PASS');
    assert.equal(r.stages.verify_input, 'PASS');
    assert.equal(r.stages.cleanup, 'PASS');
    assert.equal(r.stages.verify_cleanup, 'PASS');
    assert.equal(r.status, 'PASS');
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, 1); // cleaned up
  });
});

describe('manual execution steps and collect extraction', () => {
  it('manualExecutionSteps names the shipped artifact and trigger shape', () => {
    const steps = R.manualExecutionSteps();
    assert.equal(Array.isArray(steps), true);
    assert.ok(steps.some((l) => l.includes('Response-Interpretation V1')));
    assert.ok(steps.some((l) => l.includes('reconciliation_report')));
  });

  it('extractInterpretReport pulls the notification-node JSON', () => {
    const payload = {
      data: {
        resultData: {
          runData: { 'Interpret Responses': [{ data: { main: [[{ json: { status: 'COMPLETED', results: [] } }]] } }] },
        },
      },
    };
    assert.deepEqual(R.extractInterpretReport(payload), { status: 'COMPLETED', results: [] });
    assert.equal(R.extractInterpretReport({ data: { resultData: { runData: {} } } }), null);
  });
});

describe('CLI wiring', () => {
  const runCli = (args, env = {}) => {
    const extra = { ...env };
    if (extra.GOOGLE_SHEET_ID === undefined) delete extra.GOOGLE_SHEET_ID;
    if (extra.GOOGLE_SERVICE_ACCOUNT_JSON === undefined) delete extra.GOOGLE_SERVICE_ACCOUNT_JSON;
    let out;
    try {
      out = execFileSync(process.execPath, ['scripts/run-response-interpretation-live.js', ...args], { cwd: REPO_ROOT, env: { ...process.env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 2, out: e.stdout ? String(e.stdout) : '' + (e.stderr ? '\n' + String(e.stderr) : '') };
    }
  };

  it('--help exits 0 and prints usage', () => {
    const r = runCli(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.out.toLowerCase().includes('usage'));
  });

  it('bare invocation defaults to a full run and FAILs (exit 1) without config — never a fake PASS', () => {
    const r = runCli(['--reports-dir', os.tmpdir().split('\\').join('/')]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes('RESULT: FAIL'));
    assert.ok(!r.out.includes('RESULT: PASS'));
  });

  it('execute/collect without n8n config exits 3 (NOT_CONFIGURED), no report fabricated', () => {
    const r = runCli(['--run', '--no-interactive', '--reports-dir', os.tmpdir()], { RESP_INT_LIVE_RUN_TOKEN: TOKEN });
    assert.equal(r.code, 3);
    assert.ok(!r.out.includes('PASS'));
  });

  it('preflight-only without sheet config exits 1 (FAIL), not 0', () => {
    const r = runCli(['--preflight', '--no-interactive'], { RESP_INT_LIVE_RUN_TOKEN: TOKEN });
    assert.equal(r.code, 1);
  });
});

describe('Phase 5 security-gate literal scan', () => {
  it('runner source has no random ids, no shell/process escape, no secret-looking literals', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'response-interpretation-live-runner.js'), 'utf8');
    for (const banned of ['Math.random(', 'randomUUID', 'process.env.']) {
      assert.ok(!src.includes(banned), `banned literal ${banned}`);
    }
    // secret-shaped VALUES (not the detection-pattern vocab in SECRET_PATTERNS)
    for (const pattern of [/sk-[A-Za-z0-9]{8,}/, /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z_-]{20,}/, /ya29\.[0-9A-Za-z_-]{10,}/]) {
      assert.equal(pattern.test(src), false, `banned secret-shaped value ${pattern}`);
    }
    const ps1 = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'run-response-interpretation-live.ps1'), 'utf8');
    assert.equal(ps1.includes('-AsPlainText'), false);
  });
});