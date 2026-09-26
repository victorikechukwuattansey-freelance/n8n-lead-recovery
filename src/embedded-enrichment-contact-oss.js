'use strict';

/*
 * Embedded code for the "Enrich Contact (OSS Fallback)" node of Lead Recovery
 * Engine — Enrichment V1 (Prompt H.5).
 *
 * The embedded source is DERIVED by composing the shared modules that the
 * offline tests exercise directly — src/enrichment-schema.js +
 * src/enrichment-cache.js + src/enrichment-contact.js +
 * src/enrichment-contact-oss.js — so the workflow mirror can never drift from
 * the modules under test. The builder injects the exported string verbatim into
 * the node's jsCode; the workflow test suite asserts the shipped artifact
 * matches this string byte-for-byte and that its behavior equals the engine
 * module on every fixture (parity test).
 *
 * Node contract: reads leads from `$input.all()`, cached log rows from the
 * 'Read Contact Enrichment Log' node, and an OSS resolver STUB seam from the
 * input payload (ossResults keyed by domain). The exported copy is
 * self-contained — no requires, no process.env, no Date.now/Math.random. The
 * resolver lives on the runner side; the fixture/parity harness stubs it.
 *
 * Zero-credit engine (provider 'oss'): the enrichment is free, so credits stay
 * 0 and log rows carry ''. Empty-with-block resolver results surface as manual
 * operator decisions (contact_blocked='TRUE', provider 'manual') rather than
 * calls.
 */

const fs = require('node:fs');
const path = require('node:path');

const MODULES = [
  'enrichment-schema.js',
  'enrichment-cache.js',
  'enrichment-contact.js',
  'enrichment-contact-oss.js',
].map((file) => path.join(__dirname, file));

const MODULE_SOURCES = MODULES.map((file) => fs.readFileSync(file, 'utf8'));

const { composeBodies } = require('./embedded-enrichment-contact');

const ENGINE_BODY = composeBodies(MODULE_SOURCES);

const embeddedContactOssSource = `'use strict';

/*
 * Enrich Contact (OSS Fallback) — Lead Recovery Engine · Enrichment V1.
 * Self-contained mirror composed from the enrichment modules (single source of
 * truth). Zero-credit fallback for Hunter-empty domains (provider 'oss');
 * resolver transport from the runner-injected seam (payload ossResults).
 * Deterministic: now/runId injected from input.
 */
${ENGINE_BODY}

const inputItems = $input.all();
const payload = (inputItems[0] && inputItems[0].json) || {};
const leads = (inputItems || []).map((item) => (item && item.json) || {});
const logItems = $('Read Contact Enrichment Log').all();
const logRows = (logItems || []).map((item) => (item && item.json) || {});
const ossResults = (payload && payload.ossResults) || {};

const resolver = async (domain) => {
  const result = (ossResults && ossResults[domain]) || {};
  return result;
};

const result = await enrichContactOss({
  leads,
  logRows,
  resolver,
  now: payload.now || payload.run_timestamp || '',
  runId: payload.runId || payload.run_id || '',
});

return [{
  json: {
    enriched: result.enriched,
    skipped: result.skipped,
    failed: result.failed,
    stats: result.stats,
    log: result.log,
  },
}];
`;

module.exports = {
  embeddedContactOssSource,
  MODULES,
};