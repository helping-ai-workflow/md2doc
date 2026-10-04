const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = { check: ico('check'), load: ico('loader-circle'), alert: ico('circle-alert'), x: ico('x'), info: ico('info'), retry: ico('rotate-cw') };
const E2CSS = `
:root{--e-err:#cf222e;--e-err-bg:#ffebe9;--e-err-ink:#82071e;--e-ok:#1a7f37;--e-dirty:#9a6700}
html[data-md2doc-theme="dark"]{--e-err:#ff8a8a;--e-err-bg:#3a2224;--e-err-ink:#ffc9c9;--e-ok:#6fdd8b;--e-dirty:#e3b341}
.e-status{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--e-mut)}
.e-status svg{width:15px;height:15px;stroke-width:2}
.e-status.ok svg{color:var(--e-ok)} .e-status.dirty .dot{width:8px;height:8px;border-radius:50%;background:var(--e-dirty)}
.e-status.err{color:var(--e-err)} .e-status.saving svg{color:var(--e-mut)}
.e-status .sep{opacity:.5}
.ed-toolbar-btn.e-save-dirty{color:var(--e-accent)!important;background:var(--e-active-bg)!important}
.e-banner{position:fixed;top:var(--ed-toolbar-h,44px);left:50%;transform:translateX(-50%);margin-top:10px;z-index:999;display:flex;align-items:center;gap:12px;
  max-width:min(760px,calc(100vw - 32px));padding:10px 10px 10px 14px;border-radius:8px;background:var(--e-err-bg);color:var(--e-err-ink);
  box-shadow:inset 3px 0 0 var(--e-err),var(--e-ring);font-size:14px;line-height:1.5}
.e-banner svg{width:18px;height:18px;flex:none;color:var(--e-err)}
.e-banner .msg{flex:1}
.e-banner button{font:inherit;font-size:13px;font-weight:600;border:0;border-radius:6px;padding:4px 12px;cursor:pointer;background:var(--e-err);color:var(--e-surface)}
.e-banner button.x{background:transparent;color:var(--e-err-ink);padding:4px;display:grid;place-items:center}
.e-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:999;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;
  background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring);font-size:14px}
.e-toast svg{width:16px;height:16px;color:var(--e-mut)}
`;
(async () => {
  const port = 47161;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  // current look: one shot of the real red banner for comparison (light, original CSS)
  {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.evaluate(() => { const el = document.createElement('div'); el.className = 'ed-conflict';
      el.innerHTML = '<span>File changed on disk — reload to pick up external edits (your unsaved changes will be lost).</span><button>Reload</button><button aria-label="Dismiss">✕</button>'; document.body.appendChild(el); });
    await p.screenshot({ path: 'e2-cur-banner.png', clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.evaluate(() => { document.querySelector('.ed-conflict span').textContent = '選取範圍不連續，無法整批操作'; document.querySelectorAll('.ed-conflict button')[0].remove(); });
    await p.screenshot({ path: 'e2-cur-notice.png', clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.context().close();
  }
  for (const theme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/0', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + E2CSS });
    await p.evaluate(([m, x]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
    }, [svgMap, extra]);
    const setStatus = async (html, dirtySave) => p.evaluate(([h, d]) => {
      const st = document.querySelector('.ed-toolbar-status'); st.innerHTML = h;
      document.querySelector('[data-ed-tb="save"]').classList.toggle('e-save-dirty', !!d);
      document.querySelector('[data-ed-tb="save"]').removeAttribute('disabled');
    }, [html, dirtySave]);
    const T = theme === 'light' ? 'l' : 'd';
    const strip = async (name) => p.screenshot({ path: `e2-${T}-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 48 } });
    // S1 manual
    await setStatus('<span class="e-status dirty"><span class="dot"></span>有未儲存的變更<span class="sep">·</span>Ctrl+S 儲存</span>', true); await strip('s1-dirty');
    await setStatus(`<span class="e-status ok">${I.check}已儲存</span>`, false); await strip('s1-saved');
    // S2 autosave
    await setStatus(`<span class="e-status saving">${I.load}儲存中…</span>`, false); await strip('s2-saving');
    await setStatus(`<span class="e-status ok">${I.check}已儲存</span>`, false); await strip('s2-saved');
    await setStatus(`<span class="e-status err">${I.alert}無法儲存，3 秒後重試</span>`, false); await strip('s2-err');
    // N2 error banner
    await p.evaluate((I) => { const el = document.createElement('div'); el.className = 'e-banner'; el.setAttribute('role', 'alert');
      el.innerHTML = I.alert + '<span class="msg">這個檔案剛在別處被修改。重新載入會帶入新內容，並捨棄你在這裡還沒儲存的變更。</span><button>重新載入</button><button class="x" aria-label="關閉">' + I.x + '</button>';
      document.body.appendChild(el); }, I);
    await p.screenshot({ path: `e2-${T}-banner.png`, clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.evaluate(() => document.querySelector('.e-banner').remove());
    await p.evaluate((I) => { const el = document.createElement('div'); el.className = 'e-toast'; el.setAttribute('role', 'status');
      el.innerHTML = I.info + '<span>選取範圍不連續，無法整批操作</span>'; document.body.appendChild(el); }, I);
    await p.screenshot({ path: `e2-${T}-toast.png`, clip: { x: 0, y: 700, width: 1440, height: 200 } });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
