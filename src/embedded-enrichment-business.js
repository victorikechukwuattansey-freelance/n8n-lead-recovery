'use strict';

/*
 * Embedded code for the "Enrich Business" node of Lead Recovery Engine —
 * Enrichment V1 (Prompt H.2).
 *
 * The embedded source is DERIVED from src/enrichment-business.js (the engine is
 * the single source of truth) rather than hand-duplicated, so the workflow
 * mirror can never drift from the module the offline tests exercise. The
 * builder (scripts/build-enrichment-workflow.js) injects the exported string
 * verbatim into the node's jsCode; the workflow test suite asserts the shipped
 * artifact matches this string byte-for-byte and that its behavior equals the
 * engine module on every fixture (parity test, same discipline as Response
 * Interpretation).
 *
 * Node contract: reads Raw Leads items from the current input (`$input.all()`),
 * reads the Overture index from the 'Load Overture Index' node, runs the
 * engine, and emits exactly one item carrying { enriched, unmatched, stats }.
 * Self-contained: no requires, no process.env (never reads HUNTER_API_KEY — the
 * business stage is keyless), no Date.now/Math.random.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENGINE_PATH = path.join(__dirname, 'enrichment-business.js');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');

// Strip the engine's own header docblock (kept in the module, not in the node),
// the top-level 'use strict' (re-added once), and the terminal module.exports
// block — everything else is pure top-level function declarations that are safe
// to evaluate inside the node body. The header docblock is removed too so no
// scanner-banned wording (e.g. "Math.random") ever ships inside a code node.
function engineBodyFrom(source) {
  let text = source.replace(/^'use strict';?\s*\n?/, '');
  text = text.replace(/^\/\*[\s\S]*?\*\/\s*\n?/, '');
  const withoutExports = text.replace(/\nmodule\.exports = \{[\s\S]*$/, '');
  return withoutExports
    .split('\n')
    .filter((line) => line.trim() !== "'use strict';" && line.trim() !== "")
    .join('\n');
}

const ENGINE_BODY = engineBodyFrom(ENGINE_SOURCE);

const embeddedBusinessSource = `'use strict';

/*
 * Enrich Business — Lead Recovery Engine · Enrichment V1 (business half).
 * Self-contained mirror of src/enrichment-business.js ($injected from module).
 * Matches Raw Leads against the Overture index and fills only empty target
 * fields. Deterministic: now/runId come from input.
 */
${ENGINE_BODY}

const inputItems = $input.all();
const indexItems = $('Load Overture Index').all();
const index = (indexItems[0] && indexItems[0].json && indexItems[0].json.index) || [];
const payload = (inputItems[0] && inputItems[0].json) || {};
const leads = (inputItems || []).map((item) => (item && item.json) || {});

const result = enrichBusinessLeads({
  leads,
  index,
  now: payload.now || payload.run_timestamp || '',
  runId: payload.runId || payload.run_id || '',
});

return [{ json: { enriched: result.enriched, unmatched: result.unmatched, stats: result.stats } }];
`;

module.exports = {
  embeddedBusinessSource,
  engineBodyFrom,
  ENGINE_PATH,
};