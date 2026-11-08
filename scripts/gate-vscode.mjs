// Release gate in a real VS Code: installs the .vsix into a private extensions folder, builds the gate file set
// (real scripts, test fixtures, a 2 MB script, a 12 MB script and hostile files), computes the expected output
// with the shfmt command line tool, then runs scripts/gate/runner.js inside VS Code and prints a summary.
//
//   node scripts/gate-vscode.mjs --vsix dist/x.vsix --work ~/shell-formatter-work/gate --real ~/shell-formatter-work/real \
//        --shfmt ~/shell-formatter-work/bin/shfmt [--code "/Applications/Visual Studio Code.app/Contents/MacOS/Code"]
//
// Large and hostile files are written under --work (not the temp folder) and deleted at the end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveOptions, shfmtFlags } = require('../src/options.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const real = arg('real') ? path.resolve(arg('real')) : '';
const SHFMT = arg('shfmt');
const CODE = arg('code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code');
const CLI = path.join(path.dirname(path.dirname(CODE)), 'Resources/app/bin/code');
const keep = process.argv.includes('--keep');

fs.rmSync(work, { recursive: true, force: true });
const files = path.join(work, 'files');
fs.mkdirSync(files, { recursive: true });

// ---- gate files ----
const copy = (from, name) => { const to = path.join(files, name || path.basename(from)); fs.copyFileSync(from, to); return to; };
const list = [];
if (real) for (const f of fs.readdirSync(real).sort()) list.push(copy(path.join(real, f)));
for (const f of fs.readdirSync(path.join(root, 'test/fixtures')).filter((x) => !x.includes('.golden')).sort()) list.push(copy(path.join(root, 'test/fixtures', f)));
list.push(copy(path.join(root, 'samples/messy-deploy.sh')));

function bigScript(bytes) {
  const parts = ['#!/bin/bash\nset -e\n'];
  let n = parts[0].length;
  for (let i = 0; n < bytes; i++) {
    const s = `f${i}(){\nif [ "$1" = "x${i}" ];then\n  for a in 1 2 3;do echo "$a" | grep -q x>/dev/null||true;done\nfi\ncase $1 in\n a) echo a;;\n *) echo b;;\nesac\n}\n`;
    parts.push(s);
    n += s.length;
  }
  return parts.join('');
}
const write = (name, data) => { const p = path.join(files, name); fs.writeFileSync(p, data); return p; };
const large = write('large-2mb.sh', bigScript(2 * 1024 * 1024));
const huge = write('huge-12mb.sh', bigScript(12 * 1024 * 1024));
const nest = write('hostile-nest-5000.sh', '#!/bin/bash\n' + '('.repeat(5000) + 'true' + ')'.repeat(5000) + '\n');
const line1mb = write('hostile-1mb-line.sh', '#!/bin/bash\necho ' + 'a'.repeat(1024 * 1024) + '\n');
// A self-extracting installer: 4 KB of script, then a binary payload with NUL bytes (VS Code opens it as text,
// because its binary check reads only the start of the file).
const binary = write('hostile-binary.sh', Buffer.concat([Buffer.from('#!/bin/sh\n' + Array.from({ length: 200 }, (_, i) => `echo "unpacking part ${i}"`).join('\n') + '\nexit 0\n'),
  Buffer.from(Array.from({ length: 65536 }, (_, i) => (i * 131 + 7) % 256))]));
const heredoc = write('hostile-unterminated-heredoc.sh', '#!/bin/bash\necho start\ncat <<EOF\nnever closed\n$(echo nested\n');
const env = write('.env', 'API_KEY = "x y"\nNAME=value\n');
const docker = write('Dockerfile', 'FROM alpine\nRUN apk add --no-cache bash \\\n    && echo   done\n');
// .editorconfig parity: shfmt given only a path reads the same .editorconfig, so its output is the reference.
fs.mkdirSync(path.join(files, 'ec'), { recursive: true });
fs.writeFileSync(path.join(files, 'ec', '.editorconfig'), 'root = true\n\n[*.sh]\nindent_style = space\nindent_size = 3\nswitch_case_indent = true\nspace_redirects = true\n');
const ecFile = path.join(files, 'ec', 'case-editorconfig.sh');
fs.copyFileSync(path.join(root, 'test/fixtures/docker-entrypoint.sh'), ecFile);
fs.appendFileSync(ecFile, 'case "$1" in\na) echo a >/dev/null;;\nesac\n');
const saveFile = copy(path.join(root, 'samples/messy-deploy.sh'), 'save-test.sh');
const cmdFile = copy(path.join(root, 'test/fixtures/case.sh'), 'command-test.sh');

// ---- expectations from the shfmt CLI ----
function cli(text, file, settings = {}, editor = { insertSpaces: false, tabSize: 4 }) {
  const r = resolveOptions({ fileName: file, firstLine: text.split('\n', 1)[0], settings, editor });
  if (r.skip) return { skip: r.skip };
  let flags = shfmtFlags(r.dialect, r.opts);
  let p = spawnSync(SHFMT, flags, { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (p.status !== 0 && (r.dialectFrom === 'default' || r.dialectFrom === 'name')) {
    const m = /(?:is|are) an? ([a-z/]+) feature/.exec(p.stderr);
    const alt = m && m[1].split('/')[0];
    if (alt && alt !== r.dialect && ['bash', 'mksh', 'zsh'].includes(alt)) {
      flags = shfmtFlags(alt, r.opts);
      const p2 = spawnSync(SHFMT, flags, { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
      if (p2.status === 0) p = p2;
    }
  }
  if (p.status !== 0) {
    const m = /:(\d+):(\d+):/.exec(p.stderr);
    return { error: p.stderr.trim(), line: m ? +m[1] : 0, flags };
  }
  return { out: p.stdout, flags };
}

const manifest = { files: [] };
for (const f of [...list, large, huge, nest, line1mb, binary, heredoc, env, docker]) {
  const buf = fs.readFileSync(f);
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  const base = path.basename(f);
  const item = { file: f };
  if (f === huge) { item.expect = 'none'; item.maxMs = 1500; }
  else if (f === binary) item.expect = 'none';
  else if (f === nest) item.expect = 'none'; // engine error: a notification, no edit, no diagnostic
  else if (f === env) { item.expect = 'none'; item.lang = 'shellscript'; }
  else if (f === docker) item.expect = 'none';
  else {
    const c = cli(text, f);
    if (c.skip) item.expect = 'none';
    else if (c.error) { item.expect = 'error'; item.line = c.line; item.cli = c.error.slice(0, 200); }
    else { item.expect = 'format'; item.expected = c.out; item.flags = c.flags.join(' '); }
    if (f === large) item.maxMs = 2000;
  }
  item.name = base;
  manifest.files.push(item);
}
{
  const p = spawnSync(SHFMT, [ecFile], { encoding: 'utf8' });
  manifest.files.push({ file: ecFile, name: path.basename(ecFile), expect: 'format', expected: p.stdout, flags: 'shfmt <path> (reads .editorconfig)' });
}
{
  const t = fs.readFileSync(saveFile, 'utf8').split('\n');
  t.splice(1, 0, '# saved');
  manifest.saveTest = { file: saveFile, expected: cli(t.join('\n'), saveFile).out };
  manifest.crlf = { file: path.join(files, 'crlf.sh'), expected: cli(fs.readFileSync(path.join(files, 'crlf.sh'), 'utf8').replace(/\r\n/g, '\n'), 'crlf.sh').out };
  manifest.commandTest = { file: cmdFile, expected: cli(fs.readFileSync(cmdFile, 'utf8'), cmdFile).out };
}
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`gate files: ${manifest.files.length} (${manifest.files.filter((x) => x.expect === 'format').length} format, ${manifest.files.filter((x) => x.expect === 'error').length} error, ${manifest.files.filter((x) => x.expect === 'none').length} none)`);

// ---- install the vsix in a private profile ----
const ud = path.join(work, 'ud');
const ext = path.join(work, 'ext');
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
  'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'git.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true,
  // Tabs in the editor, so the expected output is shfmt's default (-i=0). The untitled check covers spaces.
  '[shellscript]': { 'editor.defaultFormatter': 'zovo.zovo-shell-formatter', 'editor.formatOnSave': true, 'editor.detectIndentation': false, 'editor.insertSpaces': false, 'editor.tabSize': 4 },
}, null, 1));
const inst = spawnSync(CLI, ['--user-data-dir', ud, '--extensions-dir', ext, '--install-extension', vsix, '--force'], { encoding: 'utf8', timeout: 120000 });
console.log('install:', (inst.stdout + inst.stderr).trim().split('\n').pop());
const installed = fs.readdirSync(ext).find((d) => d.startsWith('zovo.zovo-shell-formatter-'));
if (!installed) { console.error('not installed'); process.exit(2); }

// ---- run the in-editor checks ----
const out = path.join(work, 'results.json');
const t0 = Date.now();
const child = spawn(CODE, ['--user-data-dir', ud, '--extensions-dir', ext, '--disable-workspace-trust', '--skip-welcome', '--new-window',
  `--extensionDevelopmentPath=${path.join(ext, installed)}`, `--extensionTestsPath=${path.join(root, 'scripts/gate/runner.js')}`, files],
{ stdio: 'ignore', env: { ...process.env, GATE_MANIFEST: path.join(work, 'manifest.json'), GATE_OUT: out } });
const timer = setTimeout(() => { console.error('gate timeout, killing VS Code'); child.kill('SIGKILL'); }, 8 * 60 * 1000);
await new Promise((r) => child.on('exit', r));
clearTimeout(timer);
const res = JSON.parse(fs.readFileSync(out, 'utf8'));
let pass = 0, fail = 0;
console.log(`VS Code ${res.vscode} ${res.platform}-${res.arch}, ${Math.round((Date.now() - t0) / 1000)} s, extension host RSS ${JSON.stringify(res.extHostRssMB)}`);
for (const f of res.files) {
  f.ok ? pass++ : fail++;
  console.log(`${f.ok ? 'PASS' : 'FAIL'} ${f.expect.padEnd(6)} ${String(f.size).padStart(9)} B ${String(f.ms).padStart(5)} ms  ${f.file}${f.detail ? '  ' + f.detail : ''}`);
}
for (const c of res.checks) {
  c.ok ? pass++ : fail++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'} check  ${c.name}${c.ok ? '' : '  ' + c.detail}`);
}
console.log(`gate: ${pass} pass, ${fail} fail`);
fs.writeFileSync(path.join(work, 'summary.txt'), `pass ${pass} fail ${fail}\n`);
// Teardown: the large and hostile files go; the profile is kept only with --keep.
for (const f of [large, huge, nest, line1mb, binary]) fs.rmSync(f, { force: true });
if (!keep) fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
process.exit(fail ? 1 : 0);
