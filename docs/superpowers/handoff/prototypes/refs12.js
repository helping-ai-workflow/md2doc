const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, h] of [['rfc', 'https://www.rfc-editor.org/rfc/rfc9293.html', 520], ['whatwg', 'https://html.spec.whatwg.org/multipage/', 520], ['ecma', 'https://tc39.es/ecma262/', 420]]) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.screenshot({ path: `${process.argv[2]}/shots/ref12-${id}.png`, clip: { x: 0, y: 0, width: 1440, height: h } });
    await ctx.close();
  }
  await b.close();
})();
