const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto('https://mermaid.js.org/syntax/stateDiagram.html', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 3000));
  await p.evaluate(() => { const a = [...document.querySelectorAll('a,button')].find(x => /skip for now/i.test(x.textContent)); if (a) a.click(); });
  await new Promise(r => setTimeout(r, 1500));
  const heads = await p.evaluate(() => [...document.querySelectorAll('h2,h3')].slice(0, 6).map(h => h.textContent.trim()));
  console.log(heads);
  const svgs = await p.$$('svg[aria-roledescription^="state"]');
  console.log('state svgs', svgs.length);
  for (let i = 0; i < Math.min(3, svgs.length); i++) {
    const d = await svgs[i].evaluate(s => { const r = s.querySelector('.node rect, .node path'); const cs = r && getComputedStyle(r); const t = s.querySelector('.nodeLabel, text'); let h = s; while (h && !/^H[23]$/.test((h.previousElementSibling || {}).tagName || '')) h = h.parentElement; return { fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily, w: s.getBoundingClientRect().width }; });
    console.log(i, JSON.stringify(d));
    await svgs[i].evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 500));
    await svgs[i].screenshot({ path: `${process.argv[2]}/ref5-mermaid-${i}.png` });
  }
  const ds = await p.$$('.docusaurus');
  await b.close();
  const b2 = await puppeteer.launch({ args: ['--no-sandbox'] }); const q = await b2.newPage(); await q.setViewport({ width: 1440, height: 1000 });
  await q.goto('https://docusaurus.io/docs/markdown-features/diagrams', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 3000));
  const dsv = (await q.$$('svg[aria-roledescription]'))[0];
  if (dsv) { await dsv.evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 500)); await dsv.screenshot({ path: `${process.argv[2]}/ref5-docusaurus-el.png` }); }
  const m = await q.$('.mermaid'); console.log('docu', !!dsv);
  await b2.close();
})();
