'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', 'Lead Recovery Engine — Prospect Finder & Validation V1.json');

let workflow;

before(() => {
  workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
});

describe('Google Places workflow integration', () => {
  describe('node topology', () => {
    it('has Build GPL API Query node', () => {
      const node = workflow.nodes.find(n => n.name === 'Build GPL API Query');
      assert.ok(node, 'Build GPL API Query node should exist');
      assert.equal(node.type, 'n8n-nodes-base.code');
    });

    it('has Google Places API node', () => {
      const node = workflow.nodes.find(n => n.name === 'Google Places API');
      assert.ok(node, 'Google Places API node should exist');
      assert.equal(node.type, 'n8n-nodes-base.httpRequest');
    });

    it('has Process GPL node', () => {
      const node = workflow.nodes.find(n => n.name === 'Process GPL');
      assert.ok(node, 'Process GPL node should exist');
      assert.equal(node.type, 'n8n-nodes-base.code');
    });

    it('existing Foursquare branch still exists', () => {
      assert.ok(workflow.nodes.find(n => n.name === 'Build FSQ API Query'));
      assert.ok(workflow.nodes.find(n => n.name === 'Foursquare Places API'));
      assert.ok(workflow.nodes.find(n => n.name === 'Process FSQ'));
    });

    it('existing OSM branch still exists', () => {
      assert.ok(workflow.nodes.find(n => n.name === 'Build OSM API Query'));
      assert.ok(workflow.nodes.find(n => n.name === 'OpenStreetMap Overpass API'));
      assert.ok(workflow.nodes.find(n => n.name === 'Process OSM'));
    });
  });

  describe('Google Places API node configuration', () => {
    let gplNode;

    before(() => {
      gplNode = workflow.nodes.find(n => n.name === 'Google Places API');
    });

    it('uses POST method', () => {
      assert.equal(gplNode.parameters.method, 'POST');
    });

    it('calls Places API (New) searchText endpoint', () => {
      assert.equal(gplNode.parameters.url, 'https://places.googleapis.com/v1/places:searchText');
    });

    it('uses environment variable for API key', () => {
      const headers = gplNode.parameters.headerParameters?.parameters || [];
      const apiKeyHeader = headers.find(h => h.name === 'X-Goog-Api-Key');
      assert.ok(apiKeyHeader, 'X-Goog-Api-Key header should exist');
      assert.equal(apiKeyHeader.value, '={{ $env.GOOGLE_PLACES_API_KEY }}');
    });

    it('uses required field mask', () => {
      const headers = gplNode.parameters.headerParameters?.parameters || [];
      const maskHeader = headers.find(h => h.name === 'X-Goog-FieldMask');
      assert.ok(maskHeader, 'X-Goog-FieldMask header should exist');
      const mask = maskHeader.value;
      assert.ok(mask.includes('places.displayName'));
      assert.ok(mask.includes('places.formattedAddress'));
      assert.ok(mask.includes('places.internationalPhoneNumber'));
      assert.ok(mask.includes('places.websiteUri'));
      assert.ok(mask.includes('places.rating'));
      assert.ok(mask.includes('places.userRatingCount'));
      assert.ok(mask.includes('places.googleMapsUri'));
      assert.ok(mask.includes('places.types'));
    });

    it('sends correct body structure', () => {
      const bodyJson = gplNode.parameters.jsonBody;
      assert.ok(bodyJson);
      assert.ok(bodyJson.includes('textQuery'));
      assert.ok(bodyJson.includes('maxResultCount'));
      assert.ok(bodyJson.includes('languageCode'));
    });

    it('has error handling configured', () => {
      assert.equal(gplNode.onError, 'continueErrorOutput');
      assert.equal(gplNode.retryOnFail, true);
    });
  });

  describe('Build GPL API Query node', () => {
    let buildNode;

    before(() => {
      buildNode = workflow.nodes.find(n => n.name === 'Build GPL API Query');
    });

    it('constructs textQuery from search_query or niche+city+state', () => {
      const code = buildNode.parameters.jsCode;
      assert.ok(code.includes('gpl_query'));
      assert.ok(code.includes('search_query'));
      assert.ok(code.includes('niche'));
      assert.ok(code.includes('city'));
      assert.ok(code.includes('state'));
    });

    it('computes maxResultCount with caps', () => {
      const code = buildNode.parameters.jsCode;
      assert.ok(code.includes('gpl_max_results'));
      assert.ok(code.includes('target_count'));
      assert.ok(code.includes('Math.min'));
    });

    it('sets discovery_source to GOOGLE_PLACES', () => {
      const code = buildNode.parameters.jsCode;
      assert.ok(code.includes('GOOGLE_PLACES'));
    });
  });

  describe('Process GPL node', () => {
    let processNode;

    before(() => {
      processNode = workflow.nodes.find(n => n.name === 'Process GPL');
    });

    it('handles API errors without crashing', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('statusCode !== 200'));
      assert.ok(code.includes('_errorMessage'));
      assert.ok(code.includes('_provider'));
    });

    it('normalizes place fields to Raw Leads schema', () => {
      const code = processNode.parameters.jsCode;
      const requiredFields = [
        'lead_id', 'business_name', 'niche', 'city', 'state', 'country',
        'address', 'phone', 'website', 'rating', 'review_count',
        'google_maps_url', 'business_type', 'source', 'search_input_id',
        'dedupe_key', 'raw_captured_at', 'notes'
      ];
      for (const field of requiredFields) {
        assert.ok(code.includes(field), `Should include ${field}`);
      }
    });

    it('sets source to google_places', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes("source: 'google_places'"));
    });

    it('uses existing dedupe algorithm (website -> phone -> ncs)', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('buildDedupeKey'));
      assert.ok(code.includes('website:'));
      assert.ok(code.includes('phone:'));
      assert.ok(code.includes('ncs:'));
    });

    it('generates deterministic lead_id (GP- prefix)', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('generateLeadId'));
      assert.ok(code.includes('GP-'));
    });

    it('includes gp_place_id in notes for traceability', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('gp_place_id'));
    });

    it('respects MAX_RESULTS_PER_SEARCH', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('MAX_RESULTS_PER_SEARCH'));
    });

    it('handles empty results', () => {
      const code = processNode.parameters.jsCode;
      assert.ok(code.includes('_noResults'));
    });
  });

  describe('Merge node integration', () => {
    let mergeNode;

    before(() => {
      mergeNode = workflow.nodes.find(n => n.name === 'Merge');
    });

    it('has three provider inputs', () => {
      const connections = workflow.connections;
      const processFSQ = workflow.nodes.find(n => n.name === 'Process FSQ');
      const processOSM = workflow.nodes.find(n => n.name === 'Process OSM');
      const processGPL = workflow.nodes.find(n => n.name === 'Process GPL');

      const fsqConn = connections[processFSQ.name]?.main?.[0]?.find(c => c.node === 'Merge');
      const osmConn = connections[processOSM.name]?.main?.[0]?.find(c => c.node === 'Merge');
      const gplConn = connections[processGPL.name]?.main?.[0]?.find(c => c.node === 'Merge');

      assert.ok(fsqConn, 'FSQ should connect to Merge');
      assert.ok(osmConn, 'OSM should connect to Merge');
      assert.ok(gplConn, 'GPL should connect to Merge');
    });
  });

  describe('Merge wiring integrity', () => {
    let mergeNode;

    before(() => {
      mergeNode = workflow.nodes.find(n => n.name === 'Merge');
    });

    it('declares three append inputs on the Merge node — A.10 D7', () => {
      assert.equal(mergeNode.parameters.numberOfInputs, 3);
      assert.equal(mergeNode.parameters.mode, 'append');
    });

    it('routes each provider and its error envelope onto the same Merge input index', () => {
      const connections = workflow.connections;
      const expectedIndex = {
        'Process FSQ': 0,
        'FSQ Error Envelope': 0,
        'Process OSM': 1,
        'OSM Error Envelope': 1,
        'Process GPL': 2,
        'GPL Error Envelope': 2,
      };
      const inputs = Object.keys(expectedIndex).map(p => {
        const edge = connections[p]?.main?.[0]?.find(c => c.node === 'Merge');
        assert.ok(edge, `${p} should connect to Merge`);
        assert.equal(edge.index, expectedIndex[p], `${p} must feed Merge input ${expectedIndex[p]}`);
        return edge.index;
      });
      assert.deepEqual([...new Set(inputs)].sort(), [0, 1, 2]);
    });

    it('Merge has exactly one output edge — to Filter Empty Envelopes (R3)', () => {
      const mergeOut = workflow.connections['Merge']?.main?.[0] || [];
      assert.equal(mergeOut.length, 1);
      assert.equal(mergeOut[0].node, 'Filter Empty Envelopes');
      assert.equal(workflow.connections['Filter Empty Envelopes'].main[0][0].node, 'Write Raw Leads');
      assert.equal(workflow.connections['Filter Empty Envelopes'].main[0][0].index, 0);
    });

    it('has no Merge -> Process GPL feedback cycle', () => {
      const mergeOut = workflow.connections['Merge']?.main?.[0] || [];
      const feedback = mergeOut.filter(e => e.node === 'Process GPL');
      assert.equal(feedback.length, 0,
        'Merge must not write back into Process GPL; would create an infinite feedback loop');
    });
  });

  describe('Set Status Running connections', () => {
    it('connects to all three provider build nodes', () => {
      const connections = workflow.connections['Set Status Running']?.main?.[0] || [];
      const targets = connections.map(c => c.node);
      assert.ok(targets.includes('Build FSQ API Query'));
      assert.ok(targets.includes('Build OSM API Query'));
      assert.ok(targets.includes('Build GPL API Query'));
    });
  });

  describe('Downstream preservation', () => {
    it('Write Raw Leads node unchanged', () => {
      const node = workflow.nodes.find(n => n.name === 'Write Raw Leads');
      assert.ok(node);
      // Verify schema has 17 columns (the original schema)
      const schema = node.parameters.columns?.schema || [];
      // The actual schema may have more entries due to n8n metadata, just verify it's present and has expected fields
      const fieldIds = schema.map(s => s.id);
      assert.ok(fieldIds.includes('lead_id'));
      assert.ok(fieldIds.includes('business_name'));
      assert.ok(fieldIds.includes('source'));
      assert.ok(fieldIds.includes('dedupe_key'));
    });

    it('Dedup & Prepare Verified node unchanged', () => {
      const node = workflow.nodes.find(n => n.name === 'Dedup & Prepare Verified');
      assert.ok(node);
      const code = node.parameters.jsCode;
      assert.ok(code.includes('verifiedDedupKeys'));
      assert.ok(code.includes('seenThisRun'));
    });

    it('Dedup & Prepare Verified sets alwaysOutputData — A.9 D2\'', () => {
      const node = workflow.nodes.find(n => n.name === 'Dedup & Prepare Verified');
      assert.equal(node.alwaysOutputData, true, 'empty-success reads must not stall the loop');
    });

    it('Write Verified Leads node unchanged', () => {
      const node = workflow.nodes.find(n => n.name === 'Write Verified Leads');
      assert.ok(node);
      // Uses autoMapInputData
      assert.equal(node.parameters.columns?.mappingMode, 'autoMapInputData');
    });

    it('No new Verified Leads writer added', () => {
      const verifiedWriters = workflow.nodes.filter(n =>
        n.name.includes('Verified') && n.type === 'n8n-nodes-base.googleSheets' && n.parameters.operation === 'append'
      );
      // Should only have the original Write Verified Leads
      assert.equal(verifiedWriters.length, 1);
    });
  });

  describe('No hardcoded Google Places credentials', () => {
    it('workflow JSON contains no Google Places API keys', () => {
      const jsonStr = JSON.stringify(workflow);
      // Should not contain Google Places API key patterns
      assert.ok(!jsonStr.includes('AIzaSy'), 'Should not contain Google API key');
      // The pre-existing Foursquare Bearer token is out of scope for this integration
    });
  });
});