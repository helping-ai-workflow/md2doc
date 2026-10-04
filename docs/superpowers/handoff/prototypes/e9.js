const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['save', 'heading', 'quote', 'list-ordered', 'minus', 'arrow-up-to-line', 'arrow-down-to-line', 'undo-2', 'redo-2', 'panel-left', 'file-code-2', 'sun', 'moon', 'check', 'plus', 'repeat', 'bold', 'italic', 'strikethrough', 'code', 'link', 'list', 'list-checks', 'indent-decrease', 'indent-increase', 'grip-vertical', 'arrow-up', 'arrow-down', 'copy', 'trash-2', 'keyboard', 'table', 'image'].forEach((n) => { I[n] = ico(n); });
const E9 = `
.ed-toolbar{display:none!important}
.m-top{position:fixed;top:0;left:0;right:0;height:48px;z-index:400;display:flex;align-items:center;gap:2px;padding:0 8px;background:var(--e-bar);border-bottom:1px solid var(--e-rule)}
.m-top .b,.m-bot .b{width:40px;height:40px;display:grid;place-items:center;border-radius:8px;color:var(--e-mut);flex:none}
.m-top svg,.m-bot svg{width:20px;height:20px;stroke-width:1.75}
.m-top .sp{flex:1}.m-top .st{font-size:13px;color:var(--e-mut);display:flex;align-items:center;gap:4px;padding-right:4px}.m-top .st svg{width:15px;height:15px;color:var(--e-ok,#1a7f37)}
.m-top .st .dot{width:8px;height:8px;border-radius:50%;background:var(--e-dirty,#9a6700);display:inline-block}
.m-top .b.acc{color:var(--e-accent);background:var(--e-active-bg)}
.m-top.scroll{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,#000 85%,transparent);mask-image:linear-gradient(90deg,#000 85%,transparent)}
.m-top .sep,.m-bot .sep{width:1px;height:22px;background:var(--e-rule);margin:0 4px;flex:none}
.m-kb{position:fixed;left:0;right:0;bottom:0;height:290px;z-index:400;display:grid;place-items:center;background:repeating-linear-gradient(135deg,var(--e-field),var(--e-field) 10px,var(--e-hover) 10px,var(--e-hover) 20px);color:var(--e-mut);font-size:14px;border-top:1px solid var(--e-rule)}
.m-kb span{display:flex;gap:6px;align-items:center;background:var(--e-surface);padding:6px 12px;border-radius:8px;box-shadow:var(--e-ring)} .m-kb svg{width:18px;height:18px}
.m-bot{position:fixed;left:0;right:0;bottom:290px;height:48px;z-index:401;display:flex;align-items:center;gap:2px;padding:0 6px;background:var(--e-bar);border-top:1px solid var(--e-rule);overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent)}
.m-bot .b.acc{color:var(--e-accent)}
.m-sheet-bg{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.35)}
.m-sheet{position:fixed;left:0;right:0;bottom:0;z-index:501;padding:8px 8px calc(16px + env(safe-area-inset-bottom));border-radius:14px 14px 0 0;background:var(--e-surface);color:var(--e-ink);box-shadow:0 -8px 24px rgba(0,0,0,.18)}
.m-sheet .grab{width:36px;height:4px;border-radius:2px;background:var(--e-rule);margin:2px auto 8px}
.m-sheet .ti{font-size:13px;color:var(--e-mut);padding:4px 12px 8px}
.m-sheet .it{display:flex;align-items:center;gap:14px;height:48px;padding:0 12px;border-radius:8px;font-size:16px}
.m-sheet .it svg{width:20px;height:20px;color:var(--e-mut)} .m-sheet .it .nm{flex:1} .m-sheet .it .ch{color:var(--e-mut);font-size:14px}
.m-sheet .it.danger{color:var(--e-err)} .m-sheet .it.danger svg{color:inherit} .m-sheet hr{border:0;border-top:1px solid var(--e-rule);margin:4px 0}
.page-layout{padding-top:48px!important}
:root{--e-err:#cf222e;--e-ok:#1a7f37;--e-dirty:#9a6700} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a;--e-ok:#6fdd8b;--e-dirty:#e3b341}
`;
const TOP = (dark) => `<span class="b">${I['undo-2']}</span><span class="b">${I['redo-2']}</span><span class="sep"></span><span class="b">${I['panel-left']}</span><span class="b">${I['file-code-2']}</span><span class="b">${dark ? I.sun : I.moon}</span><span class="sp"></span><span class="st"><i class="dot"></i>未儲存</span><span class="b acc">${I.save}</span>`;
const BOT = `<span class="b acc">${I.plus}</span><span class="b">${I['grip-vertical']}</span><span class="sep"></span><span class="b">${I.bold}</span><span class="b">${I.italic}</span><span class="b">${I.strikethrough}</span><span class="b">${I.code}</span><span class="b">${I.link}</span><span class="sep"></span><span class="b">${I.list}</span><span class="b">${I['list-checks']}</span><span class="b">${I['indent-decrease']}</span><span class="b">${I['indent-increase']}</span>`;
const SHEET = `<div class="grab"></div><div class="ti">段落 · 改名一律記在本表…</div><div class="it">${I.repeat}<span class="nm">轉換成</span><span class="ch">文字 ›</span></div><div class="it">${I['arrow-up']}<span class="nm">上移</span></div><div class="it">${I['arrow-down']}<span class="nm">下移</span></div><div class="it">${I.copy}<span class="nm">建立副本</span></div><div class="it">${I['file-code-2']}<span class="nm">MD 原始碼</span></div><hr><div class="it danger">${I['trash-2']}<span class="nm">刪除</span></div>`;
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47301', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47301/edit/0'); await p.waitForTimeout(4000);
    await p.addStyleTag({ content: CSS + FIXES + E9 });
    await p.evaluate(([top]) => { document.querySelectorAll('.md2doc-theme-toggle,[class*="theme-bubble"],[class*="theme-toggle"]').forEach((e) => { e.style.display = 'none'; });
      const t = document.createElement('div'); t.className = 'm-top'; t.innerHTML = top; document.body.appendChild(t); }, [TOP(theme === 'dark')]);
    await p.screenshot({ path: `e9-${T}-rest.png` });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => /改名一律/.test(b.textContent)));
    const r = await para.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -80); const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
    await p.waitForTimeout(300); await p.touchscreen.tap(r.x, r.y); await p.waitForTimeout(500);
    await p.evaluate(([bot, I]) => { const k = document.createElement('div'); k.className = 'm-kb'; k.innerHTML = '<span>' + I.keyboard + '系統鍵盤（示意）</span>'; document.body.appendChild(k);
      const b = document.createElement('div'); b.className = 'm-bot'; b.innerHTML = bot; document.body.appendChild(b); }, [BOT, I]);
    await p.waitForTimeout(200); await p.screenshot({ path: `e9-${T}-edit.png` });
    await p.evaluate((sheet) => { document.querySelectorAll('.m-kb,.m-bot').forEach((e) => e.remove()); document.activeElement && document.activeElement.blur();
      const bg = document.createElement('div'); bg.className = 'm-sheet-bg'; document.body.appendChild(bg); const s = document.createElement('div'); s.className = 'm-sheet'; s.innerHTML = sheet; document.body.appendChild(s); }, SHEET);
    await p.waitForTimeout(200); await p.screenshot({ path: `e9-${T}-sheet.png` });
    if (theme === 'light') {
      await p.evaluate((I) => { document.querySelectorAll('.m-sheet,.m-sheet-bg,.m-top').forEach((e) => e.remove());
        const ids = ['save','undo-2','redo-2','|','heading','quote','code','list','list-ordered','list-checks','|','bold','italic','strikethrough','code','link','|','indent-decrease','indent-increase','|','table','arrow-up-to-line','arrow-down-to-line','minus','image','|','panel-left','file-code-2'];
        const t = document.createElement('div'); t.className = 'm-top scroll'; t.innerHTML = ids.map((k) => k === '|' ? '<span class="sep"></span>' : '<span class="b">' + I[k] + '</span>').join(''); document.body.appendChild(t); }, I);
      const r2 = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
      await p.touchscreen.tap(r2.x, r2.y); await p.waitForTimeout(400);
      await p.evaluate((I) => { const k = document.createElement('div'); k.className = 'm-kb'; k.innerHTML = '<span>' + I.keyboard + '系統鍵盤（示意）</span>'; document.body.appendChild(k); }, I);
      await p.screenshot({ path: `e9-${T}-pb.png` });
    }
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
