'use strict';
// The bundled engine (dist/worker.js + dist/main.wasm, built by `npm test` first) against golden files made
// with the shfmt 3.14.1 command line tool, plus syntax errors, hostile input and the time limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Engine, SHFMT_VERSION } = require('../src/engine');
const { resolveOptions } = require('../src/options');
const { hasNul, byteColToChar } = require('../src/edits');

const root = path.join(__dirname, '..');
const fx = (f) => path.join(__dirname, 'fixtures', f);
const engine = new Engine({ workerPath: path.join(root, 'dist/worker.js'), wasmPath: path.join(root, 'dist/main.wasm'), timeoutMs: 20000 });
test.after(() => engine.dispose());

function opts(file, extra = {}, editor = {}) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const r = resolveOptions({ fileName: file, firstLine: text.split('\n', 1)[0], settings: extra, editor });
  return { text, r };
}

test('the shfmt version in the code matches the bundled sh-syntax package', () => {
  const log = fs.readFileSync(path.join(root, 'node_modules/sh-syntax/CHANGELOG.md'), 'utf8');
  const top = log.split('\n## ')[1];
  assert.match(top, new RegExp('mvdan.cc/sh/v3` to ' + SHFMT_VERSION.replace(/\./g, '\\.')));
  assert.equal(require('../package.json').dependencies['sh-syntax'], require('../node_modules/sh-syntax/package.json').version);
});

const GOLDEN = [
  ['arrays.sh', 'arrays.sh.golden'],
  ['case.sh', 'case.sh.golden'],
  ['heredoc-tabs.sh', 'heredoc-tabs.sh.golden'],
  ['crlf.sh', 'crlf.sh.golden'],
  ['posix.sh', 'posix.sh.golden'],
  ['sample.zsh', 'sample.zsh.golden'],
  ['sample.bats', 'sample.bats.golden'],
  ['docker-entrypoint.sh', 'docker-entrypoint.sh.golden'],
  ['unicode.sh', 'unicode.sh.golden'],
  ['arrays.sh', 'arrays.sh.golden.i2ci', { switchCaseIndent: true, binaryNextLine: true, spaceRedirects: true }, { insertSpaces: true, tabSize: 2 }],
  ['case.sh', 'case.sh.golden.i4ci', { switchCaseIndent: true, indent: 4 }],
  ['docker-entrypoint.sh', 'docker-entrypoint.sh.golden.i2fnkp', { functionNextLine: true, keepPadding: true, indent: 2 }],
];

for (const [src, gold, settings, editor] of GOLDEN) {
  test(`${src} -> ${gold} is byte for byte the shfmt CLI output, and passes the same-commands check`, async () => {
    const { text, r } = opts(fx(src), settings, editor);
    assert.ok(!r.skip, r.skip);
    const res = await engine.format(text, r.opts, src, true);
    assert.equal(res.ok, true, res.message);
    assert.equal(res.text, fs.readFileSync(fx(gold), 'utf8'));
    if (res.text !== text) assert.equal(res.verified, true);
  });
}

test('the walkthrough sample formats to the golden file', async () => {
  const { text, r } = opts(path.join(root, 'samples/messy-deploy.sh'));
  const res = await engine.format(text, r.opts, 'messy-deploy.sh', true);
  assert.equal(res.text, fs.readFileSync(fx('messy-deploy.sh.golden'), 'utf8'));
});

test('formatting a formatted file changes nothing (and missing options mean shfmt defaults)', async () => {
  const gold = fs.readFileSync(fx('docker-entrypoint.sh.golden'), 'utf8');
  const res = await engine.format(gold, { variant: 1, indent: 0 }, 'x.sh', true);
  assert.equal(res.text, gold);
});

test('an unclosed here-document is a syntax error with a line, and no text', async () => {
  const { text, r } = opts(fx('error-heredoc.sh'));
  const res = await engine.format(text, r.opts, 'error-heredoc.sh', true);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'syntax');
  assert.match(res.message, /here-document/);
  assert.equal(res.line, 3);
  assert.equal(res.text, undefined);
});

test('a syntax error after non-ASCII text points at the right character', async () => {
  const { text, r } = opts(fx('error-quote-unicode.sh'));
  const res = await engine.format(text, r.opts, 'q.sh', true);
  assert.equal(res.kind, 'syntax');
  const line = text.split('\n')[res.line - 1];
  assert.equal(line[byteColToChar(line, res.column)], '"');
});

test('POSIX mode refuses bash arrays with a clear message', async () => {
  const res = await engine.format('#!/bin/sh\na=(1 2)\n', { variant: 2, indent: 0 }, 'p.sh', true);
  assert.equal(res.kind, 'syntax');
  assert.match(res.message, /arrays are a bash/);
});

test('a fish script is skipped, not reported as an error', () => {
  const { r } = opts(fx('not-shell.fish'));
  assert.match(r.skip, /fish/);
});

function bigScript(bytes) {
  let s = '#!/bin/bash\nset -e\n';
  let i = 0;
  while (s.length < bytes) {
    s += `f${i}(){\nif [ "$1" = "x${i}" ];then\n  for a in 1 2 3;do echo "$a" | grep -q x>/dev/null||true;done\nfi\ncase $1 in\n a) echo a;;\n *) echo b;;\nesac\n}\n`;
    i++;
  }
  return s;
}

test('a 2 MB script formats in under 2 seconds', async () => {
  const text = bigScript(2 * 1024 * 1024);
  const t = Date.now();
  const res = await engine.format(text, { variant: 1, indent: 0 }, 'big.sh', false);
  const ms = Date.now() - t;
  assert.equal(res.ok, true);
  assert.ok(ms < 2000, `${ms} ms`);
  assert.ok(res.text.length > text.length / 2);
  engine.reset();
});

test('hostile: 5,000 nested subshells end in an engine error, and the next file still formats', async () => {
  const text = '('.repeat(5000) + 'true' + ')'.repeat(5000) + '\n';
  const res = await engine.format(text, { variant: 1, indent: 0 }, 'nest.sh', true);
  assert.equal(res.ok, false);
  const after = await engine.format('echo   ok\n', { variant: 1, indent: 0 }, 'ok.sh', true);
  assert.equal(after.text, 'echo ok\n');
});

test('hostile: a 1 MB single line formats', async () => {
  const text = 'echo ' + 'a'.repeat(1024 * 1024) + '\n';
  const res = await engine.format(text, { variant: 1, indent: 0 }, 'line.sh', false);
  assert.equal(res.ok, true);
  assert.equal(res.text, text);
});

test('hostile: binary bytes with NUL are detected before the engine', () => {
  const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)).toString('latin1');
  assert.equal(hasNul(bin), true);
  assert.equal(hasNul('echo hi\n'), false);
});

test('the time limit stops a slow request and the engine recovers', async () => {
  const slow = new Engine({ workerPath: path.join(root, 'dist/worker.js'), wasmPath: path.join(root, 'dist/main.wasm') });
  try {
    const res = await slow.format(bigScript(2 * 1024 * 1024), { variant: 1, indent: 0 }, 'big.sh', true, 5);
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'timeout');
    assert.match(res.message, /unchanged/);
    const ok = await slow.format('if true;then echo;fi\n', { variant: 1, indent: 0 }, 'ok.sh', true);
    assert.equal(ok.text, 'if true; then echo; fi\n');
  } finally {
    slow.dispose();
  }
});

test('an unsupported dialect number is an engine error, not a crash', async () => {
  const res = await engine.format('x=1\n', { variant: 99 }, 'v.sh', true);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'engine');
});

test('very deep nesting gives a plain message, no text, and the engine still works after it', async () => {
  const deep = '#!/bin/sh\n' + '('.repeat(5000) + 'echo deep' + ')'.repeat(5000) + '\n';
  const r = resolveOptions({ fileName: 'deep.sh', firstLine: '#!/bin/sh', settings: {}, editor: {} });
  const res = await engine.format(deep, r.opts, 'deep.sh', true);
  assert.equal(res.ok, false);
  assert.equal(res.text, undefined);
  if (res.kind === 'engine') assert.match(res.message, /nested too deeply/);
  assert.doesNotMatch(res.message, /memory access out of bounds/);
  const after = await engine.format('echo   hi\n', r.opts, 'after.sh', true);
  assert.equal(after.ok, true);
  assert.equal(after.text, 'echo hi\n');
});
