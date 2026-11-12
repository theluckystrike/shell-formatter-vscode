'use strict';
// A small stub of the vscode API for the Zovo Pro tests (Shell Formatter): documents are read from disk and saved back: records commands, messages, dialogs and opened files.
// Dialog answers are queued by the test in ui.* arrays (undefined = the user pressed Escape).
const Module = require('module');
const path = require('path');

function makeVscode() {
  const log = { saved: [], untitled: [], edits: [], providers: new Map(), picks: [], modals: [], info: [], warn: [], error: [], status: [], opened: [], shown: [], external: [], quickPicks: [], writes: [] };
  const ui = { pick: [], modal: [], input: [], open: [], save: [], warn: [], info: [], pickAccept: [] };
  const commands = new Map();
  const state = new Map();
  class EventEmitter {
    constructor() { this.l = []; this.event = (fn) => { this.l.push(fn); return { dispose() {} }; }; }
    fire(v) { for (const f of this.l) f(v); }
    dispose() {}
  }
  const Uri = {
    file: (p) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}`, with: (o) => Uri.file(o && o.path !== undefined ? o.path : p) }),
    joinPath: (u, ...s) => Uri.file(path.join(u.fsPath, ...s)),
    from: (o) => ({ fsPath: o.path, scheme: o.scheme, path: o.path, toString: () => `${o.scheme}:${o.path}` }),
    parse: (s) => ({ fsPath: s, scheme: String(s).split(':')[0], toString: () => String(s) }),
  };
  const fsw = require('fs');
  class Range { constructor(a, b, c, d) { if (typeof a === 'object') { this.start = a; this.end = b; } else { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } } }
  const docs = new Map();
  function makeDoc(file, content, language) {
    let text = content !== undefined ? content : fsw.readFileSync(file, 'utf8');
    const d = {
      uri: Uri.file(file), fileName: file, languageId: language || (/\.(sh|bash|zsh|ksh|bats)$/i.test(file) ? 'shellscript' : 'plaintext'), version: 1,
      getText: (r) => { if (!r) return text; const lines = text.split('\n'); return lines.slice(r.start.line, r.end.line).join('\n'); },
      get lineCount() { return text.split('\n').length; },
      positionAt: (o) => ({ offset: o }),
      setText: (t) => { text = t; d.version++; },
      save: async () => { fsw.writeFileSync(file, text); log.saved.push(file); return true; },
    };
    return d;
  }
  class WorkspaceEdit { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, range, text }); } set(uri, edits) { for (const e of edits) this.ops.push({ uri, range: e.range, text: e.newText }); } }
  const vscode = {
    EventEmitter, Uri, Range, WorkspaceEdit,
    TextEdit: { replace: (range, newText) => ({ range, newText }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(v) { this.value = v || ''; } appendMarkdown(t) { this.value += t; return this; } },
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { Active: -1 },
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1 },
    env: { openExternal: async (u) => { log.external.push(String(u)); return true; }, clipboard: { readText: async () => '', writeText: async () => {} }, machineId: 'test', appName: 'Visual Studio Code', uriScheme: 'vscode' },
    workspace: {
      workspaceFolders: undefined,
      fs: { writeFile: async (uri, data) => { fsw.writeFileSync(uri.fsPath, data); log.writes.push(uri.fsPath); }, readFile: async (uri) => new Uint8Array(fsw.readFileSync(uri.fsPath)), stat: async (uri) => { const st = fsw.statSync(uri.fsPath); return { size: st.size, type: st.isDirectory() ? 2 : 1 }; }, readDirectory: async (uri) => fsw.readdirSync(uri.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isSymbolicLink() ? 64 | (fsw.statSync(path.join(uri.fsPath, d.name)).isDirectory() ? 2 : 1) : d.isDirectory() ? 2 : 1]) },
      textDocuments: [],
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidCloseTextDocument: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (k, d) => d }),
      openTextDocument: async (arg) => {
        if (arg && arg.fsPath) { const k = arg.fsPath; if (!docs.has(k)) docs.set(k, makeDoc(k)); return docs.get(k); }
        const d = makeDoc(`/untitled-${docs.size + 1}`, arg.content, arg.language); log.untitled.push(d); return d;
      },
      applyEdit: async (we) => { for (const op of we.ops) { const d = docs.get(op.uri.fsPath); const t = d.getText(); d.setText(t.slice(0, op.range.start.offset) + op.text + t.slice(op.range.end.offset)); } log.edits.push(we.ops.length); return true; },
      registerTextDocumentContentProvider: (scheme, p) => { log.providers.set(scheme, p); return { dispose() {} }; },
      onDidOpenTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      showInformationMessage: async (m, ...items) => { if (items[0] && items[0].modal) { log.modals.push({ m, detail: items[0].detail || '', items: items.slice(1).map((x) => (typeof x === 'string' ? x : x.title)) }); return ui.modal.length ? ui.modal.shift() : undefined; } log.info.push(m); return ui.info.length ? ui.info.shift() : undefined; },
      showWarningMessage: async (m, ...items) => { log.warn.push({ m, items: items.filter((x) => typeof x === 'string' || (x && x.title)) }); return ui.warn.length ? ui.warn.shift() : undefined; },
      showErrorMessage: async (m) => { log.error.push(m); },
      setStatusBarMessage: (m) => { log.status.push(m); return { dispose() {} }; },
      showInputBox: async (o) => { const v = ui.input.shift(); if (v !== undefined && o && o.validateInput) { const err = o.validateInput(v); if (err) throw new Error(`input refused: ${err}`); } return v; },
      showOpenDialog: async () => { const v = ui.open.shift(); return v ? [Uri.file(v)] : undefined; },
      showSaveDialog: async () => { const v = ui.save.shift(); return v ? Uri.file(v) : undefined; },
      showQuickPick: async (items) => { const want = ui.pick.shift(); log.picks.push((Array.isArray(items) ? items : []).map((i) => i.label)); return want === undefined ? undefined : (Array.isArray(items) ? items : []).find((i) => i.label === want || i.what === want); },
      tabGroups: { activeTabGroup: { activeTab: null } },
      registerCustomEditorProvider: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showErrorMessage2: undefined,
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      activeTextEditor: undefined,
      showTextDocument: async (x) => { log.shown.push((x && x.uri ? x.uri.fsPath : x && x.fsPath) || String(x)); },
      withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      registerUriHandler: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      state: { focused: true },
      createQuickPick: () => {
        const qp = { items: [], selectedItems: [], title: '', placeholder: '', accept: null, hideFn: null,
          onDidAccept(fn) { qp.accept = fn; return { dispose() {} }; },
          onDidHide(fn) { qp.hideFn = fn; return { dispose() {} }; },
          onDidTriggerButton() { return { dispose() {} }; },
          show() { log.quickPicks.push(qp); }, hide() { if (qp.hideFn) qp.hideFn(); }, dispose() {} };
        return qp;
      },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...args) => {
        if (id === 'vscode.diff') { log.opened.push({ id, left: String(args[0]), right: String(args[1]), title: args[2] }); return undefined; }
        if (id === 'vscode.open' || id === 'revealFileInOS') { log.opened.push({ id, path: args[0] && args[0].fsPath }); return undefined; }
        if (id === 'setContext') return undefined;
        if (commands.has(id)) return commands.get(id)(...args);
        return undefined;
      },
    },
    extensions: { all: [], getExtension: () => undefined },
    languages: { match: (sel, doc) => (doc && ['shellscript', 'bats'].includes(doc.languageId) ? 10 : 0), createDiagnosticCollection: () => ({ set() {}, delete() {}, has() { return false; }, dispose() {} }), setTextDocumentLanguage: async (d) => d, registerDocumentFormattingEditProvider: () => ({ dispose() {} }), registerDocumentRangeFormattingEditProvider: () => ({ dispose() {} }) },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => ({ dispose() {} }) },
  };
  const context = {
    subscriptions: [],
    workspaceState: { get: (k, d) => d, update: async () => {} },
    globalState: { get: (k, d) => (state.has(k) ? state.get(k) : d), update: async (k, v) => { state.set(k, v); }, keys: () => [...state.keys()], setKeysForSync() {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) },
    extension: undefined,
    extensionPath: path.join(__dirname, '..', '..'),
    extensionUri: Uri.file(path.join(__dirname, '..', '..')),
  };
  return { vscode, context, log, ui, commands, state };
}

/** Loads src/extension.js with the stub as "vscode". Call restore() at the end. */
function loadExtension() {
  const s = makeVscode();
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { return req === 'vscode' ? s.vscode : orig.call(this, req, parent, isMain); };
  const root = path.join(__dirname, '..', '..', 'src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(root)) delete require.cache[k];
  s.ext = require(path.join(root, 'extension.js'));
  s.restore = () => { Module._load = orig; };
  return s;
}

module.exports = { makeVscode, loadExtension };
