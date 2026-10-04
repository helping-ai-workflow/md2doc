// Prototype: B paper chrome with light + dark tokens, edit page passed through applyReaderTheme.
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ICONS = { save: 'save', undo: 'undo-2', redo: 'redo-2', headings: 'heading', quote: 'quote', code: 'code', list: 'list',
  'ordered-list': 'list-ordered', check: 'list-checks', bold: 'bold', italic: 'italic', strike: 'strikethrough', 'inline-code': 'code',
  link: 'link', outdent: 'indent-decrease', indent: 'indent-increase', table: 'table', 'insert-before': 'arrow-up-to-line',
  'insert-after': 'arrow-down-to-line', line: 'minus', image: 'image', outline: 'panel-left', preview: 'file-code-2' };
const svgMap = {}; for (const k in ICONS) svgMap[k] = ico(ICONS[k]);
const extra = { grip: ico('grip-vertical'), plus: ico('plus'), sun: ico('sun'), moon: ico('moon') };
const CSS = `
:root{--e-bar:#ffffff;--e-surface:#ffffff;--e-ring:0 0 0 1px rgba(31,35,40,.12),0 8px 24px rgba(31,35,40,.10);--e-ink:#1f2328;--e-mut:#57606a;
  --e-hover:#f3f5f7;--e-active-bg:#dbe6f3;--e-active-fg:#0550ae;--e-accent:#0969da;--e-rule:#d8dee4;--e-sel:rgba(9,105,218,.10);--e-glyph:#8c959f;--e-field:#f6f8fa}
html[data-md2doc-theme="dark"]{--e-bar:#1b1b1d;--e-surface:#2a2a2d;--e-ring:0 0 0 1px rgba(255,255,255,.10),0 8px 24px rgba(0,0,0,.55);--e-ink:#e3e3e3;--e-mut:#a3a6ab;
  --e-hover:#303134;--e-active-bg:#24364f;--e-active-fg:#a5c9f8;--e-accent:#6ea8f5;--e-rule:#38393c;--e-sel:rgba(110,168,245,.16);--e-glyph:#7d8086;--e-field:#232325}
.ed-toolbar{background:var(--e-bar)!important;border-bottom:1px solid var(--e-rule)!important;box-shadow:none!important;border-radius:0!important}
.ed-toolbar-btn{background:transparent!important;border:0!important;color:var(--e-mut)!important;width:32px!important;height:32px!important;border-radius:6px!important;display:inline-grid!important;place-items:center!important;padding:0!important}
.ed-toolbar-btn:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-toolbar-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-toolbar-btn svg{width:18px;height:18px;stroke-width:1.75}
.ed-toolbar-sep{background:var(--e-rule)!important;height:20px!important;width:1px!important;margin:0 8px!important}
.ed-toolbar-status{color:var(--e-mut)!important;background:transparent!important}
.ed-handle-menu,.ed-insert-menu,.ed-seltb,.ed-te-menu,.ed-toolbar-menu{background:var(--e-surface)!important;color:var(--e-ink)!important;box-shadow:var(--e-ring)!important;border:0!important;border-radius:8px!important;backdrop-filter:none!important}
.ed-handle-menu-btn,.ed-insert-menu-btn,.ed-seltb-btn,.ed-toolbar-menu-btn,.ed-te-menu button{background:transparent!important;color:var(--e-ink)!important;border:0!important;border-radius:6px!important}
.ed-handle-menu-btn:hover,.ed-insert-menu-btn:hover,.ed-seltb-btn:hover,.ed-toolbar-menu-btn:hover,.ed-te-menu button:hover{background:var(--e-hover)!important}
.ed-seltb-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-handle-menu svg,.ed-insert-menu svg{color:var(--e-mut)!important}
.ed-handle,.ed-insert{background:transparent!important;color:var(--e-glyph)!important;border-radius:4px!important}
.ed-handle:hover,.ed-insert:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-block:hover{outline:none!important}
.ed-wys-armed:focus{outline:2px solid var(--e-accent)!important;outline-offset:2px;caret-color:var(--e-accent)!important}
.ed-selected{background:var(--e-sel)!important}
.e-theme-btn svg{width:18px;height:18px;stroke-width:1.75}
`;
const FIXES = `
.ed-raw,.ed-raw textarea,textarea.ed-source{background:var(--e-field)!important;color:var(--e-ink)!important;border-color:var(--e-rule)!important}
.ed-te-grip-row,.ed-te-grip-col{background:var(--e-surface)!important;box-shadow:var(--e-ring)!important;border:0!important;color:var(--e-glyph)!important}
.ed-tb-insert{background:var(--e-surface)!important;border-color:var(--e-accent)!important;color:var(--e-accent)!important}
.ed-li-check{border-color:var(--e-glyph)!important}
`;
(async () => {
  const port = 47151;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  const runs = [['Bl', 'light', 'tb', false], ['Bd', 'dark', 'tb', false], ['Bdfix', 'dark', 'tb', true], ['Bdbub', 'dark', 'bubble', true]];
  for (const [tag, theme, place, fix] of runs) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
    await p.route('**/edit/0', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + (fix ? FIXES : '') + (place === 'tb' ? '.md2doc-theme-toggle,[class*="theme-bubble"],[class*="theme-toggle"]:not(.e-theme-btn){display:none!important}' : '') });
    const swap = async () => p.evaluate(([m, x, place]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k] && !btn.querySelector('svg')) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.plus; });
      if (place === 'tb' && !document.querySelector('.e-theme-btn')) {
        const pv = document.querySelector('[data-ed-tb="preview"]'); const btn = document.createElement('button');
        btn.className = 'ed-toolbar-btn e-theme-btn'; btn.title = '切換深色／淺色';
        btn.innerHTML = document.documentElement.getAttribute('data-md2doc-theme') === 'dark' ? x.sun : x.moon; pv.after(btn);
      }
    }, [svgMap, extra, place]);
    await swap();
    const shot = async (st) => { await swap(); await p.screenshot({ path: tag + '-' + st + '.png' }); };
    await shot('rest');
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
    await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const h = await para.evaluate((e) => { const x = e.querySelector('.ed-handle').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
    const conv = await p.$('.ed-handle-menu button'); if (conv) { await conv.hover(); await p.waitForTimeout(400); }
    await shot('handlemenu'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const ins = await para.evaluate((e) => { const x = e.querySelector('.ed-insert').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await shot('insert'); await p.keyboard.press('Escape');
    await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500); await shot('seltb'); await p.keyboard.press('Escape');
    const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table')].find((x) => x.rows.length > 3));
    await t.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const tr = await t.evaluate((e) => { const c = e.rows[2].cells[1].getBoundingClientRect(); return { x: c.left + 20, y: c.top + c.height / 2, by: c.bottom }; });
    await p.mouse.move(tr.x, tr.y); await p.waitForTimeout(300); await p.mouse.move(tr.x, tr.by - 1); await p.waitForTimeout(500);
    await shot('table');
    const code = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block')].find((b) => b.querySelector('pre code')));
    await code.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await code.click(); await p.waitForTimeout(700);
    await shot('raw'); await p.keyboard.press('Escape');
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
