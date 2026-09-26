'use strict';

/* Phase 5 revision — execution backend (cli/http) coverage for the live runner.
 * Complements tests/response-interpretation-live-runner.test.js; nothing here
 * touches the frozen engine artifacts or the shipped workflow.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('../src/response-interpretation-live-runner');
const { MockSheets } = require('../src/mock-sheets');
const { SPREADSHEET_ID, WORKFLOW_NAME } = require('../src/response-interpretation-workflow-contract');

const TOKEN = '00aa11bb22cc';
const NS = 'TEST-RESP-INT-LIVE-00aa11bb22cc';
const CONTAINER = 'serene_swartz';
const WORKFLOW_ID = 'gLzXBltBMeVcUIEN';
const BROKER_PORT = '5677';

const ENV_CLI = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
  RESP_INT_LIVE_RUN_TOKEN: TOKEN,
  RESP_INT_EXEC_BACKEND: 'cli',
  RESP_INT_EXEC_CONTAINER: CONTAINER,
  RESP_INT_EXEC_BROKER_PORT: BROKER_PORT,
  N8N_BASE_URL: 'https://n8n.example.local',
  N8N_API_KEY: 'test-n8n-key',
  N8N_WORKFLOW_ID: WORKFLOW_ID,
};

const ENV_HTTP = {
  GOOGLE_SHEET_ID: SPREADSHEET_ID,
  GOOGLE_ACCESS_TOKEN: 'test-token',
  RESP_INT_LIVE_RUN_TOKEN: TOKEN,
  RESP_INT_EXEC_BACKEND: 'http',
  N8N_BASE_URL: 'https://n8n.example.local',
  N8N_API_KEY: 'test-n8n-key',
  N8N_WORKFLOW_ID: WORKFLOW_ID,
};

function interpretPayload(expected) {
  return {
    data: {
      resultData: {
        runData: { 'Interpret Responses': [{ data: { main: [[{ json: expected }]] } }] },
      },
    },
  };
}

describe('execution backend selection via env', () => {
  it('defaults to cli when RESP_INT_EXEC_BACKEND is unset or empty', () => {
    assert.equal(R.readConfig({}).exec.backend, 'cli');
    assert.equal(R.readConfig({ RESP_INT_EXEC_BACKEND: '' }).exec.backend, 'cli');
  });

  it('selects http when RESP_INT_EXEC_BACKEND=http (case-insensitive)', () => {
    assert.equal(R.readConfig({ RESP_INT_EXEC_BACKEND: 'http' }).exec.backend, 'http');
    assert.equal(R.readConfig({ RESP_INT_EXEC_BACKEND: 'HTTP' }).exec.backend, 'http');
  });

  it('resolves unknown values to the cli default and surfaces the raw value', () => {
    const c = R.readConfig({ RESP_INT_EXEC_BACKEND: 'ftp' });
    assert.equal(c.exec.backend, 'cli');
    assert.equal(c.exec.backendRaw, 'ftp');
    assert.equal(R.normalizeExecBackend('ftp'), 'cli');
  });

  it('readiness follows the selected backend', () => {
    assert.equal(R.readConfig(ENV_CLI).exec.ready, true);
    assert.equal(R.readConfig(ENV_HTTP).exec.ready, true);
    assert.equal(R.readConfig({ RESP_INT_EXEC_BACKEND: 'cli', N8N_BASE_URL: 'x', N8N_API_KEY: 'y', N8N_WORKFLOW_ID: 'z' }).exec.ready, false);
    assert.equal(R.readConfig({ RESP_INT_EXEC_BACKEND: 'http', RESP_INT_EXEC_CONTAINER: CONTAINER, RESP_INT_EXEC_BROKER_PORT: BROKER_PORT, N8N_WORKFLOW_ID: 'z' }).exec.ready, false);
  });
});

describe('CLI mode command construction', () => {
  it('builds the exact docker exec argv with broker port and no shell', () => {
    const cli = R.readConfig(ENV_CLI).exec.cli;
    assert.deepEqual(R.buildCliCommand(cli), [
      'docker',
      'exec',
      '-u',
      'node',
      '-e',
      `N8N_RUNNERS_BROKER_PORT=${BROKER_PORT}`,
      CONTAINER,
      'n8n',
      'execute',
      '--id',
      WORKFLOW_ID,
    ]);
  });

  it('rejects a missing container, broker port, or workflow id', () => {
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_CONTAINER: '' }).exec.cli), /RESP_INT_EXEC_CONTAINER is required/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: '' }).exec.cli), /RESP_INT_EXEC_BROKER_PORT is required/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, N8N_WORKFLOW_ID: '' }).exec.cli), /N8N_WORKFLOW_ID is required/);
  });
});

describe('CLI mode injection hardening', () => {
  it('rejects shell metacharacters in container names', () => {
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_CONTAINER: 'serene_swartz; rm -rf /' }).exec.cli), /container-name charset/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_CONTAINER: '$(id)' }).exec.cli), /container-name charset/);
  });

  it('rejects shell metacharacters in the workflow id', () => {
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, N8N_WORKFLOW_ID: 'x;id' }).exec.cli), /must match/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, N8N_WORKFLOW_ID: 'x(1)' }).exec.cli), /must match/);
  });

  it('rejects non-numeric, out-of-range, and server-colliding broker ports', () => {
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: '5679' }).exec.cli), /collides with the running n8n server/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: 'abc;rm' }).exec.cli), /numeric port/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: '0' }).exec.cli), /integer in 1\.\.65535/);
    assert.throws(() => R.buildCliCommand(R.readConfig({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: '70000' }).exec.cli), /integer in 1\.\.65535/);
  });
});

describe('CLI mode exit-code mapping', () => {
  it('maps exit 0 to PASS', () => {
    assert.equal(R.mapCliExitCode(0).status, 'PASS');
  });

  it('maps non-zero exits to FAIL with the code in the detail', () => {
    assert.equal(R.mapCliExitCode(1).status, 'FAIL');
    assert.ok(R.mapCliExitCode(2).detail.includes('2'));
  });

  it('maps a null/signal-terminated exit to FAIL', () => {
    assert.equal(R.mapCliExitCode(null).status, 'FAIL');
    assert.ok(R.mapCliExitCode(undefined).detail.includes('signal'));
  });
});

describe('CLI mode stdout parsing', () => {
  it('parses a bare JSON execution payload from stdout', () => {
    const payload = interpretPayload({ status: 'COMPLETED', results: [] });
    const parsed = R.parseExecuteStdout(JSON.stringify(payload));
    assert.ok(parsed && typeof parsed === 'object');
    assert.ok(parsed.data.resultData.runData['Interpret Responses']);
  });

  it('parses a JSON payload embedded in log noise', () => {
    const payload = interpretPayload({ status: 'COMPLETED', results: [] });
    const noisy = `[runner] starting\nDebug output line\n${JSON.stringify(payload)}\ntrailing\n`;
    const parsed = R.parseExecuteStdout(noisy);
    assert.ok(parsed && typeof parsed === 'object');
  });

  it('returns null for empty or noise-only output', () => {
    assert.equal(R.parseExecuteStdout(''), null);
    assert.equal(R.parseExecuteStdout('  \n'), null);
    assert.equal(R.parseExecuteStdout('workflow ran, nothing structured here'), null);
    assert.equal(R.parseExecuteStdout('{ broken '), null);
  });

  it('extracts an execution id from the parsed payload when present', () => {
    assert.equal(R.executionIdFromPayload({ id: 'EX-CLI-1' }), 'EX-CLI-1');
    assert.equal(R.executionIdFromPayload({ executionId: 'EX-CLI-2' }), 'EX-CLI-2');
    assert.equal(R.executionIdFromPayload({ data: {} }), '');
  });
});

describe('executeShipped — CLI mode', () => {
  it('is NOT_CONFIGURED (exit-path) when container or broker port is missing', async () => {
    const noContainer = await R.execute({ ...ENV_CLI, RESP_INT_EXEC_CONTAINER: '' }, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {});
    assert.equal(noContainer.status, 'NOT_CONFIGURED');
    const noBroker = await R.execute({ ...ENV_CLI, RESP_INT_EXEC_BROKER_PORT: '' }, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {});
    assert.equal(noBroker.status, 'NOT_CONFIGURED');
    const defaultBackend = await R.execute({ ...ENV_HTTP, RESP_INT_EXEC_BACKEND: '' }, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {});
    assert.equal(defaultBackend.status, 'NOT_CONFIGURED');
  });

  it('spawns the validated command and captures stdout into a collected report', async () => {
    let seen;
    const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    const r = await R.execute(ENV_CLI, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      exec: async (argv) => {
        seen = argv;
        return { code: 0, stdout: JSON.stringify(interpretPayload(expected)), stderr: '' };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.deepEqual(seen, R.buildCliCommand(R.readConfig(ENV_CLI).exec.cli));
    assert.deepEqual(r.collected, expected);
  });

  it('reports FAIL with the stderr excerpt on a non-zero exit', async () => {
    const r = await R.execute(ENV_CLI, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      exec: async () => ({ code: 1, stdout: '', stderr: 'broker port in use' }),
    });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.detail.includes('broker port in use'));
  });

  it('reports FAIL when docker exec cannot be spawned', async () => {
    const r = await R.execute(ENV_CLI, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      exec: async () => { throw new Error('docker: command not found'); },
    });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.detail.includes('docker: command not found'));
  });

  it('is NOT_CONFIGURED when exit 0 but the Interpret output is not on stdout', async () => {
    const r = await R.execute(ENV_CLI, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      exec: async () => ({ code: 0, stdout: 'workflow executed; did not print JSON output', stderr: '' }),
    });
    assert.equal(r.status, 'NOT_CONFIGURED');
    assert.equal(r.executionId, '');
  });
});

describe('collectExecution — CLI mode reuses the execute-phase capture', () => {
  it('returns the already-captured report without re-running anything', async () => {
    const collected = { status: 'COMPLETED', results: [] };
    const args = { _cliCollected: collected, scenario: 'TEST-RESP-INT-001' };
    const r = await R.collect(ENV_CLI, args, {});
    assert.equal(r.status, 'PASS');
    assert.equal(r.collected, collected);
  });

  it('is NOT_CONFIGURED when nothing was captured and no REST config exists', async () => {
    const r = await R.collect(ENV_CLI, { scenario: 'TEST-RESP-INT-001' }, {});
    assert.equal(r.status, 'NOT_CONFIGURED');
  });
});

describe('HTTP mode — existing behavior preserved', () => {
  it('execute still POSTs workflowData + trigger input to /api/v1/executions', async () => {
    let seen;
    const r = await R.execute(ENV_HTTP, { scenario: 'TEST-RESP-INT-001', runToken: TOKEN }, {
      transport: async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200, json: async () => ({ id: 'EX-42' }) };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.equal(r.executionId, 'EX-42');
    assert.ok(seen.url.endsWith('/api/v1/executions'));
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers['X-N8N-API-KEY'], 'test-n8n-key');
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.workflowData.name, WORKFLOW_NAME);
    assert.ok(body.data.reconciliation_report.results.length === 1);
  });

  it('collect still GETs /api/v1/executions/<id> and extracts the Interpret report', async () => {
    let seenUrl;
    const r = await R.collect(ENV_HTTP, { executionId: 'EX-42', scenario: 'TEST-RESP-INT-001' }, {
      transport: async (url) => {
        seenUrl = url;
        return { ok: true, status: 200, json: async () => ({ data: { resultData: { runData: { 'Interpret Responses': [{ data: { main: [[{ json: { status: 'COMPLETED', results: [] } }]] } }] } } } }) };
      },
    });
    assert.equal(r.status, 'PASS');
    assert.ok(seenUrl.endsWith('/api/v1/executions/EX-42'));
    assert.deepEqual(r.collected, { status: 'COMPLETED', results: [] });
  });
});

describe('full CLI run orchestration (no network)', () => {
  it('seed -> execute -> collect -> verify -> cleanup all PASS with a mocked docker exec', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-int-cli-'));
    const mock = new MockSheets();
    mock.addTab(R.RESPONSE_TAB, [R.RESPONSE_COLUMNS.slice()]);
    const expected = R.expectedReportFor(R.resolveScenario('TEST-RESP-INT-001'), NS);
    const r = await R.fullRun(
      ENV_CLI,
      { scenario: 'TEST-RESP-INT-001', runToken: TOKEN, execute: true, reportsDir: dir },
      {
        client: mock,
        exec: async () => ({ code: 0, stdout: JSON.stringify(interpretPayload(expected)), stderr: '' }),
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
    assert.equal(mock.listRows(R.RESPONSE_TAB).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});