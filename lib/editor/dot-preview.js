'use strict';
// A kept-alive worker thread for the Graphviz preview. Created on the first
// preview, reused for every later one. An engine error comes back as an
// ordinary Error (the server answers 422 with its first line); a worker that
// dies takes its in-flight requests down with an Error flagged `crashed`
// (the server answers 500), and the next request starts a fresh worker.
const path = require('path');
const { Worker } = require('worker_threads');

function createDotPreview() {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  // Only the requests that belong to `w` die with it: a worker that was
  // closed or replaced reports its exit late, after a new one took over.
  function failAll(err, w) {
    for (const [id, p] of pending) {
      if (w !== undefined && p.worker !== w) continue;
      p.reject(err);
      pending.delete(id);
    }
  }
  function start() {
    const w = new Worker(path.join(__dirname, 'dot-worker.js'));
    // An idle worker must not keep the process (or a test) alive.
    w.unref();
    w.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.svg);
    });
    const dead = (err) => {
      if (worker === w) worker = null;
      const e = new Error(String((err && err.message) || 'graphviz worker exited'));
      e.crashed = true;
      failAll(e, w);
    };
    w.on('error', dead);
    w.on('exit', () => dead(null));
    return w;
  }
  return {
    render(source) {
      if (worker === null) worker = start();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, worker });
        // A request in flight keeps the loop alive until it answers.
        worker.ref();
        worker.postMessage({ id, source });
      }).finally(() => { if (pending.size === 0 && worker !== null) worker.unref(); });
    },
    close() {
      const w = worker;
      worker = null;
      if (w !== null) w.terminate();
      failAll(Object.assign(new Error('graphviz worker closed'), { crashed: true }));
    },
  };
}

module.exports = { createDotPreview };
