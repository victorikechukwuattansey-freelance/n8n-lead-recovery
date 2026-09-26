'use strict';

class MockSheets {
  constructor() {
    this.tabs = new Map();
    this.nextSheetId = 100;
  }

  addTab(name, grid) {
    this.tabs.set(name, {
      grid: (grid || []).map((row) => row.slice()),
      sheetId: this.nextSheetId++,
    });
  }

  _tab(name) {
    if (!this.tabs.has(name)) throw new Error(`Mock tab not found: ${name}`);
    return this.tabs.get(name);
  }

  listRows(tabName) {
    return this._tab(tabName).grid.map((row) => row.slice());
  }

  appendRows(tabName, rows) {
    const tab = this._tab(tabName);
    for (const row of rows) tab.grid.push(row.slice());
  }

  getSheetId(tabName) {
    return this._tab(tabName).sheetId;
  }

  deleteRows(tabName, zeroBasedIndexes) {
    const tab = this._tab(tabName);
    const toDelete = new Set(zeroBasedIndexes);
    tab.grid = tab.grid.filter((_, index) => !toDelete.has(index));
  }
}

function mockFromGrids({ verified, approved, outreachLog = [], responseLog = null }) {
  const mock = new MockSheets();
  mock.addTab('Verified Leads', verified);
  mock.addTab('Approved Outreach', approved);
  mock.addTab('Outreach Log', outreachLog);
  if (responseLog) mock.addTab('Response Log', responseLog);
  return mock;
}

module.exports = { MockSheets, mockFromGrids };