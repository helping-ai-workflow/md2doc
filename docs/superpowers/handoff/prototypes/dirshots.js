const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { apply } = require('./directions.js');
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const dir of (process.env.DIRS || 'B,C').split(',')) {
    const [css, svgMap, extra] = apply(dir);
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(dir + ': ' + e.message));
    await p.goto('http://127.0.0.1:' + process.env.PORT + '/edit/0', { waitUntil: 'load' }); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: css });
    const swap = async () => p.evaluate(([m, x, d]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k] && !btn.querySelector('svg')) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.plus; });
      const st = document.querySelector('.ed-toolbar-status'); if (st && d === 'C' && !st.dataset.proto) { st.dataset.proto = 1; st.textContent = '已儲存'; }
    }, [svgMap, extra, dir]);
    await swap();
    await p.screenshot({ path: dir + '-rest.png' });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
    await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(400); await swap();
    await p.screenshot({ path: dir + '-hover.png' });
    const h = await para.evaluate((e) => { const k = e.querySelector('.ed-handle'); const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
    const conv = await p.$('.ed-handle-menu button'); if (conv) { await conv.hover(); await p.waitForTimeout(400); }
    await p.screenshot({ path: dir + '-handlemenu.png' });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const ins = await para.evaluate((e) => { const k = e.querySelector('.ed-insert'); if (!k) return null; const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    if (ins) { await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await p.screenshot({ path: dir + '-insert.png' }); await p.keyboard.press('Escape'); }
    await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
    await p.screenshot({ path: dir + '-seltb.png' });
    await p.keyboard.press('Escape');
    await p.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close();
})();
