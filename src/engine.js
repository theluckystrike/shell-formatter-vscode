'use strict';
// Host side of the formatter: one worker thread, one request at a time, a time limit per request.
// When a request runs past the limit, the worker is terminated (its memory goes with it) and the next
// request starts a fresh one. No VS Code import, so tests can run it in plain Node.
const { Worker } = require('node:worker_threads');

// The mvdan/sh (shfmt) version inside sh-syntax 0.8.1. test/engine.test.js checks it against the package.
const SHFMT_VERSION = '3.14.1';

class Engine {
  /** opts: { workerPath, wasmPath, timeoutMs } */
  constructor(opts) {
    this.workerPath = opts.workerPath;
    this.wasmPath = opts.wasmPath;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.restarts = 0;
  }

  start() {
    if (this.worker) return this.worker;
    const w = new Worker(this.workerPath, { workerData: { wasmPath: this.wasmPath } });
    w.unref();
    w.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
    });
    const fail = (e) => {
      if (this.worker === w) this.worker = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, kind: 'engine', message: 'The formatter stopped: ' + ((e && e.message) || e) });
      }
      this.pending.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => { if (this.worker === w) fail(new Error('exit code ' + code)); });
    this.worker = w;
    return w;
  }

  /** Kills the worker. The next request starts a new one. */
  reset() {
    const w = this.worker;
    this.worker = null;
    if (w) w.terminate().catch(() => {});
  }

  request(msg, timeoutMs) {
    const run = () => new Promise((resolve) => {
      const w = this.start();
      const id = ++this.seq;
      const limit = timeoutMs || this.timeoutMs;
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.restarts++;
        this.reset();
        resolve({ id, ok: false, kind: 'timeout', message: `Formatting took longer than ${Math.round(limit / 1000)} s and was stopped. The file is unchanged.` });
      }, limit);
      this.pending.set(id, { resolve, timer });
      w.postMessage(Object.assign({}, msg, { id }));
    });
    // One at a time: requests wait for the one before them.
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** text, opts (sh-syntax options), name (file name, for messages), verify (bool), timeoutMs */
  format(text, opts, name, verify, timeoutMs) {
    return this.request({ op: 'format', text, opts, name, verify: !!verify }, timeoutMs);
  }

  dispose() {
    this.reset();
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
  }
}

module.exports = { Engine, SHFMT_VERSION };
