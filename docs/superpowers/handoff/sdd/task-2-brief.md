### Task 2: 編輯器外框改成 B 淺色紙面（var 角色）

**Files:**
- Modify: `lib/md2doc.js`（閱讀頁 `<style>` 裡 `.ed-*` 規則，錨點 `.ed-block { position: relative; cursor: pointer; }` 到 `.ed-conflict button`；以及 `editModeLayoutCss` 內的 `.ed-wave-edit-btn`）
- Test: `test/editor-click.test.js`

**Interfaces:**
- Consumes: Task 1 的 `--md-ed-*` 變數與既有 `--md-accent`、`--md-strong`、`--md-muted`、`--md-border`、`--md-rule`、`--md-active-bg`、`--md-active-fg`。
- Produces: 選單類元件共用外觀：`background: var(--md-ed-surface); color: var(--md-strong); border-radius: 8px; box-shadow: 0 0 0 1px var(--md-ed-ring), 0 8px 24px var(--md-ed-shadow);`

- [ ] **Step 1: 寫失敗的點擊檢查**

`test/editor-click.test.js` 在 theme 檢查之後加：

```js
check('chrome: light toolbar is paper white with no dark pill', DESKTOP, async (page) => {
  const s = await page.evaluate(() => {
    const bar = getComputedStyle(document.querySelector('.ed-toolbar'));
    const btn = getComputedStyle(document.querySelector('.ed-toolbar-btn'));
    return { bg: bar.backgroundColor, btnBorder: btn.borderTopWidth, btnBg: btn.backgroundColor };
  });
  assert.strictEqual(s.bg, 'rgb(255, 255, 255)');
  assert.strictEqual(s.btnBorder, '0px');
  assert.strictEqual(s.btnBg, 'rgba(0, 0, 0, 0)');
});
check('chrome: block hover draws no dashed outline', DESKTOP, async (page) => {
  const p = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await p.hover(); await wait(200);
  const o = await p.evaluate((e) => getComputedStyle(e).outlineStyle);
  assert.notStrictEqual(o, 'dashed');
});
check('chrome: dark menus and selection toolbar are readable', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const para = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await para.hover(); await wait(200);
  await para.locator('.ed-handle').click(); await wait(300);
  const menu = await page.evaluate(() => {
    const m = document.querySelector('.ed-handle-menu');
    const b = m.querySelector('.ed-handle-menu-btn');
    return { bg: getComputedStyle(m).backgroundColor, fg: getComputedStyle(b).color };
  });
  assert.strictEqual(menu.bg, 'rgb(42, 42, 45)');
  assert.ok(contrast(menu.fg, menu.bg) >= 4.5, 'menu text contrast ' + JSON.stringify(menu));
  await page.keyboard.press('Escape');
  await para.locator('.ed-wys-armed').dblclick(); await wait(400);
  const tb = await page.evaluate(() => {
    const t = document.querySelector('.ed-seltb');
    return { bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t.querySelector('.ed-seltb-btn')).color };
  });
  assert.strictEqual(tb.bg, 'rgb(42, 42, 45)');
  assert.ok(contrast(tb.fg, tb.bg) >= 4.5, 'seltb contrast ' + JSON.stringify(tb));
});
check('chrome: focus ring and selection tint use the reader accent', DESKTOP, async (page) => {
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await wait(200);
  const ring = await ed.evaluate((e) => getComputedStyle(e).outlineColor);
  assert.strictEqual(ring, 'rgb(9, 105, 218)');
});
```

- [ ] **Step 2: 跑確認紅**

Run: `MD2DOC_ENGINES=chromium node test/editor-click.test.js "chrome:"`
Expected: 4 項皆 FAIL（深色膠囊 `rgba(16, 18, 21, 0.92)`、`dashed`、`#3b82f6` → `rgb(59, 130, 246)`）。

- [ ] **Step 3: 改寫 CSS**

在 `lib/md2doc.js` 依下表逐條改（左欄錨點是選擇器原文，在 `<style>` 區段內 `grep -n` 找；每條只改顏色與列出的屬性，其餘宣告不動）。所有新寫的顏色只用 `var(--md-…)`，不得新增色碼常值。

| 規則 | 改成 |
|---|---|
| `.ed-block:hover { outline: 1px dashed #b0b0b0; }` | 整行刪除 |
| `.ed-block.ed-selected { background: rgba(59, 130, 246, 0.15); }` 及其下 5 行 `!important` 群組 | `rgba(59, 130, 246, 0.15)` → `var(--md-ed-sel)` |
| `.ed-li-check` 兩行與 `.ed-li-check[data-checked="1"]` | Task 10 處理，這裡先只把 `#8a8a8a` → `var(--md-ed-glyph)`、`#3b82f6` → `var(--md-accent)` |
| `.ed-wys-armed:focus`、`.ed-wys-cell:focus` | `#3b82f6` → `var(--md-accent)`（outline 與 caret-color） |
| `.ed-handle`、`.ed-insert` | `color: #8a8a8a` → `color: var(--md-ed-glyph)` |
| `.ed-handle:hover`、`.ed-insert:hover` | `background: rgba(0, 0, 0, 0.08)` → `background: var(--md-ed-hover); color: var(--md-strong)` |
| `.ed-handle-menu`、`.ed-insert-menu`、`.ed-te-menu`、`.ed-seltb`、`.ed-toolbar-menu` | `background: rgba(16, 18, 21, 0.9x); color: #e6edf3;` → `background: var(--md-ed-surface); color: var(--md-strong);`；`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2x/0.35)` → `box-shadow: 0 0 0 1px var(--md-ed-ring), 0 8px 24px var(--md-ed-shadow)` |
| `.ed-handle-menu-btn`、`.ed-insert-menu-btn`、`.ed-te-menu-btn`、`.ed-seltb-btn`、`.ed-toolbar-btn` | `border: 1px solid rgba(255, 255, 255, 0.25)` → `border: 1px solid transparent`；`background: rgba(255, 255, 255, 0.08)` → `background: transparent` |
| 上列各 `-btn:hover…` 與 `.ed-toolbar-menu-btn:hover`、`[data-ed-tb-menu-cursor]` 的 `background: rgba(255, 255, 255, 0.18)` | → `background: var(--md-ed-hover)` |
| `.ed-seltb-btn[aria-pressed="true"]`、`.ed-toolbar-btn[aria-pressed="true"]` | `background: #e6edf3; color: #101215; border-color: #e6edf3;` → `background: var(--md-active-bg); color: var(--md-active-fg); border-color: transparent;` |
| `…[aria-pressed="mixed"]` 兩條 | `background: rgba(230, 237, 243, 0.3); border-style: dashed; border-color: rgba(230, 237, 243, 0.8);` → `background: transparent; border-style: dashed; border-color: var(--md-border);` |
| `.ed-toolbar-btn[data-ed-tb-cursor]`、`.ed-toolbar-menu-btn[data-ed-tb-menu-cursor]` | `#6ea8fe` → `var(--md-accent)` |
| `.ed-toolbar` | `background: rgba(16, 18, 21, 0.92); color: #e6edf3;` → `background: var(--md-ed-chrome); color: var(--md-muted); border-bottom: 1px solid var(--md-rule);`；`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);` → `box-shadow: none;`；`--ed-tb-edge-l/r: rgba(0, 0, 0, 0)` 與兩個 `linear-gradient(…, rgba(0, 0, 0, 0))` 中的 `rgba(0, 0, 0, 0)` → `transparent` |
| `.ed-toolbar[data-ed-tb-overflow~="left/right"]` | `rgba(0, 0, 0, 0.55)` → `var(--md-ed-shadow)` |
| `.ed-toolbar-sep` | `background: rgba(255, 255, 255, 0.25)` → `background: var(--md-rule)`；`height: 18px` → `height: 20px`；`margin: 0 2px` → `margin: 0 6px` |
| `.ed-toolbar-btn` | `min-width: 28px; height: 26px; padding: 0 8px;` → `min-width: 32px; height: 32px; padding: 0;`，並加 `display: inline-grid; place-items: center; color: var(--md-muted);` |
| `.ed-toolbar-btn:hover:not(:disabled)` | 加 `color: var(--md-strong);` |
| `.ed-tb-insert` | `border: 1px solid #3b82f6` → `var(--md-accent)`；`background: #fff; color: #3b82f6` → `background: var(--md-ed-surface); color: var(--md-accent)`；`box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2)` → `box-shadow: 0 0 0 1px var(--md-ed-ring), 0 2px 6px var(--md-ed-shadow)` |
| `.ed-tb-insert:hover` | `background: #3b82f6; color: #fff;` → `background: var(--md-accent); color: var(--md-ed-surface);` |
| `.ed-te-hl` | `rgba(59, 130, 246, 0.15)` → `var(--md-ed-sel)` |
| `.ed-cell-range` | `rgba(59, 130, 246, 0.18)` → `var(--md-ed-range)` |
| `.ed-te-drop-indicator`、`.ed-block-drop-indicator` | `#3b82f6` → `var(--md-accent)` |
| `.ed-te-grip:hover` | `rgba(0, 0, 0, 0.06)` → `var(--md-ed-hover)` |
| `.ed-te-grip-dot` | `#9ca3af` → `var(--md-ed-glyph)` |
| `.ed-te-grip:hover .ed-te-grip-dot` | `#6b7280` → `var(--md-muted)` |
| `.ed-raw` | `font-family: monospace;` → `font-family: "Cascadia Mono", Consolas, ui-monospace, monospace;`；`border: 1px solid #808080` → `border: 1px solid var(--md-border); border-radius: 6px; background: var(--md-ed-field); color: var(--md-strong);` |
| `.ed-controls button` | `border: 1px solid #b0b0b0; border-radius: 4px; background: #fff;` → `border: 1px solid var(--md-border); border-radius: 6px; background: var(--md-ed-surface); color: var(--md-strong);` |
| `.ed-commit` / `.ed-cancel` | `#0a7a0a` → `var(--md-ed-ok)`；`#b00020` → `var(--md-ed-err)` |
| `.ed-conflict`、`.ed-conflict button` | Task 8 重寫，這裡先不動 |
| `editModeLayoutCss` 的 `.ed-li-marker` 規則 `color: #6b7280` | → `color: var(--md-muted)` |
| `editModeLayoutCss` 的 `.ed-wave-edit-btn` / `:hover` | 背景 `#ffffffee` → `var(--md-ed-surface)`；`color: #222` → `var(--md-strong)`；邊框 `#bbb`／`#888` → `var(--md-border)`；陰影 `rgba(0,0,0,.2)` → `var(--md-ed-shadow)` |
| `.ed-source` | Task 6 刪除，這裡不動 |

改完用這個指令確認編輯器外框沒有殘留舊色（應只剩 `.ed-wave-*`、`.ed-conflict`、`.ed-source` 的行）：

```bash
node -e "
const s=require('fs').readFileSync('lib/md2doc.js','utf8');
const old=['#3b82f6','rgba(16, 18, 21','#e6edf3','#101215','#6ea8fe','#8a8a8a','#9ca3af','#b0b0b0','rgba(59, 130, 246'];
s.split('\n').forEach((l,i)=>{ if(old.some(o=>l.includes(o))) console.log(i+1, l.trim().slice(0,100)); });"
```

Expected: 沒有輸出，或只剩 `.ed-conflict` 與註解行。

- [ ] **Step 4: 跑確認綠**

Run: `node test/editor-click.test.js "chrome:"`
Expected: 8 checks passed（4 × 2 引擎）。

- [ ] **Step 5: 反引號計數、渲染、相關長套件**

Run: 反引號計數 → `352 4`；`node test/editor-client-runtime.test.js > /tmp/b1-t2-rt.log 2>&1; echo $?`；`node test/editor-journey.test.js > /tmp/b1-t2-j.log 2>&1; echo $?`（依序跑，不要同時）。
Expected: exit 0。若有測試斷言舊色碼（例如 `rgb(59, 130, 246)` 或 `rgba(16, 18, 21, 0.92)`），把期望值改成新值（`rgb(9, 105, 218)`、`rgb(255, 255, 255)` 等），在該處註解寫「v3.10.0 B 外觀」——這是規格要求的外觀改變，不是削弱測試。改了哪幾處要列在 commit 訊息裡。

- [ ] **Step 6: Commit**

```bash
git add lib/md2doc.js test/editor-click.test.js test/editor-client-runtime.test.js test/editor-journey.test.js
git commit -m "feat(editor): paper-white chrome on theme roles (B design)"
```

---

