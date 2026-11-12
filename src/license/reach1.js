'use strict';

const DEFAULT_TRIES = 3;
const CLOSED_KEY = 'zovo.reach1.closed';

function triesLabel(left) {
  const n = Math.max(0, Number(left) || 0);
  return n === DEFAULT_TRIES ? '3 free tries' : `${n} ${n === 1 ? 'try' : 'tries'} left`;
}

function remainingTries(globalState, key, tools, maximum = DEFAULT_TRIES) {
  const used = globalState && typeof globalState.get === 'function' ? globalState.get(key) || {} : {};
  return Object.fromEntries((tools || []).map((tool) => [tool.id, Math.max(0, maximum - (Number(used[tool.id]) || 0))]));
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function commandUri(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function renderToolbarRow({ tools = [], tries = {}, commandPrefix, closed = false, getProLabel = 'Get Zovo Pro' } = {}) {
  if (closed || !Array.isArray(tools) || tools.length === 0) return '';
  const buttons = tools.map((tool) => {
    if (!tool || !tool.id || !tool.title || !tool.command) return '';
    const label = triesLabel(tries[tool.id]);
    return `<a class="zovo-reach1-tool" href="${esc(commandUri(tool.command, [{ surface: 'toolbar' }]))}" aria-label="${esc(`${tool.title}, ${label}`)}">${esc(tool.title)} <small>${esc(label)}</small></a>`;
  }).filter(Boolean).join('');
  if (!buttons) return '';
  const buy = commandUri(`${commandPrefix}.getPro`, [{ surface: 'toolbar' }]);
  return `<nav class="zovo-reach1" aria-label="Zovo Pro tools">${buttons}<a class="zovo-reach1-buy" href="${esc(buy)}">${esc(getProLabel)}</a><button class="zovo-reach1-close" type="button" aria-label="Close Pro tools row">×</button></nav>`;
}

function bindToolbarRow(root, { session = globalThis.sessionStorage, key = CLOSED_KEY } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return { dispose() {} };
  const click = (event) => {
    const close = event.target && event.target.closest && event.target.closest('.zovo-reach1-close');
    if (!close) return;
    if (session && typeof session.setItem === 'function') session.setItem(key, '1');
    const row = close.closest('.zovo-reach1');
    if (row) row.hidden = true;
  };
  root.addEventListener('click', click);
  return { dispose() { root.removeEventListener('click', click); } };
}

function isClosed(session = globalThis.sessionStorage, key = CLOSED_KEY) {
  return !!(session && typeof session.getItem === 'function' && session.getItem(key) === '1');
}

function explorerMenus(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((t) => t && t.command && t.title && Array.isArray(t.extensions) && t.extensions.length)
    .flatMap((tool) => tool.extensions.map((extension) => ({
      command: tool.command,
      title: `Zovo Pro: ${tool.title}`,
      when: `resourceExtname == ${extension.startsWith('.') ? extension : `.${extension}`}`,
      group: 'zovoPro@1',
    })));
}

module.exports = { DEFAULT_TRIES, CLOSED_KEY, triesLabel, remainingTries, renderToolbarRow, bindToolbarRow, isClosed, explorerMenus };
