const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['arrow-left-to-line', 'arrow-right-to-line', 'arrow-up-to-line', 'arrow-down-to-line', 'align-left', 'align-center', 'align-right', 'chevron-right', 'trash-2', 'plus', 'grip-vertical'].forEach((n) => { I[n] = ico(n); });
const E7 = `
.ed-block:hover{outline:none!important}
.e-tmenu{position:absolute;z-index:300;min-width:168px;padding:4px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink);font-size:13px}
.e-tmenu .it{display:flex;align-items:center;gap:10px;height:30px;padding:0 8px;border-radius:6px}
.e-tmenu .it.on{background:var(--e-hover)} .e-tmenu .it svg{width:16px;height:16px;color:var(--e-mut)} .e-tmenu .it .nm{flex:1}
.e-tmenu .it.danger{color:var(--e-err,#cf222e)} .e-tmenu .it.danger svg{color:inherit}
.e-tmenu hr{border:0;border-top:1px solid var(--e-rule);margin:4px 0}
.e-tmenu .seg{display:flex;gap:2px;margin-left:auto}.e-tmenu .seg span{width:24px;height:22px;display:grid;place-items:center;border-radius:4px;color:var(--e-mut)}
.e-tmenu .seg span.on{background:var(--e-active-bg);color:var(--e-active-fg)} .e-tmenu .seg svg{width:14px;height:14px;color:inherit}
.e-tbar{position:absolute;z-index:250;display:grid;place-items:center;border-radius:6px;background:var(--e-hover);color:var(--e-mut)}
.e-tbar svg{width:16px;height:16px}
.ed-te-grip-row,.ed-te-grip-col{background:var(--e-surface)!important;box-shadow:var(--e-ring)!important;border:0!important;color:var(--e-mut)!important;border-radius:6px!important}
.ed-te-grip-row.e-on,.ed-te-grip-col.e-on{background:var(--e-accent)!important;color:var(--e-surface)!important}
.ed-te-hl{background:var(--e-sel)!important}
`;
const ERR = `:root{--e-err:#cf222e} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a}`;
(async () => {
  const port = 47251;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + ERR + E7 });
    await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
    const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14));
    const box = await t.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -160); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, 520) }; });
    const clip = { x: box.x - 90, y: box.y - 70, width: Math.min(box.w + 150, 1440 - box.x + 90), height: box.h + 130 };
    const c = await t.evaluate((e) => { const x = e.rows[2].cells[1].getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    // edge bars on hover
    await p.mouse.move(c.x, c.y); await p.waitForTimeout(400);
    await p.evaluate(([I]) => { const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14); const r = tb.getBoundingClientRect();
      const mk = (l, t, w, h) => { const d = document.createElement('div'); d.className = 'e-tbar'; d.innerHTML = I.plus; Object.assign(d.style, { left: (l + scrollX) + 'px', top: (t + scrollY) + 'px', width: w + 'px', height: h + 'px' }); document.body.appendChild(d); };
      mk(r.left, r.bottom + 4, r.width, 22); mk(r.right + 4, r.top, 22, r.height); }, [I]);
    await p.screenshot({ path: `e7-${T}-bars.png`, clip });
    // column menu
    const g = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-col'); const x = e.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; });
    await p.evaluate(([I, g]) => { document.querySelectorAll('.e-tbar').forEach((e) => e.remove()); const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14);
      [...tb.rows].forEach((r) => r.cells[1] && r.cells[1].classList.add('ed-te-hl')); document.querySelector('.ed-te-grip-col').classList.add('e-on');
      const m = document.createElement('div'); m.className = 'e-tmenu'; m.innerHTML =
        `<div class="it on">${I['arrow-left-to-line']}<span class="nm">左側插入欄</span></div><div class="it">${I['arrow-right-to-line']}<span class="nm">右側插入欄</span></div>` +
        `<div class="it">${I['align-left']}<span class="nm">對齊</span><span class="seg"><span class="on">${I['align-left']}</span><span>${I['align-center']}</span><span>${I['align-right']}</span></span></div><hr>` +
        `<div class="it danger">${I['trash-2']}<span class="nm">刪除欄</span></div>`;
      m.style.left = (g.x + scrollX) + 'px'; m.style.top = (g.y + g.h + 6 + scrollY) + 'px'; document.body.appendChild(m); }, [I, g]);
    await p.screenshot({ path: `e7-${T}-colmenu.png`, clip });
    // row menu
    await p.evaluate(() => { document.querySelectorAll('.e-tmenu').forEach((e) => e.remove()); document.querySelectorAll('.ed-te-hl').forEach((e) => e.classList.remove('ed-te-hl')); document.querySelector('.ed-te-grip-col').classList.remove('e-on'); });
    const gr = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const x = e.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; });
    await p.evaluate(([I, g]) => { const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14);
      [...tb.rows[2].cells].forEach((c) => c.classList.add('ed-te-hl')); document.querySelector('.ed-te-grip-row').classList.add('e-on');
      const m = document.createElement('div'); m.className = 'e-tmenu'; m.innerHTML =
        `<div class="it on">${I['arrow-up-to-line']}<span class="nm">上方插入列</span></div><div class="it">${I['arrow-down-to-line']}<span class="nm">下方插入列</span></div><hr><div class="it danger">${I['trash-2']}<span class="nm">刪除列</span></div>`;
      m.style.left = (g.x + g.w + 6 + scrollX) + 'px'; m.style.top = (g.y + scrollY) + 'px'; document.body.appendChild(m); }, [I, gr]);
    await p.screenshot({ path: `e7-${T}-rowmenu.png`, clip });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
