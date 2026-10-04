const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams','img'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams','svg[aria-roledescription]']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 3000));
    const r = await p.evaluate(sel => { const d = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 200 && !e.closest('header,nav')); if (!d) return null; d.scrollIntoView({ block: 'center' }); const rc = d.getBoundingClientRect(); return [rc.x, rc.y, rc.width, rc.height].map(Math.round); }, sel);
    await new Promise(r => setTimeout(r, 2500));
    const rc = await p.evaluate(sel => { const d = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 200 && !e.closest('header,nav')); const r = d.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height].map(Math.round); }, sel);
    console.log(id, rc);
    const [x, y, w, h] = rc;
    await p.screenshot({ path: `${process.argv[2]}/ref11-${id}.png`, clip: { x: Math.max(0, x - 120), y: Math.max(0, y - 120), width: Math.min(1440 - Math.max(0, x - 120), w + 240), height: h + 240 } });
    await ctx.close();
  }
  await b.close();
})();
