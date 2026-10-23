#!/usr/bin/env node
'use strict';

// v3.17.0 T5 (D13, R33): lib/theme/runtime.js run in a vm with stubbed DOM
// and a stub `window.mermaid`, for what a browser run cannot pin cheaply: the
// order of mermaid renders on the runtime's serial chain. The diagram panel's
// preview (md2docTheme.renderMermaid) shares mermaid's ONE global config with
// the page's own light / dark draws, so a render that ran beside one of them
// could be drawn with the other's theme.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'theme', 'runtime.js'), 'utf8');
const LIGHT = { mark: 'light' };
const DARK = { mark: 'dark' };

function el(extra) {
  const attrs = {};
  const listeners = {};
  return Object.assign({
    hidden: true, textContent: '', innerHTML: '', parentNode: null,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    fire(t) { (listeners[t] || []).forEach((fn) => fn({})); },
  }, extra || {});
}

// One page: a theme toggle, the theme data, one `.content .mermaid` host (so
// the runtime owns a light and a dark draw of it), and a mermaid stub whose
// render() records the config active when it was called and settles on a
// timer, so two renders that were not chained would overlap.
function boot(opts) {
  const o = opts || {};
  const log = [];
  let active = 0;
  let maxActive = 0;
  let config = null;
  const strays = [];
  const host = el({ textContent: 'graph TD\n  A --> B' });
  const btn = el();
  const dataEl = el({ textContent: JSON.stringify({ mermaidLight: LIGHT, mermaidDark: DARK }) });
  const root = el();
  const winListeners = {};
  const body = el({ appendChild() {} });
  const document = {
    documentElement: root, body,
    getElementById(id) {
      if (id === 'md2doc-theme-toggle') return btn;
      if (id === 'md2doc-theme-data') return dataEl;
      const s = strays.find((x) => x.id === id && x.parentNode);
      return s || null;
    },
    querySelectorAll(sel) { return sel === '.content .mermaid' ? [host] : []; },
    querySelector() { return null; },
    createElement() { return { getContext() { return {}; } }; },
  };
  const mermaid = {
    initialize(c) { config = c.themeVariables; log.push({ init: c.themeVariables.mark }); },
    run(o2) { log.push({ run: config.mark }); (o2 && o2.nodes || []).forEach((n) => { n.innerHTML = 'LIGHT-MARKUP'; }); return Promise.resolve(); },
    render(id, src) {
      log.push({ render: src, theme: config.mark });
      active++; maxActive = Math.max(maxActive, active);
      return new Promise((resolve, reject) => setTimeout(() => {
        active--;
        if (o.fail && o.fail(src)) {
          // mermaid leaves a `#d<id>` element behind on a parse error.
          const stray = { id: 'd' + id, parentNode: null };
          stray.parentNode = { removeChild(n) { n.parentNode = null; } };
          strays.push(stray);
          reject(new Error('Parse error on line 1:\nmore'));
          return;
        }
        resolve({ svg: '<svg data-src="' + src + '" data-theme="' + config.mark + '"></svg>' });
      }, o.ms || 20));
    },
  };
  const window = {
    mermaid,
    matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
  };
  const ctx = {
    window, document, setTimeout, Promise, JSON, Map, WeakMap, Math,
    getComputedStyle() { return { display: 'none' }; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  };
  ctx.window.document = document;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return {
    ctx, log, host, strays,
    theme: ctx.window.md2docTheme,
    toggle() { btn.fire('click'); },
    load() { (winListeners.load || []).forEach((fn) => fn({})); },
    maxActive: () => maxActive,
    settle: () => new Promise((r) => setTimeout(r, 400)),
  };
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A render whose turn comes after a toggle is drawn in the new theme.
check('a render queued before a toggle but run after it is drawn in the new theme', async () => {
  const p = boot();
  const a = p.theme.renderMermaid('A');
  p.toggle();
  assert.ok(/data-theme="dark"/.test(await a));
});
check('renderMermaid exists and resolves the svg text', async () => {
  const p = boot();
  assert.strictEqual(typeof p.theme.renderMermaid, 'function');
  const svg = await p.theme.renderMermaid('graph LR\n  X --> Y');
  assert.strictEqual(svg, '<svg data-src="graph LR\n  X --> Y" data-theme="light"></svg>');
});

// The brief's row: two concurrent renderMermaid calls and a theme switch run
// in chain order, each with the config of the theme on screen at its turn, never two at once, and
// the last initialize() is the light config (the runtime's invariant).
check('two renders and a theme switch run in chain order; the last initialize is light', async () => {
  const p = boot();
  p.log.length = 0;
  const a = p.theme.renderMermaid('A');
  // A's turn has started (its render is out, light on screen) when the
  // toggle lands: the dark draw of the page's own host must wait behind it.
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(p.log.filter((e) => e.render !== undefined), [{ render: 'A', theme: 'light' }], 'guard: A is out');
  p.toggle(); // dark: the page's own host is drawn dark, queued behind A
  const b = p.theme.renderMermaid('B');
  const [sa, sb] = await Promise.all([a, b]);
  await p.settle();
  const renders = p.log.filter((e) => e.render !== undefined);
  assert.deepStrictEqual(renders, [
    { render: 'A', theme: 'light' },
    { render: 'graph TD\n  A --> B', theme: 'dark' },
    { render: 'B', theme: 'dark' },
  ]);
  assert.strictEqual(p.maxActive(), 1, 'never two renders at once');
  assert.ok(/data-theme="light"/.test(sa) && /data-theme="dark"/.test(sb), 'each drawn in its own turn\'s theme');
  assert.deepStrictEqual(p.log[p.log.length - 1], { init: 'light' }, 'the final initialize is the light config');
});

check('a failed render rejects with the error, removes the stray #d<id>, and leaves light configured', async () => {
  const p = boot({ fail: (src) => src === 'bad' });
  p.log.length = 0;
  let err = null;
  try { await p.theme.renderMermaid('bad'); } catch (e) { err = e; }
  assert.ok(err && /^Parse error on line 1:/.test(err.message), 'rejected: ' + (err && err.message));
  assert.strictEqual(p.strays.length, 1, 'guard: the stub left one stray');
  assert.strictEqual(p.strays[0].parentNode, null, 'the stray was removed');
  assert.deepStrictEqual(p.log[p.log.length - 1], { init: 'light' });
  // The chain is still usable after a failure.
  assert.ok(/data-src="ok"/.test(await p.theme.renderMermaid('ok')));
});

// R33: a preview render counts as in flight like the runtime's own draws, so
// a toggle to a cached theme while it is out is queued, not swapped under it.
check('a pending preview render keeps a toggle to a cached theme on the chain (inFlight)', async () => {
  const p = boot({ ms: 60 });
  p.load(); // the light draw (mermaid.run) caches the host's light markup
  await p.settle();
  assert.strictEqual(p.host.innerHTML, 'LIGHT-MARKUP', 'guard: the light draw ran');
  p.toggle(); // dark: drawn once and cached
  await p.settle();
  assert.ok(/data-theme="dark"/.test(p.host.innerHTML), 'guard: the host shows the dark draw');
  const pending = p.theme.renderMermaid('C');
  p.toggle(); // back to light: cached, but a render is in flight
  assert.ok(/data-theme="dark"/.test(p.host.innerHTML), 'not swapped synchronously while the preview render is out');
  await pending;
  await p.settle();
  assert.strictEqual(p.host.innerHTML, 'LIGHT-MARKUP', 'swapped once it was its turn');
});

check('renderMermaid rejects when mermaid is not on the page', async () => {
  const p = boot();
  delete p.ctx.window.mermaid;
  let err = null;
  try { await p.theme.renderMermaid('A'); } catch (e) { err = e; }
  assert.ok(err, 'rejected');
});

// Fix round 1 (M3): a listener that unsubscribes itself while notify() runs
// must not make the next listener miss the switch.
check('a theme listener removing itself mid-notify does not skip the next one', () => {
  const p = boot();
  const seen = [];
  let off = null;
  off = p.theme.onTheme(() => { seen.push('first'); off(); });
  p.theme.onTheme((dark) => { seen.push('second:' + dark); });
  p.toggle();
  assert.deepStrictEqual(seen, ['first', 'second:true']);
  p.toggle();
  assert.deepStrictEqual(seen, ['first', 'second:true', 'second:false'], 'the first is gone for good');
});
check('the runtime never contains a closing script tag', () => {
  assert.strictEqual(SRC.indexOf('</' + 'script'), -1);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log('ok   ' + c.name); } catch (e) { failed++; console.log('FAIL ' + c.name + '\n     ' + (e && e.message)); }
  }
  if (failed) { console.error(failed + ' of ' + checks.length + ' theme-runtime check(s) failed'); process.exit(1); }
  console.log('theme-runtime.test.js OK (' + checks.length + ' checks)');
})();
