// README and walkthrough screenshots from a real VS Code with the packaged extension installed.
//   node scripts/shots.mjs --vsix dist/x.vsix --work ~/shell-formatter-work/shots --port 9269 [--theme "Default Light Modern"]
import fs from 'node:fs';
import path from 'node:path';
import { installVsix, launch, sleep } from './vsc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vsix = path.resolve(arg('vsix'));
const work = path.resolve(arg('work'));
const port = Number(arg('port', 9269));
const theme = arg('theme', 'Default Dark Modern');
const outDir = path.resolve(arg('out', path.join(root, 'images')));
const prefix = arg('prefix', '');

fs.rmSync(work, { recursive: true, force: true });
const demo = path.join(work, 'deploy-scripts');
fs.mkdirSync(demo, { recursive: true });
const messy = fs.readFileSync(path.join(root, 'samples/messy-deploy.sh'), 'utf8');
fs.writeFileSync(path.join(demo, 'deploy.before.sh'), messy);
fs.writeFileSync(path.join(demo, 'deploy.sh'), messy);
fs.writeFileSync(path.join(demo, 'release-notes.sh'), '#!/bin/bash\n# Prints the release notes.\nversion=${1:?version}\necho "Release $version"\ncat <<EOF\n- Faster deploys\n- New health check\n');

const inst = installVsix(work, vsix);
if (inst.code !== 0) { console.error(inst.out); process.exit(2); }

const vs = await launch(work, port, demo, {
  'workbench.colorTheme': theme, 'editor.fontSize': 13, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.commandCenter.enabled': false, 'editor.minimap.enabled': false, 'breadcrumbs.enabled': false,
  'workbench.editor.enablePreview': false, 'editor.detectIndentation': false, 'editor.insertSpaces': false, 'editor.tabSize': 4,
  '[shellscript]': { 'editor.defaultFormatter': 'zovo.zovo-shell-formatter' }, 'shellFormatter.askForRating': false,
});
const errors = [];
// Format Document needs the editor focused: the command palette gives focus back to the last focused part.
async function formatActive() {
  await vs.command('View: Focus Active Editor Group');
  await sleep(400);
  // Shift+Option+F, the Format Document keybinding on macOS. Raw key events only: no character is typed.
  for (const type of ['rawKeyDown', 'keyUp']) {
    await vs.s.send('Input.dispatchKeyEvent', { type, modifiers: 1 | 8, key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 }, vs.wb);
  }
  await sleep(1500);
}
try {
  await sleep(4000);
  vs.open(path.join(demo, 'deploy.before.sh'));
  await sleep(1500);
  await vs.command('View: Split Editor Right');
  await sleep(800);
  vs.open(path.join(demo, 'deploy.sh'));
  await sleep(1500);
  await vs.command('View: Close Primary Side Bar');
  await sleep(500);
  await formatActive();
  await sleep(1500);
  const hover = async () => {
    const r = await vs.wbEval(`(() => { const e = [...document.querySelectorAll('.statusbar-item')].find(x => /shfmt/.test(x.textContent)); if (!e) return 'null'; const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2, t: e.textContent.trim() }); })()`);
    const b = JSON.parse(r);
    if (!b) { errors.push('status bar item not found'); return null; }
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x - 30, y: b.y }, vs.wb);
    await sleep(200);
    await vs.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }, vs.wb);
    await sleep(2200);
    return b.t;
  };
  const label = await hover();
  console.log('status bar:', label);
  await vs.shot(path.join(outDir, prefix + 'formatted.png'));

  await vs.command('View: Close All Editor Groups');
  await sleep(800);
  await vs.command('View: Open Primary Side Bar');
  vs.open(path.join(demo, 'release-notes.sh'));
  await sleep(1500);
  await formatActive();
  await sleep(1200);
  await vs.command('View: Focus Problems');
  await sleep(1200);
  const aux = await vs.wbEval(`(() => { const a = document.querySelector('.part.auxiliarybar'); return !!(a && a.offsetWidth > 0); })()`);
  if (aux) { await vs.command('View: Toggle Secondary Side Bar Visibility'); await sleep(800); }
  const label2 = await hover();
  console.log('status bar after error:', label2);
  await vs.shot(path.join(outDir, prefix + 'syntax-error.png'));
  const text = fs.readFileSync(path.join(demo, 'release-notes.sh'), 'utf8');
  if (!text.includes('cat <<EOF')) errors.push('broken file changed on disk');
  console.log('console errors from the extension:', vs.console.filter((c) => /shell|zovo/i.test(c.text)).length);
} catch (e) {
  errors.push(String(e && e.stack || e));
} finally {
  await vs.close();
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('shots in', outDir);
