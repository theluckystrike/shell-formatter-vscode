'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/edits');

test('lineDiff + applyLineDiff rebuild the new text exactly (random texts)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const R = () => Array.from({ length: Math.floor(rnd() * 6) }, () => ['a', 'b', '', '\tc d'][Math.floor(rnd() * 4)]).join('\n') + (rnd() < 0.5 ? '\n' : '');
  for (let i = 0; i < 20000; i++) {
    const a = R();
    const b = R();
    assert.equal(E.applyLineDiff(a, E.lineDiff(a, b)), b, JSON.stringify([a, b]));
  }
});

test('lineDiff keeps unchanged lines out of the edit', () => {
  const d = E.lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\n');
  assert.deepEqual(d, { startLine: 1, endLine: 2, endChar: 0, text: 'B\n' });
  assert.equal(E.lineDiff('x\n', 'x\n'), null);
});

test('byte columns from shfmt map to UTF-16 characters', () => {
  assert.equal(E.byteColToChar('echo ünï "x', 12), 10);
  assert.equal(E.byteColToChar('a🚀b', 5), 3);
  assert.equal(E.byteColToChar('abc', 99), 3);
});

test('selections: common indent removed and restored, here-documents need column 1', () => {
  const d = E.dedentSelection('    if x; then\n        y\n    fi');
  assert.equal(d.prefix, '    ');
  assert.equal(d.text, 'if x; then\n    y\nfi');
  assert.equal(E.indentBack('if x; then\n\ty\nfi\n', '    '), '    if x; then\n    \ty\n    fi\n');
  assert.ok(E.dedentSelection('  cat <<EOF\n  x\nEOF').refuse);
  assert.equal(E.dedentSelection('cat <<EOF\nx\nEOF').prefix, '');
});

test('sizes', () => {
  assert.equal(E.fmtSize(512), '512 B');
  assert.equal(E.fmtSize(12 * 1024 * 1024), '12.0 MB');
});

test('guessIndent: tabs, 2 or 4 spaces from the file, defaults when nothing is indented', () => {
  const { guessIndent } = require('../src/edits');
  const d = { insertSpaces: true, tabSize: 4 };
  assert.deepEqual(guessIndent('if x; then\n\techo\nfi\n', d), { insertSpaces: false, tabSize: 4 });
  assert.deepEqual(guessIndent('if x; then\n  echo\n  if y; then\n    z\n  fi\nfi\n', d), { insertSpaces: true, tabSize: 2 });
  assert.deepEqual(guessIndent('f() {\n    a\n    b\n}\n', d), { insertSpaces: true, tabSize: 4 });
  assert.deepEqual(guessIndent('echo a\necho b\n', { insertSpaces: false, tabSize: 8 }), { insertSpaces: false, tabSize: 8 });
});
