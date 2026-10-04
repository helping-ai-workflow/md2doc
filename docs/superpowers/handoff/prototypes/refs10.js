const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams',6],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position',8],['govuk','https://www.gov.uk/browse/driving',6],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams',6]];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, n] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < n; i++) { await p.keyboard.press('Tab'); await new Promise(r => setTimeout(r, 120)); }
    const r = await p.evaluate(() => { const e = document.activeElement; const s = getComputedStyle(e); const rc = e.getBoundingClientRect(); return { tag: e.tagName, text: (e.innerText || e.value || '').slice(0, 30), outline: s.outlineWidth + ' ' + s.outlineStyle + ' ' + s.outlineColor, offset: s.outlineOffset, shadow: s.boxShadow.slice(0, 80), bg: s.backgroundColor, rect: [rc.x, rc.y, rc.width, rc.height].map(Math.round) }; });
    console.log(id, JSON.stringify(r));
    const [x, y, w, h] = r.rect; const cx = Math.max(0, x - 60), cy = Math.max(0, y - 40);
    await p.screenshot({ path: `${process.argv[2]}/ref10-${id}.png`, clip: { x: cx, y: cy, width: Math.min(1440 - cx, w + 120), height: Math.min(900 - cy, h + 80) } });
    await ctx.close();
  }
  await b.close();
})();
