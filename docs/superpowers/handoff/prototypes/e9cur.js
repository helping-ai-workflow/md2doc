const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47291', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch();
  for (const v of ['cur', 'b']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    if (v === 'b') await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47291/edit/0'); await p.waitForTimeout(4000);
    if (v === 'b') { await p.addStyleTag({ content: CSS + FIXES }); await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; }); document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]); }
    const m = await p.evaluate(() => { const tb = document.querySelector('.ed-toolbar'); const r = tb.getBoundingClientRect(); const btns = [...tb.querySelectorAll('[data-ed-tb]')]; const vis = btns.filter((x) => { const q = x.getBoundingClientRect(); return q.right <= innerWidth && q.width > 0; }).length;
      return { tbW: Math.round(r.width), scrollW: tb.scrollWidth, btns: btns.length, visible: vis, docW: document.documentElement.scrollWidth, contentL: Math.round(document.querySelector('.content').getBoundingClientRect().left) }; });
    console.log(v, JSON.stringify(m));
    await p.screenshot({ path: `e9-${v}-rest.png` });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 150));
    const r = await para.evaluate((e) => { e.scrollIntoView({ block: 'center' }); const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
    await p.waitForTimeout(300); await p.touchscreen.tap(r.x, r.y); await p.waitForTimeout(600);
    await p.screenshot({ path: `e9-${v}-tap.png` });
    console.log(v, 'handle visible after tap:', await para.evaluate((e) => getComputedStyle(e.querySelector('.ed-handle')).opacity));
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
