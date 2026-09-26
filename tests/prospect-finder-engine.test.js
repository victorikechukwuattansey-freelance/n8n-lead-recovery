'use strict';

/*
 * Prospect Finder offline engine harness (Prompt C-A, Option B).
 *
 * Executes every Code node in the workflow — the 16 bodies in
 * src/prospect-finder-embedded-code.js — through the shared vm sandbox in
 * tests/helpers/prospect-finder-vm.js. Tests load jsCode from the EMBEDDED
 * module (never duplicate code in this file); a dedicated parity block pins
 * embedded<->artifact byte identity and the exact key order of the produced
 * Raw Lead / Verified sheet rows against the workflow's own mappings.
 *
 * No live HTTP, no credentials, no network: the only fs reads are the local
 * artifact and embedded-code module, and every timestamp is frozen via
 * fixedNow so the whole suite is deterministic.
 *
 * Coverage matrix (C-A §4/§5):
 *   config          Initialize Configuration, Cache Dedup Keys
 *   loop control    Filter Pending Searches
 *   query builders  Build FSQ / OSM / GPL API Query
 *   processors      Process FSQ / OSM / GPL (incl. empty-success sentinel)
 *   error envelopes FSQ/OSM/GPL Error Envelope, Handle API Error
 *   aggregation     Filter Empty Envelopes, Dedup & Prepare Verified
 *   sheet prep      Prepare Verified Sheet Row
 *   parity          embedded<->artifact bytes; Raw Leads / Verified Leads schema
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const {
  runNode,
  embeddedNodeCode,
  artifactNodeCode,
  artifactWorkflow,
} = require('./helpers/prospect-finder-vm');
const { loadProspectFinderFixtures } = require('../fixtures/prospect-finder-fixtures.js');
const { CODE_NODE_NAMES } = require('../src/prospect-finder-workflow-contract.js');

const FIXED_NOW = '2026-09-15T00:00:00.000Z';

const RAW_LEAD_SCHEMA = [
  'lead_id', 'business_name', 'niche', 'city', 'state', 'country', 'address',
  'phone', 'website', 'rating', 'review_count', 'google_maps_url', 'business_type',
  'source', 'search_input_id', 'dedupe_key', 'raw_captured_at', 'notes',
];

// Automated mapping on Write Verified Leads (parameters.columns.value) — the
// exact columns the sheet row must supply, in order.
const VERIFIED_MAPPING_SCHEMA = [
  'lead_id', 'business_name', 'niche', 'city', 'state', 'country', 'address',
  'phone', 'website', 'rating', 'review_count', 'google_maps_url', 'business_type',
  'source', 'search_input_id', 'verified_at',
];

// Automated mapping on Write Raw Leads (parameters.columns.value) — the exact
// columns every processed provider lead must supply, in order.
const RAW_MAPPING_SCHEMA = [
  'lead_id', 'business_name', 'niche', 'city', 'state', 'country', 'address',
  'phone', 'website', 'rating', 'review_count', 'google_maps_url', 'business_type',
  'source', 'search_input_id', 'dedupe_key', 'raw_captured_at', 'notes',
];

let fixtureStore;
let F;

before(() => {
  fixtureStore = loadProspectFinderFixtures();
  F = Object.fromEntries(fixtureStore.map((f) => [f.id, f]));
  assert.equal(fixtureStore.length, 8, 'TEST-PF fixture store must expose all eight scenarios');
  assert.deepEqual(
    Object.keys(F).sort(),
    ['TEST-PF-CROSS-001', 'TEST-PF-DEDUP-001', 'TEST-PF-EMPTY-001', 'TEST-PF-ERROR-001', 'TEST-PF-FSQ-001', 'TEST-PF-GPL-001', 'TEST-PF-GPL-GATES-001', 'TEST-PF-OSM-001'].sort(),
  );
});

function run(name, opts) {
  return runNode(embeddedNodeCode(name), Object.assign({ fixedNow: FIXED_NOW }, opts));
}

function rawLeads(items) {
  return items.map((i) => i.json);
}

describe('C-A §2/§5 parity: embedded code vs shipped artifact', () => {
  it('every code node carries byte-identical jsCode in the embedded module and the artifact', () => {
    for (const name of CODE_NODE_NAMES) {
      assert.equal(
        artifactNodeCode(name),
        embeddedNodeCode(name),
        `artifact jsCode for '${name}' must byte-match the embedded module`,
      );
    }
  });

  it('CODE_NODE_NAMES covers exactly the embedded code map (16 nodes, no extras)', () => {
    const { CODE_BY_NODE } = require('../src/prospect-finder-embedded-code.js');
    const embeddedNames = Object.keys(CODE_BY_NODE).sort();
    assert.deepEqual(embeddedNames, [...CODE_NODE_NAMES].sort(), 'embedded map and contract names must match');
    assert.equal(embeddedNames.length, 16);
    const artifactNames = artifactWorkflow().nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => n.name).sort();
    assert.deepEqual(artifactNames, [...CODE_NODE_NAMES].sort(), 'artifact code-node set must match the contract');
  });

  it('the test file performs no network-capable calls (static source guard)', () => {
    // The harness is offline-only by construction: no fetch, no http/https
    // client, no got/axios/undici fetch client, no OS-process spawning.
    // Forbidden tokens are assembled from fragments so the guard's own source
    // does not contain the literal substrings it is checking for.
    const ownSource = require('node:fs').readFileSync(__filename, 'utf8');
    const spawnToken = 'child' + '_process';
    const fetchClient = 'node' + '-fetch';
    assert.ok(!/require\(['"]node:?https?['"]\)/.test(ownSource), 'must not require an http(s) client');
    assert.ok(!/require\(['"](got|axios|undici)['"]\)/.test(ownSource), 'must not require a fetch client');
    assert.ok(!ownSource.includes(fetchClient), 'must not reference a fetch client module');
    assert.ok(!/fetch\(/i.test(ownSource), 'must not call fetch');
    assert.ok(!ownSource.includes(spawnToken), 'must not spawn OS processes');
  });
});

describe('Initialize Configuration (config)', () => {
  it('seeds the declared staticData bag and passes input through', () => {
    const staticData = {};
    const { items } = run('Initialize Configuration', { inputItems: [{ json: { a: 1 } }], staticData });
    assert.equal(items.length, 1);
    assert.equal(items[0].json.a, 1);
    assert.equal(staticData.LOW_COST_MODE, true);
    assert.equal(staticData.MAX_RESULTS_PER_SEARCH, 20);
    assert.equal(staticData.workflowStartedAt, FIXED_NOW);
    assert.equal(staticData.searchesProcessed, 0);
    assert.equal(staticData.leadsCaptured, 0);
    assert.equal(staticData.leadsVerified, 0);
    assert.equal(staticData.errorsEncountered, 0);
  });

  it('passes through a multi-item input unchanged', () => {
    const { items } = run('Initialize Configuration', {
      inputItems: [{ json: { x: 1 } }, { json: { x: 2 } }],
      staticData: {},
    });
    assert.deepEqual(items.map((i) => i.json), [{ x: 1 }, { x: 2 }]);
  });

  it('never returns undefined when the input is empty', () => {
    const { items } = run('Initialize Configuration', { inputItems: [], staticData: {} });
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 0);
  });
});

describe('Cache Dedup Keys (config)', () => {
  it('builds a unique website: phone: ncs: key set from lead rows', () => {
    const staticData = {};
    const { items } = run('Cache Dedup Keys', {
      inputItems: [
        { json: { website: 'https://www.Acme.com/' } },
        { json: { website: 'HTTP://acme.com' } },
        { json: { phone: '(+1) 512-555-0101' } },
        { json: { phone: '+1 512-555-0101' } },
        { json: { business_name: 'Cool Air HVAC', city: 'Austin', state: 'TX' } },
        { json: { business_name: 'cool air hvac', city: 'austin', state: 'tx' } },
        { json: {} },
      ],
      staticData,
    });
    assert.deepEqual([...staticData.verifiedDedupKeys].sort(), [
      'ncs:cool air hvac|austin|tx',
      'phone:+15125550101',
      'website:acme.com',
    ]);
    assert.equal(staticData.verifiedLeadCount, 6, 'verifiedLeadCount counts only rows that produced a key (the empty row yields none)');
    assert.equal(items.length, 7, 'Cache Dedup Keys must be a pass-through node');
  });

  it('handles an empty Verified Leads read (no rows -> empty key set)', () => {
    const staticData = {};
    run('Cache Dedup Keys', { inputItems: [], staticData });
    assert.deepEqual(staticData.verifiedDedupKeys, []);
    assert.equal(staticData.verifiedLeadCount, 0);
  });

  it('website normalization matches the GPL provider convention (protocol + www + trailing slash)', () => {
    const cases = [
      ['https://COOLAIR.example.com/', 'coolair.example.com'],
      ['http://www.example.org/site////', 'example.org/site'],
    ];
    for (const [raw, expected] of cases) {
      const staticData = {};
      run('Cache Dedup Keys', { inputItems: [{ json: { website: raw } }], staticData });
      assert.deepEqual([...staticData.verifiedDedupKeys], [`website:${expected}`], `raw=${raw}`);
    }
  });

  it('falls back to ncs only when website and phone are both absent', () => {
    const staticData = {};
    run('Cache Dedup Keys', {
      inputItems: [{ json: { business_name: 'B', city: 'Austin', state: 'TX' } }],
      staticData,
    });
    assert.deepEqual([...staticData.verifiedDedupKeys], ['ncs:b|austin|tx']);
  });
});

describe('Filter Pending Searches (loop control)', () => {
  const pendingRows = [
    { json: { input_id: 'a', status: 'Pending' } },
    { json: { input_id: 'b', status: 'Done' } },
    { json: { input_id: 'c', status: '' } },
    { json: { input_id: 'd', status: 'Failed' } },
  ];

  it('keeps only Pending / blank status rows', () => {
    const { items } = run('Filter Pending Searches', { inputItems: pendingRows, staticData: {} });
    assert.deepEqual(items.map((i) => i.json.input_id), ['a', 'c']);
  });

  it('does not mutate the input items', () => {
    const cloned = JSON.parse(JSON.stringify(pendingRows));
    run('Filter Pending Searches', { inputItems: pendingRows, staticData: {} });
    assert.deepEqual(pendingRows, cloned);
  });

  it('emits the _noPending sentinel when every search is complete or failed', () => {
    const { items } = run('Filter Pending Searches', {
      inputItems: [{ json: { status: 'Done' } }, { json: { status: 'Failed' } }],
      staticData: {},
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].json._noPending, true);
    assert.equal(items[0].json._message, 'All searches completed or failed');
  });

  it('treats a missing status as blank (kept)', () => {
    const { items } = run('Filter Pending Searches', { inputItems: [{ json: {} }], staticData: {} });
    assert.equal(items.length, 1);
  });
});

describe('Build FSQ API Query (query builder)', () => {
  it('builds the fsq query, near, limit, category and discovery source', () => {
    const { items } = run('Build FSQ API Query', {
      inputItems: [{ json: { niche: 'Plumbing', city: 'Austin', state: 'TX', target_count: 5, keep: 'v' } }],
    });
    const out = items[0].json;
    assert.equal(out.fsq_query, 'Plumbing');
    assert.equal(out.fsq_near, 'Austin, TX');
    assert.equal(out.fsq_limit, 15, 'target_count * 3, capped at 50');
    assert.equal(out.fsq_category_id, '63be6904847c3692a84b9b56');
    assert.equal(out.discovery_source, 'FOURSQUARE');
    assert.equal(out.keep, 'v', 'input fields must be spread through');
  });

  it('caps fsq_limit at 50', () => {
    const { items } = run('Build FSQ API Query', {
      inputItems: [{ json: { niche: 'HVAC', city: 'Austin', state: 'TX', target_count: 100 } }],
    });
    assert.equal(items[0].json.fsq_limit, 50);
  });

  it('defaults niche to HVAC when absent', () => {
    const { items } = run('Build FSQ API Query', {
      inputItems: [{ json: { city: 'Austin', state: 'TX' } }],
    });
    assert.equal(items[0].json.fsq_query, 'HVAC');
  });

  it('reads $json (first input item) like the shipped node', () => {
    const { items } = run('Build FSQ API Query', {
      inputItems: [{ json: { niche: 'Roofing', city: 'Houston', state: 'TX' } }, { json: { niche: 'HVAC' } }],
    });
    assert.equal(items[0].json.fsq_near, 'Houston, TX');
  });
});

describe('Build OSM API Query (query builder)', () => {
  function buildOSM(niche, city, targetCount, extra) {
    return run('Build OSM API Query', {
      inputItems: [{ json: Object.assign({ niche, city, state: 'TX', target_count: targetCount }, extra || {}) }],
      staticData: { MAX_RESULTS_PER_SEARCH: 20 },
    }).items[0].json;
  }

  it('builds the Overpass envelope for HVAC in Austin', () => {
    const out = buildOSM('HVAC', 'Austin', 2);
    assert.ok(out._apiQuery.startsWith('[out:json][timeout:60];'));
    assert.ok(out._apiQuery.includes('area["name"="Austin"]["boundary"="administrative"]->.search;'));
    assert.ok(out._apiQuery.includes('nwr["craft"="hvac"](area.search);'));
    assert.ok(out._apiQuery.includes('nwr["shop"="heating"](area.search);'));
    assert.ok(out._apiQuery.includes('nwr["shop"="air_conditioning"](area.search);'));
    assert.ok(out._apiQuery.trim().endsWith(`out center tags 20;`));
    assert.equal(out._maxResults, 2);
    assert.equal(out._candidatePoolSize, 20, 'max(target*5,20) capped by MAX_RESULTS_PER_SEARCH');
    assert.equal(out._provider, 'openstreetmap_overpass');
  });

  it('supports plumbing/roofing/electrical/pest niche branches', () => {
    const cases = [
      ['plumbing', 'nwr["craft"="plumber"](area.search);'],
      ['roofing', 'nwr["craft"="roofer"](area.search);'],
      ['electrical', 'nwr["craft"="electrician"](area.search);'],
      ['pest', 'nwr["craft"="pest_control"](area.search);'],
    ];
    for (const [niche, expectedFragment] of cases) {
      const out = buildOSM(niche, 'Dallas', 2);
      assert.ok(out._apiQuery.includes(expectedFragment), `${niche}: ${expectedFragment}`);
    }
  });

  it('falls back to a name-only query for unknown niches', () => {
    const out = buildOSM('landscaping', 'Austin', 2);
    assert.ok(out._apiQuery.includes('nwr["name"](area.search);'));
    assert.ok(!out._apiQuery.includes('craft='), 'no craft/shop filter for unknown niche');
  });

  it('respects a small MAX_RESULTS_PER_SEARCH ceiling', () => {
    const { items } = run('Build OSM API Query', {
      inputItems: [{ json: { niche: 'HVAC', city: 'Austin', state: 'TX', target_count: 100 } }],
      staticData: { MAX_RESULTS_PER_SEARCH: 12 },
    });
    assert.equal(items[0].json._candidatePoolSize, 12);
    assert.ok(items[0].json._apiQuery.endsWith('out center tags 12;'));
  });

  it('spreads the search input through and echoes target count as _maxResults', () => {
    const out = buildOSM('HVAC', 'Austin', 7, { input_id: 'T-OSM' });
    assert.equal(out.input_id, 'T-OSM');
    assert.equal(out._maxResults, 7);
    assert.equal(out._candidatePoolSize, 20, '7*5=35 capped to 20');
  });
});

describe('Build GPL API Query (query builder)', () => {
  it('prefers search_query over the niche+city+state default', () => {
    const { items } = run('Build GPL API Query', {
      inputItems: [{ json: { niche: 'HVAC', city: 'Austin', state: 'TX', search_query: 'ac repair' } }],
    });
    assert.equal(items[0].json.gpl_query, 'ac repair');
  });

  it('defaults gpl_query to "<niche> in <city>, <state>"', () => {
    const { items } = run('Build GPL API Query', {
      inputItems: [{ json: { niche: 'HVAC', city: 'Austin', state: 'TX' } }],
    });
    assert.equal(items[0].json.gpl_query, 'HVAC in Austin, TX');
  });

  it('caps gpl_max_results at 20 (target_count * 3)', () => {
    const { items } = run('Build GPL API Query', {
      inputItems: [{ json: { target_count: 8 } }],
    });
    assert.equal(items[0].json.gpl_max_results, 20);
  });

  it('sets discovery_source GOOGLE_PLACES and spreads input through', () => {
    const { items } = run('Build GPL API Query', {
      inputItems: [{ json: { niche: 'HVAC', target_count: 1, keep: 'z' } }],
    });
    const out = items[0].json;
    assert.equal(out.discovery_source, 'GOOGLE_PLACES');
    assert.equal(out.keep, 'z');
    assert.equal(out.gpl_max_results, 3);
  });
});

describe('Process FSQ (processor)', () => {
  it('turns the TEST-PF-FSQ-001 payload into 3 Raw Leads, rejecting plumbing and phone dups', () => {
    const fx = F['TEST-PF-FSQ-001'];
    const { items } = run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    });
    const leads = rawLeads(items);
    assert.equal(leads.length, fx.expected.raw_lead_count);
    assert.deepEqual(leads.map((l) => l.lead_id), fx.expected.raw_lead_ids);
    assert.deepEqual(leads.map((l) => l.dedupe_key), fx.expected.raw_dedupe_keys);
    assert.deepEqual(leads.map((l) => l.source), fx.expected.sources);
    assert.deepEqual(leads.map((l) => l.business_type), fx.expected.business_types);
    assert.ok(leads.every((l) => l.search_input_id === fx.expected.search_input_id));
    assert.ok(leads.every((l) => l.city === 'Austin' && l.state === 'TX' && l.country === 'USA'));
    assert.ok(leads.every((l) => l.rating === 0 && l.review_count === 0 && l.google_maps_url === ''));
    assert.ok(!leads.some((l) => l.business_name === fx.expected.rejected_business_names[0]), 'plumbing must be rejected');
    assert.equal(
      leads.filter((l) => l.phone === fx.expected.dropped_duplicate_phone).length,
      1,
      'the duplicated phone collapses to a single lead (first occurrence wins, not zero occurrences)',
    );
    assert.ok(leads[0].notes.includes(fx.expected.qualification_note_substring));
    assert.ok(leads[0].notes.includes('fsq_place_id=fsq-test-cool-air-0001'));
    assert.equal(leads[0].raw_captured_at, FIXED_NOW, 'timestamp frozen by the harness');
  });

  it('produces Raw Lead rows in the exact Write Raw Leads column order', () => {
    const fx = F['TEST-PF-FSQ-001'];
    const { items } = run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    });
    for (const lead of rawLeads(items)) {
      assert.deepEqual(Object.keys(lead), RAW_LEAD_SCHEMA, 'FSQ lead key order must match the Raw Leads mapping');
    }
  });

  it('applies the geography filter (mismatched city is dropped)', () => {
    const fx = F['TEST-PF-FSQ-001'];
    const shifted = JSON.parse(JSON.stringify(fx.foursquare_response));
    // Shift the uniquely-named entry (index 1); the fixture also contains a
    // duplicate "Cool Air HVAC" row, so shifting index 0 would only drop that
    // copy and leave its twin behind.
    shifted.results[1].location.locality = 'Houston';
    const { items } = run('Process FSQ', {
      inputItems: [{ json: shifted }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    });
    const names = rawLeads(items).map((l) => l.business_name);
    assert.ok(!names.includes('Chill Bros Air Conditioning'), 'out-of-city business must be dropped');
    assert.deepEqual(names, ['Cool Air HVAC', 'Texas Comfort Heating & Air']);
  });

  it('normalizes "Texas" to "TX" for the state geography check', () => {
    const fx = F['TEST-PF-FSQ-001'];
    const shifted = JSON.parse(JSON.stringify(fx.foursquare_response));
    shifted.results[0].location.locality = 'Austin';
    shifted.results[0].location.region = 'Texas';
    const { items } = run('Process FSQ', {
      inputItems: [{ json: shifted }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    });
    assert.ok(rawLeads(items).some((l) => l.business_name === 'Cool Air HVAC'), 'Texas must equal TX');
  });

  it('drops a place with no phone, website or address', () => {
    const { items } = run('Process FSQ', {
      inputItems: [{
        json: {
          results: [{
            fsq_place_id: 'x1', name: 'ZonePro Systems',
            categories: [{ id: '63be6904847c3692a84b9b56', name: 'HVAC Contractor' }],
            location: {},
          }],
        },
      }],
      nodeData: { 'Build FSQ API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX', country: 'USA' } }] },
    });
    assert.equal(items[0].json._noResults, true, 'no contact path (phone/website/address) -> empty -> sentinel');
  });

  it('keeps an HVAC-category place with a weak name as REVIEW (R8 category-id fix)', () => {
    const { items } = run('Process FSQ', {
      inputItems: [{
        json: {
          results: [{
            fsq_place_id: 'x1b', name: 'ZonePro Systems',
            categories: [{ id: '63be6904847c3692a84b9b56', name: 'HVAC Contractor' }],
            location: { locality: 'Austin', region: 'TX' },
            tel: '+1 512-555-0199',
          }],
        },
      }],
      nodeData: { 'Build FSQ API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX', country: 'USA' } }] },
    });
    const lead = items[0].json;
    assert.equal(items[0].json._noResults, undefined, 'a category-matched place must not be sentineled');
    assert.equal(lead.business_name, 'ZonePro Systems');
    assert.ok(
      lead.notes.includes('fsq_qualification=REVIEW; reason=hvac_category_without_strong_name_match;'),
      'category match must promote to REVIEW, not silently drop',
    );
    assert.ok(lead.notes.includes('hvac_category_match=true'));
    assert.ok(lead.notes.includes('hvac_name_match=false'));
  });

  it('rejects non-HVAC names via the rejection patterns (roofing)', () => {
    const { items } = run('Process FSQ', {
      inputItems: [{
        json: {
          results: [{
            fsq_place_id: 'x2', name: 'Roofing Plus Texas',
            categories: [{ id: '50327a8591d4c4b30a586d6d', name: 'Roofing Contractor' }],
            location: { locality: 'Austin', region: 'TX', address: '1 St' },
            tel: '+1 512-555-0100',
          }],
        },
      }],
      nodeData: { 'Build FSQ API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    assert.equal(items[0].json._noResults, true);
  });

  it('flags a trane.com parent-company website as REVIEW', () => {
    const { items } = run('Process FSQ', {
      inputItems: [{
        json: {
          results: [{
            fsq_place_id: 'x3', name: 'Cool Air HVAC',
            categories: [{ id: '63be6904847c3692a84b9b56', name: 'HVAC Contractor' }],
            location: { locality: 'Austin', region: 'TX', formatted_address: '1 St, Austin, TX' },
            tel: '+1 512-555-0100', website: 'https://www.trane.com/residential',
          }],
        },
      }],
      nodeData: { 'Build FSQ API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    const lead = items[0].json;
    assert.ok(lead.notes.includes('fsq_qualification=REVIEW; reason=suspicious_or_parent_company_website;'));
  });

  it('emits a _noResults sentinel for an empty success (A.11/R7 parity)', () => {
    const fx = F['TEST-PF-EMPTY-001'];
    const { items } = run('Process FSQ', {
      inputItems: [{ json: fx.empty.foursquare }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    });
    assert.deepEqual(items[0].json, fx.expected.sentinels.foursquare);
  });
});

describe('Process OSM (processor)', () => {
  it('turns the TEST-PF-OSM-001 payload into 2 Raw Leads (rejecting chiller + unnamed)', () => {
    const fx = F['TEST-PF-OSM-001'];
    const { items } = run('Process OSM', {
      inputItems: [{ json: fx.osm_response }],
      nodeData: { 'Build OSM API Query': [{ json: fx.search_input }] },
    });
    const leads = rawLeads(items);
    assert.equal(leads.length, fx.expected.raw_lead_count);
    assert.deepEqual(leads.map((l) => l.lead_id), fx.expected.raw_lead_ids);
    assert.deepEqual(leads.map((l) => l.dedupe_key), fx.expected.raw_dedupe_keys);
    assert.deepEqual(leads.map((l) => l.source), fx.expected.sources);
    assert.deepEqual(leads.map((l) => l.business_type), fx.expected.business_types);
    assert.ok(leads.every((l) => l.search_input_id === fx.expected.search_input_id));
    assert.equal(leads[0].website, 'https://aircare.example.com', 'bare domains get the https:// prefix');
    assert.deepEqual(JSON.parse(leads[0].notes).coordinates, fx.expected.note_coordinates_first);
    assert.equal(leads[0].raw_captured_at, FIXED_NOW);
  });

  it('produces Raw Lead rows in the exact Write Raw Leads column order', () => {
    const fx = F['TEST-PF-OSM-001'];
    const { items } = run('Process OSM', {
      inputItems: [{ json: fx.osm_response }],
      nodeData: { 'Build OSM API Query': [{ json: fx.search_input }] },
    });
    for (const lead of rawLeads(items)) {
      assert.deepEqual(Object.keys(lead), RAW_LEAD_SCHEMA, 'OSM lead key order must match the Raw Leads mapping');
    }
  });

  it('collapses +1-prefixed and bare US phones to one canonical key within a single OSM batch', () => {
    const { items } = run('Process OSM', {
      inputItems: [{
        json: {
          elements: [
            { type: 'node', id: 1, tags: { name: 'Alpha HVAC', craft: 'hvac', phone: '+1 512-555-0500' } },
            { type: 'node', id: 2, tags: { name: 'Alpha HVAC Branch', craft: 'hvac', phone: '5125550500' } },
          ],
        },
      }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX', country: 'USA' } }] },
    });
    // Prompt A.12 canonical normalizePhone: an 11-digit number whose leading
    // digit is 1 collapses to its 10-digit local form, so '+1 512-555-0500'
    // and '5125550500' produce the SAME dedupe key and the duplicate collapses.
    assert.equal(items.length, 1, 'cross-format US phones must collapse to one canonical key');
    assert.deepEqual(
      items.map((i) => i.json.dedupe_key),
      ['phone:5125550500'],
      'canonical form is digits-only with the leading US 1 stripped',
    );
  });

  it('deduplicates within a single OSM batch by phone (identical normalized keys)', () => {
    const { items } = run('Process OSM', {
      inputItems: [{
        json: {
          elements: [
            { type: 'node', id: 3, tags: { name: 'Beta HVAC', craft: 'hvac', phone: '+1 512-555-0600' } },
            { type: 'node', id: 4, tags: { name: 'Beta HVAC Services', craft: 'hvac', phone: '+1 512-555-0600' } },
            { type: 'node', id: 5, tags: { name: 'Gamma HVAC', craft: 'hvac', phone: '+1 512-555-0700' } },
          ],
        },
      }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    assert.equal(items.length, 2, 'two identical phones -> one lead, third distinct phone kept');
    assert.deepEqual(items.map((i) => i.json.lead_id), ['OSM-NODE-3', 'OSM-NODE-5']);
  });

  it('skips elements with no name and no usable contact', () => {
    const { items } = run('Process OSM', {
      inputItems: [{
        json: {
          elements: [
            { type: 'node', id: 9, tags: { craft: 'hvac' } },
            { type: 'way', id: 10, tags: { name: 'Cafe Corner', craft: 'cafe' } },
          ],
        },
      }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    assert.equal(items[0].json._noResults, true, 'no viable OSM prospects -> empty -> sentinel');
  });

  it('rejects facility / equipment / plant records', () => {
    const { items } = run('Process OSM', {
      inputItems: [{
        json: {
          elements: [
            { type: 'node', id: 20, tags: { name: 'Metro HVAC Plant', craft: 'hvac', phone: '+1 512-555-0501' } },
            { type: 'node', id: 21, tags: { name: 'Duct Install Services', craft: 'hvac', phone: '+1 512-555-0502' } },
          ],
        },
      }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    const names = rawLeads(items).map((l) => l.business_name);
    assert.deepEqual(names, ['Duct Install Services'], '"plant" rejected, "install" allowed');
  });

  it('emits a _noResults sentinel for an empty success (A.11/R7 parity)', () => {
    const fx = F['TEST-PF-EMPTY-001'];
    const { items } = run('Process OSM', {
      inputItems: [{ json: fx.empty.osm }],
      nodeData: { 'Build OSM API Query': [{ json: fx.search_input }] },
    });
    assert.deepEqual(items[0].json, fx.expected.sentinels.osm);
  });
});

describe('Process GPL (processor)', () => {
  it('turns the TEST-PF-GPL-001 envelope into 2 Raw Leads with deterministic GP ids', () => {
    const fx = F['TEST-PF-GPL-001'];
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    });
    const leads = rawLeads(items);
    assert.equal(leads.length, fx.expected.raw_lead_count);
    assert.deepEqual(leads.map((l) => l.lead_id), fx.expected.raw_lead_ids);
    assert.deepEqual(leads.map((l) => l.dedupe_key), fx.expected.raw_dedupe_keys);
    assert.deepEqual(leads.map((l) => l.rating), fx.expected.ratings);
    assert.deepEqual(leads.map((l) => l.review_count), fx.expected.review_counts);
    assert.deepEqual(leads.map((l) => l.business_type), fx.expected.business_types);
    assert.deepEqual(leads.map((l) => l.source), fx.expected.sources);
    assert.ok(leads.every((l) => l.search_input_id === fx.expected.search_input_id));
    assert.equal(leads[0].phone, '+15125550301', 'phone digits are normalized, + preserved');
    assert.equal(leads[0].website, 'lonestar.example.com', 'protocol/www stripped for website');
    assert.ok(leads[0].notes.includes(fx.expected.note_substring));
    assert.equal(leads[0].raw_captured_at, FIXED_NOW);
  });

  it('produces Raw Lead rows in the exact Write Raw Leads column order', () => {
    const fx = F['TEST-PF-GPL-001'];
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    });
    for (const lead of rawLeads(items)) {
      assert.deepEqual(Object.keys(lead), RAW_LEAD_SCHEMA, 'GPL lead key order must match the Raw Leads mapping');
    }
  });

  it('caps results at target_count * 3 (bounded by MAX_RESULTS_PER_SEARCH)', () => {
    const places = Array.from({ length: 10 }, (_, i) => ({
      id: `ChIJCapTest${i}`, displayName: { text: `Place ${i}` },
      formattedAddress: `Addr ${i}, Austin, TX 78701`,
    }));
    const { items } = run('Process GPL', {
      inputItems: [{ json: { statusCode: 200, body: { places } } }],
      nodeData: { 'Build GPL API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX', country: 'USA', target_count: 2 } }] },
    });
    assert.equal(items.length, 6, 'maxResults = min(2*3, 20, MAX_RESULTS_PER_SEARCH)');
  });

  it('applies the relevance / geo / no-contact gates to the TEST-PF-GPL-GATES-001 envelope', () => {
    const fx = F['TEST-PF-GPL-GATES-001'];
    const staticData = {};
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
      staticData,
    });
    const leads = rawLeads(items);
    assert.equal(leads.length, fx.expected.raw_lead_count, 'only qualified geotargeted contactable leads survive');
    assert.deepEqual(leads.map((l) => l.lead_id), fx.expected.raw_lead_ids);
    assert.deepEqual(leads.map((l) => l.dedupe_key), fx.expected.raw_dedupe_keys);
    assert.deepEqual(leads.map((l) => l.rating), fx.expected.ratings);
    assert.deepEqual(leads.map((l) => l.review_count), fx.expected.review_counts);
    assert.deepEqual(leads.map((l) => l.business_type), fx.expected.business_types);
    assert.ok(leads.every((l) => l.search_input_id === fx.expected.search_input_id));
    assert.ok(leads[0].notes.includes(fx.expected.note_substring));
    assert.equal(staticData.gplRelevanceRejected, fx.expected.gates.gplRelevanceRejected);
    assert.equal(staticData.gplGeoRejected, fx.expected.gates.gplGeoRejected);
    assert.equal(staticData.gplNoContact, fx.expected.gates.gplNoContact);
  });

  it('neutralizes the dedupe key and marks notes for the no-contact lead (gate C)', () => {
    const fx = F['TEST-PF-GPL-GATES-001'];
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    });
    const lead = rawLeads(items)[fx.expected.no_contact_lead.index];
    assert.equal(lead.dedupe_key, fx.expected.no_contact_lead.dedupe_key);
    assert.ok(lead.notes.includes(fx.expected.no_contact_lead.note_substring));
  });

  it('drops every rejected door through the distinct zero-qualified sentinel, not the plain empty sentinel', () => {
    const staticData = {};
    const { items } = run('Process GPL', {
      inputItems: [{
        json: {
          statusCode: 200,
          body: {
            places: [
              { id: 'ChIJQ1', displayName: { text: 'Supply Depot' }, formattedAddress: '1 Main St, Dallas, TX 75201', types: ['store'] },
              { id: 'ChIJQ2', displayName: { text: 'Fort Worth Cooling Co' }, formattedAddress: '2 Main St, Fort Worth, TX 76102', types: ['hvac_contractor'] },
              { id: 'ChIJQ3', displayName: { text: 'Dallas Air Co' }, formattedAddress: '', types: ['hvac_contractor'] },
            ],
          },
        },
      }],
      nodeData: { 'Build GPL API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Dallas', state: 'TX', country: 'USA', target_count: 1 } }] },
      staticData,
    });
    const env = items[0].json;
    assert.equal(env._noResults, true);
    assert.equal(env._message, 'Google Places returned zero qualified results');
    assert.equal(env._provider, 'google_places');
    assert.equal(env._gplRelevanceRejected, 1);
    assert.equal(env._gplGeoRejected, 2);
    assert.equal(staticData.gplRelevanceRejected, 1);
    assert.equal(staticData.gplGeoRejected, 2);
    assert.ok(!Object.hasOwn(env, '_no_contact'));
  });

  it('keeps engine oracle and embedded Process GPL in lock-step on the gate fixture (parity)', () => {
    const { normalizeGooglePlacesResponse } = require('../src/google-places');
    const fx = F['TEST-PF-GPL-GATES-001'];
    const staticData = { MAX_RESULTS_PER_SEARCH: 20 };
    const engine = normalizeGooglePlacesResponse({ places: fx.gpl_envelope.body.places }, fx.search_input, staticData);
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    });

    const engineLeads = engine.leads.map(({ raw_captured_at, ...rest }) => rest);
    const embeddedLeads = rawLeads(items).map(({ raw_captured_at, ...rest }) => rest);
    assert.deepEqual(embeddedLeads, engineLeads, 'embedded Process GPL must match the engine oracle lead-for-lead');
    assert.equal(staticData.gplRelevanceRejected, fx.expected.gates.gplRelevanceRejected);
    assert.equal(staticData.gplGeoRejected, fx.expected.gates.gplGeoRejected);
    assert.equal(staticData.gplNoContact, fx.expected.gates.gplNoContact);
  });

  it('converts the HTTP error output into a typed failure envelope (errorsEncountered++)', () => {
    const staticData = {};
    const { items } = run('Process GPL', {
      inputItems: [{ json: { statusCode: 403, body: { error: { message: 'PERMISSION_DENIED' } } } }],
      nodeData: { 'Build GPL API Query': [{ json: { input_id: 'TEST-PF-ERROR-001' } }] },
      staticData,
    });
    const env = items[0].json;
    assert.equal(env.input_id, 'TEST-PF-ERROR-001');
    assert.equal(env._errorMessage, 'Google Places API error: PERMISSION_DENIED (HTTP 403)');
    assert.equal(env._rawStatus, 'HTTP 403');
    assert.equal(env._provider, 'google_places');
    assert.equal(staticData.errorsEncountered, 1);
  });

  it('uses error.status verbatim for _rawStatus when present', () => {
    const { items } = run('Process GPL', {
      inputItems: [{ json: { statusCode: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'bad' } } } }],
      nodeData: { 'Build GPL API Query': [{ json: {} }] },
    });
    assert.equal(items[0].json._rawStatus, 'INVALID_ARGUMENT');
    assert.equal(items[0].json._errorMessage, 'Google Places API error: bad (HTTP 400)');
  });

  it('emits a _noResults sentinel for an empty success (A.11/R7 parity)', () => {
    const fx = F['TEST-PF-EMPTY-001'];
    const { items } = run('Process GPL', {
      inputItems: [{ json: fx.empty.gpl }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    });
    assert.deepEqual(items[0].json, fx.expected.sentinels.gpl);
  });
});

describe('Error envelopes (FSQ / OSM / GPL)', () => {
  const ENVELOPE_NODE = {
    foursquare: 'FSQ Error Envelope',
    osm: 'OSM Error Envelope',
    gpl: 'GPL Error Envelope',
  };
  const BUILD_NODE = {
    foursquare: 'Build FSQ API Query',
    osm: 'Build OSM API Query',
    gpl: 'Build GPL API Query',
  };

  for (const [provider, nodeName] of Object.entries(ENVELOPE_NODE)) {
    describe(`${provider} error envelope`, () => {
      it('converts the TEST-PF-ERROR-001 payload into the typed envelope', () => {
        const fx = F['TEST-PF-ERROR-001'];
        const expected = fx.expected.envelopes[provider];
        const staticData = {};
        const { items } = run(nodeName, {
          inputItems: [{ json: fx.errors[provider] }],
          nodeData: { [BUILD_NODE[provider]]: [{ json: fx.search_input }] },
          staticData,
        });
        assert.equal(items.length, 1);
        const env = items[0].json;
        assert.equal(env.input_id, fx.search_input.input_id);
        assert.equal(env.search_input_id, fx.search_input.input_id, 'cleanup matcher parity');
        assert.equal(env._provider, expected._provider);
        assert.equal(env._status, expected._status);
        assert.equal(env._errorMessage, expected._errorMessage);
        assert.equal(env._rawStatus, expected._rawStatus);
        assert.equal(env.source, expected.source);
        assert.ok(env.notes.length > 0);
        assert.equal(staticData.errorsEncountered, 1);
      });

      it('degrades to _rawStatus "ERROR" when no httpCode is present', () => {
        const staticData = {};
        const { items } = run(nodeName, {
          inputItems: [{ json: { error: { message: 'Network error' } } }],
          nodeData: { [BUILD_NODE[provider]]: [{ json: { input_id: 'E1' } }] },
          staticData,
        });
        assert.equal(items[0].json.search_input_id, 'E1');
        assert.equal(items[0].json._rawStatus, 'ERROR');
        assert.match(items[0].json._errorMessage, /API error: Network error/);
      });

      it('survives a missing build-query node (empty input_id fallback)', () => {
        const { items } = run(nodeName, {
          inputItems: [{ json: { error: { message: 'boom', httpCode: 500 } } }],
          nodeData: {},
        });
        assert.equal(items[0].json.input_id, '');
        assert.equal(items[0].json.search_input_id, '');
      });
    });
  }

  it('the three envelopes all increment the same errorsEncountered counter', () => {
    const staticData = { errorsEncountered: 2 };
    for (const nodeName of Object.values(ENVELOPE_NODE)) {
      const { items } = run(nodeName, {
        inputItems: [{ json: { error: { message: 'x', httpCode: 500 } } }],
        nodeData: {},
        staticData,
      });
      assert.equal(items.length, 1);
    }
    assert.equal(staticData.errorsEncountered, 5);
  });
});

describe('Handle API Error (OSM HTTP failure sink)', () => {
  it('builds the failure row from the OSM HTTP error payload', () => {
    const staticData = {};
    const { items } = run('Handle API Error', {
      inputItems: [{ json: { statusCode: 502, body: { error: { message: 'Bad gateway' } } } }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'TEST-PF-ERROR-001' } }] },
      staticData,
    });
    assert.equal(items.length, 1);
    const row = items[0].json;
    assert.equal(row.input_id, 'TEST-PF-ERROR-001');
    assert.equal(row._errorMessage, 'Places API error: Bad gateway (HTTP 502)');
    assert.equal(row._rawStatus, 'HTTP 502');
    assert.equal(staticData.errorsEncountered, 1);
  });

  it('prefers error.status for _rawStatus', () => {
    const { items } = run('Handle API Error', {
      inputItems: [{ json: { statusCode: 503, error: { status: 'UNAVAILABLE', message: 'down' } } }],
      nodeData: { 'Build OSM API Query': [{ json: {} }] },
    });
    assert.equal(items[0].json._rawStatus, 'UNAVAILABLE');
    assert.equal(items[0].json._errorMessage, 'Places API error: down (HTTP 503)');
  });

  it('pins the fallback strings when no error details exist', () => {
    const { items } = run('Handle API Error', {
      inputItems: [{ json: {} }],
      nodeData: { 'Build OSM API Query': [{ json: {} }] },
    });
    assert.equal(items[0].json._errorMessage, 'Places API error: HTTP error 0 (HTTP 0)');
    assert.equal(items[0].json._rawStatus, 'HTTP 0');
  });
});

describe('Filter Empty Envelopes (aggregation)', () => {
  it('suppresses all three _noResults sentinels while keeping errors and real leads', () => {
    const { items } = run('Filter Empty Envelopes', {
      inputItems: [
        { json: F['TEST-PF-EMPTY-001'].expected.sentinels.foursquare },
        { json: F['TEST-PF-EMPTY-001'].expected.sentinels.osm },
        { json: F['TEST-PF-EMPTY-001'].expected.sentinels.gpl },
        { json: { lead_id: 'GP-abc', business_name: 'Real Co' } },
        { json: { _status: 'error', _errorMessage: 'X', _provider: 'google_places' } },
      ],
    });
    assert.equal(items.length, 2, 'sentinels dropped; real lead + error envelope kept');
    assert.equal(items[0].json.lead_id, 'GP-abc');
    assert.equal(items[1].json._status, 'error');
  });

  it('drops completely empty objects and keeps payload-bearing objects', () => {
    const { items } = run('Filter Empty Envelopes', {
      inputItems: [{ json: {} }, { json: { any: 1 } }],
    });
    assert.deepEqual(rawLeads(items), [{ any: 1 }]);
  });

  it('rejects stale success rows that forgot the sentinel shape but are empty', () => {
    const { items } = run('Filter Empty Envelopes', {
      inputItems: [{ json: { foo: '' } }],
    });
    // Kept here: the row carries a (meaningless) payload key — the workflow relies
    // on processors emitting `_noResults` for true empties, which A.11 restored.
    assert.equal(items.length, 1);
    assert.equal(items[0].json.foo, '');
  });
});

describe('Dedup & Prepare Verified (aggregation)', () => {
  function runDedup(inputItems, cacheKeys) {
    const staticData = {};
    const { items } = run('Dedup & Prepare Verified', {
      inputItems,
      nodeData: { 'Cache Dedup Keys': cacheKeys.map((k) => ({ json: { dedupe_key: k } })) },
      staticData,
    });
    return { items, staticData };
  }

  it('resolves the TEST-PF-DEDUP-001 cross-provider duplicate to a single verified lead', () => {
    const fx = F['TEST-PF-DEDUP-001'];
    const fsq = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    }).items);
    const gpl = rawLeads(run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    }).items);

    assert.deepEqual(fsq.map((l) => l.dedupe_key), fx.expected.fsq_dedupe_keys);
    assert.deepEqual(gpl.map((l) => l.dedupe_key), fx.expected.gpl_dedupe_keys);

    const { items } = runDedup(
      [...fsq.map((json) => ({ json })), ...gpl.map((json) => ({ json }))],
      [],
    );
    const verified = rawLeads(items);
    assert.equal(verified.length, fx.expected.verified_count);

    const dupes = verified.filter((l) => l.dedupe_key === fx.expected.cross_provider_dupe_key);
    assert.equal(dupes.length, fx.expected.verified_dupe_occurrences, 'FSQ + GPL share one website key -> exactly one passes');
    assert.equal(dupes[0].business_name, fx.expected.cross_provider_dupe_business_name);
    assert.equal(dupes[0].source, 'FOURSQUARE', 'first provider to emit the key wins this run');
  });

  it('emits the verified row shape (verified_at + manual_review_notes, key preserved)', () => {
    const { items } = runDedup(
      [{ json: { lead_id: 'GP-a', business_name: 'B', niche: 'HVAC', city: 'Austin', state: 'TX', country: 'USA', source: 'google_places', search_input_id: 's1', dedupe_key: 'phone:1' } }],
      [],
    );
    const v = items[0].json;
    assert.equal(v.verified_at, FIXED_NOW);
    assert.equal(v.manual_review_notes, '');
    assert.equal(v.dedupe_key, 'phone:1');
    assert.equal(items.length, 1);
  });

  it('skips leads already present in Verified Leads (existing key set)', () => {
    const { items } = runDedup(
      [{ json: { business_name: 'B', dedupe_key: 'website:existing.com' } }],
      ['website:existing.com'],
    );
    assert.equal(items[0].json._noNewVerified, true, 'all keys existing -> no-op sentinel');
    assert.equal(items[0].json._message, 'All leads already exist in Verified Leads');
  });

  it('skips leads without a dedupe_key and de-dupes within this run', () => {
    const { items } = runDedup(
      [
        { json: { business_name: 'X', dedupe_key: 'phone:1' } },
        { json: { business_name: 'Y', dedupe_key: '' } },
        { json: { business_name: 'X2', dedupe_key: 'phone:1' } },
      ],
      [],
    );
    assert.deepEqual(rawLeads(items).map((l) => l.business_name), ['X']);
  });

  it('respects alwaysOutputData semantics via the _noNewVerified sentinel rather than stalling', () => {
    const { items } = runDedup([], []);
    assert.equal(items.length, 1);
    assert.equal(items[0].json._noNewVerified, true);
  });

  /*
   * R9 pairedItem lineage contract.
   *
   * `Dedup & Prepare Verified` receives MULTIPLE items and returns NEW items
   * with an UNEQUAL count (it drops duplicates and skips keyless rows). n8n's
   * automatic item linking cannot guess this mapping, so a Code node MUST set
   * `pairedItem` or the thread breaks — the live symptom was
   * `$('Set Status Running').item` in `Update Status Completed` throwing
   * "Paired item data for item from node 'Dedup & Prepare Verified' is
   * unavailable." These tests pin the exact index each emitted item links to.
   */
  it('emits pairedItem pointing each verified row at the input index that produced it', () => {
    const { items } = runDedup(
      [
        { json: { business_name: 'A', dedupe_key: 'phone:1' } },
        { json: { business_name: 'B', dedupe_key: '' } },
        { json: { business_name: 'C', dedupe_key: 'phone:1' } },
        { json: { business_name: 'D', dedupe_key: 'phone:2' } },
      ],
      [],
    );

    assert.deepEqual(items.map((i) => i.json.business_name), ['A', 'D']);
    assert.deepEqual(
      items.map((i) => i.pairedItem),
      [{ item: 0 }, { item: 3 }],
      'each verified row must link back to its own source input index',
    );
  });

  it('keeps the surviving cross-provider duplicate linked to the first emitted input (FSQ wins)', () => {
    const fx = F['TEST-PF-DEDUP-001'];
    const fsq = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    }).items);
    const gpl = rawLeads(run('Process GPL', {
      inputItems: [{ json: fx.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fx.search_input }] },
    }).items);

    const inputItems = [...fsq.map((json) => ({ json })), ...gpl.map((json) => ({ json }))];
    const { items } = runDedup(inputItems, []);

    const dupe = items.find((i) => i.json.dedupe_key === fx.expected.cross_provider_dupe_key);
    assert.equal(dupe.json.source, 'FOURSQUARE');
    const expectedIndex = inputItems.findIndex(
      (i) => i.json.dedupe_key === fx.expected.cross_provider_dupe_key,
    );
    assert.equal(dupe.pairedItem.item, expectedIndex, 'surviving duplicate links to its first occurrence');
  });

  it('links the _noNewVerified sentinel to input index 0 when inputs exist', () => {
    const { items } = runDedup(
      [
        { json: { business_name: 'B', dedupe_key: 'website:existing.com' } },
        { json: { business_name: 'C', dedupe_key: 'website:other.com' } },
      ],
      ['website:existing.com', 'website:other.com'],
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].json._noNewVerified, true);
    assert.deepEqual(items[0].pairedItem, { item: 0 }, 'sentinel must keep a resolvable thread');
  });

  it('omits pairedItem on the sentinel only when Dedup received no input items', () => {
    const { items } = runDedup([], []);
    assert.equal(items.length, 1);
    assert.equal(items[0].json._noNewVerified, true);
    assert.equal(
      items[0].pairedItem,
      undefined,
      'no input items exist to link to in the degenerate alwaysOutputData case',
    );
  });
});

describe('Prompt A.12 single canonical phone normalization (R8)', () => {
  // The canonical helper — byte-identical in BOTH providers — must satisfy the
  // A.12 table regardless of which body it is read from (single source, so the
  // table only needs one extraction; the parity is pinned by the builder test).
  function canonicalNormalizePhone() {
    const body = embeddedNodeCode('Process FSQ');
    const src = body.match(/function normalizePhone\(value\) \{\n[\s\S]*?\n\}/)[0];
    const vm = require('node:vm');
    return vm.runInNewContext(`${src};\nnormalizePhone`, {});
  }

  const TABLE = [
    // input, canonical
    ['(512) 600-4311', '5126004311'],
    [15126004311, '5126004311'],
    ['+1 (512) 600-4311', '5126004311'],
    ['512-600-4311', '5126004311'],
    ['', ''],
    [null, ''],
    [undefined, ''],
    [5126004311, '5126004311'],
    ['+44 20 7946 0958', '442079460958'],
  ];

  it('normalizePhone matches the canonical table (parenthesized, +1, bare, empty, null, number, non-US)', () => {
    const normalizePhone = canonicalNormalizePhone();
    for (const [input, expected] of TABLE) {
      assert.equal(normalizePhone(input), expected, `normalizePhone(${JSON.stringify(input)})`);
    }
  });

  it('stored phones are never numbers (Foursquare and OSM outputs are strings)', () => {
    const fsq = rawLeads(run('Process FSQ', {
      inputItems: [{ json: F['TEST-PF-FSQ-001'].foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: F['TEST-PF-FSQ-001'].search_input }] },
    }).items);
    const osm = rawLeads(run('Process OSM', {
      inputItems: [{ json: F['TEST-PF-OSM-001'].osm_response }],
      nodeData: { 'Build OSM API Query': [{ json: F['TEST-PF-OSM-001'].search_input }] },
    }).items);
    assert.ok(fsq.every((l) => typeof l.phone === 'string'), 'all FSQ phones must be strings');
    assert.ok(osm.every((l) => typeof l.phone === 'string'), 'all OSM phones must be strings');
  });

  it('collapses a numeric OSM phone tag into the canonical string form', () => {
    const { items } = run('Process OSM', {
      inputItems: [{
        json: {
          elements: [
            { type: 'node', id: 700, tags: { name: 'Smart Air Conditioning', craft: 'hvac', phone: 15126004311 } },
          ],
        },
      }],
      nodeData: { 'Build OSM API Query': [{ json: { input_id: 'T', niche: 'HVAC', city: 'Austin', state: 'TX' } }] },
    });
    const lead = rawLeads(items)[0];
    assert.equal(lead.phone, '5126004311', 'numeric tag int becomes a canonical string');
    assert.equal(lead.dedupe_key, 'phone:5126004311');
  });

  it('mirrors live rows 12/50: FSQ "(512) 600-4311" + OSM 15126004311 -> one verified lead', () => {
    const fx = F['TEST-PF-CROSS-001'];
    function runDedup(inputItems, cacheKeys) {
      const staticData = {};
      const { items } = run('Dedup & Prepare Verified', {
        inputItems,
        nodeData: { 'Cache Dedup Keys': cacheKeys.map((k) => ({ json: { dedupe_key: k } })) },
        staticData,
      });
      return { items, staticData };
    }
    const fsq = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    }).items);
    const osm = rawLeads(run('Process OSM', {
      inputItems: [{ json: fx.osm_response }],
      nodeData: { 'Build OSM API Query': [{ json: fx.search_input }] },
    }).items);
    assert.deepEqual(fsq.map((l) => l.dedupe_key), fx.expected.fsq_dedupe_keys);
    assert.deepEqual(osm.map((l) => l.dedupe_key), fx.expected.osm_dedupe_keys);
    assert.equal(osm[0].phone, '5126004311');
    assert.equal(typeof osm[0].phone, 'string', 'OSM numeric phone must be stored as a string');

    const { items } = runDedup(
      [...fsq.map((json) => ({ json })), ...osm.map((json) => ({ json }))],
      [],
    );
    const verified = rawLeads(items);
    assert.equal(verified.length, fx.expected.verified_count, 'two provider rows -> exactly one verified lead');
    const dupes = verified.filter((l) => l.dedupe_key === fx.expected.cross_provider_dupe_key);
    assert.equal(dupes.length, fx.expected.verified_dupe_occurrences);
    assert.equal(dupes[0].business_name, fx.expected.cross_provider_dupe_business_name);
    assert.equal(dupes[0].source, 'FOURSQUARE', 'first provider to emit the key wins this run');
  });

  it('Cache Dedup Keys keeps raw +-form phone keys (A.12 leaves Cache untouched — pinned divergence)', () => {
    const staticData = {};
    run('Cache Dedup Keys', {
      inputItems: [
        { json: { phone: '(+1) 512-555-0101' } },
        { json: { phone: '+1 512-555-0101' } },
      ],
      staticData,
    });
    assert.deepEqual(
      [...staticData.verifiedDedupKeys].sort(),
      ['phone:+15125550101'],
      'Cache phone keys still normalize via [^\\d+] (website -> phone -> ncs order, + preserved)',
    );
  });
});

describe('Prepare Verified Sheet Row (sheet prep)', () => {
  it('emits the shipped 19-key sheet row (dedupe_key interposed between search_input_id and verified_at)', () => {
    const { items } = run('Prepare Verified Sheet Row', {
      inputItems: [{
        json: {
          lead_id: 'GP-1', business_name: 'B', niche: 'HVAC', city: 'Austin', state: 'TX',
          country: 'USA', address: '1 St', phone: '+1', website: 'w', rating: '4.8',
          review_count: '10', google_maps_url: 'g', business_type: 'hvac_contractor',
          source: 'google_places', search_input_id: 's1', verified_at: FIXED_NOW,
          notes: 'n', manual_review_notes: 'm', dedupe_key: 'website:w',
        },
      }],
    });
    const row = items[0].json;
    // Pinned to the shipped node output: the Write Verified mapping is a strict
    // subsequence here — the node interposes dedupe_key before verified_at and
    // appends notes + manual_review_notes (C-A §5 divergence documented in report).
    assert.deepEqual(Object.keys(row), [
      ...VERIFIED_MAPPING_SCHEMA.slice(0, 15),
      'dedupe_key',
      'verified_at',
      'notes',
      'manual_review_notes',
    ]);
    assert.equal(row.notes, 'n');
    assert.equal(row.manual_review_notes, 'm');
    assert.equal(row.verified_at, FIXED_NOW);
    assert.equal(row.dedupe_key, 'website:w', 'the sheet row carries the internal dedupe_key (shipped behavior)');
  });

  it('defaults absent notes / manual_review_notes to empty strings', () => {
    const { items } = run('Prepare Verified Sheet Row', {
      inputItems: [{ json: { lead_id: 'L', verified_at: FIXED_NOW } }],
    });
    assert.equal(items[0].json.notes, '');
    assert.equal(items[0].json.manual_review_notes, '');
  });

  it('maps every input item 1:1', () => {
    const { items } = run('Prepare Verified Sheet Row', {
      inputItems: [{ json: { lead_id: 'a' } }, { json: { lead_id: 'b', verified_at: FIXED_NOW } }],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].json.lead_id, 'a');
    assert.equal(items[1].json.lead_id, 'b');
  });
});

describe('C-A §5 schema parity: node output vs workflow sheets', () => {
  it('Process FSQ/OSM/GPL lead keys exactly match the Write Raw Leads mapping (order preserved)', () => {
    const artifact = artifactWorkflow();
    const writeRaw = artifact.nodes.find((n) => n.name === 'Write Raw Leads');
    const mappingKeys = Object.keys(writeRaw.parameters.columns.value);
    assert.deepEqual(mappingKeys, RAW_MAPPING_SCHEMA, 'Write Raw Leads mapping must stay positional');

    const fxFsq = F['TEST-PF-FSQ-001'];
    const fsqLead = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fxFsq.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fxFsq.search_input }] },
    }).items)[0];
    assert.deepEqual(Object.keys(fsqLead), mappingKeys, 'FSQ lead keys match the Raw Leads sheet mapping');

    const fxGpl = F['TEST-PF-GPL-001'];
    const gplLead = rawLeads(run('Process GPL', {
      inputItems: [{ json: fxGpl.gpl_envelope }],
      nodeData: { 'Build GPL API Query': [{ json: fxGpl.search_input }] },
    }).items)[0];
    assert.deepEqual(Object.keys(gplLead), mappingKeys, 'GPL lead keys match the Raw Leads sheet mapping');
  });

  it('Prepare Verified Sheet Row keys cover the Write Verified Leads mapping as an ordered subsequence (dedupe_key interposed)', () => {
    const artifact = artifactWorkflow();
    const writeVerified = artifact.nodes.find((n) => n.name === 'Write Verified Leads');
    const mappingKeys = Object.keys(writeVerified.parameters.columns.value);
    assert.deepEqual(mappingKeys, VERIFIED_MAPPING_SCHEMA, 'Write Verified Leads mapping must stay positional');

    const { items } = run('Prepare Verified Sheet Row', {
      inputItems: [{
        json: {
          lead_id: 'GP-1', business_name: 'B', niche: 'HVAC', city: 'Austin', state: 'TX',
          country: 'USA', address: '1 St', phone: '+1', website: 'w', rating: '4.8',
          review_count: '10', google_maps_url: 'g', business_type: 'hvac_contractor',
          source: 'google_places', search_input_id: 's1', verified_at: FIXED_NOW,
        },
      }],
    });
    const rowKeys = Object.keys(items[0].json);
    const mappingPositions = mappingKeys.map((k) => rowKeys.indexOf(k));
    assert.ok(mappingPositions.every((p) => p >= 0), 'every Write Verified mapping column is present in the sheet row');
    assert.deepEqual(mappingPositions, [...mappingPositions].sort((a, b) => a - b), 'mapping columns appear in the mapped order (subset)');
    // C-A §5 divergence: the shipped node interposes dedupe_key before
    // verified_at and appends notes + manual_review_notes (19 keys total,
    // mapping is 16). Pinned here, reported in the C-A write-up.
    const verifiedAtPos = mappingPositions[mappingPositions.length - 1];
    assert.equal(rowKeys[verifiedAtPos - 1], 'dedupe_key');
    assert.ok(rowKeys.includes('notes') && rowKeys.includes('manual_review_notes'));
  });

  it('the harness is deterministic under a frozen clock (fixed raw_captured_at)', () => {
    const fx = F['TEST-PF-FSQ-001'];
    const a = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    }).items);
    const b = rawLeads(run('Process FSQ', {
      inputItems: [{ json: fx.foursquare_response }],
      nodeData: { 'Build FSQ API Query': [{ json: fx.search_input }] },
    }).items);
    // vm-context objects carry the sandbox's own prototypes; normalize both
    // sides to plain objects so the comparison is byte-for-byte on data only.
    const normalize = (leads) => JSON.parse(JSON.stringify(leads));
    assert.deepEqual(normalize(a), normalize(b), 'two runs under fixedNow must be byte-identical');
  });
});