const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47281', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47281/edit/0'); await p.waitForTimeout(5000);
  const d = await p.evaluate(() => { const b = document.querySelector('.ed-block[data-block-id="671"]'); b.scrollIntoView({ block: 'center' }); const el = b.querySelector('.wavedrom-diagram, [id^="WaveDrom_Display_"]'); const x = (el || b).getBoundingClientRect(); return { has: !!el, cls: b.firstElementChild.className, x: x.left + x.width / 2, y: x.top + x.height / 2, n: document.querySelectorAll('.ed-wave-edit-btn').length }; });
  console.log(JSON.stringify(d));
  await p.waitForTimeout(300); await p.mouse.move(d.x - 40, d.y); await p.mouse.move(d.x, d.y, { steps: 5 }); await p.waitForTimeout(500);
  console.log(JSON.stringify(await p.evaluate(() => { const e = document.querySelector('.ed-wave-edit-btn'); const r = e.getBoundingClientRect(); const at = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { hidden: e.hidden, r: [r.left, r.top, r.width], at: at && at.tagName + '.' + at.className.baseVal + at.className }; })));
  await b.close(); srv.kill();
})();
