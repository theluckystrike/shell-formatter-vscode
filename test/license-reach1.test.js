'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reach = require('../src/license/reach1');
const idx = require('../src/license/index');

const tools = [
  { id: 'merge', title: 'Merge PDFs', command: 'pdf.merge', extensions: ['.pdf'] },
  { id: 'split', title: 'Split PDF', command: 'pdf.split', extensions: ['pdf'] },
];

test('REACH1 tries label reads the existing counter as a remaining count', () => {
  assert.equal(reach.triesLabel(3), '3 free tries');
  assert.equal(reach.triesLabel(2), '2 tries left');
  assert.equal(reach.triesLabel(1), '1 try left');
  assert.equal(reach.triesLabel(0), '0 tries left');
  assert.deepEqual(reach.remainingTries({ get: (key) => key === 'viewer.proTrial' ? { merge: 1, split: 3 } : {} }, 'viewer.proTrial', tools), { merge: 2, split: 0 });
});

test('REACH1 card links carry toolbar and context surface tags', () => {
  assert.ok(idx.SURFACES.includes('toolbar'));
  assert.ok(idx.SURFACES.includes('ctx'));
  const html = reach.renderToolbarRow({ tools, tries: { merge: 3 }, commandPrefix: 'pdfViewer' });
  const href = html.match(/class="zovo-reach1-buy" href="([^"]+)/)[1];
  const url = new URL(href.replace('&amp;', '&'));
  assert.equal(url.pathname, 'pdfViewer.getPro');
  assert.deepEqual(JSON.parse(decodeURIComponent(url.search.slice(1))), [{ surface: 'toolbar' }]);
  assert.deepEqual(reach.explorerMenus(tools).map((m) => m.title), ['Zovo Pro: Merge PDFs', 'Zovo Pro: Split PDF']);
  assert.ok(idx.SURFACES.includes('ctx'), 'ctx is accepted by card2 surface validation');
  assert.equal(idx.surfaceOf({ surface: 'toolbar' }), 'toolbar');
  assert.equal(idx.surfaceOf({ surface: 'ctx' }), 'ctx');
});

test('REACH1 row hides after close for the rest of the session', () => {
  const values = new Map();
  const session = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
  assert.equal(reach.isClosed(session), false);
  const root = { addEventListener(_name, fn) { this.click = fn; }, removeEventListener() {} };
  const row = { hidden: false };
  const close = { closest: (selector) => selector === '.zovo-reach1' ? row : null };
  reach.bindToolbarRow(root, { session });
  root.click({ target: { closest: (selector) => selector === '.zovo-reach1-close' ? close : null } });
  assert.equal(row.hidden, true);
  assert.equal(reach.isClosed(session), true);
  assert.equal(reach.renderToolbarRow({ tools, commandPrefix: 'pdfViewer', closed: reach.isClosed(session) }), '');
});

test('REACH1 emits no row when the listing has no Pro tools', () => {
  assert.equal(reach.renderToolbarRow({ tools: [], commandPrefix: 'viewer' }), '');
  assert.equal(reach.renderToolbarRow({ commandPrefix: 'viewer' }), '');
});
