'use strict';
// Runs inside a real VS Code (extension host) during the release gate. Started by scripts/gate-vscode.mjs with
// --extensionTestsPath. It formats every file of the gate manifest through VS Code's own formatting command,
// compares the result with the shfmt CLI output, and checks diagnostics, format on save, selections, CRLF,
// the size limit and the skipped file types. Results go to the JSON file in GATE_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function applyEdits(doc, edits) {
  const text = doc.getText();
  const list = (edits || []).map((e) => ({ s: doc.offsetAt(e.range.start), e: doc.offsetAt(e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s);
  let out = text;
  for (const x of list) out = out.slice(0, x.s) + x.t.replace(/\r?\n/g, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n') + out.slice(x.e);
  return out;
}

const ours = (uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'Shell Formatter');

async function formatFile(file, options, lang) {
  const uri = vscode.Uri.file(file);
  let doc = await vscode.workspace.openTextDocument(uri);
  if (lang && doc.languageId !== lang) doc = await vscode.languages.setTextDocumentLanguage(doc, lang);
  const t0 = Date.now();
  const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', uri, options || { tabSize: 4, insertSpaces: false });
  const ms = Date.now() - t0;
  return { doc, uri, edits: edits || [], ms, result: applyEdits(doc, edits) };
}

exports.run = async function run() {
  const manifest = JSON.parse(fs.readFileSync(process.env.GATE_MANIFEST, 'utf8'));
  const results = { started: new Date().toISOString(), vscode: vscode.version, platform: process.platform, arch: process.arch, files: [], checks: [] };
  const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 400) });
  const save = () => fs.writeFileSync(process.env.GATE_OUT, JSON.stringify(results, null, 1));
  try {
    const ext = vscode.extensions.getExtension('zovo.zovo-shell-formatter');
    check('extension installed', !!ext, ext && ext.extensionPath);
    const api = await ext.activate();
    check('activates and reports the engine version', api && api.engineVersion === '3.14.1', api && api.engineVersion);
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['shellFormatter.format', 'shellFormatter.setDefault', 'shellFormatter.formatOnSave', 'shellFormatter.copyCommand',
      'shellFormatter.openSample', 'shellFormatter.openWalkthrough', 'shellFormatter.supportDeveloper', 'shellFormatter.moreViewers', 'shellFormatter.menu']) {
      check('command ' + c, cmds.includes(c));
    }
    const rss0 = process.memoryUsage().rss;

    // 1. Every manifest file through VS Code's formatting command.
    for (const item of manifest.files) {
      const row = { file: path.basename(item.file), size: fs.statSync(item.file).size, expect: item.expect };
      try {
        const r = await formatFile(item.file, item.options, item.lang);
        const got = r.result.replace(/\r\n/g, '\n');
        row.ms = r.ms;
        row.edits = r.edits.length;
        row.diagnostics = ours(r.uri).map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
        if (item.expect === 'format') {
          row.ok = got === item.expected;
          if (!row.ok) {
            const a = got.split('\n');
            const b = item.expected.split('\n');
            const i = a.findIndex((l, k) => l !== b[k]);
            row.detail = `first difference on line ${i + 1}: got ${JSON.stringify(a[i])} expected ${JSON.stringify(b[i])}`;
          }
        } else if (item.expect === 'error') {
          row.ok = r.edits.length === 0 && row.diagnostics.length === 1 && (!item.line || row.diagnostics[0].startsWith(item.line + ':'));
          row.detail = row.diagnostics.join(' | ');
        } else { // 'none': skipped or refused, no edit and no diagnostic
          row.ok = r.edits.length === 0 && row.diagnostics.length === 0;
        }
        if (item.maxMs) { row.maxMs = item.maxMs; row.ok = row.ok && r.ms < item.maxMs; }
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // VS Code itself refuses to open some binary files as text: nothing can be formatted, which is the goal.
        row.ok = item.expect === 'none' && /binary/i.test(msg);
        row.detail = (row.ok ? 'VS Code refused to open it as text: ' : 'threw: ') + msg.slice(0, 200);
      }
      results.files.push(row);
      save();
    }
    results.extHostRssMB = { before: Math.round(rss0 / 1e6), after: Math.round(process.memoryUsage().rss / 1e6) };

    // 2. The file is unchanged on disk after a syntax error, and the diagnostic goes away after a fix.
    const errFile = manifest.files.find((f) => f.expect === 'error');
    if (errFile) {
      const before = fs.readFileSync(errFile.file, 'utf8');
      const doc = await vscode.workspace.openTextDocument(errFile.file);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await sleep(500);
      check('syntax error: editor text unchanged', doc.getText() === before);
      check('syntax error: file on disk unchanged', fs.readFileSync(errFile.file, 'utf8') === before);
      check('syntax error: one diagnostic in Problems', ours(doc.uri).length === 1, ours(doc.uri).map((d) => d.message).join(' | '));
    }

    // 3. Format on save writes the formatted text to disk.
    const saveFile = manifest.saveTest;
    if (saveFile) {
      const doc = await vscode.workspace.openTextDocument(saveFile.file);
      const ed = await vscode.window.showTextDocument(doc);
      await ed.edit((b) => b.insert(new vscode.Position(1, 0), '# saved\n'));
      await vscode.commands.executeCommand('workbench.action.files.save');
      await sleep(800);
      const disk = fs.readFileSync(saveFile.file, 'utf8');
      check('format on save writes shfmt output to disk', disk === saveFile.expected, disk.slice(0, 200));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    // 4. CRLF stays CRLF after the edit is applied.
    if (manifest.crlf) {
      const doc = await vscode.workspace.openTextDocument(manifest.crlf.file);
      const ed = await vscode.window.showTextDocument(doc);
      check('CRLF file opens as CRLF', doc.eol === vscode.EndOfLine.CRLF);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await sleep(400);
      check('CRLF kept after formatting', doc.eol === vscode.EndOfLine.CRLF && doc.getText().includes('\r\n'));
      check('CRLF result equals shfmt output', doc.getText().replace(/\r\n/g, '\n') === manifest.crlf.expected);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      void ed;
    }

    // 5. Format Selection inside an indented block.
    {
      const doc = await vscode.workspace.openTextDocument({ language: 'shellscript', content: 'main() {\n    if true;then\n        echo   hi;fi\n}\n' });
      await vscode.window.showTextDocument(doc);
      const edits = await vscode.commands.executeCommand('vscode.executeFormatRangeProvider', doc.uri, new vscode.Range(1, 0, 2, 20), { tabSize: 4, insertSpaces: true });
      const out = applyEdits(doc, edits);
      check('format selection keeps the outer indent', out === 'main() {\n    if true; then\n        echo hi\n    fi\n}\n', JSON.stringify(out));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }

    // 6. Untitled script, indent from the editor (2 spaces).
    {
      const doc = await vscode.workspace.openTextDocument({ language: 'shellscript', content: 'for i in 1 2;do\necho $i;done\n' });
      const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true });
      check('untitled script formats with the editor indent', applyEdits(doc, edits) === 'for i in 1 2; do\n  echo $i\ndone\n', JSON.stringify(applyEdits(doc, edits)));
    }

    // 7. Our own command formats even when another formatter is the default.
    if (manifest.commandTest) {
      const doc = await vscode.workspace.openTextDocument(manifest.commandTest.file);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('shellFormatter.format');
      await sleep(400);
      check('Shell Formatter: Format This Script command', doc.getText() === manifest.commandTest.expected);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }

    // 8. The walkthrough sample opens as an untitled shell script.
    await vscode.commands.executeCommand('shellFormatter.openSample');
    await sleep(300);
    const sample = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    check('sample opens untitled, not on disk', sample && sample.isUntitled && sample.languageId === 'shellscript' && /Deploy a build/.test(sample.getText()));
    if (sample) await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  } catch (e) {
    check('runner', false, e && e.stack ? e.stack : e);
  }
  results.finished = new Date().toISOString();
  save();
};
