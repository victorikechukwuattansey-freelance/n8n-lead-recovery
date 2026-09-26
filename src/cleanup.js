'use strict';

const { CLEANUP_REGEX } = require('./schema');

function isTestName(leadId) {
  return CLEANUP_REGEX.test(String(leadId).trim());
}

function assertNamespaced(leadId) {
  const id = String(leadId).trim();
  if (!isTestName(id)) {
    throw new Error(`Refusing to delete non-namespaced lead_id: ${id}`);
  }
  return id;
}

function collectTestRows(grid, columnIndex = 0) {
  const rows = [];
  (grid || []).forEach((row, index) => {
    const raw = row && row[columnIndex] !== undefined ? String(row[columnIndex]).trim() : '';
    if (raw === 'lead_id') return;
    if (isTestName(raw)) {
      assertNamespaced(raw);
      rows.push({ index, lead_id: raw, row });
    }
  });
  return rows;
}

function planGridDeletes(grid, columnIndex = 0) {
  return collectTestRows(grid, columnIndex).map((r) => r.index);
}

function applyRowDeletes(grid, indexesToDelete) {
  const toDelete = new Set(indexesToDelete);
  return (grid || []).filter((_, index) => !toDelete.has(index));
}

module.exports = {
  isTestName,
  assertNamespaced,
  collectTestRows,
  planGridDeletes,
  applyRowDeletes,
};