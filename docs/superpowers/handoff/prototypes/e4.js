const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const { E3CSS, menuHtml } = require('./slash.js');
const ALIGN = `.ed-handle,.ed-insert{width:24px!important;height:24px!important}.ed-handle svg,.ed-insert svg{width:16px;height:16px}
.ed-insert{left:-58px!important}.ed-handle{left:-34px!important}`;
(async () => {
  const port = 47201;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    for (const v of ['cur', 'new']) {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
      await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
      await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
      await p.addStyleTag({ content: CSS + FIXES + E3CSS + (v === 'new' ? ALIGN : '') });
      await p.evaluate(([m, x, v]) => {
        document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-block').forEach((bl) => {
          const h = bl.querySelector('.ed-handle'), i = bl.querySelector('.ed-insert'); if (h) h.innerHTML = x.grip; if (i) i.innerHTML = x.plus;
          if (v === 'new') { const ed = bl.querySelector('[contenteditable], h1,h2,h3,h4,p,li,td') || bl; const lh = parseFloat(getComputedStyle(ed).lineHeight) || 24;
            const off = ed.getBoundingClientRect().top - bl.getBoundingClientRect().top; const top = off + (lh - 24) / 2;
            if (h) h.style.setProperty('top', top + 'px', 'important'); if (i) i.style.setProperty('top', top + 'px', 'important'); }
        });
      }, [svgMap, extra, v]);
      // hover heading "1 Introduction" and the paragraph under it, crop gutter region
      const pos = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); h.scrollIntoView({ block: 'start' }); scrollBy(0, -200);
        const r = h.getBoundingClientRect(); const pr = h.nextElementSibling.getBoundingClientRect(); return { hx: r.left + 60, hy: r.top + 10, px: pr.left + 60, py: pr.top + 8, left: r.left, top: r.top }; });
      await p.mouse.move(pos.hx, pos.hy); await p.waitForTimeout(300);
      await p.screenshot({ path: `e4-${T}-${v}-hh.png`, clip: { x: pos.left - 90, y: pos.top - 30, width: 560, height: 110 } });
      await p.mouse.move(pos.px, pos.py); await p.waitForTimeout(300);
      await p.screenshot({ path: `e4-${T}-${v}-hp.png`, clip: { x: pos.left - 90, y: pos.top + 30, width: 560, height: 110 } });
      // click + on the paragraph
      const ins = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const i = h.nextElementSibling.querySelector('.ed-insert').getBoundingClientRect(); return { x: i.left + i.width / 2, y: i.top + i.height / 2 }; });
      if (v === 'cur') {
        await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400);
      } else {
        await p.evaluate((h) => {
          const hd = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const para = hd.nextElementSibling;
          const f = para.cloneNode(true); f.classList.add('e-fake'); const ed = f.querySelector('[contenteditable]') || f; ed.textContent = '/'; para.after(f);
          ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
          const fr = f.getBoundingClientRect(); const m = document.createElement('div'); m.className = 'e-slash m1'; m.innerHTML = h;
          m.style.left = (fr.left + scrollX) + 'px'; m.style.top = (fr.bottom + scrollY + 6) + 'px'; document.body.appendChild(m); m.querySelector('.it').classList.add('on');
        }, menuHtml('m1', '')); await p.waitForTimeout(300);
      }
      await p.screenshot({ path: `e4-${T}-${v}-plus.png` });
      await ctx.close();
    }
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
