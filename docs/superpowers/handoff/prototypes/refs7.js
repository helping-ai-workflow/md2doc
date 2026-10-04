const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.screenshot({ path: `${process.argv[2]}/ref7-${id}.png` });
    await p.close();
  }
  await b.close();
})();
