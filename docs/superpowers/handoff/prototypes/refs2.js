const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of [['w3c','https://www.w3.org/TR/css-grid-2/','.secno'],['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html','.secnum']]) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 1500));
    const info = await p.evaluate((sel) => {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const res = {};
      for (const n of document.querySelectorAll(sel)) {
        const h = n.closest('h1,h2,h3,h4,h5,h6'); if (!h || h.closest('nav,#toc,.toc')) continue;
        const d = h.tagName; if (res[d]) continue;
        const hc = getComputedStyle(h), nc = getComputedStyle(n);
        res[d] = { text: h.textContent.trim().replace(/\s+/g,' ').slice(0, 50), size: (parseFloat(hc.fontSize) / body).toFixed(2), weight: hc.fontWeight, color: hc.color, mt: hc.marginTop, mb: hc.marginBottom, numColor: nc.color, numWeight: nc.fontWeight, numPos: nc.position, numFloat: nc.float, numMarginL: nc.marginLeft };
      }
      return { body, res };
    }, sel);
    console.log(id, JSON.stringify(info));
    await p.evaluate((sel) => { const n = [...document.querySelectorAll(sel)].map(n => n.closest('h3,h4')).filter(Boolean)[2]; if (n) window.scrollTo(0, n.getBoundingClientRect().top + scrollY - 200); }, sel);
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref-${id}.png` });
    await p.close();
  }
  await b.close();
})();
