const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['mkdocs', 'https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],
  ['docusaurus', 'https://docusaurus.io/docs/markdown-features/diagrams'],
  ['mermaiddocs', 'https://mermaid.js.org/syntax/stateDiagram.html'],
  ['github', 'https://github.com/mermaid-js/mermaid/blob/develop/README.md'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    try { await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) { console.log(id, 'load', e.message); }
    await new Promise(r => setTimeout(r, 4000));
    const found = await p.evaluate(() => {
      const svgs = [...document.querySelectorAll('svg')].filter(s => s.querySelector('.node, .statediagram-state, g.node, rect.basic') && s.getBoundingClientRect().width > 150);
      const frames = [...document.querySelectorAll('iframe')].map(f => f.src).filter(s => /viewscreen|render/.test(s));
      if (!svgs.length) return { n: 0, frames };
      const s = svgs[0]; s.scrollIntoView({ block: 'center' });
      const r = s.querySelector('.node rect, .node path, rect.basic, .node polygon');
      const cs = r ? getComputedStyle(r) : null;
      const t = s.querySelector('.nodeLabel, text, span');
      return { n: svgs.length, fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily, frames };
    });
    console.log(id, JSON.stringify(found));
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref5-${id}.png` });
    await p.close();
  }
  await b.close();
})();
