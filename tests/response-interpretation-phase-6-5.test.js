'use strict';

/* Phase 6.5 — test harness backend (webhook payload injection, Mechanism B).
 * Covers: payload parity with the canonical trigger input, the harness
 * contract (+ mutation negatives), builder determinism with frozen-artifact
 * splice fidelity, harness webhook URL construction, dedicated RESP_INT_HARNESS_*
 * env sourcing (with N8N_BASE_URL fallback only), runner harness/collect/verify
 * wiring with a mocked transport, and the executeFailureInfo banner-strip
 * regression.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const R = require('../src/response-interpretation-live-runner');
const { buildScenarioPayload } = require('../src/response-interpretation-scenario-payloads');
const H = require('../src/response-interpretation-test-harness-contract');
const B = require('../scripts/build-response-interpretation-test-harness');
const { MockSheets } = require('../src/mock-sheets');
const { SPREADSHEET_ID, ARTIFACT } = require('../src/response-interpretation-workflow-contract');

const TOKEN = '00aa11bb22cc';
const NS = 'TEST-RESP-INT-LIVE-00aa11bb22cc';
const FROZEN_SHA = 'ae365cd3b98fce08b95ccea9fae7661e4d1bde7f655326a4ed13b7031adb4bac';
const PROD_WORKFLOW_ID = 'VP3qw1h7hC4FVu9K'; // the production id — harness must NEVER use it

const ENV_HARNESS = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
  RESP_INT_LIVE_RUN_TOKEN: TOKEN,
  RESP_INT_EXEC_BACKEND: 'harness',
  N8N_BASE_URL: 'https://n8n.example.local',
  N8N_API_KEY: 'test-n8n-key',
  N8N_WORKFLOW_ID: PROD_WORKFLOW_ID,
  RESP_INT_HARNESS_BASE_URL: 'https://n8n.example.local',
  RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
};

function shaLines(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

const validWf = () => B.buildHarnessJson();

describe('Phase 6.5 payload parity with the canonical trigger input', () => {
  it('buildScenarioPayload === injectedTriggerInputFor for every fixture', () => {
    for (const id of R.validScenarioIds()) {
      assert.deepEqual(buildScenarioPayload(id, NS), R.injectedTriggerInputFor(R.resolveScenario(id), NS), `parity: ${id}`);
    }
  });

  it('parity holds for every failure key', () => {
    for (const key of ['empty', 'response-log-failure', 'reconciliation-failure', 'upstream-incomplete', 'double-failure']) {
      assert.deepEqual(buildScenarioPayload(key, NS), R.injectedTriggerInputFor(R.resolveScenario(key), NS), `parity: ${key}`);
    }
  });

  it('empty namespace is deterministic', () => {
    const a = buildScenarioPayload('TEST-RESP-INT-001', '');
    assert.deepEqual(a, R.injectedTriggerInputFor(R.resolveScenario('TEST-RESP-INT-001'), ''));
    assert.deepEqual(buildScenarioPayload('TEST-RESP-INT-001', ''), a);
  });

  it('trigger input shape is the 4-field Manual Trigger contract', () => {
    const p = buildScenarioPayload('TEST-RESP-INT-001', NS);
    assert.ok(p && typeof p === 'object');
    assert.equal(p.event, '');
    assert.ok(p.reconciliation_report && typeof p.reconciliation_report === 'object');
    assert.ok('response_log_read_error' in p);
    assert.ok('reconciliation_read_error' in p);
  });

  it('payloads carry no sensitive response fields (reconcile report card hygiene)', () => {
    for (const id of R.validScenarioIds()) {
      const raw = JSON.stringify(buildScenarioPayload(id, NS));
      assert.ok(!/response_text|provider_message_id|sender|recipient|raw_response/.test(raw), `hygiene: ${id}`);
    }
  });
});

describe('Phase 6.5 harness contract', () => {
  it('passes on the generated harness artifact', () => {
    const wf = JSON.parse(fs.readFileSync(H.harnessWorkflowPath(), 'utf8'));
    const failures = H.checkHarnessContract(wf).filter((c) => !c.ok);
    assert.equal(failures.length, 0, failures.map((f) => f.label).join('; '));
  });

  it('builds byte-identical JSON on repeat builds', () => {
    const a = JSON.stringify(validWf());
    const b = JSON.stringify(validWf());
    assert.equal(a, b);
  });

  it('generated artifact matches a fresh build (byte-for-byte)', () => {
    const onDisk = fs.readFileSync(H.harnessWorkflowPath(), 'utf8');
    assert.equal(`${JSON.stringify(validWf(), null, 2)}\n`, onDisk);
  });

  it('frozen workflow artifact hash is unchanged', () => {
    const raw = fs.readFileSync(H.frozenWorkflowPath(), 'utf8');
    assert.equal(shaLines(raw), FROZEN_SHA);
  });

  it('Read Response Log carries the documented empty-read continuation flag (alwaysOutputData)', () => {
    const wf = validWf();
    const rrl = wf.nodes.find((n) => n.name === 'Read Response Log');
    assert.equal(rrl.alwaysOutputData, true);
    const frozenRrl = H.loadFrozenWorkflow().nodes.find((n) => n.name === 'Read Response Log');
    assert.equal(frozenRrl.alwaysOutputData, undefined, 'frozen node must not carry the flag');
    const failures = H.checkHarnessContract(wf).filter((c) => !c.ok);
    assert.equal(failures.length, 0, failures.map((f) => f.label).join('; '));
  });

  it('a continuation flag on a non-exception spliced node is rejected', () => {
    const wf = validWf();
    wf.nodes.find((n) => n.name === 'Response Interpretation Complete').alwaysOutputData = true;
    assert.ok(
      H.checkHarnessContract(wf).some((c) => c.label.includes('alwaysOutputData') && !c.ok),
      'Response Interpretation Complete alwaysOutputData must fail strict frozen equality',
    );
  });

  it('webhook URL uses the corrected single-segment path (no workflow id)', () => {
    assert.equal(
      H.harnessWebhookUrl('https://n8n.example.local/'),
      `https://n8n.example.local/webhook/${H.HARNESS_WEBHOOK_PATH}`,
    );
    assert.ok(!H.harnessWebhookUrl('https://n8n.example.local/', undefined, 'production').includes(PROD_WORKFLOW_ID));
  });
});

describe('Phase 6.5 revision — harnessWebhookUrl construction', () => {
  it('strips a trailing slash from the base URL', () => {
    const a = H.harnessWebhookUrl('https://n8n.example.local/', H.HARNESS_WEBHOOK_PATH, 'production');
    const b = H.harnessWebhookUrl('https://n8n.example.local', H.HARNESS_WEBHOOK_PATH, 'production');
    assert.equal(a, b);
    assert.equal(a, `https://n8n.example.local/webhook/${H.HARNESS_WEBHOOK_PATH}`);
  });

  it('production mode mounts at /webhook/<path>', () => {
    assert.equal(
      H.harnessWebhookUrl('http://localhost:5678', H.HARNESS_WEBHOOK_PATH, 'production'),
      'http://localhost:5678/webhook/test/resp-int-harness',
    );
  });

  it('test mode mounts at /webhook-test/<path>', () => {
    assert.equal(
      H.harnessWebhookUrl('http://localhost:5678', H.HARNESS_WEBHOOK_PATH, 'test'),
      'http://localhost:5678/webhook-test/test/resp-int-harness',
    );
  });

  it('strips a leading slash on the path', () => {
    assert.equal(
      H.harnessWebhookUrl('http://localhost:5678', '/test/resp-int-harness', 'production'),
      'http://localhost:5678/webhook/test/resp-int-harness',
    );
  });

  it('the workflow id is never part of the URL for any mode or path', () => {
    for (const mode of ['production', 'test']) {
      for (const path of ['test/resp-int-harness', 'other/path']) {
        const url = H.harnessWebhookUrl('http://localhost:5678', path, mode);
        assert.ok(!url.includes(PROD_WORKFLOW_ID), `${mode}/${path}`);
        assert.ok(!url.includes(H.HARNESS_WORKFLOW_ID), `${mode}/${path}`);
        assert.ok(!url.includes('/webhook/webhook'), `double segment leak: ${mode}/${path}`);
      }
    }
  });

  it('mode defaults to production when omitted', () => {
    assert.equal(
      H.harnessWebhookUrl('http://localhost:5678'),
      'http://localhost:5678/webhook/test/resp-int-harness',
    );
  });
});

describe('Phase 6.5 harness contract — mutation negatives', () => {
  it('rejects a missing node', () => {
    const wf = validWf();
    wf.nodes = wf.nodes.filter((n) => n.name !== 'Read Reconciliation Report');
    assert.ok(H.checkHarnessContract(wf).some((c) => !c.ok));
  });

  it('rejects a renamed node', () => {
    const wf = validWf();
    wf.nodes.find((n) => n.name === 'Webhook').name = 'Ingress';
    assert.ok(H.checkHarnessContract(wf).some((c) => !c.ok));
  });

  it('rejects a wrong webhook path or responseMode', () => {
    const wf = validWf();
    wf.nodes.find((n) => n.name === 'Webhook').parameters.path = 'test/other';
    assert.ok(H.checkHarnessContract(wf).some((c) => !c.ok));
    const wf2 = validWf();
    wf2.nodes.find((n) => n.name === 'Webhook').parameters.responseMode = 'onReceived';
    assert.ok(H.checkHarnessContract(wf2).some((c) => !c.ok));
  });

  it('rejects a tampered bridge jsCode', () => {
    const wf = validWf();
    wf.nodes.find((n) => n.name === 'Manual Trigger').parameters.jsCode = 'return [{ json: $input.first().json };';
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'bridge: flatten-body jsCode exact' && !c.ok));
  });

  it('rejects a second credentials-bearing node', () => {
    const wf = validWf();
    wf.nodes.find((n) => n.name === 'Read Reconciliation Report').credentials = { googleSheetsOAuth2Api: H.HARNESS_PROVIDER_CREDENTIAL };
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'exactly one credentials-bearing node (Read Response Log)' && !c.ok));
  });

  it('rejects a credential block carrying secret key material', () => {
    const wf = validWf();
    const rrl = wf.nodes.find((n) => n.name === 'Read Response Log');
    rrl.credentials.googleSheetsOAuth2Api.data = { accessToken: 'ya29.fake' };
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'credential ref is reference-only ({id,name})' && !c.ok));
  });

  it('rejects a secret value pattern anywhere in the serialized workflow', () => {
    const wf = validWf();
    wf.meta = { artifact: H.HARNESS_ARTIFACT, note: 'sk-testABC1234567890XYZ' };
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'no secret value patterns' && !c.ok));
  });

  it('rejects a broken chain order', () => {
    const wf = validWf();
    wf.connections['Read Reconciliation Report'] = { main: [[{ node: 'Interpret Responses', type: 'main', index: 0 }]] };
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'strict 6-node linear chain order' && !c.ok));
  });

  it('rejects a wrong workflow id or an active workflow', () => {
    const wf = validWf();
    wf.id = 'otherId123';
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label === 'workflow-level id present and deterministic' && !c.ok));
    const wf2 = validWf();
    wf2.active = true;
    assert.ok(H.checkHarnessContract(wf2).some((c) => c.label === 'workflow inactive (active=false)' && !c.ok));
  });

  it('rejects a banned node type injected into the chain', () => {
    const wf = validWf();
    wf.nodes.splice(2, 0, { name: 'Bad Node', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [0, 0] });
    assert.ok(H.checkHarnessContract(wf).some((c) => c.label.includes('no provider/AI/output/scheduler nodes') && !c.ok));
  });
});

describe('Phase 6.5 harness backend selection', () => {
  it('readConfig: harness backend selected and readiness gated on harness baseUrl + workflowId', () => {
    const c = R.readConfig(ENV_HARNESS);
    assert.equal(c.exec.backend, 'harness');
    assert.equal(c.exec.harness.ready, true);
    assert.equal(c.exec.ready, true);
    assert.equal(c.exec.harness.workflowId, H.HARNESS_WORKFLOW_ID);
    assert.equal(c.exec.harness.webhookPath, 'test/resp-int-harness');
    assert.equal(c.exec.harness.webhookMode, 'production');
    const missing = R.readConfig({ ...ENV_HARNESS, RESP_INT_HARNESS_WORKFLOW_ID: '' });
    assert.equal(missing.exec.harness.ready, false);
    assert.equal(missing.exec.ready, false);
  });

  it('readConfig: a set N8N_WORKFLOW_ID alone never satisfies the harness', () => {
    const cfg = R.readConfig({
      RESP_INT_EXEC_BACKEND: 'harness',
      RESP_INT_HARNESS_BASE_URL: 'http://localhost:5678',
      N8N_WORKFLOW_ID: PROD_WORKFLOW_ID,
    });
    assert.equal(cfg.exec.harness.workflowId, '');
    assert.equal(cfg.exec.harness.ready, false);
  });

  it('readConfig: RESP_INT_HARNESS_BASE_URL wins; N8N_BASE_URL is the fallback', () => {
    const cfg = R.readConfig({
      RESP_INT_EXEC_BACKEND: 'harness',
      N8N_BASE_URL: 'http://fallback:5678',
      RESP_INT_HARNESS_BASE_URL: 'http://dedicated:5678',
      RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
    });
    assert.equal(cfg.exec.harness.baseUrl, 'http://dedicated:5678');
    const fallback = R.readConfig({
      RESP_INT_EXEC_BACKEND: 'harness',
      N8N_BASE_URL: 'http://fallback:5678',
      RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
    });
    assert.equal(fallback.exec.harness.baseUrl, 'http://fallback:5678');
    assert.equal(fallback.exec.harness.ready, true);
    assert.equal(fallback.exec.ready, true);
  });

  it('readConfig: webhook path and mode default to the harness constants', () => {
    const cfg = R.readConfig({
      RESP_INT_EXEC_BACKEND: 'harness',
      N8N_BASE_URL: 'http://localhost:5678',
      RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
    });
    assert.equal(cfg.exec.harness.webhookPath, H.HARNESS_WEBHOOK_PATH);
    assert.equal(cfg.exec.harness.webhookMode, H.HARNESS_WEBHOOK_MODE_PRODUCTION);
    const custom = R.readConfig({
      RESP_INT_EXEC_BACKEND: 'harness',
      N8N_BASE_URL: 'http://localhost:5678',
      RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
      RESP_INT_HARNESS_WEBHOOK_PATH: 'other/path',
      RESP_INT_HARNESS_WEBHOOK_MODE: 'test',
    });
    assert.equal(custom.exec.harness.webhookPath, 'other/path');
    assert.equal(custom.exec.harness.webhookMode, 'test');
  });

  it('effectiveExecBackend: injectScenario forces harness; env harness wins; else cli', () => {
    const cfg = R.readConfig({});
    assert.equal(R.effectiveExecBackend({ injectScenario: true }, cfg), 'harness');
    assert.equal(R.effectiveExecBackend({}, R.readConfig(ENV_HARNESS)), 'harness');
    assert.equal(R.effectiveExecBackend({}, cfg), 'cli');
  });

  it('parseArgs: --inject-scenario is accepted and stored', () => {
    assert.equal(R.parseArgs(['--inject-scenario']).injectScenario, true);
    assert.equal(R.parseArgs([]).injectScenario, false);
  });

  it('usage documents the harness backend', () => {
    const u = R.usage();
    assert.ok(u.includes('cli|http|harness'));
    assert.ok(u.includes('--inject-scenario'));
  });
});

describe('Phase 6.5 harness backend — execute/collect/verify wiring', () => {
  it('execute POSTs the scenario payload to the versioned webhook and passes the capture through', async () => {
    const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    let seen;
    const r = await R.execute(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, json: async () => expected };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(r.executionId, '');
    assert.deepEqual(r.collected, expected);
    assert.equal(seen.url, `https://n8n.example.local/webhook/${H.HARNESS_WEBHOOK_PATH}`);
    assert.ok(!seen.url.includes(PROD_WORKFLOW_ID), 'production workflow id must not appear in the harness URL');
    assert.equal(seen.opts.method, 'POST');
    assert.ok(!('X-N8N-API-KEY' in seen.opts.headers));
    assert.deepEqual(JSON.parse(seen.opts.body), buildScenarioPayload('TEST-RESP-INT-001', NS));
  });

  it('execute harness: unset RESP_INT_HARNESS_WORKFLOW_ID is NOT_CONFIGURED and never uses N8N_WORKFLOW_ID', async () => {
    let hit = false;
    const env = { ...ENV_HARNESS, RESP_INT_HARNESS_WORKFLOW_ID: '' };
    const r = await R.execute(env, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async () => { hit = true; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    assert.equal(r.status, 'NOT_CONFIGURED');
    assert.ok(r.detail.includes('RESP_INT_HARNESS_WORKFLOW_ID'));
    assert.ok(!r.detail.includes('N8N_WORKFLOW_ID = '));
    assert.equal(hit, false, 'no request may be made without the harness workflow id');
    assert.equal(r.executionId, null);
  });

  it('execute harness: unset base URL (no N8N_BASE_URL fallback) is NOT_CONFIGURED', async () => {
    const r = await R.execute(
      { ...ENV_HARNESS, RESP_INT_HARNESS_BASE_URL: '', N8N_BASE_URL: '' },
      { scenario: 'TEST-RESP-INT-001', runToken: TOKEN },
      { transport: async () => { throw new Error('must not be called'); } },
    );
    assert.equal(r.status, 'NOT_CONFIGURED');
    assert.ok(r.detail.includes('RESP_INT_HARNESS_BASE_URL'));
  });

  it('execute harness: N8N_BASE_URL is used as the base fallback and the corrected URL is POSTed', async () => {
    let seen;
    const env = {
      ...ENV_HARNESS,
      RESP_INT_HARNESS_BASE_URL: '',
      RESP_INT_HARNESS_WORKFLOW_ID: H.HARNESS_WORKFLOW_ID,
    };
    const r = await R.execute(env, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, json: async () => R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS) };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(seen.url, 'https://n8n.example.local/webhook/test/resp-int-harness');
  });

  it('execute harness: webhookMode=test targets /webhook-test/<path>', async () => {
    let seen;
    const env = {
      ...ENV_HARNESS,
      RESP_INT_HARNESS_WEBHOOK_MODE: 'test',
      N8N_WORKFLOW_ID: PROD_WORKFLOW_ID,
    };
    const r = await R.execute(env, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, json: async () => R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS) };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(seen.url, 'https://n8n.example.local/webhook-test/test/resp-int-harness');
    assert.ok(!seen.url.includes(PROD_WORKFLOW_ID));
  });

  it('normalizeHarnessResponse unwraps a single-item array and rejects other shapes', () => {
    assert.equal(R.normalizeHarnessResponse(null), null);
    assert.deepEqual(R.normalizeHarnessResponse({ status: 'COMPLETED', results: [] }), { status: 'COMPLETED', results: [] });
    assert.deepEqual(R.normalizeHarnessResponse([{ status: 'COMPLETED', results: [] }]), { status: 'COMPLETED', results: [] });
    assert.equal(R.normalizeHarnessResponse([]), null);
    assert.equal(R.normalizeHarnessResponse([{}, {}]), null);
    assert.equal(R.normalizeHarnessResponse('nope'), null);
  });

  it('execute harness: a non-ok webhook response is FAIL', async () => {
    const r = await R.execute(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async () => ({ ok: false, status: 404, text: async () => 'webhook not found' }),
    });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.detail.includes('404'));
  });

  it('execute harness: a transport throw is FAIL, never a claim', async () => {
    const r = await R.execute(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.detail.includes('ECONNREFUSED'));
  });

  it('execute harness: an unparseable webhook body is NOT_CONFIGURED', async () => {
    const r = await R.execute(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }),
    });
    assert.equal(r.status, 'NOT_CONFIGURED');
  });

  it('execute harness: a body that is no report is NOT_CONFIGURED', async () => {
    const r = await R.execute(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async () => ({ ok: true, status: 200, json: async () => null }),
    });
    assert.equal(r.status, 'NOT_CONFIGURED');
  });

  it('collect reuses the harness capture and reports NOT_CONFIGURED without one', async () => {
    const collected = { status: 'COMPLETED', results: [] };
    const r = await R.collect(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001', _harnessCollected: collected }, {});
    assert.equal(r.status, 'PASS');
    assert.equal(r.collected, collected);
    const none = await R.collect(ENV_HARNESS, { scenario: 'TEST-RESP-INT-001' }, {});
    assert.equal(none.status, 'NOT_CONFIGURED');
  });
});

describe('Phase 6.5 executeFailureInfo banner-strip regression', () => {
  it('parses an error payload out of banner/noise lines', () => {
    const payload = {
      data: {
        resultData: {
          error: {
            name: 'ExpressionError',
            message: "Node 'Read Reconciliation Report' hasn't been executed",
            context: { nodeCause: 'Interpret Responses', lastNodeExecuted: 'Interpret Responses' },
          },
        },
      },
    };
    const noisy = `Starting workflow execution...\n${JSON.stringify(payload)}\nExecution took 42ms\n`;
    const info = R.executeFailureInfo(noisy);
    assert.equal(info.stage, 'execute');
    assert.equal(info.name, 'ExpressionError');
    assert.equal(info.message, "Node 'Read Reconciliation Report' hasn't been executed");
    assert.equal(info.nodeCause, 'Interpret Responses');
  });

  it('keeps the existing empty/noise semantics', () => {
    assert.equal(R.executeFailureInfo(''), null);
    assert.equal(R.executeFailureInfo('  \n'), null);
    const info = R.executeFailureInfo('workflow exited; no structured output');
    assert.equal(info.name, 'UnparseableOutput');
  });
});

describe('Phase 6.5 full run orchestration (offline, harness backend)', () => {
  it('seed -> execute(harness) -> collect -> verify -> cleanup all PASS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-int-harness-'));
    const mock = new MockSheets();
    mock.addTab(R.RESPONSE_TAB, [R.RESPONSE_COLUMNS.slice()]);
    const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    const r = await R.fullRun(
      ENV_HARNESS,
      { scenario: 'TEST-RESP-INT-001', runToken: TOKEN, execute: true, reportsDir: dir },
      {
        client: mock,
        transport: async () => ({ ok: true, status: 200, json: async () => expected }),
      },
    );
    assert.equal(r.stages.preflight, 'PASS');
    assert.equal(r.stages.seed, 'PASS');
    assert.equal(r.stages.execute, 'PASS');
    assert.equal(r.stages.collect, 'PASS');
    assert.equal(r.stages.verify_input, 'PASS');
    assert.equal(r.stages.cleanup, 'PASS');
    assert.equal(r.stages.verify_cleanup, 'PASS');
    assert.equal(r.status, 'PASS');
    const report = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
    assert.equal(report.execution.backend, 'harness');
    assert.ok(report.execution.webhook_path.includes(H.HARNESS_WEBHOOK_PATH));
    assert.equal(report.execution.webhook_mode, 'production');
    assert.equal(report.execution.workflow_id, H.HARNESS_WORKFLOW_ID);
    assert.ok(!report.execution.workflow_id.includes(PROD_WORKFLOW_ID));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 6.5 artifact hygiene (report-level)', () => {
  it('harness artifact contains no frozen drift and no forbidden keys', () => {
    const raw = JSON.stringify(validWf(), null, 2);
    assert.ok(!/access_?token|refresh_?token|api[_-]?key|password|authorization|oauthTokenData/.test(raw));
    assert.ok(!/sk-|AKIA|ya29\.|-----BEGIN|process\.env|\$\{?env\./.test(raw));
  });

  it('manifest fidelity: frozen artifact still matches the pinned sha', () => {
    assert.equal(ARTIFACT, 'Response-Interpretation V1');
    assert.equal(shaLines(fs.readFileSync(H.frozenWorkflowPath(), 'utf8')), FROZEN_SHA);
  });
});