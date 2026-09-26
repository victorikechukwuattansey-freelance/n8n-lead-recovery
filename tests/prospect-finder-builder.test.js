'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const WF_PATH = path.join(__dirname, '..', 'Lead Recovery Engine — Prospect Finder & Validation V1.json');
const { prospectFinderWorkflow } = require('../scripts/build-prospect-finder-workflow.js');
const { CODE_BY_NODE } = require('../src/prospect-finder-embedded-code.js');
const { referenceWorkflow, CODE_NODE_NAMES } = require('../src/prospect-finder-workflow-contract.js');

/*
 * Frozen-by-convention hash anchor — the current artifact fingerprint
 * (revision R9, pairedItem lineage fix — replaces the R8 A.12 anchor; the A.12
 * phone-key changes are retained, only `Dedup & Prepare Verified` gained
 * explicit `pairedItem` on its emitted items). This guard FAILS if any
 * hand-edit changes the artifact without rebuilding and updating this anchor.
 * When you intentionally change the workflow through the builder (spec or
 * embedded code edit + build), update this constant to the new artifact hash
 * (see reports/PROSPECT-FINDER-GPL-PREFLIGHT.md §12.3 revision log,
 * reports/PROSPECT-FINDER-A12-PHONE-NORMALIZATION-REPORT.md, and
 * reports/PROSPECT-FINDER-PAIRED-ITEM-LINEAGE-FIX-REPORT.md).
 */
const ARTIFACT_HASH = '30a5020506850b079eea48f3932c41bf4fc20c32e224f81c059ee6a9162f2308';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const artifactBytes = () => fs.readFileSync(WF_PATH, 'utf8');

function serialize(workflow) {
  return JSON.stringify(workflow, null, 2);
}

describe('Prospect Finder deterministic builder', () => {
  it('builds twice into temp files and emits byte-identical output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-builder-'));
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    try {
      fs.writeFileSync(a, serialize(prospectFinderWorkflow()), 'utf8');
      fs.writeFileSync(b, serialize(prospectFinderWorkflow()), 'utf8');
      const aBytes = fs.readFileSync(a, 'utf8');
      const bBytes = fs.readFileSync(b, 'utf8');
      assert.equal(aBytes, bBytes, 'two builds must be byte-identical');
      assert.equal(sha256(aBytes), sha256(bBytes));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits the artifact byte-for-byte (no regeneration drift)', () => {
    const built = serialize(prospectFinderWorkflow());
    assert.equal(built, artifactBytes(), 'builder output must equal the shipped artifact bytes');
    assert.equal(Buffer.byteLength(built, 'utf8'), 88855);
    assert.equal(sha256(built), sha256(artifactBytes()));
  });

  it('the artifact is LF-only (no \\r\\n) — CRLF line-ending drift guard', () => {
    const bytes = artifactBytes();
    assert.ok(
      !bytes.includes('\r\n'),
      'artifact must be LF-only; core.autocrlf=true + a fresh checkout converts JSON to CRLF, ' +
        'which breaks byte-for-byte builder comparison (.gitattributes forces *.json eol=lf)',
    );
    assert.ok(
      !bytes.includes('\r'),
      'artifact must not contain any carriage return character',
    );
  });

  it('an exact second build also byte-matches the artifact (fresh object each call)', () => {
    assert.equal(
      serialize(prospectFinderWorkflow()),
      serialize(prospectFinderWorkflow()),
      'repeated builds must not drift',
    );
  });

  it('hash anchor: the current artifact fingerprint is frozen at ARTIFACT_HASH', () => {
    assert.equal(
      sha256(artifactBytes()),
      ARTIFACT_HASH,
      'artifact hash changed vs frozen anchor — fallback to a hand-edit or an unrecorded rebuild',
    );
  });

  it('workflow identity and node count are preserved', () => {
    const built = prospectFinderWorkflow();
    assert.equal(built.nodes.length, 33);
    assert.equal(built.name, 'Lead Recovery Engine — Prospect Finder & Validation V1');
    assert.equal(built.id, 'WcUgtTPiKXPL0BLH');
    assert.equal(built.versionId, 'd4206a64-3385-4ea8-b8c1-51628540674f');
    assert.equal(built.active, false);
    assert.deepEqual(built.meta, { templateCredsSetupCompleted: true, instanceId: built.meta.instanceId });
  });

  it('every code node receives its exact jsCode from the embedded-code module', () => {
    const built = prospectFinderWorkflow();
    const byName = new Map(built.nodes.map((n) => [n.name, n]));
    for (const name of CODE_NODE_NAMES) {
      const node = byName.get(name);
      assert.equal(node.type, 'n8n-nodes-base.code', `${name} must be a code node`);
      assert.equal(node.parameters.jsCode, CODE_BY_NODE[name], `${name} jsCode must equal the embedded constant`);
    }
    assert.equal(
      Object.keys(CODE_BY_NODE).length,
      built.nodes.filter((n) => n.type === 'n8n-nodes-base.code').length,
      'embedded-code map must cover exactly the code nodes',
    );
  });

  it('non-code parameters survive the build (no jsCode stripping outside code nodes)', () => {
    const built = prospectFinderWorkflow();
    const readVerified = built.nodes.find((n) => n.name === 'Read Verified Leads');
    assert.equal(readVerified.parameters.documentId.value, '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ');
    assert.equal(readVerified.parameters.sheetName.value, 102);
    assert.deepEqual(readVerified.credentials, {
      googleSheetsOAuth2Api: { id: 'rOKhG0ESKifN5zy2', name: 'Google Sheets account' },
    });
    const gplApi = built.nodes.find((n) => n.name === 'Google Places API');
    assert.equal(gplApi.parameters.method, 'POST');
    assert.equal(gplApi.parameters.url, 'https://places.googleapis.com/v1/places:searchText');
  });

  it('Merge uses append mode (not combine) — A.9 D1 fix', () => {
    const built = prospectFinderWorkflow();
    const merge = built.nodes.find((n) => n.name === 'Merge');
    assert.equal(merge.parameters.mode, 'append');
    assert.equal(merge.parameters.combineBy, undefined, 'combineBy must not be emitted in append mode');
    assert.equal(merge.parameters.combinationMode, undefined, 'combinationMode must not be emitted');
  });

  it('Merge numberOfInputs is 3 — A.10 D7 fix (one input per provider)', () => {
    const built = prospectFinderWorkflow();
    const merge = built.nodes.find((n) => n.name === 'Merge');
    assert.equal(merge.parameters.numberOfInputs, 3);
  });

  it('Merge numberOfInputs cannot regress above 3 (D7 drift guard)', () => {
    const built = prospectFinderWorkflow();
    const merge = built.nodes.find((n) => n.name === 'Merge');
    assert.ok(
      merge.parameters.numberOfInputs <= 3,
      'D7 fix requires at most one Merge input per provider',
    );
  });

  it('OSM Error Envelope is a code node feeding Merge input 1 (A.10 D7)', () => {
    const built = prospectFinderWorkflow();
    const byName = new Map(built.nodes.map((n) => [n.name, n]));
    const env = byName.get('OSM Error Envelope');
    assert.ok(env, 'OSM Error Envelope node must exist');
    assert.equal(env.type, 'n8n-nodes-base.code');
    assert.equal(env.parameters.jsCode, CODE_BY_NODE['OSM Error Envelope']);
    const edge = built.connections['OSM Error Envelope'].main[0].find((c) => c.node === 'Merge');
    assert.equal(edge.index, 1, 'OSM Error Envelope must feed Merge input 1');
  });

  it('Process FSQ/OSM mirror the GPL _noResults sentinel on empty success (A.11 shape pin)', () => {
    const expectedProvider = { 'Process FSQ': 'foursquare', 'Process OSM': 'openstreetmap', 'Process GPL': 'google_places' };
    const expectedMessage = { 'Process FSQ': 'Foursquare returned zero results', 'Process OSM': 'OpenStreetMap returned zero results', 'Process GPL': 'Google Places returned zero results' };
    const gate = { 'Process FSQ': 'output.length === 0', 'Process OSM': 'output.length === 0', 'Process GPL': 'leads.length === 0' };
    for (const name of Object.keys(expectedProvider)) {
      const body = CODE_BY_NODE[name];
      assert.ok(body.includes("_noResults: true"), `${name} must emit a _noResults sentinel`);
      assert.ok(
        body.includes(`return [{ json: { _noResults: true, _message: '${expectedMessage[name]}', _provider: '${expectedProvider[name]}' } }];`),
        `${name} must mirror the GPL sentinel shape for ${expectedProvider[name]}`,
      );
      assert.match(body, new RegExp(`if \\(${gate[name]}\\) \\\{`), `${name} must gate the sentinel on an empty result set`);
    }
  });

  it('Merge has no combine-mode parameters — A.9 D1 drift guard', () => {
    const built = prospectFinderWorkflow();
    const merge = built.nodes.find((n) => n.name === 'Merge');
    assert.equal(merge.parameters.fieldsToMatch, undefined, 'fieldsToMatch must not be emitted');
    assert.equal(merge.parameters.joinMode, undefined, 'joinMode must not be emitted');
  });

  it('Process FSQ reads real Foursquare category ids — R8 (Prompt C-B) shape pin', () => {
    const body = CODE_BY_NODE['Process FSQ'];
    assert.ok(
      body.includes('.map(c => clean(c.id) || clean(c.fsq_category_id))'),
      'getCategoryIds must read the real `categories[].id` field with an fsq_category_id fallback',
    );
    assert.ok(
      !/\.map\(c => clean\(c\.fsq_category_id\)\)/.test(body),
      'the fsq_category_id-only read must be gone (it never fired on live payloads)',
    );
  });

  it('Process FSQ and Process OSM embed the byte-identical canonical normalizePhone — R8 (Prompt A.12) shape pin', () => {
    const { CANONICAL_PHONE_NORMALIZER } = require('../src/prospect-finder-embedded-code.js');
    const fsq = CODE_BY_NODE['Process FSQ'];
    const osm = CODE_BY_NODE['Process OSM'];
    const canonical = CANONICAL_PHONE_NORMALIZER.join('\n');
    assert.ok(fsq.includes(canonical), 'Process FSQ must embed the shared canonical normalizePhone');
    assert.ok(osm.includes(canonical), 'Process OSM must embed the shared canonical normalizePhone');
    assert.ok(
      fsq.match(/function normalizePhone[\s\S]*?\n\}/)[0]
        === osm.match(/function normalizePhone[\s\S]*?\n\}/)[0],
      'FSQ and OSM helpers must be byte-identical (single source injected into both)',
    );
    assert.ok(
      fsq.includes('phone:${normalizePhone(phone)}'),
      'FSQ buildDedupeKey must key on the canonical digits (no + kept)',
    );
    assert.ok(
      !/normalize\(phone\)\.replace\(\\\/\[\\\^\\d\+\\\]\\\/g, ''\)/.test(fsq),
      'the C-B +-keeping phone-key branch must be gone from FSQ',
    );
    assert.ok(
      !osm.includes('return clean(value).replace(/[^\\d+]/g, \'\')'),
      'the OSM +-keeping normalizePhone must be gone (replaced by the canonical helper)',
    );
  });

  it('Dedup & Prepare Verified has alwaysOutputData: true — A.9 D2\' fix', () => {
    const built = prospectFinderWorkflow();
    const dedup = built.nodes.find((n) => n.name === 'Dedup & Prepare Verified');
    assert.equal(dedup.alwaysOutputData, true);
  });

  it('Dedup & Prepare Verified alwaysOutputData placement matches pattern — A.9 D2\' fix', () => {
    const built = prospectFinderWorkflow();
    const readVerified = built.nodes.find((n) => n.name === 'Read Verified Leads');
    const dedup = built.nodes.find((n) => n.name === 'Dedup & Prepare Verified');
    assert.equal(readVerified.alwaysOutputData, true, 'Read Verified Leads also uses alwaysOutputData');
    assert.equal(dedup.alwaysOutputData, true);
  });

  it('Google Places API uses n8n 2.x body+header params (no v1-era params) — A.8 fix', () => {
    const built = prospectFinderWorkflow();
    const gpl = built.nodes.find((n) => n.name === 'Google Places API');
    assert.equal(gpl.parameters.contentType, 'json');
    assert.equal(gpl.parameters.specifyBody, 'json');
    assert.equal(gpl.parameters.jsonBody, "={{ JSON.stringify({ textQuery: $json.gpl_query, maxResultCount: $json.gpl_max_results, languageCode: 'en' }) }}");
    assert.equal(gpl.parameters.sendHeaders, true);
    assert.equal(gpl.parameters.jsonParameters, undefined, 'v1 jsonParameters must not be emitted');
    assert.equal(gpl.parameters.bodyParametersJson, undefined, 'v1 bodyParametersJson must not be emitted');
    assert.equal(gpl.parameters.sendBody, true);
    const headers = gpl.parameters.headerParameters.parameters.map((h) => h.name);
    assert.ok(headers.includes('X-Goog-Api-Key'));
    assert.ok(headers.includes('X-Goog-FieldMask'));
  });

  it('no node carries a v1-only param across the whole workflow — A.8 drift guard', () => {
    const built = prospectFinderWorkflow();
    const v1Only = ['jsonParameters', 'bodyParametersJson', 'combinationMode'];
    for (const node of built.nodes) {
      const present = v1Only.filter((p) => node.parameters[p] !== undefined);
      assert.deepEqual(
        present,
        [],
        `${node.name} emits v1-only param(s) removed in n8n 2.x: ${present.join(', ')}`,
      );
    }
  });

  it('structural wiring invariants hold on the freshly-built workflow', () => {
    // Mirror of tests/gpl-workflow.test.js "Merge wiring integrity" (canonical
    // block) — asserted here against BUILT output so spec/regeneration changes
    // cannot silently reintroduce the R1/R3/D7 wiring defect.
    const built = prospectFinderWorkflow();
    const conns = built.connections;
    const merge = built.nodes.find((n) => n.name === 'Merge');

    assert.equal(merge.parameters.numberOfInputs, 3);
    assert.equal(merge.parameters.mode, 'append');

    // D7 topology (A.10): exactly one Merge input per provider; each provider's
    // success AND error paths feed the SAME input.
    const expectedIndex = {
      'Process FSQ': 0,
      'FSQ Error Envelope': 0,
      'Process OSM': 1,
      'OSM Error Envelope': 1,
      'Process GPL': 2,
      'GPL Error Envelope': 2,
    };
    for (const [p, expected] of Object.entries(expectedIndex)) {
      const edge = conns[p].main[0].find((c) => c.node === 'Merge');
      assert.ok(edge, `${p} must connect to Merge`);
      assert.equal(edge.index, expected, `${p} must feed Merge input ${expected}`);
    }
    assert.deepEqual([...new Set(Object.values(expectedIndex))].sort((x, y) => x - y), [0, 1, 2]);

    // Every Merge input has at least one producer.
    for (let i = 0; i < 3; i++) {
      const producers = Object.keys(conns).filter(
        (src) => (conns[src].main?.[0] || []).some((e) => e.node === 'Merge' && e.index === i),
      );
      assert.ok(producers.length >= 1, `Merge input ${i} must have at least one producer`);
    }

    // Error outputs of the provider HTTP/IF nodes are wired (R3 + A.10).
    assert.deepEqual(
      conns['Google Places API'].main[1].map((e) => e.node),
      ['GPL Error Envelope'],
    );
    assert.deepEqual(
      conns['Foursquare Places API'].main[1].map((e) => e.node),
      ['FSQ Error Envelope'],
    );
    assert.deepEqual(
      conns['OpenStreetMap Overpass API'].main[1].map((e) => e.node),
      ['OSM Error Envelope', 'Handle API Error'],
    );
    assert.deepEqual(
      conns['API Success?'].main[1].map((e) => e.node),
      ['OSM Error Envelope', 'Handle API Error'],
    );

    const mergeOut = conns['Merge'].main[0];
    assert.equal(mergeOut.length, 1, 'Merge must have exactly one output edge');
    assert.equal(mergeOut[0].node, 'Filter Empty Envelopes');
    assert.equal(
      conns['Filter Empty Envelopes'].main[0][0].node,
      'Write Raw Leads',
    );
    assert.equal(
      mergeOut.filter((e) => e.node === 'Process GPL').length,
      0,
      'no Merge -> Process GPL feedback edge',
    );
  });

  it('the contract is a functional spec (referenceWorkflow builds a valid base)', () => {
    const base = referenceWorkflow();
    assert.equal(base.nodes.length, 33);
    // Contract code nodes carry a parameters: {} placeholder, ready for injection.
    for (const name of CODE_NODE_NAMES) {
      const node = base.nodes.find((n) => n.name === name);
      assert.deepEqual(node.parameters, {});
    }
  });
});