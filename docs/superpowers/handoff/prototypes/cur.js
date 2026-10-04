const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:47123/edit/0', { waitUntil: 'load' }); await p.waitForTimeout(3500);
  await p.screenshot({ path: 'cur-rest.png' });
  // a plain paragraph in section 1
  const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
  await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
  await p.mouse.move(r.x, r.y); await p.waitForTimeout(400);
  await p.screenshot({ path: 'cur-hover.png' });
  const h = await para.evaluate((e) => { const k = e.querySelector('.ed-handle'); const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
  const conv = await p.$('.ed-handle-menu [data-action="convert"], .ed-handle-menu button');
  if (conv) { await conv.hover(); await p.waitForTimeout(400); }
  await p.screenshot({ path: 'cur-handlemenu.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
  const ins = await para.evaluate((e) => { const k = e.querySelector('.ed-insert'); if (!k) return null; const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  if (ins) { await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await p.screenshot({ path: 'cur-insert.png' }); await p.keyboard.press('Escape'); }
  // selection toolbar: double-click a word in the paragraph
  await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-seltb.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // heading menu on toolbar
  const hb = await p.$('.ed-toolbar [data-ed-tb-action="heading"], .ed-toolbar button[aria-haspopup]');
  if (hb) { await hb.click(); await p.waitForTimeout(400); await p.screenshot({ path: 'cur-toolbarmenu.png', clip: { x: 0, y: 0, width: 1440, height: 360 } }); await p.keyboard.press('Escape'); }
  // table: hover near a row boundary to show grips and insert bubbles
  const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table')].find((x) => x.rows.length > 3));
  await t.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const tr = await t.evaluate((e) => { const c = e.rows[2].cells[1].getBoundingClientRect(); return { x: c.left + 20, y: c.top + c.height / 2, by: c.bottom }; });
  await p.mouse.move(tr.x, tr.y); await p.waitForTimeout(300); await p.mouse.move(tr.x, tr.by - 1); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-table.png' });
  // code block raw editor
  const code = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block')].find((b) => b.querySelector('pre code')));
  if (code) { await code.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await code.click(); await p.waitForTimeout(600); await p.screenshot({ path: 'cur-raw.png' }); await p.keyboard.press('Escape'); }
  console.log('errors', errs.length ? errs : 'none');
  await b.close();
})();
