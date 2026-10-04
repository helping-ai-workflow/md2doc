const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mdn','https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input'],['docusaurus','https://docusaurus.io/docs/api/docusaurus-config'],['mkdocs','https://squidfunk.github.io/mkdocs-material/setup/changing-the-colors/'],['whatwg','https://html.spec.whatwg.org/multipage/input.html'],['ghdocs','https://docs.github.com/en/actions/reference/workflows-and-actions/contexts']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const st = c => { const s = getComputedStyle(c); return { bg: s.backgroundColor, color: s.color, border: s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor, pad: s.padding, fs: s.fontSize, ff: s.fontFamily.slice(0, 40) }; };
      const inTd = [...document.querySelectorAll('td code')].find(c => !c.closest('pre'));
      const inP = [...document.querySelectorAll('p code')].find(c => !c.closest('pre'));
      if (inTd) inTd.closest('table').scrollIntoView({ block: 'center' });
      return { td: inTd && st(inTd), p: inP && st(inP) };
    });
    console.log(id, JSON.stringify(r));
    await new Promise(r => setTimeout(r, 600));
    await p.screenshot({ path: `${process.argv[2]}/ref9-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
