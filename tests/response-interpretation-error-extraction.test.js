'use strict';

/*
 * Phase 5.4 regression tests: runner error surfacing.
 *
 * The pre-5.4 empirical failure produced a NON-zero `n8n execute` exit and the
 * runner only reported "execute failed (exit code N)" — the raw ExpressionError
 * (message "Node 'Read Reconciliation Report' hasn't been executed",
 * descriptionKey pairedItemNoConnectionCodeNode) lived in the CLI stdout and
 * was discarded. These tests lock `executeFailureInfo` (the structured
 * extractor), its redaction, and the full-run recording path so raw execution
 * errors reach `failure_info` instead of dying in an exit-code detail string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  executeFailureInfo,
  executeCli,
  redact,
  buildRunReport,
} = require('../src/response-interpretation-live-runner');

const EXPRESSION_ERROR_PAYLOAD = JSON.stringify({
  data: {
    resultData: {
      error: {
        message: "Node 'Read Reconciliation Report' hasn't been executed",
        descriptionKey: 'pairedItemNoConnectionCodeNode',
        context: {
          nodeCause: 'Read Reconciliation Report',
          lastNodeExecuted: 'Read Response Log',
        },
      },
    },
  },
});

const CONFIG = {
  exec: { cli: { container: 'n8n.test', brokerPort: '5677', workflowId: 'wf-chain' } },
};

test('executeFailureInfo returns null on empty stdout', () => {
  assert.equal(executeFailureInfo(''), null);
  assert.equal(executeFailureInfo('   \n  '), null);
});

test('executeFailureInfo extracts name, message, and both context fields from an n8n execution error', () => {
  const info = executeFailureInfo(EXPRESSION_ERROR_PAYLOAD);
  assert.deepEqual(info, {
    stage: 'execute',
    name: 'ExecutionError',
    message: "Node 'Read Reconciliation Report' hasn't been executed",
    nodeCause: 'Read Reconciliation Report',
    lastNodeExecuted: 'Read Response Log',
  });
});

test('executeFailureInfo preserves the n8n-reported error name when present', () => {
  const info = executeFailureInfo(
    JSON.stringify({
      data: { resultData: { error: { name: 'ExpressionError', message: 'boom' } } },
    }),
  );
  assert.equal(info.name, 'ExpressionError');
  assert.equal(info.message, 'boom');
  assert.equal(info.stage, 'execute');
});

test('executeFailureInfo returns null when the payload has no runtime error (success-shaped stdout)', () => {
  assert.equal(executeFailureInfo(JSON.stringify({ data: { resultData: {} } })), null);
  assert.equal(executeFailureInfo(JSON.stringify({ ok: true })), null);
  assert.equal(executeFailureInfo(JSON.stringify({ data: { resultData: { runData: {} } } })), null);
});

test('executeFailureInfo maps malformed stdout to UnparseableOutput, truncated', () => {
  const info = executeFailureInfo('x'.repeat(500));
  assert.equal(info.stage, 'execute');
  assert.equal(info.name, 'UnparseableOutput');
  assert.ok(info.message.includes('not JSON'));
  assert.ok(info.message.length < 400, 'message must be truncated well below the raw stdout');
});

test('redact masks secret material even inside extracted failure text', () => {
  const leaking = 'raw dump: Authorization: Bearer AbCdEfGh1234567890xyz unrecoverable';
  const info = executeFailureInfo(leaking);
  assert.equal(info.name, 'UnparseableOutput');
  assert.ok(info.message.includes('AbCdEfGh1234567890xyz'), 'extractor keeps raw text for diagnosis');
  const masked = redact(info);
  assert.ok(!masked.message.includes('AbCdEfGh1234567890xyz'), 'redacted report hides the token');
  assert.ok(masked.message.includes('<redacted>'));
});

test('redact masks JWT-shaped secrets', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.ok(redact(`token ${jwt}`).includes('<redacted>'));
  assert.ok(!redact(`token ${jwt}`).includes('eyJhbGci'));
});

test('executeCli FAIL carries the structured failure for the orchestrator', async () => {
  const deps = {
    exec: async () => ({ code: 1, stdout: EXPRESSION_ERROR_PAYLOAD, stderr: '' }),
  };
  const res = await executeCli({}, {}, deps, CONFIG);
  assert.equal(res.status, 'FAIL');
  assert.deepEqual(res.failure, {
    stage: 'execute',
    name: 'ExecutionError',
    message: "Node 'Read Reconciliation Report' hasn't been executed",
    nodeCause: 'Read Reconciliation Report',
    lastNodeExecuted: 'Read Response Log',
  });
});

test('executeCli FAIL on a spawn error has detail only (nothing to extract)', async () => {
  const deps = {
    exec: async () => {
      throw new Error('spawn ENOENT');
    },
  };
  const res = await executeCli({}, {}, deps, CONFIG);
  assert.equal(res.status, 'FAIL');
  assert.match(res.detail, /spawn failed/);
  assert.equal(res.failure, undefined);
});

test('buildRunReport records structured failures into failure_info unchanged', () => {
  const entry = {
    stage: 'execute',
    name: 'ExpressionError',
    message: "Node 'Read Reconciliation Report' hasn't been executed",
    nodeCause: 'Read Reconciliation Report',
    lastNodeExecuted: 'Read Response Log',
  };
  const report = buildRunReport({
    args: {},
    env: {},
    outcomes: { stages: {}, failures: [entry] },
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: '2026-09-13T00:00:00.000Z',
  });
  assert.deepEqual(report.failure_info, [entry]);
});

test('buildRunReport failure_info stays empty when the execute phase passes', () => {
  const report = buildRunReport({
    args: {},
    env: {},
    outcomes: { stages: { execute: 'PASS' }, failures: [] },
    startedAt: '2026-09-13T00:00:00.000Z',
    completedAt: '2026-09-13T00:00:00.000Z',
  });
  assert.deepEqual(report.failure_info, []);
});