'use strict';

const {
  APPROVED_COLUMNS,
  VERIFIED_COLUMNS,
  SOURCE_INTEGRITY_FIELDS,
  rowToObject,
  normalize,
  isControlName,
  FORMULA_COLUMN_SET,
} = require('./schema');

const MAPPED_FIELDS = [
  'business_name',
  'niche',
  'city',
  'state',
  'country',
  'website',
  'phone',
];

const DEFAULT_EMPTY_FIELDS = [
  'email',
  'contact_name',
  'contact_title',
  'email_source',
  'email_verified',
  'contact_form',
  'linkedin_url',
];

function same(a, b) {
  return normalize(a) === normalize(b);
}

function gridHeaderMatches(grid, expected) {
  const header = (grid[0] || []).map((c) => normalize(c));
  if (header.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (header[i] !== expected[i]) return false;
  }
  return true;
}

function analyzeGrid(grid, expectedColumns) {
  const headerOk = gridHeaderMatches(grid, expectedColumns);
  const isBlankRow = (row) => !row || row.length === 0 || row.every((cell) => normalize(cell) === '');
  const body = (grid || []).slice(1).filter((row) => !isBlankRow(row));
  const rows = body.map((row) => ({
    raw: row,
    obj: rowToObject(row, expectedColumns),
    hasExtraColumns: row.length > expectedColumns.length,
    hasMissingColumns: row.length < expectedColumns.length,
  }));
  return { headerOk, rows };
}

function indexByLeadId(rows) {
  const index = new Map();
  for (const { obj } of rows) {
    const id = normalize(obj.lead_id);
    if (id !== '' && !index.has(id)) index.set(id, obj);
  }
  return index;
}

/**
 * Builds the 13 category verification report mandated by the harness spec §14.
 *
 * approvedGrid / verifiedGrid: raw grids (header row first) as returned by a
 * Sheets transport. outreachRows: flat array of lead_ids (or raw rows) from the
 * Outreach Log tab. cleanupOk: whether post-run cleanup was executed and verified.
 */
function buildReport({ fixtures, approvedGrid, verifiedGrid, outreachRows, cleanupOk = false, tag = 'AUTOMATED' }) {
  const approved = analyzeGrid(approvedGrid || [], APPROVED_COLUMNS);
  const verified = analyzeGrid(verifiedGrid || [], VERIFIED_COLUMNS);

  const counts = new Map();
  const firstByLeadId = new Map();
  for (const entry of approved.rows) {
    const id = normalize(entry.obj.lead_id);
    if (!counts.has(id)) counts.set(id, 0);
    counts.set(id, counts.get(id) + 1);
    if (!firstByLeadId.has(id)) firstByLeadId.set(id, entry);
  }

  const verifiedIndex = indexByLeadId(verified.rows);
  const fixtureIndex = new Map(fixtures.verifiedSeeds.map((r) => [normalize(r.lead_id), r]));

  const preseed = new Set(fixtures.preseedIds);
  const expectedInsert = fixtures.expectedInsert;

  const hasExactlyOne = (id) => counts.get(id) === 1;
  const hasNone = (id) => !counts.has(id);

  const lines = [];

  lines.push({
    label: 'QUALIFIED + website',
    ok: hasExactlyOne('TEST-AOH-001'),
    detail: `TEST-AOH-001 rows=${counts.get('TEST-AOH-001') || 0}`,
    tag,
  });

  lines.push({
    label: 'QUALIFIED + phone',
    ok: hasExactlyOne('TEST-AOH-002'),
    detail: `TEST-AOH-002 rows=${counts.get('TEST-AOH-002') || 0}`,
    tag,
  });

  lines.push({
    label: 'REVIEW rejected',
    ok: hasNone('TEST-AOH-003'),
    detail: `TEST-AOH-003 rows=${counts.get('TEST-AOH-003') || 0}`,
    tag,
  });

  lines.push({
    label: 'DISQUALIFIED rejected',
    ok: hasNone('TEST-AOH-004'),
    detail: `TEST-AOH-004 rows=${counts.get('TEST-AOH-004') || 0}`,
    tag,
  });

  lines.push({
    label: 'Missing contact rejected',
    ok: hasNone('TEST-AOH-005'),
    detail: `TEST-AOH-005 rows=${counts.get('TEST-AOH-005') || 0}`,
    tag,
  });

  lines.push({
    label: 'Existing lead deduped',
    ok: hasExactlyOne('TEST-AOH-006'),
    detail: `TEST-AOH-006 rows=${counts.get('TEST-AOH-006') || 0} (pre-seeded once, no re-insert)`,
    tag,
  });

  lines.push({
    label: 'Mixed batch',
    ok: hasExactlyOne('TEST-AOH-006') && hasExactlyOne('TEST-AOH-007') && hasExactlyOne('TEST-AOH-008'),
    detail: `006=${counts.get('TEST-AOH-006') || 0} 007=${counts.get('TEST-AOH-007') || 0} 008=${counts.get('TEST-AOH-008') || 0}`,
    tag,
  });

  const expectedApprovedSet = new Set([...preseed, ...expectedInsert]);
  const namespaceApprovedIds = [...counts.keys()].filter((id) => /^TEST-AOH-\d+$/.test(id));
  const noUnexpectedRows =
    namespaceApprovedIds.length === expectedApprovedSet.size &&
    [...expectedApprovedSet].every((id) => counts.get(id) === 1);

  lines.push({
    label: 'Repeat execution',
    ok: noUnexpectedRows,
    detail: `TEST-AOH ids present=${namespaceApprovedIds.sort().join(',') || '(none)'}, every id exactly 1 row; repeat adds zero`,
    tag,
  });

  let mappingOk = expectedInsert.size > 0;
  const mappingDetails = [];
  for (const id of expectedInsert) {
    const entry = firstByLeadId.get(id);
    if (!entry) {
      mappingOk = false;
      continue;
    }
    const verified = fixtureIndex.get(id) || verifiedIndex.get(id);
    if (!verified) {
      mappingOk = false;
      continue;
    }
    for (const field of MAPPED_FIELDS) {
      if (!same(entry.obj[field], verified[field])) {
        mappingOk = false;
        mappingDetails.push(`${id}.${field}`);
      }
    }
    if (!same(entry.obj.score, verified.score)) {
      mappingOk = false;
      mappingDetails.push(`${id}.score`);
    }
    for (const field of DEFAULT_EMPTY_FIELDS) {
      if (normalize(entry.obj[field]) !== '') {
        mappingOk = false;
        mappingDetails.push(`${id}.${field}`);
      }
    }
    if (normalize(entry.obj.approved_at) === '') {
      mappingOk = false;
      mappingDetails.push(`${id}.approved_at`);
    }
  }

  lines.push({
    label: 'Mapping',
    ok: mappingOk,
    detail: mappingDetails.length ? `mismatch: ${mappingDetails.join(', ')}` : `fields+defaults checked on ${expectedInsert.size} inserted rows`,
    tag,
  });

  let schemaOk =
    approved.headerOk &&
    approved.rows.every((r) => !r.hasExtraColumns && !r.hasMissingColumns);

  if (schemaOk) {
    for (const entry of approved.rows) {
      for (const key of Object.keys(entry.obj)) {
        const leaked = isControlName(key) || (FORMULA_COLUMN_SET.has(key) && !APPROVED_COLUMNS.includes(key));
        if (leaked) {
          schemaOk = false;
          break;
        }
      }
      if (!schemaOk) break;
    }
  }

  lines.push({
    label: 'Schema contract',
    ok: schemaOk,
    detail: schemaOk
      ? `${APPROVED_COLUMNS.length}-column exact schema, no control/formula leakage`
      : 'header mismatch, row length drift, or control/formula leakage',
    tag,
  });

  let verifiedIntegrityOk = true;
  const integrityDetails = [];
  for (const id of fixtures.verifiedSeeds.map((r) => normalize(r.lead_id))) {
    const before = fixtureIndex.get(id);
    const after = verifiedIndex.get(id);
    if (!before || !after) {
      verifiedIntegrityOk = false;
      integrityDetails.push(`${id}: missing in Verified`);
      continue;
    }
    for (const field of SOURCE_INTEGRITY_FIELDS) {
      if (!same(before[field], after[field])) {
        verifiedIntegrityOk = false;
        integrityDetails.push(`${id}.${field}`);
      }
    }
  }

  lines.push({
    label: 'Verified Leads integrity',
    ok: verifiedIntegrityOk,
    detail: integrityDetails.length ? `changed: ${integrityDetails.join(', ')}` : `checked ${fixtures.verifiedSeeds.length} fixture rows`,
    tag,
  });

  const outreachNamespaceRows = (outreachRows || []).filter((r) => /^TEST-AOH-\d+$/.test(normalize(r)));
  lines.push({
    label: 'Outreach Log isolation',
    ok: outreachNamespaceRows.length === 0,
    detail: `outreach TEST-AOH rows=${outreachNamespaceRows.length}`,
    tag,
  });

  lines.push({
    label: 'Cleanup',
    ok: cleanupOk === true,
    detail: cleanupOk === true
      ? 'post-cleanup runner re-read Verified Leads + Approved Outreach and confirmed zero TEST-AOH rows remain (namespace-guarded deletes only)'
      : 'cleanup not executed or not verified (read-only verification run)',
    tag,
  });

  const passed = lines.filter((l) => l.ok).length;
  return { lines, passed, total: lines.length, ok: passed === lines.length };
}

module.exports = {
  buildReport,
  analyzeGrid,
  gridHeaderMatches,
  indexByLeadId,
  MAPPED_FIELDS,
  DEFAULT_EMPTY_FIELDS,
};