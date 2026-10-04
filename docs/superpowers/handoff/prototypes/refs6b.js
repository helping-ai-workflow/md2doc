const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/','a.headerlink'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams','a.hash-link'],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position','h2 a, h3 a'],['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams','h2 a, h3 a'],['whatwg','https://html.spec.whatwg.org/multipage/dom.html','a.self-link']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of sites) for (const mob of [true, false]) {
    const p = await b.newPage();
    await p.setViewport(mob ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(sel => { const a = [...document.querySelectorAll(sel)].find(a => a.closest('h2,h3')); if (!a) return null; const cs = getComputedStyle(a), bcs = getComputedStyle(a, '::before'), acs = getComputedStyle(a, '::after'); a.closest('h2,h3').scrollIntoView({ block: 'center' }); return { text: a.textContent.trim().slice(0, 30), opacity: cs.opacity, visibility: cs.visibility, display: cs.display, before: bcs.content, after: acs.content, headingIsLink: a.textContent.trim().length > 3 }; }, sel);
    console.log(id, mob ? 'mobile' : 'desktop', JSON.stringify(r));
    if (mob) { await new Promise(r => setTimeout(r, 600)); await p.screenshot({ path: `${process.argv[2]}/ref6b-${id}.png` }); }
    await p.close();
  }
  await b.close();
})();
