const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],
  ['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],
  ['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],
  ['python','https://docs.python.org/3/library/functions.html'],
  ['mdbook','https://doc.rust-lang.org/book/ch01-00-getting-started.html'],
  ['vitepress','https://vitepress.dev/guide/what-is-vitepress'],
  ['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams'],
  ['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const mob of [false, true]) for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
    await p.setViewport(mob ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const re = /theme|dark|light|color scheme|colour|appearance|配色/i;
      const cands = [...document.querySelectorAll('button, a, select, label, input')].filter(e => {
        const t = [e.getAttribute('aria-label'), e.title, e.getAttribute('data-md-color-media') && 'theme', e.id, e.className && String(e.className), e.tagName === 'SELECT' ? e.innerText : ''].join(' ');
        const rc = e.getBoundingClientRect(); return re.test(t) && rc.width > 0 && rc.height > 0;
      });
      return cands.slice(0, 3).map(e => { const rc = e.getBoundingClientRect(); return { tag: e.tagName, label: (e.getAttribute('aria-label') || e.title || e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50), x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height), pos: getComputedStyle(e.closest('header,nav,aside,footer,[class*="sidebar"],[class*="header"]') || e).position, inside: (e.closest('header,nav,aside,footer,[class*="sidebar"],[class*="header"]') || {}).tagName || '-' }; });
    });
    console.log(mob ? 'MOB' : 'DESK', id, JSON.stringify(r));
    await p.screenshot({ path: `${process.argv[2]}/ref11t-${mob ? 'm' : 'd'}-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
