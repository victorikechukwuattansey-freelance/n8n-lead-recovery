'use strict';

const { normalize } = require('./schema');

function isEligible(lead) {
  const json = lead && lead.json ? lead.json : lead || {};
  const businessName = normalize(json.business_name);
  const city = normalize(json.city);
  const state = normalize(json.state);
  const country = normalize(json.country);
  const hasContact = normalize(json.website) !== '' || normalize(json.phone) !== '';
  const qualified = normalize(json.qualification_status).toUpperCase() === 'QUALIFIED';
  return Boolean(qualified && businessName && city && state && country && hasContact);
}

function expectedOutcome(fixtureRow, approvedIds) {
  if (!isEligible(fixtureRow)) return 'skip';
  const id = normalize(fixtureRow.lead_id);
  if (approvedIds.has(id)) return 'skip';
  return 'insert';
}

module.exports = { isEligible, expectedOutcome };