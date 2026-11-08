'use strict';
// Shell Formatter: formats bash, sh, mksh, bats and zsh scripts with shfmt compiled to WebAssembly.
// Nothing is downloaded and nothing is sent anywhere: the engine ships inside the extension.
const vscode = require('vscode');
const path = require('path');
const fsp = require('fs/promises');
const { Engine, SHFMT_VERSION } = require('./engine');
const { resolveOptions, editorConfigProps, shfmtFlags } = require('./options');
const { lineDiff, byteColToChar, dedentSelection, indentBack, hasNul, fmtSize } = require('./edits');
const { createRatingPrompt } = require('./rate');
const { registerSupport, footerMarkdown, showLinks } = require('./support');

const SECTION = 'shellFormatter';
const SELF_ID = 'zovo.zovo-shell-formatter';
const SELECTOR = [{ language: 'shellscript' }, { language: 'bats' }];
const VERIFY_MAX = 256 * 1024; // the same-commands check parses twice; above this size it is skipped
const RECYCLE_AT = 256 * 1024; // after a file this big the worker is restarted, so its memory is returned

let engine = null;
let rating = { success() {}, failure() {} };
let diagnostics = null;
let status = null;
const last = new Map(); // uri -> { ok, dialect, dialectFrom, indentFrom, flags, ms, verified, message }
const counted = new Set();
const warnedLarge = new Set();
let requests = 0;

function settings(uri) {
  const c = vscode.workspace.getConfiguration(SECTION, uri);
  const indent = c.get('indent', null);
  return {
    dialect: c.get('dialect', 'auto'),
    indent: typeof indent === 'number' ? indent : null,
    binaryNextLine: c.get('binaryNextLine', false),
    switchCaseIndent: c.get('switchCaseIndent', false),
    spaceRedirects: c.get('spaceRedirects', false),
    keepPadding: c.get('keepPadding', false),
    functionNextLine: c.get('functionNextLine', false),
    simplify: c.get('simplify', false),
    minify: c.get('minify', false),
    useEditorConfig: c.get('useEditorConfig', true),
    verify: c.get('verifyCommands', true),
    maxFileMB: Math.max(1, Math.min(100, Number(c.get('maxFileMB', 10)) || 10)),
    timeoutSeconds: Math.max(2, Math.min(120, Number(c.get('timeoutSeconds', 10)) || 10)),
    skipFiles: c.get('skipFiles', ['.env', '.env.*', '*.env']),
  };
}

/** .editorconfig texts from the file's folder up to the first root = true (local and remote file systems). */
async function readEditorConfigs(uri) {
  const out = [];
  if (uri.scheme === 'untitled') return out;
  let dir = path.posix.dirname(uri.path);
  for (let i = 0; i < 64; i++) {
    const ecUri = uri.with({ path: path.posix.join(dir, '.editorconfig'), query: '', fragment: '' });
    try {
      let text;
      if (uri.scheme === 'file') {
        const st = await fsp.stat(ecUri.fsPath);
        if (st.isFile() && st.size <= 1024 * 1024) text = await fsp.readFile(ecUri.fsPath, 'utf8');
      } else {
        const st = await vscode.workspace.fs.stat(ecUri);
        if (st.size <= 1024 * 1024) text = Buffer.from(await vscode.workspace.fs.readFile(ecUri)).toString('utf8');
      }
      if (text !== undefined) {
        out.push({ dir, text });
        if (/^\s*root\s*=\s*true\s*$/im.test(text.split(/^\s*\[/m)[0])) break;
      }
    } catch { /* no .editorconfig here */ }
    const up = path.posix.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

function globToRe(g) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

function skippedByName(uri, s) {
  const name = path.posix.basename(uri.path);
  return (Array.isArray(s.skipFiles) ? s.skipFiles : []).some((g) => typeof g === 'string' && g && globToRe(g).test(name));
}

function engineVersionText() {
  return `shfmt ${SHFMT_VERSION}`;
}

function setDiagnostic(doc, text, res, lineOffset, prefixLen) {
  const lines = text.split('\n');
  const line = Math.max(0, (res.line || 1) - 1);
  const ch = byteColToChar(lines[line] || '', res.column || 0);
  const docLine = Math.min(doc.lineCount - 1, line + (lineOffset || 0));
  const lineLen = doc.lineAt(docLine).text.length;
  const start = new vscode.Position(docLine, Math.min(ch + (prefixLen || 0), lineLen));
  const end = new vscode.Position(docLine, Math.min(lineLen, start.character + 1) || lineLen);
  const d = new vscode.Diagnostic(new vscode.Range(start, end.isAfter(start) ? end : start),
    `${res.message} (shfmt could not parse the script, so it was not formatted)`, vscode.DiagnosticSeverity.Error);
  d.source = 'Shell Formatter';
  diagnostics.set(doc.uri, [d]);
}

function featureDialect(message) {
  const m = /(?:is|are) an? ([a-z/]+) feature/.exec(message || '');
  if (!m) return '';
  const first = m[1].split('/')[0];
  return ['bash', 'mksh', 'zsh'].includes(first) ? first : '';
}

/**
 * Formats a document, or whole lines of it. Returns VS Code edits ([] when nothing changes or on an error).
 * range: undefined for the whole document.
 */
async function formatDocument(doc, editorOptions, token, range) {
  const s = settings(doc.uri);
  const uriKey = doc.uri.toString();
  if (skippedByName(doc.uri, s)) return [];
  let text = range ? doc.getText(range) : doc.getText();
  const size = Buffer.byteLength(text, 'utf8');
  if (size > s.maxFileMB * 1024 * 1024) {
    if (!warnedLarge.has(uriKey)) {
      warnedLarge.add(uriKey);
      // Not awaited: a format-on-save must not wait for the user to close a notification.
      vscode.window.showWarningMessage(
        `Shell Formatter: ${path.posix.basename(doc.uri.path)} is ${fmtSize(size)}. Files over ${s.maxFileMB} MB are not formatted, so the editor stays fast.`,
        'Change the limit').then((pick) => { if (pick) vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.maxFileMB`); });
    }
    return [];
  }
  if (hasNul(text)) {
    vscode.window.setStatusBarMessage('$(info) Shell Formatter: the file has binary (NUL) bytes, so it was not formatted.', 8000);
    return [];
  }
  text = text.replace(/\r\n/g, '\n');
  const orig = text;
  let prefix = '';
  if (range) {
    const ded = dedentSelection(text);
    if (ded.refuse) { vscode.window.setStatusBarMessage('$(info) Shell Formatter: ' + ded.refuse, 8000); return []; }
    text = ded.text;
    prefix = ded.prefix;
  }
  const firstLine = doc.lineAt(0).text;
  const ec = s.useEditorConfig ? editorConfigProps(await readEditorConfigs(doc.uri), doc.uri.path, guessDialect(doc, s)) : {};
  const r = resolveOptions({
    fileName: doc.uri.path, firstLine, settings: s,
    editor: { insertSpaces: !!(editorOptions && editorOptions.insertSpaces), tabSize: editorOptions && editorOptions.tabSize }, ec,
  });
  if (r.skip) {
    last.set(uriKey, { ok: true, skipped: r.skip });
    updateStatus();
    vscode.window.setStatusBarMessage('$(info) Shell Formatter: ' + r.skip, 8000);
    return [];
  }
  let dialect = r.dialect;
  const verify = s.verify && !r.opts.simplify && !r.opts.minify && size <= VERIFY_MAX;
  const timeoutMs = s.timeoutSeconds * 1000;
  let res = await engine.format(text, r.opts, path.posix.basename(doc.uri.path), verify, timeoutMs);
  // No shebang and the parser names the dialect it needs ("anonymous functions are a zsh feature"): try that one.
  if (!res.ok && res.kind === 'syntax' && (r.dialectFrom === 'default' || r.dialectFrom === 'name') && s.dialect === 'auto' && !ec.shell_variant) {
    const alt = featureDialect(res.message);
    const variants = { bash: 1, mksh: 4, zsh: 16 };
    if (alt && alt !== dialect) {
      const res2 = await engine.format(text, Object.assign({}, r.opts, { variant: variants[alt] }), path.posix.basename(doc.uri.path), verify, timeoutMs);
      if (res2.ok) { res = res2; dialect = alt; }
    }
  }
  requests++;
  if (size > RECYCLE_AT || requests % 500 === 0) engine.reset();
  if (token && token.isCancellationRequested) return [];
  const info = { dialect, dialectFrom: dialect === r.dialect ? r.dialectFrom : 'parser hint', indentFrom: r.indentFrom, flags: shfmtFlags(dialect, r.opts), ms: res.ms, verified: !!res.verified, size };
  if (!res.ok) {
    info.ok = false;
    info.message = res.message;
    last.set(uriKey, info);
    if (res.kind === 'syntax') {
      setDiagnostic(doc, text, res, range ? range.start.line : 0, prefix.length);
      vscode.window.setStatusBarMessage(`$(warning) Shell Formatter: syntax error on line ${(res.line || 1) + (range ? range.start.line : 0)}. The file is unchanged.`, 8000);
    } else {
      rating.failure();
      vscode.window.showWarningMessage(`Shell Formatter: ${res.message}`);
    }
    updateStatus();
    return [];
  }
  diagnostics.delete(doc.uri);
  info.ok = true;
  last.set(uriKey, info);
  updateStatus();
  let out = res.text;
  if (range) {
    out = indentBack(out, prefix);
    if (!orig.endsWith('\n') && out.endsWith('\n')) out = out.slice(0, -1);
  }
  if (!counted.has(uriKey) && doc.uri.scheme !== 'untitled') { counted.add(uriKey); rating.success(doc.uri); }
  const d = lineDiff(orig, out);
  if (!d) return [];
  const baseLine = range ? range.start.line : 0;
  const edit = new vscode.TextEdit(
    new vscode.Range(baseLine + d.startLine, 0, baseLine + d.endLine, d.endChar),
    d.text);
  return [edit];
}

/** The dialect before EditorConfig is read, used only to pick [[bash]] / [[zsh]] sections. */
function guessDialect(doc, s) {
  const r = resolveOptions({ fileName: doc.uri.path, firstLine: doc.lineAt(0).text, settings: Object.assign({}, s, { useEditorConfig: false }) });
  return r.dialect || 'bash';
}

function isShellDoc(doc) {
  return !!doc && vscode.languages.match(SELECTOR, doc) > 0;
}

function updateStatus() {
  if (!status) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isShellDoc(ed.document)) { status.hide(); return; }
  const info = last.get(ed.document.uri.toString());
  const bad = info && info.ok === false;
  status.text = (bad ? '$(warning) ' : '$(check) ') + engineVersionText();
  status.backgroundColor = bad ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [`${SECTION}.format`, `${SECTION}.menu`, `${SECTION}.supportDeveloper`, `${SECTION}.moreViewers`, 'workbench.action.openSettings'] };
  md.appendMarkdown(`**Shell Formatter** · ${engineVersionText()} built in (WebAssembly). No download, works offline.\n\n`);
  if (info && info.skipped) md.appendMarkdown(`Not formatted: ${info.skipped}\n\n`);
  else if (info) {
    md.appendMarkdown(`Dialect: **${info.dialect}** (${info.dialectFrom}) · Indent from: ${info.indentFrom}\n\n`);
    if (info.ok) md.appendMarkdown(`Last format: ${info.ms} ms${info.verified ? ' · same commands checked' : ''}\n\n`);
    else md.appendMarkdown(`Last format stopped: ${String(info.message || '').replace(/[[\]*_`]/g, '')}. The file is unchanged.\n\n`);
  } else md.appendMarkdown('Format with Shift+Alt+F (Shift+Option+F on macOS) or on save.\n\n');
  md.appendMarkdown(`[Format now](command:${SECTION}.format) · [Settings](command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify([SECTION]))})`);
  if (showLinks(vscode, SECTION)) md.appendMarkdown('\n\n' + footerMarkdown(SECTION));
  status.tooltip = md;
  status.show();
}

async function formatCommand() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  if (!isShellDoc(ed.document)) {
    vscode.window.showInformationMessage('Shell Formatter: open a shell script (bash, sh, zsh, bats) first.');
    return;
  }
  const edits = await formatDocument(ed.document, ed.options, undefined, undefined);
  if (edits.length) {
    await ed.edit((b) => { for (const e of edits) b.replace(e.range, e.newText); });
  }
  const info = last.get(ed.document.uri.toString());
  if (info && info.ok) vscode.window.setStatusBarMessage(edits.length ? `$(check) Formatted with ${engineVersionText()} in ${info.ms} ms` : '$(check) Already formatted', 4000);
}

async function setDefaultFormatter() {
  const cfg = vscode.workspace.getConfiguration();
  for (const lang of ['shellscript']) {
    const key = `[${lang}]`;
    const cur = Object.assign({}, cfg.get(key) || {});
    cur['editor.defaultFormatter'] = SELF_ID;
    await cfg.update(key, cur, vscode.ConfigurationTarget.Global);
  }
  vscode.window.showInformationMessage('Shell Formatter is now the default formatter for shell scripts (user settings).');
}

async function formatOnSave() {
  const cfg = vscode.workspace.getConfiguration();
  const cur = Object.assign({}, cfg.get('[shellscript]') || {});
  cur['editor.defaultFormatter'] = SELF_ID;
  cur['editor.formatOnSave'] = true;
  await cfg.update('[shellscript]', cur, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('Shell scripts are now formatted each time you save (user settings).');
}

async function openSample(context) {
  // An untitled copy, so nothing is written to disk and the sample never counts for the rating ask.
  const uri = vscode.Uri.joinPath(context.extensionUri, 'samples', 'messy-deploy.sh');
  const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  const doc = await vscode.workspace.openTextDocument({ language: 'shellscript', content });
  await vscode.window.showTextDocument(doc);
}

async function copyCommand() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isShellDoc(ed.document)) return;
  const s = settings(ed.document.uri);
  const ec = s.useEditorConfig ? editorConfigProps(await readEditorConfigs(ed.document.uri), ed.document.uri.path, guessDialect(ed.document, s)) : {};
  const r = resolveOptions({ fileName: ed.document.uri.path, firstLine: ed.document.lineAt(0).text, settings: s,
    editor: { insertSpaces: !!ed.options.insertSpaces, tabSize: ed.options.tabSize }, ec });
  if (r.skip) { vscode.window.showInformationMessage('Shell Formatter: ' + r.skip); return; }
  const cmd = `shfmt ${shfmtFlags(r.dialect, r.opts).join(' ')} -w ${JSON.stringify(path.posix.basename(ed.document.uri.path))}`;
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`Copied: ${cmd}. Use it in CI to get the same result as the editor.`);
}

async function menu(support) {
  const items = [
    { label: '$(wand) Format this script', run: formatCommand },
    { label: '$(star) Use Shell Formatter as the default for shell scripts', run: setDefaultFormatter },
    { label: '$(save) Format each time a shell script is saved', run: formatOnSave },
    { label: '$(terminal) Copy the matching shfmt command (for CI)', run: copyCommand },
    { label: '$(gear) Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', SECTION) },
    { label: '$(book) Get started', run: () => vscode.commands.executeCommand(`${SECTION}.openWalkthrough`) },
    { label: '$(extensions) More free tools by Zovo', run: () => support.moreViewers() },
    { label: '$(heart) Support the developer', run: () => support.supportDeveloper() },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Shell Formatter · ${engineVersionText()} · no download, works offline` });
  if (pick) await pick.run();
}

function activate(context) {
  const dist = path.join(context.extensionPath, 'dist');
  engine = new Engine({ workerPath: path.join(dist, 'worker.js'), wasmPath: path.join(dist, 'main.wasm'), timeoutMs: 10000 });
  rating = createRatingPrompt({ vscode, context, extensionId: SELF_ID, section: SECTION, name: 'Shell Formatter' });
  const support = registerSupport({ vscode, context, prefix: SECTION, selfId: SELF_ID });
  diagnostics = vscode.languages.createDiagnosticCollection('shell-formatter');
  status = vscode.window.createStatusBarItem('zovo.shellFormatter.status', vscode.StatusBarAlignment.Right, 100);
  status.name = 'Shell Formatter';
  status.command = `${SECTION}.menu`;

  const provider = {
    provideDocumentFormattingEdits: (doc, options, token) => formatDocument(doc, options, token),
    provideDocumentRangeFormattingEdits: (doc, range, options, token) => {
      const full = new vscode.Range(range.start.line, 0, range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line,
        Number.MAX_SAFE_INTEGER);
      return formatDocument(doc, options, token, doc.validateRange(full));
    },
  };

  context.subscriptions.push(
    { dispose: () => engine && engine.dispose() },
    diagnostics,
    status,
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, provider),
    vscode.languages.registerDocumentRangeFormattingEditProvider(SELECTOR, provider),
    vscode.commands.registerCommand(`${SECTION}.format`, formatCommand),
    vscode.commands.registerCommand(`${SECTION}.setDefault`, setDefaultFormatter),
    vscode.commands.registerCommand(`${SECTION}.copyCommand`, copyCommand),
    vscode.commands.registerCommand(`${SECTION}.formatOnSave`, formatOnSave),
    vscode.commands.registerCommand(`${SECTION}.openSample`, () => openSample(context)),
    vscode.commands.registerCommand(`${SECTION}.menu`, () => menu(support)),
    vscode.commands.registerCommand(`${SECTION}.openWalkthrough`, () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${SELF_ID}#${SECTION}.start`, false)),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length && diagnostics.has(e.document.uri)) diagnostics.delete(e.document.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => { diagnostics.delete(d.uri); last.delete(d.uri.toString()); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) updateStatus(); }),
  );
  updateStatus();
  return { formatText: (text, opts, name, verify) => engine.format(text, opts, name, verify), engineVersion: SHFMT_VERSION };
}

function deactivate() {
  if (engine) engine.dispose();
}

module.exports = { activate, deactivate, SHFMT_VERSION, featureDialect, globToRe };
