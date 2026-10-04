const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['ghdocs','https://docs.github.com/en/actions/reference/workflows-and-actions/contexts'],
  ['mdn','https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input'],
  ['docusaurus','https://docusaurus.io/docs/api/docusaurus-config'],
  ['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/data-tables/'],
  ['github','https://github.com/microsoft/vscode/blob/main/CONTRIBUTING.md'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const ts = [...document.querySelectorAll('main table, article table, .markdown-body table, table')].filter(t => t.getBoundingClientRect().width > 0 && t.querySelectorAll('tr').length > 2);
      if (!ts.length) return null;
      const t = ts.sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
      t.scrollIntoView({ block: 'start' }); window.scrollBy(0, -60);
      const cs = getComputedStyle(t); let sc = t; while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      const row = t.querySelector('tbody tr') || t.querySelectorAll('tr')[1];
      const tds = [...row.children].map(c => Math.round(c.getBoundingClientRect().width));
      const hs = [...t.querySelectorAll('tbody tr')].slice(0, 6).map(r => Math.round(r.getBoundingClientRect().height));
      return { display: cs.display, width: cs.width, tableW: Math.round(t.getBoundingClientRect().width), contentW: t.scrollWidth, scroller: sc ? sc.tagName + '.' + String(sc.className).slice(0, 30) : '-', colW: tds, rowH: hs, ws: getComputedStyle(row.children[row.children.length - 1]).whiteSpace, minW: getComputedStyle(row.children[row.children.length - 1]).minWidth };
    });
    console.log(id, JSON.stringify(r));
    await new Promise(r => setTimeout(r, 600));
    await p.screenshot({ path: `${process.argv[2]}/shots/ref13-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
