const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.evaluate(() => window.scrollTo(0, 1400)); await new Promise(r => setTimeout(r, 1200));
    const bar = await p.evaluate(() => { const els = [...document.querySelectorAll('header, nav, [class*="header"], [class*="navbar"]')].filter(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return (cs.position === 'sticky' || cs.position === 'fixed') && r.top <= 1 && r.height > 20 && r.height < 120; }); return els.slice(0, 2).map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), h: Math.round(e.getBoundingClientRect().height), pos: getComputedStyle(e).position, text: e.innerText.replace(/\s+/g, ' ').slice(0, 60) })); });
    console.log(id, JSON.stringify(bar));
    await p.screenshot({ path: `${process.argv[2]}/ref6-${id}.png` });
    await p.close();
  }
  await b.close();
})();
