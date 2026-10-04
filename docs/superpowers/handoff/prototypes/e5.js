const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const SEL = ['bold', 'italic', 'strikethrough', 'underline', 'code', 'link'].map(ico);
const I = { link: ico('link'), ext: ico('external-link'), pen: ico('pencil'), unlink: ico('unlink'), enter: ico('corner-down-left') };
const E5CSS = `
.ed-seltb.e-icons .ed-seltb-btn{width:30px!important;height:30px!important;display:inline-grid!important;place-items:center!important;padding:0!important;color:var(--e-mut)!important}
.ed-seltb.e-icons .ed-seltb-btn:hover{color:var(--e-ink)!important}
.ed-seltb.e-icons .ed-seltb-btn svg{width:16px;height:16px;stroke-width:2}
.ed-seltb.e-icons{padding:3px!important;gap:2px!important}
.ed-seltb .e-sep{width:1px;height:18px;background:var(--e-rule);margin:0 3px;align-self:center}
.e-linkbar{position:absolute;z-index:300;display:flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;width:360px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink)}
.e-linkbar svg{width:16px;height:16px;color:var(--e-mut);flex:none}
.e-linkbar input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--e-ink);font:14px/1.4 inherit;padding:4px 0}
.e-linkbar input::placeholder{color:var(--e-glyph)}
.e-linkbar button{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:6px;padding:5px 10px;font:600 13px inherit;background:var(--e-accent);color:var(--e-surface)}
.e-linkbar button svg{color:inherit;width:14px;height:14px}
.e-linkcard{position:absolute;z-index:300;display:flex;align-items:center;gap:2px;padding:4px 4px 4px 10px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink);font-size:13px}
.e-linkcard .u{color:var(--e-accent);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px}
.e-linkcard button{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--e-mut)}
.e-linkcard button:first-of-type{background:var(--e-hover)}
.e-linkcard svg{width:15px;height:15px}
`;
(async () => {
  const port = 47221;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + E5CSS });
    await p.evaluate(([m, x]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
    }, [svgMap, extra]);
    const pos = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const para = h.nextElementSibling;
      para.scrollIntoView({ block: 'start' }); scrollBy(0, -250); const ed = para.querySelector('[contenteditable]');
      // select the text "IEEE 802.3-2022"
      const tw = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const i = n.data.indexOf('功能摘要'); if (i >= 0) { const r = ed.getBoundingClientRect(); const rr = document.createRange(); rr.setStart(n, i); rr.setEnd(n, i + 4); const q = rr.getBoundingClientRect(); return { x1: q.left + 1, x2: q.right - 1, y: q.top + q.height / 2, L: r.left, T: q.top }; } } });
    await p.mouse.move(pos.x1, pos.y); await p.mouse.down(); await p.mouse.move(pos.x2, pos.y, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(500);
    const clip = { x: pos.L - 40, y: pos.T - 90, width: 900, height: 170 };
    await p.screenshot({ path: `e5-${T}-cur.png`, clip });
    await p.evaluate((S) => { const tb = document.querySelector('.ed-seltb'); tb.classList.add('e-icons'); const bs = tb.querySelectorAll('.ed-seltb-btn');
      bs.forEach((b, i) => { if (S[i]) b.innerHTML = S[i]; }); const sep = document.createElement('span'); sep.className = 'e-sep'; bs[5] && tb.insertBefore(sep, bs[5]); }, SEL);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-icons.png`, clip });
    // link bar replaces the toolbar
    await p.evaluate((I) => { const tb = document.querySelector('.ed-seltb'); const r = tb.getBoundingClientRect(); tb.style.visibility = 'hidden';
      const bar = document.createElement('div'); bar.className = 'e-linkbar'; bar.innerHTML = I.link + '<input value="https://www.ieee802.org/3/" aria-label="網址"><button>' + I.enter + '套用</button>';
      bar.style.left = (r.left + scrollX) + 'px'; bar.style.top = (r.top + scrollY) + 'px'; document.body.appendChild(bar); }, I);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-linkbar.png`, clip });
    await p.evaluate(() => { const bar = document.querySelector('.e-linkbar'); bar.querySelector('input').value = ''; bar.querySelector('input').placeholder = '貼上或輸入網址'; });
    await p.screenshot({ path: `e5-${T}-linkbar-empty.png`, clip });
    // link card on an existing link
    await p.evaluate((I) => { document.querySelector('.e-linkbar').remove(); const tb = document.querySelector('.ed-seltb'); tb.style.display = 'none';
      const s = getSelection(); const rg = s.getRangeAt(0); const a = document.createElement('a'); a.href = 'https://www.ieee802.org/3/'; rg.surroundContents(a);
      const r2 = document.createRange(); r2.setStart(a.firstChild, 2); r2.collapse(true); s.removeAllRanges(); s.addRange(r2);
      const q = a.getBoundingClientRect(); const c = document.createElement('div'); c.className = 'e-linkcard';
      c.innerHTML = '<span class="u">www.ieee802.org/3/</span><button aria-label="開啟">' + I.ext + '</button><button aria-label="編輯">' + I.pen + '</button><button aria-label="移除連結">' + I.unlink + '</button>';
      c.style.left = (q.left + scrollX) + 'px'; c.style.top = (q.bottom + scrollY + 6) + 'px'; document.body.appendChild(c); }, I);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-card.png`, clip: { x: clip.x, y: clip.y + 40, width: 900, height: 170 } });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
