'use strict';

/*
 * Message-body resolver (Doc 1 §5 "Message body resolution").
 *
 * Sits between buildPayload and the Resend adapter, per RESEND-REAL-EMAIL-DELIVERY-v1.md.
 * Resolves a variant to a template on disk, renders {{ lead.<dot.path> }} placeholders,
 * and produces the send-ready envelope { from, to, subject, text, html }.
 *
 * Contract:
 *   - variant resolution order: variant arg > lead.message_variant > 'cold-outreach-v1'.
 *   - templates live at templates/<variant>.json (repo root), read via readFileSync;
 *     an optional templatesDir option overrides that location (test-only).
 *   - missing template file throws `message-body: template not found: <variant>`.
 *   - malformed template JSON throws (parse error propagates).
 *   - template keys subject/text/html default to '' when absent.
 *   - only {{ lead.* }} is substituted; a missing path renders ''; other {{ ... }}
 *     (e.g. {{company.name}}) is left as-is.
 *   - no HTML escaping — templates are operator-authored and placeholder values are
 *     substituted raw. Escaping policy is a follow-up decision.
 *   - from: process.env.RESEND_FROM_EMAIL || '' ; to: lead.email || ''.
 *   - hermetic: no network, no side effects, no creds. DRY_RUN-compatible.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_VARIANT = 'cold-outreach-v1';
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

const PLACEHOLDER_RE = /\{\{\s*lead\.([\w.]+)\s*\}\}/g;

function lookupDotPath(lead, dotPath) {
  let value = lead;
  for (const key of dotPath.split('.')) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function resolveTemplate(variant, templatesDir) {
  const templatePath = path.join(templatesDir, `${variant}.json`);
  let raw;
  try {
    raw = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`message-body: template not found: ${variant}`);
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  return {
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: parsed.html || '',
  };
}

function render(text, lead) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(PLACEHOLDER_RE, (_, dotPath) => {
    const value = lookupDotPath(lead, dotPath);
    return value == null ? '' : value;
  });
}

function resolveMessage({ lead, variant, templatesDir } = {}) {
  if (lead == null || typeof lead !== 'object') {
    throw new Error('message-body: lead is required');
  }
  const resolvedVariant = variant || lead.message_variant || DEFAULT_VARIANT;
  const template = resolveTemplate(resolvedVariant, templatesDir || TEMPLATE_DIR);
  return {
    from: process.env.RESEND_FROM_EMAIL || '',
    to: lead.email || '',
    subject: render(template.subject, lead),
    text: render(template.text, lead),
    html: render(template.html, lead),
  };
}

module.exports = { resolveMessage };