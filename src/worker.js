'use strict';
// Runs shfmt (mvdan/sh, compiled to WebAssembly by the sh-syntax package) in a worker thread.
// Why a worker: the Go runtime shim sets globals (Go, fs) that must not leak into the shared extension host,
// and a hostile file (deep nesting, a huge single line) must never block the editor. The host kills this
// worker after a time limit and starts a new one for the next request.
// No network: the WebAssembly file is read from the extension folder.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { getProcessorSync } = require('sh-syntax');
const { normalizeAst } = require('./verify');

let proc = null;
function processor() {
  if (!proc) proc = getProcessorSync(fs.readFileSync(workerData.wasmPath));
  return proc;
}

function errorOut(e) {
  if (e && (e.name === 'ParseError' || 'incomplete' in e) && e.pos) {
    return { ok: false, kind: 'syntax', message: String(e.text || e.message || 'syntax error'), line: e.pos.line, column: e.pos.column, offset: e.pos.offset, incomplete: !!e.incomplete };
  }
  if (e && (e.name === 'ParseError' || e.name === 'SyntaxError')) {
    // A parse error without a position. Try to read "line:col:" from the message, as shfmt prints it.
    const text = String(e.text || e.message || 'syntax error');
    const m = /^(?:[^:]*:)?(\d+):(\d+): (.*)$/s.exec(text);
    if (m) return { ok: false, kind: 'syntax', message: m[3], line: +m[1], column: +m[2], incomplete: !!e.incomplete };
    return { ok: false, kind: 'syntax', message: text, line: 0, column: 0, incomplete: !!e.incomplete };
  }
  return { ok: false, kind: 'engine', message: String((e && e.message) || e) };
}

function run(msg) {
  const t0 = Date.now();
  const p = processor();
  // shfmt's own defaults. The sh-syntax library defaults differ (it turns on -bn, -ci and -sr), so every
  // option missing from the request is set here and the output matches the shfmt command line tool.
  const opts = Object.assign({ variant: 1, indent: 0, binaryNextLine: false, switchCaseIndent: false, spaceRedirects: false,
    keepPadding: false, functionNextLine: false, simplify: false, minify: false }, msg.opts, { filepath: msg.name || '' });
  opts.useTabs = opts.indent === 0;
  opts.tabWidth = opts.indent || 8;
  let out;
  try {
    out = p(msg.text, Object.assign({}, opts, { print: true }));
  } catch (e) {
    return errorOut(e);
  }
  const res = { ok: true, text: out, ms: Date.now() - t0, verified: false };
  if (msg.verify && out !== msg.text) {
    // Safety check: the formatted script must parse to the same commands as the original.
    try {
      const keepComments = !opts.minify;
      const a = normalizeAst(p(msg.text, Object.assign({}, opts, { keepComments })), opts);
      const b = normalizeAst(p(out, Object.assign({}, opts, { keepComments })), opts);
      if (a !== b) return { ok: false, kind: 'verify', message: 'The formatted script would not parse to the same commands as the original, so the file was left unchanged.' };
      res.verified = true;
    } catch (e) {
      const r = errorOut(e);
      if (r.kind === 'syntax') return { ok: false, kind: 'verify', message: 'The formatted script did not parse again (' + r.message + '), so the file was left unchanged.' };
      return r;
    }
  }
  res.ms = Date.now() - t0;
  return res;
}

parentPort.on('message', (msg) => {
  let res;
  try {
    if (msg.op === 'ping') res = { ok: true, text: '' };
    else res = run(msg);
  } catch (e) {
    res = errorOut(e);
  }
  res.id = msg.id;
  parentPort.postMessage(res);
});
