'use strict';

/*
 * Dedicated offline n8n Code-node harness for the Approved Outreach Handoff
 * stage (Prompt C-B, Part B).
 *
 * Mirrors the Prospect Finder mirror harness pattern
 * (tests/helpers/prospect-finder-vm.js): the SAME vm sandbox + frozen-Date
 * executor (runNode) is reused, but jsCode is sourced from ONLY the Handoff
 * artifact (Approved Outreach Handoff V1.json) — the Handoff stage has no
 * canonical src/ engine module; its logic ships as embedded code inside the
 * artifact's three code nodes:
 *
 *   Filter Eligible Leads
 *   Dedup Against Approved Outreach
 *   Prepare Approved Outreach Rows
 *
 * No live HTTP, no credentials, no network — deterministic, offline, and
 * provider-independent (same constraint set as handoff-workflow.test.js).
 */

const path = require('node:path');
const fs = require('node:fs');

const { runNode } = require('./prospect-finder-vm.js');

const HANDOFF_ARTIFACT_PATH = path.join(__dirname, '..', '..', 'Approved Outreach Handoff V1.json');

const HANDOFF_CODE_NODES = [
  'Filter Eligible Leads',
  'Dedup Against Approved Outreach',
  'Prepare Approved Outreach Rows',
];

let cachedArtifact = null;
function handoffArtifact() {
  if (cachedArtifact === null) {
    cachedArtifact = JSON.parse(fs.readFileSync(HANDOFF_ARTIFACT_PATH, 'utf8'));
  }
  return cachedArtifact;
}

function handoffNodeCode(name) {
  const node = handoffArtifact().nodes.find((n) => n.name === name);
  if (!node || typeof node.parameters.jsCode !== 'string') {
    throw new Error(`node '${name}' does not carry jsCode in the Handoff artifact`);
  }
  return node.parameters.jsCode;
}

module.exports = {
  HANDOFF_ARTIFACT_PATH,
  HANDOFF_CODE_NODES,
  handoffArtifact,
  handoffNodeCode,
  runNode,
};