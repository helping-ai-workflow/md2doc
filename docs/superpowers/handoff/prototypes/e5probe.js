const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47211', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47211/edit/0'); await p.waitForTimeout(4000);
  console.log(JSON.stringify(await p.evaluate(() => {
    const types = {}; const deg = {}; const why = {};
    document.querySelectorAll('.content .ed-block').forEach((bl) => {
      const t = bl.getAttribute('data-block-type') || '?'; types[t] = (types[t] || 0) + 1;
      if (['paragraph', 'heading', 'li'].includes(t) && !bl.querySelector('.ed-wys-armed')) {
        deg[t] = (deg[t] || 0) + 1;
        const tags = new Set([...bl.querySelectorAll('*')].map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).filter((x) => !/^(button|svg|path|line|circle|rect|polyline|span\.ed-|div\.ed-)/.test(x)));
        tags.forEach((x) => { why[x] = (why[x] || 0) + 1; });
      }
    });
    const ex=[...document.querySelectorAll('.content .ed-block[data-block-type=li]')].filter(b=>!b.querySelector('.ed-wys-armed')).slice(0,3).map(b=>b.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g,'').slice(0,500)); return { ex };
  })));
  await b.close(); srv.kill();
})();
