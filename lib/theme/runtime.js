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
  var data = JSON.parse(dataEl.textContent);
  var listeners = [];
  function onTheme(fn) { listeners.push(fn); }
  function notify(dark) { for (var i = 0; i < listeners.length; i++) listeners[i](dark); }
  function isDark() { return root.getAttribute('data-md2doc-theme') === 'dark'; }
  function save(dark) {
    try {
      if (dark) localStorage.setItem(KEY, 'dark'); else localStorage.removeItem(KEY);
    } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }
  function paint() {
    var dark = isDark();
    var label = dark ? '深色（點一下切換到淺色）' : '淺色（點一下切換到深色）';
    btn.textContent = dark ? '☾' : '☀';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  btn.addEventListener('click', function () {
    var dark = !isDark();
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
    if (bar && phone.matches) { if (btn.parentNode !== bar) bar.appendChild(btn); }
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
  function mermaidConfig(theme) {
    return { startOnLoad: false, theme: 'base', themeVariables: theme === 'dark' ? data.mermaidDark : data.mermaidLight };
  }
  function swapMermaid(theme) {
    mermaids.forEach(function (el, i) { el.innerHTML = rendered[theme][i]; });
  }
  function drawMermaid(theme) {
    window.mermaid.initialize(mermaidConfig(theme));
    mermaids.forEach(function (el) { el.removeAttribute('data-processed'); el.textContent = el.getAttribute('data-md2doc-src'); });
    return window.mermaid.run({ nodes: mermaids }).then(function () {
      if (theme === 'dark') mermaids.forEach(function (el) { var s = el.querySelector('svg'); if (s) s.setAttribute('data-md2doc-recoloured', ''); });
      rendered[theme] = mermaids.map(function (el) { return el.innerHTML; });
    });
  }
  function showMermaid(dark) {
    if (!hasMermaid) return;
    var theme = dark ? 'dark' : 'light';
    // Synchronous when nothing is drawing and the render is cached: print needs that.
    // Known limit: if beforeprint fires while a dark draw is in flight, the light swap
    // is queued behind it, so that print snapshot can catch the raw mermaid source.
    if (!inFlight && rendered[theme]) { swapMermaid(theme); return; }
    inFlight++;
    chain = chain.then(function () { return rendered[theme] ? swapMermaid(theme) : drawMermaid(theme); })
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
    onTheme(showMermaid);
  }

  // ── graphviz / WaveDrom / baked SVG: recolour by computed colour ──
  // Rules: spec "Diagram recolour rules (D10)". Reading COMPUTED fill/stroke
  // covers both graphviz presentation attributes and WaveDrom's own <style>.
  var INK = '#c4c7cc';
  var TEXT = '#e3e3e3';
  var RECOLOUR = '.content .graphviz svg, .content [id^="WaveDrom_Display_"] svg, .content .wavedrom-diagram svg' +
    (hasMermaid ? '' : ', .content .mermaid svg');
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
  function recolourSvg(svg, dark) {
    var els = svg.querySelectorAll('polygon, ellipse, path, polyline, rect, line, circle, text, tspan');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.hasAttribute('data-md2doc-style')) {
        var orig = el.getAttribute('data-md2doc-style');
        if (orig) el.setAttribute('style', orig); else el.removeAttribute('style');
      } else {
        el.setAttribute('data-md2doc-style', el.getAttribute('style') || '');
      }
      if (!dark) continue;
      var cs = getComputedStyle(el);
      var fill = rgba(cs.fill), stroke = rgba(cs.stroke);
      // Overrides are written once, as attribute text, never through el.style:
      // setProperty leaves style="" on the element after the restore removes
      // the attribute (Chromium re-serialises it), so light would not be
      // byte-exact.
      var ov = '';
      if (/^(text|tspan)$/i.test(el.tagName)) {
        if (fill && fill[3] > 0 && lum(fill) < 0.35) ov += 'fill:' + (hsl(fill)[1] > 0.25 ? tone(fill, 0.78, 0.7) : TEXT) + ' !important;';
      } else {
        if (fill && fill[3] > 0) {
          var L = lum(fill);
          if (L > 0.85) ov += 'fill:transparent !important;';
          else if (L > 0.3) ov += 'fill:' + tone(fill, 0.26, 0.55) + ' !important;';
          else if (el.closest('g.edge')) ov += 'fill:' + lineColour(fill) + ' !important;';
        }
        if (stroke && stroke[3] > 0 && lum(stroke) < 0.35) ov += 'stroke:' + lineColour(stroke) + ' !important;';
      }
      if (ov) {
        var base = el.getAttribute('data-md2doc-style');
        el.setAttribute('style', (base ? base.replace(/;?\s*$/, ';') : '') + ov);
      }
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
          var svgs = node.matches && node.matches(RECOLOUR) ? [node] : (node.querySelectorAll ? node.querySelectorAll(RECOLOUR) : []);
          for (var k = 0; k < svgs.length; k++) recolourSvg(svgs[k], true);
        }
      }
    }).observe(content, { childList: true, subtree: true });
  }
  if (isDark()) recolourAll(true);
})();
