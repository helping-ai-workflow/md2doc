// md2doc reader theme toggle (v3.9.0). Inlined into reader HTML by
// lib/theme/tokens.js#applyReaderTheme — plain browser JS, not part of the
// lib/md2doc.js template literal. Must never contain a closing script tag.
// Spec: docs/superpowers/specs/2026-10-02-dark-mode-design.md
(function () {
  'use strict';
  var KEY = 'md2doc-theme';
  var root = document.documentElement;
  var btn = document.getElementById('md2doc-theme-toggle');
  var dataEl = document.getElementById('md2doc-theme-data');
  if (!btn || !dataEl) return;
  btn.hidden = false;
  var data = JSON.parse(dataEl.textContent);
  var listeners = [];
  // Returns the unsubscribe: a page that draws and discards its own svgs (the
  // wave editor's canvas, once per open) must not leave a listener behind
  // holding what it drew.
  function onTheme(fn) {
    listeners.push(fn);
    return function () {
      var at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  }
  // Over a copy: a listener may unsubscribe itself (or another) while it
  // runs, and a splice under the loop would skip the next one.
  function notify(dark) { var ls = listeners.slice(); for (var i = 0; i < ls.length; i++) ls[i](dark); }
  function isDark() { return root.getAttribute('data-md2doc-theme') === 'dark'; }
  function save(dark) {
    try {
      if (dark) localStorage.setItem(KEY, 'dark'); else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }
  function paint() {
    var dark = isDark();
    var label = dark ? 'Dark theme (click for light)' : 'Light theme (click for dark)';
    btn.textContent = dark ? '☾' : '☀';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  btn.addEventListener('click', function () {
    var dark = !isDark();
    // Measured while the light layout is still clean: see prepareGeometry. A
    // failure there only costs that speed-up; the toggle must still work.
    if (dark) { try { prepareGeometry(); } catch (e) { /* recolourSvg measures lazily instead */ } }
    if (dark) root.setAttribute('data-md2doc-theme', 'dark'); else root.removeAttribute('data-md2doc-theme');
    save(dark);
    paint();
    notify(dark);
  });

  // Phone (<= 1080px): the one button moves into the 44px top bar. A document
  // with no headings has no bar, so the button keeps floating there.
  var bar = document.getElementById('mobile-bar');
  var phone = window.matchMedia('(max-width: 1080px)');
  function place() {
    // Edit mode hides #mobile-bar; a button moved into it would vanish, so the
    // bar has to be on screen, not merely in the DOM.
    var barShown = bar && getComputedStyle(bar).display !== 'none';
    if (barShown && phone.matches) { if (btn.parentNode !== bar) bar.appendChild(btn); }
    else if (btn.parentNode !== document.body) document.body.appendChild(btn);
  }
  if (phone.addEventListener) phone.addEventListener('change', place); else if (phone.addListener) phone.addListener(place);
  place();

  // Print is always light. The dark tokens are @media screen only; the
  // listeners put diagrams back to their light form while printing.
  var printedDark = false;
  window.addEventListener('beforeprint', function () { printedDark = isDark(); if (printedDark) notify(false); });
  window.addEventListener('afterprint', function () { if (printedDark) notify(true); printedDark = false; });

  paint();

  // ── mermaid: light and dark each drawn once, then swapped as markup ──
  // The runtime takes over md2doc's own startOnLoad render (mermaid reads
  // startOnLoad from its config at window load), draws light first so print
  // and toggle-back always have it, and draws dark the first time it is needed.
  var mermaids = [].slice.call(document.querySelectorAll('.content .mermaid'));
  var hasMermaid = typeof window.mermaid !== 'undefined' && mermaids.length > 0;
  var rendered = { light: null, dark: null };
  var chain = Promise.resolve();
  var inFlight = 0;
  // Which render the hosts hold. The observer below must not recolour a light
  // render that is shown on purpose (print while dark swaps light back in).
  var mermaidShown = 'light';
  function mermaidConfig(theme) {
    return { startOnLoad: false, theme: 'base', themeVariables: theme === 'dark' ? data.mermaidDark : data.mermaidLight };
  }
  function swapMermaid(theme) {
    mermaidShown = theme;
    mermaids.forEach(function (el, i) { el.innerHTML = rendered[theme][i]; });
  }
  function cached(theme) {
    var r = rendered[theme];
    if (!r) return false;
    for (var i = 0; i < mermaids.length; i++) if (typeof r[i] !== 'string') return false;
    return true;
  }
  // Light: mermaid.run over the source-text hosts, which is what shows mermaid's
  // own error box for a broken diagram. run() rejects after one, so the cache is
  // stored either way; otherwise every toggle would redraw everything.
  function drawLight() {
    window.mermaid.initialize(mermaidConfig('light'));
    mermaidShown = 'light';
    mermaids.forEach(function (el) { el.removeAttribute('data-processed'); el.textContent = el.getAttribute('data-md2doc-src'); });
    function store() { rendered.light = mermaids.map(function (el) { return el.innerHTML; }); }
    return window.mermaid.run({ nodes: mermaids }).then(store, function (e) { store(); throw e; });
  }
  // Dark: no host is touched until its own svg is ready, so the page never
  // collapses to source text (WebKit has no scroll anchoring and would lose the
  // reading position). A broken diagram keeps its current markup.
  function drawDark() {
    window.mermaid.initialize(mermaidConfig('dark'));
    mermaidShown = 'dark';
    rendered.dark = [];
    var p = Promise.resolve();
    mermaids.forEach(function (el, i) {
      p = p.then(function () {
        return window.mermaid.render('md2doc-mermaid-dark-' + i, el.getAttribute('data-md2doc-src')).then(function (res) {
          el.innerHTML = res.svg;
          if (res.bindFunctions) res.bindFunctions(el);
          var s = el.querySelector('svg');
          if (s) { s.setAttribute('data-md2doc-recoloured', ''); s.setAttribute('data-md2doc-live', ''); }
        }, function () {
          var stray = document.getElementById('dmd2doc-mermaid-dark-' + i);
          if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
          // The host keeps its light render (mermaid's error box); it was drawn light, so it needs the full recolour.
          var kept = el.querySelector('svg');
          if (kept && !kept.hasAttribute('data-md2doc-live')) recolourSvg(kept, isDark());
        }).then(function () { rendered.dark[i] = el.innerHTML; });
      });
    });
    return p.then(function () { window.mermaid.initialize(mermaidConfig('light')); });
  }
  function drawMermaid(theme) { return theme === 'dark' ? drawDark() : drawLight(); }
  function showMermaid(dark) {
    if (!hasMermaid) return;
    var theme = dark ? 'dark' : 'light';
    // Synchronous when nothing is drawing and the render is cached: print needs that.
    // Known limit: if beforeprint fires while a dark draw is in flight, the light swap
    // is queued behind it, so that print snapshot can catch the raw mermaid source.
    if (!inFlight && cached(theme)) { swapMermaid(theme); return; }
    inFlight++;
    chain = chain.then(function () { return cached(theme) ? swapMermaid(theme) : drawMermaid(theme); })
      .catch(function () { /* a failed render leaves mermaid's own error box */ })
      .then(function () { inFlight--; });
  }
  if (hasMermaid) {
    mermaids.forEach(function (el) { el.setAttribute('data-md2doc-src', el.textContent); });
    window.mermaid.initialize(mermaidConfig('light'));
    window.addEventListener('load', function () {
      showMermaid(false);
      if (isDark()) showMermaid(true);
    });
  }
  // Registered even with no mermaid at load: an edit can add the first one
  // (showMermaid() itself returns early while there is none).
  onTheme(showMermaid);

  // v3.10.0: the editor rebuilds the blocks an edit touched and hands the new
  // .mermaid hosts to __md2docInitDiagrams (lib/md2doc.js). Those hosts are not
  // in `mermaids` (captured at load), so they used to be drawn by mermaid's own
  // init with whatever config was set last — light — and then picked up the
  // generic recolour of a light-drawn svg: transparent node fills in dark.
  // __md2docInitDiagrams now calls this instead. It re-reads the hosts in the
  // document, carries every unchanged host's cached light/dark markup over,
  // and draws only the new ones, in the theme on screen, on the same chain a
  // toggle uses. The other theme is drawn for them the next time it is asked
  // for (cached() is false while any entry is missing).
  var freshSeq = 0;
  function adoptMermaids() {
    var now = [].slice.call(document.querySelectorAll('.content .mermaid'));
    var at = new Map();
    mermaids.forEach(function (el, i) { at.set(el, i); });
    function carry(r) { return r ? now.map(function (el) { return at.has(el) ? r[at.get(el)] : undefined; }) : null; }
    rendered = { light: carry(rendered.light), dark: carry(rendered.dark) };
    var fresh = now.filter(function (el) { return !at.has(el); });
    fresh.forEach(function (el) { if (!el.hasAttribute('data-md2doc-src')) el.setAttribute('data-md2doc-src', el.textContent); });
    mermaids = now;
    hasMermaid = now.length > 0;
    return fresh;
  }
  function drawFresh(els, theme) {
    window.mermaid.initialize(mermaidConfig(theme));
    var p = Promise.resolve();
    els.forEach(function (el) {
      p = p.then(function () {
        var i = mermaids.indexOf(el);
        if (i < 0) return;
        var id = 'md2doc-mermaid-' + theme + '-new-' + (++freshSeq);
        var src = el.getAttribute('data-md2doc-src');
        return window.mermaid.render(id, src).then(function (res) {
          el.innerHTML = res.svg;
          if (res.bindFunctions) res.bindFunctions(el);
          el.setAttribute('data-processed', 'true');
          var svg = el.querySelector('svg');
          if (svg && theme === 'dark') { svg.setAttribute('data-md2doc-recoloured', ''); svg.setAttribute('data-md2doc-live', ''); }
          if (rendered[theme]) rendered[theme][i] = el.innerHTML;
        }, function () {
          var stray = document.getElementById('d' + id);
          if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
          // A broken diagram shows mermaid's own error box, drawn light (the
          // observer gives it the full recolour in dark), like drawLight().
          window.mermaid.initialize(mermaidConfig('light'));
          el.removeAttribute('data-processed');
          el.textContent = src;
          return window.mermaid.run({ nodes: [el] }).catch(function () {});
        });
      });
    });
    return p.then(function () { window.mermaid.initialize(mermaidConfig('light')); });
  }
  // The re-read itself waits its turn on the chain: a full drawLight() /
  // drawDark() already running indexes `mermaids` and `rendered` by the
  // order it started with, so swapping either under it would file one host's
  // markup under another (and store a new host's source text as its light
  // render). Until its turn, a new host simply shows its source text.
  window.__md2docThemeMermaid = function () {
    if (typeof window.mermaid === 'undefined') return false;
    inFlight++;
    chain = chain.then(function () {
      var fresh = adoptMermaids();
      if (!fresh.length) return;
      var theme = isDark() ? 'dark' : 'light';
      mermaidShown = theme;
      return drawFresh(fresh, theme);
    })
      .catch(function () { /* each host already fell back to mermaid's own error box */ })
      .then(function () { inFlight--; });
    return true;
  };

  // v3.17.0 (D13): one off-page render for the editor's diagram panel preview.
  // It waits its turn on the same chain, because mermaid has ONE global config
  // and a render beside a light / dark draw could be drawn with the other's
  // theme. Its turn initialises the theme on screen at that moment, renders
  // under a fresh id, and puts the light config back after (the invariant
  // every draw here keeps). Resolves the svg text; rejects with mermaid's
  // error, its stray #d<id> element removed. Counted in inFlight like the
  // draws, so a toggle to a cached theme waits behind it too.
  var previewSeq = 0;
  function renderMermaid(src) {
    if (typeof window.mermaid === 'undefined') return Promise.reject(new Error('mermaid is not loaded'));
    inFlight++;
    var run = chain.then(function () {
      var id = 'md2doc-mermaid-preview-' + (++previewSeq);
      window.mermaid.initialize(mermaidConfig(isDark() ? 'dark' : 'light'));
      return Promise.resolve().then(function () { return window.mermaid.render(id, String(src)); }).then(function (res) {
        window.mermaid.initialize(mermaidConfig('light'));
        return res.svg;
      }, function (e) {
        var stray = document.getElementById('d' + id);
        if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
        window.mermaid.initialize(mermaidConfig('light'));
        throw e;
      });
    });
    chain = run.catch(function () { /* the caller shows the error */ }).then(function () { inFlight--; });
    return run;
  }

  // ── graphviz / WaveDrom / baked SVG: recolour by computed colour ──
  // Rules: spec "Diagram recolour rules (D10)". Reading COMPUTED fill/stroke
  // covers both graphviz presentation attributes and WaveDrom's own <style>.
  var INK = '#c4c7cc';
  var TEXT = '#e3e3e3';
  // .mermaid svg is always included. A live dark render (data-md2doc-live, set by drawDark)
  // keeps mermaid's own arrowheads, markers and edges: only its labels and node shapes
  // carrying an author style are recoloured. A baked or light-drawn mermaid svg gets the full rules.
  var RECOLOUR = '.content .graphviz svg, .content [id^="WaveDrom_Display_"] svg, .content .wavedrom-diagram svg, .content .mermaid svg';
  var XHTML = 'http://www.w3.org/1999/xhtml';
  // Saturation caps are the spec D10 values: 0.7 for text, 0.8 for lines, 0.55 for fills.
  var probe = document.createElement('canvas').getContext('2d');
  function rgba(c) {
    if (!c || c === 'none' || c.indexOf('url(') === 0) return null;
    var m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) {
      probe.fillStyle = '#000'; probe.fillStyle = c; c = probe.fillStyle;
      if (c.charAt(0) === '#') return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
      m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
    }
    var p = m[1].split(',').map(parseFloat);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2, h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function tone(c, l, smax) {
    var x = hsl(c);
    return 'hsl(' + Math.round(x[0]) + ', ' + Math.round(Math.min(x[1], smax) * 100) + '%, ' + Math.round(l * 100) + '%)';
  }
  function lineColour(c) { return hsl(c)[1] > 0.25 ? tone(c, 0.68, 0.8) : INK; }
  // WaveDrom draws every edge label (and point note) as g > rect + text inside wavearcs_N, the
  // white rect masking the edge and waveform behind the words. Made transparent like other
  // near-white fills, the line runs straight through the text in dark; it takes the page
  // colour instead. Only this shape: graphviz/mermaid white fills still go transparent.
  function isWaveLabelBacking(el) {
    var next = el.nextElementSibling;
    return /^rect$/i.test(el.tagName) && next !== null && /^text$/i.test(next.tagName) &&
      el.closest('[id^="wavearcs"]') !== null;
  }
  function contrast(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // ── Where a text sits (R7 option A) ──
  // Geometry is kept apart from colour: a text's STACK is every shape before it in
  // document order (= paint order) whose fill AREA covers the text's centre, bottom
  // to top, whatever its fill. That is the same in light and dark, so the toggle
  // measures it BEFORE the theme attribute flips, while the page layout is still
  // clean (prepareGeometry), and keeps it per svg; a read after the flip would force
  // a synchronous layout of the whole restyled page. Colour is applied afterwards:
  // the stack's FINAL fills are composited (fill alpha x fill-opacity x opacity of
  // the shape and its ancestors) over the page, so a semi-transparent cell counts as
  // the colour it really shows.
  var PAINTED = 'polygon, ellipse, path, rect, circle';
  var NOT_PAINTED = 'defs, marker, clipPath, mask, pattern, symbol, foreignObject';
  var geoCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  // A mermaid XHTML label is measured by its foreignObject.
  function geoOf(el) { return el.namespaceURI === XHTML ? el.closest('foreignObject') : el; }
  function centreOf(g) {
    if (!g || typeof g.getBBox !== 'function') return null;
    var b, m;
    try { b = g.getBBox(); m = g.getCTM(); } catch (e) { return null; }
    if (!m || (!b.width && !b.height)) return null;
    return new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(m);
  }
  function geomShapes(svg) {
    var all = svg.querySelectorAll(PAINTED), list = [];
    for (var i = 0; i < all.length; i++) {
      var s = all[i], b, m;
      if (s.closest(NOT_PAINTED) || typeof s.isPointInFill !== 'function') continue;
      try { b = s.getBBox(); m = s.getCTM(); } catch (e) { continue; }
      if (!m) continue;
      // Its box in viewport units, for a cheap reject before isPointInFill.
      var xs = [], ys = [], cs = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]];
      for (var c = 0; c < 4; c++) { var q = new DOMPoint(cs[c][0], cs[c][1]).matrixTransform(m); xs.push(q.x); ys.push(q.y); }
      list.push({ el: s, m: m, vp: s.nearestViewportElement,
        box: [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)] });
    }
    return list;
  }
  // null when the element has no geometry (detached, display:none).
  function stackAt(g, shapes) {
    var p = centreOf(g);
    if (!p) return null;
    var vp = g.nearestViewportElement, stack = [];
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i];
      if (s.vp !== vp || p.x < s.box[0] || p.x > s.box[2] || p.y < s.box[1] || p.y > s.box[3]) continue;
      if (!(s.el.compareDocumentPosition(g) & 4)) break; // document order: every later shape follows g too
      if (s.el.isPointInFill(p.matrixTransform(s.m.inverse()))) stack.push(s.el);
    }
    return stack;
  }
  // A mermaid svg is rebuilt from markup on every theme swap (new elements, same
  // drawing), so its stacks are ALSO kept per host and per render kind (light / live
  // dark) as indices: the n-th text or foreignObject over the m-th shapes. A swapped-in
  // svg with the same counts adopts them without reading geometry.
  var GEO_EL = 'text, tspan, foreignObject';
  var hostGeo = typeof WeakMap === 'function' ? new WeakMap() : null;
  function hostEntry(svg, make) {
    var host = hostGeo && svg.closest('.mermaid');
    if (!host) return null;
    var kind = svg.hasAttribute('data-md2doc-live') ? 'live' : 'light';
    var all = hostGeo.get(host) || {};
    var nT = svg.querySelectorAll(GEO_EL).length, nS = svg.querySelectorAll(PAINTED).length, e = all[kind];
    if (!e || e.nT !== nT || e.nS !== nS) {
      if (!make) return null;
      e = all[kind] = { nT: nT, nS: nS, map: {} };
      hostGeo.set(host, all);
    }
    return e;
  }
  function adopt(svg) {
    var e = geoCache && hostEntry(svg, false);
    if (!e) return;
    var keep = geoCache.get(svg) || new Map(), gl = svg.querySelectorAll(GEO_EL), sl = svg.querySelectorAll(PAINTED);
    for (var t in e.map) {
      var g = gl[+t];
      if (g && !keep.has(g)) keep.set(g, e.map[t].map(function (n) { return sl[n]; }));
    }
    if (keep.size) geoCache.set(svg, keep);
  }
  // An element with no geometry (empty label, display:none) is remembered for the
  // current toggle only (geoGen): it may be shown before the next one.
  var noGeo = typeof WeakMap === 'function' ? new WeakMap() : null, geoGen = 0;
  // Measures the given geometry elements of one svg and remembers each stack.
  function measure(svg, gs) {
    var shapes = null, keep = geoCache ? geoCache.get(svg) || new Map() : new Map(), out = new Map();
    for (var i = 0; i < gs.length; i++) {
      var g = gs[i];
      if (!g || out.has(g)) continue;
      if (shapes === null) shapes = geomShapes(svg);
      var st = stackAt(g, shapes);
      out.set(g, st);
      if (st) keep.set(g, st); else if (noGeo) noGeo.set(g, geoGen);
    }
    if (geoCache && keep.size) geoCache.set(svg, keep);
    var e = keep.size ? hostEntry(svg, true) : null;
    if (e) {
      var gl = [].slice.call(svg.querySelectorAll(GEO_EL)), sl = [].slice.call(svg.querySelectorAll(PAINTED));
      out.forEach(function (st, g) {
        if (st) e.map[gl.indexOf(g)] = st.map(function (s) { return sl.indexOf(s); });
      });
    }
    return out;
  }
  // Called by the toggle before it flips to dark. A light-drawn mermaid svg is
  // measured too (it is recoloured until the live dark render arrives) unless that
  // dark render is cached: then the swap replaces it before anything is recoloured.
  function prepareGeometry() {
    if (!geoCache) return;
    geoGen++;
    var swapsNow = hasMermaid && !inFlight && cached('dark');
    var svgs = document.querySelectorAll(RECOLOUR);
    for (var i = 0; i < svgs.length; i++) {
      var svg = svgs[i], gs = [];
      if (swapsNow && svg.closest('.mermaid')) continue;
      adopt(svg);
      var known = geoCache.get(svg), ts = svg.querySelectorAll('text, tspan, foreignObject *');
      for (var k = 0; k < ts.length; k++) {
        var g = geoOf(ts[k]);
        // Every text, not only the dark ones: an inherited colour can turn dark (or
        // light) with the page once the theme flips.
        if (g && !(known && known.has(g)) && !(noGeo && noGeo.get(g) === geoGen)) gs.push(g);
      }
      if (gs.length) measure(svg, gs);
    }
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 1 : n; }
  // A shape's final paint as [r, g, b, alpha], or null when it shows nothing.
  function paintOf(s, svg, memo) {
    if (memo.has(s)) return memo.get(s);
    var cs = getComputedStyle(s), f = rgba(cs.fill), out = null;
    if (f) {
      var a = f[3] * num(cs.fillOpacity) * num(cs.opacity);
      for (var p = s.parentNode; a > 0 && p && p !== svg && p.nodeType === 1; p = p.parentNode) a *= num(getComputedStyle(p).opacity);
      if (a > 0) out = [f[0], f[1], f[2], Math.min(a, 1)];
    }
    memo.set(s, out);
    return out;
  }
  // The colour under a text: its stack composited over the page; null when nothing
  // in the stack paints (the text then keeps the old rule).
  function composite(stack, page, svg, memo) {
    var c = null;
    for (var i = 0; i < stack.length; i++) {
      var p = paintOf(stack[i], svg, memo);
      if (!p) continue;
      if (!c) c = page.slice(0, 3);
      c = [p[0] * p[3] + c[0] * (1 - p[3]), p[1] * p[3] + c[1] * (1 - p[3]), p[2] * p[3] + c[2] * (1 - p[3])];
    }
    return c ? [c[0], c[1], c[2], 1] : null;
  }
  // No geometry at recolour time (a diagram hidden while the theme flips): the text
  // could sit on any shape of its own node or cluster, so it is judged against all
  // of them: each shape's paint composited over the page, or the page where a shape
  // paints nothing (a table cell without a bgcolor). Text in no node keeps the old rule.
  function nodeFallback(el, page, svg, memo) {
    var n = el.closest('g.node, g.cluster');
    if (!n) return null;
    var pg = [page[0], page[1], page[2], 1], all = n.querySelectorAll(PAINTED), out = [], seen = {};
    for (var i = 0; i < all.length; i++) {
      if (all[i].closest('foreignObject')) continue;
      var c = composite([all[i]], page, svg, memo) || pg;
      if (!seen[c.join()]) { seen[c.join()] = 1; out.push(c); }
    }
    return out.length ? out : [pg];
  }
  // R7 option A: a dark text keeps its author colour unless the rule's replacement
  // (a toned colour for saturated text) or #e3e3e3 reads better on what is under it.
  // `unders` is the colour under it (one entry) or, with no geometry, every colour it
  // might sit on: each option is scored by its WORST contrast over them, the best
  // score wins, ties keep the author's then the toned colour. null = keep the
  // author's colour. Over no shape (unders null): the old rule (the replacement).
  // Shapes are never changed here.
  function textFor(own, unders) {
    var cand = hsl(own)[1] > 0.25 ? tone(own, 0.78, 0.7) : TEXT;
    if (!unders) return cand;
    var opts = cand === TEXT ? [null, TEXT] : [null, cand, TEXT], best = null, bestC = -1;
    for (var i = 0; i < opts.length; i++) {
      var col = opts[i] === null ? own : rgba(opts[i]), worst = Infinity;
      for (var u = 0; u < unders.length; u++) worst = Math.min(worst, contrast(col, unders[u]));
      if (worst > bestC) { best = opts[i]; bestC = worst; }
    }
    return best;
  }
  function decide(own, unders, memo) {
    var key = own.join() + '|' + (unders ? unders.map(function (u) { return u.join(); }).join(';') : '');
    if (!(key in memo)) memo[key] = textFor(own, unders);
    return memo[key];
  }
  function restyle(el, ov) {
    if (!ov) return;
    var base = el.getAttribute('data-md2doc-style');
    el.setAttribute('style', (base ? base.replace(/;?\s*$/, ';') : '') + ov);
  }
  function recolourSvg(svg, dark, opts) {
    var backing = (opts && opts.backing) || 'var(--md-bg)';
    var els = svg.querySelectorAll('polygon, ellipse, path, polyline, rect, line, circle, text, tspan, foreignObject *');
    var live = svg.hasAttribute('data-md2doc-live');
    var texts = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-md2doc-style')) {
        var orig = el.getAttribute('data-md2doc-style');
        if (orig) el.setAttribute('style', orig); else el.removeAttribute('style');
      } else {
        if (live && el.namespaceURI !== XHTML) {
          var own = el.getAttribute('style') || '';
          // Only what the author styled: node and subgraph shapes, linkStyle edges, text. Never "any inline style":
          // mermaid writes its own fill and stroke inline (pie legend rects), and markers keep their theme colours.
          if (el.closest('marker') || !/(^|;)\s*(fill|stroke)\s*:/.test(own) ||
              !(el.closest('g.node, g.cluster') || el.matches('.flowchart-link') || /^(text|tspan)$/i.test(el.tagName))) continue;
        }
        el.setAttribute('data-md2doc-style', el.getAttribute('style') || '');
      }
      if (!dark) continue;
      // Texts and mermaid's XHTML labels wait for the second pass, so each one
      // is paired with the FINAL fill of its own shape whatever the document order.
      if (el.namespaceURI === XHTML || /^(text|tspan)$/i.test(el.tagName)) { texts.push(el); continue; }
      var cs = getComputedStyle(el);
      var ov = '';
      var fill = rgba(cs.fill), stroke = rgba(cs.stroke);
      // Overrides are written once, as attribute text, never through el.style:
      // setProperty leaves style="" on the element after the restore removes
      // the attribute (Chromium re-serialises it), so light would not be
      // byte-exact.
      if (fill && fill[3] > 0) {
        var L = lum(fill);
        if (L > 0.85) ov += isWaveLabelBacking(el) ? 'fill:' + backing + ' !important;' : 'fill:transparent !important;';
        else if (L > 0.3) ov += 'fill:' + tone(fill, 0.26, 0.55) + ' !important;';
        else if (el.closest('g.edge, marker')) ov += 'fill:' + lineColour(fill) + ' !important;';
      }
      if (stroke && stroke[3] > 0 && lum(stroke) < 0.35) ov += 'stroke:' + lineColour(stroke) + ' !important;';
      restyle(el, ov);
    }
    // Only a dark text has a choice to make. It uses the stack measured before the
    // toggle flipped the theme when there is one. Otherwise geometry is read only
    // when the choice can differ between what the text might sit on (each opaque
    // paint, or none; any translucent paint always measures): reading it forces a
    // synchronous layout, which a freshly drawn svg (the wave editor redraws on every
    // edit) has not had yet. An svg text's own fill is read here once and reused
    // below: the writes below would otherwise force a style recalc before every read.
    var memo = {}, paints = new Map(), unders = [], owns = [], need = [], fills = null, translucent = false;
    if (dark) adopt(svg);
    var known = geoCache && geoCache.get(svg), page = null;
    function pageColour() {
      if (page) return page;
      var bk = opts && opts.backing;
      page = (bk && /^rgba?\(/.test(bk) ? rgba(bk) : null) || rgba(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
      return page;
    }
    for (var k = 0; k < texts.length; k++) {
      var kc = owns[k] = rgba(texts[k].namespaceURI === XHTML ? getComputedStyle(texts[k]).color : getComputedStyle(texts[k]).fill);
      if (!kc || kc[3] === 0 || lum(kc) >= 0.35) continue;
      var st = known && known.get(geoOf(texts[k]));
      if (st && st.every(function (s) { return svg.contains(s); })) { var cu = composite(st, pageColour(), svg, paints); unders[k] = cu ? [cu] : null; continue; }
      var kg = geoOf(texts[k]);
      if (noGeo && kg && noGeo.get(kg) === geoGen) { unders[k] = nodeFallback(texts[k], pageColour(), svg, paints); continue; }
      if (fills === null) {
        fills = [];
        var all = svg.querySelectorAll(PAINTED), seen = {};
        for (var q = 0; q < all.length; q++) {
          if (all[q].closest(NOT_PAINTED)) continue;
          var pq = paintOf(all[q], svg, paints);
          if (!pq) continue;
          if (pq[3] < 1) translucent = true;
          else if (!seen[pq.join()]) { seen[pq.join()] = 1; fills.push(pq); }
        }
      }
      var first = decide(kc, null, memo), differs = translucent;
      for (var w = 0; w < fills.length && !differs; w++) differs = decide(kc, [fills[w]], memo) !== first;
      if (differs) need.push(k);
    }
    if (need.length) {
      var got = measure(svg, need.map(function (n) { return geoOf(texts[n]); }));
      for (var r = 0; r < need.length; r++) {
        var ns = got.get(geoOf(texts[need[r]]));
        var nc = ns ? composite(ns, pageColour(), svg, paints) : null;
        unders[need[r]] = ns ? (nc ? [nc] : null) : nodeFallback(texts[need[r]], pageColour(), svg, paints);
      }
    }
    for (var j = 0; j < texts.length; j++) {
      var t = texts[j], tov = '';
      if (t.namespaceURI === XHTML) {
        // Mermaid flowchart labels: HTML inside foreignObject, coloured by CSS.
        // Read again: a label inherits the colour its parent was just given.
        var tcs = getComputedStyle(t), fg = rgba(tcs.color), bgc = rgba(tcs.backgroundColor);
        if (fg && fg[3] > 0 && lum(fg) < 0.35) {
          var fc = decide(fg, unders[j], memo);
          if (fc) tov += 'color:' + fc + ' !important;';
        }
        if (bgc && bgc[3] > 0) {
          var BL = lum(bgc);
          if (BL > 0.85) tov += 'background-color:transparent !important;';
          else if (BL > 0.3) tov += 'background-color:' + tone(bgc, 0.26, 0.55) + ' !important;';
        }
      } else {
        var tf = owns[j];
        if (tf && tf[3] > 0 && lum(tf) < 0.35) {
          var tc = decide(tf, unders[j], memo);
          if (tc) tov += 'fill:' + tc + ' !important;';
        }
      }
      restyle(t, tov);
    }
    if (dark) svg.setAttribute('data-md2doc-recoloured', ''); else svg.removeAttribute('data-md2doc-recoloured');
  }
  function recolourAll(dark) {
    var svgs = document.querySelectorAll(RECOLOUR);
    for (var i = 0; i < svgs.length; i++) recolourSvg(svgs[i], dark);
  }
  onTheme(recolourAll);
  // WaveDrom draws again at DOMContentLoaded, load, +250ms and +1000ms; watch
  // for inserted svgs instead of copying that schedule (same reasoning as
  // applyDiagramScale's observer in lib/md2doc.js).
  var content = document.querySelector('.content');
  if (content && typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      if (!isDark()) return;
      for (var r = 0; r < records.length; r++) {
        var added = records[r].addedNodes;
        for (var a = 0; a < added.length; a++) {
          var node = added[a];
          if (!node || node.nodeType !== 1) continue;
          if (mermaidShown === 'light' && node.closest && node.closest('.mermaid')) continue;
          var svgs = node.matches && node.matches(RECOLOUR) ? [node] : (node.querySelectorAll ? node.querySelectorAll(RECOLOUR) : []);
          for (var k = 0; k < svgs.length; k++) recolourSvg(svgs[k], true);
        }
      }
    }).observe(content, { childList: true, subtree: true });
  }
  if (isDark()) recolourAll(true);
  // Public surface for pages that draw their own SVG outside .content (the wave editor canvas).
  // `__listenerCount` is a test hook (test/editor-click.test.js): the wave
  // editor subscribes once per open and must unsubscribe on close.
  window.md2docTheme = { isDark: isDark, onTheme: onTheme, recolourSvg: recolourSvg, renderMermaid: renderMermaid,
    __listenerCount: function () { return listeners.length; } };
})();
