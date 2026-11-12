'use strict';
// Zovo Pro for Shell Formatter, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license). Three Pro tools, 3 free tries each on this computer. A try counts only after a result (files
// formatted, a report or patch with changes shown, a minified copy written); Escape, Cancel or "nothing to change"
// never uses one. Nothing about Pro shows on open, activation or update: the panel appears only after a click on a Pro
// tool with no tries left. Format Document, Format Selection, format on save and every setting stay free.
const { createLicense } = require('./license');
const { withSurface } = require('./reach');

const SKU = 'shell-formatter-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'shellFormatter.proTrial';

const FEATURES = {
  folder: {
    title: 'Format all shell scripts in a folder',
    detail: 'Checks every shell script in a folder (and its subfolders) with the same shfmt engine, settings and .editorconfig as Format Document, shows how many would change, then formats them all or gives a Markdown report. Scripts that would not run the same commands are left as they are.',
  },
  check: {
    title: 'Formatting check with a patch file',
    detail: 'Checks a folder without changing a file and opens one patch (unified diff, like shfmt -d) of every change formatting would make, with the list of scripts that are not formatted and the shfmt command for CI. Review it, attach it to a pull request or apply it with git apply.',
  },
  minify: {
    title: 'Minify a script to a copy',
    detail: 'Writes a minified copy of a script next to it (name.min.sh): comments and spacing removed by shfmt -mn, and checked to run the same commands. The original file is not changed.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, prefix = 'shellFormatter', productName = 'Shell Formatter' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, withSurface({ detail: feat.detail, triesUsed: used(f), tools: TOOLS })));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
