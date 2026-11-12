'use strict';
// Unified diff for the Zovo Pro formatting check: the patch must apply with patch(1) and git apply and give the
// formatted text byte for byte (fixtures against their shfmt goldens, end-of-file newline cases, an empty file).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { unifiedDiff, diffStat, diffLines } = require('../src/patch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shfmt-patch-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').replace(/\r\n/g, '\n');

function applies(before, after, name = 'dir/script.sh') {
  const patch = unifiedDiff(before, after, name);
  for (const tool of ['patch', 'git']) {
    const d = fs.mkdtempSync(path.join(tmp, tool + '-'));
    fs.mkdirSync(path.join(d, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), before);
    fs.writeFileSync(path.join(d, 'x.patch'), '# a comment line before the diff, as the check writes it\n' + patch);
    if (tool === 'patch') execFileSync('patch', ['-p1', '-s', '-f', '-N', '-i', 'x.patch'], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    else execFileSync('git', ['apply', '--unsafe-paths', 'x.patch'], { cwd: d, env: { ...process.env, GIT_DIR: path.join(d, '.nogit') } });
    assert.equal(fs.readFileSync(path.join(d, name), 'utf8'), after, `${tool} gives the formatted text`);
  }
  return patch;
}

test('equal texts give no patch', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'x.sh'), '');
});

test('fixtures against their shfmt goldens: the patch applies with patch -p1 and git apply', () => {
  for (const f of ['arrays.sh', 'case.sh', 'docker-entrypoint.sh', 'heredoc-tabs.sh', 'posix.sh', 'unicode.sh', 'sample.zsh']) {
    const before = fx(f);
    const after = fx(f + '.golden');
    if (before === after) continue;
    const p = applies(before, after, 'scripts/' + f);
    assert.match(p, new RegExp(`^--- a/scripts/${f.replace('.', '\\.')}\\n\\+\\+\\+ b/scripts/`));
    assert.match(p, /\n@@ -\d+,\d+ \+\d+,\d+ @@\n/);
  }
});

test('missing newline at the end of the file, on either side, and an empty file', () => {
  applies('echo a\nif true;then\necho b\nfi', 'echo a\nif true; then\n\techo b\nfi\n');
  applies('a\nb\nc', 'a\nb\nc\n');
  applies('a\nb\nc\n', 'a\nb\nc');
  applies('', 'echo hi\n');
  applies('echo hi\n', '');
  const p = unifiedDiff('x\ny', 'x\ny\n', 'f.sh');
  assert.match(p, /-y\n\\ No newline at end of file\n\+y\n/);
});

test('far apart changes make separate hunks with 3 lines of context; stat counts lines', () => {
  const a = Array.from({ length: 40 }, (_, i) => `echo ${i}`).join('\n') + '\n';
  const b = a.replace('echo 2\n', 'echo  2\n').replace('echo 30\n', 'echo 30\necho 30b\n');
  const p = applies(a, b);
  assert.equal((p.match(/^@@ /gm) || []).length, 2);
  assert.deepEqual(diffStat(p), { add: 2, del: 1 });
});

test('a large rewrite stays a valid patch (edit limit)', () => {
  const a = Array.from({ length: 6000 }, (_, i) => `echo a${i}`).join('\n') + '\n';
  const b = Array.from({ length: 6000 }, (_, i) => `echo b${i}`).join('\n') + '\n';
  const t = Date.now();
  applies(a, b, 'big.sh');
  assert.ok(Date.now() - t < 10000);
  assert.equal(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']).map((o) => o.op).join(''), ' -+ ');
});
