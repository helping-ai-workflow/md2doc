const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47241', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await p.goto('http://127.0.0.1:47241/edit/0'); await p.waitForTimeout(3500);
  const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14));
  console.log('tables', JSON.stringify(await p.evaluate(() => { const all=[...document.querySelectorAll('.content .ed-block[data-block-type=table]')]; const deg=all.filter(b=>!b.querySelector('table.ed-wys-table')); const why={}; deg.forEach(b=>{ const tags=new Set([...b.querySelectorAll('td *, th *')].map(e=>e.tagName.toLowerCase())); tags.forEach(x=>why[x]=(why[x]||0)+1); if(!tags.size) why['(none)']=(why['(none)']||0)+1; }); return {all:all.length, deg:deg.length, why}; })));
  const box = await t.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -160); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, 520) }; });
  const clip = { x: box.x - 50, y: box.y - 60, width: Math.min(box.w + 100, 1440 - box.x + 50), height: box.h + 100 };
  const cell = async (r, c) => t.evaluate((e, [r, c]) => { const x = e.rows[r].cells[c].getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, l: x.left, t: x.top, b: x.bottom, r: x.right }; }, [r, c]);
  const c = await cell(2, 1); await p.mouse.move(c.x, c.y); await p.waitForTimeout(500);
  await p.screenshot({ path: 'e7-cur-hover.png', clip });
  const g = await p.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, vis: getComputedStyle(e).display !== 'none' && x.width > 0 }; }; return { row: r('.ed-te-grip-row'), col: r('.ed-te-grip-col') }; });
  console.log(JSON.stringify(g));
  if (g.col && g.col.vis) { await p.mouse.move(g.col.x, g.col.y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(500); await p.screenshot({ path: 'e7-cur-colmenu.png', clip }); await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
  await p.mouse.move(c.x, c.y); await p.waitForTimeout(300);
  const g2 = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const x = e.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  await p.mouse.move(g2.x, g2.y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(500); await p.screenshot({ path: 'e7-cur-rowmenu.png', clip }); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.mouse.move(c.x, c.y); await p.waitForTimeout(200); await p.mouse.move(c.x, c.b - 1); await p.waitForTimeout(600);
  await p.screenshot({ path: 'e7-cur-bubble.png', clip });
  const last = await t.evaluate((e) => { const rr = e.rows[e.rows.length - 1]; const x = rr.cells[rr.cells.length - 1].getBoundingClientRect(); return { x: x.left + 10, y: x.top + x.height / 2 }; });
  console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.ed-te-menu button')].map((b) => b.textContent))));
  await b.close(); srv.kill();
})();
