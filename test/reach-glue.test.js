'use strict';
// REACH1 glue tests (lane REACHE): tries labels, surface tags, row closed for the session, no row without Pro tools,
// and the Explorer entries in package.json. No network, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const glue = require('../src/reach');
const cfg = require('../src/reach-config');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function fakeVscode() {
  const cmds = new Map(); const ran = [];
  const Uri = { joinPath: (u, ...p) => ({ scheme: u.scheme, path: path.posix.join(u.path, ...p), fsPath: path.posix.join(u.path, ...p) }) };
  return {
    cmds, ran, Uri,
    commands: {
      registerCommand: (id, fn) => { cmds.set(id, fn); return { dispose() { cmds.delete(id); } }; },
      executeCommand: async (id, ...args) => { ran.push({ id, args, surface: glue.currentSurface() }); return cmds.has(id) ? cmds.get(id)(...args) : undefined; },
    },
  };
}
function make(over = {}) {
  const store = new Map(Object.entries(over.store || {}));
  const context = { subscriptions: [], globalState: { get: (k) => store.get(k), update: async (k, v) => store.set(k, v) } };
  const vscode = fakeVscode();
  const r = glue.createReach(Object.assign({ vscode, context, prefix: cfg.prefix, triesKey: cfg.triesKey, slot: cfg.slot, tools: cfg.tools, licensed: () => false, shown: () => true }, over.opts || {}));
  return { r, vscode, context, store };
}
const ids = cfg.tools.map((t) => t.id);

test('row: one link per Pro tool with "3 free tries" or "N tries left" from the tries store, then Get Zovo Pro', () => {
  assert.ok(cfg.tools.length > 0);
  const used = { [ids[0]]: 1 };
  if (ids[1]) used[ids[1]] = 3;
  const { r } = make({ store: { [cfg.triesKey]: used } });
  const html = r.rowHtml();
  assert.equal((html.match(/class="zovo-reach1-tool"/g) || []).length, cfg.tools.length);
  assert.match(html, /2 tries left/);
  if (ids[1]) assert.match(html, /0 tries left/);
  if (ids[2]) assert.match(html, /3 free tries/);
  assert.match(html, new RegExp(`command:${cfg.prefix.replace('.', '\\.')}\\.getPro\\?`));
  assert.match(html, />Get Zovo Pro</);
  for (const t of cfg.tools) assert.ok(html.includes(`command:${t.command}?${encodeURIComponent(JSON.stringify([{ surface: 'toolbar' }]))}`), t.command);
  assert.ok(r.commandIds().includes(`${cfg.prefix}.getPro`));
});

test('row: none when Pro is owned, when the Pro tools setting is off, or with no Pro tools', () => {
  assert.equal(make({ opts: { licensed: () => true } }).r.rowHtml(), '');
  assert.equal(make({ opts: { shown: () => false } }).r.rowHtml(), '');
  assert.equal(make({ opts: { tools: [] } }).r.rowHtml(), '');
});

test('row: hidden for the rest of the session after the close button, in every viewer', async () => {
  const { r } = make();
  const posted = [];
  const w1 = { postMessage: (m) => { posted.push(['w1', m]); return Promise.resolve(true); } };
  const w2 = { postMessage: (m) => { posted.push(['w2', m]); return Promise.resolve(true); } };
  r.attach(w1); r.attach(w2);
  assert.notEqual(r.rowHtml(), '');
  assert.equal(r.onMessage({ type: 'other' }), false);
  assert.equal(r.onMessage({ type: 'zovoReach1Closed' }), true);
  assert.equal(r.rowHtml(), '');
  assert.deepEqual(posted.map(([w, m]) => [w, m.type, m.html]), [['w1', 'zovoReach1', ''], ['w2', 'zovoReach1', '']]);
  // the browser side keeps it closed too (module isClosed / bindToolbarRow with session storage)
  const head = r.headHtml('N0nce');
  assert.ok(head.includes('bindToolbarRow(document, { session: ss, key: CLOSED_KEY })'));
});

test('surface tags: toolbar link and Explorer entry reach requirePro as toolbar and ctx', async () => {
  const { r, vscode } = make();
  let seen = null;
  const tool = r.wrap(async (...a) => { seen = { args: a, surface: glue.currentSurface(), detail: glue.withSurface('d') }; });
  await tool({ surface: 'toolbar' });
  assert.deepEqual(seen, { args: [], surface: 'toolbar', detail: { detail: 'd', surface: 'toolbar' } });
  const uri = { scheme: 'file', path: '/w/a.bin', fsPath: '/w/a.bin' };
  await tool(uri);
  assert.deepEqual(seen, { args: [uri], surface: '', detail: 'd' });
  assert.equal(glue.withSurface({ detail: 'x' }).surface, undefined);
  r.registerCtx();
  for (const t of cfg.tools) {
    vscode.cmds.set(t.command, r.wrap(async () => { seen = glue.withSurface({ detail: 'x' }); }));
    await vscode.cmds.get(`${cfg.prefix}.zovoPro.${t.id}`)(uri, [uri]);
    assert.equal(seen.surface, 'ctx', t.id);
    const call = vscode.ran.filter((c) => c.id === t.command).pop();
    assert.equal(call.args[0].path, t.folder ? '/w' : '/w/a.bin');
  }
  assert.equal(glue.currentSurface(), '');
});

test('webview head: nonce on style and script, the boot script parses, no early </script>', () => {
  const head = make().r.headHtml('N0nce');
  assert.match(head, /^<style nonce="N0nce">/);
  assert.match(head, /<script nonce="N0nce">/);
  const body = head.split('<script nonce="N0nce">')[1].replace(/<\/script>$/, '');
  assert.ok(!/<\/script/i.test(body));
  assert.doesNotThrow(() => new vm.Script(body));
  assert.ok(head.includes(JSON.stringify(cfg.slot)));
});

test('package.json: "Zovo Pro: <tool>" commands, hidden in the palette, in the Explorer menu for the file types', () => {
  const cmds = new Map((pkg.contributes.commands || []).map((c) => [c.command, c]));
  const ex = pkg.contributes.menus['explorer/context'] || [];
  const pal = pkg.contributes.menus.commandPalette || [];
  for (const t of cfg.tools) {
    if (t.rowOnly) { assert.ok(cmds.has(t.command), t.command); assert.ok(!ex.some((m) => m.command === `${cfg.prefix}.zovoPro.${t.id}`)); continue; } // row only
    const id = `${cfg.prefix}.zovoPro.${t.id}`;
    assert.ok(cmds.has(t.command), t.command);
    assert.equal(cmds.get(id) && cmds.get(id).title, `Zovo Pro: ${t.title}`);
    assert.ok(pal.some((m) => m.command === id && m.when === 'false'), `${id} hidden in palette`);
    const rows = ex.filter((m) => m.command === id);
    assert.ok(rows.length > 0, `${id} in explorer/context`);
    for (const m of rows) assert.match(m.when, t.folderMenu ? /^explorerResourceIsFolder\b/ : /^resourceExtname == \.[a-z0-9]+/);
  }
});
