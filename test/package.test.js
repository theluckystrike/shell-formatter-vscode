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

test('every word of each target phrase is in the display name, and the name is our own', () => {
  const name = pk.displayName.toLowerCase();
  for (const phrase of ['shell format', 'shell formatter', 'bash formatter', 'shfmt']) {
    for (const w of phrase.split(' ')) assert.ok(new RegExp(`\\b${w}\\b`).test(name), `${w} missing`);
  }
  assert.ok(!/^shell[- ]format\b/.test(name), 'must not start like another listing name');
});

test('each shellFormatter.* setting read in the code is declared', () => {
  const declared = new Set(Object.keys(pk.contributes.configuration.properties).map((k) => k.replace('shellFormatter.', '')));
  for (const m of src.matchAll(/c\.get\('(\w+)'/g)) assert.ok(declared.has(m[1]), m[1]);
});

test('each command in package.json is registered, and walkthrough command links exist', () => {
  const registered = new Set([...src.matchAll(/registerCommand\(`\$\{SECTION\}\.(\w+)`/g)].map((m) => 'shellFormatter.' + m[1]));
  registered.add('shellFormatter.supportDeveloper');
  registered.add('shellFormatter.moreViewers');
  for (const c of pk.contributes.commands) assert.ok(registered.has(c.command), c.command);
  for (const step of pk.contributes.walkthroughs[0].steps) {
    for (const m of step.description.matchAll(/command:(shellFormatter\.\w+)/g)) assert.ok(registered.has(m[1]), m[1]);
    const media = step.media.image || step.media.markdown;
    assert.ok(fs.existsSync(path.join(root, media)), media);
  }
});

test('no network code in the shipped sources', () => {
  for (const f of ['extension.js', 'engine.js', 'worker.js', 'options.js', 'edits.js', 'verify.js']) {
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
