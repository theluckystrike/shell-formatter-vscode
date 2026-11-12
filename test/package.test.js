'use strict';
// Listing and wiring checks: engine floor, phrase words in the name, settings and commands that the code uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pk = require('../package.json');
const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');

test('engine floor ^1.90.0 and @types/vscode ~1.90.0 (OVX1)', () => {
  assert.equal(pk.engines.vscode, '^1.90.0');
  assert.equal(pk.devDependencies['@types/vscode'], '~1.90.0');
});

test('display name: 30 characters or less, the search phrase whole and first, and the name is our own', () => {
  const name = pk.displayName.toLowerCase();
  assert.ok(pk.displayName.length <= 30, pk.displayName);
  assert.ok(name.startsWith('shell formatter '), 'phrase first');
  assert.ok(/\bbash\b/.test(name) && /\bzsh\b/.test(name));
  assert.ok(!['shell formatter', 'shell-format', 'shell format'].includes(name), 'not the whole name of another listing');
  assert.ok(pk.description.toLowerCase().startsWith('shell formatter'));
  assert.deepEqual(pk.keywords, ['shell formatter', 'bash formatter', 'shfmt', 'shell format', 'format on save']);
});

test('each shellFormatter.* setting read in the code is declared', () => {
  const declared = new Set(Object.keys(pk.contributes.configuration.properties).map((k) => k.replace('shellFormatter.', '')));
  for (const m of src.matchAll(/c\.get\('(\w+)'/g)) assert.ok(declared.has(m[1]), m[1]);
});

test('each command in package.json is registered, and walkthrough command links exist', () => {
  const registered = new Set([...src.matchAll(/registerCommand\(`\$\{SECTION\}\.(\w+)`/g)].map((m) => 'shellFormatter.' + m[1]));
  registered.add('shellFormatter.supportDeveloper');
  registered.add('shellFormatter.moreViewers');
  // Zovo Pro: the license module registers its palette commands, src/reach.js the "Zovo Pro: <tool>" Explorer wrappers
  for (const c of ['getPro', 'payWithPayPal', 'unlockWithSponsors', 'enterLicenseKey', 'removeLicense', 'payByCard']) registered.add('shellFormatter.' + c);
  for (const t of require('../src/reach-config').tools) registered.add(`shellFormatter.zovoPro.${t.id}`);
  for (const c of pk.contributes.commands) assert.ok(registered.has(c.command), c.command);
  for (const step of pk.contributes.walkthroughs[0].steps) {
    for (const m of step.description.matchAll(/command:(shellFormatter\.\w+)/g)) assert.ok(registered.has(m[1]), m[1]);
    const media = step.media.image || step.media.markdown;
    assert.ok(fs.existsSync(path.join(root, media)), media);
  }
});

test('no network code in the shipped sources', () => {
  for (const f of ['extension.js', 'engine.js', 'worker.js', 'options.js', 'edits.js', 'verify.js', 'pro.js', 'protools.js', 'patch.js', 'reach.js']) {
    const t = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.ok(!/\b(fetch\(|https?\.request|http\.get|XMLHttpRequest|WebSocket|net\.connect)/.test(t), f);
  }
});

test('Dockerfile and .env are never formatted', () => {
  assert.ok(!JSON.stringify(pk.activationEvents).includes('dockerfile'));
  assert.deepEqual(pk.contributes.configuration.properties['shellFormatter.skipFiles'].default, ['.env', '.env.*', '*.env']);
  assert.ok(!/dockerfile|dotenv/i.test(src.match(/const SELECTOR = .*$/m)[0]));
});

test('.bats files open as shell scripts', () => {
  assert.ok(pk.contributes.languages.some((l) => l.id === 'shellscript' && l.extensions.includes('.bats')));
});
