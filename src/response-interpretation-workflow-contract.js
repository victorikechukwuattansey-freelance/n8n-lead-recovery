'use strict';

/*
 * Response Interpretation V1 — workflow CONTRACT (Phase 3).
 *
 * Single source of truth for the n8n workflow boundary around the pure
 * interpretation engine. Phase 4 must render this contract into the shipped
 * workflow JSON via its builder; the contract-and-parity gate lives here so
 * the embedded mirror of Phase 4 can be verified against the same reference
 * this file defines.
 *
 * This module is NOT the embedded mirror and does NOT emit a workflow JSON.
 * It defines:
 *   - the exact 5-node topology, node types, names, and connection order;
 *   - the only Google Sheets read (Response Log) and the reconciliation-report
 *     read role (pure relay — never a sheet, never network, never fs);
 *   - the input/join contract: everything joins by response_id, reconciliation
 *     is authoritative evidence and is NEVER recomputed;
 *   - the failure semantics (healthy reads -> COMPLETED, read failure ->
 *     INCOMPLETE with nulled summary, never a fabricated zero);
 *   - the banned-surface rules for every node in the workflow;
 *   - the fixture-parity gate (`engineBehaviorFor` / `assertEngineEquivalence`)
 *     that any Phase 4 embedded implementation must reproduce byte-for-byte.
 *
 * Determinism: run metadata is injected (FIXED_NOW / FIXED_RUN_ID), the same
 * clock the Phase 2 corpus goldens were produced with.
 */

const { RUN_LABEL, digits14, interpretationIdFor, interpretResponses } = require('./response-interpretation');
const { reconcileResponses } = require('./response-reconcile');

const WORKFLOW_NAME = 'Lead Recovery Engine — Response Interpretation V1';
const ARTIFACT = 'Response-Interpretation V1';
const RESPONSE_LOG_SHEET = 'Response Log';
const JOIN_KEY = 'response_id';

/*
 * The single spreadsheet reference adopted by every frozen workflow in this
 * repository. It is the engine/fixture spreadsheet, never a production id and
 * never a secret — it is pinned here so Phase 4 renders exactly one reference.
 */
const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';

const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Response Log',
  'Read Reconciliation Report',
  'Interpret Responses',
  'Response Interpretation Complete',
];

const NODE_TYPES = {
  'Manual Trigger': 'n8n-nodes-base.manualTrigger',
  'Read Response Log': 'n8n-nodes-base.googleSheets',
  'Read Reconciliation Report': 'n8n-nodes-base.code',
  'Interpret Responses': 'n8n-nodes-base.code',
  'Response Interpretation Complete': 'n8n-nodes-base.noOp',
};

/*
 * Empty successful reads must still reach the interpretation stage. Both code
 * nodes that consume the two reads set alwaysOutputData so a zero-item read is
 * a COMPLETED run with valid zero metrics, never a silently skipped branch.
 */
const ALWAYS_OUTPUT_DATA = ['Read Reconciliation Report', 'Interpret Responses'];

/*
 * The Manual Trigger carries optional read-failure metadata (same convention
 * as the frozen reconciliation workflow). Interpret reads these two keys; the
 * engine options `responseLogReadError` / `reconciliationReadError` map 1:1.
 */
const TRIGGER_ERROR_KEYS = ['response_log_read_error', 'reconciliation_read_error'];

const RECONCILIATION_SOURCE =
  'Response Reconciliation V1 report artifact (per-run JSON evidence; read-only; never recomputed)';

const BANNED_NODE_TYPES = [
  'n8n-nodes-base.emailSend',
  'n8n-nodes-base.twilio',
  'n8n-nodes-base.whatsapp',
  'n8n-nodes-base.slack',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.hunter',
  'n8n-nodes-base.clearbit',
  '@n8n/n8n-nodes-langchain.chatOpenAI',
  'n8n-nodes-base.openAi',
];

/* Raw material that must never leave the workflow boundary. */
const SENSITIVE_KEYS = ['response_text', 'provider_message_id', 'sender', 'recipient'];

/* The same frozen clock the Phase 2 fixture goldens were produced with. */
const FIXED_NOW = new Date('2026-09-12T09:00:00.000Z').getTime();
const FIXED_RUN_ID = `${RUN_LABEL}-${digits14(String(FIXED_NOW))}`;

/*
 * Phase 5.4: the workflow is a strict linear chain. n8n pairs every output item
 * to a single parent item (pairedItem), so a code node's `$('X')` resolves only
 * when X is an ancestor along the item's chain. The pre-5.4 diamond placed Read
 * Reconciliation Report on a sibling branch; n8n threw descriptionKey
 * pairedItemNoConnectionCodeNode with message
 * "Node 'Read Reconciliation Report' hasn't been executed".
 */
const TOPOLOGY = {
  chain: [
    'Manual Trigger',
    'Read Reconciliation Report',
    'Read Response Log',
    'Interpret Responses',
    'Response Interpretation Complete',
  ],
  exit: 'Response Interpretation Complete',
};

/*
 * Phase 5.4: the explicit, intended edge set — a single linear chain. Every
 * edge is a [source, target] pair. The contract treats this as the canonical
 * wiring — anything missing is a FAIL, anything extra is a FAIL, and every
 * non-trigger / non-terminal node must carry exactly one incoming / outgoing
 * edge (see pairedItemAncestors / the chain checks below). This replaces the
 * pre-5.4 diamond whose two read nodes had NO ancestor relationship: n8n items
 * carry one parent, so the Interpret Responses code node could not resolve
 * `$('Read Reconciliation Report')` from items that arrived via the Read
 * Response Log branch (ExpressionError / pairedItemNoConnectionCodeNode,
 * "Node 'Read Reconciliation Report' hasn't been executed").
 */
const EXPECTED_EDGES = [
  ['Manual Trigger', 'Read Reconciliation Report'],
  ['Read Reconciliation Report', 'Read Response Log'],
  ['Read Response Log', 'Interpret Responses'],
  ['Interpret Responses', 'Response Interpretation Complete'],
];

const META_REQUIREMENTS = {
  artifact: ARTIFACT,
  readOnly: true,
  sheets: [RESPONSE_LOG_SHEET],
  joinKey: JOIN_KEY,
};

function stripRuntime(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => ['run_id', 'run_at', 'detected_at'].includes(key) ? undefined : val),
  );
}

/**
 * Canonical projection of the three workflow feed surfaces onto the engine
 * signature — exactly what the Phase 4 Interpret node must do:
 *   - responseItems   -> responseRows (full durable rows),
 *   - reportItems     -> reconciliationReport (authoritative evidence; the read
 *                        yields a single JSON document, healthy-empty allowed),
 *   - errorCarrier    -> responseLogReadError / reconciliationReadError.
 * Join happens exclusively by response_id inside the engine. Reconciliation is
 * consumed as a report and never recomputed.
 */
function projectWorkflowInputs({ errorCarrier = {}, responseItems = [], reportItems = [] } = {}) {
  const report = (reportItems || []).length > 0 ? reportItems[0].json : null;
  return {
    responseRows: (responseItems || []).map((item) => item && item.json),
    reconciliationReport: report || { status: 'COMPLETED', results: [] },
    responseLogReadError: errorCarrier.response_log_read_error || '',
    reconciliationReadError: errorCarrier.reconciliation_read_error || '',
    now: FIXED_NOW,
    runId: FIXED_RUN_ID,
  };
}

/**
 * Derives the frozen reconcile artifact a fixture's read would have produced,
 * then interprets. This is the parity BASELINE: the Phase 4 embedded node is
 * required to reproduce `engineBehaviorFor(fixture)` byte-for-byte.
 */
function engineBehaviorFor(fixture) {
  const report =
    fixture.upstreamIncomplete
      ? { status: 'INCOMPLETE', results: [] }
      : fixture.responseReadError || fixture.reconciliationReadError
        ? { status: 'COMPLETED', results: [] }
        : reconcileResponses({
            responseRows: fixture.reconcileResponseRows || [],
            outreachRows: fixture.reconcileOutreachRows || [],
            now: FIXED_NOW,
            runId: 'RESPRECON-FIXED',
          });
  return interpretResponses(
    projectWorkflowInputs({
      errorCarrier: {
        response_log_read_error: fixture.responseReadError || '',
        reconciliation_read_error: fixture.reconciliationReadError || '',
      },
      responseItems: (fixture.initialResponseRows || []).map((json) => ({ json })),
      reportItems: [{ json: report }],
    }),
  );
}

/**
 * The Phase 4 parity gate. Returns true only when the embedded node's output
 * for a fixture is engine-equivalent (equal up to run identity fields).
 */
function assertEngineEquivalence(actualReport, fixture) {
  const actual = stripRuntime(actualReport);
  const baseline = stripRuntime(engineBehaviorFor(fixture));
  return JSON.stringify(actual) === JSON.stringify(baseline);
}

/* ------------------------------------------------------------------ */
/* Reference topology (minimal structural placeholder — NO jsCode)     */
/* ------------------------------------------------------------------ */

/**
 * The canonical 5-node read-only topology, rendered with the exact node names,
 * ids, types, connections, meta, and positions Phase 4's builder must emit
 * (Phase 4 injects the embedded jsCode into the two code nodes). The
 * reconciliation report read is a code node because the repository has NO
 * file-read workflow precedent and n8n cannot read the runner-local artifact;
 * it is a read-only pure relay — never a sheet, never a write.
 */
function referenceWorkflow() {
  const manualTrigger = {
    parameters: { event: '' },
    id: 'resp-int-manual-0000001',
    name: 'Manual Trigger',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 160],
  };

  const readResponseLog = {
    parameters: {
      documentId: { __rl: true, value: SPREADSHEET_ID, mode: 'list' },
      operation: 'read',
      sheetName: { mode: 'name', value: RESPONSE_LOG_SHEET },
      filtersUI: { values: [] },
      options: { returnAllMatches: true },
    },
    id: 'resp-int-read-response-0001',
    name: 'Read Response Log',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4,
    position: [260, -40],
  };

  const readReconciliationReport = {
    parameters: {},
    id: 'resp-int-read-recon-0001',
    name: 'Read Reconciliation Report',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    alwaysOutputData: true,
    position: [260, 300],
  };

  const interpretResponsesNode = {
    parameters: {},
    id: 'resp-int-interpret-0000001',
    name: 'Interpret Responses',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    alwaysOutputData: true,
    position: [520, 160],
  };

  const complete = {
    parameters: {},
    id: 'resp-int-complete-0000001',
    name: 'Response Interpretation Complete',
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: [780, 160],
  };

  /*
   * Phase 5.4: the canonical wiring is a strict linear chain so every item's
   * pairedItem ancestry contains the three nodes Interpret Responses reads via
   * $('...') — Manual Trigger -> Read Reconciliation Report -> Read Response
   * Log -> Interpret Responses -> Response Interpretation Complete. Each node
   * has exactly one outgoing edge in main[0] and exactly one incoming edge.
   */
  const connections = {
    'Manual Trigger': {
      main: [[{ node: 'Read Reconciliation Report', type: 'main', index: 0 }]],
    },
    'Read Reconciliation Report': {
      main: [[{ node: 'Read Response Log', type: 'main', index: 0 }]],
    },
    'Read Response Log': { main: [[{ node: 'Interpret Responses', type: 'main', index: 0 }]] },
    'Interpret Responses': { main: [[{ node: 'Response Interpretation Complete', type: 'main', index: 0 }]] },
  };

  return {
    name: WORKFLOW_NAME,
    active: false,
    nodes: [manualTrigger, readResponseLog, readReconciliationReport, interpretResponsesNode, complete],
    connections,
    meta: {
      artifact: ARTIFACT,
      spreadsheetId: SPREADSHEET_ID,
      readOnly: true,
      sheets: [RESPONSE_LOG_SHEET],
      responseTextReadAuthority: 'OUTREACH-RESPONSE-INTERPRETATION-V1 (first artifact allowed to read response_text)',
      reconciliationReportSource: RECONCILIATION_SOURCE,
      joinKey: JOIN_KEY,
      readErrorsCarriedBy: `Manual Trigger (${TRIGGER_ERROR_KEYS.join(' / ')})`,
      emptyReadBehavior:
        'alwaysOutputData on Read Reconciliation Report and Interpret Responses — empty successful reads yield COMPLETED with valid zero metrics',
      generatedBy: 'scripts/build-response-interpretation-workflow.js',
    },
  };
}

function describeWorkflowContract() {
  return {
    name: WORKFLOW_NAME,
    artifact: ARTIFACT,
    expectedNodes: EXPECTED_NODES,
    nodeTypes: NODE_TYPES,
    alwaysOutputData: ALWAYS_OUTPUT_DATA,
    joinKey: JOIN_KEY,
    reconciliationSource: RECONCILIATION_SOURCE,
    triggerErrorKeys: TRIGGER_ERROR_KEYS,
    spreadsheetId: SPREADSHEET_ID,
    responseLogSheet: RESPONSE_LOG_SHEET,
    topology: TOPOLOGY,
    metaRequirements: META_REQUIREMENTS,
    bannedNodeTypes: BANNED_NODE_TYPES,
    sensitiveKeys: SENSITIVE_KEYS,
  };
}

/* ------------------------------------------------------------------ */
/* Banned-surface scanning                                            */
/* ------------------------------------------------------------------ */

const CLEAN_CODE_SCAN = [
  [/staticData/, 'staticData'],
  [/process\.env/, 'process.env'],
  [/\$env/, '$env'],
  [/require\s*\(/, 'require('],
  [/\bfetch\s*\(/, 'fetch('],
  [/eval\s*\(/, 'eval('],
  [/new Function/, 'new Function'],
  [/Math\.random/, 'Math.random'],
  [/crypto\.randomUUID/, 'crypto.randomUUID'],
  [/\brequire\b/, 'module require'],
  [/\bchild_process\b/, 'child_process'],
  [/\bfs\b/, 'fs'],
  [/https?:\/\//i, 'http(s) transport'],
];

function assertCleanSource(code) {
  for (const [pattern, label] of CLEAN_CODE_SCAN) {
    if (pattern.test(code)) {
      throw new Error(`code-node violation: banned pattern "${label}"`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Contract validator                                                 */
/* ------------------------------------------------------------------ */

/**
 * Phase 5.1: flatten a workflow's connections object into a canonical set of
 * "source -> target" edge descriptors. Each descriptor is the string form so
 * edge sets compare deterministically regardless of connection-array layout.
 */
function workflowEdges(connections) {
  const edges = [];
  for (const [source, nodeConnections] of Object.entries(connections || {})) {
    const main = nodeConnections && nodeConnections.main;
    if (!Array.isArray(main)) continue;
    for (const branch of main) {
      for (const edge of branch || []) {
        if (edge && typeof edge.node === 'string') {
          edges.push(`${source} -> ${edge.node}`);
        }
      }
    }
  }
  return edges.sort();
}

/**
 * Phase 5.1: BFS traversal from the trigger. Returns the set of node names
 * reachable from the trigger over the connection graph. A node that is not in
 * this set can never execute — including nodes referenced by $('...') in code.
 */
function reachableNodes(connections, names) {
  const adjacency = new Map();
  for (const name of names) adjacency.set(name, []);
  for (const edge of workflowEdges(connections)) {
    const [from, to] = edge.split(' -> ');
    if (adjacency.has(from) && adjacency.has(to)) adjacency.get(from).push(to);
  }
  const seen = new Set();
  const queue = ['Manual Trigger'];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) || []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * Phase 5.1: extract every $('Node Name') self-reference target from embedded
 * code. Used to guarantee a code node never references a node that cannot be
 * reached from the trigger (the exact defect class that stalled Phase 6).
 */
function codeNodeReferences(code) {
  const refs = [];
  const pattern = /\$\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

/**
 * Phase 5.4: count outgoing edges (across every branch of `main`) per node.
 * Returns a Map name -> count (0 for a node with no outgoing edges).
 * Pure — no mutation of the workflow object.
 */
function outgoingCounts(connections, names) {
  const counts = new Map();
  for (const name of names) counts.set(name, 0);
  for (const edge of workflowEdges(connections || {})) {
    const [from] = edge.split(' -> ');
    if (counts.has(from)) counts.set(from, counts.get(from) + 1);
  }
  return counts;
}

/**
 * Phase 5.4: count incoming edges per node. Returns a Map name -> count.
 * Pure — no mutation of the workflow object.
 */
function incomingCounts(connections, names) {
  const counts = new Map();
  for (const name of names) counts.set(name, 0);
  for (const edge of workflowEdges(connections || {})) {
    const [, to] = edge.split(' -> ');
    if (counts.has(to)) counts.set(to, counts.get(to) + 1);
  }
  return counts;
}

/**
 * Phase 5.4: the set of node names reachable by walking INWARD (following
 * incoming edges) from `nodeName`. n8n pairs every output item to a single
 * parent item, so inside a code node `$('X')` resolves only when X is a
 * transitive ancestor of the item the node received — i.e. X is in this set.
 * A sibling node on a separate branch is NEVER an ancestor; that is exactly
 * the pre-5.4 diamond defect (pairedItemNoConnectionCodeNode). For a strict
 * chain this set is unambiguous; combined with the chain fan-in/fan-out
 * checks below it fully replaces per-path reasoning.
 */
function pairedItemAncestors(connections, nodeName, names) {
  const reverse = new Map();
  for (const name of names) reverse.set(name, []);
  for (const edge of workflowEdges(connections || {})) {
    const [from, to] = edge.split(' -> ');
    if (reverse.has(to)) reverse.get(to).push(from);
  }
  const ancestors = new Set();
  const queue = [...(reverse.get(nodeName) || [])];
  while (queue.length > 0) {
    const current = queue.shift();
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    for (const prev of reverse.get(current) || []) queue.push(prev);
  }
  return ancestors;
}

/**
 * Validates any workflow-shaped object against the Phase 3 contract. Throws on
 * the first (accumulated) violation. Used here against the reference topology
 * and by Phase 4 against the builder output and the shipped JSON.
 */
function assertWorkflowContract(wf) {
  const violations = [];

  if (!wf || typeof wf !== 'object') {
    throw new Error('workflow contract violation: workflow object required');
  }
  if (wf.active) violations.push('workflow must be shipped inactive');

  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const names = nodes.map((n) => n && n.name);
  if (names.length !== EXPECTED_NODES.length) {
    violations.push(`exactly ${EXPECTED_NODES.length} nodes required (got ${names.length})`);
  }
  EXPECTED_NODES.forEach((expected, index) => {
    if (names[index] !== expected) {
      violations.push(`node ${index} must be "${expected}" in that order (got "${names[index]}")`);
    }
  });
  const nameSet = new Set(names);
  if (nameSet.size !== names.length) violations.push('node names must be unique');
  const idList = nodes.map((n) => n && n.id);
  if (new Set(idList).size !== idList.length) violations.push('node ids must be unique');
  if (idList.some((id) => !id)) violations.push('every node must carry an id');

  const types = nodes.map((n) => n && n.type);
  EXPECTED_NODES.forEach((name) => {
    const node = nodes[names.indexOf(name)];
    if (!node) return;
    if (node.type !== NODE_TYPES[name]) {
      violations.push(`"${name}" must be ${NODE_TYPES[name]} (got ${node.type})`);
    }
  });

  for (const banned of BANNED_NODE_TYPES) {
    if (types.includes(banned)) violations.push(`banned node type present: ${banned}`);
  }

  const sheetNodes = nodes.filter((n) => n && n.type === 'n8n-nodes-base.googleSheets');
  if (sheetNodes.length !== 1) {
    violations.push(`exactly one googleSheets read required (got ${sheetNodes.length})`);
  } else {
    const read = sheetNodes[0];
    const p = read.parameters || {};
    if (p.operation !== 'read') violations.push('Response Log read must use operation "read"');
    if (!p.sheetName || p.sheetName.value !== RESPONSE_LOG_SHEET) {
      violations.push('the only sheet read must target the Response Log tab');
    }
    if (!p.documentId || p.documentId.value !== SPREADSHEET_ID) {
      violations.push('sheet read must reference the pinned engine spreadsheet id');
    }
    if (p.filtersUI && p.filtersUI.values && p.filtersUI.values.length > 0) {
      violations.push('sheet read must be unfiltered');
    }
    if (p.options && p.options.returnAllMatches === false) {
      violations.push('sheet read must return all matches');
    }
  }
  for (const sheet of sheetNodes) {
    const op = sheet.parameters && sheet.parameters.operation;
    if (op && ['append', 'appendOrUpdate', 'update', 'upsert', 'delete'].includes(op)) {
      violations.push(`write operation forbidden in workflow: ${op}`);
    }
  }

  const reconNode = nodes[names.indexOf('Read Reconciliation Report')];
  if (reconNode) {
    if (reconNode.type === 'n8n-nodes-base.googleSheets') {
      violations.push('Read Reconciliation Report must never be a sheet read');
    }
    if (reconNode.alwaysOutputData !== true) {
      violations.push('Read Reconciliation Report must set alwaysOutputData');
    }
  }
  const interpretNode = nodes[names.indexOf('Interpret Responses')];
  if (interpretNode) {
    if (interpretNode.alwaysOutputData !== true) {
      violations.push('Interpret Responses must set alwaysOutputData');
    }
  }

  const trigger = nodes[names.indexOf('Manual Trigger')];
  if (trigger && trigger.type === 'n8n-nodes-base.manualTrigger' && !trigger.parameters) {
    violations.push('Manual Trigger must carry parameters');
  }

  const connections = wf.connections || {};
  for (const source of Object.keys(connections)) {
    if (!nameSet.has(source)) violations.push(`connection source not in workflow: ${source}`);
  }

  /*
   * Phase 5.4: chain (fan-in / fan-out) checks. The workflow must be a strict
   * linear chain — every node except the terminal has exactly one outgoing
   * edge, and every node except the trigger has exactly one incoming edge.
   * The pre-5.4 diamond gave Interpret Responses TWO incoming edges (one from
   * each read branch). n8n pairs a code node's input item to a single parent,
   * so referencing a sibling-branch node fails at runtime with descriptionKey
   * pairedItemNoConnectionCodeNode ("Node 'X' hasn't been executed"). The
   * fan-in check is what catches a diamond: a diamond is precisely a node with
   * two incoming edges.
   */
  const outCounts = outgoingCounts(connections, names);
  const inCounts = incomingCounts(connections, names);
  for (const name of names) {
    if (name !== TOPOLOGY.exit && outCounts.get(name) !== 1) {
      violations.push(
        `"${name}" has ${outCounts.get(name)} outgoing edge(s), expected exactly 1 (chain)`,
      );
    }
    if (name === TOPOLOGY.exit && outCounts.get(name) !== 0) {
      violations.push(
        `terminal "${TOPOLOGY.exit}" must have 0 outgoing edge(s) (got ${outCounts.get(name)})`,
      );
    }
    if (name !== 'Manual Trigger' && inCounts.get(name) !== 1) {
      violations.push(
        `"${name}" has ${inCounts.get(name)} incoming edge(s), expected exactly 1 (chain)`,
      );
    }
  }
  const expectedConnectionSources = [...new Set(EXPECTED_EDGES.map(([from]) => from))].sort();
  const actualConnectionSources = Object.keys(connections).sort();
  if (JSON.stringify(actualConnectionSources) !== JSON.stringify(expectedConnectionSources)) {
    violations.push(
      `connection key set must be the ${expectedConnectionSources.length} chain sources ` +
        `(got ${actualConnectionSources.join(', ')})`,
    );
  }

  /*
   * Phase 5.2: output-slot validity.
   * n8n node types have a fixed output count. For every connection source,
   * the branch index (the outer array position in `main`) must be strictly
   * less than the node's output count. The built workflow must emit
   * main[0] only for a 1-output node like Manual Trigger; any main[1+]
   * is silently discarded at runtime, which is exactly the defect that
   * stalled the Phase 6 live run.
   *
   * Node output counts (from n8n-nodes-base definitions):
   *   manualTrigger → 1, googleSheets → 1, code → 1, noOp → 1.
   *   All five nodes in this workflow have exactly 1 output.
   */
  const NODE_OUTPUT_COUNTS = {
    'Manual Trigger': 1,
    'Read Response Log': 1,
    'Read Reconciliation Report': 1,
    'Interpret Responses': 1,
    'Response Interpretation Complete': 1,
  };

  // Check that no edge references an output index >= the source node's count.
  for (const source of Object.keys(connections)) {
    const outputCount = NODE_OUTPUT_COUNTS[source];
    if (outputCount === undefined) continue;
    const main = connections[source] && connections[source].main;
    if (!Array.isArray(main)) continue;
    for (let i = 0; i < main.length; i++) {
      if (i >= outputCount) {
        violations.push(
          `main[${i}] exceeds output count (${outputCount}) for source "${source}"`
        );
      }
      if (Array.isArray(main[i])) {
        for (let j = 0; j < main[i].length; j++) {
          // Each edge carries a `type` and an `index` naming the source output
          // slot it attaches to. An edge whose own index is out of range for
          // the source node is a wiring defect (identical class to main[1]
          // being discarded): it would target a slot the node never emits.
          const edge = main[i][j];
          if (edge && typeof edge.index === 'number' && edge.index >= outputCount) {
            violations.push(
              `edge ${source} -> ${edge.node} references output index ${edge.index} ` +
                `but "${source}" has only ${outputCount} output(s)`
            );
          }
        }
      }
    }
  }

  // Check that no node's main array has more slots than its output count.
  // (This catches cases where a multi-output node is mis-specified or where
  //  a single-output node erroneously has multiple main[] branches.)
  for (const source of Object.keys(connections)) {
    const outputCount = NODE_OUTPUT_COUNTS[source];
    if (outputCount === undefined) continue;
    const main = connections[source] && connections[source].main;
    if (!Array.isArray(main)) continue;
    // The number of branches (outer arrays) must not exceed outputCount.
    // Since all nodes here have outputCount === 1, main must have exactly 1 branch.
    if (main.length > outputCount) {
      violations.push(
        `main array has ${main.length} branch(es) but "${source}" has only ${outputCount} output(s)`
      );
    }
  }

/*
   * Phase 5.2: reachability from the trigger using n8n runtime semantics.
   * The reachable set is computed via workflowEdges + reachableNodes (already
   * present from Phase 5.1 below). Any node not reachable from the trigger
   * cannot execute; any expected edge missing from the reachable graph indicates
   * a broken fan-out or a dropped connection. (The Phase 5.1 hardening block
   * at line 627 computes reachableNodes and checks orphans/unreachable nodes
   * and code-reference reachability — this block adds the output-slot validity
   * checks that are the new 5.2 contribution.)
   */
// Reachability checked by Phase 5.1 block below (line 627).

  // Output-slot validity (Phase 5.2): no edge may reference an output index
  // >= the source node's output count. All five nodes in this workflow have
  // exactly 1 output, so main[0] is the only valid branch; main[1+] is
  // silently discarded at runtime — this is the defect that stalled Phase 6.
  const actualEdges = workflowEdges(connections);
  const expectedEdgeStrings = EXPECTED_EDGES.map(([from, to]) => `${from} -> ${to}`).sort();
  const missingEdges = expectedEdgeStrings.filter((edge) => !actualEdges.includes(edge));
  const extraEdges = actualEdges.filter((edge) => !expectedEdgeStrings.includes(edge));
  if (missingEdges.length > 0) {
    violations.push(`missing edge(s): ${missingEdges.join(', ')}`);
  }
  if (extraEdges.length > 0) {
    violations.push(`unexpected edge(s): ${extraEdges.join(', ')}`);
  }
  if (actualEdges.length !== expectedEdgeStrings.length) {
    violations.push(`edge count mismatch: expected ${expectedEdgeStrings.length}, got ${actualEdges.length}`);
  }
  const reachable = reachableNodes(connections, names);
  for (const name of names) {
    if (name === 'Manual Trigger') continue;
    if (!reachable.has(name)) violations.push(`node unreachable from trigger: ${name}`);
  }
  const incoming = new Map();
  for (const edge of actualEdges) {
    const [, to] = edge.split(' -> ');
    incoming.set(to, (incoming.get(to) || 0) + 1);
  }
  for (const name of names) {
    if (name === 'Manual Trigger') continue;
    if (!incoming.has(name) || incoming.get(name) === 0) {
      violations.push(`orphaned node (no incoming edge): ${name}`);
    }
  }
  for (const node of nodes) {
    const code = node && node.parameters && node.parameters.jsCode;
    if (typeof code !== 'string' || code.length === 0) continue;
    for (const ref of codeNodeReferences(code)) {
      if (!nameSet.has(ref)) violations.push(`code references unknown node: ${ref}`);
      else if (!reachable.has(ref)) violations.push(`code references unreachable node: ${ref}`);
      else {
        // Phase 5.4: even a reachable node is useless to a code node unless it
        // is a transitive pairedItem ancestor of the node's input items. This
        // is the exact defect that stalled Phase 6: both diamond reads were
        // reachable, yet items arriving via one branch make the other branch's
        // node unresolvable (pairedItemNoConnectionCodeNode).
        const ancestors = pairedItemAncestors(connections, node.name, names);
        if (!ancestors.has(ref)) {
          violations.push(
            `code node "${node.name}" references "${ref}" which is not a transitive pairedItem ancestor`,
          );
        }
      }
    }
  }

  const meta = wf.meta || {};
  if (meta.readOnly !== true) violations.push('meta.readOnly must be true');
  if (meta.artifact !== ARTIFACT) violations.push('meta.artifact must be "Response-Interpretation V1"');
  if (JSON.stringify(meta.sheets || []) !== JSON.stringify([RESPONSE_LOG_SHEET])) {
    violations.push('meta.sheets must list only the Response Log tab');
  }
  if (!meta.readErrorsCarriedBy) violations.push('meta.readErrorsCarriedBy must document the trigger carrier');
  else {
    for (const key of TRIGGER_ERROR_KEYS) {
      if (!String(meta.readErrorsCarriedBy).includes(key)) violations.push(`meta.readErrorsCarriedBy must mention ${key}`);
    }
  }
  if (!String(meta.emptyReadBehavior || '').includes('alwaysOutputData')) {
    violations.push('meta.emptyReadBehavior must document alwaysOutputData');
  }
  if (meta.joinKey !== JOIN_KEY) violations.push(`meta.joinKey must be ${JOIN_KEY}`);

  for (const node of nodes) {
    const code = node && node.parameters && node.parameters.jsCode;
    if (typeof code === 'string' && code.length > 0) {
      assertCleanSource(code);
    }
  }

  const raw = JSON.stringify(wf);
  if (/Bearer\s+[A-Z0-9]{10,}/i.test(raw)) violations.push('bearer token material embedded');
  if (/Authorization/.test(raw)) violations.push('Authorization header embedded');
  if (raw.includes('credentials')) violations.push('credential blocks embedded');
  if (/\$\{?env\./i.test(raw)) violations.push('env interpolation embedded');
  if (/process\.env/.test(raw)) violations.push('process.env embedded');

  if (violations.length > 0) {
    throw new Error('workflow contract violation: ' + violations.join('; '));
  }
}

module.exports = {
  WORKFLOW_NAME,
  ARTIFACT,
  RESPONSE_LOG_SHEET,
  JOIN_KEY,
  SPREADSHEET_ID,
  EXPECTED_NODES,
  NODE_TYPES,
  ALWAYS_OUTPUT_DATA,
  TRIGGER_ERROR_KEYS,
  RECONCILIATION_SOURCE,
  BANNED_NODE_TYPES,
  SENSITIVE_KEYS,
  FIXED_NOW,
  FIXED_RUN_ID,
  TOPOLOGY,
  EXPECTED_EDGES,
  workflowEdges,
  reachableNodes,
  codeNodeReferences,
  incomingCounts,
  outgoingCounts,
  pairedItemAncestors,
  META_REQUIREMENTS,
  stripRuntime,
  projectWorkflowInputs,
  engineBehaviorFor,
  assertEngineEquivalence,
  referenceWorkflow,
  describeWorkflowContract,
  assertCleanSource,
  assertWorkflowContract,
  interpretationIdFor,
};