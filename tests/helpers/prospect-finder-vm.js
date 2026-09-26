'use strict';

/*
 * Shared offline n8n Code-node vm sandbox for Prospect Finder node bodies.
 *
 * Extracted from tests/prospect-finder-error-paths.test.js (the A.6 pattern)
 * so the error-path suite and the C-A engine harness execute node bodies
 * through the SAME bindings:
 *
 *   - $input.first() / $input.all()              (current node's input items)
 *   - $('NodeName').first() / $('NodeName').all() (output of an upstream node)
 *   - $getWorkflowStaticData('global')           (shared static data bag)
 *   - $json                                      (first input item's json — used by
 *                                                 Build FSQ API Query and Build GPL
 *                                                 API Query, which read $json directly)
 *
 * No live HTTP, no credentials, no network — deterministic and
 * provider-agnostic. Node bodies are executed via node:vm against the mock
 * globals exactly as shipped.
 *
 * Determinism: pass `fixedNow` (ISO string) to bind a frozen Date constructor
 * so node bodies that call `new Date().toISOString()` (raw_captured_at,
 * verified_at, workflowStartedAt) become fully deterministic and assertable.
 *
 * Two jsCode sources are exposed so callers can pin WHICH instance they test:
 *
 *   - embeddedNodeCode(name) -> src/prospect-finder-embedded-code.js (canonical
 *                               editable source; the C-A engine harness loads
 *                               from here per spec — tests never duplicate code)
 *   - artifactNodeCode(name) -> Lead Recovery Engine … V1.json node.parameters.jsCode
 *                               (what ships in the workflow)
 *
 * The embedded<->artifact byte parity between the two is asserted explicitly in
 * tests/prospect-finder-engine.test.js (C-A §5).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EMBEDDED_CODE_PATH = path.join(__dirname, '..', '..', 'src', 'prospect-finder-embedded-code.js');
const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'Lead Recovery Engine — Prospect Finder & Validation V1.json');

// eslint-disable-next-line global-require
const { CODE_BY_NODE } = require(EMBEDDED_CODE_PATH);

let cachedArtifact = null;
function artifactWorkflow() {
  if (cachedArtifact === null) {
    cachedArtifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  }
  return cachedArtifact;
}

function artifactNodeCode(name) {
  const workflow = artifactWorkflow();
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) {
    throw new Error(`node '${name}' does not exist in the workflow artifact`);
  }
  return node.parameters.jsCode;
}

function embeddedNodeCode(name) {
  const code = CODE_BY_NODE[name];
  if (code === undefined) {
    throw new Error(`embedded code node '${name}' does not exist in src/prospect-finder-embedded-code.js`);
  }
  return code;
}

function fixedDate(iso) {
  const fixed = new Date(iso);
  return class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(fixed.getTime());
      } else {
        super(...args);
      }
    }
    static now() {
      return fixed.getTime();
    }
    static parse(value) {
      return Date.parse(value);
    }
    static UTC(...args) {
      return Date.UTC(...args);
    }
  };
}

/*
 * vm.runInNewContext produces objects that carry the CONTEXT's prototypes
 * (a separate vm realm). assert.deepEqual / assert.deepStrictEqual then fails
 * with "Values have same structure but are not reference-equal" even when the
 * data is byte-identical, because the prototypes differ. Everyone (engine
 * harness AND error-path suite) wants plain main-realm data back, so runNode
 * deep-escapes every value returned by the node body into the main realm.
 */
function escapeRealm(value) {
  if (value === null || value === undefined || typeof value === 'function') {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return value;
  }

  const tag = Object.prototype.toString.call(value);

  if (tag === '[object Date]') {
    return new Date(value.getTime());
  }
  if (tag === '[object Set]') {
    return new Set(Array.from(value, escapeRealm));
  }
  if (tag === '[object Map]') {
    return new Map(Array.from(value, ([key, val]) => [escapeRealm(key), escapeRealm(val)]));
  }
  if (tag === '[object Array]') {
    return Array.from(value, escapeRealm);
  }

  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = escapeRealm(value[key]);
  }
  return out;
}

/*
 * Executes a node body against mocked n8n globals.
 *
 *   jsCode      — the node body to execute (from embeddedNodeCode / artifactNodeCode)
 *   opts        - { inputItems, nodeData, staticData, fixedNow }
 *     inputItems  — array of { json } items presented by $input
 *     nodeData    — map of upstream node name -> array of { json } items
 *     staticData  — the mutable workflow static-data bag
 *     fixedNow    — optional ISO string; when present, Date is frozen to it
 *
 * Returns { items, staticData } exactly like the error-path suite's helper.
 * Both are escaped back into the main realm (see escapeRealm above).
 */
function runNode(jsCode, { inputItems = [{ json: {} }], nodeData = {}, staticData = {}, fixedNow } = {}) {
  const state = { staticData };
  const accessorCache = new Map();

  const resolve = (name) => {
    if (accessorCache.has(name)) return accessorCache.get(name);
    const items = (nodeData[name] || []).map((raw) => ({ json: raw && raw.json !== undefined ? raw.json : raw }));
    const accessor = { first: () => items[0] || { json: {} }, all: () => items };
    accessorCache.set(name, accessor);
    return accessor;
  };

  const firstInput = inputItems[0] || { json: {} };

  const sandbox = {
    $input: {
      first: () => firstInput,
      all: () => inputItems,
    },
    $json: firstInput.json,
    $getWorkflowStaticData: () => state.staticData,
    $: resolve,
    Math,
    Date: fixedNow ? fixedDate(fixedNow) : Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    RegExp,
    Boolean,
    Error,
    Symbol,
    Set,
    Map,
    Promise,
    undefined,
  };

  const fn = vm.runInNewContext(`(function() {\n${jsCode}\n})`, sandbox, { filename: 'embedded-node.js' });
  const items = fn();
  // Escape values in place so the CALLER's staticData reference (the one the
  // node body mutated through $getWorkflowStaticData) also sees main-realm data.
  const resolvedStaticData = state.staticData;
  for (const key of Object.keys(resolvedStaticData)) {
    resolvedStaticData[key] = escapeRealm(resolvedStaticData[key]);
  }
  return { items: escapeRealm(items), staticData: resolvedStaticData };
}

module.exports = {
  EMBEDDED_CODE_PATH,
  ARTIFACT_PATH,
  artifactWorkflow,
  artifactNodeCode,
  embeddedNodeCode,
  runNode,
};