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

  // ── mermaid (Task 3) ──

  // ── diagram recolour (Task 4) ──
})();
