'use strict';
// The three Zovo Pro tools of Shell Formatter:
//   folder  Format all shell scripts in a folder (check first, then format them all or show a report)
//   check   Formatting check with a patch file (nothing is changed: one unified diff of what formatting would do)
//   minify  Minify a script to a copy (name.min.sh next to it, original unchanged)
// All use the same shfmt engine, settings, .editorconfig and same-commands check as Format Document (formatText).
// No network. A free try counts only after a result: files formatted, a report or a patch with changes opened, or a
// minified copy written. Cancel, Escape, "no scripts" and "nothing to change" never use one.
const path = require('path');
const { unifiedDiff, diffStat } = require('./patch');

const EXT_RE = /\.(sh|bash|zsh|ksh|mksh|bats)$/i;
const NAME_RE = /^(\.?bashrc|\.?bash_profile|\.?bash_aliases|\.?bash_login|\.?bash_logout|\.?zshrc|\.?zshenv|\.?zprofile|\.?zlogin|\.?zlogout|\.?profile|PKGBUILD|APKBUILD|\.envrc)$/;
const SHEBANG_RE = /^#!\s*\S*\/(?:env\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|ksh|mksh|dash|ash|bats|ksh93|bash\d[\d.]*)\b/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.venv', 'venv', 'vendor', '__pycache__', 'bower_components']);
const MAX_FILES = 5000;
const NO_EXT_MAX = 1024 * 1024; // extensionless files above this size are not opened to look for a shebang
const MENU_EXTS = ['.sh', '.bash', '.zsh', '.ksh', '.mksh', '.bats'];

/** True when the first line of an extensionless file names a shell. */
function isShellShebang(firstLine) {
  return SHEBANG_RE.test(String(firstLine || ''));
}

/** Name of the minified copy: deploy.sh -> deploy.min.sh, run -> run.min, .bashrc -> .bashrc.min */
function minName(name) {
  const m = /^(.+?)(\.(?:sh|bash|zsh|ksh|mksh|bats))$/i.exec(name);
  return m ? `${m[1]}.min${m[2]}` : `${name}.min`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** " Zovo Pro: N of 3 free tries left for this tool." after a counted try (empty with Pro). */
function triesNote(pro, f) {
  if (pro.licensed) return '';
  const n = pro.left(f);
  return ` Zovo Pro: ${n} of ${pro.TRIAL_USES || 3} free tries left for this tool.`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * deps: { vscode, pro, formatText(uri, text, { minify }) -> Promise<{ ok, text?, kind?, message?, line?, dialect?, flags? }>,
 *         decode(bytes) -> string }
 */
function createProTools(deps) {
  const { vscode, pro, formatText } = deps;
  const decode = deps.decode || ((b) => Buffer.from(b).toString('utf8'));

  async function readText(uri) { return decode(await vscode.workspace.fs.readFile(uri)); }

  /** Shell scripts under a folder: by file name, or an extensionless file whose first line names a shell. */
  async function listScripts(folder) {
    const out = [];
    const queue = [folder];
    while (queue.length && out.length < MAX_FILES) {
      const dir = queue.shift();
      let entries;
      try { entries = await vscode.workspace.fs.readDirectory(dir); } catch { continue; }
      entries.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
      for (const [name, type] of entries) {
        const u = vscode.Uri.joinPath(dir, name);
        if (type & vscode.FileType.SymbolicLink) continue; // never follow links out of the folder
        if (type & vscode.FileType.Directory) { if (!SKIP_DIRS.has(name) && !(name.startsWith('.') && name !== '.github')) queue.push(u); continue; }
        if (!(type & vscode.FileType.File)) continue;
        if (EXT_RE.test(name) || NAME_RE.test(name)) out.push(u);
        else if (!path.extname(name)) {
          try {
            const st = await vscode.workspace.fs.stat(u);
            if (st.size > 2 && st.size <= NO_EXT_MAX) {
              const head = (await readText(u)).slice(0, 200).split('\n', 1)[0];
              if (isShellShebang(head)) out.push(u);
            }
          } catch { /* unreadable: not a script for us */ }
        }
        if (out.length >= MAX_FILES) break;
      }
    }
    return out;
  }

  const relOf = (folder, uri) => path.posix.relative(folder.path, uri.path);

  async function pickFolder(arg, title) {
    if (arg && arg.scheme) {
      try {
        const st = await vscode.workspace.fs.stat(arg);
        if (st.type & vscode.FileType.Directory) return arg;
        return vscode.Uri.joinPath(arg, '..');
      } catch { return arg; }
    }
    const ws = vscode.workspace.workspaceFolders || [];
    if (ws.length) {
      // The open folders first (no system dialog), then any other folder.
      const items = ws.map((f) => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath || f.uri.path, uri: f.uri }));
      items.push({ label: '$(folder-opened) Choose another folder...', uri: null });
      const p = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick a folder; its subfolders are included' });
      if (!p) return undefined;
      if (p.uri) return p.uri;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title, openLabel: 'Use this folder', defaultUri: ws[0] ? ws[0].uri : undefined });
    return picked && picked[0];
  }

  /** Runs formatText on every script; null when cancelled. Rows: { uri, rel, before, after, status, why, dialect } */
  async function checkAll(folder, uris, title) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
      const rows = [];
      for (let i = 0; i < uris.length; i++) {
        if (token.isCancellationRequested) return null;
        const rel = relOf(folder, uris[i]);
        progress.report({ message: `${i + 1} of ${uris.length}: ${rel}`, increment: 100 / uris.length });
        const row = { uri: uris[i], rel };
        try {
          const raw = await readText(uris[i]);
          const before = raw.replace(/\r\n/g, '\n');
          const r = await formatText(uris[i], raw, {});
          row.before = before;
          row.dialect = r.dialect || '';
          row.flags = r.flags || '';
          if (r.ok) {
            row.after = r.text;
            row.status = r.text !== before ? 'changes' : 'formatted already';
          } else if (r.kind === 'skip') { row.status = 'skipped'; row.why = r.message; }
          else { row.status = 'not formatted'; row.why = `${r.message}${r.line ? ` (line ${r.line})` : ''}`; }
        } catch (e) {
          row.status = 'not formatted';
          row.why = e && e.message ? e.message : String(e);
        }
        rows.push(row);
      }
      return rows;
    });
  }

  function reportMarkdown(folder, rows, heading) {
    const cell = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [`# ${heading}: ${path.posix.basename(folder.path) || folder.path}`, '',
      `${plural(rows.length, 'script')} checked on ${new Date().toISOString().slice(0, 10)} with the same shfmt engine, settings and .editorconfig as Format Document.`, '',
      '| Script | Result | Dialect | Detail |', '| --- | --- | --- | --- |'];
    for (const r of rows) {
      let detail = r.why || '';
      if (!detail && r.after !== undefined && r.after !== r.before) {
        const st = diffStat(unifiedDiff(r.before, r.after, r.rel));
        detail = `${st.del} line${st.del === 1 ? '' : 's'} out, ${st.add} in`;
      }
      lines.push(`| ${cell(r.rel)} | ${cell(r.status)} | ${cell(r.dialect)} | ${cell(detail)} |`);
    }
    return lines.join('\n') + '\n';
  }

  async function openUntitled(language, content) {
    const doc = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }

  // ---- folder: Format all shell scripts in a folder ----
  async function formatFolder(arg) {
    if (!(await pro.allowed('folder'))) return;
    const folder = await pickFolder(arg, 'Folder of shell scripts to format');
    if (!folder) return;
    const uris = await listScripts(folder);
    if (!uris.length) { vscode.window.showInformationMessage(`No shell scripts in ${path.posix.basename(folder.path)}. No free try was used.`); return; }
    const rows = await checkAll(folder, uris, `Checking ${plural(uris.length, 'shell script')}`);
    if (!rows) return;
    const changes = rows.filter((r) => r.status === 'changes');
    const failed = rows.filter((r) => r.status === 'not formatted');
    const summary = `${changes.length} of ${plural(rows.length, 'script')} would change${failed.length ? `, ${failed.length} cannot be formatted` : ''}.`;
    if (!changes.length && !failed.length) {
      vscode.window.showInformationMessage(`All ${plural(rows.length, 'shell script')} in ${path.posix.basename(folder.path)} are formatted already. No free try was used.`);
      return;
    }
    const items = [];
    if (changes.length) items.push({ label: `Format ${plural(changes.length, 'script')}`, description: 'save each file; Undo works per file', act: 'apply' });
    items.push({ label: 'Show the report only', description: 'a Markdown list of every script, nothing is changed', act: 'report' });
    const pick = await vscode.window.showQuickPick(items, { title: summary, placeHolder: 'Pick what to do' });
    if (!pick) return;
    if (pick.act === 'apply') {
      let done = 0;
      let stale = 0;
      for (const r of changes) {
        try {
          const doc = await vscode.workspace.openTextDocument(r.uri);
          if (doc.getText().replace(/\r\n/g, '\n') !== r.before) { stale++; r.status = 'changed while checking, left as it is'; continue; }
          const we = new vscode.WorkspaceEdit();
          we.replace(r.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), r.after);
          if (await vscode.workspace.applyEdit(we)) { await doc.save(); done++; r.status = 'formatted'; }
          else r.status = 'could not be changed';
        } catch (e) { r.status = 'could not be changed'; r.why = e && e.message ? e.message : String(e); }
      }
      await openUntitled('markdown', reportMarkdown(folder, rows, 'Shell scripts formatted'));
      if (done) await pro.produced('folder');
      vscode.window.showInformationMessage(`Formatted ${plural(done, 'shell script')}${stale ? `; ${stale} changed while checking and were left as they are` : ''}.${done ? triesNote(pro, 'folder') : ' No free try was used.'}`);
      return;
    }
    await openUntitled('markdown', reportMarkdown(folder, rows, 'Shell formatting report'));
    await pro.produced('folder');
  }

  // ---- check: Formatting check with a patch file ----
  function patchText(folder, rows) {
    const changes = rows.filter((r) => r.status === 'changes');
    const failed = rows.filter((r) => r.status === 'not formatted');
    const head = [
      `# Shell formatting check: ${path.posix.basename(folder.path) || folder.path} (${new Date().toISOString().slice(0, 10)})`,
      `# ${plural(rows.length, 'script')} checked, ${changes.length} not formatted, ${failed.length} with errors.`,
      '# Apply from that folder: patch -p1 < this-file, or git apply this-file when the folder is the repository root.',
    ];
    if (changes.length) head.push('#', '# Not formatted:', ...changes.map((r) => `#   ${r.rel}`));
    if (failed.length) head.push('#', '# Not formatted because of an error:', ...failed.map((r) => `#   ${r.rel}: ${String(r.why || '').replace(/\n/g, ' ')}`));
    const flags = changes.find((r) => r.flags) || {};
    head.push('#', `# The same check in CI: shfmt -d${flags.flags ? ' ' + flags.flags : ''} .   (shfmt reads the same .editorconfig keys)`);
    return head.join('\n') + '\n' + changes.map((r) => unifiedDiff(r.before, r.after, r.rel)).join('');
  }

  async function checkFolder(arg) {
    if (!(await pro.allowed('check'))) return;
    const folder = await pickFolder(arg, 'Folder of shell scripts to check');
    if (!folder) return;
    const uris = await listScripts(folder);
    if (!uris.length) { vscode.window.showInformationMessage(`No shell scripts in ${path.posix.basename(folder.path)}. No free try was used.`); return; }
    const rows = await checkAll(folder, uris, `Checking ${plural(uris.length, 'shell script')}`);
    if (!rows) return;
    const changes = rows.filter((r) => r.status === 'changes');
    const failed = rows.filter((r) => r.status === 'not formatted');
    if (!changes.length && !failed.length) {
      vscode.window.showInformationMessage(`All ${plural(rows.length, 'shell script')} in ${path.posix.basename(folder.path)} are formatted. No patch needed, no free try was used.`);
      return;
    }
    const text = patchText(folder, rows);
    await openUntitled('diff', text);
    await pro.produced('check');
    vscode.window.setStatusBarMessage(`$(check) Shell Formatter: ${changes.length} of ${plural(rows.length, 'script')} not formatted. Nothing was changed.${triesNote(pro, 'check')}`, 10000);
  }

  // ---- minify: Minify a script to a copy ----
  async function minifyCopy(arg) {
    if (!(await pro.allowed('minify'))) return;
    let src = arg && arg.scheme ? arg : null;
    const ed = vscode.window.activeTextEditor;
    let text;
    if (!src && ed && ['shellscript', 'bats'].includes(ed.document.languageId)) {
      src = ed.document.uri;
      text = ed.document.getText();
    }
    if (!src) {
      const p = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Shell script to minify', openLabel: 'Minify a copy' });
      src = p && p[0];
    }
    if (!src) return;
    if (text === undefined) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === src.toString());
      text = open ? open.getText() : await readText(src);
    }
    const r = await formatText(src, text, { minify: true });
    if (!r.ok) {
      vscode.window.showWarningMessage(`Minify: ${r.message}${r.line ? ` (line ${r.line})` : ''}. No copy was written and no free try was used.`);
      return;
    }
    const before = text.replace(/\r\n/g, '\n');
    const name = path.posix.basename(src.path) || 'script';
    if (src.scheme === 'untitled') {
      await openUntitled('shellscript', r.text);
      await pro.produced('minify');
      return;
    }
    const target = vscode.Uri.joinPath(src, '..', minName(name));
    let exists = false;
    try { await vscode.workspace.fs.stat(target); exists = true; } catch { exists = false; }
    if (exists) {
      const ok = await vscode.window.showWarningMessage(`${minName(name)} exists. Replace it with the new minified copy?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(r.text, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });
    await pro.produced('minify');
    const a = Buffer.byteLength(before, 'utf8');
    const b = Buffer.byteLength(r.text, 'utf8');
    vscode.window.setStatusBarMessage(`$(check) ${minName(name)}: ${fmtBytes(a)} to ${fmtBytes(b)}${a ? ` (${Math.round((1 - b / a) * 100)} % smaller)` : ''}, same commands${r.verified ? ' (checked)' : ''}. ${name} is unchanged.${triesNote(pro, 'minify')}`, 10000);
  }

  return { formatFolder, checkFolder, minifyCopy, listScripts, patchText, reportMarkdown };
}

module.exports = { createProTools, isShellShebang, minName, MENU_EXTS, EXT_RE, SKIP_DIRS };
