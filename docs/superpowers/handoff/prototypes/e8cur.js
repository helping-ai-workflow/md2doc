const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47261', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47261/edit/0'); await p.waitForTimeout(5000);
  const kinds = await p.evaluate(() => {
    const out = {}; document.querySelectorAll('.content .ed-block').forEach((b) => {
      const k = b.querySelector('pre code.language-verilog, pre code[class*=verilog]') ? 'verilog' : b.querySelector('.graphviz, [class*=graphviz], svg.graphviz') ? 'dot' : b.querySelector('.mermaid, [class*=mermaid]') ? 'mermaid' : b.querySelector('.wavedrom, [class*=wave]') ? 'wave' : b.querySelector('img') ? 'img' : null;
      if (k) { out[k] = out[k] || []; out[k].push(b.getAttribute('data-block-id') + ':' + b.getAttribute('data-block-type') + ':' + (b.firstElementChild && b.firstElementChild.className)); } });
    return out; });
  console.log(JSON.stringify(kinds).slice(0, 1500));
  await b.close(); srv.kill();
})();
