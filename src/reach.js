'use strict';
// REACH1 glue for this listing (lane REACHE, module 2026-11-12.reach1 in src/license/reach1.js, copied by apply.sh).
// 1. A quiet Pro row inside the viewer's own toolbar: one small link per Pro tool with "3 free tries" / "N tries left"
//    (read from the same tries store as src/pro.js), then "Get Zovo Pro" and a close button. Never a popup, toast or
//    modal; it sits in the toolbar's normal layout, never over the file. Hidden when the user owns Pro, when the
//    listing's "show Pro tools" setting is off, and for the rest of the window session after a click on its close button.
// 2. Explorer right-click entries "Zovo Pro: <tool>" (commands <prefix>.zovoPro.<id>, menus written by apply.sh) that
//    run the existing tool command on the clicked file.
// 3. The surface of the click (toolbar or ctx) goes to license.requirePro, so the card link carries
//    <install id>_toolbar or <install id>_ctx. Clicks from anywhere else keep the card2 tags.
const reach1 = require('./license/reach1');

let current = '';
/** The surface of the Pro tool run in progress: 'toolbar', 'ctx' or '' (the gate passes it to requirePro). */
function currentSurface() { return current; }
/** Adds { surface } to a requirePro detail (string or object) only while a toolbar or ctx run is in progress. */
function withSurface(detail) {
  if (!current) return detail;
  if (detail && typeof detail === 'object') return Object.assign({}, detail, { surface: current });
  return { detail: detail || '', surface: current };
}
async function runAs(surface, fn) {
  const prev = current;
  current = surface;
  try { return await fn(); } finally { current = prev; }
}
/** True for the argument a webview toolbar link passes: { surface: 'toolbar' } (or [{...}]). */
function isToolbarArg(a) {
  const x = Array.isArray(a) ? a[0] : a;
  return !!(x && typeof x === 'object' && !x.scheme && x.surface === 'toolbar');
}

const CSS = '.zovo-reach1{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0 0 0 8px;font-size:11px;line-height:16px;vertical-align:middle}'
  + '.zovo-reach1[hidden]{display:none!important}'
  + '.zovo-reach1 a{color:var(--vscode-textLink-foreground);text-decoration:none;padding:0 5px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,transparent));border-radius:3px;white-space:nowrap}'
  + '.zovo-reach1 a:hover,.zovo-reach1 a:focus{text-decoration:underline}'
  + '.zovo-reach1 small{opacity:.75;font-size:10px}'
  + '.zovo-reach1-close{background:none;border:0;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:13px;line-height:16px}';

// Browser side: keeps the row inside the toolbar (slot) when the viewer redraws it, binds the close button with the
// module's bindToolbarRow, and tells the extension host so the row stays closed in other viewers of this session.
function bootScript(slot, html) {
  return `(function () {
  var CLOSED_KEY = ${JSON.stringify(reach1.CLOSED_KEY)};
  var bindToolbarRow = ${reach1.bindToolbarRow.toString()};
  var isClosed = ${reach1.isClosed.toString()};
  var ss = null; try { ss = window.sessionStorage; } catch (e) { ss = null; }
  var api = acquireVsCodeApi(); window.acquireVsCodeApi = function () { return api; };
  var SLOT = ${JSON.stringify(slot)}; var html = ${JSON.stringify(html).replace(/</g, '\\u003c')}; var row = null;
  function build() {
    if (row && row.parentNode) row.parentNode.removeChild(row);
    row = null;
    if (!html || isClosed(ss, CLOSED_KEY)) return;
    var t = document.createElement('template'); t.innerHTML = html; row = t.content.firstElementChild;
  }
  function place() {
    if (!row || row.hidden) return;
    var s = document.querySelector(SLOT);
    if (s && row.parentNode !== s) s.appendChild(row);
  }
  bindToolbarRow(document, { session: ss, key: CLOSED_KEY });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.zovo-reach1-close')) { html = ''; api.postMessage({ type: 'zovoReach1Closed' }); }
  });
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.type === 'zovoReach1') { html = typeof m.html === 'string' ? m.html : ''; build(); place(); }
  });
  build();
  new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
  place();
})();`;
}

/**
 * o: { vscode, context, prefix, triesKey, tools: [{ id, title, command, folder? }], slot (CSS selector of the toolbar),
 *      licensed(): bool, shown(): bool (the listing's own "show Pro tools" setting), maximum? (tries, default 3) }
 */
function createReach(o) {
  const { vscode, context, prefix, triesKey, slot } = o;
  const tools = (o.tools || []).filter((t) => t && t.id && t.title && t.command);
  const views = new Set();
  let closed = false;
  const licensed = () => { try { return !!(o.licensed && o.licensed()); } catch (e) { return false; } };
  const shown = () => { try { return o.shown ? o.shown() !== false : true; } catch (e) { return true; } };

  function rowHtml() {
    if (closed || licensed() || !shown()) return '';
    const tries = reach1.remainingTries(context.globalState, triesKey, tools, o.maximum || reach1.DEFAULT_TRIES);
    return reach1.renderToolbarRow({ tools, tries, commandPrefix: prefix, closed });
  }
  /** Style and boot script for the webview head; nonce is the page's CSP nonce. */
  function headHtml(nonce) {
    return `<style nonce="${nonce}">${CSS}</style>\n<script nonce="${nonce}">${bootScript(slot, rowHtml())}</script>`;
  }
  /** Command ids the webview's enableCommandUris must allow for the row. */
  const commandIds = () => [...new Set([...tools.map((t) => t.command), `${prefix}.getPro`])];
  function post(w) { try { const p = w.postMessage({ type: 'zovoReach1', html: rowHtml() }); if (p && p.then) p.then(undefined, () => false); } catch (e) { /* disposed */ } }
  function refresh() { for (const w of views) post(w); }
  /** Track a webview (custom editor or panel) so tries and license changes update its row. */
  function attach(webview, disposable) {
    views.add(webview);
    const d = { dispose() { views.delete(webview); } };
    if (disposable && typeof disposable.onDidDispose === 'function') disposable.onDidDispose(() => d.dispose());
    return d;
  }
  /** Handles the webview's close message; true when it was one. */
  function onMessage(msg) {
    if (!msg || msg.type !== 'zovoReach1Closed') return false;
    closed = true;
    refresh();
    return true;
  }
  /** Wraps a tool command handler: a toolbar link runs it like the palette (no argument) tagged toolbar. */
  function wrap(fn) {
    return (...args) => (isToolbarArg(args[0]) ? runAs('toolbar', () => fn()) : fn(...args));
  }
  /** Registers <prefix>.zovoPro.<id> for each tool: the Explorer entry runs the tool on the clicked file (its folder
   *  for folder tools), tagged ctx. */
  function registerCtx() {
    return tools.map((t) => {
      const d = vscode.commands.registerCommand(`${prefix}.zovoPro.${t.id}`, (uri, uris) => runAs('ctx', () => {
        const target = uri && uri.scheme && t.folder ? vscode.Uri.joinPath(uri, '..') : uri;
        return target && target.scheme ? vscode.commands.executeCommand(t.command, target, t.folder ? [target] : uris) : vscode.commands.executeCommand(t.command);
      }));
      context.subscriptions.push(d);
      return d;
    });
  }
  return { tools, rowHtml, headHtml, commandIds, refresh, attach, onMessage, wrap, registerCtx, get closed() { return closed; } };
}

module.exports = { createReach, currentSurface, withSurface, runAs, isToolbarArg, bootScript, CSS };
