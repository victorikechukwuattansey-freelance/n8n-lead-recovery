'use strict';

/*
 * Response Interpretation V1 — scenario payload builder (Phase 6.5).
 *
 * Self-contained, pure module that renders the exact Manual Trigger input the
 * LIVE runner would inject for a given scenario, WITHOUT importing the runner
 * (no circular dependency) and WITHOUT reading env, argv, or the network.
 *
 * The runner has the authoritative helpers (resolveScenario, projectedFixtureFor,
 * injectedReportFor, injectedTriggerInputFor) used by its cli/http backends.
 * Mechanism B (webhook payload injection) needs the SAME trigger input to be
 * POSTed to the test harness workflow. That input is reproduced here as an
 * independent implementation so a parity test can prove the webhook backend
 * receives byte-identical trigger data to the cli/http path.
 *
 * Rule: this module must never grow runner-specific behavior. Every helper is a
 * faithful mirror of the runner's projection; tests/response-interpretation-
 * phase-6-5.test.js pins buildScenarioPayload deep-equal to the runner's
 * injectedTriggerInputFor across all 27 fixtures + 5 failure keys.
 */

const { reconcileResponses } = require('./response-reconcile');
const { loadResponseInterpretationFixtures } = require('./response-interpretation-fixtures');
const { FIXED_NOW } = require('./response-interpretation-workflow-contract');

const RESP_INT_LIVE_NAMESPACE = 'TEST-RESP-INT-LIVE';
const DEFAULT_SCENARIO = 'TEST-RESP-INT-001';
const FIXTURE_REPORT_RUN_ID = 'RESPRECON-LIVE-FIXED';

const SCENARIO_FAILURE_KEYS = [
  'empty',
  'response-log-failure',
  'reconciliation-failure',
  'upstream-incomplete',
  'double-failure',
];

function pad3(n) {
  return String(n).padStart(3, '0');
}

/* ------------------------- scenario resolution ----------------------- */

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

/* ------------------- namespaced projection (pure) -------------------- */

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

/* ----------------------- trigger input injection --------------------- */

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

/*
 * The single public entry point for the harness backend. `ns` is the
 * namespace-qualified run token ('' = canonical/unqualified, matching the
 * runner's degenerate case). Deterministic: identical inputs produce identical
 * payloads.
 */
function buildScenarioPayload(scenarioId, ns) {
  const resolved = resolveScenario(scenarioId);
  return injectedTriggerInputFor(resolved, String(ns || '').trim());
}

module.exports = {
  RESP_INT_LIVE_NAMESPACE,
  DEFAULT_SCENARIO,
  FIXTURE_REPORT_RUN_ID,
  SCENARIO_FAILURE_KEYS,
  pad3,
  syntheticFixture,
  validScenarioIds,
  resolveScenario,
  buildIdMaps,
  projectResponseRow,
  projectOutreachRow,
  projectedFixtureFor,
  injectedReportFor,
  injectedTriggerInputFor,
  buildScenarioPayload,
};