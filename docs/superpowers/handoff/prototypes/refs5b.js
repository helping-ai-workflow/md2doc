const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  // mkdocs material: mermaid renders into a shadow root on div.mermaid
  let p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto('https://squidfunk.github.io/mkdocs-material/reference/diagrams/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 4000));
  const info = await p.evaluate(() => {
    const hosts = [...document.querySelectorAll('.mermaid')];
    const out = [];
    for (const h of hosts) {
      const root = h.shadowRoot || h; const svg = root.querySelector('svg'); if (!svg) continue;
      const r = svg.querySelector('.node rect, .node path, .node polygon'); const cs = r && getComputedStyle(r);
      const t = svg.querySelector('.nodeLabel, text'); out.push({ type: svg.getAttribute('aria-roledescription'), fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily });
    }
    const st = hosts.find(h => ((h.shadowRoot || h).querySelector('svg') || {}).getAttribute && (h.shadowRoot || h).querySelector('svg').getAttribute('aria-roledescription') === 'stateDiagram') || hosts[0];
    if (st) st.scrollIntoView({ block: 'center' });
    return out;
  });
  console.log('mkdocs', JSON.stringify(info));
  await new Promise(r => setTimeout(r, 800));
  await p.screenshot({ path: process.argv[2] + '/ref5-mkdocs.png' }); await p.close();
  // github: screenshot first rendered mermaid iframe
  p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.goto('https://github.com/mermaid-js/mermaid/blob/develop/README.md', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 6000));
  const frames = await p.$$('iframe[src*="viewscreen"]');
  console.log('github frames', frames.length);
  for (let i = 0; i < Math.min(frames.length, 4); i++) {
    await frames[i].evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 2500));
    const fr = await frames[i].contentFrame();
    const d = fr ? await fr.evaluate(() => { const svg = document.querySelector('svg'); if (!svg) return null; const r = svg.querySelector('.node rect, .node path, .node polygon'); const cs = r && getComputedStyle(r); const t = svg.querySelector('.nodeLabel, text'); return { type: svg.getAttribute('aria-roledescription'), fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily }; }).catch(e => 'err ' + e.message) : 'noframe';
    console.log('github', i, JSON.stringify(d));
    await frames[i].screenshot({ path: `${process.argv[2]}/ref5-github-${i}.png` }).catch(e => console.log('shot', e.message));
  }
  await b.close();
})();
