'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WF_PATH = path.join(__dirname, '..', 'Enrichment V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const {
  enrichmentWorkflow,
  OUTPUT,
  WORKFLOW_NAME,
  ARTIFACT,
  SPREADSHEET_ID,
  ENRICHMENT_LOG_SHEET,
  APPROVED_SHEET,
  UPDATED_COLUMNS,
  ENRICHMENT_LOG_COLUMNS,
  ALWAYS_OUTPUT_DATA,
  CODE_SOURCES,
  PREPARE_ENRICHMENT_SCOPE_CODE,
  PREPARE_OSS_FALLBACK_SCOPE_CODE,
  CONSOLIDATE_ENRICHMENT_RESULTS_CODE,
  SPLIT_ENRICHMENT_LOG_ROWS_CODE,
  SPLIT_CONTACT_UPDATES_CODE,
  REPORT_ENRICHMENT_RUN_CODE,
} = require('../scripts/build-enrichment-workflow');
const {
  assertCleanSource,
  codeNodeReferences,
  pairedItemAncestors,
  reachableNodes,
} = require('../src/response-interpretation-workflow-contract');
const { enrichContactLeads } = require('../src/enrichment-contact');
const { enrichContactOss } = require('../src/enrichment-contact-oss');
const { embeddedContactSource } = require('../src/embedded-enrichment-contact');
const { embeddedContactOssSource } = require('../src/embedded-enrichment-contact-oss');
const { loadEnrichmentFixtures, CONTACT_FIXTURES_PATH, AGENTDATA_CONTACT_FIXTURES_PATH } = require('../fixtures/enrichment-fixtures.js');

const SEAM_KEYS = [
  'now',
  'runId',
  'run_timestamp',
  'run_id',
  'provider',
  'agentdataResults',
  'agentdataFailures',
  'hunterResults',
  'hunterFailures',
  'ossResults',
];

const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Contact Enrichment Log',
  'Read Approved Outreach',
  'Prepare Enrichment Scope',
  'Enrich Contact',
  'Prepare OSS Fallback Scope',
  'Enrich Contact OSS Fallback',
  'Consolidate Enrichment Results',
  'Has Enrichment Output?',
  'Split Enrichment Log Rows',
  'Write Contact Enrichment Log',
  'Split Contact Updates',
  'Update Approved Outreach Contacts',
  'Report Enrichment Run',
  'Enrichment Complete',
  'No-Op End',
];

const EXPECTED_EDGES = [
  ['Manual Trigger', 'Read Contact Enrichment Log'],
  ['Read Contact Enrichment Log', 'Read Approved Outreach'],
  ['Read Approved Outreach', 'Prepare Enrichment Scope'],
  ['Prepare Enrichment Scope', 'Enrich Contact'],
  ['Enrich Contact', 'Prepare OSS Fallback Scope'],
  ['Prepare OSS Fallback Scope', 'Enrich Contact OSS Fallback'],
  ['Enrich Contact OSS Fallback', 'Consolidate Enrichment Results'],
  ['Consolidate Enrichment Results', 'Has Enrichment Output?'],
  ['Has Enrichment Output?', 'Split Enrichment Log Rows'],
  ['Has Enrichment Output?', 'Split Contact Updates'],
  ['Has Enrichment Output?', 'No-Op End'],
  ['Split Enrichment Log Rows', 'Write Contact Enrichment Log'],
  ['Split Contact Updates', 'Update Approved Outreach Contacts'],
  ['Update Approved Outreach Contacts', 'Report Enrichment Run'],
  ['Report Enrichment Run', 'Enrichment Complete'],
];

const ZERO_OUTGOING = ['Write Contact Enrichment Log', 'Enrichment Complete', 'No-Op End'];

const fixtures = [
  ...loadEnrichmentFixtures(CONTACT_FIXTURES_PATH),
  ...loadEnrichmentFixtures(AGENTDATA_CONTACT_FIXTURES_PATH),
];

function byName(name) {
  const node = WF.nodes.find((n) => n.name === name);
  if (!node) throw new Error('Node not found: ' + name);
  return node;
}

function jsCodeOf(name) {
  const code = byName(name).parameters.jsCode || '';
  if (!code) throw new Error('No jsCode on node: ' + name);
  return code;
}

function itemsFromRows(rows) {
  return (rows || []).map((json) => ({ json }));
}

function workflowEdgesOf(wf) {
  const edges = [];
  for (const [source, conns] of Object.entries(wf.connections || {})) {
    for (const branch of (conns.main || [])) {
      for (const edge of branch || []) {
        edges.push([source, edge.node]);
      }
    }
  }
  return edges.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/* ------------------------------------------------------------------ */
/* Fixture -> client seams (mirror of the engine test helpers)          */
/* ------------------------------------------------------------------ */

function stubClientFor(fx) {
  const provider = fx.provider || 'agentdata';
  return {
    provider,
    domainSearch: async (domain) => {
      const entry = (fx.domainResults || {})[domain];
      if (entry == null) return { emails: [], source: provider, creditsUsed: 0 };
      if (entry.fatal === true) {
        const err = new Error(entry.reason || 'stub_fatal');
        err.fatal = true;
        err.reason = entry.reason || 'stub_fatal';
        err.status = entry.status || null;
        throw err;
      }
      if (entry.error === true) {
        const err = new Error(entry.reason || 'stub_error');
        err.fatal = false;
        err.reason = entry.reason || 'stub_error';
        err.status = entry.status || null;
        throw err;
      }
      return { emails: entry.emails || [], source: provider, creditsUsed: entry.creditsUsed || 0 };
    },
  };
}

function seamsFor(fx) {
  const provider = fx.provider || 'agentdata';
  const agentdataResults = {};
  const agentdataFailures = {};
  const hunterResults = {};
  const hunterFailures = {};
  for (const [domain, entry] of Object.entries(fx.domainResults || {})) {
    if (entry.fatal === true || entry.error === true) {
      hunterFailures[domain] = { fatal: entry.fatal === true, reason: entry.reason || '', status: entry.status || null };
      agentdataFailures[domain] = { fatal: entry.fatal === true, reason: entry.reason || '', status: entry.status || null };
    } else {
      hunterResults[domain] = { emails: entry.emails || [], creditsUsed: entry.creditsUsed || 0 };
      agentdataResults[domain] = {
        emails: entry.emails || [],
        source: entry.source || provider,
        creditsUsed: entry.creditsUsed === undefined || entry.creditsUsed === null ? 0 : entry.creditsUsed,
      };
    }
  }
  return {
    now: fx.now,
    runId: fx.runId,
    run_timestamp: fx.now,
    run_id: fx.runId,
    provider,
    agentdataResults,
    agentdataFailures,
    hunterResults,
    hunterFailures,
    ossResults: fx.ossResults || {},
  };
}

function stripSeams(value) {
  if (Array.isArray(value)) return value.map(stripSeams);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SEAM_KEYS.includes(key)) continue;
      out[key] = stripSeams(child);
    }
    return out;
  }
  return value;
}

function scrubSeams(rows) {
  return (rows || []).map((row) => stripSeams(row));
}

function contentScore(update) {
  return UPDATED_COLUMNS.filter((c) => c !== 'lead_id').reduce(
    (n, field) => n + (String(update[field] || '').trim() !== '' ? 1 : 0),
    0,
  );
}

/* ------------------------------------------------------------------ */
/* Async code-node executor                                             */
/* ------------------------------------------------------------------ */

async function executeCode(nodeName, opts = {}) {
  const source = jsCodeOf(nodeName);
  const input = opts.input || [];
  const refs = opts.refs || {};
  const $input = { all: () => input };
  const $ = (name) => ({ all: () => refs[name] || [], item: () => (refs[name] || [])[0] && (refs[name] || [])[0].json });
  const body = '"use strict";\nreturn (async function () {\n' + source + '\n})();';
  const fn = new Function('$input', '$json', '$', body);
  return fn($input, {}, $);
}

function triggerItemsFor(fx) {
  return [{ json: Object.assign({ event: 'workflow' }, seamsFor(fx)) }];
}

async function runChain(fx) {
  const trigger = triggerItemsFor(fx);
  const approved = itemsFromRows(fx.leads);
  const logRead = itemsFromRows(fx.cacheRows);

  const prepareOut = await executeCode('Prepare Enrichment Scope', {
    input: approved,
    refs: { 'Manual Trigger': trigger, 'Read Approved Outreach': approved },
  });

  const contactOut = await executeCode('Enrich Contact', {
    input: prepareOut,
    refs: { 'Read Contact Enrichment Log': logRead },
  });

  const prepareOssOut = await executeCode('Prepare OSS Fallback Scope', {
    input: contactOut,
    refs: {
      'Enrich Contact': contactOut,
      'Read Approved Outreach': approved,
      'Manual Trigger': trigger,
    },
  });

  const ossOut = await executeCode('Enrich Contact OSS Fallback', {
    input: prepareOssOut,
    refs: { 'Read Contact Enrichment Log': logRead },
  });

  const consolidated = await executeCode('Consolidate Enrichment Results', {
    input: contactOut,
    refs: {
      'Enrich Contact': contactOut,
      'Enrich Contact OSS Fallback': ossOut,
      'Manual Trigger': trigger,
    },
  });

  const report = await executeCode('Report Enrichment Run', {
    input: [],
    refs: { 'Consolidate Enrichment Results': consolidated },
  });

  return {
    trigger,
    approved,
    logRead,
    prepareOut,
    contactOut,
    prepareOssOut,
    ossOut,
    consolidated,
    report,
  };
}

/* ------------------------------------------------------------------ */
/* Structural contract                                                  */
/* ------------------------------------------------------------------ */

test('workflow has exactly the expected 16-node enrichment set with unique names and ids', () => {
  const names = WF.nodes.map((n) => n.name);
  assert.deepEqual([...new Set(names)].sort(), [...EXPECTED_NODES].sort());
  assert.equal(names.length, 16, 'expected exactly 16 nodes');
  const ids = WF.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'node ids must be unique');
  assert.ok(ids.every((id) => /^enrich-[a-z0-9-]+$/.test(id)), 'nodes must use the deterministic enrich- id namespace');
});

test('nodes appear in the canonical order with id, type, typeVersion and position pinned', () => {
  const expected = {
    'Manual Trigger': { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    'Read Contact Enrichment Log': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [260, 0] },
    'Read Approved Outreach': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [520, 0] },
    'Prepare Enrichment Scope': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [780, 0] },
    'Enrich Contact': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [1040, 0] },
    'Prepare OSS Fallback Scope': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [1300, 0] },
    'Enrich Contact OSS Fallback': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [1560, 0] },
    'Consolidate Enrichment Results': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [1820, 0] },
    'Has Enrichment Output?': { type: 'n8n-nodes-base.if', typeVersion: 2, position: [2080, 0] },
    'Split Enrichment Log Rows': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [2340, -160] },
    'Write Contact Enrichment Log': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [2600, -160] },
    'Split Contact Updates': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [2340, 160] },
    'Update Approved Outreach Contacts': { type: 'n8n-nodes-base.googleSheets', typeVersion: 4, position: [2600, 160] },
    'Report Enrichment Run': { type: 'n8n-nodes-base.code', typeVersion: 2, position: [2860, 160] },
    'Enrichment Complete': { type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [3120, 160] },
    'No-Op End': { type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2340, 320] },
  };
  WF.nodes.forEach((node, index) => {
    const exp = expected[node.name];
    assert.ok(exp, `unexpected node at index ${index}: ${node.name}`);
    assert.equal(index, EXPECTED_NODES.indexOf(node.name), 'nodes must be in canonical order');
    assert.equal(node.type, exp.type, `${node.name} type`);
    assert.equal(node.typeVersion, exp.typeVersion, `${node.name} typeVersion`);
    assert.deepEqual(node.position, exp.position, `${node.name} position`);
  });
});

test('exactly six code nodes set alwaysOutputData and they are the documented ones', () => {
  const always = WF.nodes.filter((n) => n.alwaysOutputData === true).map((n) => n.name).sort();
  assert.deepEqual(always, [...ALWAYS_OUTPUT_DATA].sort());
  const operation = (name) => byName(name).parameters.operation;
  assert.equal(operation('Read Contact Enrichment Log'), 'read');
  assert.equal(operation('Read Approved Outreach'), 'read');
  assert.equal(operation('Write Contact Enrichment Log'), 'append');
  assert.equal(operation('Update Approved Outreach Contacts'), 'update');
});

test('connections match the canonical edge set and every terminal has zero outgoing edges', () => {
  const actual = workflowEdgesOf(WF).map(([from, to]) => `${from} -> ${to}`).sort();
  const expected = EXPECTED_EDGES.map(([from, to]) => `${from} -> ${to}`).sort();
  assert.deepEqual(actual, expected);
  const nameSet = new Set(WF.nodes.map((n) => n.name));
  const outCounts = new Map();
  for (const [source, conns] of Object.entries(WF.connections)) {
    assert.ok(nameSet.has(source), 'missing source node: ' + source);
    for (const branch of conns.main) {
      for (const edge of branch) {
        assert.ok(nameSet.has(edge.node), 'missing target node: ' + edge.node);
        outCounts.set(source, (outCounts.get(source) || 0) + 1);
      }
    }
  }
  for (const name of EXPECTED_NODES) {
    if (ZERO_OUTGOING.includes(name)) {
      assert.equal(outCounts.get(name) || 0, 0, `${name} must be a terminal`);
    } else if (name === 'Has Enrichment Output?') {
      assert.equal(outCounts.get(name) || 0, 3, 'the IF node must fan out to both splits and No-Op End');
    } else {
      assert.equal(outCounts.get(name) || 0, 1, `${name} must have exactly one outgoing edge`);
    }
  }
});

test('the IF node fans output[0] to both splits and output[1] to No-Op End', () => {
  const branches = WF.connections['Has Enrichment Output?'].main.map((branch) => branch.map((e) => e.node));
  assert.deepEqual(branches, [['Split Enrichment Log Rows', 'Split Contact Updates'], ['No-Op End']]);
});

test('every node is reachable from Manual Trigger', () => {
  const names = WF.nodes.map((n) => n.name);
  const reachable = reachableNodes(WF.connections, names);
  for (const name of names) {
    if (name === 'Manual Trigger') continue;
    assert.ok(reachable.has(name), `unreachable node: ${name}`);
  }
});

test('every $($json) code reference resolves to a transitive pairedItem ancestor', () => {
  const names = WF.nodes.map((n) => n.name);
  const nameSet = new Set(names);
  for (const name of EXPECTED_NODES) {
    const node = byName(name);
    const code = node.parameters && node.parameters.jsCode;
    if (typeof code !== 'string' || code.length === 0) continue;
    const ancestors = pairedItemAncestors(WF.connections, name, names);
    for (const ref of codeNodeReferences(code)) {
      assert.ok(nameSet.has(ref), `${name} references unknown node ${ref}`);
      assert.ok(ancestors.has(ref), `${name} references ${ref} which is not a transitive pairedItem ancestor`);
    }
  }
});

test('workflow is shipped inactive with the enrichment meta contract', () => {
  assert.equal(WF.active, false);
  assert.equal(WF.meta.artifact, 'Enrichment V1');
  assert.equal(WF.meta.readOnly, false);
  assert.deepEqual(WF.meta.sheets, ['Contact Enrichment Log', 'Approved Outreach']);
  assert.equal(WF.meta.spreadsheetId, SPREADSHEET_ID);
  assert.match(WF.meta.generatedBy, /build-enrichment-workflow\.js/);
  assert.match(WF.meta.emptyRunBehavior, /No-Op End/);
  assert.match(WF.meta.fatalBehavior, /No-Op End/);
});

test('sheet nodes target the pinned spreadsheet and the two allowed tabs', () => {
  const sheets = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.equal(sheets.length, 4);
  const targetSheets = sheets.map((n) => n.parameters.sheetName.value).sort();
  assert.deepEqual(targetSheets, ['Approved Outreach', 'Approved Outreach', 'Contact Enrichment Log', 'Contact Enrichment Log'].sort());
  for (const node of sheets) {
    assert.equal(node.parameters.documentId.value, SPREADSHEET_ID);
  }
});

test('the update node writes only the enrichment-owned columns and matches on lead_id', () => {
  const update = byName('Update Approved Outreach Contacts');
  const value = Object.keys(update.parameters.columns.value);
  const owned = UPDATED_COLUMNS.filter((c) => c !== 'lead_id');
  assert.deepEqual(value.sort(), owned.slice().sort(), 'update must map exactly the 7 enrichment-owned contact columns');
  assert.deepEqual(update.parameters.columns.matchingColumns, ['lead_id']);
  const schemaIds = update.parameters.columns.schema.map((s) => s.id);
  assert.deepEqual(schemaIds, UPDATED_COLUMNS);
  for (const entry of update.parameters.columns.schema) {
    assert.equal(entry.canBeUsedToMatch, true);
    assert.equal(entry.type, 'string');
  }
});

test('the append node maps the full 14-column Contact Enrichment Log contract', () => {
  const append = byName('Write Contact Enrichment Log');
  const value = Object.keys(append.parameters.columns.value);
  assert.deepEqual(value, ENRICHMENT_LOG_COLUMNS);
  for (const column of ENRICHMENT_LOG_COLUMNS) {
    assert.equal(append.parameters.columns.value[column], `={{ $json.${column} }}`);
  }
});

test('the IF node evaluates _hasOutput as a strict boolean true', () => {
  const cond = byName('Has Enrichment Output?').parameters.conditions;
  assert.equal(cond.combinator, 'and');
  assert.equal(cond.conditions.length, 1);
  const c = cond.conditions[0];
  assert.equal(c.leftValue, '={{ $json._hasOutput }}');
  assert.equal(c.rightValue, true);
  assert.deepEqual(c.operator, { type: 'boolean', operation: 'true', singleValue: true });
});

test('all workflow junction wiring is void of banned integration node types', () => {
  const types = WF.nodes.map((n) => n.type);
  for (const banned of [
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.twilio',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.hunter',
    'n8n-nodes-base.clearbit',
    'n8n-nodes-base.httpRequest',
  ]) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }
});

/* ------------------------------------------------------------------ */
/* Embedded-source integrity                                            */
/* ------------------------------------------------------------------ */

test('code node jsCode matches the builder CODE_SOURCES single source of truth', () => {
  const shipped = new Set();
  for (const [name, source] of Object.entries(CODE_SOURCES)) {
    assert.equal(byName(name).parameters.jsCode, source, `${name} jsCode`);
    shipped.add(name);
  }
  const codeNames = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => n.name).sort();
  assert.deepEqual(codeNames, [...shipped].sort(), 'every code node must be sourced from CODE_SOURCES');
});

test('Enrich Contact and Enrich Contact OSS Fallback inject the embedded mirrors byte-for-byte', () => {
  assert.equal(byName('Enrich Contact').parameters.jsCode, embeddedContactSource);
  assert.equal(byName('Enrich Contact OSS Fallback').parameters.jsCode, embeddedContactOssSource);
});

test('every code node passes the clean-source scanner', () => {
  for (const name of EXPECTED_NODES) {
    const node = byName(name);
    const code = node.parameters && node.parameters.jsCode;
    if (typeof code !== 'string' || code.length === 0) continue;
    assert.doesNotThrow(() => assertCleanSource(code), name);
  }
});

test('shipped workflow embeds no secrets, credentials, or env access', () => {
  const raw = fs.readFileSync(WF_PATH, 'utf8');
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/HUNTER_API_KEY/.test(raw), 'no HUNTER_API_KEY');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env interpolation');
  assert.ok(!raw.includes('credentials'), 'no embedded credential blocks');
  assert.ok(!/example\.com/.test(raw), 'no fixture email material in the shipped artifact');
});

test('deterministic build: the builder output byte-matches the shipped file', () => {
  const rebuilt = enrichmentWorkflow();
  assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(fs.readFileSync(WF_PATH, 'utf8')));
  assert.equal(
    fs.readFileSync(WF_PATH, 'utf8'),
    JSON.stringify(enrichmentWorkflow(), null, 2) + '\n',
    'rebuild must be byte-identical',
  );
  const hashOf = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  assert.equal(hashOf(fs.readFileSync(WF_PATH, 'utf8')), hashOf(JSON.stringify(rebuilt, null, 2) + '\n'));
  assert.equal(path.basename(OUTPUT), 'Enrichment V1.json');
});

/* ------------------------------------------------------------------ */
/* Chain behavior parity (fixtures 007-013)                             */
/* ------------------------------------------------------------------ */

test('enrichment chain matches the engine modules on every contact fixture', async () => {
  for (const fx of fixtures) {
    const chain = await runChain(fx);

    const moduleContact = await enrichContactLeads({
      leads: fx.leads,
      logRows: fx.cacheRows || [],
      client: stubClientFor(fx),
      now: fx.now,
      runId: fx.runId,
    });
    const contactEnvelope = chain.contactOut[0].json;
    assert.equal(contactEnvelope.provider, moduleContact.provider, `${fx.id}: provider label`);
    assert.deepEqual(scrubSeams(contactEnvelope.enriched), scrubSeams(moduleContact.enriched), `${fx.id}: contact enriched`);
    assert.deepEqual(scrubSeams(contactEnvelope.skipped), scrubSeams(moduleContact.skipped), `${fx.id}: contact skipped`);
    assert.deepEqual(scrubSeams(contactEnvelope.failed), scrubSeams(moduleContact.failed), `${fx.id}: contact failed`);
    assert.deepEqual(contactEnvelope.stats, moduleContact.stats, `${fx.id}: contact stats`);
    assert.deepEqual(contactEnvelope.log, moduleContact.log, `${fx.id}: contact log`);
    if (moduleContact.fatal) {
      assert.deepEqual(contactEnvelope.fatal, moduleContact.fatal, `${fx.id}: contact fatal`);
    } else {
      assert.equal('fatal' in contactEnvelope, false, `${fx.id}: contact fatal must be absent`);
    }
  }
});

test('OSS fallback node matches the OSS engine on the OSS-scope leads when the fallback runs', async () => {
  for (const fx of fixtures) {
    const chain = await runChain(fx);
    const ossEnvelope = chain.ossOut[0].json;
    const ossScope = chain.prepareOssOut.map((item) => item.json);

    // Fixture 011 has a fatal contact run -> Prepare OSS emits [] -> the OSS
    // node receives zero items and its envelope is the empty-engine result.
    // 013 has no hunter entries but its contact run still yields a Hunter
    // no_emails_found decision over an empty client; the OSS scope is the lead.
    const moduleOss = await enrichContactOss({
      leads: ossScope.map((row) => stripSeams(row)),
      logRows: fx.cacheRows || [],
      resolver: async (domain) => (fx.ossResults || {})[domain] || {},
      now: fx.now,
      runId: fx.runId,
    });

    assert.deepEqual(scrubSeams(ossEnvelope.enriched), scrubSeams(moduleOss.enriched), `${fx.id}: oss enriched`);
    assert.deepEqual(scrubSeams(ossEnvelope.skipped), scrubSeams(moduleOss.skipped), `${fx.id}: oss skipped`);
    assert.deepEqual(scrubSeams(ossEnvelope.failed), scrubSeams(moduleOss.failed), `${fx.id}: oss failed`);
    assert.deepEqual(ossEnvelope.stats, moduleOss.stats, `${fx.id}: oss stats`);
    assert.deepEqual(ossEnvelope.log, moduleOss.log, `${fx.id}: oss log`);
  }
});

test('consolidate merges both engines with dedupe, nesting, and _hasOutput routing', async () => {
  for (const fx of fixtures) {
    const chain = await runChain(fx);
    const consolidated = chain.consolidated[0].json;
    const contactEnvelope = chain.contactOut[0].json;
    const ossEnvelope = chain.ossOut[0].json;

    assert.equal(consolidated.run_id, fx.runId, `${fx.id}: run_id`);
    assert.equal(consolidated.run_timestamp, fx.now, `${fx.id}: run_timestamp`);
    assert.equal(consolidated.contact_provider, contactEnvelope.provider, `${fx.id}: contact_provider`);

    const expectedUpdates = [];
    const seenIds = new Set();
    const indexById = new Map();
    for (const row of contactEnvelope.enriched.concat(ossEnvelope.enriched)) {
      const id = String(row.lead_id || '').trim();
      if (!id) continue;
      const update = { lead_id: id };
      let hasContent = false;
      for (const field of UPDATED_COLUMNS.filter((c) => c !== 'lead_id')) {
        const value = row[field] === undefined || row[field] === null ? '' : String(row[field]);
        update[field] = value;
        if (value.trim() !== '') hasContent = true;
      }
      if (!hasContent) continue;
      const index = indexById.get(id);
      if (index === undefined) {
        indexById.set(id, expectedUpdates.length);
        seenIds.add(id);
        expectedUpdates.push(update);
      } else if (contentScore(update) > contentScore(expectedUpdates[index])) {
        expectedUpdates[index] = update;
      }
    }
    expectedUpdates.sort((a, b) => String(a.lead_id).localeCompare(String(b.lead_id)));
    assert.deepEqual(consolidated.contactUpdates, expectedUpdates, `${fx.id}: contactUpdates`);

    const expectedLogMap = new Map();
    for (const row of contactEnvelope.log.concat(ossEnvelope.log)) {
      const key = String(row.enrichment_key || '').trim();
      if (key && !expectedLogMap.has(key)) expectedLogMap.set(key, row);
    }
    const expectedLog = Array.from(expectedLogMap.values()).sort((a, b) => {
      const byKey = String(a.enrichment_key).localeCompare(String(b.enrichment_key));
      if (byKey !== 0) return byKey;
      const byAt = String(a.enriched_at).localeCompare(String(b.enriched_at));
      if (byAt !== 0) return byAt;
      return String(a.lead_id).localeCompare(String(b.lead_id));
    });
    assert.deepEqual(consolidated.logRows, expectedLog, `${fx.id}: logRows`);

    assert.deepEqual(consolidated.stats.contact, contactEnvelope.stats, `${fx.id}: contact stats`);
    assert.deepEqual(consolidated.stats.oss, ossEnvelope.stats, `${fx.id}: oss stats`);
    assert.equal(consolidated._hasOutput, consolidated.contactUpdates.length > 0 || consolidated.logRows.length > 0);

    if (contactEnvelope.fatal) assert.deepEqual(consolidated.fatal, contactEnvelope.fatal, `${fx.id}: fatal propagated`);
    else assert.equal('fatal' in consolidated, false, `${fx.id}: no fatal`);
  }
});

test('fixture 013: manual block stamps a manual provider log row and the update lineage', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-013');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  const update = consolidated.contactUpdates.find((u) => u.lead_id === 'RWL-0013-A');
  assert.ok(update, 'RWL-0013-A must be present');
  assert.equal(update.contact_blocked, 'TRUE');
  assert.equal(update.contact_source_provider, 'manual');
  assert.equal(update.email, '');

  const logRow = consolidated.logRows.find((r) => r.enrichment_key === 'missco.example.com::oss');
  assert.ok(logRow, 'OSS log row present');
  assert.equal(logRow.provider, 'manual');
  assert.equal(logRow.notes, 'no public email sources; operator review required');
  assert.deepEqual(consolidated.stats.oss, { total: 1, enriched: 1, skipped: 0, failed: 0, credits_consumed: 0, cache_hits: 0 });

  const splitOut = await executeCode('Split Contact Updates', {
    input: [{ json: consolidated }],
    refs: {},
  });
  assert.equal(splitOut.length, 1);
  assert.deepEqual(Object.keys(splitOut[0].json).sort(), [...UPDATED_COLUMNS].sort());
  assert.equal(splitOut[0].json.contact_blocked, 'TRUE');
  assert.equal(splitOut[0].json.contact_source_provider, 'manual');
});

test('fixture 011: a fatal-only run routes to No-Op End with zero updates, zero log rows and no report', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-011');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  assert.equal(consolidated._hasOutput, false);
  assert.deepEqual(consolidated.contactUpdates, []);
  assert.deepEqual(consolidated.logRows, []);
  assert.deepEqual(consolidated.fatal, { reason: 'hunter_auth_failed', status: 401 });

  const splitUpdates = await executeCode('Split Contact Updates', { input: [{ json: consolidated }], refs: {} });
  const splitLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.deepEqual(splitUpdates, [], 'no contact updates can reach the write path');
  assert.deepEqual(splitLog, [], 'no log rows can reach the write path');
});

test('cache-hit runs re-carry the cached row in the merged log but never re-append it', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-008');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  assert.ok(consolidated.contactUpdates.length > 0, 'cache hit still yields a contact update');
  assert.equal(consolidated.logRows.length, 1, 'the cache-hit row is re-carried with its incremented count');
  assert.equal(consolidated.logRows[0].enrichment_key, 'cachedco.example.com::hunter');
  assert.equal(consolidated.logRows[0].cache_hit_count, '3');

  const splitLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.deepEqual(splitLog, [], 'an enrichment_key already present in the log read must be filtered from the append payload');

  assert.equal(consolidated.stats.contact.cache_hits, 1);
  assert.equal(consolidated.stats.contact.credits_consumed, 0);
});

test('fixture 007: a fresh Hunter hit produces one update and one append log row', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-007');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  assert.equal(consolidated.contactUpdates.length, 1);
  assert.equal(consolidated.logRows.length, 1);
  const update = consolidated.contactUpdates[0];
  assert.equal(update.lead_id, 'RWL-0007-A');
  assert.equal(update.email, 'john.smith@example-services.example.com');
  assert.equal(update.contact_source_provider, 'hunter');
  assert.equal(consolidated.stats.contact.credits_consumed, 1);

  const splitLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.equal(splitLog.length, 1);
  assert.equal(splitLog[0].json.enrichment_key, 'example-services.example.com::hunter');
});

test('fixture 020: an AgentData fresh hit reports agentdata metrics and a ::agentdata update lineage', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-020');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;
  const report = chain.report[0].json;

  assert.equal(consolidated.contact_provider, 'agentdata');
  assert.equal(report.provider_runs.agentdata.credits_consumed, 1);
  assert.equal(report.provider_runs.agentdata.enriched, 1);
  assert.equal(report.provider_runs.agentdata.total, 1);
  assert.equal(report.approved_updates, 1);

  const update = consolidated.contactUpdates.find((u) => u.lead_id === 'RWL-0020-A');
  assert.ok(update, 'RWL-0020-A present');
  assert.equal(update.email, 'jane.doe@bestad.example.com');
  assert.equal(update.contact_name, 'Jane Roe', 'pre-existing contact_name is preserved');
  assert.equal(update.contact_title, 'Operations Manager');
  assert.equal(update.email_source, 'agentdata');
  assert.equal(update.contact_source_provider, 'agentdata');

  const logRow = consolidated.logRows.find((r) => r.enrichment_key === 'bestad.example.com::agentdata');
  assert.ok(logRow, '::agentdata log row');
  assert.equal(logRow.result_contact_name, 'Jane Doe', 'the log records the provider result name');
  assert.equal(logRow.credits_consumed, '1');

  const splitLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.equal(splitLog.length, 1);
  assert.equal(splitLog[0].json.enrichment_key, 'bestad.example.com::agentdata');
});

test('fixture 026: an AgentData cache hit re-carries the ::agentdata row with an incremented hit count', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-026');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  assert.ok(consolidated.contactUpdates.length > 0, 'a cache hit still yields a contact update');
  const update = consolidated.contactUpdates.find((u) => u.lead_id === 'RWL-0026-A');
  assert.equal(update.email, 'maya.singh@cachedad.example.com');
  assert.equal(update.email_source, 'agentdata');
  assert.equal(update.contact_source_provider, 'agentdata');

  assert.equal(consolidated.logRows.length, 1, 'the ::agentdata cache-hit row is re-carried');
  assert.equal(consolidated.logRows[0].enrichment_key, 'cachedad.example.com::agentdata');
  assert.equal(consolidated.logRows[0].cache_hit_count, '3');

  const splitLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.deepEqual(splitLog, [], 'an enrichment_key already present in the log read must be filtered from the append payload');

  assert.equal(consolidated.stats.contact.cache_hits, 1);
  assert.equal(consolidated.stats.contact.credits_consumed, 0);
});

test('the report node emits provider-and-run metrics with zero leakage from the write path', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-012');
  const chain = await runChain(fx);
  const report = chain.report[0].json;

  assert.equal(report.run_id, fx.runId);
  assert.equal(report.run_timestamp, fx.now);
  assert.equal(report.provider_runs.hunter.credits_consumed, 1);
  assert.equal(report.provider_runs.oss.enriched, 1);
  assert.equal(report.provider_runs.oss.credits_consumed, 0);
  assert.equal(report.approved_updates, 1, 'the OSS-filled contact replaces the empty hunter stub for the single lead');
  assert.equal(report.enrichment_log_rows, 2);
  assert.equal(report._hasOutput, true);
  assert.equal('fatal' in report, false);
  for (const key of ['website', 'business_name', 'phone', 'country']) {
    assert.equal(key in report, false, `report must not leak raw lead fields: ${key}`);
  }
});

test('split nodes project exactly their single column set and drop empty consolidated arrays', async () => {
  const fx = fixtures.find((f) => f.id === 'TEST-ENRICH-012');
  const chain = await runChain(fx);
  const consolidated = chain.consolidated[0].json;

  const updates = await executeCode('Split Contact Updates', { input: [{ json: consolidated }], refs: {} });
  assert.ok(updates.length > 0);
  for (const item of updates) {
    assert.deepEqual(Object.keys(item.json).sort(), [...UPDATED_COLUMNS].sort());
  }

  const logRowsOut = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: consolidated }],
    refs: { 'Read Contact Enrichment Log': chain.logRead },
  });
  assert.ok(logRowsOut.length > 0);
  for (const item of logRowsOut) {
    assert.deepEqual(Object.keys(item.json).sort(), [...ENRICHMENT_LOG_COLUMNS].sort());
  }

  const emptyUpdates = await executeCode('Split Contact Updates', { input: [{ json: { contactUpdates: [] } }], refs: {} });
  const emptyLog = await executeCode('Split Enrichment Log Rows', {
    input: [{ json: { logRows: [] } }],
    refs: { 'Read Contact Enrichment Log': [] },
  });
  assert.deepEqual(emptyUpdates, []);
  assert.deepEqual(emptyLog, []);
});

test('embedded Enrich Contact source is self-contained (no requires, no transport)', () => {
  const banned = [/\brequire\s*\(/, /process\.env/, /Date\.now/, /Math\.random/, /https?:\/\//];
  for (const re of banned) {
    assert.equal(re.test(embeddedContactSource), false, `banned token ${re}`);
  }
});

test('embedded Enrich Contact OSS source is self-contained', () => {
  const banned = [/\brequire\s*\(/, /process\.env/, /Date\.now/, /Math\.random/, /https?:\/\//];
  for (const re of banned) {
    assert.equal(re.test(embeddedContactOssSource), false, `banned token ${re}`);
  }
});