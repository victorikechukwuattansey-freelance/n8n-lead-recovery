'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WF_PATH = path.join(__dirname, '..', 'Approved Outreach Handoff V1.json');
const WF = JSON.parse(fs.readFileSync(WF_PATH, 'utf8'));

const { APPROVED_COLUMNS } = require('../src/schema.js');

const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';

const APPROVED_OUTREACH_COLUMNS = [
  'lead_id',
  'business_name',
  'niche',
  'city',
  'state',
  'country',
  'website',
  'phone',
  'email',
  'contact_name',
  'contact_title',
  'email_source',
  'email_verified',
  'contact_form',
  'linkedin_url',
  'lead_score',
  'qualification_status',
  'outreach_channel',
  'outreach_status',
  'approved_at',
  'notes',
];

const WRITE_MAP_COLUMNS = [
  'lead_id',
  'business_name',
  'niche',
  'city',
  'state',
  'country',
  'website',
  'phone',
  'email',
  'contact_name',
  'verification_source',
  'score',
  'channel',
  'approved_at',
  'notes',
];

const VERIFIED_FORMULA_FIELDS = [
  'has_website',
  'has_phone',
  'target_niche',
  'dedupe_key',
];

const EXPECTED_NODES = [
  'Manual Trigger',
  'Read Verified Leads',
  'Filter Eligible Leads',
  'Read Approved Outreach',
  'Dedup Against Approved Outreach',
  'Prepare Approved Outreach Rows',
  'Has New Approved Leads?',
  'Write Approved Outreach',
  'No-Op End',
  'Handoff Complete End',
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

function executeCode(nodeName, opts = {}) {
  const input = opts.input ?? [];
  const refs = opts.refs ?? {};
  const $input = {
    all: () => input,
    item: input[0] ? input[0].json : {},
  };
  const $json = input[0] ? input[0].json : {};
  const $ = (name) => ({
    all: () => refs[name] ?? [],
    item: (refs[name] ?? [])[0] ? (refs[name] ?? [])[0].json : {},
  });
  const source = jsCodeOf(nodeName);
  const body = '"use strict";\nreturn (function () {\n' + source + '\n})();';
  const fn = new Function('$input', '$json', '$', body);
  return fn($input, $json, $);
}

function runPipeline(verifiedItems, approvedRows) {
  const filter = executeCode('Filter Eligible Leads', { input: verifiedItems });
  const dedup = executeCode('Dedup Against Approved Outreach', {
    input: approvedRows,
    refs: { 'Filter Eligible Leads': filter },
  });
  const prepare = executeCode('Prepare Approved Outreach Rows', { input: dedup });
  return { filter, dedup, prepare };
}

function jsonList(out) {
  return (out || []).map((item) => item.json);
}

function isNoOpMarker(out) {
  return out.length === 1 && out[0].json && out[0].json._noNewApproved === true;
}

function lead(id, overrides = {}) {
  return {
    json: {
      lead_id: id,
      business_name: 'Acme Heating & Air',
      niche: 'HVAC',
      city: 'Austin',
      state: 'Texas',
      country: 'USA',
      address: '100 Main St',
      phone: '+1 512 555 0100',
      website: 'https://acmehvac.example.com',
      rating: 4.6,
      review_count: 12,
      google_maps_url: 'https://maps.example.com/acme',
      business_type: 'Service business',
      source: 'Foursquare',
      search_input_id: 'si-1',
      dedupe_key: 'website:https://acmehvac.example.com',
      has_website: 'TRUE',
      has_phone: 'TRUE',
      target_niche: 'HVAC',
      score: 88,
      qualification_status: 'QUALIFIED',
      verified_at: '2026-09-10T00:00:00.000Z',
      notes: '',
      manual_review_notes: '',
      ...overrides,
    },
  };
}

function approvedRow(id) {
  return { json: { lead_id: id } };
}

/* ------------------------------------------------------------------ */
/* Structural / importability validation                               */
/* ------------------------------------------------------------------ */

test('workflow has the expected node set with unique names and ids', () => {
  const names = WF.nodes.map((n) => n.name);
  assert.deepEqual(new Set(names).size, names.length, 'node names must be unique');
  assert.deepEqual(
    [...new Set(names)].sort(),
    [...EXPECTED_NODES].sort(),
  );
  const ids = WF.nodes.map((n) => n.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'node ids must be unique');
  assert.ok(names.length === 10, 'expected exactly 10 nodes');
});

test('all connections reference existing nodes', () => {
  const names = new Set(WF.nodes.map((n) => n.name));
  for (const [source, conns] of Object.entries(WF.connections)) {
    assert.ok(names.has(source), 'missing source node: ' + source);
    for (const branches of Object.values(conns)) {
      for (const branch of branches) {
        for (const edge of branch) {
          assert.ok(names.has(edge.node), 'missing target node: ' + edge.node);
        }
      }
    }
  }
});

test('workflow is provider-independent (no http requests, no provider branches)', () => {
  const types = WF.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.httpRequest'), 'httpRequest must not appear');
  for (const n of WF.nodes) {
    const lower = n.name.toLowerCase();
    assert.ok(!lower.includes('foursquare'));
    assert.ok(!lower.includes('osm'));
    assert.ok(!lower.includes('overpass'));
    assert.ok(!lower.includes('places'));
    assert.ok(!lower.includes('search input'));
  }
  assert.deepEqual(
    new Set(types),
    new Set([
      'n8n-nodes-base.manualTrigger',
      'n8n-nodes-base.googleSheets',
      'n8n-nodes-base.code',
      'n8n-nodes-base.if',
      'n8n-nodes-base.noOp',
    ]),
  );
});

test('google sheets nodes target the engine spreadsheet and correct tabs', () => {
  const sheetNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.ok(sheetNodes.length === 3, 'expected 3 google sheets nodes');
  for (const n of sheetNodes) {
    const doc = n.parameters.documentId;
    assert.ok(doc && doc.value === SPREADSHEET_ID, n.name + ' must target engine spreadsheet');
  }
  const reads = sheetNodes.filter((n) => n.parameters.operation === 'read');
  assert.deepEqual(reads.map((n) => n.parameters.sheetName.value).sort(), [
    'Approved Outreach',
    'Verified Leads',
  ]);
  const writes = sheetNodes.filter((n) => n.parameters.operation === 'append');
  assert.ok(writes.length === 1);
  assert.equal(writes[0].name, 'Write Approved Outreach');
  assert.equal(writes[0].parameters.sheetName.value, 'Approved Outreach');
});

test('no hardcoded secrets or credential material in any node', () => {
  const raw = fs.readFileSync(WF_PATH, 'utf8');
  assert.ok(!/Bearer\s+[A-Z0-9]{10,}/i.test(raw), 'no bearer tokens');
  assert.ok(!/Authorization/.test(raw), 'no Authorization header');
  assert.ok(!/\$\{?env\./i.test(raw), 'no env var interpolation');
});

test('code nodes contain no staticData, no process.env, no $env usage', () => {
  for (const n of WF.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
    const code = n.parameters.jsCode || '';
    assert.ok(!code.includes('staticData'), n.name + ' must not use staticData');
    assert.ok(!code.includes('process.env'), n.name + ' must not read env');
    assert.ok(!/$env/.test(code), n.name + ' must not read $env');
  }
});

/* ------------------------------------------------------------------ */
/* Pipeline acceptance cases (T1-T10)                                  */
/* ------------------------------------------------------------------ */

test('T1: a QUALIFIED lead with contact info enters Approved Outreach with correct mapping', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-001')],
    [],
  );
  const rows = jsonList(prepare);

  assert.equal(isNoOpMarker(prepare), false, 'expected a new row');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), [...APPROVED_OUTREACH_COLUMNS].sort());
  assert.equal(rows[0].lead_id, 'lead-001');
  assert.equal(rows[0].business_name, 'Acme Heating & Air');
  assert.equal(rows[0].niche, 'HVAC');
  assert.equal(rows[0].city, 'Austin');
  assert.equal(rows[0].state, 'Texas');
  assert.equal(rows[0].country, 'USA');
  assert.equal(rows[0].website, 'https://acmehvac.example.com');
  assert.equal(rows[0].phone, '+1 512 555 0100');
  assert.equal(rows[0].lead_score, 88);
  assert.equal(rows[0].qualification_status, 'QUALIFIED');
  assert.equal(rows[0].outreach_status, 'not_ready');
  assert.equal(rows[0].outreach_channel, '');
  assert.equal(rows[0].email, '');
  assert.equal(rows[0].contact_name, '');
  assert.equal(rows[0].contact_title, '');
  assert.equal(rows[0].email_source, '');
  assert.equal(rows[0].email_verified, '');
  assert.equal(rows[0].contact_form, '');
  assert.equal(rows[0].linkedin_url, '');
  assert.equal(rows[0].notes, '');
  assert.ok(typeof rows[0].approved_at === 'string' && rows[0].approved_at.length > 0);

  const filterControl = dedup[0].json._control;
  assert.equal(filterControl.eligible, 1);
  assert.equal(filterControl.verified_examined, 1);
});

test('T2: REVIEW-requiring leads are excluded from Approved Outreach', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-review', { qualification_status: 'REVIEW' })],
    [],
  );
  assert.equal(dedup[0].json._control.ineligible_not_qualified, 1);
  assert.equal(isNoOpMarker(dedup), true);
  assert.equal(isNoOpMarker(prepare), true);
});

test('T3: DISQUALIFIED leads are excluded from Approved Outreach', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-no', { qualification_status: 'DISQUALIFIED' })],
    [],
  );
  assert.equal(dedup[0].json._control.ineligible_not_qualified, 1);
  assert.equal(isNoOpMarker(dedup), true);
  assert.equal(isNoOpMarker(prepare), true);
});

test('T4: QUALIFIED leads with neither website nor phone are excluded', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-cold', { website: '', phone: '' })],
    [],
  );
  assert.equal(dedup[0].json._control.ineligible_no_contact_path, 1);
  assert.equal(isNoOpMarker(dedup), true);
  assert.equal(isNoOpMarker(prepare), true);
});

test('T5: a lead that is already approved is skipped (no new row)', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-001')],
    [approvedRow('lead-001')],
  );
  assert.equal(dedup[0].json._control.already_approved, 1);
  assert.equal(dedup[0].json._control.newly_approved, 0);
  assert.equal(isNoOpMarker(dedup), true);
  assert.equal(isNoOpMarker(prepare), true);
});

test('T6: mixed batch — existing approvals skipped, new leads inserted once', () => {
  const { dedup, prepare } = runPipeline(
    [lead('lead-001'), lead('lead-002'), lead('lead-003')],
    [approvedRow('lead-001')],
  );
  const rows = jsonList(prepare);
  assert.equal(dedup[0].json._control.already_approved, 1);
  assert.equal(dedup[0].json._control.newly_approved, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.lead_id).sort(), ['lead-002', 'lead-003']);
});

test('T7: repeat execution inserts zero new rows when everything is already approved', () => {
  const verified = [
    lead('lead-001', { id: 'lead-001' }),
    lead('lead-002', { id: 'lead-002' }),
    lead('lead-003', { id: 'lead-003' }),
  ];
  const approved = verified.map((l) => approvedRow(l.json.lead_id));

  const { dedup, prepare } = runPipeline(verified, approved);
  assert.equal(isNoOpMarker(dedup), true, 'second run must be a no-op');
  assert.equal(isNoOpMarker(prepare), true);
});

test('T8: source integrity — Verified Leads are only read, nothing leaked into output rows', () => {
  const verified = byName('Read Verified Leads');
  assert.equal(verified.parameters.operation, 'read');

  const pipeline = runPipeline([lead('lead-001'), lead('lead-002')], []);
  const rows = jsonList(pipeline.prepare);
  assert.ok(rows.length === 2);

  for (const row of rows) {
    for (const formulaField of VERIFIED_FORMULA_FIELDS) {
      assert.ok(!(formulaField in row), 'formula field leaked: ' + formulaField);
    }
    assert.ok(!('_control' in row), '_control must not reach a sheet row');
    assert.ok(!('_noNewApproved' in row), '_noNewApproved must not reach a sheet row');
    assert.ok(!('verified_at' in row), 'verified_at is not an Approved Outreach field');
    assert.deepEqual(Object.keys(row).sort(), [...APPROVED_OUTREACH_COLUMNS].sort());
  }

  const write = byName('Write Approved Outreach');
  const columns = write.parameters.columns;
  assert.equal(columns.mappingMode, 'defineBelow');
  assert.deepEqual(Object.keys(columns.value).sort(), [...WRITE_MAP_COLUMNS].sort());
  assert.ok(!('_control' in columns.value));
  assert.ok(!('_noNewApproved' in columns.value));
});

test('write-subset guard: the handoff append maps ONLY the 15 handoff-owned columns', () => {
  const write = byName('Write Approved Outreach');
  const columns = write.parameters.columns;
  assert.equal(columns.mappingMode, 'defineBelow');
  const mapped = Object.keys(columns.value);
  const enrichmentOwned = ['contact_blocked', 'contact_source_provider'];
  for (const key of mapped) {
    assert.ok(
      APPROVED_COLUMNS.includes(key),
      'write map key must be a live Approved Outreach sheet header: ' + key,
    );
    assert.ok(
      !enrichmentOwned.includes(key),
      'handoff must never write an enrichment-owned column: ' + key,
    );
  }
  assert.deepEqual(
    mapped.sort(),
    [...WRITE_MAP_COLUMNS].sort(),
    'handoff writes exactly its 15-owned columns',
  );
  assert.ok(mapped.includes('country'), 'country must stay mapped (live column X)');
});

test('T9: failure recovery — re-running after a failed/partial write never duplicates', () => {
  const verified = [lead('lead-001'), lead('lead-002')];

  const attempt1 = runPipeline(verified, []);
  assert.equal(jsonList(attempt1.prepare).length, 2, 'both leads eligible on first attempt');

  const attempt2 = runPipeline(verified, []);
  assert.equal(jsonList(attempt2.prepare).length, 2, 'failed write means retry sees the same eligible set');

  const partial = runPipeline(verified, [approvedRow('lead-001')]);
  const partialRows = jsonList(partial.prepare);
  assert.deepEqual(partialRows.map((r) => r.lead_id), ['lead-002']);
  assert.equal(partial.dedup[0].json._control.already_approved, 1);

  const complete = runPipeline(verified, [approvedRow('lead-001'), approvedRow('lead-002')]);
  assert.ok(isNoOpMarker(complete.prepare), 'fully persisted run inserts nothing');

  const dupBatch = runPipeline([lead('lead-003'), lead('lead-003')], []);
  const dupRows = jsonList(dupBatch.prepare);
  assert.equal(dupRows.length, 1, 'in-batch duplicates collapse to one write');
  assert.equal(dupBatch.dedup[0].json._control.duplicate_in_batch, 1);
});

test('T10: no outreach side effects — nothing is sent, logged, or emitted beyond the Approved sheet', () => {
  const types = WF.nodes.map((n) => n.type);
  for (const banned of [
    'n8n-nodes-base.emailSend',
    'n8n-nodes-base.twilio',
    'n8n-nodes-base.whatsapp',
    'n8n-nodes-base.slack',
    'n8n-nodes-base.webhook',
    'n8n-nodes-base.scheduleTrigger',
  ]) {
    assert.ok(!types.includes(banned), 'banned node type present: ' + banned);
  }

  const writes = WF.nodes.filter(
    (n) => n.type === 'n8n-nodes-base.googleSheets' && n.parameters.operation === 'append',
  );
  assert.equal(writes.length, 1, 'exactly one sheet write in the workflow');
  assert.equal(writes[0].parameters.sheetName.value, 'Approved Outreach');
  const allSheetNames = WF.nodes
    .filter((n) => n.type === 'n8n-nodes-base.googleSheets')
    .map((n) => n.parameters.sheetName.value);
  assert.ok(!allSheetNames.includes('Outreach Log'), 'Outreach Log must not be touched');
});

test('observability: counters surface every ineligibility reason', () => {
  const { dedup } = runPipeline(
    [
      lead('q-ok', { website: '', phone: '' }),
      lead('q-review', { qualification_status: 'REVIEW' }),
      lead('q-no-city', { city: '' }),
      lead('q-no-state', { state: '' }),
      lead('q-no-country', { country: '' }),
      lead('q-no-name', { business_name: '' }),
      lead('q-good'),
    ],
    [],
  );
  const c = dedup[0].json._control;
  assert.equal(c.verified_examined, 7);
  assert.equal(c.eligible, 1);
  assert.equal(c.ineligible_not_qualified, 1);
  assert.equal(c.ineligible_missing_business_name, 1);
  assert.equal(c.ineligible_missing_city, 1);
  assert.equal(c.ineligible_missing_state, 1);
  assert.equal(c.ineligible_missing_country, 1);
  assert.equal(c.ineligible_no_contact_path, 1);
});

test('no-op marker carries the exact spec message', () => {
  const { dedup } = runPipeline([lead('lead-review', { qualification_status: 'REVIEW' })], []);
  assert.equal(dedup[0].json._noNewApproved, true);
  assert.equal(dedup[0].json._message, 'No new eligible leads for Approved Outreach');
});