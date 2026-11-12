'use strict';
// Zovo Pro tools of Shell Formatter with a stub vscode and the real shfmt worker (dist/, built by npm test):
// Format all scripts in a folder, Formatting check with a patch file, Minify a script to a copy. Tries count only
// after a result, the 4th use opens the Pro panel, nothing about Pro happens at activation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadExtension } = require('./support/vscode-stub');
const { isShellShebang, minName } = require('../src/protools');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shfmt-pro-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const MESSY = '#!/bin/bash\n# deploy\nif [ -n "$1" ];then\necho   "hi $1"\nfi\n';
function tree() {
  const root = fs.mkdtempSync(path.join(dir, 'proj-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'scripts', 'deploy.sh'), MESSY);
  fs.writeFileSync(path.join(root, 'scripts', 'ok.sh'), 'echo ok\n');
  fs.writeFileSync(path.join(root, 'scripts', 'tabs.sh'), 'if true; then\n\techo tab\nfi\n');
  fs.writeFileSync(path.join(root, 'run'), '#!/usr/bin/env bash\nfor x in a b;do echo $x;done\n');
  fs.writeFileSync(path.join(root, 'notes'), 'just text, no shebang\n');
  fs.writeFileSync(path.join(root, 'tool.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'broken.sh'), 'cat <<EOF\nno end\n');
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.sh'), 'if true;then echo;fi\n');
  return root;
}
const trial = (s, f) => (s.state.get('shellFormatter.proTrial') || {})[f];

test('helpers: shebang detection and the minified file name', () => {
  for (const l of ['#!/bin/sh', '#!/bin/bash -e', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash -eu', '#!/bin/zsh', '#!/bin/ksh']) assert.ok(isShellShebang(l), l);
  for (const l of ['#!/usr/bin/env python3', '#!/usr/bin/fish', 'echo hi', '']) assert.ok(!isShellShebang(l), l);
  assert.equal(minName('deploy.sh'), 'deploy.min.sh');
  assert.equal(minName('a.b.bash'), 'a.b.min.bash');
  assert.equal(minName('run'), 'run.min');
});

test('activation shows nothing and registers the Pro commands and the Explorer wrappers', () => {
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    for (const c of ['formatFolder', 'checkFolder', 'minifyCopy', 'zovoPro.folder', 'zovoPro.check', 'zovoPro.minify', 'getPro', 'payByCard']) assert.ok(s.commands.has('shellFormatter.' + c), c);
    assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length + s.log.modals.length + s.log.quickPicks.length + s.log.picks.length, 0);
  } finally { s.ext.deactivate(); s.restore(); }
});

test('Format all scripts in a folder: Escape uses no try, report changes nothing, apply formats and saves', async () => {
  const root = tree();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const run = () => s.commands.get('shellFormatter.formatFolder')(s.vscode.Uri.file(root));
    s.ui.pick.push(undefined);
    await run();
    assert.equal(trial(s, 'folder'), undefined, 'Escape at the choice uses no try');
    assert.deepEqual(s.log.picks.at(-1), ['Format 2 scripts', 'Show the report only']);
    s.ui.pick.push('Show the report only');
    await run();
    assert.equal(trial(s, 'folder'), 1);
    const rep = s.log.untitled.at(-1).getText();
    assert.match(rep, /^# Shell formatting report: proj-/);
    assert.match(rep, /\| scripts\/deploy\.sh \| changes \| bash \| /);
    assert.match(rep, /\| run \| changes \| bash \| /);
    assert.match(rep, /\| scripts\/ok\.sh \| formatted already \| /);
    assert.match(rep, /\| scripts\/tabs\.sh \| formatted already \| /, 'a tab-indented script keeps its tabs (detected indentation)');
    assert.match(rep, /\| broken\.sh \| not formatted \| /);
    assert.ok(!/skip\.sh|notes|tool\.py/.test(rep), 'node_modules, plain text and other languages are not checked');
    assert.equal(fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf8'), MESSY);
    s.ui.pick.push('Format 2 scripts');
    await run();
    assert.equal(trial(s, 'folder'), 2);
    assert.equal(fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf8'), '#!/bin/bash\n# deploy\nif [ -n "$1" ]; then\n    echo "hi $1"\nfi\n');
    assert.equal(fs.readFileSync(path.join(root, 'run'), 'utf8'), '#!/usr/bin/env bash\nfor x in a b; do echo $x; done\n');
    assert.match(s.log.info.at(-1), /^Formatted 2 shell scripts\.$/);
    // all formatted now except the broken one: the report still lists it; with only formatted scripts there is no try
    const clean = fs.mkdtempSync(path.join(dir, 'clean-'));
    fs.writeFileSync(path.join(clean, 'a.sh'), 'echo a\n');
    await s.commands.get('shellFormatter.formatFolder')(s.vscode.Uri.file(clean));
    assert.match(s.log.info.at(-1), /are formatted already\. No free try was used\.$/);
    assert.equal(trial(s, 'folder'), 2);
  } finally { s.ext.deactivate(); s.restore(); }
});

test('Formatting check: one patch for every change, nothing changed on disk, and git apply makes the folder formatted', async () => {
  const root = tree();
  fs.rmSync(path.join(root, 'broken.sh'));
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    await s.commands.get('shellFormatter.checkFolder')(s.vscode.Uri.file(root));
    assert.equal(trial(s, 'check'), 1);
    const doc = s.log.untitled.at(-1);
    assert.equal(doc.languageId, 'diff');
    const patch = doc.getText();
    assert.match(patch, /^# Shell formatting check: proj-/);
    assert.match(patch, /#   scripts\/deploy\.sh\n/);
    assert.match(patch, /# The same check in CI: shfmt -d -i=4 \./);
    assert.match(patch, /\n--- a\/run\n\+\+\+ b\/run\n/);
    assert.equal(fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf8'), MESSY, 'the check changes nothing');
    fs.writeFileSync(path.join(root, 'fmt.patch'), patch);
    execFileSync('patch', ['-p1', '-s', '-f', '-N', '-i', 'fmt.patch'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    fs.rmSync(path.join(root, 'fmt.patch'));
    await s.commands.get('shellFormatter.checkFolder')(s.vscode.Uri.file(root));
    assert.match(s.log.info.at(-1), /are formatted\. No patch needed, no free try was used\.$/);
    assert.equal(trial(s, 'check'), 1);
  } finally { s.ext.deactivate(); s.restore(); }
});

test('Minify to a copy: writes name.min.sh with the #! line, original unchanged; an error writes nothing and uses no try', async () => {
  const root = tree();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const src = path.join(root, 'scripts', 'deploy.sh');
    await s.commands.get('shellFormatter.zovoPro.minify')(s.vscode.Uri.file(src));
    const out = fs.readFileSync(path.join(root, 'scripts', 'deploy.min.sh'), 'utf8');
    assert.equal(out, '#!/bin/bash\nif [ -n "$1" ];then\necho "hi $1"\nfi\n');
    assert.equal(fs.readFileSync(src, 'utf8'), MESSY);
    assert.equal(trial(s, 'minify'), 1);
    assert.match(s.log.status.at(-1), /deploy\.min\.sh: .* same commands \(checked\)\. deploy\.sh is unchanged\./);
    await s.commands.get('shellFormatter.minifyCopy')(s.vscode.Uri.file(path.join(root, 'broken.sh')));
    assert.match(s.log.warn.at(-1).m, /^Minify: .*No copy was written and no free try was used\.$/);
    assert.ok(!fs.existsSync(path.join(root, 'broken.min.sh')));
    assert.equal(trial(s, 'minify'), 1);
    // replacing an existing copy asks first; Escape keeps it and uses no try
    s.ui.warn.push(undefined);
    await s.commands.get('shellFormatter.minifyCopy')(s.vscode.Uri.file(src));
    assert.equal(trial(s, 'minify'), 1);
  } finally { s.ext.deactivate(); s.restore(); }
});

test('3 free tries per tool, then the Pro panel instead of the tool (no file written)', async () => {
  const root = tree();
  const s = loadExtension();
  try {
    s.ext.activate(s.context);
    const src = path.join(root, 'scripts', 'deploy.sh');
    for (let i = 0; i < 3; i++) {
      fs.rmSync(path.join(root, 'scripts', 'deploy.min.sh'), { force: true });
      await s.commands.get('shellFormatter.minifyCopy')(s.vscode.Uri.file(src));
    }
    assert.equal(trial(s, 'minify'), 3);
    fs.rmSync(path.join(root, 'scripts', 'deploy.min.sh'));
    const modals = s.log.modals.length + s.log.quickPicks.length;
    await s.commands.get('shellFormatter.zovoPro.minify')(s.vscode.Uri.file(src));
    assert.ok(s.log.modals.length + s.log.quickPicks.length > modals, 'the Pro panel opened');
    assert.ok(!fs.existsSync(path.join(root, 'scripts', 'deploy.min.sh')), 'no 4th copy without Pro');
    assert.equal(trial(s, 'minify'), 3);
  } finally { s.ext.deactivate(); s.restore(); }
});

test('from the palette: the open workspace folder is offered first, Escape does nothing', async () => {
  const root = tree();
  const s = loadExtension();
  try {
    s.vscode.workspace.workspaceFolders = [{ name: 'proj', uri: s.vscode.Uri.file(root) }];
    s.ext.activate(s.context);
    s.ui.pick.push(undefined);
    await s.commands.get('shellFormatter.checkFolder')();
    assert.deepEqual(s.log.picks.at(-1), ['$(folder) proj', '$(folder-opened) Choose another folder...']);
    assert.equal(trial(s, 'check'), undefined);
    s.ui.pick.push('$(folder) proj');
    await s.commands.get('shellFormatter.checkFolder')();
    assert.equal(trial(s, 'check'), 1);
    assert.match(s.log.untitled.at(-1).getText(), /\n--- a\/scripts\/deploy\.sh\n/);
  } finally { s.ext.deactivate(); s.restore(); }
});
