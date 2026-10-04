const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  for (const [f, port] of [['empty.md', 47131], ['short.md', 47132]]) {
    const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), f], { cwd: __dirname });
    await new Promise((r) => setTimeout(r, 2500));
    const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(2500);
    const before = await p.evaluate(() => ({ blocks: document.querySelectorAll('.ed-block').length, h: document.querySelector('.content').getBoundingClientRect().height }));
    await p.mouse.click(700, 700); await p.waitForTimeout(300);
    await p.keyboard.type('hello'); await p.waitForTimeout(300);
    const after = await p.evaluate(() => ({ blocks: document.querySelectorAll('.ed-block').length, active: document.activeElement.className, text: document.querySelector('.content').innerText.slice(0, 80) }));
    await p.screenshot({ path: f + '.png' });
    console.log(f, JSON.stringify(before), JSON.stringify(after));
    await b.close(); srv.kill();
  }
})();
