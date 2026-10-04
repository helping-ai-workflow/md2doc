const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['w3c', 'https://www.w3.org/TR/css-grid-2/', 'h3'],
  ['whatwg', 'https://html.spec.whatwg.org/multipage/dom.html', 'h4'],
  ['ecma', 'https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html', 'h1'],
  ['rfc', 'https://www.rfc-editor.org/rfc/rfc9293.html', 'h3'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, tag] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    try { await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) { console.log(id, 'load', e.message); }
    await new Promise(r => setTimeout(r, 1500));
    const info = await p.evaluate(() => {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const out = { body, levels: {} };
      for (const t of ['h2', 'h3', 'h4']) {
        const hs = [...document.querySelectorAll(t)].filter(h => /^\s*[\d.]+|^\s*[A-Z]?\d/.test(h.textContent));
        const h = hs[Math.min(3, hs.length - 1)];
        if (!h) continue;
        const cs = getComputedStyle(h);
        const num = h.querySelector('.secno, .secnum, [class*="secno"], [class*="secnum"], .section-number, a.section-number, span');
        const ncs = num ? getComputedStyle(num) : null;
        out.levels[t] = { text: h.textContent.trim().slice(0, 50), size: (parseFloat(cs.fontSize) / body).toFixed(2), weight: cs.fontWeight, color: cs.color, mt: cs.marginTop, mb: cs.marginBottom,
          num: num ? { cls: num.className, text: num.textContent.trim().slice(0, 12), color: ncs.color, weight: ncs.fontWeight, pos: ncs.position } : null };
      }
      return out;
    });
    console.log(id, JSON.stringify(info));
    const target = await p.evaluate(() => { const h = [...document.querySelectorAll('h3')].filter(h => /\d/.test(h.textContent))[2] || document.querySelector('h2'); if (!h) return false; window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 200); return true; });
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref-${id}.png` });
    await p.close();
  }
  await b.close();
})();
