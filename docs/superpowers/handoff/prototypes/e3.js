const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ITEMS = [
  ['基本', [['type', '文字', '一般段落', ''], ['heading-1', '標題 1', '章節大標', '#'], ['heading-2', '標題 2', '小節標題', '##'], ['heading-3', '標題 3', '更小的標題', '###']]],
  ['清單', [['list', '項目符號列表', '不分先後的條列', '-'], ['list-ordered', '編號列表', '有順序的步驟', '1.'], ['square-check', '待辦清單', '可勾選的項目', '[]']]],
  ['區塊', [['quote', '引用', '引述或備註', '>'], ['square-code', '程式碼', '等寬程式碼區塊', '```'], ['minus', '分隔線', '水平分隔', '---'], ['table', '表格', '3 欄 × 2 列', ''], ['image', '圖片', '上傳或貼上圖片', '']]],
  ['圖表', [['workflow', 'Mermaid 圖', '流程圖、時序圖', ''], ['git-fork', 'Graphviz 圖', 'dot 有向圖', ''], ['activity', 'WaveDrom 波形', '時序波形，可視覺編輯', ''], ['sigma', '數學公式', 'KaTeX 區塊公式', '$$']]],
];
const svg = {}; ITEMS.forEach(([, l]) => l.forEach(([i]) => { svg[i] = ico(i); }));
const E3CSS = `
.e-slash{position:absolute;z-index:200;width:280px;max-height:372px;overflow:auto;padding:6px;border-radius:8px;background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring);font-size:14px}
.e-slash .grp{font-size:12px;font-weight:600;color:var(--e-mut);padding:8px 8px 4px}
.e-slash .it{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px;border-radius:6px}
.e-slash .it.on{background:var(--e-hover)}
.e-slash .it svg{width:16px;height:16px;flex:none;color:var(--e-mut);stroke-width:1.75}
.e-slash .it .nm{flex:1}
.e-slash .it kbd{font:12px ui-monospace,Consolas,monospace;color:var(--e-mut)}
.e-slash.m2{width:320px}
.e-slash.m2 .it{height:48px}
.e-slash.m2 .tile{width:32px;height:32px;border-radius:6px;display:grid;place-items:center;box-shadow:0 0 0 1px var(--e-rule);background:var(--e-bar)}
.e-slash.m2 .tx{display:grid;line-height:1.3;flex:1}.e-slash.m2 .ds{font-size:12px;color:var(--e-mut)}
.e-slash .foot{border-top:1px solid var(--e-rule);margin:6px -6px -6px;padding:6px 14px;font-size:12px;color:var(--e-mut)}
.e-ph::before{content:attr(data-ph);color:var(--e-glyph);pointer-events:none}
`;
function menuHtml(kind, filter) {
  let h = '';
  for (const [g, list] of ITEMS) {
    const items = list.filter((x) => !filter || x[1].includes(filter) || x[2].includes(filter));
    if (!items.length) continue;
    h += `<div class="grp">${g}</div>`;
    for (const [i, nm, ds, k] of items) {
      h += kind === 'm1'
        ? `<div class="it">${svg[i]}<span class="nm">${nm}</span><kbd>${k}</kbd></div>`
        : `<div class="it"><span class="tile">${svg[i]}</span><span class="tx"><span>${nm}</span><span class="ds">${ds}</span></span><kbd>${k}</kbd></div>`;
    }
  }
  return h + '<div class="foot">↑↓ 選擇　Enter 插入　Esc 關閉</div>';
}
(async () => {
  const port = 47171;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md', 'empty.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    const prep = async () => {
      await p.addStyleTag({ content: CSS + FIXES + E3CSS });
      await p.evaluate(([m, x]) => {
        document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; });
        document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
      }, [svgMap, extra]);
    };
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500); await prep();
    // a fake new paragraph after the "1 Introduction" body paragraph
    const setup = async (text, ph) => p.evaluate(([text, ph]) => {
      document.querySelectorAll('.e-fake,.e-slash').forEach((e) => e.remove());
      const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim()));
      const para = h.nextElementSibling;
      const f = para.cloneNode(true); f.classList.add('e-fake');
      const ed = f.querySelector('[contenteditable]') || f; ed.querySelectorAll('*:not(.ed-handle):not(.ed-insert)').forEach(() => {});
      ed.textContent = text; if (ph) { ed.classList.add('e-ph'); ed.setAttribute('data-ph', ph); }
      para.after(f); f.scrollIntoView({ block: 'start' }); scrollBy(0, -300);
      ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }, [text, ph]);
    const menu = async (kind, filter) => p.evaluate(([h, kind]) => {
      const f = document.querySelector('.e-fake'); const r = f.getBoundingClientRect();
      const m = document.createElement('div'); m.className = 'e-slash ' + kind; m.innerHTML = h;
      m.style.left = (r.left + scrollX) + 'px'; m.style.top = (r.bottom + scrollY + 6) + 'px';
      document.body.appendChild(m); m.querySelector('.it').classList.add('on');
    }, [menuHtml(kind, filter), kind]);
    await setup('', '輸入文字，或按「/」選擇區塊'); await p.waitForTimeout(300);
    await p.screenshot({ path: `e3-${T}-ph.png` });
    for (const kind of ['m1', 'm2']) {
      await setup('/', ''); await menu(kind, ''); await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-${kind}.png` });
      await setup('/圖', ''); await menu(kind, '圖'); await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-${kind}-filter.png` });
    }
    // empty document
    await p.goto(`http://127.0.0.1:${port}/edit/1`); await p.waitForTimeout(3000); await prep();
    await p.screenshot({ path: `e3-${T}-emptycur.png` });
    await p.evaluate(() => {
      const c = document.querySelector('.content');
      const d = document.createElement('div'); d.className = 'ed-block'; d.style.cssText = 'padding:2px 0';
      const e = document.createElement('p'); e.className = 'ed-wys-armed e-ph'; e.setAttribute('data-ph', '從這裡開始輸入，或按「/」選擇區塊'); e.contentEditable = 'true'; e.style.margin = '0';
      d.appendChild(e); c.appendChild(d); e.focus();
    });
    await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-empty.png` });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
