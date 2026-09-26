'use strict';

/*
 * Provider boundary for Outreach-Execution-and-Delivery V1.
 *
 * The repository has NO real external delivery integration (no email, SMS, or
 * calling provider). Per the artifact spec this artifact must NOT invent one.
* Instead it defines a minimal adapter contract plus safe implementations:
 *
 *  - MockProvider: deterministic, call-tracking, used ONLY in offline tests and
 *     the local harness. It returns `success` with a `provider_message_id` that
 *     IT asserts as part of the mock contract; the engine never fabricates one.
 *  - ResendAdapter (src/providers/resend.js): the REAL-email delivery adapter,
 *     resolved by providerFor('REAL') when RESEND_API_KEY is set (Doc 1D).
 *  - NOT_CONFIGURED_PROVIDER: refuses every execution with
 *     PROVIDER_NOT_CONFIGURED. This is the workflow's default so that REAL mode
 *     without an explicit real adapter fails honestly instead of pretending.
 *
 * A real adapter (future artifact) must implement:
 *   execute(channel, payload) -> { success, provider_status, provider_message_id }
 *                            |  { success: false, error_code, error_message }
 * and may be async (returning a Promise). Success is ONLY true when the external
 * provider truthfully confirms the attempt.
 */

const PROVIDER_MODE = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  REAL: 'REAL',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
};

const PROVIDER_ERROR = {
  MOCK_PROVIDER_FAILURE: 'MOCK_PROVIDER_FAILURE',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
};

class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderError';
    this.code = code || 'PROVIDER_ERROR';
  }
}

class MockProvider {
  constructor({ mode = PROVIDER_MODE.SUCCESS } = {}) {
    this.mode = mode;
    this.calls = [];
    this._callSeq = 0;
  }

  isConfigured() {
    return true;
  }

  reset() {
    this.calls = [];
    this._callSeq = 0;
  }

  get callCount() {
    return this.calls.length;
  }

  async execute(channel, payload = {}) {
    this._callSeq += 1;
    this.calls.push({
      seq: this._callSeq,
      channel,
      payload: Object.assign({}, payload),
      at: this._callSeq,
    });
    const executionId = payload.execution_id || '?';
    if (this.mode === PROVIDER_MODE.FAILURE) {
      return {
        success: false,
        error_code: PROVIDER_ERROR.MOCK_PROVIDER_FAILURE,
        error_message: 'mock provider returned failure mode; no message was sent',
      };
    }
    return {
      success: true,
      provider_status: 'accepted',
      provider_message_id: `mock:${executionId}`,
    };
  }
}

const NOT_CONFIGURED_PROVIDER = {
  isConfigured: () => false,
  async execute() {
    return {
      success: false,
      error_code: PROVIDER_ERROR.PROVIDER_NOT_CONFIGURED,
      error_message: 'No real provider adapter is configured; execution is refused. ' +
        'This is the safe default — nothing was sent.',
    };
  },
};

/**
 * Resolve a provider-mode string to a safe provider instance. Anything other
 * than SUCCESS/FAILURE maps to NOT_CONFIGURED_PROVIDER so an unknown mode can
 * never unlock execution.
 *
 * REAL resolves the Resend email adapter when RESEND_API_KEY is set; without the
 * key it falls through to NOT_CONFIGURED_PROVIDER (fail-closed, unchanged default).
 */
function providerFor(mode) {
  if (mode === PROVIDER_MODE.SUCCESS || mode === PROVIDER_MODE.FAILURE) {
    return new MockProvider({ mode });
  }
  if (mode === PROVIDER_MODE.REAL) {
    if (process.env.RESEND_API_KEY) {
      const { ResendAdapter } = require('./providers/resend');
      return new ResendAdapter({
        apiKey: process.env.RESEND_API_KEY,
        unsubscribeUrl: process.env.RESEND_UNSUBSCRIBE_URL || '',
        unsubscribeMailto: process.env.RESEND_UNSUBSCRIBE_MAILTO || '',
      });
    }
    return NOT_CONFIGURED_PROVIDER;
  }
  return NOT_CONFIGURED_PROVIDER;
}

module.exports = {
  PROVIDER_MODE,
  PROVIDER_ERROR,
  ProviderError,
  MockProvider,
  NOT_CONFIGURED_PROVIDER,
  providerFor,
};