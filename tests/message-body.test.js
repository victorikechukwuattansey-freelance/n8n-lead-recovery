'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveMessage } = require('../src/message-body');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');
const TEST_TEMPLATES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'message-body-test-'));

const FIXTURE_TEMPLATES = {
  'cold-outreach-v1.json': {
    subject: '{{lead.business_name}} — {{ lead.contact_name }} — {{lead.nonexistent}} — {{company.name}}',
    text: 'Hello {{  lead.business_name  }}, path={{lead.nonexistent}} keep={{company.name}}',
    html: '<p>{{lead.business_name}}</p>',
  },
  '__other-v1.json': {
    subject: 'other:@{{lead.business_name}}}',
    text: 'other:{{lead.business_name}}',
    html: '<p>other</p>',
  },
};

for (const [name, body] of Object.entries(FIXTURE_TEMPLATES)) {
  fs.writeFileSync(path.join(TEST_TEMPLATES_DIR, name), JSON.stringify(body));
}

const BASE_LEAD = {
  email: 'lead@example.com',
  business_name: 'Acme Roofing',
  contact_name: 'Ada',
  message_variant: '',
};

test('default variant resolves cold-outreach-v1 when lead.message_variant is empty', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD }, templatesDir: TEST_TEMPLATES_DIR });
  assert.equal(result.subject, 'Acme Roofing — Ada —  — {{company.name}}');
});

test('lead-provided variant is used when no argument given', () => {
  const lead = { ...BASE_LEAD, message_variant: 'cold-outreach-v1' };
  const result = resolveMessage({ lead, templatesDir: TEST_TEMPLATES_DIR });
  assert.equal(result.subject, 'Acme Roofing — Ada —  — {{company.name}}');
  assert.equal(result.to, 'lead@example.com');
});

test('variant argument overrides lead.message_variant', () => {
  const lead = { ...BASE_LEAD, message_variant: 'cold-outreach-v1' };
  const result = resolveMessage({ lead, variant: '__other-v1', templatesDir: TEST_TEMPLATES_DIR });
  assert.equal(result.subject, 'other:@Acme Roofing}');
});

test('placeholder substitution renders business_name in subject', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD }, templatesDir: TEST_TEMPLATES_DIR });
  assert.ok(result.subject.startsWith('Acme Roofing'));
});

test('whitespace tolerance inside braces renders identically', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD }, templatesDir: TEST_TEMPLATES_DIR });
  assert.ok(result.text.startsWith('Hello Acme Roofing'));
});

test('missing dot-path renders empty string without throwing', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD }, templatesDir: TEST_TEMPLATES_DIR });
  assert.equal(result.subject, 'Acme Roofing — Ada —  — {{company.name}}');
  assert.equal(result.text, 'Hello Acme Roofing, path= keep={{company.name}}');
});

test('non-lead placeholder is preserved untouched', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD }, templatesDir: TEST_TEMPLATES_DIR });
  assert.ok(result.subject.includes('{{company.name}}'));
  assert.ok(result.text.includes('{{company.name}}'));
});

test('missing template file throws message-body: template not found', () => {
  assert.throws(
    () => resolveMessage({ lead: { ...BASE_LEAD }, variant: 'no-such-variant', templatesDir: TEST_TEMPLATES_DIR }),
    /message-body: template not found: no-such-variant/
  );
});

test('from is empty when RESEND_FROM_EMAIL is missing', () => {
  const previous = process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_FROM_EMAIL;
  try {
    const result = resolveMessage({ lead: { ...BASE_LEAD } });
    assert.equal(result.from, '');
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_FROM_EMAIL;
    } else {
      process.env.RESEND_FROM_EMAIL = previous;
    }
  }
});

test('from is populated when RESEND_FROM_EMAIL is set', () => {
  const previous = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_FROM_EMAIL = 'sender@example.com';
  try {
    const result = resolveMessage({ lead: { ...BASE_LEAD } });
    assert.equal(result.from, 'sender@example.com');
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_FROM_EMAIL;
    } else {
      process.env.RESEND_FROM_EMAIL = previous;
    }
  }
});

test('to comes from lead.email', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD } });
  assert.equal(result.to, 'lead@example.com');
  assert.equal(result.from, process.env.RESEND_FROM_EMAIL || '');
});

test('return shape is exactly from/to/subject/text/html', () => {
  const result = resolveMessage({ lead: { ...BASE_LEAD } });
  assert.deepEqual(Object.keys(result).sort(), ['from', 'html', 'subject', 'text', 'to']);
});

process.on('exit', () => {
  fs.rmSync(TEST_TEMPLATES_DIR, { recursive: true, force: true });
});