'use strict';
// Pure text helpers for the formatter (no VS Code): the smallest line edit, byte columns, selections.

/**
 * The smallest whole-line edit that turns oldText into newText (both with "\n" line ends), or null when equal.
 * Returns { startLine, endLine, endChar, text }: replace from (startLine, 0) to (endLine, endChar) of the old
 * text with `text`. Unchanged lines stay out of the edit, so the cursor, folds, breakpoints and the scroll
 * position stay where they were.
 */
function lineDiff(oldText, newText) {
  if (oldText === newText) return null;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const max = Math.min(a.length, b.length);
  let s = 0;
  while (s < max - 1 && a[s] === b[s]) s++; // the last line has no "\n" after it, so it never counts as prefix
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  let pre = 0;
  for (let i = 0; i < s; i++) pre += a[i].length + 1;
  const oldEnd = oldText.length - a.slice(ea).join('\n').length;
  const newEnd = newText.length - b.slice(eb).join('\n').length;
  const before = oldText.slice(0, oldEnd);
  const endLine = (before.match(/\n/g) || []).length;
  const endChar = oldEnd - (before.lastIndexOf('\n') + 1);
  return { startLine: s, endLine, endChar, text: newText.slice(pre, newEnd) };
}

/** Applies a lineDiff result to the old text (used by the tests to prove the edit is exact). */
function applyLineDiff(oldText, d) {
  if (!d) return oldText;
  const lines = oldText.split('\n');
  let start = 0;
  for (let i = 0; i < d.startLine; i++) start += lines[i].length + 1;
  let end = 0;
  for (let i = 0; i < d.endLine; i++) end += lines[i].length + 1;
  end += d.endChar;
  return oldText.slice(0, start) + d.text + oldText.slice(end);
}

/** A 0-based UTF-8 byte column (what shfmt reports) as a UTF-16 index into the line. */
function byteColToChar(lineText, byteCol) {
  const s = String(lineText || '');
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    if (bytes >= byteCol) return i;
    const c = s.codePointAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++;
  }
  return s.length;
}

/**
 * Prepares selected lines for shfmt: removes the common indent. Returns { text, prefix } or { refuse }.
 * The indent is put back on each output line by indentBack, except inside here-documents, so a selection
 * with a here-document is only formatted when it starts at column 1.
 */
function dedentSelection(text) {
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim() !== '');
  if (first === undefined) return { text, prefix: '' };
  const prefix = /^[ \t]*/.exec(first)[0];
  if (!prefix) return { text, prefix: '' };
  if (/<</.test(text)) return { refuse: 'The selection has a here-document and starts after column 1. Select from the start of the line, or format the whole file.' };
  for (const l of lines) if (l.trim() !== '' && !l.startsWith(prefix)) return { text, prefix: '' };
  return { text: lines.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l.trimStart())).join('\n'), prefix };
}

function indentBack(text, prefix) {
  if (!prefix) return text;
  return text.split('\n').map((l) => (l === '' ? l : prefix + l)).join('\n');
}

function hasNul(text) {
  return text.indexOf('\0') !== -1;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

module.exports = { lineDiff, applyLineDiff, byteColToChar, dedentSelection, indentBack, hasNul, fmtSize };
