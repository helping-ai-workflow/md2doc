const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47181', 'empty.md', 'short.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 2500));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const i of [0, 1]) {
    await p.goto('http://127.0.0.1:47181/edit/' + i); await p.waitForTimeout(2500);
    console.log(i, JSON.stringify(await p.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height), getComputedStyle(e).display]; };
      return { content: r('.content'), sidebar: r('.sidebar'), layout: r('.page-layout'), bodyCls: document.body.className }; })));
  }
  await b.close(); srv.kill();
})();
