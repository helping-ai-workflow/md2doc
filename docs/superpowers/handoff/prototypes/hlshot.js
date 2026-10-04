const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const h = require('./hl/node_modules/highlight.js/lib/core'); h.registerLanguage('verilog', require('./hl/node_modules/highlight.js/lib/languages/verilog'));
const PA = `:root{--hk:#cf222e;--hn:#0550ae;--hc:#6e7781;--hs:#0a3069;--ht:#953800;--hf:#8250df}
html[data-md2doc-theme="dark"]{--hk:#ff7b72;--hn:#79c0ff;--hc:#8b949e;--hs:#a5d6ff;--ht:#ffa657;--hf:#d2a8ff}
.hljs-keyword{color:var(--hk)}.hljs-number{color:var(--hn)}.hljs-comment{color:var(--hc);font-style:italic}.hljs-string{color:var(--hs)}.hljs-type,.hljs-built_in{color:var(--ht)}.hljs-title,.hljs-variable{color:var(--hf)}.hljs-meta{color:var(--ht)}`;
const PB = `:root{--hk:#1f2328;--hn:#0969da;--hc:#6e7781} html[data-md2doc-theme="dark"]{--hk:#f5f6f7;--hn:#6ea8f5;--hc:#8b949e}
.hljs-keyword{color:var(--hk);font-weight:600}.hljs-number{color:var(--hn)}.hljs-comment{color:var(--hc);font-style:italic}.hljs-string{color:var(--hn)}.hljs-meta{color:var(--hc)}`;
(async () => {
  const b = await chromium.launch();
  for (const theme of ['light', 'dark']) for (const [v, css] of [['none', ''], ['pa', PA], ['pb', PB]]) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); await p.goto('file://' + __dirname + '/mtc.html'); await p.waitForTimeout(1500);
    const srcs = await p.evaluate(() => [...document.querySelectorAll('pre code.language-verilog')].map((c) => c.textContent));
    const hl = srcs.map((s) => h.highlight(s, { language: 'verilog' }).value);
    const clip = await p.evaluate(([hl, css, v]) => { const cs = [...document.querySelectorAll('pre code.language-verilog')]; if (v !== 'none') cs.forEach((c, i) => { c.innerHTML = hl[i]; });
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      const pre = cs[3].parentElement; pre.scrollIntoView({ block: 'start' }); scrollBy(0, -20); const r = pre.getBoundingClientRect(); return { x: r.left - 10, y: r.top - 10, width: Math.min(r.width + 20, 700), height: Math.min(r.height + 20, 330) }; }, [hl, css, v]);
    await p.screenshot({ path: `hl-${theme[0]}-${v}.png`, clip }); await ctx.close();
  }
  await b.close();
})();
