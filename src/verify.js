'use strict';
// The safety check behind "formatting never changes what the script does": the original and the formatted
// text are parsed by the same shfmt parser, and their syntax trees must match once layout is removed.
// Removed before the compare: positions, the backquote style of $(...) (shfmt prints `cmd` as $(cmd)),
// leading tabs in <<- here-document bodies (the shell strips them anyway) and where comments are attached
// (comment texts are compared as a sorted list), and `for ((...)); { }` versus `do ... done` (the same loop). Pure function, no VS Code.

const DASH_HDOC = 72; // RedirOperator.DashHdoc in sh-syntax
const DROP = new Set(['start', 'end', 'backquotes']);

function isPos(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && 'offset' in v && 'line' in v && 'column' in v && !('type' in v);
}

function stripTabs(node) {
  if (Array.isArray(node)) return node.map(stripTabs);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === 'value' && node.type === 'Lit' && typeof v === 'string') out[k] = v.replace(/(^|\n)\t+/g, '$1');
    else out[k] = stripTabs(v);
  }
  return out;
}

/** A canonical string for a parsed File (sh-syntax AST). Two scripts with the same string run the same commands. */
function normalizeAst(file) {
  const comments = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      const arr = [];
      for (const x of node) {
        if (x && typeof x === 'object' && x.type === 'Comment') { comments.push(String(x.text || '').replace(/\s+$/, '')); continue; }
        arr.push(walk(x));
      }
      return arr;
    }
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'Comment') { comments.push(String(node.text || '').replace(/\s+$/, '')); return null; }
    const out = {};
    for (const k of Object.keys(node).sort()) {
      const v = node[k];
      if (DROP.has(k) || isPos(v)) continue;
      if (k === 'braces' && node.type === 'ForClause') continue;
      if (k === 'name' && node.type === 'File') continue;
      if (k === 'hdoc' && node.type === 'Redirect' && node.op === DASH_HDOC) { out[k] = walk(stripTabs(v)); continue; }
      out[k] = walk(v);
    }
    return out;
  };
  const tree = walk(file);
  comments.sort();
  return JSON.stringify({ tree, comments });
}

module.exports = { normalizeAst, isPos };
