const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] }); const p = await b.newPage();
  await p.setViewport({ width: 660, height: 150, deviceScaleFactor: 2 });
  for (const k of 'ABCDE') { await p.goto('file://' + process.argv[2] + '/bubble-' + k + '.html'); await p.screenshot({ path: process.argv[2] + '/shots/i11s-close-' + k + '.png' }); }
  await b.close();
})();
