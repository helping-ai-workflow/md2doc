const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47141', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47141/edit/0'); await p.waitForTimeout(3500);
  const info = await p.evaluate(() => {
    const t = document.querySelector('.md2doc-theme-toggle, [data-md2doc-theme-toggle], button[aria-label*="深"], button[aria-label*="theme" i]');
    const r = t && t.getBoundingClientRect();
    return { toggle: t ? t.outerHTML.slice(0, 160) : null, visible: !!(r && r.width), rect: r && [r.x, r.y, r.width, r.height], attr: document.documentElement.getAttribute('data-md2doc-theme') };
  });
  console.log(JSON.stringify(info));
  if (info.visible) {
    await p.mouse.click(info.rect[0] + info.rect[2] / 2, info.rect[1] + info.rect[3] / 2); await p.waitForTimeout(800);
  } else {
    await p.evaluate(() => document.documentElement.setAttribute('data-md2doc-theme', 'dark')); await p.waitForTimeout(800);
  }
  console.log('after', await p.evaluate(() => document.documentElement.getAttribute('data-md2doc-theme')));
  await p.screenshot({ path: 'cur-dark-rest.png' });
  const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
  await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
  await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-dark-seltb.png' });
  await b.close(); srv.kill();
})();
