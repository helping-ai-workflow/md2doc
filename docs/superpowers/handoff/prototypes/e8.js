const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['copy', 'chevron-down', 'pencil', 'replace', 'text-cursor-input', 'trash-2', 'check'].forEach((n) => { I[n] = ico(n); });
const md = fs.readFileSync(__dirname + '/doc/mac-tx-core.md', 'utf8');
const dot = md.match(/```dot\n([\s\S]*?)```/)[1];
const E8 = `
.e-code{position:relative}
.e-code pre{outline:2px solid var(--e-accent)!important;outline-offset:2px;caret-color:var(--e-accent)}
.e-chipbar{position:absolute;top:6px;right:8px;display:flex;gap:4px;z-index:5}
.e-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;font:12px/1 var(--f-ui,inherit);background:var(--e-surface);color:var(--e-mut);box-shadow:0 0 0 1px var(--e-rule)}
.e-chip svg{width:13px;height:13px}
.e-dg-btn{position:absolute;top:8px;right:8px;z-index:5;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;font-size:13px;background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring)}
.e-dg-btn svg{width:14px;height:14px;color:var(--e-mut)}
.e-split{border-radius:8px;box-shadow:0 0 0 2px var(--e-accent);overflow:hidden;margin:8px 0}
.e-split .hd{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;font-size:12px;color:var(--e-mut);background:var(--e-field);border-bottom:1px solid var(--e-rule)}
.e-split .hd b{color:var(--e-ink);font-weight:600}.e-split .hd .sp{flex:1}
.e-split .hd button{border:0;border-radius:6px;padding:4px 10px;font:600 12px inherit;background:var(--e-accent);color:var(--e-surface)}
.e-split pre.src{margin:0;padding:10px 12px;max-height:220px;overflow:auto;font:12.5px/1.55 "Cascadia Mono",Consolas,ui-monospace,monospace;background:var(--e-field);color:var(--e-ink);border-bottom:1px solid var(--e-rule);white-space:pre}
.e-split .pv{padding:8px;position:relative;overflow:auto;max-height:420px}.e-split .pv .lb{position:absolute;top:6px;left:10px;font-size:11px;color:var(--e-mut)}
.e-imgbar{position:absolute;z-index:6;display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring)}
.e-imgbar span{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:6px;font-size:13px;color:var(--e-ink)}
.e-imgbar span svg{width:14px;height:14px;color:var(--e-mut)} .e-imgbar span.danger{color:var(--e-err,#cf222e)} .e-imgbar span.danger svg{color:inherit}
:root{--e-err:#cf222e} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a}
`;
(async () => {
  const port = 47271;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  const runs = (process.env.RUNS || 'cur:light,cur:dark,new:light,new:dark').split(',').map((x) => x.split(':'));
  for (const [v, theme] of runs) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(5000);
    await p.addStyleTag({ content: CSS + FIXES + E8 });
    await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
    const blk = async (id) => p.evaluate((id) => { const b = document.querySelector('.ed-block[data-block-id="' + id + '"]'); b.scrollIntoView({ block: 'start' }); scrollBy(0, -120); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, id);
    // 1. code
    let r = await blk('282');
    if (v === 'cur') { await p.mouse.click(r.x + 100, r.y + 20); await p.waitForTimeout(800); }
    else await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="282"]'); b.classList.add('e-code'); const pre = b.querySelector('pre'); pre.contentEditable = 'true'; pre.focus();
      const bar = document.createElement('div'); bar.className = 'e-chipbar'; bar.innerHTML = '<span class="e-chip">Verilog' + I['chevron-down'] + '</span><span class="e-chip">' + I.copy + '複製</span>'; b.appendChild(bar); }, [I]);
    await p.waitForTimeout(300); await p.screenshot({ path: `e8-${v}-${T}-code.png` });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    // 2. graphviz
    r = await blk('271');
    if (v === 'cur') { await p.mouse.move(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(400); await p.screenshot({ path: `e8-${v}-${T}-dot.png` });
      await p.mouse.click(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(800); await p.screenshot({ path: `e8-${v}-${T}-dotclick.png` }); await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
    else {
      await p.mouse.move(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(300);
      await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="271"]'); b.style.position = 'relative'; const btn = document.createElement('span'); btn.className = 'e-dg-btn e-tmp'; btn.innerHTML = I.pencil + '編輯圖表'; b.appendChild(btn); }, [I]);
      await p.screenshot({ path: `e8-${v}-${T}-dot.png` });
      await p.evaluate(([dot]) => { document.querySelectorAll('.e-tmp').forEach((e) => e.remove()); const b = document.querySelector('.ed-block[data-block-id="271"]'); const g = b.querySelector('.graphviz') || b.firstElementChild;
        const w = document.createElement('div'); w.className = 'e-split'; w.innerHTML = '<div class="hd"><b>Graphviz</b><span>預覽在停止輸入 0.5 秒後更新</span><span class="sp"></span><button>完成</button></div>';
        const src = document.createElement('pre'); src.className = 'src'; src.textContent = dot; src.contentEditable = 'true'; w.appendChild(src);
        const pv = document.createElement('div'); pv.className = 'pv'; pv.innerHTML = '<span class="lb">預覽</span>'; g.parentNode.insertBefore(w, g); pv.appendChild(g); w.appendChild(pv);
        b.scrollIntoView({ block: 'start' }); scrollBy(0, -120); }, [dot]);
      await p.waitForTimeout(300); await p.screenshot({ path: `e8-${v}-${T}-dotclick.png` });
    }
    // 3. image
    r = await blk('53');
    await p.mouse.move(r.x + r.w / 3, r.y + 40); await p.waitForTimeout(300);
    if (v === 'new') await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="53"]'); const im = b.querySelector('img').getBoundingClientRect();
      const bar = document.createElement('div'); bar.className = 'e-imgbar'; bar.innerHTML = '<span>' + I.replace + '替換</span><span>' + I['text-cursor-input'] + '替代文字</span><span class="danger">' + I['trash-2'] + '刪除</span>';
      bar.style.left = (im.left + scrollX + 8) + 'px'; bar.style.top = (im.top + scrollY + 8) + 'px'; document.body.appendChild(bar); }, [I]);
    await p.screenshot({ path: `e8-${v}-${T}-img.png` });
    if (v === 'cur') { await p.mouse.click(r.x + r.w / 3, r.y + 40); await p.waitForTimeout(800); await p.screenshot({ path: `e8-${v}-${T}-imgclick.png` }); await p.keyboard.press('Escape'); }
    // 4. wave editor (current only)
    if (v === 'cur') {
      const dg0 = await p.evaluate(() => { document.querySelector('.ed-block[data-block-id="671"]').scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(500); const dg = await p.evaluate(() => { const d = document.querySelector('.ed-block[data-block-id="671"] .wavedrom-diagram'); const x = d.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; }); await p.mouse.move(dg.x - 40, dg.y); await p.mouse.move(dg.x, dg.y, { steps: 5 }); await p.waitForTimeout(500); await p.screenshot({ path: `e8-${v}-${T}-wave.png` });
      const bb = await p.evaluate(() => { const bs = [...document.querySelectorAll('.ed-wave-edit-btn')]; const v = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.top < innerHeight; }); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); console.log('wavebtn', JSON.stringify(bb)); if (bb) { await p.mouse.move(bb.x, bb.y); await p.waitForTimeout(200); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(1500); await p.screenshot({ path: `e8-${v}-${T}-waveed.png` }); }
    }
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
