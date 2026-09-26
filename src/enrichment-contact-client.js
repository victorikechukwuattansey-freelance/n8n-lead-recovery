'use strict';

/*
 * Contact enrichment provider clients (Prompt H.4-rev) — resolve the domain-
 * search provider contract that the contact engine (src/enrichment-contact.js)
 * injects through its `client` seam (client.domainSearch(domain)). This is the
 * ONLY module in the contact half that talks to the externally-defined
 * transport; it performs no network I/O on its own and the offline tests always
 * inject a stub `transport`, so fixtures never touch the network.
 *
 * Provider contract (consumed by enrichContactLeads via client.domainSearch):
 *   client.domainSearch(domain) → { emails:[{ email, first_name, last_name,
 *                                    position, confidence, verification_status }],
 *                                    source, creditsUsed }
 *                               | THROWS with .fatal (true halts the whole
 *                                 batch; false defers the lead), .reason, .status.
 * A provider that simply has no data returns a successful empty result
 * ({ emails:[], source, creditsUsed:0 } for 4xx; creditsUsed:1 for 200-empty)
 * so the "no emails found" decision is cached and the lead is not re-billed.
 *
 * Providers:
 *   - agentdata (DEFAULT) — GET {baseUrl}/api/v1/lookup?domain=<d>
 *     &min_confidence=90&verification_status=valid,catch-all with header
 *     `Authorization: Bearer <key>`. Retries 429/5xx/transport on the
 *     [500,1500,4500] backoff schedule, paces requests at >= 200ms, 401/403 is
 *     FATAL, other 4xx returns an empty result at zero credit.
 *   - hunter (retained) — legacy GET {baseUrl}/domain-search?domain=<d>
 *     &api_key=<key>&limit=10 with exponential backoff (H.6 semantics); 401/403
 *     FATAL, other 4xx returns an empty result at zero credit.
 *
 * The provider selector and API keys are resolved ONLY here (the live runner
 * supplies both): this module may read process.env because it is runner-only
 * and is NEVER shipped inside the workflow, where the clean-source scanner bans
 * process.env. The engine and the embedded mirror never read the environment.
 */

const DEFAULT_BASE_URL = 'https://api.hunter.io/v2';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_DELAY_MS = 100;
const DEFAULT_LIMIT = 10;

const AGENTDATA_BASE_URL = 'https://agentdata.run';
const AGENTDATA_MIN_PACING_MS = 200;
const RETRY_DELAYS = [500, 1500, 4500];

const HUNTER_NOT_CONFIGURED = 'HUNTER_API_KEY not configured';
const HUNTER_AUTH_FAILED = 'hunter_auth_failed';
const HUNTER_RATE_LIMITED = 'hunter_rate_limited';
const HUNTER_SERVER_ERROR = 'hunter_server_error';
const HUNTER_NETWORK_ERROR = 'hunter_network_error';
const HUNTER_TRANSPORT_UNAVAILABLE = 'hunter_transport_unavailable';
const HUNTER_UNKNOWN_RESPONSE = 'hunter_unknown_response';

const AGENTDATA_NOT_CONFIGURED = 'AGENTDATA_API_KEY not configured';
const AGENTDATA_AUTH_FAILED = 'AgentData: invalid API key';
const AGENTDATA_RATE_LIMITED = 'AgentData: rate limited';
const AGENTDATA_SERVER_ERROR = 'AgentData: server error';
const AGENTDATA_NETWORK_ERROR = 'AgentData: network error';
const AGENTDATA_TRANSPORT_UNAVAILABLE = 'AgentData: transport unavailable';
const AGENTDATA_INVALID_JSON = 'AgentData: invalid response JSON';
const AGENTDATA_UNKNOWN_RESPONSE = 'AgentData: unknown response';

function normalize(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeDomain(value) {
  let url = normalize(value).toLowerCase();
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  url = url.replace(/^www\./, '');
  url = url.split('/')[0];
  url = url.split('?')[0];
  url = url.split('#')[0];
  return url.replace(/[.:]+$/, '');
}

function emailDomainOf(value) {
  const at = normalize(value).lastIndexOf('@');
  if (at === -1) return '';
  return normalize(value).slice(at + 1);
}

function delayForAttempt(attempt, minDelayMs) {
  const base = Number.isFinite(Number(minDelayMs)) ? Number(minDelayMs) : DEFAULT_MIN_DELAY_MS;
  const exp = Number.isFinite(Number(attempt)) ? Number(attempt) : 0;
  return Math.max(0, base * Math.pow(2, exp));
}

function delayForSchedule(backoff, attempt) {
  const schedule = Array.isArray(backoff) && backoff.length > 0 ? backoff : RETRY_DELAYS;
  const index = Number.isFinite(Number(attempt)) ? Number(attempt) : 0;
  if (index >= schedule.length) return schedule[schedule.length - 1];
  return Number(schedule[index]) || 0;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceDelayFor(lastCallAt, now, minPacingMs) {
  const pacing = Number(minPacingMs) || 0;
  if (pacing <= 0 || !Number.isFinite(now)) return 0;
  if (!Number.isFinite(lastCallAt)) return 0;
  return Math.max(0, pacing - Math.max(0, now - lastCallAt));
}

async function fetchTransport(url, options) {
  const opts = options || {};
  const headers = opts.headers || {};
  const response = await fetch(url, Object.keys(headers).length > 0 ? { headers } : undefined);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function providerError(reason, fatal, status) {
  const err = new Error(reason);
  err.reason = reason;
  err.fatal = fatal === true;
  if (status !== undefined && status !== null) err.status = status;
  return err;
}

/* ------------------------------------------------------------------ */
/* AgentData domain-search client (default provider)                    */
/* ------------------------------------------------------------------ */

function normalizeVerificationStatus(value) {
  const v = normalize(value).toLowerCase();
  if (v === 'valid' || v === 'catch-all') return 'valid';
  return 'unknown';
}

function splitName(item) {
  const first = normalize(item && item.first_name);
  const last = normalize(item && item.last_name);
  if (first !== '' || last !== '') return { first, last };
  const full = normalize(item && (item.name || item.full_name));
  if (full === '') return { first: '', last: '' };
  const at = full.lastIndexOf(' ');
  if (at === -1) return { first: full, last: '' };
  return { first: normalize(full.slice(0, at)), last: normalize(full.slice(at + 1)) };
}

function firstEmailArray(body) {
  if (body && Array.isArray(body.emails)) return body.emails;
  if (body && body.emails && Array.isArray(body.emails.data)) return body.emails.data;
  if (body && body.data && Array.isArray(body.data.emails)) return body.data.emails;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

function parseAgentDataDomainSearch(body, requestedDomain) {
  const target = normalizeDomain(requestedDomain);
  const emails = [];
  for (const item of firstEmailArray(body)) {
    if (!item || typeof item !== 'object') continue;
    const email = normalize(item.email || item.value);
    if (email === '') continue;
    if (target !== '' && normalizeDomain(emailDomainOf(email)) !== target) continue;
    const name = splitName(item);
    const confidence = Number(item.confidence);
    emails.push({
      email,
      first_name: name.first,
      last_name: name.last,
      position: normalize(item.position || item.title),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      verification_status: normalizeVerificationStatus(item.verification_status || item.verification),
    });
  }
  return { ok: true, emails, source: 'agentdata', creditsUsed: 1 };
}

function buildAgentDataUrl(options) {
  const opts = options || {};
  const base = normalize(opts.baseUrl) || AGENTDATA_BASE_URL;
  const minConfidence = opts.minConfidence === undefined || opts.minConfidence === null ? 90 : opts.minConfidence;
  const params = new URLSearchParams({
    domain: String(opts.domain || ''),
    min_confidence: String(minConfidence),
    verification_status: String(opts.verificationStatus || 'valid,catch-all'),
  });
  return `${base.replace(/\/+$/, '')}/api/v1/lookup?${params.toString()}`;
}

function createAgentDataClient(options) {
  const opts = options || {};
  const envKey = typeof process !== 'undefined' && process.env ? process.env.AGENTDATA_API_KEY : '';
  const apiKey = String(opts.apiKey || envKey || '');
  const baseUrl = normalize(opts.baseUrl) || AGENTDATA_BASE_URL;
  const maxRetries = Number.isFinite(Number(opts.maxRetries)) ? Number(opts.maxRetries) : RETRY_DELAYS.length;
  const retryDelays = Array.isArray(opts.retryDelays) ? opts.retryDelays.slice() : RETRY_DELAYS.slice();
  const minPacingMs = Number.isFinite(Number(opts.minPacingMs)) ? Number(opts.minPacingMs) : AGENTDATA_MIN_PACING_MS;
  const transport = typeof opts.transport === 'function' ? opts.transport : null;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
  let lastCallAt = Number.NaN;

  function isConfigured() {
    return apiKey !== '';
  }

  async function domainSearch(domain) {
    if (!isConfigured()) {
      throw providerError(AGENTDATA_NOT_CONFIGURED, true, null);
    }
    if (!transport) {
      throw providerError(AGENTDATA_TRANSPORT_UNAVAILABLE, false, null);
    }
    const url = buildAgentDataUrl({ baseUrl, domain });
    const headers = { Authorization: `Bearer ${apiKey}` };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const paceWait = paceDelayFor(lastCallAt, clock(), minPacingMs);
      if (paceWait > 0) await sleep(paceWait);
      lastCallAt = clock();

      let status = 0;
      let body = null;
      try {
        const result = await transport(url, { headers });
        status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 0;
        body = result ? result.body : null;
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(delayForSchedule(retryDelays, attempt));
          continue;
        }
        throw providerError(AGENTDATA_NETWORK_ERROR, false, null);
      }

      if (status === 200) {
        return parseAgentDataDomainSearch(body, domain);
      }
      if (status === 401 || status === 403) {
        throw providerError(AGENTDATA_AUTH_FAILED, true, status);
      }
      if (status === 429 || status >= 500) {
        if (attempt < maxRetries) {
          await sleep(delayForSchedule(retryDelays, attempt));
          continue;
        }
        throw providerError(
          status === 429 ? AGENTDATA_RATE_LIMITED : AGENTDATA_SERVER_ERROR,
          false,
          status,
        );
      }
      if (status === 0 && !body) {
        throw providerError(AGENTDATA_UNKNOWN_RESPONSE, false, null);
      }
      return { ok: true, emails: [], source: 'agentdata', creditsUsed: 0 };
    }

    throw providerError(AGENTDATA_UNKNOWN_RESPONSE, false, null);
  }

  return { provider: 'agentdata', domainSearch, search: domainSearch, isConfigured };
}

/* ------------------------------------------------------------------ */
/* Hunter domain-search client (retained, reshaped to the contract)     */
/* ------------------------------------------------------------------ */

function parseDomainSearch(body, requestedDomain) {
  const data = (body && body.data) || {};
  const rawEmails = Array.isArray(data.emails) ? data.emails : [];
  const target = normalizeDomain(requestedDomain);
  const emails = [];
  for (const item of rawEmails) {
    if (!item || typeof item !== 'object') continue;
    const value = normalize(item.value);
    if (value === '') continue;
    if (target !== '' && normalizeDomain(emailDomainOf(value)) !== target) continue;
    const confidence = Number(item.confidence);
    const verification = (item && item.verification) || {};
    emails.push({
      email: value,
      first_name: normalize(item.first_name),
      last_name: normalize(item.last_name),
      position: normalize(item.position),
      confidence: Number.isFinite(confidence) ? confidence : 0,
      verification_status: normalize(verification.status).toLowerCase() === 'valid' ? 'valid' : 'unknown',
    });
  }
  return { ok: true, emails, source: 'hunter', creditsUsed: 1 };
}

function buildSearchUrl(options) {
  const opts = options || {};
  const base = normalize(opts.baseUrl) || DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    domain: String(opts.domain || ''),
    api_key: String(opts.apiKey || ''),
    limit: String(opts.limit || DEFAULT_LIMIT),
  });
  return `${base.replace(/\/+$/, '')}/domain-search?${params.toString()}`;
}

function createHunterClient(options) {
  const opts = options || {};
  const envKey = typeof process !== 'undefined' && process.env ? process.env.HUNTER_API_KEY : '';
  const apiKey = String(opts.apiKey || envKey || '');
  const baseUrl = normalize(opts.baseUrl) || DEFAULT_BASE_URL;
  const maxRetries = Number.isFinite(Number(opts.maxRetries)) ? Number(opts.maxRetries) : DEFAULT_MAX_RETRIES;
  const minDelayMs = Number.isFinite(Number(opts.minDelayMs)) ? Number(opts.minDelayMs) : DEFAULT_MIN_DELAY_MS;
  const transport = typeof opts.transport === 'function' ? opts.transport : null;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;

  function isConfigured() {
    return apiKey !== '';
  }

  async function domainSearch(domain) {
    if (!isConfigured()) {
      throw providerError(HUNTER_NOT_CONFIGURED, true, null);
    }
    if (!transport) {
      throw providerError(HUNTER_TRANSPORT_UNAVAILABLE, false, null);
    }
    const url = buildSearchUrl({ baseUrl, apiKey, domain, limit: DEFAULT_LIMIT });

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let status = 0;
      let body = null;
      try {
        const result = await transport(url);
        status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 0;
        body = result ? result.body : null;
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(delayForAttempt(attempt, minDelayMs));
          continue;
        }
        throw providerError(HUNTER_NETWORK_ERROR, false, null);
      }

      if (status === 200) {
        return parseDomainSearch(body, domain);
      }
      if (status === 401 || status === 403) {
        throw providerError(HUNTER_AUTH_FAILED, true, status);
      }
      if (status === 429 || status >= 500) {
        if (attempt < maxRetries) {
          await sleep(delayForAttempt(attempt, minDelayMs));
          continue;
        }
        throw providerError(
          status === 429 ? HUNTER_RATE_LIMITED : HUNTER_SERVER_ERROR,
          false,
          status,
        );
      }
      if (status === 0 && !body) {
        throw providerError(HUNTER_UNKNOWN_RESPONSE, false, null);
      }
      return { ok: true, emails: [], source: 'hunter', creditsUsed: 0 };
    }

    throw providerError(HUNTER_UNKNOWN_RESPONSE, false, null);
  }

  return { provider: 'hunter', domainSearch, search: domainSearch, isConfigured };
}

/* ------------------------------------------------------------------ */
/* Provider dispatch                                                    */
/* ------------------------------------------------------------------ */

function createContactClient(options) {
  const opts = options || {};
  const envProvider =
    typeof process !== 'undefined' && process.env ? process.env.ENRICHMENT_PROVIDER || '' : '';
  const provider = normalize(opts.provider || envProvider || 'agentdata').toLowerCase();
  if (provider === 'agentdata') return createAgentDataClient(opts);
  if (provider === 'hunter') return createHunterClient(opts);
  throw providerError(`enrichment-client: unknown provider '${provider}'`, true, null);
}

function isConfigured(apiKey) {
  return normalize(apiKey) !== '';
}

module.exports = {
  createContactClient,
  createAgentDataClient,
  createHunterClient,
  parseDomainSearch,
  parseAgentDataDomainSearch,
  buildSearchUrl,
  buildAgentDataUrl,
  emailDomainOf,
  delayForAttempt,
  delayForSchedule,
  paceDelayFor,
  normalizeVerificationStatus,
  defaultSleep,
  isConfigured,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_LIMIT,
  AGENTDATA_BASE_URL,
  AGENTDATA_MIN_PACING_MS,
  RETRY_DELAYS,
  HUNTER_NOT_CONFIGURED,
  HUNTER_AUTH_FAILED,
  HUNTER_RATE_LIMITED,
  HUNTER_SERVER_ERROR,
  HUNTER_NETWORK_ERROR,
  HUNTER_TRANSPORT_UNAVAILABLE,
  HUNTER_UNKNOWN_RESPONSE,
  AGENTDATA_NOT_CONFIGURED,
  AGENTDATA_AUTH_FAILED,
  AGENTDATA_RATE_LIMITED,
  AGENTDATA_SERVER_ERROR,
  AGENTDATA_NETWORK_ERROR,
  AGENTDATA_TRANSPORT_UNAVAILABLE,
  AGENTDATA_INVALID_JSON,
  AGENTDATA_UNKNOWN_RESPONSE,
};