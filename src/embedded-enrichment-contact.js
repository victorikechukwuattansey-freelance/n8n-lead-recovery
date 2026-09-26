'use strict';

/*
 * Embedded code for the "Enrich Contact" node of Lead Recovery Engine —
 * Enrichment V1 (Prompt H.4-rev).
 *
 * The embedded source is DERIVED by composing the shared modules that the
 * offline tests exercise directly — src/enrichment-schema.js +
 * src/enrichment-cache.js + src/enrichment-contact.js — so the workflow mirror
 * can never drift from the modules under test. The builder
 * (scripts/build-enrichment-workflow.js) injects the exported string verbatim
 * into the node's jsCode; the workflow test suite asserts the shipped artifact
 * matches this string byte-for-byte and that its behavior equals the engine
 * module on every fixture (parity test, same discipline as Response
 * Interpretation).
 *
 * Node contract: reads leads from `$input.all()`, cached log rows from the
 * 'Read Contact Enrichment Log' node, and a provider STUB seam from the input
 * payload. The seam is provider-aware: `payload.provider` selects the seam
 * maps — agentdataResults / agentdataFailures for AgentData (default), else
 * hunterResults / hunterFailures — each keyed by domain. The exported copy is
 * self-contained — no requires, no process.env (never reads an API key), no
 * Date.now/Math.random. Provider calls happen through the injected `client`
 * whose transport is the lead-workflow runner; in the fixture/parity harness
 * that transport is a stub map.
 *
 * The seam convention mirrors the module contract: each input item's `.json`
 * carries the lead row; the first item's `.json` also carries the run context
 * (now/runId) plus the provider seams.
 */

const fs = require('node:fs');
const path = require('node:path');

const MODULES = ['enrichment-schema.js', 'enrichment-cache.js', 'enrichment-contact.js'].map((file) =>
  path.join(__dirname, file),
);

const MODULE_SOURCES = MODULES.map((file) => fs.readFileSync(file, 'utf8'));

// Same transforms as the business mirror's engineBodyFrom, plus require-line
// stripping: every `const { … } = require('…');` (single or multi-line form) is
// dropped because the composed copy must be require-free. Each module's header
// (leading 'use strict' + docblock) is stripped so no descriptive text that the
// clean-source scanner bans (e.g. "Math.random") leaks into the emitted node.
function stripHeader(source) {
  let text = source.replace(/^'use strict';?\s*\n?/, '');
  text = text.replace(/^\/\*[\s\S]*?\*\/\s*\n?/, '');
  return text;
}

function composeBodies(sources) {
  const stripped = sources.map((source) => {
    const withoutExports = source.replace(/\nmodule\.exports = \{[\s\S]*$/, '');
    return withoutExports
      .replace(/const\s*\{[\s\S]*?\}\s*=\s*require\(['"][^'"]+['"]\);\s*/g, '')
      .split('\n')
      .filter((line) => line.trim() !== "'use strict';" && line.trim() !== '')
      .join('\n');
  });
  return stripped.map(stripHeader).join('\n\n');
}

const ENGINE_BODY = composeBodies(MODULE_SOURCES);

const embeddedContactSource = `'use strict';

/*
 * Enrich Contact — Lead Recovery Engine · Enrichment V1 (contact half).
 * Self-contained mirror composed from src/enrichment-schema.js +
 * src/enrichment-cache.js + src/enrichment-contact.js (single source of truth).
 * Provider transport comes from the runner-injected client (payload seams:
 * agentdataResults / agentdataFailures for the default provider; hunterResults
 * / hunterFailures when payload.provider signals 'hunter'). Deterministic:
 * now/runId injected from input.
 */
${ENGINE_BODY}

const inputItems = $input.all();
const payload = (inputItems[0] && inputItems[0].json) || {};
const leads = (inputItems || []).map((item) => (item && item.json) || {});
const logItems = $('Read Contact Enrichment Log').all();
const logRows = (logItems || []).map((item) => (item && item.json) || {});
const provider = String((payload && payload.provider) || 'agentdata').toLowerCase();
const isAgentData = provider === 'agentdata';
const agentdataResults = (payload && payload.agentdataResults) || {};
const agentdataFailures = (payload && payload.agentdataFailures) || {};
const hunterResults = isAgentData ? {} : ((payload && payload.hunterResults) || {});
const hunterFailures = isAgentData ? {} : ((payload && payload.hunterFailures) || {});
const resultsMap = isAgentData ? agentdataResults : hunterResults;
const failuresMap = isAgentData ? agentdataFailures : hunterFailures;

const client = {
  provider,
  domainSearch: async (domain) => {
    if (failuresMap && failuresMap[domain]) {
      const failure = failuresMap[domain];
      const err = new Error(failure.reason || 'provider_failed');
      err.fatal = failure.fatal === true;
      err.reason = failure.reason || '';
      err.status = failure.status || null;
      throw err;
    }
    const result = (resultsMap && resultsMap[domain]) || null;
    if (result == null) {
      return { emails: [], source: provider, creditsUsed: 0 };
    }
    return {
      emails: result.emails || [],
      source: result.source || provider,
      creditsUsed: result.creditsUsed === undefined || result.creditsUsed === null ? 1 : result.creditsUsed,
    };
  },
};

const result = await enrichContactLeads({
  leads,
  logRows,
  client,
  now: payload.now || payload.run_timestamp || '',
  runId: payload.runId || payload.run_id || '',
});

return [{
  json: {
    provider: result.provider,
    enriched: result.enriched,
    skipped: result.skipped,
    failed: result.failed,
    stats: result.stats,
    log: result.log,
    ...(result.fatal ? { fatal: result.fatal } : {}),
  },
}];
`;

module.exports = {
  embeddedContactSource,
  composeBodies,
  MODULES,
};