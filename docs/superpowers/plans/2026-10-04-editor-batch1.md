# 編輯器改版 批 1：外觀與深色 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `md2doc --edit` 換成與閱讀頁同一套外觀（B 淺色紙面、Lucide 圖示、強調色 `#0969da`）、開放深色模式、存檔狀態看得到、訊息分兩級、清單與待辦樣式一致、程式碼語法上色，並移除整份原始碼模式。

**Architecture:** 主題沿用 v3.9.0 的 post-pass（`applyReaderTheme`）並讓編輯模式也跑；編輯器外框 CSS 改寫成 `var(--md-ed-*)`（新增「direct」角色，不參與常值對應），波形編輯器維持常值、交給既有改寫並補 `wave-*` 角色。語法上色在伺服器產生 HTML 時以 highlight.js 完成。原始碼模式整塊刪除，外部修改偵測走 `/api/ping` 的回應標頭。

**Tech Stack:** Node 20、marked 14、highlight.js 11.11.1（新增）、Playwright（Chromium＋WebKit 點擊檢查）、puppeteer（既有長套件）。

**Spec:** `docs/superpowers/specs/2026-10-04-editor-batch1-design.md`（總覽：`docs/superpowers/specs/2026-10-04-editor-overhaul-index.md`）

## Global Constraints

- `docs/superpowers/specs/`、`docs/superpowers/plans/` 永不 `git add`（`.gitignore` 已含 `docs/superpowers/`）。
- 工作在 worktree `/home/user/hp_workspace/md2doc-editor-b1`，分支 `feat/editor-batch1`，從 `main`（`ba72389`，v3.9.1）切出。任何 subagent 的第一步必須 `cd /home/user/hp_workspace/md2doc-editor-b1`。
- `lib/md2doc.js` 的 `<style>` 與 `editModeLayoutCss` 都在 JS template literal 裡：**不得新增反引號，不得新增會被吃掉的反斜線**。每個動到 `lib/md2doc.js` 的任務結束前，用 `node -e "const s=require('fs').readFileSync('lib/md2doc.js','utf8');console.log((s.match(/\x60/g)||[]).length,(s.match(/\\\\\x60/g)||[]).length)"` 確認輸出仍是 `352 4`（Task 11 起是 `354 4`，見該任務；其他任務都不得改變計數），並實際渲染一份文件（`node bin/md2doc.js test/fixtures/… --out /tmp/x.html` 或 render 測試）確認 exit 0。
- `lib/editor/client.js` 含 NUL 位元組：搜尋用 `grep -a`；計數或「不存在」檢查用 node `String.indexOf`，不用 `grep -o | wc -l`。
- `client.js` 裡不得出現子字串：`ed-bar`、`openTableEditor`、`runTableStructureOp`、`selectedBlockEl`、`dismissBar`、`showBarFor`、`updateBarButtons`（`test/editor-client.test.js` 以 `includes` 檢查，連註解也算）。新角色名稱因此用 `ed-chrome` 不用 `ed-bar`。
- `client.js` 必須仍含：`__ED__`、`Ctrl`、`beforeunload`、`/api/save`、`/api/render`、`/api/ping`、`409`、`__md2docInitDiagrams`、`ed-raw`、`ed-wys-cell`、`ed-tb-insert`、`wireBlockSelection`、`ed-selected`、`md2docSelection`。
- 主題屬性是 `data-md2doc-theme`，偏好鍵 `md2doc-theme`；不得用 `data-theme`。
- 不得跑兩個長測試套件或一邊改檔一邊跑 `npm test`（CLAUDE.md：會讀到混合版本）。
- 跑全套：`rtk proxy npm test`（不要讓 RTK 摘要輸出）；點擊檢查：`npm run test:browser`。
- `git diff` 要檢查刪除時一律導到檔案再讀，不要 pipe。
- 每個任務一個以上 commit；commit 訊息英文，結尾加：
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01B7CMwWwLPVYwZdw2TntFdd`。
- 不改波形編輯器的版面與操作，只換顏色（使用者另開審查）。
- 存檔維持手動（E2 定案 S1），不做自動存檔、不做自動重試。

## Review Focus

1. **編輯模式下 Mermaid 區塊重畫後的深色**：主題 runtime 接管 mermaid 的淺／深快取，而編輯器在 `/api/render` 局部重建時會重新初始化圖表（`__md2docInitDiagrams`）。使用者在深色下改了文件裡別的段落，Mermaid 圖應維持深色、不閃回淺色。→ Task 3 的點擊檢查。
2. **勾選的待辦底下有未勾的子項目**：刪除線只該畫在勾選那一項自己的文字上，子項目不能被劃掉（CSS `text-decoration` 會傳給子孫，無法在子層取消）。→ Task 10 的單元與點擊檢查。
3. **提示小框 4 秒自動消失 vs. 依賴橫幅的既有流程**：Esc 優先序、`activeBannerIsRefusal`、鍵盤導覽離開提示在小框消失後要回到「沒有橫幅」的狀態，不能殘留旗標讓下一次 Esc 被吃掉。→ Task 8 的 runtime 測試。
4. **外部修改自動重新載入時正好在打字**：使用者游標在段落裡但還沒提交（burst 未送出）時，`documentIsDirty()` 已為真，必須走衝突卡片而不是重新載入。→ Task 9 的單元與點擊檢查。
5. **未標語言或標了未註冊語言的程式碼區塊**：必須原樣輸出純文字，不得猜語言、不得丟例外；`lang` 帶額外字（例如 ```` ```verilog title=x ````）只取第一個字。→ Task 11 的單元測試。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `lib/theme/tokens.js` | 改 | `THEME_TOKENS` 新增 `direct` 角色（`ed-*`、`syn-*`）與 `wave-*` 常值角色；`LITERAL_TO_TOKEN` 跳過 `direct`；`SKIP_SELECTOR` 只剩 `.lightbox`；新增 `KEEP_RGBA` |
| `lib/theme/runtime.js` | 改 | 切換鈕只在 `#mobile-bar` 實際顯示時才搬進去 |
| `lib/md2doc.js` | 改 | 編輯模式跑 `applyReaderTheme`；編輯器外框 CSS 改寫；清單符號逐層；核取框；閱讀頁待辦；程式碼上色；移除 `.ed-source` 與原始碼模式 CSS |
| `lib/editor/icons.js` | 新 | Lucide 圖示（UMD，`window.md2docIcons`），只收用到的圖示 |
| `lib/editor/toolbar-model.js` | 改 | `icon` 改為圖示名稱；移除 `preview` 與 `mode` |
| `lib/editor/docsource.js` | 刪 | 只服務原始碼模式 |
| `lib/editor/server.js` | 改 | 注入 `icons.js`、移除 `docsource.js` 注入；`/api/ping` 帶 `X-Md2doc-Mtime` |
| `lib/editor/client.js` | 改 | 圖示渲染；⠿ ＋ 對齊；移除原始碼模式；存檔狀態；訊息兩級；外部修改偵測 |
| `package.json` | 改 | 加 `highlight.js` 依賴；`test` 移除 `docsource.test.js`；`test:browser` 加 `editor-click.test.js` |
| `.github/workflows/browser.yml` | 改 | 路徑加 `test/editor-click.test.js` |
| `test/editor-click.test.js` | 新 | 編輯器點擊檢查（Playwright，Chromium＋WebKit，桌面＋手機） |
| `test/theme.test.js`、`test/reader-design.test.js` | 改 | 編輯模式有主題；allow-list 涵蓋 `.ed-` 與其 `rgba` |
| `test/toolbar-model.test.js`、`test/editor-journey.test.js`、`test/editor-client-runtime.test.js`、`test/detach-census.test.js` | 改 | 原始碼模式移除、22 顆、訊息文案的遷移 |
| `test/docsource.test.js` | 刪 | 對應模組刪除 |
| `test/highlight.test.js` | 新 | 語法上色單元測試 |
| `CLAUDE.md`、`CHANGELOG.md` | 改 | 深色規則與發版紀錄 |

---

### Task 1: Worktree、基準線、主題引擎支援 direct 角色並套到編輯模式

**Files:**
- Modify: `lib/theme/tokens.js`
- Modify: `lib/theme/runtime.js`（`place()`）
- Modify: `lib/md2doc.js`（`renderMarkdown` 尾端 `// Edit mode is light-only` 那兩行）
- Modify: `test/reader-design.test.js`（`theme: edit mode output carries no theme at all`）
- Modify: `test/theme.test.js`
- Create: `test/editor-click.test.js`

**Interfaces:**
- Produces: `THEME_TOKENS` 條目可帶 `direct: true`，其 `light[0]` 只用來定義 `:root` 變數、不進 `LITERAL_TO_TOKEN`。CSS 以 `var(--md-<name>)` 直接引用。
- Produces: `test/editor-click.test.js` 的 `check(name, viewport, fn, opts)`、`bootEditor(mdText, opts) -> { url, mdPath, srv }`、`wait(ms)`、`contrast(fgRgb, bgRgb) -> number`，後續任務往這個檔加檢查。

- [ ] **Step 1: 建 worktree 並取得基準線**

```bash
cd /home/user/hp_workspace/md2doc
git fetch origin && git checkout main && git pull --ff-only
git worktree add -b feat/editor-batch1 /home/user/hp_workspace/md2doc-editor-b1 main
cd /home/user/hp_workspace/md2doc-editor-b1
npm install
rtk proxy npm test > /tmp/b1-baseline.log 2>&1; echo "exit $?"
grep -n "FAIL\|AssertionError\|Error:" /tmp/b1-baseline.log | head
```

Expected: exit 0。若唯一失敗是 `editor-journey` 的「F6 前提失敗…childCount=0」，那是 main 上既知的 flake（memory `v390-followups`），重跑一次；兩次都紅才停下回報。

- [ ] **Step 2: 寫失敗測試——direct 角色不搶閱讀頁常值、編輯模式有主題**

`test/theme.test.js`（helper 是 `check(name, fn)`）——既有兩項要改、新增一項：

1. `every token has a name, at least one lowercase #rrggbb or #rgb light literal and a #rrggbb dark value`：direct 角色可以用 `rgba()`。把迴圈內兩個 `assert.match` 改成：

```js
    const COLOUR = t.direct ? /^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba\(\d+, \d+, \d+, (0|1|0?\.\d+)\))$/ : /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
    for (const l of t.light) assert.match(l, COLOUR, t.name);
    assert.match(t.dark, t.direct ? COLOUR : /^#[0-9a-f]{6}$/, t.name);
```

   並把 check 名稱改成 `'every token has a name and well-formed light/dark values (direct roles may use rgba)'`。

2. `a light literal belongs to one token only`：只對非 direct 角色檢查（direct 角色不參與常值對應，`ed-chrome` 的 `#ffffff` 與 `bg` 相同是刻意的）：

```js
  for (const t of T.THEME_TOKENS) if (!t.direct) for (const l of t.light) {
```

3. 新增：

```js
check('direct roles never claim a reader literal', () => {
  const direct = T.THEME_TOKENS.filter((t) => t.direct);
  assert.ok(direct.length > 0, 'guard: at least one direct role exists');
  // '#ffffff' is ed-chrome's light value too; it must still rewrite to bg.
  const out = T.applyThemeTokens('  .x {\n    background: #ffffff;\n  }');
  assert.ok(out.includes('var(--md-bg)'), 'reader #ffffff still maps to bg: ' + out);
  for (const t of direct) assert.ok(/^(ed|syn)-/.test(t.name), 'direct role names start ed- or syn-: ' + t.name);
});
```

4. `dark palette meets the spec contrast table` 的 `pairs` 加上編輯器組合（`contrast()` 只吃 `#hex`，所以只列 hex 角色）：

```js
    ['strong', 'ed-surface', 4.5], ['muted', 'ed-chrome', 4.5], ['muted', 'ed-surface', 4.5],
    ['ed-err-ink', 'ed-err-bg', 4.5], ['active-fg', 'active-bg', 4.5],
    ['accent', 'ed-chrome', 3], ['ed-ok', 'ed-chrome', 3], ['ed-dirty', 'ed-chrome', 3], ['ed-glyph', 'ed-chrome', 3],
```

`test/reader-design.test.js` 把

```js
check('theme: edit mode output carries no theme at all', async () => {
  const src = path.join(tmpDir, 'edit-theme.md');
  const { html } = await renderMarkdown(THEME_MD.join('\n'), src, { editMode: true });
  for (const s of ['md2doc-theme', 'var(--md-', '--md-bg']) assert.ok(!html.includes(s), 'edit HTML contains ' + s);
});
```

換成

```js
check('theme: edit mode output carries the theme (v3.10.0)', async () => {
  const src = path.join(tmpDir, 'edit-theme.md');
  const { html } = await renderMarkdown(THEME_MD.join('\n'), src, { editMode: true });
  for (const s of ['md2doc-theme-toggle', '--md-bg', '--md-ed-chrome', 'md2doc-theme-data']) {
    assert.ok(html.includes(s), 'edit HTML lacks ' + s);
  }
});
```

- [ ] **Step 3: 跑測試確認紅**

Run: `node test/theme.test.js; node test/reader-design.test.js "theme: edit mode"`
Expected: theme.test 失敗於 `guard: at least one direct role exists`；reader-design 失敗於 `edit HTML lacks md2doc-theme-toggle`。（reader-design 若不支援名稱篩選，整支跑，看到這一項 FAIL 即可。）

- [ ] **Step 4: 實作 direct 角色與編輯模式主題**

`lib/theme/tokens.js`：

1. 在 `THEME_TOKENS` 陣列 `error` 之後加（淺／深值取自規格 3.2 表；`ed-ring`/`ed-shadow`/`ed-sel`/`ed-range` 是 rgba，因為 direct 角色只進 `:root` 變數，所以可以是任何 CSS 色值）：

```js
  // v3.10.0 editor chrome. `direct`: referenced only as var(--md-<name>) in
  // the editor CSS, never by literal, so a light value that happens to equal a
  // reader literal ('#ffffff') cannot steal it — see LITERAL_TO_TOKEN below.
  { name: 'ed-chrome', light: ['#ffffff'], dark: '#1b1b1d', direct: true },
  { name: 'ed-surface', light: ['#ffffff'], dark: '#2a2a2d', direct: true },
  { name: 'ed-ring', light: ['rgba(31, 35, 40, 0.12)'], dark: 'rgba(255, 255, 255, 0.10)', direct: true },
  { name: 'ed-shadow', light: ['rgba(31, 35, 40, 0.10)'], dark: 'rgba(0, 0, 0, 0.55)', direct: true },
  { name: 'ed-hover', light: ['#f3f5f7'], dark: '#303134', direct: true },
  { name: 'ed-glyph', light: ['#8c959f'], dark: '#7d8086', direct: true },
  { name: 'ed-field', light: ['#f6f8fa'], dark: '#232325', direct: true },
  { name: 'ed-sel', light: ['rgba(9, 105, 218, 0.10)'], dark: 'rgba(110, 168, 245, 0.16)', direct: true },
  { name: 'ed-range', light: ['rgba(9, 105, 218, 0.14)'], dark: 'rgba(110, 168, 245, 0.20)', direct: true },
  { name: 'ed-err', light: ['#cf222e'], dark: '#ff8a8a', direct: true },
  { name: 'ed-err-bg', light: ['#ffebe9'], dark: '#3a2224', direct: true },
  { name: 'ed-err-ink', light: ['#82071e'], dark: '#ffc9c9', direct: true },
  { name: 'ed-ok', light: ['#1a7f37'], dark: '#6fdd8b', direct: true },
  { name: 'ed-dirty', light: ['#9a6700'], dark: '#e3b341', direct: true },
```

2. 把

```js
for (const t of THEME_TOKENS) for (const l of t.light) LITERAL_TO_TOKEN.set(l, t.name);
```

改成

```js
for (const t of THEME_TOKENS) if (!t.direct) for (const l of t.light) LITERAL_TO_TOKEN.set(l, t.name);
```

3. 把 `SKIP_SELECTOR` 上方註解的「the editor's own UI (edit mode is light only) and」這段先保留不動——`.ed-` 的跳過在 Task 3 才拿掉。

`lib/md2doc.js`：把

```js
  // Edit mode is light-only; noTheme is an internal switch for the light-lock test.
  if (!opts.editMode && !opts.noTheme) bakedHtml = applyReaderTheme(bakedHtml);
```

改成

```js
  // v3.10.0: edit mode is themed too. noTheme is an internal switch for the light-lock test.
  if (!opts.noTheme) bakedHtml = applyReaderTheme(bakedHtml);
```

`lib/theme/runtime.js` 的 `place()` 改成只在 bar 真的看得見時才搬：

```js
  function place() {
    // Edit mode hides #mobile-bar; a button moved into it would vanish, so the
    // bar has to be on screen, not merely in the DOM.
    var barShown = bar && getComputedStyle(bar).display !== 'none';
    if (barShown && phone.matches) { if (btn.parentNode !== bar) bar.appendChild(btn); }
    else if (btn.parentNode !== document.body) document.body.appendChild(btn);
  }
```

- [ ] **Step 5: 建立編輯器點擊檢查檔與第一個檢查**

建立 `test/editor-click.test.js`：

```js
#!/usr/bin/env node
'use strict';

// Editor click-through checks: the --edit page clicked for real in Chromium and
// WebKit at a desktop (1440x900) and a phone (390x844) viewport. Assertions read
// DOM geometry and computed style, never screenshots. Companion of
// test/reader-click.test.js; same runner shape.
//
// Run:   npm run test:browser
// One engine:  MD2DOC_ENGINES=webkit node test/editor-click.test.js
// A subset:    node test/editor-click.test.js "theme:"

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const playwright = require('playwright');
const { createEditorServer } = require('../lib/editor/server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE = [
  '# Editor Fixture', '',
  '## 1. Alpha', '',
  'First paragraph with **bold** text and a [link](https://example.com).', '',
  '- one', '  - two', '    - three', '',
  '- [x] done item', '  - [ ] open child', '- [ ] open item', '',
  '| Signal | Width |', '|---|---|', '| `clk_tx` | 1 |', '| `rst_n` | 1 |', '',
  '\x60\x60\x60verilog', 'module a; assign x = 1\'b0; // c', 'endmodule', '\x60\x60\x60', '',
  '\x60\x60\x60mermaid', 'graph LR', '  A[Start] --> B[End]', '\x60\x60\x60', '',
  '## 2. Beta', '', 'Second paragraph.', '',
].join('\n');

const servers = [];
async function bootEditor(mdText, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-edclick-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText === undefined ? FIXTURE : mdText, 'utf8');
  const srv = await createEditorServer(Object.assign({ files: [mdPath], clientJs: CLIENT_SRC }, opts || {}));
  servers.push(srv);
  return { url: srv.urlFor(mdPath), mdPath, srv };
}

function lum(rgb) {
  const m = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

const checks = [];
function check(name, viewport, fn, opts) { checks.push({ name, viewport, fn, opts: opts || {} }); }

check('theme: the edit page has a theme toggle and it turns the toolbar dark', DESKTOP, async (page) => {
  const btn = page.locator('#md2doc-theme-toggle');
  assert.ok(await btn.isVisible(), 'toggle visible in edit mode');
  await btn.click(); await wait(300);
  const r = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-md2doc-theme'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));
  assert.strictEqual(r.attr, 'dark');
  assert.strictEqual(r.bodyBg, 'rgb(27, 27, 29)');
});
check('theme: on a phone the toggle stays visible in edit mode', PHONE, async (page) => {
  const box = await page.locator('#md2doc-theme-toggle').boundingBox();
  assert.ok(box && box.width > 0 && box.y + box.height <= 844, 'toggle on screen: ' + JSON.stringify(box));
});

(async () => {
  const engines = (process.env.MD2DOC_ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
  const only = process.argv[2];
  let failed = 0; let ran = 0;
  for (const engine of engines) {
    const browser = await playwright[engine].launch();
    try {
      for (const c of checks) {
        if (only && !c.name.includes(only)) continue;
        ran++;
        const boot = await bootEditor(c.opts.md, c.opts.srv);
        const context = await browser.newContext(Object.assign({ viewport: c.viewport }, c.opts.ctx));
        const page = await context.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
        try {
          await page.goto(boot.url, { waitUntil: 'load' });
          await page.waitForSelector('.ed-toolbar');
          await wait(400);
          await c.fn(page, boot);
          assert.deepStrictEqual(errs, [], 'page errors');
          console.log('ok   [' + engine + '] ' + c.name);
        } catch (e) {
          failed++;
          console.log('FAIL [' + engine + '] ' + c.name + '\n     ' + (e && e.message));
        } finally {
          await context.close();
          await boot.srv.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  if (!ran) { console.error('no check matched ' + JSON.stringify(only)); process.exit(1); }
  if (failed) { console.error(failed + ' of ' + ran + ' editor click check(s) failed'); process.exit(1); }
  console.log('editor-click: ' + ran + ' checks passed');
  process.exit(0);
})();
```

`package.json` 的 `"test:browser"` 改成 `"node test/reader-click.test.js && node test/editor-click.test.js"`。`.github/workflows/browser.yml` 兩處 `paths:` 都在 `"test/reader-click.test.js"` 下一行加 `- "test/editor-click.test.js"`。

- [ ] **Step 6: 跑測試確認綠**

Run: `node test/theme.test.js && node test/reader-design.test.js && node test/editor-click.test.js "theme:"`
Expected: 全部 PASS；editor-click 印 `editor-click: 4 checks passed`（2 檢查 × 2 引擎）。

- [ ] **Step 7: 確認反引號計數與全套**

Run: 反引號計數指令（見 Global Constraints）→ `352 4`；`rtk proxy npm test > /tmp/b1-t1.log 2>&1; echo $?`
Expected: `352 4`；exit 0。若 `md2doc.test.js` 有斷言「編輯模式輸出不含 theme」之類而紅，依 Step 2 的方式改成斷言「有主題」，不得刪。

- [ ] **Step 8: Commit**

```bash
git add lib/theme/tokens.js lib/theme/runtime.js lib/md2doc.js test/theme.test.js test/reader-design.test.js test/editor-click.test.js package.json .github/workflows/browser.yml
git commit -m "feat(editor): theme the edit page and add direct editor colour roles"
```

---

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

### Task 3: 波形編輯器顏色角色、移除 `.ed-` 跳過、allow-list 涵蓋編輯器

**Files:**
- Modify: `lib/theme/tokens.js`
- Modify: `test/reader-design.test.js`（`theme: every reader colour literal is either a token or on the keep list`）
- Test: `test/editor-click.test.js`

**Interfaces:**
- Produces: `KEEP_RGBA`（匯出）：`.ed-` 規則裡允許保留的 `rgba(...)` 正規化字串清單。
- Produces: `wave-*` 常值角色（非 direct）。

- [ ] **Step 1: 寫失敗測試**

`test/reader-design.test.js` 的 allow-list 檢查改成也掃編輯模式輸出與 `rgba`：

```js
check('theme: every reader and editor colour literal is either a token or on the keep list', async () => {
  const scan = (html) => {
    const s = html.indexOf('<style>', html.indexOf('</title>'));
    const marker = html.indexOf('/* v3.9.0 dark mode', s);
    assert.ok(marker > s, 'theme block marker present');
    const css = html.slice(s, marker);
    let sel = ''; const hex = new Set(); const rgba = new Set();
    for (const line of css.split('\n')) {
      const b = line.indexOf('{'); if (b !== -1) sel = line.slice(0, b);
      if (/^\s*(\/\*|\*)/.test(line) || /(^|[\s,>+~(])\.lightbox/.test(sel)) continue;
      for (const m of line.match(/#[0-9a-fA-F]{3,6}\b/g) || []) hex.add(m.toLowerCase());
      if (/(^|[\s,>+~(])(html\.ed-|\.ed-)/.test(sel)) {
        for (const m of line.match(/rgba?\([^)]*\)/g) || []) rgba.add(m.replace(/\s+/g, ''));
      }
    }
    return { hex, rgba };
  };
  const reader = scan(render(THEME_MD).html);
  const src = path.join(tmpDir, 'edit-allow.md');
  const edit = scan((await renderMarkdown(THEME_MD.join('\n'), src, { editMode: true })).html);
  const extraHex = [...new Set([...reader.hex, ...edit.hex])].filter((l) => !THEME.KEEP_LITERALS.includes(l));
  assert.deepStrictEqual(extraHex, [], 'add these to THEME_TOKENS or KEEP_LITERALS in lib/theme/tokens.js');
  const extraRgba = [...edit.rgba].filter((l) => !THEME.KEEP_RGBA.includes(l));
  assert.deepStrictEqual(extraRgba, [], 'editor rgba must be a var() role or listed in KEEP_RGBA');
  assert.ok(reader.hex.has('#000'), 'guard: the scan sees the TOC mask literal');
  assert.ok(edit.hex.size > 0 || edit.rgba.size > 0, 'guard: the edit scan saw editor CSS');
});
```

`test/theme.test.js` 的 `applyThemeTokens leaves editor and lightbox rules literal` 改成（編輯器規則從此會被改寫，燈箱仍保持常值）：

```js
check('applyThemeTokens rewrites editor rules and leaves lightbox rules literal', () => {
  const ed = T.applyThemeTokens('  .ed-wave-panel { background: #fff; color: #111; }');
  assert.strictEqual(ed, '  .ed-wave-panel { background: var(--md-bg); color: var(--md-wave-ink); }');
  const lb = '  .lightbox-canvas > * {\n    background: #ffffff;\n  }';
  assert.strictEqual(T.applyThemeTokens(lb), lb);
});
```

並把 `test/editor-click.test.js` 加：

```js
check('wave: the waveform editor panel follows dark', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(300);
  const d = page.locator('.wavedrom-diagram').first();
  await d.scrollIntoViewIfNeeded(); await wait(300);
  const box = await d.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await wait(300);
  await page.locator('.ed-wave-edit-btn').click(); await wait(800);
  const s = await page.evaluate(() => {
    const p = document.querySelector('.ed-wave-panel');
    const label = document.querySelector('.ed-wave-lane-label, .ed-wave-section-title');
    return { bg: getComputedStyle(p).backgroundColor, fg: getComputedStyle(label).color };
  });
  assert.notStrictEqual(s.bg, 'rgb(255, 255, 255)', 'panel is not white in dark');
  assert.ok(contrast(s.fg, s.bg) >= 4.5, 'wave label contrast ' + JSON.stringify(s));
}, { md: FIXTURE + '\n\x60\x60\x60wavedrom\n{ "signal": [ { "name": "clk", "wave": "p...." } ] }\n\x60\x60\x60\n' });
```

- [ ] **Step 2: 跑確認紅**

Run: `node test/reader-design.test.js; MD2DOC_ENGINES=chromium node test/editor-click.test.js "wave:"`
Expected: theme.test 的新改寫檢查 FAIL（`.ed-` 仍被跳過）；reader-design 因 `THEME.KEEP_RGBA` 為 undefined 丟例外；wave 檢查 FAIL 於 `panel is not white in dark`。

- [ ] **Step 3: 實作**

`lib/theme/tokens.js`：

1. `THEME_TOKENS` 加波形角色（非 direct；左值是 `editModeLayoutCss` 現有常值，深色值如下，全部只出現在 `.ed-wave-*` 規則、閱讀頁用量為 0——Step 4 的指令會驗證）：

```js
  // v3.10.0 waveform editor (editModeLayoutCss .ed-wave-*). Literal roles: the
  // wave CSS keeps its literals and applyThemeTokens rewrites them. Every one
  // of these literals is used by no reader rule (measured 2026-10-04).
  { name: 'wave-accent', light: ['#1a73e8'], dark: '#6ea8f5' },
  { name: 'wave-rule', light: ['#e2e2e2'], dark: '#38393c' },
  { name: 'wave-ink', light: ['#111'], dark: '#e3e3e3' },
  { name: 'wave-mut', light: ['#555'], dark: '#a3a6ab' },
  { name: 'wave-edge', light: ['#0041c4'], dark: '#79b0f6' },
  { name: 'wave-strong', light: ['#222'], dark: '#f5f6f7' },
  { name: 'wave-grid', light: ['#ececec'], dark: '#303134' },
  { name: 'wave-faint', light: ['#aaa'], dark: '#7d8086' },
  { name: 'wave-text', light: ['#333'], dark: '#e3e3e3' },
  { name: 'wave-border', light: ['#bbb'], dark: '#505257' },
  { name: 'wave-border-2', light: ['#888'], dark: '#7d8086' },
  { name: 'wave-field', light: ['#f6f6f6'], dark: '#232325' },
  { name: 'wave-warn-ink', light: ['#7a4b00'], dark: '#e3b341' },
  { name: 'wave-panel', light: ['#fafafa'], dark: '#232325' },
  { name: 'wave-control', light: ['#c4c4c4'], dark: '#46484c' },
  { name: 'wave-mut-2', light: ['#666'], dark: '#a3a6ab' },
  { name: 'wave-warn-bg', light: ['#fff6e0'], dark: '#3a3020' },
  { name: 'wave-warn-line', light: ['#e8c987'], dark: '#6e5e14' },
  { name: 'wave-err-ink', light: ['#7a1f00'], dark: '#ffb4a0' },
  { name: 'wave-err-bg', light: ['#ffe9e0'], dark: '#3a2420' },
  { name: 'wave-err-line', light: ['#e8a987'], dark: '#7a3b2a' },
  { name: 'wave-sel-bg', light: ['#eaf2fe'], dark: '#24364f' },
  { name: 'wave-group-line', light: ['#d8d8d8'], dark: '#46484c' },
  { name: 'wave-group-bg', light: ['#f2f2f2'], dark: '#2a2a2d' },
  { name: 'wave-x', light: ['#d9d9d9'], dark: '#505257' },
  { name: 'wave-bus', light: ['#f5e9c8'], dark: '#4a4128' },
  { name: 'wave-bus-3', light: ['#d8ead3'], dark: '#2f4a2b' },
  { name: 'wave-bus-4', light: ['#d6e4f7'], dark: '#26384f' },
  { name: 'wave-bus-5', light: ['#f7d6e4'], dark: '#4a2c3a' },
  { name: 'wave-cursor', light: ['#d93025'], dark: '#ff8a8a' },
  { name: 'wave-status', light: ['#444'], dark: '#a3a6ab' },
```

2. `SKIP_SELECTOR` 改成只跳過燈箱，並改註解：

```js
// Rules whose literals stay literal: the lightbox, which is a dark overlay
// already. v3.10.0: the editor's own UI is themed (it used to be skipped).
const SKIP_SELECTOR = /(^|[\s,>+~(])\.lightbox/;
```

3. 加 `KEEP_RGBA` 並匯出（這些是刻意不跟主題的：遮罩與陰影是半透明黑，在深淺兩種底上都成立；波形選取色是半透明藍）：

```js
// rgba() literals the editor CSS keeps on purpose (normalised, no spaces).
// Scrims and shadows are translucent black and work on both grounds; the
// wave selection is a translucent blue. Anything else in an .ed- rule must be
// a var() role — test/reader-design.test.js enforces it.
const KEEP_RGBA = ['rgba(0,0,0,.35)', 'rgba(0,0,0,.45)', 'rgba(26,115,232,.18)'];
```

`module.exports` 加 `KEEP_RGBA`。

4. `applyThemeTokens` 的 hex 改寫目前不處理 `#ffffffee` 這種 8 位色碼；Task 2 已把唯一一處（`.ed-wave-edit-btn`）改成 var，不需動改寫函式。

- [ ] **Step 4: 驗證波形常值沒有被閱讀頁使用**

```bash
node -e "
const s=require('fs').readFileSync('lib/md2doc.js','utf8');const T=require('./lib/theme/tokens.js');
const a=s.indexOf('<style>',s.indexOf('// ── HTML template'));const b=s.lastIndexOf('</style>',s.indexOf('</head>',a));
let sel='';const bad=[];
s.slice(a,b).split('\n').forEach(l=>{const br=l.indexOf('{');if(br!==-1)sel=l.slice(0,br);if(/\.ed-/.test(sel)||/^\s*(\/\*|\*)/.test(l))return;
 T.THEME_TOKENS.filter(t=>t.name.startsWith('wave-')).forEach(t=>t.light.forEach(x=>{ if(new RegExp(x+'\\\\b','i').test(l)) bad.push(t.name+': '+l.trim()); }));});
console.log(bad.length?bad.join('\n'):'none');"
```

Expected: `none`。

- [ ] **Step 5: 跑確認綠**

Run: `node test/reader-design.test.js && node test/theme.test.js && node test/editor-click.test.js "wave:"`
Expected: PASS。若 allow-list 列出殘留常值，依該常值所在規則：屬編輯器外框 → 回 Task 2 的表改成 var；屬波形 → 加進上面的 `wave-*` 表並給深色值；是遮罩／陰影 → 加進 `KEEP_RGBA` 並在註解寫原因。不得把整條規則改回跳過。

- [ ] **Step 6: 全套與反引號**

Run: `352 4` 計數；`rtk proxy npm test > /tmp/b1-t3.log 2>&1; echo $?`
Expected: exit 0。

- [ ] **Step 7: Commit**

```bash
git add lib/theme/tokens.js test/reader-design.test.js test/editor-click.test.js
git commit -m "feat(editor): theme the waveform editor and extend the colour allow-list to editor CSS"
```

---

### Task 4: Lucide 圖示（工具列、選字工具列、⠿ ＋）

**Files:**
- Create: `lib/editor/icons.js`
- Modify: `lib/editor/server.js`（注入清單，錨點 `` `<script>${TOOLBAR_MODEL_SRC}</script>\n` ``）
- Modify: `lib/editor/toolbar-model.js`（`BUTTON_DEFS` 的 `icon`）
- Modify: `lib/editor/client.js`（`buildToolbar`、`buildSelToolbar`、`buildGutterHandle`、`buildGutterInsertButton`）
- Modify: `lib/md2doc.js`（`.ed-toolbar-btn svg`、`.ed-seltb` 尺寸、分隔線）
- Test: `test/toolbar-model.test.js`、`test/editor-click.test.js`

**Interfaces:**
- Produces: `window.md2docIcons.svg(name, size) -> string`（`<svg class="ed-ico" …>`，`aria-hidden="true"`，`stroke="currentColor"`，`stroke-width="1.75"`）；`md2docIcons.NAMES`（陣列）。Node 端 `require('./lib/editor/icons.js')` 得到同一物件。
- Produces: `toolbar-model` 每個按鈕 `icon` 是 `md2docIcons.NAMES` 裡的名稱。

- [ ] **Step 1: 寫失敗測試**

`test/toolbar-model.test.js` 檔尾加：

```js
{
  const icons = require('../lib/editor/icons.js');
  for (const b of tm.BUTTONS) {
    ok(icons.NAMES.includes(b.icon), 'toolbar icon is a known Lucide name: ' + b.id + ' -> ' + b.icon);
  }
  const s = icons.svg('bold', 16);
  ok(/^<svg class="ed-ico"/.test(s) && s.includes('aria-hidden="true"') && s.includes('width="16"'), 'svg() shape');
  ok(!/<\/script/i.test(require('fs').readFileSync(require.resolve('../lib/editor/icons.js'), 'utf8')), 'icons.js is inlined into a script tag');
}
```

`test/editor-click.test.js` 加：

```js
check('icons: every toolbar button draws an svg and no emoji', DESKTOP, async (page) => {
  const r = await page.evaluate(() => [].map.call(document.querySelectorAll('.ed-toolbar-btn'), (b) => ({
    id: b.getAttribute('data-ed-tb'), svg: !!b.querySelector('svg'), text: b.textContent.trim(),
    vis: (() => { const q = b.getBoundingClientRect(); return q.right <= innerWidth && q.width > 0; })(),
  })));
  assert.ok(r.length >= 22, 'guard: toolbar present ' + r.length);
  assert.deepStrictEqual(r.filter((x) => !x.svg || x.text), [], 'buttons without svg or with glyph text');
  assert.deepStrictEqual(r.filter((x) => !x.vis).map((x) => x.id), [], 'buttons off screen at 1440');
});
check('icons: selection toolbar has six icon buttons and a divider before link', DESKTOP, async (page) => {
  await page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first().dblclick(); await wait(400);
  const r = await page.evaluate(() => {
    const t = document.querySelector('.ed-seltb');
    const kids = [].map.call(t.children, (c) => c.classList.contains('ed-seltb-sep') ? '|' : (c.querySelector('svg') ? 'svg' : 'text'));
    return kids.join(',');
  });
  assert.strictEqual(r, 'svg,svg,svg,svg,svg,|,svg');
});
check('icons: gutter handle and plus are svg', DESKTOP, async (page) => {
  const p = page.locator('.ed-block[data-block-type="paragraph"]').first();
  await p.hover(); await wait(200);
  const r = await p.evaluate((e) => ({ h: !!e.querySelector('.ed-handle svg'), i: !!e.querySelector('.ed-insert svg') }));
  assert.deepStrictEqual(r, { h: true, i: true });
});
```

- [ ] **Step 2: 跑確認紅**

Run: `node test/toolbar-model.test.js; MD2DOC_ENGINES=chromium node test/editor-click.test.js "icons:"`
Expected: toolbar-model 失敗於 `Cannot find module '../lib/editor/icons.js'`；三個點擊檢查 FAIL。

- [ ] **Step 3: 建立 `lib/editor/icons.js`**

從 lucide-static 0.469.0 取 SVG 內文（`<svg>` 標籤內的子元素），只收下列名稱：`save undo-2 redo-2 heading quote square-code list list-ordered list-checks bold italic strikethrough underline code link indent-decrease indent-increase table arrow-up-to-line arrow-down-to-line minus image panel-left grip-vertical plus check circle-alert info x`。產生指令（在 worktree 根目錄跑；寫出的檔要提交）：

```bash
mkdir -p /tmp/lucide && cd /tmp/lucide
for n in save undo-2 redo-2 heading quote square-code list list-ordered list-checks bold italic strikethrough underline code link indent-decrease indent-increase table arrow-up-to-line arrow-down-to-line minus image panel-left grip-vertical plus check circle-alert info x; do
  curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo "MISSING $n"
done
cd /home/user/hp_workspace/md2doc-editor-b1
node -e "
const fs=require('fs');const names=fs.readdirSync('/tmp/lucide').filter(f=>f.endsWith('.svg')).map(f=>f.slice(0,-4)).sort();
const body={};for(const n of names){const s=fs.readFileSync('/tmp/lucide/'+n+'.svg','utf8');body[n]=s.slice(s.indexOf('>',s.indexOf('<svg'))+1,s.lastIndexOf('</svg>')).replace(/\s+/g,' ').trim();}
const out=\"'use strict';\n/* Lucide icons v0.469.0 (ISC License, https://lucide.dev/license), only the ones\n   the editor draws. UMD like toolbar-model.js: require()-able in node for the\n   tests, injected into the edit page as window.md2docIcons (lib/editor/server.js). */\n(function (root, factory) {\n  if (typeof module === 'object' && module.exports) module.exports = factory();\n  else root.md2docIcons = factory();\n})(typeof self !== 'undefined' ? self : this, function () {\nconst BODY = \"+JSON.stringify(body,null,2)+\";\nconst NAMES = Object.freeze(Object.keys(BODY));\nfunction svg(name, size) {\n  const s = size || 16;\n  return '<svg class=\\\"ed-ico\\\" xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 24 24\\\" width=\\\"' + s + '\\\" height=\\\"' + s + '\\\" ' +\n    'fill=\\\"none\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"1.75\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\" ' +\n    'aria-hidden=\\\"true\\\" focusable=\\\"false\\\">' + BODY[name] + '</svg>';\n}\nreturn { NAMES, svg };\n});\n\";
fs.writeFileSync('lib/editor/icons.js',out);console.log(names.length+' icons');"
node -e "const i=require('./lib/editor/icons.js');console.log(i.NAMES.length, i.svg('bold',16).slice(0,60))"
```

Expected: `29 icons`，第二行印出 `29 <svg class="ed-ico" …`。沒有任何 `MISSING`。

- [ ] **Step 4: 注入與使用**

`lib/editor/server.js`：在 `const DOCSOURCE_SRC = …` 附近加 `const ICONS_SRC = fs.readFileSync(path.join(__dirname, 'icons.js'), 'utf8');`，並在注入清單 `` `<script>${TOOLBAR_MODEL_SRC}</script>\n` `` 之前加一行 `` `<script>${ICONS_SRC}</script>\n` + ``。

`lib/editor/toolbar-model.js`：`BUTTON_DEFS` 的 `icon` 換成名稱（`label`、`title` 不動）：

| id | icon |
|---|---|
| save | `save` |
| undo / redo | `undo-2` / `redo-2` |
| headings | `heading` |
| quote | `quote` |
| code | `square-code` |
| list / ordered-list / check | `list` / `list-ordered` / `list-checks` |
| bold / italic / strike / inline-code / link | `bold` / `italic` / `strikethrough` / `code` / `link` |
| outdent / indent | `indent-decrease` / `indent-increase` |
| table / insert-before / insert-after / line / image | `table` / `arrow-up-to-line` / `arrow-down-to-line` / `minus` / `image` |
| outline | `panel-left` |
| preview | `square-code`（暫時；Task 6 會整顆移除） |

`lib/editor/client.js`：

- 檔頭取得模組處（`const docSourceLib = window.md2docDocSource;` 附近）加 `const icons = window.md2docIcons;`
- `buildToolbar` 把 `btn.textContent = def.icon;` 改成 `btn.innerHTML = icons.svg(def.icon, 18);`
- `updateToolbar` 內刪除 `if (typeof st.label === 'string') btn.textContent = st.label;` 這一行及其上方「derived label; every other button keeps the glyph it was built with.」註解（圖示固定，不再由狀態改寫；`title` 的更新保留）。
- `buildGutterHandle`：`el.textContent = '⠿';` → `el.innerHTML = icons.svg('grip-vertical', 16);`
- `buildGutterInsertButton`：`el.textContent = '＋';` → `el.innerHTML = icons.svg('plus', 16);`
- `buildSelToolbar`：`addBtn` 內 `b.textContent = label;` → `b.innerHTML = icons.svg(SELTB_ICON[cls], 16);`，並在 `buildSelToolbar` 上方加

```js
  const SELTB_ICON = {
    'ed-seltb-b': 'bold', 'ed-seltb-i': 'italic', 'ed-seltb-s': 'strikethrough',
    'ed-seltb-u': 'underline', 'ed-seltb-code': 'code', 'ed-seltb-link': 'link',
  };
```

  （六顆的 class 已確認為 `ed-seltb-b/-i/-s/-u/-code/-link`。）在 `addBtn('ed-seltb-link', …)` 那行之前插入分隔線：

```js
    const sep = document.createElement('span');
    sep.className = 'ed-seltb-sep';
    sep.setAttribute('aria-hidden', 'true');
    el.appendChild(sep);
```

- 既有 `.ed-seltb-b { font-weight: bold; }` 等 4 條與 `.ed-toolbar-b/-i/-s` 3 條的字型樣式對圖示無意義，刪掉（`lib/md2doc.js`）。

`lib/md2doc.js` 加（放在 `.ed-seltb-btn[aria-disabled="true"]` 之後）：

```css
  .ed-seltb { padding: 3px; gap: 2px; }
  .ed-seltb-btn { width: 30px; height: 30px; min-width: 0; padding: 0; display: inline-grid; place-items: center; color: var(--md-muted); }
  .ed-seltb-btn:hover:not([aria-disabled="true"]) { color: var(--md-strong); }
  .ed-seltb-sep { width: 1px; height: 18px; margin: 0 3px; background: var(--md-rule); align-self: center; }
  .ed-ico { display: block; flex: none; }
```

並在 `.ed-toolbar-btn:hover:not(:disabled)` 之後加 `.ed-toolbar-btn .ed-ico { width: 18px; height: 18px; }`。

- [ ] **Step 5: 跑確認綠**

Run: `node test/toolbar-model.test.js && node test/editor-client.test.js && node test/editor-click.test.js "icons:"`
Expected: PASS（editor-client 的禁用子字串與必要子字串都過）。

- [ ] **Step 6: 長套件**

Run（依序）：`node test/editor-client-runtime.test.js > /tmp/b1-t4-rt.log 2>&1; echo $?`、`node test/editor-journey.test.js > /tmp/b1-t4-j.log 2>&1; echo $?`
Expected: exit 0。若有測試以按鈕文字（`'💾'`、`'↶'`、`'B'`、`'⠿'`、`'＋'` 等）找元素或斷言，改用 `data-ed-tb` 屬性、class 或 `aria-label` 找；列在 commit 訊息。

- [ ] **Step 7: Commit**

```bash
git add lib/editor/icons.js lib/editor/server.js lib/editor/toolbar-model.js lib/editor/client.js lib/md2doc.js test/toolbar-model.test.js test/editor-click.test.js test/editor-client-runtime.test.js test/editor-journey.test.js
git commit -m "feat(editor): Lucide line icons for toolbar, selection toolbar and gutter"
```

---

### Task 5: ⠿ ＋ 24px 並置中在第一行文字

**Files:**
- Modify: `lib/md2doc.js`（`editModeLayoutCss` 的 `--ed-gutter-btn`、`--ed-gutter-gap`、`.ed-handle`／`.ed-insert` 的 `top`）
- Modify: `lib/md2doc.js`（閱讀頁 `<style>` 的 `.ed-handle`／`.ed-insert` 高度）
- Modify: `lib/editor/client.js`（`armEditables` 末尾）
- Test: `test/editor-click.test.js`

**Interfaces:**
- Produces: `alignGutterTops(blockEls)`：對每個區塊設定 `--ed-gutter-top`（px 字串）。`armEditables` 結束時呼叫；之後任何重新掛上 ＋ ⠿ 的路徑也都經過 `armEditables`。

- [ ] **Step 1: 寫失敗的點擊檢查**

```js
check('gutter: handle and plus are 24px and centred on the first text line', DESKTOP, async (page) => {
  const kinds = ['h2', 'paragraph', 'li'];
  for (const k of kinds) {
    const sel = k === 'h2' ? '.ed-block[data-block-type="heading"]' : '.ed-block[data-block-type="' + k + '"]';
    const blk = page.locator(sel).first();
    await blk.scrollIntoViewIfNeeded(); await blk.hover(); await wait(200);
    const r = await blk.evaluate((b) => {
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
        n.data.trim() && !n.parentElement.closest('.ed-handle, .ed-insert, .ed-li-marker') ? 1 : 3 });
      const t = walker.nextNode(); const rg = document.createRange(); rg.selectNodeContents(t);
      const line = rg.getClientRects()[0];
      const h = b.querySelector('.ed-handle').getBoundingClientRect();
      const i = b.querySelector('.ed-insert').getBoundingClientRect();
      const hit = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
      return { lineMid: line.top + line.height / 2, hMid: h.top + h.height / 2, iMid: i.top + i.height / 2,
        hw: h.width, hh: h.height, hit: !!(hit && hit.closest('.ed-handle')) };
    });
    assert.strictEqual(r.hw, 24, k + ' handle width'); assert.strictEqual(r.hh, 24, k + ' handle height');
    assert.ok(Math.abs(r.hMid - r.lineMid) <= 2, k + ' handle off the first line ' + JSON.stringify(r));
    assert.ok(Math.abs(r.iMid - r.lineMid) <= 2, k + ' plus off the first line ' + JSON.stringify(r));
    assert.ok(r.hit, k + ' handle centre hits the handle');
  }
});
```

- [ ] **Step 2: 跑確認紅**

Run: `MD2DOC_ENGINES=chromium node test/editor-click.test.js "gutter:"`
Expected: FAIL 於 `h2 handle width`（目前 18）。

- [ ] **Step 3: 實作**

`lib/md2doc.js`（`editModeLayoutCss`）：

```css
    --ed-gutter-btn: 24px;
    --ed-gutter-gap: 0px;
```

（取代原本的 `18px` 與 `4px` 兩行；`--ed-gutter-w` 公式不動。）`.ed-handle` 與 `.ed-insert`（在 `:root { --ed-gutter-shift: 10px; }` 之後那兩條）的 `top: 0;` 改成 `top: var(--ed-gutter-top, 0px);`。`.ed-block::before` 那條（hover 橋）保持 `top: 0`。

閱讀頁 `<style>` 的 `.ed-handle`、`.ed-insert` 兩條：`width: 18px; height: 20px;` → `width: 24px; height: 24px;`；`font-size: 13px; line-height: 1;` 保留。並刪除 `.ed-insert` 的 `top: -22px;`（`editModeLayoutCss` 已覆寫，留著只會誤導）。

`lib/editor/client.js`：在 `armEditables` 的 `blockEls.forEach(...)` 之後、函式結尾前加 `alignGutterTops(blockEls);`，並在 `armEditables` 之後新增：

```js
  // The ⠿ / ＋ pair sits on the block's first line of text, whatever the
  // block's own margin and line-height (a heading line is 49.5px tall, a
  // paragraph's 24.75px). Measured from the first real text node's first
  // line box, so tables, list items and code all land on their first row; a
  // block with no text (an image, a bare diagram) keeps top 0.
  function alignGutterTops(blockEls) {
    if (!blockEls.length || !blockEls[0].isConnected) {
      if (blockEls.length) requestAnimationFrame(() => alignGutterTops(blockEls.filter((b) => b.isConnected)));
      return;
    }
    for (const b of blockEls) {
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.data.trim() && !n.parentElement.closest('.ed-handle, .ed-insert, .ed-li-marker, svg'))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      });
      const t = walker.nextNode();
      let top = 0;
      if (t) {
        const rg = document.createRange();
        rg.selectNodeContents(t);
        const line = rg.getClientRects()[0];
        const handle = b.querySelector('.ed-handle');
        if (line && handle) top = Math.round(line.top + line.height / 2 - b.getBoundingClientRect().top - handle.offsetHeight / 2);
      }
      b.style.setProperty('--ed-gutter-top', top + 'px');
    }
  }
```

- [ ] **Step 4: 跑確認綠**

Run: `node test/editor-click.test.js "gutter:"`
Expected: 2 checks passed。

- [ ] **Step 5: 長套件**

Run（依序）：editor-client-runtime、editor-journey，各導到 log。
Expected: exit 0。既有測試若有量 ＋ ⠿ 位置的 `MEASURED` 數值（例如 `[350, 368]`、`contentLeft-22`）而紅：**重新量**（CLAUDE.md「Re-measure, don't recompute」），把新量到的值與量測方式寫進測試與註解；`lib/md2doc.js` 裡描述舊座標的註解（`⠿ [contentLeft-22, contentLeft-4]` 等）同步改成新量測值，並註明「v3.10.0 re-measured」。

- [ ] **Step 6: Commit**

```bash
git add lib/md2doc.js lib/editor/client.js test/editor-click.test.js test/editor-client-runtime.test.js test/editor-journey.test.js
git commit -m "feat(editor): 24px gutter pair centred on each block's first line"
```

---

### Task 6: 移除整份原始碼模式

**Files:**
- Delete: `lib/editor/docsource.js`、`test/docsource.test.js`
- Modify: `lib/editor/server.js`（`DOCSOURCE_SRC` 與注入行）
- Modify: `lib/editor/toolbar-model.js`（`preview` 按鈕、`mode`、`source` 覆寫、檔頭的 `23-button roster` 註解）
- Modify: `lib/editor/client.js`（`docMode`、`enterSourceMode`、`leaveSourceMode`、`setDocMode`、`cycleDocMode`、`paintModeStatus` 的模式文字、`data-ed-mode`、`case 'preview'`、`docSourceLib`、`NO_SOURCE_LINE…` 系列訊息文字）
- Modify: `lib/md2doc.js`（`.ed-source` 規則、`body[data-ed-mode="source"]` 兩條、相關註解）
- Modify: `package.json`（`test` 移除 `node test/docsource.test.js &&`）
- Modify: `test/toolbar-model.test.js`、`test/editor-journey.test.js`、`test/editor-client-runtime.test.js`、`test/detach-census.test.js`

**Interfaces:**
- Produces: 工具列 22 顆；`deriveState(ctx)` 不再讀 `ctx.mode`；`.ed-toolbar-status` 交給 Task 7。

- [ ] **Step 1: 盤點原始碼模式的測試，決定每一處怎麼遷移**

```bash
for f in test/editor-journey.test.js test/editor-client-runtime.test.js test/toolbar-model.test.js test/detach-census.test.js; do
  echo "== $f"; grep -n "preview\|data-ed-mode\|ed-source\|docMode\|source mode\|原始碼模式\|enterSourceMode\|cycleDocMode\|'source'" "$f" | cut -c1-140
done > /tmp/b1-t6-sites.txt; wc -l /tmp/b1-t6-sites.txt
```

讀 `/tmp/b1-t6-sites.txt`，把每個**情境**（不是每一行）分到三類並寫進 `/tmp/b1-t6-plan.txt`：
- **A 測原始碼模式本身**（進出、round-trip、按鈕 label 切換、source 模式下其他按鈕 disabled）→ 刪除。
- **B 借道原始碼模式去改文件**（例如進 source 改一行再回來，目的是測別的功能）→ 改成用 ⠿ → MD 原始碼改同一個區塊、或直接改測試 fixture，保留被測的功能斷言。
- **C 只是數按鈕或列出按鈕 id**（`TB_ROWS`、`23`）→ 改成 22、移除 `preview` 條目。

不得在沒有分類的情況下刪任何一處；B 類一處都不能刪。

- [ ] **Step 2: 寫失敗測試**

`test/toolbar-model.test.js`：把 `eq(tm.BUTTONS.length, 23, …)` 改成 `eq(tm.BUTTONS.length, 22, '22 顆（v3.10.0 移除原始碼模式）')`，第 64 行附近的 `view: ['outline', 'preview']` 改成 `view: ['outline']`，`'export is not part of the 23'` 改成 `22`，並加：

```js
ok(!tm.BUTTONS.some((b) => b.id === 'preview'), 'the source-mode button is gone');
{
  const st = tm.deriveState(baseCtx({}));
  ok(!('preview' in st), 'deriveState has no preview entry');
}
```

`test/editor-click.test.js` 加：

```js
check('source mode: gone from the page', DESKTOP, async (page) => {
  const r = await page.evaluate(() => ({
    btn: !!document.querySelector('[data-ed-tb="preview"]'),
    attr: document.body.hasAttribute('data-ed-mode'),
    ta: !!document.querySelector('textarea.ed-source'),
    count: document.querySelectorAll('.ed-toolbar-btn').length,
  }));
  assert.deepStrictEqual(r, { btn: false, attr: false, ta: false, count: 22 });
});
```

並依 Step 1 的 A 類清單刪除、B 類改寫、C 類改數字。

- [ ] **Step 3: 跑確認紅**

Run: `node test/toolbar-model.test.js; MD2DOC_ENGINES=chromium node test/editor-click.test.js "source mode:"`
Expected: toolbar-model 失敗於 `22 顆`（實際 23）；點擊檢查 FAIL。

- [ ] **Step 4: 刪除實作**

1. `git rm lib/editor/docsource.js test/docsource.test.js`；`package.json` 的 `test` 移除 `node test/docsource.test.js && `。
2. `lib/editor/server.js`：刪 `const DOCSOURCE_SRC = …` 與 `` `<script>${DOCSOURCE_SRC}</script>\n` + `` 兩行。
3. `lib/editor/toolbar-model.js`：刪 `preview` 那條 `BUTTON_DEFS` 及其上方註解；`deriveState` 內刪 `const mode = c.mode;`、`state.preview.label/title` 兩行、`if (mode === 'source') { … }` 整段及其註解；檔頭 `// The 23-button roster` 改成 `// The 22-button roster`，並在同段補一句「v3.10.0 removed the edit/source mode button with source mode itself.」。
4. `lib/editor/client.js`：
   - 刪 `const docSourceLib = window.md2docDocSource;`。
   - 刪 `let docMode = 'edit';`，以及 `toolbarContext` 內 `mode: docMode,`。
   - 刪 `enterSourceMode`、`leaveSourceMode`、`cycleDocMode`、`setDocMode` 四個函式（`grep -a -n "function enterSourceMode\|function leaveSourceMode\|async function cycleDocMode\|async function setDocMode" lib/editor/client.js` 定位；每個從函式前的註解區塊開頭刪到結尾大括號）。
   - `runToolbarAction` 刪 `case 'preview': return cycleDocMode();`。
   - 兩處 `document.body.setAttribute('data-ed-mode', docMode);` 刪除。
   - 兩處 `if (docMode !== 'edit') return;`（約 16306、16316，圖片拖放／貼上監聽器）刪除該行——原始碼模式不存在後，這兩個閘門永遠為真；同時刪除其上方「⚠ BOTH listeners are gated on `docMode === 'edit'`」那段註解。
   - `paintModeStatus` 暫時改成只清空：`function paintModeStatus() { /* Task 7 paints save state here */ }`——Task 7 會換掉；不要留「原始碼／編輯」字串。
   - `NO_SOURCE_LINE_MESSAGE`、`NO_SOURCE_LINE_INSERT_MESSAGE`、`UNLOCATABLE_LINE_MESSAGE`、`UNLOCATABLE_LINE_INSERT_MESSAGE` 四個常數的文字改成：
     ```js
     const NO_SOURCE_LINE_MESSAGE = '此項目沒有自己的來源行，無法在這裡刪除或編輯。請用文字編輯器修改，存檔後這裡會自動更新。';
     const NO_SOURCE_LINE_INSERT_MESSAGE = '此項目沒有自己的來源行，無法在其後插入。請用文字編輯器修改，存檔後這裡會自動更新。';
     const UNLOCATABLE_LINE_MESSAGE = '這段巢狀清單對不到自己的來源行，無法在這裡刪除或編輯。請用文字編輯器修改，存檔後這裡會自動更新。';
     const UNLOCATABLE_LINE_INSERT_MESSAGE = '這段巢狀清單對不到自己的來源行，無法在其後插入。請用文字編輯器修改，存檔後這裡會自動更新。';
     ```
     （「存檔後這裡會自動更新」由 Task 9 兌現；兩個任務同一批發布。）若測試以舊字串比對，更新期望。
5. `lib/md2doc.js`：刪 `.ed-source { … }` 整條與其上方註解；刪 `body[data-ed-mode="source"] .toc,` 與 `body[data-ed-mode="source"] .search-results { display: none !important; }` 兩行與其上方註解段落。

完成後確認殘留：

```bash
node -e "const s=require('fs').readFileSync('lib/editor/client.js','utf8');for(const n of ['docMode','enterSourceMode','leaveSourceMode','cycleDocMode','setDocMode','docSourceLib','data-ed-mode','ed-source','md2docDocSource'])console.log(n,s.indexOf(n));"
grep -n "ed-source\|data-ed-mode\|docsource" lib/md2doc.js lib/editor/server.js package.json
```

Expected: 全部 `-1`；grep 無輸出。

- [ ] **Step 5: 跑確認綠**

Run: `node test/toolbar-model.test.js && node test/editor-client.test.js && node test/editor-click.test.js "source mode:"`
Expected: PASS。

- [ ] **Step 6: 長套件**

Run（依序）：`node test/detach-census.test.js`、editor-client-runtime、editor-journey，各導到 log。
Expected: exit 0；並確認 Step 1 的 B 類情境名稱都出現在輸出的 `OK` 行（「The test exists is not the test ran」）：

```bash
grep -c "OK\|ok " /tmp/b1-t6-j.log
```

把 B 類情境名稱逐一 `grep` 在 log 裡，全部找得到才算過。

- [ ] **Step 7: Commit**

```bash
git add -A lib/editor lib/md2doc.js package.json test
git commit -m "feat(editor)!: remove the whole-document source mode"
```

（`git add -A` 只限這兩個目錄與檔案；執行前 `git status` 確認沒有 `docs/superpowers/` 出現。）

---

### Task 7: 工具列存檔狀態

**Files:**
- Modify: `lib/editor/client.js`（`paintModeStatus` → `paintSaveStatus`、`setDirty`、`save`）
- Modify: `lib/md2doc.js`（`.ed-toolbar-status` 規則，加狀態樣式）
- Test: `test/editor-click.test.js`

**Interfaces:**
- Consumes: `documentIsDirty()`、`icons.svg`。
- Produces: `paintSaveStatus(state)`，`state ∈ 'clean' | 'dirty' | 'saving' | 'failed'`；`setDirty()` 結尾呼叫 `paintSaveStatus(documentIsDirty() ? 'dirty' : 'clean')`。`.ed-toolbar-status[data-state]` 反映目前狀態。

- [ ] **Step 1: 寫失敗的點擊檢查**

```js
check('save status: clean, dirty with save lit, then saved after Ctrl+S', DESKTOP, async (page, boot) => {
  const st = () => page.evaluate(() => {
    const s = document.querySelector('.ed-toolbar-status');
    const b = document.querySelector('[data-ed-tb="save"]');
    return { state: s.getAttribute('data-state'), text: s.textContent.trim(), pressed: b.getAttribute('aria-pressed'), role: s.getAttribute('role') };
  });
  let s = await st();
  assert.strictEqual(s.state, 'clean'); assert.ok(s.text.includes('已儲存'), s.text); assert.strictEqual(s.role, 'status');
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' more');
  await page.locator('.ed-block[data-block-type="heading"]').last().click(); await wait(600);
  s = await st();
  assert.strictEqual(s.state, 'dirty'); assert.ok(s.text.includes('有未儲存的變更'), s.text); assert.strictEqual(s.pressed, 'true');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s'); await wait(800);
  s = await st();
  assert.strictEqual(s.state, 'clean');
  assert.ok(fs.readFileSync(boot.mdPath, 'utf8').includes('(https://example.com). more'), 'file saved');
});
```

- [ ] **Step 2: 跑確認紅**

Run: `MD2DOC_ENGINES=chromium node test/editor-click.test.js "save status:"`
Expected: FAIL 於 `state` 為 `null`。

- [ ] **Step 3: 實作**

`lib/editor/client.js`：

1. 把 Task 6 留下的 `function paintModeStatus() { … }` 換成：

```js
  // The toolbar's right-hand status slot says whether the file on disk matches
  // the page. Save stays manual (Ctrl/Cmd+S or the save button); this only
  // makes the state visible. role="status" so a screen reader hears it.
  const SAVE_KEY_HINT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
  function paintSaveStatus(state) {
    const statusEl = document.querySelector('.ed-toolbar-status');
    if (!statusEl) return;
    statusEl.setAttribute('data-state', state);
    if (state === 'clean') statusEl.innerHTML = icons.svg('check', 15) + '<span>已儲存</span>';
    else if (state === 'dirty') statusEl.innerHTML = '<i class="ed-status-dot"></i><span>有未儲存的變更 · ' + SAVE_KEY_HINT + ' 儲存</span>';
    else if (state === 'saving') statusEl.innerHTML = '<span>儲存中…</span>';
    else statusEl.innerHTML = icons.svg('circle-alert', 15) + '<span>無法儲存</span>';
    const btn = toolbarBtns && toolbarBtns.save;
    if (btn) btn.setAttribute('aria-pressed', state === 'dirty' ? 'true' : 'false');
  }
```

（`toolbarBtns` 是既有的模組變數 `let toolbarBtns = null; // { [buttonId]: HTMLButtonElement }`。狀態欄在 `mountToolbar` 裡以區域變數 `statusEl` 建立，在那裡加 `statusEl.setAttribute('role', 'status');`。）把原本呼叫 `paintModeStatus()` 的地方（`mountToolbar` 之後）改成 `paintSaveStatus(documentIsDirty() ? 'dirty' : 'clean')`。

2. `setDirty()` 改成：

```js
  function setDirty() {
    document.title = (documentIsDirty() ? '● ' : '') + baseTitle;
    paintSaveStatus(documentIsDirty() ? 'dirty' : 'clean');
  }
```

3. `save()`：`const token = stack.saveToken();` 之後加 `paintSaveStatus('saving');`；三個失敗分支與 409 分支在 `showBanner`/`showConflictBanner` 之前加 `paintSaveStatus('failed');`。成功分支已呼叫 `setDirty()`，會畫回 `clean`。

4. `deriveState` 若把 `save` 標成 `toggle: false` 導致 `aria-pressed` 被 `updateToolbar` 每次覆寫回 `false`：在 `updateToolbar` 套用狀態之後再呼叫一次 `paintSaveStatus(statusEl.getAttribute('data-state') || 'clean')`，讓存檔鈕的 pressed 以狀態欄為準。

`lib/md2doc.js` 的 `.ed-toolbar-status` 改成：

```css
  .ed-toolbar-status { position: fixed; top: 0; right: 12px;
    height: var(--ed-toolbar-h); display: flex; align-items: center; gap: 6px;
    min-width: 7rem; justify-content: flex-end; font-size: 13px; color: var(--md-muted);
    pointer-events: none; }
  .ed-toolbar-status[data-state="clean"] .ed-ico { color: var(--md-ed-ok); }
  .ed-toolbar-status[data-state="failed"] { color: var(--md-ed-err); }
  .ed-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--md-ed-dirty); display: inline-block; }
  .ed-toolbar-btn[data-ed-tb="save"][aria-pressed="true"] { color: var(--md-accent); background: var(--md-active-bg); }
```

（取代原本 `opacity: .8; line-height: …; text-align: right; font-size: 12px` 那條。）`.ed-toolbar` 的 `padding-right: 124px` 改為 `padding-right: 260px`，讓最長的狀態文字不壓到按鈕；改後重跑 Task 4 的 `icons: every toolbar button … no emoji` 檢查，它會抓到被遮住（off screen）的按鈕。

- [ ] **Step 4: 跑確認綠**

Run: `node test/editor-click.test.js "save status:" && node test/editor-click.test.js "icons:"`
Expected: PASS。

- [ ] **Step 5: 長套件**

Run（依序）：editor-client-runtime、editor-journey。
Expected: exit 0。斷言狀態欄文字為「編輯」的測試改為斷言 `data-state`。

- [ ] **Step 6: Commit**

```bash
git add lib/editor/client.js lib/md2doc.js test/editor-click.test.js test/editor-client-runtime.test.js test/editor-journey.test.js
git commit -m "feat(editor): show save state in the toolbar"
```

---

### Task 8: 訊息分兩級（錯誤卡片／提示小框）與中文文案

**Files:**
- Modify: `lib/editor/client.js`（`showBanner` 及 47 個呼叫點、`showConflictBanner`）
- Modify: `lib/md2doc.js`（`.ed-conflict` 規則）
- Modify: `test/editor-journey.test.js`（英文文案斷言：約 9624、9631、9635、11625、11785、11826、11999 行）
- Test: `test/editor-client-runtime.test.js`、`test/editor-click.test.js`

**Interfaces:**
- Produces: `showError(message, actionLabel, onAction) -> HTMLElement`、`showNotice(message) -> HTMLElement`。兩者都產生 `.ed-conflict` 元素（保留 class：139 處測試以它找橫幅），以 `data-level="error" | "notice"` 區分。`showBanner` 保留為內部實作，簽名加第四參數 `level`，預設 `'error'`。
- 提示小框 4 秒後自動移除；滑鼠在上面時暫停計時；移除時走與按 ✕ 相同的清理（`activeBanner = null` 與三個旗標歸零）。

**呼叫點分級（以函式內上下文為準，行號是 2026-10-04 量測，實作時以 `grep -a -n` 重新定位）：**

| 級別 | 呼叫點（訊息） |
|---|---|
| error | `showConflictBanner`（磁碟衝突，動作「重新載入」）；`Render failed` 5 處（1550、1556、1563、1567、2571）；`SWALLOW_MESSAGE`（1778）；`Save failed` 3 處（14757、14766、14791）；`DROPPED_GESTURE_MESSAGE` 17 處；圖片讀取／上傳失敗 5 處（16086、16098、16103、16114、16118）；波形寫回失敗 3 處（18751、18869、18907） |
| notice | `含不支援的格式，改用原始碼編輯` 2 處（7109、7225）；`refuseStructuralListEdit` 的 `message`（9225）；`GRID_PASTE_TOO_BIG_MESSAGE`（10313）；`無法刪除最後一欄／標題列／最後一列`（11590、11618、11622）；`TOOLBAR_UNSUPPORTED_IMAGE_MESSAGE`（16079）；`TOOLBAR_NO_ANCHOR_MESSAGE` 3 處（16157、16222、16254）；`TOOLBAR_KEYNAV_EXIT_MESSAGE`（16792）；draw.io 通知 2 處（17749、17760） |

合計 47。分完以 node 數 `showBanner(` 剩餘出現次數應只剩函式定義本身與 `showError`／`showNotice` 內部兩處。

- [ ] **Step 1: 寫失敗測試**

`test/editor-click.test.js`：

```js
check('messages: a failed save is a sticky error card under the toolbar', DESKTOP, async (page) => {
  await page.route('**/api/save', (r) => r.fulfill({ status: 500, body: 'boom' }));
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' x');
  await page.locator('.ed-block[data-block-type="heading"]').last().click(); await wait(500);
  await page.keyboard.press('Control+s'); await wait(600);
  const err = await page.evaluate(() => {
    const e = document.querySelector('.ed-conflict[data-level="error"]');
    if (!e) return null;
    const r = e.getBoundingClientRect(); const tb = document.querySelector('.ed-toolbar').getBoundingClientRect();
    return { text: e.textContent, role: e.getAttribute('role'), belowBar: r.top >= tb.bottom, centred: Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 4 };
  });
  assert.ok(err, 'error card present');
  assert.ok(err.text.includes('無法儲存'), err.text);
  assert.strictEqual(err.role, 'alert'); assert.ok(err.belowBar && err.centred, JSON.stringify(err));
  await wait(4500);
  assert.ok(await page.$('.ed-conflict[data-level="error"]'), 'error card does not fade');
});
check('messages: a notice sits at the bottom and goes away by itself', DESKTOP, async (page) => {
  await page.evaluate(() => document.querySelector('.ed-block[data-block-type="table"]').scrollIntoView({ block: 'center' }));
  // two body rows: delete one (ok), then try to delete the last body row → "無法刪除最後一列"
  for (let i = 0; i < 2; i++) {
    const tr = await page.locator('.ed-block[data-block-type="table"] tbody tr').first().boundingBox();
    await page.mouse.move(tr.x + 20, tr.y + tr.height / 2); await wait(300);
    const g = await page.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(g.x, g.y); await wait(300);
    await page.locator('.ed-te-menu button', { hasText: '刪除列' }).click(); await wait(800);
  }
  const n = await page.evaluate(() => {
    const e = document.querySelector('.ed-conflict[data-level="notice"]');
    if (!e) return null; const r = e.getBoundingClientRect();
    return { text: e.textContent, role: e.getAttribute('role'), bottom: innerHeight - r.bottom };
  });
  assert.ok(n, 'notice present'); assert.ok(n.text.includes('無法刪除最後一列'), n.text);
  assert.strictEqual(n.role, 'status'); assert.ok(n.bottom >= 16 && n.bottom <= 48, 'near the bottom ' + JSON.stringify(n));
  await wait(4600);
  assert.strictEqual(await page.$('.ed-conflict[data-level="notice"]'), null, 'notice faded');
  await page.keyboard.press('Escape');
});
```

`test/editor-click.test.js` 再加一項，鎖 Review Focus 第 3 點（提示自己消失後，下一次 Esc 必須照常清掉區塊選取，不能被殘留旗標吃掉）：

```js
check('messages: after a notice fades, Esc still clears a block selection', DESKTOP, async (page) => {
  await page.evaluate(() => document.querySelector('.ed-block[data-block-type="table"]').scrollIntoView({ block: 'center' }));
  for (let i = 0; i < 2; i++) {
    const tr = await page.locator('.ed-block[data-block-type="table"] tbody tr').first().boundingBox();
    await page.mouse.move(tr.x + 20, tr.y + tr.height / 2); await wait(300);
    const g = await page.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(g.x, g.y); await wait(300);
    await page.locator('.ed-te-menu button', { hasText: '刪除列' }).click(); await wait(800);
  }
  assert.ok(await page.$('.ed-conflict[data-level="notice"]'), 'guard: the refusal notice appeared');
  await page.keyboard.press('Escape'); await wait(200);   // closes the table menu if still open
  await wait(4600);
  assert.strictEqual(await page.$('.ed-conflict'), null, 'notice gone');
  const paras = page.locator('.ed-block[data-block-type="paragraph"]');
  await paras.nth(0).click({ modifiers: ['Shift'] }); await paras.nth(1).click({ modifiers: ['Shift'] }); await wait(300);
  const before = await page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
  assert.ok(before >= 1, 'guard: a block selection exists ' + before);
  await page.keyboard.press('Escape'); await wait(300);
  const after = await page.evaluate(() => document.querySelectorAll('.ed-block.ed-selected').length);
  assert.strictEqual(after, 0, 'Esc cleared the selection after the notice faded');
});
```

- [ ] **Step 2: 跑確認紅**

Run: `MD2DOC_ENGINES=chromium node test/editor-click.test.js "messages:"`
Expected: 三項 FAIL（沒有 `data-level`）。

- [ ] **Step 3: 實作**

`lib/editor/client.js`：

1. `showBanner(message, actionLabel, onAction)` 簽名改為 `showBanner(message, actionLabel, onAction, level)`；在 `el.className = 'ed-conflict';` 之後加：

```js
    const lv = level === 'notice' ? 'notice' : 'error';
    el.setAttribute('data-level', lv);
    el.setAttribute('role', lv === 'error' ? 'alert' : 'status');
    const ico = document.createElement('span');
    ico.className = 'ed-msg-ico';
    ico.innerHTML = icons.svg(lv === 'error' ? 'circle-alert' : 'info', 18);
    el.appendChild(ico);
```

`msg` 加 `msg.className = 'ed-msg-text';`；✕ 鈕 `dismissBtn.textContent = '✕';` 改 `dismissBtn.innerHTML = icons.svg('x', 16);`、`aria-label` 改 `'關閉'`、加 `className = 'ed-msg-x'`；notice 不放 ✕（`if (lv === 'error') el.appendChild(dismissBtn);`）。把 ✕ 的清理邏輯抽成 `function dismissBannerEl(el) { … }`（就是現有 click handler 的內容），click 呼叫它。函式最後、`return el;` 之前加：

```js
    if (lv === 'notice') {
      let left = 4000; let t0 = Date.now(); let timer = setTimeout(() => dismissBannerEl(el), left);
      el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - t0; });
      el.addEventListener('mouseleave', () => { t0 = Date.now(); timer = setTimeout(() => dismissBannerEl(el), Math.max(left, 800)); });
    }
```

2. 新增兩個出口：

```js
  function showError(message, actionLabel, onAction) { return showBanner(message, actionLabel, onAction, 'error'); }
  function showNotice(message) { return showBanner(message, null, null, 'notice'); }
```

3. 依上表把 47 個呼叫點改成 `showError(…)` 或 `showNotice(…)`（`activeBannerIsRefusal = true` 等旗標設定行維持在呼叫之後不動）。
4. 文案（英文 → 中文）：

```js
  function showConflictBanner() {
    showError('這個檔案剛在別處被修改。重新載入會帶入新內容，並捨棄你在這裡還沒儲存的變更。', '重新載入', () => location.reload());
  }
```

`save()` 三處：`'無法儲存：連不到編輯伺服器（' + describeFailure(e) + '）。變更還在這個分頁裡，請稍後再按 ' + SAVE_KEY_HINT + '。'`、`'無法儲存：伺服器回傳的內容無法解析。變更還在這個分頁裡。'`、`'無法儲存：' + reason + '。變更還在這個分頁裡。'`。Render failed 五處：`'這次修改沒有套用：連不到編輯伺服器（' + describeFailure(e) + '）。文件維持修改前的樣子。'`、`'這次修改沒有套用：' + reason + '。文件維持修改前的樣子。'`、`'這次修改沒有套用：伺服器回傳的內容無法解析。文件維持修改前的樣子。'`（1563、1567 兩處相同）、`'這次修改沒有套用：發生未預期的錯誤（' + describeFailure(e) + '）。文件維持修改前的樣子。'`。

`lib/md2doc.js`：把 `.ed-conflict` 與 `.ed-conflict button` 兩條換成：

```css
  .ed-conflict {
    position: fixed; left: 50%; transform: translateX(-50%); z-index: 999;
    display: flex; align-items: center; gap: 10px;
    max-width: min(760px, calc(100vw - 32px)); box-sizing: border-box;
    padding: 10px 10px 10px 14px; border-radius: 8px; font-size: 14px; line-height: 1.5;
  }
  .ed-conflict[data-level="error"] {
    top: calc(var(--ed-toolbar-h) + 10px);
    background: var(--md-ed-err-bg); color: var(--md-ed-err-ink);
    box-shadow: inset 3px 0 0 var(--md-ed-err), 0 0 0 1px var(--md-ed-ring), 0 8px 24px var(--md-ed-shadow);
  }
  .ed-conflict[data-level="notice"] {
    bottom: 28px; background: var(--md-ed-surface); color: var(--md-strong);
    box-shadow: 0 0 0 1px var(--md-ed-ring), 0 8px 24px var(--md-ed-shadow);
  }
  .ed-msg-ico { display: grid; color: var(--md-muted); }
  .ed-conflict[data-level="error"] .ed-msg-ico { color: var(--md-ed-err); }
  .ed-msg-text { flex: 1 1 auto; }
  .ed-conflict button { font: inherit; font-size: 13px; font-weight: 600; border: 0; border-radius: 6px;
    padding: 4px 12px; cursor: pointer; background: var(--md-ed-err); color: var(--md-ed-surface); }
  .ed-conflict button.ed-msg-x { background: transparent; color: inherit; padding: 4px; display: grid; }
```

（既有 `.ed-conflict` 上方的「backlog #8」長註解保留，它解釋為何錯誤卡片在工具列下方；把其中「`top: var(--ed-toolbar-h)`」的描述改成「error 卡片的 top 以 `--ed-toolbar-h` 為底」，避免假句子。）

5. `test/editor-journey.test.js` 的英文文案斷言：`'File changed on disk'` → `'這個檔案剛在別處被修改'`；按鈕文字 `'Reload'` → `'重新載入'`（含 11625、11826 兩處測試自建的假橫幅按鈕，與 11999 的查找）。每處只換字串，不改斷言結構。

- [ ] **Step 4: 跑確認綠**

Run: `node test/editor-click.test.js "messages:" && node test/editor-client.test.js`
Expected: PASS。並數剩餘直呼：

```bash
node -e "const s=require('fs').readFileSync('lib/editor/client.js','utf8');console.log((s.match(/showBanner\(/g)||[]).length)"
```

Expected: `3`（定義 1、`showError` 1、`showNotice` 1）＋註解裡提到的次數；逐一檢視多出的都在註解中。

- [ ] **Step 5: 長套件**

Run（依序）：editor-client-runtime、editor-journey、`node test/editor-cell-range.test.js`、`node test/table-anchor-recovery.test.js`。
Expected: exit 0。若有情境在觸發「提示」後等待超過 4 秒才檢查 `.ed-conflict`：改成觸發後立刻讀（在 4 秒內），或改斷言提示「出現過」（在觸發的同一個 evaluate 裡取 textContent）。不得把提示改回 error 來讓測試過。

- [ ] **Step 6: Commit**

```bash
git add lib/editor/client.js lib/md2doc.js test/editor-click.test.js test/editor-client-runtime.test.js test/editor-journey.test.js
git commit -m "feat(editor): split messages into error cards and fading notices, in Chinese"
```

---

### Task 9: 外部修改偵測（`X-Md2doc-Mtime`）

**Files:**
- Modify: `lib/editor/server.js`（`/api/ping`）
- Modify: `lib/editor/client.js`（10 秒 ping 的回應處理、重新載入後還原位置）
- Test: `test/editor-server.test.js`、`test/editor-click.test.js`

**Interfaces:**
- Produces: `/api/ping` 對有效 `fileId` 的 204 與 200 都帶 `X-Md2doc-Mtime: <mtimeMs>`；無效 `fileId` 不帶。主體不變。
- Produces（client）：`onDiskMtime(ms)`：與 `mtimeMs` 不同時，乾淨 → 存捲動錨點到 `sessionStorage['md2doc-reload-anchor']` 並 `location.reload()`；有變更 → `showConflictBanner()`（每個外部版本只顯示一次）。波形編輯器開著時不處理，關閉後下一次 ping 再判斷。

- [ ] **Step 1: 寫失敗測試**

`test/editor-server.test.js`（依該檔 `req(port, method, path, body)` helper；它回傳的物件若沒有 headers，先在 helper 裡加上 `headers: res.headers`）：

```js
  // v3.10.0: ping reports the file's mtime in a header; the 204 stays bodiless.
  {
    const r = await req(srv.port, 'POST', '/api/ping', { fileId: 0 });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.body, '');
    const ms = Number(r.headers['x-md2doc-mtime']);
    assert.strictEqual(ms, fs.statSync(mdPath).mtimeMs, 'mtime header');
    const bad = await req(srv.port, 'POST', '/api/ping', { fileId: 99 });
    assert.strictEqual(bad.headers['x-md2doc-mtime'], undefined, 'no header for an unknown file');
  }
```

（放進該檔一個已有 `srv`、`mdPath` 的情境裡；變數名以該處實際名稱為準。）

`test/editor-click.test.js`：

```js
check('external edit: a clean page reloads itself, a dirty one raises the conflict card', DESKTOP, async (page, boot) => {
  const t0 = Date.now();
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8').replace('Second paragraph.', 'Second paragraph, edited outside.'));
  await page.waitForFunction(() => document.body.textContent.includes('edited outside'), null, { timeout: 15000 });
  assert.ok(Date.now() - t0 <= 13000, 'picked up within one ping');
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').first();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' local');
  fs.writeFileSync(boot.mdPath, fs.readFileSync(boot.mdPath, 'utf8') + '\nAppended outside.\n');
  await page.waitForSelector('.ed-conflict[data-level="error"]', { timeout: 15000 });
  const r = await page.evaluate(() => ({ text: document.querySelector('.ed-conflict').textContent, mine: document.body.textContent.includes(' local') }));
  assert.ok(r.text.includes('這個檔案剛在別處被修改'), r.text);
  assert.ok(r.mine, 'the unsaved edit is still on the page');
});
```

（第二段刻意在 burst 尚未提交時寫檔——鎖 Review Focus 第 4 點。）

- [ ] **Step 2: 跑確認紅**

Run: `node test/editor-server.test.js; MD2DOC_ENGINES=chromium node test/editor-click.test.js "external edit:"`
Expected: server 測試失敗於 `mtime header`；點擊檢查逾時。

- [ ] **Step 3: 實作**

`lib/editor/server.js` 的 `/api/ping`，在 `touchDrawioClient(...)` 之前加：

```js
        // v3.10.0: the client compares this with its own baseline to notice an
        // edit made outside the browser. A header, not a body: the bare 204
        // ("nothing stale") is part of the drawio contract and stays bodiless.
        const pingFile = (typeof fileId === 'number') ? absFiles[fileId] : undefined;
        if (pingFile) {
          try { res.setHeader('X-Md2doc-Mtime', String(fs.statSync(pingFile).mtimeMs)); } catch (e) { /* file gone: no header */ }
        }
```

`lib/editor/client.js` 的 10 秒 ping：把

```js
    }).then((res) => {
      if (res.status !== 200) return null;
      return res.json().catch(() => null);
```

改成

```js
    }).then((res) => {
      const disk = Number(res.headers.get('x-md2doc-mtime'));
      if (isFinite(disk) && disk > 0) onDiskMtime(disk);
      if (res.status !== 200) return null;
      return res.json().catch(() => null);
```

並在 ping 的 `setInterval` 之前新增：

```js
  // v3.10.0: an edit made outside the browser. Clean page: reload it and land
  // on the same heading. Unsaved work here: say so now, once per outside
  // version, instead of waiting for the save to bounce with a 409.
  let conflictShownFor = 0;
  function onDiskMtime(disk) {
    if (disk === mtimeMs || waveEditorIsModal()) return;
    if (!documentIsDirty()) {
      try { sessionStorage.setItem('md2doc-reload-anchor', JSON.stringify(readingAnchor())); } catch (e) { /* private mode */ }
      location.reload();
      return;
    }
    if (conflictShownFor === disk) return;
    conflictShownFor = disk;
    showConflictBanner();
  }
  function readingAnchor() {
    const hs = [].slice.call(document.querySelectorAll('.content h1[id], .content h2[id], .content h3[id], .content h4[id]'));
    let best = null;
    for (const h of hs) { if (h.getBoundingClientRect().top <= 80) best = h; else break; }
    return best ? { id: best.id, off: Math.round(best.getBoundingClientRect().top) } : { y: Math.round(scrollY) };
  }
  (function restoreReloadAnchor() {
    let a = null;
    try { a = JSON.parse(sessionStorage.getItem('md2doc-reload-anchor') || 'null'); sessionStorage.removeItem('md2doc-reload-anchor'); } catch (e) { a = null; }
    if (!a) return;
    requestAnimationFrame(() => {
      const h = a.id && document.getElementById(a.id);
      if (h) scrollTo(0, scrollY + h.getBoundingClientRect().top - a.off);
      else if (typeof a.y === 'number') scrollTo(0, a.y);
      showNotice('檔案在別處被修改，已重新載入。');
    });
  })();
```

（`documentIsDirty()` 已含未提交的 burst，所以打字中的狀態會走衝突卡片。`waveEditorIsModal` 是既有函式。）

- [ ] **Step 4: 跑確認綠**

Run: `node test/editor-server.test.js && node test/editor-click.test.js "external edit:"`
Expected: PASS。

- [ ] **Step 5: 相關套件**

Run: `node test/cli-edit.test.js && node test/editor-client.test.js`；再依序 editor-client-runtime、editor-journey。
Expected: exit 0。注意 journey 裡「刻意在外部改檔測 409」的情境：它現在會更早看到衝突卡片（ping 觸發），斷言的終態相同；若它斷言「存檔前沒有卡片」，改成斷言卡片文字，並在註解寫 v3.10.0 起外部修改會主動提示。

- [ ] **Step 6: Commit**

```bash
git add lib/editor/server.js lib/editor/client.js test/editor-server.test.js test/editor-click.test.js test/editor-journey.test.js
git commit -m "feat(editor): notice edits made outside the browser"
```

---

### Task 10: 清單符號逐層、核取框、勾選樣式（編輯器＋閱讀頁）

**Files:**
- Modify: `lib/md2doc.js`（`editModeLayoutCss` 的 ul 符號、閱讀頁 `.ed-li-check`、`renderer.listitem`、閱讀頁 `.content li` 附近加待辦規則）
- Test: `test/md2doc.test.js`、`test/editor-click.test.js`、`test/reader-click.test.js`

**Interfaces:**
- Produces（閱讀頁 HTML）：待辦項目 `<li class="task-item">` 或 `<li class="task-item is-checked">`，項目自己的文字包在 `<span class="task-text">…</span>`，子清單在 span 之外。

- [ ] **Step 1: 寫失敗測試**

`test/md2doc.test.js`（依該檔 render helper 寫法）：

```js
{
  const html = render('- [x] done\n  - [ ] child\n- [ ] open\n- plain\n');
  assert.ok(/<li class="task-item is-checked"><input[^>]*checked[^>]*>\s*<span class="task-text">done<\/span>\s*<ul>/.test(html), 'checked task wraps only its own text: ' + html);
  assert.ok(/<li class="task-item"><input[^>]*>\s*<span class="task-text">child<\/span><\/li>/.test(html), 'unchecked child');
  assert.ok(/<li>plain<\/li>/.test(html), 'plain items untouched');
}
```

`test/editor-click.test.js`：

```js
check('lists: bullets change by depth, checked items are struck, children are not', DESKTOP, async (page) => {
  const marks = await page.evaluate(() => [].map.call(document.querySelectorAll('.ed-block[data-list-type="ul"][data-task="0"] > .ed-li-marker'),
    (m) => getComputedStyle(m, '::before').content).slice(0, 3));
  assert.deepStrictEqual(marks, ['"•"', '"◦"', '"▪"']);
  const r = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ed-block[data-task="1"]')];
    const done = items.find((b) => b.textContent.includes('done item'));
    const child = items.find((b) => b.textContent.includes('open child'));
    const box = done.querySelector('.ed-li-check');
    return { doneDeco: getComputedStyle(done.querySelector('.ed-li-text')).textDecorationLine,
      childDeco: getComputedStyle(child.querySelector('.ed-li-text')).textDecorationLine,
      boxW: box.getBoundingClientRect().width, boxBg: getComputedStyle(box).backgroundImage };
  });
  assert.strictEqual(r.doneDeco, 'line-through'); assert.strictEqual(r.childDeco, 'none');
  assert.strictEqual(Math.round(r.boxW), 16); assert.ok(r.boxBg.includes('svg'), 'check mark drawn');
});
```

`test/reader-click.test.js`（在 theme 相關檢查附近；用一個帶待辦的 fixture，沿用該檔 `fixtureUrl(name, mdLines)`）：

```js
check('desktop: task items have no bullet; a checked one is struck but its child is not', DESKTOP, async (page) => {
  await page.goto(fixtureUrl('tasks', ['# T', '', '- [x] done', '  - [ ] child', '- [ ] open', '']), { waitUntil: 'load' }); await wait(300);
  const r = await page.evaluate(() => {
    const li = [...document.querySelectorAll('.content li.task-item')];
    return { n: li.length, styles: li.map((x) => getComputedStyle(x).listStyleType),
      done: getComputedStyle(li[0].querySelector('.task-text')).textDecorationLine,
      child: getComputedStyle(li[1].querySelector('.task-text')).textDecorationLine };
  });
  assert.strictEqual(r.n, 3);
  assert.deepStrictEqual(r.styles, ['none', 'none', 'none']);
  assert.strictEqual(r.done, 'line-through'); assert.strictEqual(r.child, 'none');
});
```

- [ ] **Step 2: 跑確認紅**

Run: `node test/md2doc.test.js; MD2DOC_ENGINES=chromium node test/editor-click.test.js "lists:"; MD2DOC_ENGINES=chromium node test/reader-click.test.js "task items"`
Expected: 三者皆 FAIL。

- [ ] **Step 3: 實作**

`lib/md2doc.js`：

1. `renderer.listitem` 改成：

```js
    const baseListitem = renderer.listitem.bind(renderer);
    renderer.listitem = function(token) {
      appendSectionText(flattenTokenText(token.tokens));
      const html = baseListitem(token);
      if (!token.task) return html;
      // v3.10.0: a task item drops its bullet and keeps its own text in a span,
      // so a checked item's strike-through stops at its own words — CSS
      // text-decoration cannot be undone on a nested child list.
      const cls = token.checked ? 'task-item is-checked' : 'task-item';
      const m = html.match(/^<li>([\s\S]*?<input[^>]*>)([\s\S]*?)(<(?:ul|ol)[\s>][\s\S]*|<\/p>[\s\S]*|<\/li>\s*)$/);
      if (!m) return html.replace(/^<li>/, '<li class="' + cls + '">');
      return '<li class="' + cls + '">' + m[1] + ' <span class="task-text">' + m[2].trim() + '</span>' + m[3];
    };
```

（Step 1 的單元測試會驗證 regex 對 tight／巢狀／一般項目都正確；loose 項目（`<li><p><input…> text</p>`）由 `</p>` 分支處理，另加一個單元斷言：`render('- [x] a\n\n- [ ] b\n')` 含 `<span class="task-text">a</span></p>`。）

2. 閱讀頁 `<style>`，在 `.content li,` 那組規則之後加：

```css
  .content li.task-item { list-style: none; }
  .content li.task-item > input[type="checkbox"],
  .content li.task-item > p > input[type="checkbox"] {
    appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0 6px 0 -22px;
    vertical-align: -3px; border: 1.5px solid var(--md-muted); border-radius: 4px; background: transparent; }
  .content li.task-item.is-checked > input[type="checkbox"],
  .content li.task-item.is-checked > p > input[type="checkbox"] {
    border-color: var(--md-accent); background: var(--md-accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 12px no-repeat; }
  .content li.task-item.is-checked > .task-text,
  .content li.task-item.is-checked > p > .task-text { color: var(--md-muted); text-decoration: line-through; }
```

（不使用色碼常值；`white` 在 data URI 裡，不會被主題改寫。刪除線只用子選擇器 `>`：巢狀子項目自己的 `.task-text` 在外層 `li.is-checked` 之內，後代選擇器會把它一起劃掉——Review Focus 第 2 點。）

3. 編輯器 `.ed-li-check` 兩條改成：

```css
  .ed-li-check { display: inline-block; width: 16px; height: 16px; margin-right: 6px; box-sizing: border-box;
    border: 1.5px solid var(--md-ed-glyph); border-radius: 4px; vertical-align: middle; cursor: pointer; }
  .ed-li-check[data-checked="1"] { border-color: var(--md-accent); background: var(--md-accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 12px no-repeat; }
  .ed-block[data-task="1"]:has(> .ed-li-check[data-checked="1"]) > .ed-li-text { color: var(--md-muted); text-decoration: line-through; }
```

4. `editModeLayoutCss` 的 `.ed-block[data-list-type="ul"] > .ed-li-marker::before { content: "\\2022"; }${edOlCounterCss}` 改成 `${edUlMarkerCss}${edOlCounterCss}`，並在 `edOlCounterCss` 迴圈之後新增（一般 JS 字串，不在 template literal 內，所以一個反斜線在字串裡要寫成兩個）：

```js
  // v3.10.0: bullets change by depth like the reader's disc / circle / square,
  // cycling every three levels. Task items keep their own content:none rule.
  const ED_UL_GLYPHS = ['\\2022', '\\25E6', '\\25AA'];
  let edUlMarkerCss = '';
  for (let d = 0; d <= ED_OL_MAX_DEPTH; d++) {
    edUlMarkerCss += '\n  .ed-block[data-list-type="ul"][data-indent="' + d + '"] > .ed-li-marker::before' +
      ' { content: "' + ED_UL_GLYPHS[d % 3] + '"; }';
  }
```

- [ ] **Step 4: 跑確認綠**

Run: `node test/md2doc.test.js && node test/editor-click.test.js "lists:" && node test/reader-click.test.js "task items"`
Expected: PASS。反引號計數 `352 4`。

- [ ] **Step 5: 相關套件**

Run: `node test/list-md.test.js && node test/roundtrip.test.js && node test/byte-stability.test.js && node test/reader-design.test.js`
Expected: PASS（閱讀頁 HTML 變了，但 editMode 的區塊 HTML 不經 `renderer.listitem`——若 list-md 測試紅，代表編輯模式也走到了新分支，回頭確認編輯模式的清單渲染路徑並讓 `task-item` 只出現在閱讀模式）。

- [ ] **Step 6: Commit**

```bash
git add lib/md2doc.js test/md2doc.test.js test/editor-click.test.js test/reader-click.test.js
git commit -m "feat: bullets by depth in the editor, task items with check marks and struck done items"
```

---

### Task 11: 程式碼語法上色（highlight.js）

**Files:**
- Modify: `package.json`（`dependencies` 加 `"highlight.js": "11.11.1"`；`test` 加 `node test/highlight.test.js`）
- Create: `lib/highlight.js`
- Modify: `lib/md2doc.js`（`renderer.code` 預設分支；閱讀頁 `<style>` 加 `.hljs-*` 規則）
- Modify: `lib/theme/tokens.js`（`syn-*` direct 角色）
- Create: `test/highlight.test.js`

**Interfaces:**
- Produces: `require('./highlight').highlightCode(code, lang) -> string | null`：已註冊語言回傳上色後 HTML（已跳脫），否則回 `null`。`lang` 只取第一個以空白分隔的字並轉小寫。

- [ ] **Step 1: 寫失敗測試**

`test/highlight.test.js`：

```js
'use strict';
const assert = require('assert');
const path = require('path');
const { highlightCode } = require('../lib/highlight.js');
const { renderMarkdown } = require('../lib/md2doc.js');

const v = highlightCode("module a; assign x = 1'b0; // c\nendmodule", 'verilog');
assert.ok(v.includes('<span class="hljs-keyword">module</span>'), v);
assert.ok(v.includes('hljs-number') && v.includes('hljs-comment'), v);
assert.strictEqual(highlightCode('a <b>', 'nosuchlang'), null, 'unregistered → null');
assert.strictEqual(highlightCode('x', ''), null, 'no lang → null');
assert.ok(highlightCode('module m; endmodule', 'verilog title=x').includes('hljs-keyword'), 'first word only');
assert.ok(highlightCode('module m; endmodule', 'SystemVerilog').includes('hljs-keyword'), 'alias, case-insensitive');
assert.ok(highlightCode('a < b && c', 'python').includes('&lt;'), 'escaped');

(async () => {
  const src = path.join(__dirname, 'fixtures-highlight.md');
  const md = '\x60\x60\x60verilog\nmodule a; endmodule\n\x60\x60\x60\n\n\x60\x60\x60\na <b>\n\x60\x60\x60\n\n\x60\x60\x60nosuch\nplain & text\n\x60\x60\x60\n';
  const { html } = await renderMarkdown(md, src, {});
  assert.ok(/<pre><code class="language-verilog hljs"><span class="hljs-keyword">module<\/span>/.test(html), 'verilog block coloured');
  assert.ok(html.includes('<pre><code class="language-">a &lt;b&gt;</code></pre>'), 'unlabelled block plain');
  assert.ok(html.includes('<pre><code class="language-nosuch">plain &amp; text</code></pre>'), 'unknown lang plain');
  const text = (h) => h.replace(/<[^>]+>/g, '');
  assert.strictEqual(text(highlightCode('module a; // x', 'verilog')), 'module a; // x', 'textContent unchanged');
  assert.ok(!/<script[^>]*>[^<]*hljs/.test(html), 'no highlighting script in the page');
  const edit = (await renderMarkdown(md, src, { editMode: true })).html;
  assert.ok(edit.includes('hljs-keyword'), 'edit mode blocks coloured too');
  console.log('highlight: ok');
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑確認紅**

Run: `node test/highlight.test.js`
Expected: FAIL `Cannot find module '../lib/highlight.js'`。

- [ ] **Step 3: 實作**

```bash
npm install --save-exact highlight.js@11.11.1
```

`lib/highlight.js`：

```js
'use strict';
// v3.10.0: syntax colour for fenced code, done once when the HTML is written —
// the reading page needs no script for it, and PDF gets it for free. Only the
// languages below are registered; anything else (or no language) stays plain
// text rather than guessing.
const hljs = require('highlight.js/lib/core');

const LANGS = {
  verilog: require('highlight.js/lib/languages/verilog'),
  python: require('highlight.js/lib/languages/python'),
  bash: require('highlight.js/lib/languages/bash'),
  c: require('highlight.js/lib/languages/c'),
  cpp: require('highlight.js/lib/languages/cpp'),
  json: require('highlight.js/lib/languages/json'),
  yaml: require('highlight.js/lib/languages/yaml'),
  tcl: require('highlight.js/lib/languages/tcl'),
  makefile: require('highlight.js/lib/languages/makefile'),
  javascript: require('highlight.js/lib/languages/javascript'),
  diff: require('highlight.js/lib/languages/diff'),
  plaintext: require('highlight.js/lib/languages/plaintext'),
};
for (const [name, def] of Object.entries(LANGS)) hljs.registerLanguage(name, def);
hljs.registerAliases(['systemverilog', 'sv', 'v'], { languageName: 'verilog' });
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });

function highlightCode(code, lang) {
  const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!name || !hljs.getLanguage(name)) return null;
  return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}

module.exports = { highlightCode };
```

`lib/md2doc.js`：檔頭 `require` 區加 `const { highlightCode } = require('./highlight');`。`renderer.code` 的預設分支改成：

```js
      // Default: fenced code. v3.10.0 colours registered languages here, at
      // render time (lib/highlight.js); an unknown or missing language stays
      // plain escaped text.
      const coloured = highlightCode(code, lang);
      if (coloured !== null) return `<pre><code class="language-${lang} hljs">${coloured}</code></pre>\n`;
      const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<pre><code class="language-${lang}">${escaped}</code></pre>\n`;
```

（這段在 `renderer.code` 函式內，不在 HTML template literal 內，模板字串本來就存在；不新增反引號以外的模板。改完跑反引號計數：**這裡新增了 2 個反引號**（一個新的模板字串），所以新總數是 `354 4`——在 commit 訊息與 CLAUDE.md 的計數段落記下新基準。）

`lib/theme/tokens.js` 在 `ed-*` 之後加：

```js
  { name: 'syn-keyword', light: ['#cf222e'], dark: '#ff7b72', direct: true },
  { name: 'syn-number', light: ['#0550ae'], dark: '#79c0ff', direct: true },
  { name: 'syn-comment', light: ['#6e7781'], dark: '#8b949e', direct: true },
  { name: 'syn-string', light: ['#0a3069'], dark: '#a5d6ff', direct: true },
  { name: 'syn-type', light: ['#953800'], dark: '#ffa657', direct: true },
  { name: 'syn-title', light: ['#8250df'], dark: '#d2a8ff', direct: true },
```

`test/theme.test.js` 的對比 `pairs` 加（深色程式碼底是閱讀頁 `pre` 的背景角色；先 `grep -n "  pre {" lib/md2doc.js` 確認是 `surface` 或 `panel`，下面以實際角色為準）：

```js
    ['syn-keyword', 'surface', 4.5], ['syn-number', 'surface', 4.5], ['syn-comment', 'surface', 4.5],
    ['syn-string', 'surface', 4.5], ['syn-type', 'surface', 4.5], ['syn-title', 'surface', 4.5],
```

淺色同樣要過：在同一個 check 後面加一段以 `T.THEME_TOKENS.find(...).light[0]` 取淺色值、對淺色 `surface`（`#f6f8fa`）算對比 ≥ 4.5 的迴圈。若某個值不到 4.5，調整該角色的值（深色往亮、淺色往暗），並同步改 Step 3 表格與 CHANGELOG 不需要列色碼。

閱讀頁 `<style>`（在 `pre` / `code` 相關規則之後）加：

```css
  .hljs-keyword, .hljs-selector-tag, .hljs-literal { color: var(--md-syn-keyword); }
  .hljs-number, .hljs-attr, .hljs-attribute { color: var(--md-syn-number); }
  .hljs-comment, .hljs-quote { color: var(--md-syn-comment); font-style: italic; }
  .hljs-string, .hljs-regexp { color: var(--md-syn-string); }
  .hljs-type, .hljs-built_in, .hljs-meta { color: var(--md-syn-type); }
  .hljs-title, .hljs-variable, .hljs-params, .hljs-section { color: var(--md-syn-title); }
  .hljs-addition { color: var(--md-syn-string); }
  .hljs-deletion { color: var(--md-syn-keyword); }
```

修正 `renderer.code` 上一個分支裡「`// Default: syntax-highlighted code block`」那句與程式不符的舊註解（已被上面的新註解取代）。

- [ ] **Step 4: 跑確認綠**

Run: `node test/highlight.test.js && node test/reader-design.test.js && node test/theme.test.js`
Expected: `highlight: ok`，其餘 PASS。

- [ ] **Step 5: 全套**

Run: `rtk proxy npm test > /tmp/b1-t11.log 2>&1; echo $?`
Expected: exit 0。若 `md2doc.test.js` 有斷言程式碼區塊精確 HTML（`<pre><code class="language-verilog">…`），更新為新輸出；`byte-stability`／`roundtrip` 必須維持不變（它們比對 Markdown，不比 HTML）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/highlight.js lib/md2doc.js lib/theme/tokens.js test/highlight.test.js
git commit -m "feat: syntax colour for fenced code (highlight.js, GitHub palette)"
```

---

### Task 12: 編輯模式 Mermaid 在深色下的重畫

**Files:**
- Test: `test/editor-click.test.js`
- Modify（只有在測試紅時）: `lib/theme/runtime.js`、`lib/editor/client.js`

鎖 Review Focus 第 1 點。

- [ ] **Step 1: 寫檢查**

```js
check('mermaid: stays dark after an unrelated block is edited', DESKTOP, async (page) => {
  await page.locator('#md2doc-theme-toggle').click(); await wait(1200);
  const fill = () => page.evaluate(() => {
    const r = document.querySelector('.mermaid svg .node rect, .mermaid svg .node polygon');
    return r ? getComputedStyle(r).fill : null;
  });
  const before = await fill();
  assert.ok(before && before !== 'rgb(234, 242, 253)', 'guard: mermaid drawn dark ' + before);
  const ed = page.locator('.ed-block[data-block-type="paragraph"] .ed-wys-armed').last();
  await ed.click(); await page.keyboard.press('End'); await page.keyboard.type(' z');
  await page.locator('.ed-block[data-block-type="heading"]').first().click(); await wait(1500);
  assert.strictEqual(await fill(), before, 'mermaid kept its dark fill after a re-render');
});
```

- [ ] **Step 2: 跑**

Run: `node test/editor-click.test.js "mermaid:"`
Expected: PASS 即本任務完成（只提交測試）。若 FAIL：讀 `lib/theme/runtime.js` 的 mermaid 快取（`data-md2doc-live`、`drawDark`）與 `client.js` 的 `__md2docInitDiagrams` 呼叫點，找出重建區塊時是否繞過主題 runtime；修正方式是讓重建後的 mermaid 節點經過同一個 `notify(isDark())` 路徑。修完重跑直到兩個引擎都綠。

- [ ] **Step 3: Commit**

```bash
git add test/editor-click.test.js lib/theme/runtime.js lib/editor/client.js
git commit -m "test(editor): mermaid keeps dark after a block re-render"
```

---

### Task 13: 文件與版本紀錄

**Files:**
- Modify: `CLAUDE.md`、`CHANGELOG.md`

- [ ] **Step 1: CLAUDE.md**

1. 「Dark Mode — Colours Go Through `lib/theme/tokens.js`」一節：
   - 刪除「Rules whose selector text … contains `.ed-`, `html.ed-` or `.lightbox` … are skipped on purpose (edit mode is light-only; the lightbox is already dark).」改寫為：「Rules whose selector contains `.lightbox` are skipped (already dark). Since v3.10.0 the editor is themed: its chrome uses `direct` roles (`ed-*`, `syn-*`) written as `var(--md-…)` in the CSS — a direct role's light value never claims a reader literal — and the waveform editor keeps literals mapped by `wave-*` roles. In `.ed-` rules every `rgba()` must be a role or listed in `KEEP_RGBA`.」
   - 刪除「`renderMarkdown(…, { noTheme: true })` skips the post-pass; only the light-lock test uses it.」之前關於編輯模式不跑主題的任何敘述（若有）。
2. 「`lib/md2doc.js`'s CSS Lives Inside a JS Template Literal」一節的反引號計數：把「352 / 348」更新為 Task 11 後**實測**的新值（`node -e` 指令重新量），並寫明「measured at v3.10.0」；舊數字保留在「Measured at v3.5.0 (be5cea1) and again at v3.6.0」那句歷史敘述裡不改。
3. Repo Layout 表：新增 `lib/editor/icons.js`、`lib/highlight.js` 兩列（一句用途＋錨點）。
4. 「Tests live in `test/`」那段加 `editor-click.test.js`（Playwright，屬於 `test:browser`）與 `highlight.test.js`。

- [ ] **Step 2: CHANGELOG.md**

在最上方加：

```markdown
## [3.10.0] - 2026-10-??

### Added
- Edit mode now has dark mode: the same ☀/☾ bubble as the reading page, the same palette, and every editor control (toolbar, menus, selection toolbar, block source box, table controls, waveform editor) follows it.
- Fenced code is syntax-coloured (highlight.js, GitHub colours) in the reading page, PDF and editor. Registered: Verilog/SystemVerilog, Python, Bash, C, C++, JSON, YAML, Tcl, Makefile, JavaScript, diff. Other languages stay plain.
- The toolbar shows whether the file is saved ("✓ 已儲存" / "● 有未儲存的變更 · Ctrl+S 儲存"); the save button lights up while there are unsaved changes.
- The editor notices edits made outside the browser: a page with no unsaved changes reloads itself at the same heading; a page with unsaved changes shows the conflict card right away.

### Changed
- Editor look: paper-white toolbar and menus with Lucide line icons, the reader's blue (#0969da) for focus, selection and drop lines; no dashed outline on hover.
- Messages come in two kinds: problems that can lose or skip an edit are cards under the toolbar that stay until closed; explanations are small boxes at the bottom that fade after 4 seconds. All messages are in Chinese.
- The ⠿ / ＋ buttons are 24px and sit on each block's first line of text.
- Bullets change by depth in the editor (• ◦ ▪), like the reading page. Task checkboxes are 16px with a check mark; a checked item's text is greyed and struck through, in both the editor and the reading page.

### Fixed
- Reading page: task-list items showed a bullet and a checkbox at the same time.

### Removed
- The whole-document source mode (the M↓ button). Edit one block's Markdown from ⠿ → MD 原始碼; for anything the editor cannot reach, edit the file in a text editor — the page updates itself.
```

（日期在發版當天填。）

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: v3.10.0 changelog and contributor notes for the themed editor"
```

---

### Task 14: 全面驗證（等同 8-step gate 的 6–8）

不寫新產品程式碼。任何一步紅就回到對應任務修，修完從本任務 Step 1 重來。

- [ ] **Step 1: 乾淨工作樹跑全套**

```bash
git status --short   # 必須為空
rtk proxy npm test > /tmp/b1-final.log 2>&1; echo "exit $?"
```

Expected: exit 0。紅的話先依 CLAUDE.md 判斷是否為基礎設施（0 個 AssertionError ＋ TargetCloseError 等）或 F6 既知 flake，重跑；可重現的紅一律修。

- [ ] **Step 2: 點擊檢查兩個引擎**

Run: `npm run test:browser > /tmp/b1-browser.log 2>&1; echo $?; grep -c "^ok" /tmp/b1-browser.log`
Expected: exit 0；`editor-click:` 與 `reader-click:` 兩行 `checks passed` 都在；`ok` 行數等於（檢查數 × 2 引擎）。

- [ ] **Step 3: 端到端——真實文件**

用 mac-tx-core 的副本（不得改原檔）：

```bash
mkdir -p /tmp/b1-e2e && cp -r /home/user/hp_workspace/paperwork-workspace-rtk/spec/mac-tx-core/design-doc/* /tmp/b1-e2e/
node bin/md2doc.js /tmp/b1-e2e/mac-tx-core.md --out /tmp/b1-e2e/out.html && echo render-ok
```

寫一支一次性 Playwright 腳本 `/tmp/b1-e2e/e2e.js`（不進 repo），用 `createEditorServer` 開 `/tmp/b1-e2e/mac-tx-core.md`，依序斷言（每項印出實際值）：
1. 深色切換後：工具列、⠿ 選單、選字工具列、表格欄選單、MD 原始碼框、波形編輯器面板的背景與文字對比都 ≥ 4.5:1。
2. 7 個 Verilog 區塊都有 `.hljs-number` 或 `.hljs-keyword`；7 張 Graphviz、2 張 Mermaid 在深色下仍是深色（沿用 reader-click 的對比函式）。
3. 隨機 10 個段落／標題／清單項：⠿ 中心在第一行 ±2px。
4. 改一個段落 → 狀態「有未儲存的變更」→ Ctrl+S → 「已儲存」→ 檔案只有那一段的行改變（`diff` 原檔與新檔，只有 1 個 hunk）。
5. 外部 `touch` 加改一個字 → 12 秒內頁面更新、停在原標題附近（閱讀線上的標題 id 不變）。
6. 沒有 `[data-ed-tb="preview"]`、沒有 `textarea.ed-source`、工具列 22 顆全部可見。
7. 待辦（若文件沒有，在副本末尾加三行待辦）勾選後刪除線、子項目無刪除線。

Expected: 全部通過。把腳本輸出存 `/tmp/b1-e2e/report.txt`。

- [ ] **Step 4: 規格逐條對照**

逐節讀 `docs/superpowers/specs/2026-10-04-editor-batch1-design.md`，每一條要求寫下對應的任務與證據（測試名或 e2e 項目），存 `/tmp/b1-spec-trace.txt`。沒有證據的要求 → 停下回報，不得宣告完成。

- [ ] **Step 5: 範圍外檢查**

確認批 2、批 3 的功能沒有被意外帶進來，也沒有被破壞：Enter 仍是「送出並離開」（批 2 才改）、＋ 仍是 5 種膠囊（批 2 才改）、程式碼區塊點擊仍開 MD 原始碼框（批 3 才改）。各以一個快速點擊驗證並記錄。

- [ ] **Step 6: 回報**

給使用者：`git log --oneline main..feat/editor-batch1`、`git diff --stat main..feat/editor-batch1`、`/tmp/b1-final.log` 尾端摘要、`/tmp/b1-browser.log` 的 passed 行、e2e 報告、spec trace 的缺口（應為 0）。**不 push、不開 PR、不升版**——等使用者說「OK 更新 repo」再依 CLAUDE.md Release Flow（PR → CI 綠 → `--merge` → `npm version minor` → push main 與 tag）。
