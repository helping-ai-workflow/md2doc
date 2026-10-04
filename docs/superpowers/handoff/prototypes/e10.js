const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const h = require('./hl/node_modules/highlight.js/lib/core'); h.registerLanguage('markdown', require('./hl/node_modules/highlight.js/lib/languages/markdown'));
const R1 = `
textarea.ed-source{font:13px/1.65 "Cascadia Mono",Consolas,ui-monospace,monospace!important;background:var(--e-bar)!important;color:var(--e-ink)!important;border:0!important;outline:0!important;
  box-shadow:0 0 0 1px var(--e-rule)!important;border-radius:8px!important;padding:16px 20px!important;width:100%!important;box-sizing:border-box!important;height:calc(100vh - 44px - 32px)!important;resize:none!important;display:block}
body[data-ed-mode="source"] .toc{display:block!important}
.e-src-wrap{position:relative;width:100%}
.e-hl{position:absolute;inset:0;margin:0;padding:16px 20px;font:13px/1.65 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;color:var(--e-ink);pointer-events:none;overflow:hidden;box-sizing:border-box;border-radius:8px}
.e-hl .hljs-section{color:var(--hk);font-weight:700}.e-hl .hljs-bullet{color:var(--ht)}.e-hl .hljs-code{color:var(--hn)}.e-hl .hljs-strong{font-weight:700}.e-hl .hljs-emphasis{font-style:italic}.e-hl .hljs-link{color:var(--hc)}.e-hl .hljs-string{color:var(--hf)}.e-hl .hljs-quote{color:var(--hc)}
:root{--hk:#cf222e;--hn:#0550ae;--hc:#6e7781;--ht:#953800;--hf:#8250df} html[data-md2doc-theme="dark"]{--hk:#ff7b72;--hn:#79c0ff;--hc:#8b949e;--ht:#ffa657;--hf:#d2a8ff}
`;
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47311', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const [v, theme] of (process.env.RUNS ? process.env.RUNS.split(',').map((x) => x.split(':')) : [['cur', 'light'], ['r1', 'light'], ['r1', 'dark'], ['r2', 'light'], ['r2', 'dark']])) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    if (v !== 'cur') await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47311/edit/0'); await p.waitForTimeout(4000);
    if (v !== 'cur') { await p.addStyleTag({ content: CSS + FIXES + R1 + (v === 'r1w' ? 'textarea.ed-source{white-space:pre-wrap!important;overflow-wrap:anywhere!important}' : '') }); await p.evaluate(([m]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; }); }, [svgMap]); }
    await p.click('[data-ed-tb="preview"]'); await p.waitForTimeout(1500);
    const src = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); return t ? t.value : null; });
    if (!src) { console.log('no source textarea'); }
    const first = src.indexOf('# 1 Introduction');
    if (v !== 'cur') await p.evaluate(([html, hl]) => { const t = document.querySelector('textarea.ed-source'); const w = document.createElement('div'); w.className = 'e-src-wrap'; t.parentNode.insertBefore(w, t); w.appendChild(t);
      if (hl) { const pre = document.createElement('pre'); pre.className = 'e-hl'; pre.innerHTML = html + '\n'; w.appendChild(pre); t.style.setProperty('color', 'transparent', 'important'); t.style.setProperty('caret-color', 'var(--e-ink)', 'important');
        const cs = getComputedStyle(t); if (t.getAttribute('wrap') === 'off' || cs.whiteSpace === 'pre') pre.style.whiteSpace = 'pre'; t.addEventListener('scroll', () => { pre.scrollTop = t.scrollTop; pre.scrollLeft = t.scrollLeft; }); } }, [h.highlight(src, { language: 'markdown' }).value, v === 'r2']);
    await p.evaluate(() => scrollTo(0, 0));
    // scroll so that "1 Introduction" is near top (textarea or page scroll)
    await p.evaluate((first) => { const t = document.querySelector('textarea.ed-source'); t.focus(); t.setSelectionRange(first, first); const lh = parseFloat(getComputedStyle(t).lineHeight) || 20; const ln = t.value.slice(0, first).split('\n').length;
      const mirror = document.createElement('div'); const cs = getComputedStyle(t); mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:' + (t.getAttribute('wrap') === 'off' || cs.whiteSpace === 'pre' ? 'pre' : 'pre-wrap') + ';overflow-wrap:break-word;box-sizing:border-box;width:' + t.clientWidth + 'px;padding:' + cs.padding + ';font:' + cs.font; mirror.textContent = t.value.slice(0, first); document.body.appendChild(mirror); const top = mirror.scrollHeight - 16 - 3 * lh; mirror.remove(); t.scrollTop = Math.max(0, top); t.dispatchEvent(new Event('scroll')); }, first);
    await p.waitForTimeout(400);
    const m = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); const cs = getComputedStyle(t); return { wrap: t.getAttribute('wrap'), ws: cs.whiteSpace, font: cs.fontFamily.slice(0, 40), size: cs.fontSize, h: Math.round(t.getBoundingClientRect().height), scrollH: t.scrollHeight }; });
    console.log(v, theme, JSON.stringify(m));
    await p.screenshot({ path: `e10-${v}-${T}.png` }); await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
