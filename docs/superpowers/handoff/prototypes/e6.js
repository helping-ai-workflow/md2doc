const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const fs = require('fs');
const check = fs.readFileSync(__dirname + '/lucide/check.svg', 'utf8').replace(/<!--[^>]*-->/, '').replace(/\n/g, ' ').trim();
const checkUri = 'data:image/svg+xml,' + encodeURIComponent(check.replace('currentColor', '#ffffff').replace('stroke-width="2"', 'stroke-width="3"'));
const E6 = `
.ed-block[data-list-type="ul"][style*="--ed-indent:1"] > .ed-li-marker::before{content:"\\25E6"!important}
.ed-block[data-list-type="ul"][style*="--ed-indent:2"] > .ed-li-marker::before{content:"\\25AA"!important}
.ed-li-marker{color:var(--e-mut)!important}
.ed-li-check{width:16px!important;height:16px!important;border:1.5px solid var(--e-glyph)!important;border-radius:4px!important;background:transparent!important;margin-top:4px}
.ed-li-check[data-checked="1"]{background:var(--e-accent) url("${checkUri}") center/12px no-repeat!important;border-color:var(--e-accent)!important}
`;
const C2 = `.ed-block:has(> .ed-li-check[data-checked="1"]) .ed-li-text{color:var(--e-mut);text-decoration:line-through;text-decoration-color:var(--e-glyph)}`;
(async () => {
  const port = 47231;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'lists.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    // reader
    {
      const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); await p.goto('file://' + __dirname + '/lists.html'); await p.waitForTimeout(1200);
      await p.screenshot({ path: `e6-${T}-reader.png` }); await ctx.close();
    }
    for (const v of ['cur', 'c1', 'c2']) {
      const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
      await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
      await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3000);
      await p.addStyleTag({ content: CSS + FIXES + (v !== 'cur' ? E6 : '') + (v === 'c2' ? C2 : '') });
      await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
      await p.mouse.move(1000, 950);
      await p.screenshot({ path: `e6-${T}-${v}.png` });
      if (v === 'cur') {
        const info = await p.evaluate(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')].map((b) => (b.querySelector('.ed-wys-armed') ? 'W' : 'R') + b.getAttribute('data-indent')).join(' '));
        console.log(theme, 'li armed/raw + indent:', info);
        const loose = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => /Simulation model/.test(b.textContent)));
        await loose.click(); await p.waitForTimeout(700); await p.screenshot({ path: `e6-${T}-looseclick.png` });
      }
      await ctx.close();
    }
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
