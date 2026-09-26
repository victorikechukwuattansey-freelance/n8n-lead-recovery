'use strict';

/*
 * Response Interpretation V1 — TEST HARNESS contract (Phase 6.5).
 *
 * Definition, validation, and constants for the test-only harness workflow that
 * lets the live runner execute the FROZEN Response-Interpretation V1 chain via
 * webhook payload injection (Mechanism B, proven in §0 — see reports/PHASE-6.5
 * -REPORT.md).
 *
 * The harness differs from the shipped production workflow in EXACTLY the way
 * the boundary contract permits for a test surface:
 *   - a Webhook entry node (test path, POST, responseMode=lastNode) feeding a
 *     Code bridge named "Manual Trigger" (the frozen chain's trigger symbol);
 *   - the four frozen nodes (Read Reconciliation Report -> Read Response Log ->
 *     Interpret Responses -> Response Interpretation Complete) spliced in
 *     BYTE-IDENTICAL to `Response-Interpretation V1.json` EXCEPT the two
 *     documented modular allowances on Read Response Log listed below;
 *   - Read Response Log carries a credentials REFERENCE ({id, name} only — no
 *     secret material) because the in-container n8n instance must authenticate
 *     to the pinned spreadsheet;
 *   - Read Response Log ALSO sets alwaysOutputData=true — the ONLY harness-side
 *     flag deviation on a spliced node. The node reads the LIVE Response Log
 *     sheet; when the sheet has no data rows the googleSheets node emits an
 *     empty branch, and an empty main terminates the chain in n8n (downstream
 *     never runs, and responseMode=lastNode then 500s with "No item to return
 *     was found"). alwaysOutputData=true makes an empty successful read emit
 *     the input item instead, so the frozen Interpret Responses -> Complete
 *     chain always runs and the webhook returns a structured report. When data
 *     rows ARE present, the real (non-empty) output is used and behavior is
 *     byte-identical to the frozen node. Empirically verified end-to-end: see
 *     reports/PHASE-6-5-REVISION-REPORT.md §4.
 *
 * Hygiene rules enforced here:
 *   - the SPLICED nodes' type/typeVersion/parameters/id must equal the frozen
 *     artifact byte-for-byte (splice drift would break the comparison);
 *   - the ONLY flag a spliced node may change is alwaysOutputData -> true on
 *     Read Response Log (the empty-read continuation flag documented above);
 *     every other spliced node's alwaysOutputData must remain frozen-equal;
 *   - the only allowed credential reference is
 *     googleSheetsOAuth2Api -> {id, name} on Read Response Log; everything else
 *     is a FAIL (no data, oauthTokenData, accessToken, refreshToken, apiKey,
 *     password, authorization material anywhere in the artifact);
 *   - banned provider/AI/output nodes and strict 6-node linear-chain wiring;
 *   - $('X') code references are transitive pairedItem ancestors only;
 *   - code nodes pass the same assertCleanSource used everywhere else.
 *
 * This module is NOT the flow builder and does NOT write the artifact; it
 * defines the contract, loads both workflow JSONs read-only, and exposes
 * checkHarnessContract/assertHarnessContract plus the harness constants.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  ARTIFACT,
  BANNED_NODE_TYPES,
  SPREADSHEET_ID,
  assertCleanSource,
} = require('./response-interpretation-workflow-contract');

const HARNESS_ARTIFACT = 'Response-Interpretation V1 — Test Harness';
const HARNESS_WORKFLOW_ID = 'harnessRespIntV10000001';
const HARNESS_WEBHOOK_PATH = 'test/resp-int-harness';
const HARNESS_WEBHOOK_MODE_PRODUCTION = 'production';
const HARNESS_WEBHOOK_MODE_TEST = 'test';
const HARNESS_BRIDGE_NODE_NAME = 'Manual Trigger';
const HARNESS_BRIDGE_JAVASCRIPT = '\nreturn [{ json: (($input.first().json.body) || {}) }];\n';
const HARNESS_CREDENTIAL_TYPE = 'googleSheetsOAuth2Api';
/* Reference-only credential identity captured from the running container's
 * workflow_entity (serene_swartz): exactly one googleSheetsOAuth2Api credential
 * named "Google Sheets account". id + name are NOT secret material. */
const HARNESS_PROVIDER_CREDENTIAL = { id: 'Q2J6wmozbkk3NCTM', name: 'Google Sheets account' };

const HARNESS_NODE_NAMES = [
  'Webhook',
  'Manual Trigger',
  'Read Reconciliation Report',
  'Read Response Log',
  'Interpret Responses',
  'Response Interpretation Complete',
];

const SPLICED_NODE_NAMES = [
  'Read Reconciliation Report',
  'Read Response Log',
  'Interpret Responses',
  'Response Interpretation Complete',
];

/* Read Response Log is the ONLY spliced node allowed a harness-side flag:
 * alwaysOutputData=true (the empty-read continuation flag). The live sheet can
 * legitimately have zero data rows; an empty main terminates the frozen chain
 * in n8n and the webhook then 500s with "No item to return was found"
 * (verified empirically, reports/PHASE-6-5-REVISION-REPORT.md §4). Any node
 * NOT in this table keeps the strict frozen-equal alwaysOutputData check. */
const HARNESS_CONTINUATION_FLAG_NODES = ['Read Response Log'];

const HARNESS_WEBHOOK_NODE_ID = 'b619c17c-h000-4b2e-9a3c-000000000001';
const HARNESS_BRIDGE_NODE_ID = 'b619c17c-h000-4b2e-9a3c-000000000002';

/* Secret-material scan. The harness deliberately splices frozen code that
 * legitimately references response schema field names (response_text,
 * provider_message_id, sender, recipient) — those are NOT hygiene violations.
 * Hygiene here means: no embedded-secret KEYS (oAuth-ish / apiKey / password /
 * authorization / private key), no credential blocks beyond the one allowed
 * node, no secret VALUE patterns, no env interpolation, no bearer material. The
 * serialized scan runs AFTER the single allowed credentials block is removed,
 * so the word "credentials" must not appear anywhere else. */
const FORBIDDEN_EMBEDDED_KEY_RE =
  /(access_?token|refresh_?token|api[_-]?key|password|authorization|private[_-]?key|oauthTokenData|token_secret)/i;
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ya29\.[A-Za-z0-9_-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/i,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/,
];
const FORBIDDEN_MATERIAL_RE = /\$\{?env\.|process\.env|\/Bearer\s+[A-Z]/i;

function frozenWorkflowPath() {
  return path.join(__dirname, '..', `${ARTIFACT}.json`);
}

function harnessWorkflowPath() {
  return path.join(__dirname, '..', `${HARNESS_ARTIFACT}.json`);
}

function loadWorkflowJson(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) {
    throw new Error(`workflow json is not a workflow: ${filePath}`);
  }
  return raw;
}

function loadFrozenWorkflow() {
  return loadWorkflowJson(frozenWorkflowPath());
}

function loadHarnessWorkflow() {
  return loadWorkflowJson(harnessWorkflowPath());
}

function nodeByName(wf, name) {
  return (wf && wf.nodes && wf.nodes.find((n) => n && n.name === name)) || null;
}

/*
 * n8n webhook URL forms (corrected in the Phase 6.5 revision — the previous
 * implementation mistakenly embedded the workflow id from the abandoned
 * two-segment experiment):
 *   - PRODUCTION webhook (registered while the workflow is ACTIVE):
 *       ${base}/webhook/<path>
 *   - TEST webhook (one-shot, only valid while the n8n editor's "Listen for
 *     test event" is active):
 *       ${base}/webhook-test/<path>
 * The workflow id is NEVER part of a webhook URL. Leading slashes on the path
 * are stripped; trailing slashes on the base are stripped.
 */
function harnessWebhookUrl(baseUrl, webhookPath = HARNESS_WEBHOOK_PATH, mode = HARNESS_WEBHOOK_MODE_PRODUCTION) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const segment = mode === HARNESS_WEBHOOK_MODE_TEST ? 'webhook-test' : 'webhook';
  return `${base}/${segment}/${String(webhookPath).replace(/^\/+/, '')}`;
}

function nodeEdges(wf) {
  const edges = [];
  for (const source of Object.keys((wf && wf.connections) || {})) {
    for (const branch of (wf.connections[source].main || [])) {
      for (const c of branch || []) {
        edges.push({ source, target: String(c.node || ''), type: String(c.type || ''), index: c.index });
      }
    }
  }
  return edges;
}

function nodeCounts(edges) {
  const incoming = new Map();
  const outgoing = new Map();
  for (const e of edges) {
    outgoing.set(e.source, (outgoing.get(e.source) || 0) + 1);
    incoming.set(e.target, (incoming.get(e.target) || 0) + 1);
  }
  return { incoming, outgoing };
}

/* Extract $('Name') references from embedded code. */
function codeNodeReferences(wf) {
  const out = [];
  for (const node of (wf && wf.nodes) || []) {
    if (node && node.type === 'n8n-nodes-base.code') {
      const jsCode = String((node.parameters && node.parameters.jsCode) || '');
      const refs = [...jsCode.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
      out.push({ name: node.name, refs });
    }
  }
  return out;
}

function spliceIdentityMatches(frozenNode, harnessNode, name) {
  const checks = [];
  checks.push({ label: `${name}: type`, ok: harnessNode.type === frozenNode.type, detail: `${harnessNode.type} vs frozen ${frozenNode.type}` });
  checks.push({ label: `${name}: typeVersion`, ok: harnessNode.typeVersion === frozenNode.typeVersion, detail: `${harnessNode.typeVersion} vs frozen ${frozenNode.typeVersion}` });
  checks.push({ label: `${name}: id`, ok: harnessNode.id === frozenNode.id, detail: `${harnessNode.id} vs frozen ${frozenNode.id}` });
  const continuationAllowed = HARNESS_CONTINUATION_FLAG_NODES.includes(name);
  const allowsContinuation = continuationAllowed && !frozenNode.alwaysOutputData && harnessNode.alwaysOutputData === true;
  checks.push({
    label: `${name}: alwaysOutputData${continuationAllowed ? ' (or documented continuation flag)' : ''}`,
    ok: allowsContinuation || !!harnessNode.alwaysOutputData === !!frozenNode.alwaysOutputData,
    detail: `${harnessNode.alwaysOutputData} vs frozen ${frozenNode.alwaysOutputData}${allowsContinuation ? ' — documented empty-read continuation flag' : ''}`,
  });
  checks.push({
    label: `${name}: parameters byte-identical`,
    ok: JSON.stringify(harnessNode.parameters) === JSON.stringify(frozenNode.parameters),
    detail: JSON.stringify(harnessNode.parameters) === JSON.stringify(frozenNode.parameters)
      ? 'identical'
      : 'DIFFERS from frozen — splice drift breaks the live comparison',
  });
  return checks;
}

function checkHarnessContract(wf) {
  const checks = [];
  const fail = (label, detail) => checks.push({ label, ok: false, detail });

  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
    return [{ label: 'harness workflow parses', ok: false, detail: 'not a workflow object' }];
  }

  checks.push({
    label: 'workflow-level id present and deterministic',
    ok: wf.id === HARNESS_WORKFLOW_ID && /^[A-Za-z0-9_-]{1,64}$/.test(String(wf.id || '')),
    detail: `id=${wf.id} (expected ${HARNESS_WORKFLOW_ID})`,
  });
  checks.push({ label: 'workflow inactive (active=false)', ok: wf.active === false, detail: `active=${wf.active}` });

  const names = (wf.nodes || []).map((n) => n && n.name);
  checks.push({
    label: 'node names exactly the Phase 6.5 harness set',
    ok: JSON.stringify(names) === JSON.stringify(HARNESS_NODE_NAMES),
    detail: names.join(' > '),
  });
  checks.push({
    label: 'node count 6',
    ok: (wf.nodes || []).length === 6,
    detail: `${(wf.nodes || []).length}/6`,
  });

  const webhook = nodeByName(wf, 'Webhook');
  if (!webhook) {
    fail('one Webhook entry node', 'missing');
  } else {
    checks.push({ label: 'Webhook: type', ok: webhook.type === 'n8n-nodes-base.webhook', detail: webhook.type });
    checks.push({ label: 'Webhook: typeVersion', ok: webhook.typeVersion === 2, detail: `typeVersion=${webhook.typeVersion}` });
    const p = webhook.parameters || {};
    checks.push({ label: 'Webhook: test namespace path', ok: p.path === HARNESS_WEBHOOK_PATH, detail: `path=${p.path}` });
    checks.push({ label: 'Webhook: POST', ok: p.httpMethod === 'POST', detail: `httpMethod=${p.httpMethod}` });
    checks.push({ label: 'Webhook: responseMode lastNode', ok: p.responseMode === 'lastNode', detail: `responseMode=${p.responseMode}` });
  }

  const bridge = nodeByName(wf, 'Manual Trigger');
  if (!bridge) {
    fail('bridge "Manual Trigger" node', 'missing');
  } else {
    checks.push({ label: 'bridge: code type', ok: bridge.type === 'n8n-nodes-base.code', detail: bridge.type });
    checks.push({
      label: 'bridge: flatten-body jsCode exact',
      ok: String((bridge.parameters && bridge.parameters.jsCode) || '') === HARNESS_BRIDGE_JAVASCRIPT,
      detail: 'jsCode differs from the proven §0 bridge',
    });
  }

  const frozen = loadFrozenWorkflow();
  const frozenByName = new Map((frozen.nodes || []).map((n) => [n.name, n]));
  for (const name of SPLICED_NODE_NAMES) {
    const fn = frozenByName.get(name);
    const hn = nodeByName(wf, name);
    if (!fn) {
      fail(`${name}: not present in the frozen artifact`, 'frozen splice reference missing');
      continue;
    }
    if (!hn) {
      fail(`${name}: not present in the harness`, 'missing splice');
      continue;
    }
    checks.push(...spliceIdentityMatches(fn, hn, name));
  }

  const edges = nodeEdges(wf);
  checks.push({ label: 'exactly 5 edges', ok: edges.length === 5, detail: `${edges.length} edges` });
  const chainOk = edges.length === 5 && edges.every((e, i) => e.source === HARNESS_NODE_NAMES[i] && e.target === HARNESS_NODE_NAMES[i + 1]);
  checks.push({
    label: 'strict 6-node linear chain order',
    ok: chainOk,
    detail: chainOk ? HARNESS_NODE_NAMES.join(' -> ') : edges.map((e) => `${e.source}->${e.target}`).join(', '),
  });
  const over = edges.filter((e) => !(e.type === 'main'));
  checks.push({ label: 'all edges are main type', ok: over.length === 0, detail: over.length ? over.map((e) => e.source).join(', ') : 'ok' });
  const { incoming, outgoing } = nodeCounts(edges);
  for (const name of HARNESS_NODE_NAMES) {
    const expectedIn = name === 'Webhook' ? 0 : 1;
    const expectedOut = name === 'Response Interpretation Complete' ? 0 : 1;
    checks.push({ label: `${name}: exactly one incoming`, ok: (incoming.get(name) || 0) === expectedIn, detail: `incoming=${incoming.get(name) || 0}` });
    checks.push({ label: `${name}: exactly one outgoing`, ok: (outgoing.get(name) || 0) === expectedOut, detail: `outgoing=${outgoing.get(name) || 0}` });
  }

  /* credential surface */
  const credNodes = (wf.nodes || []).filter((n) => n && n.credentials);
  checks.push({ label: 'exactly one credentials-bearing node (Read Response Log)', ok: credNodes.length === 1 && credNodes[0].name === 'Read Response Log', detail: `${credNodes.length} node(s)` });
  if (credNodes.length === 1 && credNodes[0].name === 'Read Response Log') {
    const rrl = credNodes[0];
    const refOk =
      rrl.credentials &&
      typeof rrl.credentials === 'object' &&
      Object.keys(rrl.credentials).length === 1 &&
      rrl.credentials[HARNESS_CREDENTIAL_TYPE] &&
      JSON.stringify(rrl.credentials[HARNESS_CREDENTIAL_TYPE]) === JSON.stringify(HARNESS_PROVIDER_CREDENTIAL);
    checks.push({
      label: 'credential ref is reference-only ({id,name})',
      ok: !!refOk,
      detail: refOk ? `googleSheetsOAuth2Api -> ${JSON.stringify(HARNESS_PROVIDER_CREDENTIAL)}` : 'credentials block carries forbidden material',
    });
  }

  /* serialization hygiene — after removing the single allowed credential block */
  const copy = JSON.parse(JSON.stringify(wf));
  const rrl = copy.nodes && copy.nodes.find((n) => n && n.name === 'Read Response Log');
  if (rrl) delete rrl.credentials;
  const raw = JSON.stringify(copy);
  checks.push({ label: 'no embedded-secret key material outside the allowed block', ok: !FORBIDDEN_EMBEDDED_KEY_RE.test(raw), detail: FORBIDDEN_EMBEDDED_KEY_RE.test(raw) ? 'forbidden key name found' : 'clean' });
  checks.push({ label: 'no other credentials block appears in the workflow', ok: raw.indexOf('credentials') === -1, detail: raw.indexOf('credentials') === -1 ? 'only the allowed RRL block' : 'second credentials block found' });
  const secretHits = SECRET_VALUE_PATTERNS.filter((re) => re.test(raw));
  checks.push({ label: 'no secret value patterns', ok: secretHits.length === 0, detail: secretHits.length ? secretHits.map((re) => re.source).join(', ') : 'clean' });
  checks.push({ label: 'no env interpolation / bearer material', ok: !FORBIDDEN_MATERIAL_RE.test(raw), detail: FORBIDDEN_MATERIAL_RE.test(raw) ? 'forbidden material found' : 'clean' });

  /* sheet surface: exactly one read, zero writes */
  const sheets = (wf.nodes || []).filter((n) => n && n.type === 'n8n-nodes-base.googleSheets');
  const readOps = sheets.filter((n) => (n.parameters && n.parameters.operation) === 'read');
  const writeOps = sheets.filter((n) =>
    ['append', 'appendOrUpdate', 'update', 'upsert', 'delete'].includes((n.parameters && n.parameters.operation) || ''),
  );
  checks.push({ label: 'exactly one Google Sheets node (the frozen Response Log read)', ok: sheets.length === 1 && readOps.length === 1 && readOps[0].name === 'Read Response Log', detail: `${sheets.length} sheet node(s), ${readOps.length} read(s)` });
  checks.push({ label: 'zero sheets write nodes', ok: writeOps.length === 0, detail: `${writeOps.length} write node(s)` });

  /* banned types — the single Webhook entry is the permitted exception */
  const banned = (wf.nodes || []).filter((n) => n && BANNED_NODE_TYPES.includes(n.type) && n.type !== 'n8n-nodes-base.webhook');
  checks.push({ label: 'no provider/AI/output/scheduler nodes', ok: banned.length === 0, detail: banned.length ? banned.map((n) => n.type).join(', ') : 'none' });

  /* clean source on every code node */
  for (const node of (wf.nodes || []) || []) {
    if (node && node.type === 'n8n-nodes-base.code') {
      try {
        assertCleanSource(String((node.parameters && node.parameters.jsCode) || ''));
        checks.push({ label: `clean source: ${node.name}`, ok: true, detail: 'assertCleanSource passed' });
      } catch (err) {
        checks.push({ label: `clean source: ${node.name}`, ok: false, detail: err.message });
      }
    }
  }

  /* pairedItem ancestry — code refs are transitive ancestors only */
  const indexByName = new Map(HARNESS_NODE_NAMES.map((name, i) => [name, i]));
  for (const { name, refs } of codeNodeReferences(wf)) {
    const own = indexByName.get(name);
    for (const ref of refs) {
      const refIdx = indexByName.get(ref);
      checks.push({
        label: `${name}: $('${ref}') is a transitive ancestor`,
        ok: own != null && refIdx != null && refIdx < own,
        detail: refIdx == null ? `unknown ref ${ref}` : `index ${refIdx} vs own ${own}`,
      });
    }
  }

  const pinned = (readOps[0] && readOps[0].parameters && readOps[0].parameters.documentId) || {};
  checks.push({
    label: 'Response Log read targets the pinned spreadsheet',
    ok: String(pinned.value || '') === SPREADSHEET_ID,
    detail: String(pinned.value || '') === SPREADSHEET_ID ? SPREADSHEET_ID : String(pinned.value || ''),
  });

  checks.push({ label: 'meta.artifact recorded', ok: !!(wf.meta && wf.meta.artifact) === true, detail: (wf.meta && wf.meta.artifact) || 'missing' });

  return checks;
}

function assertHarnessContract(wf) {
  const failures = checkHarnessContract(wf).filter((c) => !c.ok);
  if (failures.length) {
    throw new Error(`test harness workflow contract violation: ${failures.map((f) => f.label).join('; ')}`);
  }
}

module.exports = {
  HARNESS_ARTIFACT,
  HARNESS_WORKFLOW_ID,
  HARNESS_WEBHOOK_PATH,
  HARNESS_WEBHOOK_MODE_PRODUCTION,
  HARNESS_WEBHOOK_MODE_TEST,
  HARNESS_BRIDGE_NODE_NAME,
  HARNESS_BRIDGE_JAVASCRIPT,
  HARNESS_CREDENTIAL_TYPE,
  HARNESS_PROVIDER_CREDENTIAL,
  HARNESS_NODE_NAMES,
  SPLICED_NODE_NAMES,
  HARNESS_CONTINUATION_FLAG_NODES,
  HARNESS_WEBHOOK_NODE_ID,
  HARNESS_BRIDGE_NODE_ID,
  frozenWorkflowPath,
  harnessWorkflowPath,
  loadFrozenWorkflow,
  loadHarnessWorkflow,
  nodeByName,
  harnessWebhookUrl,
  nodeEdges,
  nodeCounts,
  codeNodeReferences,
  spliceIdentityMatches,
  checkHarnessContract,
  assertHarnessContract,
};