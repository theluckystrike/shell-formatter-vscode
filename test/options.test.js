'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/options');

test('dialect from the shebang first, then the file name, else bash', () => {
  const d = (name, first, setting = 'auto') => O.detectDialect(name, first, setting);
  assert.equal(d('x.sh', '#!/bin/bash').dialect, 'bash');
  assert.equal(d('x.sh', '#!/bin/sh').dialect, 'posix');
  assert.equal(d('x', '#!/usr/bin/env dash').dialect, 'posix');
  assert.equal(d('x', '#!/usr/bin/env -S bash -e').dialect, 'bash');
  assert.equal(d('x', '#!/usr/bin/env zsh').dialect, 'zsh');
  assert.equal(d('x', '#!/bin/ksh').dialect, 'mksh');
  assert.equal(d('x', '#!/usr/bin/env bats').dialect, 'bats');
  assert.equal(d('x.bats', '').dialect, 'bats');
  assert.equal(d('/home/u/.zshrc', '').dialect, 'zsh');
  assert.equal(d('/home/u/.bashrc', '').dialect, 'bash');
  assert.equal(d('PKGBUILD', '').dialect, 'bash');
  assert.equal(d('lib.sh', '').dialect, 'bash');
  assert.equal(d('x.sh', '#!/bin/sh', 'bash').dialect, 'bash');
});

test('non-POSIX shells and other interpreters are skipped', () => {
  assert.ok(O.detectDialect('x.fish', '').skip);
  assert.ok(O.detectDialect('x', '#!/usr/bin/env fish').skip);
  assert.ok(O.detectDialect('x.csh', '').skip);
  assert.ok(O.detectDialect('x', '#!/bin/tcsh').skip);
  assert.ok(O.detectDialect('x.sh', '#!/usr/bin/env python3').skip);
  assert.ok(O.detectDialect('x.sh', '#!/bin/toString').skip, 'object keys are not shells');
  assert.equal(O.shebangInterpreter('#!/usr/bin/env -S bash -e'), 'bash');
  assert.equal(O.shebangInterpreter('#!/usr/bin/env FOO=1 bash'), 'bash');
});

test('EditorConfig parsing and globs', () => {
  const ec = O.parseEditorConfig('root = true\n\n[*]\nindent_style = space\n[*.{sh,bash}]\nindent_size = 4 # four\n[Makefile]\nindent_style = tab\n');
  assert.equal(ec.root, true);
  assert.equal(ec.sections.length, 3);
  assert.equal(ec.sections[1].props.indent_size, '4');
  assert.ok(O.globMatches('*.{sh,bash}', 'scripts/a.bash'));
  assert.ok(!O.globMatches('*.{sh,bash}', 'a.zsh'));
  assert.ok(O.globMatches('scripts/**.sh', 'scripts/x/y.sh'));
  assert.ok(!O.globMatches('/scripts/*.sh', 'other/scripts/a.sh'));
  assert.ok(O.globMatches('file{1..3}.sh', 'file2.sh'));
  assert.ok(O.globMatches('[ab].sh', 'a.sh'));
  assert.ok(!O.globMatches('[!ab].sh', 'a.sh'));
});

test('EditorConfig: nearer files win, root stops the walk, [[shell]] and [[bash]] sections apply', () => {
  const files = [
    { dir: '/p/sub', text: '[*.sh]\nindent_size = 3\nindent_style = space\n[[bash]]\nswitch_case_indent = true\n' },
    { dir: '/p', text: 'root = true\n[*]\nindent_style = tab\nbinary_next_line = true\n' },
    { dir: '/', text: '[*]\nspace_redirects = true\n' },
  ];
  const p = O.editorConfigProps(files, '/p/sub/a.sh', 'bash');
  assert.equal(p.indent_size, '3');
  assert.equal(p.indent_style, 'space');
  assert.equal(p.switch_case_indent, 'true');
  assert.equal(p.binary_next_line, 'true');
  assert.equal(p.space_redirects, undefined);
  const z = O.editorConfigProps(files, '/p/sub/a.sh', 'posix');
  assert.equal(z.switch_case_indent, undefined);
});

test('option order: .editorconfig, then settings, then the editor', () => {
  const base = { fileName: 'a.sh', firstLine: '#!/bin/bash' };
  assert.equal(O.resolveOptions({ ...base, editor: { insertSpaces: false, tabSize: 4 } }).opts.indent, 0);
  assert.equal(O.resolveOptions({ ...base, editor: { insertSpaces: true, tabSize: 4 } }).opts.indent, 4);
  assert.equal(O.resolveOptions({ ...base, settings: { indent: 2 }, editor: { insertSpaces: true, tabSize: 4 } }).opts.indent, 2);
  const ec = { indent_style: 'space', indent_size: '3', switch_case_indent: 'true', shell_variant: 'posix' };
  const r = O.resolveOptions({ ...base, settings: { indent: 2, switchCaseIndent: false }, ec });
  assert.equal(r.opts.indent, 3);
  assert.equal(r.opts.switchCaseIndent, true);
  assert.equal(r.dialect, 'posix');
  assert.equal(r.indentFrom, '.editorconfig');
  const off = O.resolveOptions({ ...base, settings: { indent: 2, useEditorConfig: false }, ec });
  assert.equal(off.opts.indent, 2);
  assert.equal(off.dialect, 'bash');
  assert.equal(O.resolveOptions({ ...base, ec: { indent_size: '4' } }).opts.indent, 0, 'indent_size alone keeps tabs, like shfmt');
  assert.ok(O.resolveOptions({ ...base, ec: { ignore: 'true' } }).skip);
});

test('shfmt defaults (not the sh-syntax library defaults) when nothing is set', () => {
  const r = O.resolveOptions({ fileName: 'a.sh', firstLine: '' });
  assert.deepEqual(
    [r.opts.binaryNextLine, r.opts.switchCaseIndent, r.opts.spaceRedirects, r.opts.keepPadding, r.opts.functionNextLine, r.opts.simplify, r.opts.minify],
    [false, false, false, false, false, false, false]);
  assert.equal(r.opts.indent, 0);
});

test('shfmt flags for the copied CI command', () => {
  const r = O.resolveOptions({ fileName: 'a.sh', firstLine: '#!/bin/sh', settings: { indent: 2, switchCaseIndent: true, simplify: true } });
  assert.deepEqual(O.shfmtFlags(r.dialect, r.opts), ['-ln=posix', '-i=2', '-ci', '-s']);
});
