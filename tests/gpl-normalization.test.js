'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const {
  clean,
  normalizeWebsite,
  normalizePhone,
  buildDedupeKey,
  generateLeadId,
  normalizeGooglePlace,
  normalizeGooglePlacesResponse,
  rejectPatterns,
  normalizeState,
  extractGeo
} = require('../src/google-places');

const FIXED_NOW = '2026-09-12T00:00:00.000Z';

function stripRuntime(lead) {
  const { raw_captured_at, lead_id, notes, ...rest } = lead;
  return rest;
}

describe('google-places normalization', () => {
  let staticData;

  before(() => {
    staticData = { MAX_RESULTS_PER_SEARCH: 20 };
  });

  describe('clean', () => {
    it('trims whitespace', () => {
      assert.equal(clean('  hello  '), 'hello');
    });
    it('handles null/undefined', () => {
      assert.equal(clean(null), '');
      assert.equal(clean(undefined), '');
    });
  });

  describe('normalizeWebsite', () => {
    it('strips protocol, www, trailing slash', () => {
      assert.equal(normalizeWebsite('https://www.example.com/'), 'example.com');
      assert.equal(normalizeWebsite('http://example.com'), 'example.com');
      assert.equal(normalizeWebsite('www.test.com/path/'), 'test.com/path');
    });
    it('handles empty', () => {
      assert.equal(normalizeWebsite(''), '');
      assert.equal(normalizeWebsite(null), '');
    });
  });

  describe('normalizePhone', () => {
    it('preserves + and digits', () => {
      assert.equal(normalizePhone('+1 214-555-0100'), '+12145550100');
      assert.equal(normalizePhone('(214) 555-0100'), '2145550100');
    });
    it('handles empty', () => {
      assert.equal(normalizePhone(''), '');
    });
  });

  describe('buildDedupeKey', () => {
    it('prefers website', () => {
      const lead = { website: 'example.com', phone: '+12145550100', business_name: 'Test', city: 'Dallas', state: 'Texas' };
      assert.equal(buildDedupeKey(lead), 'website:example.com');
    });
    it('falls back to phone', () => {
      const lead = { website: '', phone: '+12145550100', business_name: 'Test', city: 'Dallas', state: 'Texas' };
      assert.equal(buildDedupeKey(lead), 'phone:+12145550100');
    });
    it('falls back to ncs', () => {
      const lead = { website: '', phone: '', business_name: 'Test Biz', city: 'Dallas', state: 'Texas' };
      assert.equal(buildDedupeKey(lead), 'ncs:test biz|dallas|texas');
    });
    it('returns empty for insufficient data', () => {
      assert.equal(buildDedupeKey({}), '');
    });
  });

  describe('generateLeadId', () => {
    it('is deterministic for same input', () => {
      const id1 = generateLeadId('ChIJ123', 0);
      const id2 = generateLeadId('ChIJ123', 0);
      assert.equal(id1, id2);
      assert.match(id1, /^GP-[a-f0-9]{8}$/);
    });
    it('differs for different place IDs', () => {
      const id1 = generateLeadId('ChIJ123', 0);
      const id2 = generateLeadId('ChIJ456', 0);
      assert.notEqual(id1, id2);
    });
  });

  describe('rejectPatterns', () => {
    it('contains the business-relevance rejection patterns (gate A)', () => {
      assert.equal(rejectPatterns.length, 17);
      assert.ok(rejectPatterns.some((p) => /supply/.test(p.source)));
      assert.ok(rejectPatterns.some((p) => /wholesale/.test(p.source)));
      assert.ok(rejectPatterns.some((p) => /rental/.test(p.source)));
      assert.ok(rejectPatterns.every((p) => p instanceof RegExp));
    });
  });

  describe('normalizeState', () => {
    it('recognizes two-letter codes case-insensitively', () => {
      assert.equal(normalizeState('TX'), 'tx');
      assert.equal(normalizeState('tx'), 'tx');
      assert.equal(normalizeState('GA'), 'ga');
      assert.equal(normalizeState('DC'), 'dc');
    });
    it('maps full state names to abbreviations', () => {
      assert.equal(normalizeState('Texas'), 'tx');
      assert.equal(normalizeState('New Mexico'), 'nm');
      assert.equal(normalizeState('District of Columbia'), 'dc');
    });
    it('returns empty for unrecognized values', () => {
      assert.equal(normalizeState('Saskatchewan'), '');
      assert.equal(normalizeState(''), '');
      assert.equal(normalizeState(null), '');
      assert.equal(normalizeState(undefined), '');
    });
  });

  describe('extractGeo', () => {
    it('extracts city and state from a US formatted address', () => {
      assert.deepEqual(extractGeo('123 Main St, Dallas, TX 75201, USA'), { city: 'dallas', state: 'tx' });
    });
    it('handles "City ST ZIP" without commas', () => {
      assert.deepEqual(extractGeo('Dallas TX 75201'), { city: 'dallas', state: 'tx' });
    });
    it('handles ZIP+4', () => {
      assert.deepEqual(extractGeo('123 Main St, Dallas, TX 75201-1234, USA'), { city: 'dallas', state: 'tx' });
    });
    it('keeps multi-word city names', () => {
      assert.deepEqual(extractGeo('456 Main St, San Antonio, TX 78201'), { city: 'san antonio', state: 'tx' });
    });
    it('returns the actual state, not the target state', () => {
      assert.deepEqual(extractGeo('1717 Dallas Hwy, Dallas, GA 30132'), { city: 'dallas', state: 'ga' });
    });
    it('skips unrecognized state tokens and keeps scanning', () => {
      assert.deepEqual(extractGeo('123 Main St, Unit 75201, Dallas, TX 75201'), { city: 'dallas', state: 'tx' });
    });
    it('returns null when no recognized state segment exists', () => {
      assert.equal(extractGeo('7334 South Westmoreland Rd'), null);
      assert.equal(extractGeo('123 Somewhere Lane, Paris, France'), null);
      assert.equal(extractGeo(''), null);
      assert.equal(extractGeo(undefined), null);
    });
  });

  describe('normalizeGooglePlace', () => {
    const searchInput = {
      input_id: 'S-HVAC-001',
      niche: 'HVAC',
      city: 'Dallas',
      state: 'Texas',
      country: 'USA',
      search_query: 'HVAC repair in Dallas, Texas',
      target_count: 1
    };

    it('normalizes full place', () => {
      const place = {
        id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
        displayName: { text: 'Acme HVAC Services', languageCode: 'en' },
        formattedAddress: '123 Main St, Dallas, TX 75201, USA',
        internationalPhoneNumber: '+1 214-555-0100',
        websiteUri: 'https://www.acmehvac.example.com',
        rating: 4.5,
        userRatingCount: 127,
        googleMapsUri: 'https://maps.google.com/?cid=123456789',
        types: ['hvac_contractor', 'point_of_interest', 'establishment']
      };

      const lead = normalizeGooglePlace(place, searchInput, 0, FIXED_NOW);
      assert.ok(lead);
      assert.equal(lead.business_name, 'Acme HVAC Services');
      assert.equal(lead.niche, 'HVAC');
      assert.equal(lead.city, 'Dallas');
      assert.equal(lead.state, 'Texas');
      assert.equal(lead.country, 'USA');
      assert.equal(lead.address, '123 Main St, Dallas, TX 75201, USA');
      assert.equal(lead.phone, '+12145550100');
      assert.equal(lead.website, 'acmehvac.example.com');
      assert.equal(lead.rating, '4.5');
      assert.equal(lead.review_count, '127');
      assert.equal(lead.google_maps_url, 'https://maps.google.com/?cid=123456789');
      assert.equal(lead.business_type, 'hvac_contractor');
      assert.equal(lead.source, 'google_places');
      assert.equal(lead.search_input_id, 'S-HVAC-001');
      assert.equal(lead.dedupe_key, 'website:acmehvac.example.com');
      assert.match(lead.lead_id, /^GP-[a-f0-9]{8}$/);
      assert.ok(lead.notes.includes('gp_place_id:ChIJN1t_tDeuEmsRUsoyG83frY4'));
    });

    it('handles minimal place (only name)', () => {
      const place = {
        id: 'ChIJMinimal123',
        displayName: { text: 'Quick Plumb Co', languageCode: 'en' },
        formattedAddress: '',
        internationalPhoneNumber: '',
        websiteUri: '',
        rating: null,
        userRatingCount: null,
        googleMapsUri: '',
        types: ['plumber']
      };

      const lead = normalizeGooglePlace(place, searchInput, 0, FIXED_NOW);
      assert.ok(lead);
      assert.equal(lead.business_name, 'Quick Plumb Co');
      assert.equal(lead.address, '');
      assert.equal(lead.phone, '');
      assert.equal(lead.website, '');
      assert.equal(lead.rating, '');
      assert.equal(lead.review_count, '');
      assert.equal(lead.google_maps_url, '');
      assert.equal(lead.business_type, 'plumber');
      assert.equal(lead.dedupe_key, 'ncs:quick plumb co|dallas|texas');
    });

    it('handles null/undefined optional fields', () => {
      const place = {
        id: 'ChIJMissing456',
        displayName: { text: 'Spark Electric', languageCode: 'en' },
        formattedAddress: '456 Oak Ave, San Antonio, TX 78201',
        internationalPhoneNumber: null,
        websiteUri: null,
        rating: 4.0,
        userRatingCount: 0,
        googleMapsUri: null,
        types: ['electrician', 'establishment']
      };

      const lead = normalizeGooglePlace(place, searchInput, 0, FIXED_NOW);
      assert.ok(lead);
      assert.equal(lead.phone, '');
      assert.equal(lead.website, '');
      assert.equal(lead.rating, '4');
      assert.equal(lead.review_count, '0');
      assert.equal(lead.google_maps_url, '');
    });

    it('returns null for empty business name', () => {
      const place = {
        id: 'ChIJBad333',
        displayName: { text: '', languageCode: 'en' },
        formattedAddress: '100 Bad St, Austin, TX 78701',
        internationalPhoneNumber: '+1 512-555-0300',
        websiteUri: 'https://bad.example.com',
        rating: 3.0,
        userRatingCount: 10,
        googleMapsUri: 'https://maps.google.com/?cid=777888999',
        types: ['plumber']
      };

      const lead = normalizeGooglePlace(place, searchInput, 0, FIXED_NOW);
      assert.equal(lead, null);
    });
  });

  describe('normalizeGooglePlacesResponse', () => {
    const searchInput = {
      input_id: 'S-HVAC-001',
      niche: 'HVAC',
      city: 'Dallas',
      state: 'Texas',
      country: 'USA',
      search_query: 'HVAC repair in Dallas, Texas',
      target_count: 1
    };

    it('returns leads array on success', () => {
      const response = {
        places: [
          {
            id: 'ChIJ123',
            displayName: { text: 'Test HVAC', languageCode: 'en' },
            formattedAddress: '123 Test St, Dallas, TX 75201, USA',
            internationalPhoneNumber: '+1 555-0001',
            websiteUri: 'https://test.example.com',
            rating: 4.0,
            userRatingCount: 50,
            googleMapsUri: 'https://maps.google.com/?cid=111',
            types: ['hvac_contractor']
          }
        ]
      };

      const result = normalizeGooglePlacesResponse(response, searchInput, staticData);
      assert.equal(result.error, false);
      assert.ok(Array.isArray(result.leads));
      assert.equal(result.leads.length, 1);
      assert.equal(result.leads[0].source, 'google_places');
    });

    it('respects maxResults cap (target_count * 3, 20, MAX_RESULTS_PER_SEARCH)', () => {
      const places = Array.from({ length: 25 }, (_, i) => ({
        id: `ChIJ${i}`,
        displayName: { text: `Biz ${i}`, languageCode: 'en' },
        formattedAddress: '123 Dallas St, Dallas, TX 75201',
        types: ['establishment']
      }));
      const response = { places };
      const searchInputHigh = { ...searchInput, target_count: 10 }; // 10 * 3 = 30, capped at 20

      const result = normalizeGooglePlacesResponse(response, searchInputHigh, staticData);
      assert.equal(result.leads.length, 20);
    });

    it('handles empty places array', () => {
      const response = { places: [] };
      const result = normalizeGooglePlacesResponse(response, searchInput, staticData);
      assert.equal(result.error, false);
      assert.equal(result.leads.length, 0);
    });

    it('returns error object for API error response', () => {
      const response = {
        error: { code: 403, message: 'PERMISSION_DENIED', status: 'PERMISSION_DENIED' }
      };

      const result = normalizeGooglePlacesResponse(response, searchInput, staticData);
      assert.equal(result.error, true);
      assert.equal(result.statusCode, 403);
      assert.ok(result.errorMessage.includes('PERMISSION_DENIED'));
    });

    it('handles HTTP error status codes', () => {
      // The normalizeGooglePlacesResponse function checks for gplResponse.error at top level
      const response = {
        error: { code: 429, message: 'RESOURCE_EXHAUSTED', status: 'RESOURCE_EXHAUSTED' }
      };

      const result = normalizeGooglePlacesResponse(response, searchInput, staticData);
      assert.equal(result.error, true);
      assert.equal(result.statusCode, 429);
    });

    it('limits results by target_count', () => {
      const places = Array.from({ length: 10 }, (_, i) => ({
        id: `ChIJ${i}`,
        displayName: { text: `Biz ${i}`, languageCode: 'en' },
        formattedAddress: '123 Dallas St, Dallas, TX 75201',
        types: ['establishment']
      }));
      const response = { places };
      const searchInputLow = { ...searchInput, target_count: 2 }; // 2 * 3 = 6, but only 10 available

      const result = normalizeGooglePlacesResponse(response, searchInputLow, staticData);
      assert.equal(result.leads.length, 6);
    });

    it('rejects business-relevance matches before lead creation (gate A)', () => {
      const sd = { MAX_RESULTS_PER_SEARCH: 20 };
      const response = {
        places: [
          {
            id: 'ChIJSupply1', displayName: { text: 'Dallas HVAC Supply Co', languageCode: 'en' },
            formattedAddress: '123 Dallas St, Dallas, TX 75201', types: ['store']
          },
          {
            id: 'ChIJGood1', displayName: { text: 'North Dallas Air & Heating', languageCode: 'en' },
            formattedAddress: '456 Dallas St, Dallas, TX 75201', websiteUri: 'https://air.example.com',
            internationalPhoneNumber: '+1 214-555-0100', types: ['hvac_contractor']
          }
        ]
      };

      const result = normalizeGooglePlacesResponse(response, searchInput, sd);
      assert.equal(result.leads.length, 1);
      assert.equal(result.leads[0].business_name, 'North Dallas Air & Heating');
      assert.equal(sd.gplRelevanceRejected, 1);
      assert.equal(sd.gplGeoRejected, 0);
      assert.equal(sd.gplNoContact, 0);
    });

    it('rejects geographic mismatches and fails closed on missing evidence (gate B)', () => {
      const sd = { MAX_RESULTS_PER_SEARCH: 20 };
      const gateSearchInput = { ...searchInput, target_count: 10 };
      const response = {
        places: [
          {
            id: 'ChIJPlano1', displayName: { text: 'Plano Climate Masters', languageCode: 'en' },
            formattedAddress: '789 Plano Rd, Plano, TX 75075', types: ['hvac_contractor']
          },
          {
            id: 'ChIJNoAddr1', displayName: { text: 'Dallas Comfort Experts', languageCode: 'en' },
            formattedAddress: '', types: ['hvac_contractor']
          },
          {
            id: 'ChIJGa1', displayName: { text: 'Cowboy Air Co', languageCode: 'en' },
            formattedAddress: '1717 Dallas Hwy, Dallas, GA 30132', types: ['hvac_contractor']
          },
          {
            id: 'ChIJGood2', displayName: { text: 'Bella Mesa Heating & Air', languageCode: 'en' },
            formattedAddress: '1000 Dallas St, Dallas, TX 75201', websiteUri: 'https://bella.example.com',
            internationalPhoneNumber: '+1 214-555-0200', types: ['hvac_contractor']
          }
        ]
      };

      const result = normalizeGooglePlacesResponse(response, gateSearchInput, sd);
      assert.equal(result.leads.length, 1);
      assert.equal(result.leads[0].business_name, 'Bella Mesa Heating & Air');
      assert.equal(sd.gplGeoRejected, 3);
      assert.equal(sd.gplRelevanceRejected, 0);
    });

    it('marks no-contact records with an empty dedupe key and note (gate C)', () => {
      const sd = { MAX_RESULTS_PER_SEARCH: 20 };
      const response = {
        places: [
          {
            id: 'ChIJNoContact1', displayName: { text: 'Suburban Air Balance', languageCode: 'en' },
            formattedAddress: '1100 Dallas St, Dallas, TX 75201', types: ['hvac_contractor']
          }
        ]
      };

      const result = normalizeGooglePlacesResponse(response, searchInput, sd);
      assert.equal(result.leads.length, 1);
      const lead = result.leads[0];
      assert.equal(lead.dedupe_key, '');
      assert.ok(lead.notes.includes('no_contact=true'));
      assert.equal(sd.gplNoContact, 1);
      assert.equal(sd.gplRelevanceRejected, 0);
      assert.equal(sd.gplGeoRejected, 0);
    });

    it('accumulates gate counters across calls and does not require staticData', () => {
      const sd = { MAX_RESULTS_PER_SEARCH: 20 };
      const gated = {
        places: [
          {
            id: 'ChIJRejectA', displayName: { text: 'HVAC Rental Co', languageCode: 'en' },
            formattedAddress: '123 Dallas St, Dallas, TX 75201', types: ['rental']
          }
        ]
      };
      normalizeGooglePlacesResponse(gated, searchInput, sd);
      assert.equal(sd.gplRelevanceRejected, 1);

      const noChange = {
        places: [
          {
            id: 'ChIJGood3', displayName: { text: 'Dal-Tex Air Pros', languageCode: 'en' },
            formattedAddress: '2000 Dallas St, Dallas, TX 75201', websiteUri: 'https://daltex.example.com',
            internationalPhoneNumber: '+1 214-555-0300', types: ['hvac_contractor']
          }
        ]
      };
      normalizeGooglePlacesResponse(noChange, searchInput, sd);
      assert.equal(sd.gplRelevanceRejected, 1);
      assert.equal(sd.gplGeoRejected, 0);

      normalizeGooglePlacesResponse(gated, searchInput, null);
      normalizeGooglePlacesResponse(noChange, searchInput, undefined);
    });
  });
});