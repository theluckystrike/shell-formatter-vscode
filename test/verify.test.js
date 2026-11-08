'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getProcessorSync } = require('sh-syntax');
const { normalizeAst } = require('../src/verify');

const p = getProcessorSync(fs.readFileSync(require.resolve('sh-syntax/main.wasm')));
const same = (a, b, variant = 1) => normalizeAst(p(a, { variant })) === normalizeAst(p(b, { variant }));

test('layout changes keep the same commands', () => {
  assert.ok(same('if true;then\necho  hi;fi\n', 'if true; then\n\techo hi\nfi\n'));
  assert.ok(same('echo `date`\n', 'echo $(date)\n'));
  assert.ok(same('for ((i=0;i<3;i++)) {\n echo $i\n}\n', 'for ((i = 0; i < 3; i++)); do\n\techo $i\ndone\n'));
  assert.ok(same('f() {\n\tcat <<-EOF\n\t\t\tx\n\tEOF\n}\n', 'f() {\n\tcat <<-EOF\n\t\tx\n\tEOF\n}\n'));
  assert.ok(same('a=1 # note\nb=2\n', 'a=1   # note\nb=2\n'));
});

test('a changed command, word, quote or here-document body is caught', () => {
  assert.ok(!same('echo a\n', 'echo b\n'));
  assert.ok(!same('echo "$x"\n', 'echo $x\n'));
  assert.ok(!same('rm -rf "$dir"/\n', 'rm -rf "$dir" /\n'));
  assert.ok(!same('cat <<EOF\n  x\nEOF\n', 'cat <<EOF\nx\nEOF\n'));
  assert.ok(!same('a && b\n', 'a || b\n'));
  assert.ok(!same('# keep\necho\n', '# changed\necho\n'));
});

test('every golden file has the same commands as its source', () => {
  const dir = path.join(__dirname, 'fixtures');
  for (const f of fs.readdirSync(dir).filter((x) => /\.golden$/.test(x) && fs.existsSync(path.join(dir, x.replace(/\.golden$/, ''))))) {
    const src = fs.readFileSync(path.join(dir, f.replace(/\.golden$/, '')), 'utf8').replace(/\r\n/g, '\n');
    const out = fs.readFileSync(path.join(dir, f), 'utf8');
    const v = /\.zsh/.test(f) ? 16 : /\.bats/.test(f) ? 8 : /posix|crlf/.test(f) ? 2 : 1;
    assert.ok(same(src, out, v), f);
  }
});
