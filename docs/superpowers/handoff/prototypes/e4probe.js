const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47191', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47191/edit/0'); await p.waitForTimeout(3500);
  console.log(JSON.stringify(await p.evaluate(() => {
    const out = {};
    for (const t of ['paragraph', 'heading', 'li', 'table', 'code']) {
      const bl = [...document.querySelectorAll('.ed-block')].find((b) => (b.getAttribute('data-block-type') || '') === t || (t === 'table' && b.querySelector('table')) || (t === 'code' && b.querySelector('pre')));
      if (!bl) { out[t] = null; continue; }
      const R = (e) => { if (!e) return null; const x = e.getBoundingClientRect(), B = bl.getBoundingClientRect(); return [Math.round(x.left - B.left), Math.round(x.top - B.top), Math.round(x.width), Math.round(x.height)]; };
      const lh = parseFloat(getComputedStyle(bl.querySelector('[contenteditable]') || bl).lineHeight);
      out[t] = { type: bl.getAttribute('data-block-type'), handle: R(bl.querySelector(':scope > .ed-handle, .ed-handle')), insert: R(bl.querySelector('.ed-insert')), lineH: lh, shift: getComputedStyle(bl).getPropertyValue('--ed-gutter-shift') };
    }
    return out;
  })));
  await b.close(); srv.kill();
})();
