'use strict';

/*
 * Resend real-email adapter (RESEND-REAL-EMAIL-DELIVERY-v1 §5, Doc 1D).
 *
 * Implements the typed provider seam from src/provider.js:
 *   execute(channel, payload) -> { success, provider_status, provider_message_id }
 *                            |  { success: false, error_code, error_message }
 * returning a Promise, plus isConfigured().
 *
 * Probe results (scripts/probe-resend.js, 9b9edbb, 2026-09-21):
 *   - Idempotency-Key is honored (same id on replay, Idempotent-Replayed: true,
 *     one delivered email).
 *   - the response id field is `id`.
 *   - rate-limit shape was not observed; the adapter uses a fixed 1 s backoff and
 *     honors a Retry-After header if one appears later.
 *
 * Behavior:
 *   - channel === 'email' only; anything else -> REJECTED_CHANNEL.
 *   - payload must carry to/from/subject and at least one of text/html;
 *     otherwise -> REJECTED_PAYLOAD (defense-in-depth; the executor validates too).
 *   - Idempotency-Key: EX-<lead_id>-<channel>, deterministic across retries/runs.
 *   - POST { from, to, subject, text, html } (html omitted when not provided).
 *   - RFC 8058 List-Unsubscribe headers are sent in the request BODY's
 *     `headers` field (Resend forwards body.headers onto the outgoing email),
 *     never as HTTP request headers — HTTP request headers are only seen by
 *     Resend's API and never reach the delivered message.
 *   - 200 + { id } -> { success: true, provider_status: 'SENT',
 *     provider_message_id: id, idempotent_replayed }.
 *   - 429/5xx or network/timeout: retry once after backoff; second failure fails.
 *   - other 4xx: no retry.
 *   - one retry per call only; 10 s request timeout (AbortController).
 *   - adapter-owned pacing: module-level timestamp gate keeps the adapter safe when
 *     called back-to-back in a tight loop (~2 req/s default); no-ops when the
 *     executor already paces.
 *   - hermetic: no hard-coded secrets; RESEND_API_KEY is read by providerFor and
 *     injected here; this module performs no env reads.
 */

const RESEND_API_URL = 'https://api.resend.com/emails';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_PACING_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;

class ResendAdapter {
  constructor({
    apiKey,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    backoffMs = DEFAULT_BACKOFF_MS,
    pacingMs = DEFAULT_PACING_MS,
    unsubscribeUrl = '',
    unsubscribeMailto = '',
  } = {}) {
    if (!apiKey) {
      throw new Error('ResendAdapter requires an apiKey');
    }
    this.apiKey = apiKey;
    this.label = 'RESEND';
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.backoffMs = backoffMs;
    this.pacingMs = pacingMs;
    this.unsubscribeUrl = unsubscribeUrl;
    this.unsubscribeMailto = unsubscribeMailto;
  }

  isConfigured() {
    return true;
  }

  async _pace() {
    if (!this.pacingMs) {
      return;
    }
    const now = Date.now();
    const wait = Math.max(0, this.pacingMs - (now - lastRequestAt));
    if (wait > 0) {
      await sleep(wait);
    }
    lastRequestAt = Date.now();
  }

  async _post(body, idempotencyKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'Idempotency-Key': idempotencyKey,
    };

    try {
      return await this.fetch(RESEND_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(channel, payload = {}) {
    if (channel !== 'email') {
      return {
        success: false,
        provider_status: 'REJECTED_CHANNEL',
        error_code: 'REJECTED_CHANNEL',
        error_message: `Resend adapter only handles channel 'email'; got '${channel}'`,
      };
    }

    const hasText = payload.text != null;
    const hasHtml = payload.html != null;
    if (!payload.to || !payload.from || !payload.subject || (!hasText && !hasHtml)) {
      return {
        success: false,
        provider_status: 'REJECTED_PAYLOAD',
        error_code: 'REJECTED_PAYLOAD',
        error_message: 'payload missing required fields (to, from, subject, and text|html)',
      };
    }

    const idempotencyKey = payload.outreach_id || `EX-${payload.lead_id || 'unknown-lead'}-${channel}`;

    const body = {
      from: payload.from,
      to: payload.to,
      subject: payload.subject,
    };
    if (hasText) {
      body.text = payload.text;
    }
    if (hasHtml) {
      body.html = payload.html;
    }

    // RFC 8058 List-Unsubscribe — these go in the request BODY's `headers`
    // field, not as HTTP request headers. Resend forwards body.headers onto
    // the outgoing email; HTTP request headers are only seen by Resend's API.
    const unsubscribe = {};
    if (this.unsubscribeUrl) {
      unsubscribe['List-Unsubscribe'] = `<${this.unsubscribeUrl}>` +
        (this.unsubscribeMailto ? `, <mailto:${this.unsubscribeMailto}>` : '');
      unsubscribe['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    } else if (this.unsubscribeMailto) {
      unsubscribe['List-Unsubscribe'] = `<mailto:${this.unsubscribeMailto}>`;
    }
    if (Object.keys(unsubscribe).length > 0) {
      body.headers = unsubscribe;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this._pace();

      let res;
      try {
        res = await this._post(body, idempotencyKey);
      } catch (err) {
        if (attempt === 0) {
          await sleep(this.backoffMs);
          continue;
        }
        const isTimeout = err && err.name === 'AbortError';
        return {
          success: false,
          provider_status: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          error_code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
          error_message: isTimeout
            ? `Resend request timed out after ${this.timeoutMs}ms`
            : `Resend request failed: ${err.message}`,
        };
      }

      const raw = await res.text().catch(() => '');
      const isReplay =
        String((res.headers && res.headers.get('idempotent-replayed')) || '').toLowerCase() === 'true';

      if (res.status === 200) {
        let parsed = {};
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* non-JSON success body — keep empty object */
        }
        return {
          success: true,
          provider_status: 'SENT',
          provider_message_id: parsed.id || '',
          idempotent_replayed: isReplay,
        };
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt === 0) {
        const retryAfter = Number(res.headers && res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.backoffMs;
        await sleep(backoff);
        continue;
      }

      return {
        success: false,
        provider_status: String(res.status),
        error_code: String(res.status),
        error_message: raw
          ? raw.slice(0, 500)
          : `Resend returned HTTP ${res.status}`,
      };
    }
  }
}

module.exports = { ResendAdapter };