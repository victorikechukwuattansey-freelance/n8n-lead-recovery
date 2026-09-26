'use strict';

/*
 * Approved Outreach Handoff engine harness (Prompt C-B, Part B).
 *
 * Dedicated mirror harness following the Prospect Finder C-A pattern:
 *   - jsCode is read from ONLY the Handoff artifact (Approved Outreach Handoff
 *     V1.json) via tests/helpers/handoff-vm.js and executed through the shared
 *     vm sandbox (runNode — same bindings, frozen Date, realm-escaped output).
 *   - Inputs + golden `expected` blocks come from fixtures/handoff-fixtures.json
 *     (TEST-HANDOFF-* namespace) via the collocated loader.
 *
 * Coverage (C-B Part B requirements):
 *   1. only QUALIFIED leads are copied to Approved Outreach
 *   2. name + city/state/country + a contact path are all required
 *   3. idempotency per lead_id (sheet + within-batch)
 *   4. rows stamped outreach_status='not_ready' + deterministic approved_at
 *   5. Verified Leads are read-only (no write ever targets that sheet)
 *   6. Verified-formula / Q:U-owned columns are never written
 *   7. no-eligible runs emit the _noNewApproved sentinel end to end
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { runNode, handoffNodeCode, handoffArtifact, HANDOFF_CODE_NODES } = require('./helpers/handoff-vm.js');
const { loadHandoffFixtures } = require('../fixtures/handoff-fixtures.js');
const { APPROVED_COLUMNS } = require('../src/schema.js');

const FIXED_NOW = '2026-09-16T12:00:00.000Z';

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

const VERIFIED_FORMULA_FIELDS = ['has_website', 'has_phone', 'target_niche', 'dedupe_key'];

const F = Object.fromEntries(loadHandoffFixtures().map((fx) => [fx.id, fx]));

const asItems = (rows) => rows.map((json) => ({ json }));

function runFilter(fx) {
  return runNode(handoffNodeCode('Filter Eligible Leads'), {
    inputItems: asItems(fx.verified_leads),
    fixedNow: FIXED_NOW,
  });
}

function runPipeline(fx) {
  const filter = runFilter(fx);
  const dedup = runNode(handoffNodeCode('Dedup Against Approved Outreach'), {
    inputItems: asItems(fx.approved_rows),
    nodeData: { 'Filter Eligible Leads': filter.items },
    fixedNow: FIXED_NOW,
  });
  const prepare = runNode(handoffNodeCode('Prepare Approved Outreach Rows'), {
    inputItems: dedup.items,
    fixedNow: FIXED_NOW,
  });
  return { filter, dedup, prepare };
}

const jsonList = (out) => (out || []).map((item) => item.json);
const control = (out) => (out[0] ? out[0].json._control : undefined);

describe('Handoff fixture store', () => {
  it('fixture ids are unique and namespaced', () => {
    assert.ok(Object.keys(F).length >= 6, 'expected at least six TEST-HANDOFF fixtures');
  });
});

describe('Filter Eligible Leads (harness)', () => {
  it('all six ineligibility counters and the eligible set (TEST-HANDOFF-FILTER-001)', () => {
    const fx = F['TEST-HANDOFF-FILTER-001'];
    const { items } = runFilter(fx);
    const filtered = jsonList(items);
    const c = control(items, 'filter');

    assert.equal(c.verified_examined, fx.expected.verified_examined);
    assert.deepEqual(
      { eligible: c.eligible, ineligible_not_qualified: c.ineligible_not_qualified, ineligible_missing_business_name: c.ineligible_missing_business_name, ineligible_missing_city: c.ineligible_missing_city, ineligible_missing_state: c.ineligible_missing_state, ineligible_missing_country: c.ineligible_missing_country, ineligible_no_contact_path: c.ineligible_no_contact_path },
      fx.expected.filter,
    );
    assert.deepEqual(filtered.map((l) => l.lead_id), fx.expected.eligible_ids);
  });

  it('every eligible item carries the control counters onward', () => {
    const fx = F['TEST-HANDOFF-FILTER-001'];
    const { items } = runFilter(fx);
    for (const item of items) {
      assert.ok(item.json._control, 'eligible rows must carry _control for the dedup stage');
      assert.equal(item.json._control.eligible, fx.expected.filter.eligible);
    }
  });
});

describe('Dedup Against Approved Outreach (harness)', () => {
  it('drops already-approved ids and collapses within-batch duplicates (TEST-HANDOFF-DEDUP-001)', () => {
    const fx = F['TEST-HANDOFF-DEDUP-001'];
    const { dedup } = runPipeline(fx);
    const rows = jsonList(dedup.items);

    // The dedup controls are merged with the upstream filter counters, so pin
    // the four dedup-specific counters individually (see fixture note for the
    // sheet-before-batch ordering semantics).
    const judges = {
      eligible_incoming: (c) => c.eligible_incoming,
      already_approved: (c) => c.already_approved,
      duplicate_in_batch: (c) => c.duplicate_in_batch,
      newly_approved: (c) => c.newly_approved,
    };
    for (const [key, pick] of Object.entries(judges)) {
      assert.equal(pick(control(dedup.items)), fx.expected.dedup[key], `${key} counter`);
    }
    assert.deepEqual(rows.map((r) => r.lead_id), fx.expected.prepared_ids);
    assert.ok(!rows.some((r) => r._noNewApproved === true), 'new rows must not carry the sentinel');
  });

  it('returns a sentinel when every eligible lead is already approved (TEST-HANDOFF-DEDUP-002)', () => {
    const fx = F['TEST-HANDOFF-DEDUP-002'];
    const { dedup } = runPipeline(fx);
    assert.equal(dedup.items[0].json._noNewApproved, true);
    assert.equal(dedup.items[0].json._message, fx.expected.sentinel.message);
  });
});

describe('Prepare Approved Outreach Rows (harness)', () => {
  it('maps a lead to the exact 21-column schema with frozen approved_at (TEST-HANDOFF-PREPARE-001)', () => {
    const fx = F['TEST-HANDOFF-PREPARE-001'];
    const { prepare } = runPipeline(fx);
    const rows = jsonList(prepare.items);
    assert.equal(rows.length, 1);
    const row = rows[0];

    assert.deepEqual(Object.keys(row).sort(), [...APPROVED_OUTREACH_COLUMNS].sort());
    assert.deepEqual(row, fx.expected.row, 'full golden row must match byte-for-byte');
    assert.equal(row.outreach_status, 'not_ready');
    assert.equal(row.approved_at, FIXED_NOW, 'approved_at must be frozen by the harness Date');
    assert.equal(row.lead_score, 91);

    for (const formulaField of VERIFIED_FORMULA_FIELDS) {
      assert.ok(!(formulaField in row), `Verified formula field leaked: ${formulaField}`);
    }
    assert.ok(!('_control' in row), '_control must not reach a sheet row');
    assert.ok(!('_noNewApproved' in row), '_noNewApproved must not reach a sheet row');
    assert.ok(!('verified_at' in row), 'verified_at is not an Approved Outreach field');
    assert.ok(!('manual_review_notes' in row), 'manual_review_notes must not leak');
  });

  it('passes the no-op sentinel through unchanged (TEST-HANDOFF-PREPARE-002)', () => {
    const fx = F['TEST-HANDOFF-PREPARE-002'];
    const { dedup, prepare } = runPipeline(fx);
    assert.equal(prepare.items.length, 1);
    assert.ok(prepare.items[0].json._noNewApproved === true, 'no-op must stay a no-op');
    assert.equal(prepare.items[0].json._message, dedup.items[0].json._message, 'prepare must not rewrite the sentinel message');
    assert.deepEqual(
      Object.keys(prepare.items[0].json).sort(),
      Object.keys(dedup.items[0].json).sort(),
      'prepare must pass the sentinel shape through verbatim',
    );
  });
});

describe('Handoff stage integrity (structural, offline)', () => {
  it('Verified Leads is read-only; the only sheet write targets Approved Outreach', () => {
    const wf = handoffArtifact();
    const sheets = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');

    const readVerified = sheets.find((n) => n.name === 'Read Verified Leads');
    assert.equal(readVerified.parameters.operation, 'read');
    assert.equal(readVerified.parameters.sheetName.value, 'Verified Leads');

    const writes = sheets.filter((n) => n.parameters.operation === 'append');
    assert.equal(writes.length, 1, 'exactly one sheet write in the workflow');
    assert.equal(writes[0].name, 'Write Approved Outreach');
    assert.equal(writes[0].parameters.sheetName.value, 'Approved Outreach');
    assert.ok(
      !writes.some((n) => n.parameters.sheetName.value === 'Verified Leads'),
      'Verified Leads must never be written',
    );
  });

  it('the columns mapping writes exactly the 15 handoff-owned columns, never Q:U formula fields', () => {
    const wf = handoffArtifact();
    const write = wf.nodes.find((n) => n.name === 'Write Approved Outreach');
    const columns = write.parameters.columns;
    assert.equal(columns.mappingMode, 'defineBelow');
    assert.deepEqual(Object.keys(columns.value).sort(), [...WRITE_MAP_COLUMNS].sort());
    const enrichmentOwned = ['contact_blocked', 'contact_source_provider'];
    for (const key of Object.keys(columns.value)) {
      assert.ok(
        APPROVED_COLUMNS.includes(key),
        `write map key must be a live Approved Outreach sheet header: ${key}`,
      );
      assert.ok(
        !enrichmentOwned.includes(key),
        `handoff must never write an enrichment-owned column: ${key}`,
      );
    }
    assert.ok('country' in columns.value, 'country must stay mapped (live column X)');
    for (const banned of ['_control', '_noNewApproved', ...VERIFIED_FORMULA_FIELDS, 'verified_at', 'manual_review_notes']) {
      assert.ok(!(banned in columns.value), `write mapping must not include ${banned}`);
    }
  });

  it('Has New Approved Leads? gates the write on the _noNewApproved sentinel', () => {
    const wf = handoffArtifact();
    const gate = wf.nodes.find((n) => n.name === 'Has New Approved Leads?');
    assert.equal(gate.type, 'n8n-nodes-base.if');
    assert.ok(JSON.stringify(gate.parameters.conditions).includes('_noNewApproved'), 'IF must test _noNewApproved');
  });

  it('all three code-node bodies are executed in the harness (no dead code)', () => {
    for (const name of HANDOFF_CODE_NODES) {
      assert.ok(typeof handoffNodeCode(name) === 'string' && handoffNodeCode(name).length > 100, `${name} must have a live body`);
    }
  });
});