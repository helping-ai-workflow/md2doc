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

