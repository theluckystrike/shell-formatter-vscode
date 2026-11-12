'use strict';
// Unified diff (the format of `diff -u`, `git diff` and `shfmt -d`) for the Zovo Pro formatting check. Pure, no VS Code.
// Line diff with the Myers algorithm; above MAX_EDIT the two texts are shown as one changed block, which is still a
// valid patch (git apply and patch -p1 accept it).

const MAX_EDIT = 4000; // edit distance limit for the Myers search (keeps a hostile file from taking seconds)

function splitLines(text) {
  if (text === '') return { lines: [], noEol: false };
  const noEol = !text.endsWith('\n');
  const lines = (noEol ? text : text.slice(0, -1)).split('\n');
  return { lines, noEol };
}

/** Edit script between two line arrays: [{ op: ' ' | '-' | '+', line }]. */
function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const head = a.slice(0, s).map((line) => ({ op: ' ', line }));
  const tail = a.slice(ea).map((line) => ({ op: ' ', line }));
  const mid = myers(a.slice(s, ea), b.slice(s, eb));
  return head.concat(mid, tail);
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ op: '+', line }));
  if (!m) return a.map((line) => ({ op: '-', line }));
  const max = Math.min(n + m, MAX_EDIT);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return a.map((line) => ({ op: '-', line })).concat(b.map((line) => ({ op: '+', line })));
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
    const px = vv[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) { out.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    if (x === px) out.push({ op: '+', line: b[y - 1] }); else out.push({ op: '-', line: a[x - 1] });
    x = px; y = py;
  }
  while (x > 0 && y > 0) { out.push({ op: ' ', line: a[x - 1] }); x--; y--; }
  return out.reverse();
}

/**
 * A unified diff of one file. oldText/newText with "\n" line ends. name: the path inside the patch (a/<name>, b/<name>).
 * Returns '' when the texts are equal.
 */
function unifiedDiff(oldText, newText, name, context = 3) {
  if (oldText === newText) return '';
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const ops = diffLines(A.lines, B.lines);
  // the "\ No newline at end of file" marker belongs to the last line of a side
  const lastA = A.lines.length;
  const lastB = B.lines.length;
  let ai = 0;
  let bi = 0;
  const rows = ops.map((o) => {
    const r = { op: o.op, line: o.line, a: ai, b: bi };
    if (o.op !== '+') ai++;
    if (o.op !== '-') bi++;
    return r;
  });
  // the newline at the end of the file differs and the last line is shared: it is a changed line on both sides
  if (A.noEol !== B.noEol && rows.length && rows[rows.length - 1].op === ' ') {
    const r = rows.pop();
    rows.push({ op: '-', line: r.line, a: r.a, b: r.b }, { op: '+', line: r.line, a: r.a + 1, b: r.b });
  }
  const changed = rows.map((r, i) => (r.op !== ' ' ? i : -1)).filter((i) => i >= 0);
  const hunks = [];
  let cur = null;
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(rows.length - 1, i + context);
    if (cur && lo <= cur.hi + 1) cur.hi = Math.max(cur.hi, hi);
    else { cur = { lo, hi }; hunks.push(cur); }
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const h of hunks) {
    const part = rows.slice(h.lo, h.hi + 1);
    const aLines = part.filter((r) => r.op !== '+');
    const bLines = part.filter((r) => r.op !== '-');
    const aStart = aLines.length ? aLines[0].a + 1 : part[0].a;
    const bStart = bLines.length ? bLines[0].b + 1 : part[0].b;
    out.push(`@@ -${aStart},${aLines.length} +${bStart},${bLines.length} @@`);
    for (const r of part) {
      out.push(r.op + r.line);
      if (r.op !== '+' && A.noEol && r.a === lastA - 1) out.push('\\ No newline at end of file');
      else if (r.op === '+' && B.noEol && r.b === lastB - 1) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}

/** Changed line count (removed + added) of a unified diff text. */
function diffStat(patch) {
  let add = 0;
  let del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { add, del };
}

module.exports = { unifiedDiff, diffLines, diffStat, splitLines, MAX_EDIT };
