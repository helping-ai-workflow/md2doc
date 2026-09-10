## Task 1: heading 文字的雙重跳脫

**Files:**
- Modify: `lib/md2doc.js`（`escapeHtml()` 旁新增 `unescapeHtml()`；`flattenTokenText()` 的兩個葉節點分支）
- Test: `test/md2doc.test.js`

**Interfaces:**
- Produces: `unescapeHtml(value) -> string`——`escapeHtml()` 的精確逆函式，module 內部使用，不對外匯出。`flattenTokenText(tokens) -> string` 的契約改為「一律回傳純文字，永遠不帶 HTML 實體」。

### 背景（實作者需要知道的）

`marked` 的 lexer 對同一個 heading 給出兩種跳脫狀態。這是量測結果，不是推論：

```
輸入：# Alpha & Beta <x> `a&b`

heading.text  = "Alpha & Beta <x> `a&b`"     ← 原始，未跳脫
  tok text     text= "Alpha &amp; Beta "     ← 已跳脫
  tok html     text= "<x>"
  tok codespan text= "a&amp;b"               ← 已跳脫
```

`renderer.heading` 寫的是 `stripHtmlTags(flattenTokenText(token.tokens) || token.text || '')`。
`flattenTokenText()` 走 inline token 回傳已跳脫的字串；`|| token.text` 的後備支回傳原始字串。
**同一個 `||` 的兩邊跳脫狀態不一致**，這是缺陷本身。

三個消費者吃到已跳脫的字串：`renderTocNodes()` 的 `escapeHtml(node.text)`（雙重跳脫）、
`slugifyHeading(headingText)`（錨點帶 `amp`/`lt`/`gt`）、`startSection({...text})`（section index）。

- [ ] **Step 1: 寫會紅的測試**

在 `test/md2doc.test.js` 既有的渲染器測試旁邊加入（沿用該檔既有的 helper 與斷言風格——先讀該檔開頭，看它怎麼呼叫渲染、怎麼比對）：

```js
// v3.4.0 §1: marked 的 inline token 已經跳脫過，flattenTokenText() 不得把
// 它原樣交出去 —— 交出去之後 escapeHtml() 會再跳一次，而 slugifyHeading()
// 會把實體名稱 amp / lt / gt 當成文字併進錨點。
{
  const html = renderToHtml('# Alpha & Beta\n\ntext\n\n## C < D > E\n\nmore\n');

  assert.ok(html.includes('href="#alpha-beta"'),
    'slug 不得含實體名稱 amp。Got: ' +
    (html.match(/href="#[^"]*"/g) || []).join(', '));
  assert.ok(html.includes('href="#c-d-e"'),
    'slug 不得含實體名稱 lt / gt。Got: ' +
    (html.match(/href="#[^"]*"/g) || []).join(', '));

  assert.ok(!html.includes('&amp;amp;'),
    'TOC 標籤不得雙重跳脫（&amp;amp; 會顯示成 &amp;）');
  assert.ok(!html.includes('&amp;lt;'),
    'TOC 標籤不得雙重跳脫（&amp;lt; 會顯示成 &lt;）');

  // TOC 連結本身仍必須是單層跳脫的合法 HTML
  assert.ok(html.includes('title="Alpha &amp; Beta"'),
    'TOC 的 title 應為單層跳脫。Got: ' +
    (html.match(/title="[^"]*"/g) || []).join(', '));
}
```

- [ ] **Step 2: 跑測試確認它紅**

```bash
node test/md2doc.test.js > /tmp/t1.log 2>&1; echo "EXIT=$?"; cat /tmp/t1.log
```

預期：`EXIT=1`，且訊息顯示實際 slug 是 `#alpha-amp-beta` 與 `#c-lt-d-gt-e`。

**若它在改動前就是綠的，停下來**——代表機制猜錯了，回報 `BLOCKED` 並附上實際輸出。

- [ ] **Step 3: 新增 `unescapeHtml()`**

放在 `escapeHtml()` 正下方（同一個 scope）。**`&amp;` 必須最後處理**，否則
`&amp;lt;` 會被解成 `<` 而不是 `&lt;`：

```js
    // escapeHtml() 的精確逆函式。marked 的 inline lexer 會把 text / codespan
    // token 的 `text` 欄位跳脫過再交出來，而 heading token 自己的 `text` 是
    // 原始的 —— flattenTokenText() 用這一支把兩邊拉回同一個狀態。
    // &amp; 必須最後解：先解它會讓 `&amp;lt;` 變成 `<` 而不是 `&lt;`。
    function unescapeHtml(value) {
      return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }
```

- [ ] **Step 4: 改 `flattenTokenText()` 的兩個葉節點分支**

`codespan` 分支與最後的 fallthrough 是唯二真的讀 `item.text` 的地方：

```js
          if (item.type === 'codespan') {
            return unescapeHtml(item.text || '');
          }
          if (item.tokens) {
            return flattenTokenText(item.tokens);
          }
          return unescapeHtml(item.text || '');
```

並在函式上方補一行契約註解：

```js
    // 契約：一律回傳純文字，永遠不帶 HTML 實體。呼叫端（TOC 標籤、
    // slugifyHeading、startSection）三者都假設這一點。
```

**不要動** `renderer.heading` 裡的 `headingHtml`（走 `parser.parseInline`，本來就正確），
也不要動 `renderTocNodes()` 的 `escapeHtml(node.text)`。

- [ ] **Step 5: 跑測試確認它綠**

```bash
node test/md2doc.test.js > /tmp/t1.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t1.log
```

預期：`EXIT=0`。

- [ ] **Step 6: 跑會被影響的其他快速測試**

`slugifyHeading` 的輸出是錨點，`docsource` / `roundtrip` / `render-api` 都可能釘過它：

```bash
for f in test/docsource.test.js test/roundtrip.test.js test/render-api.test.js test/editmode-render.test.js; do
  node $f > /tmp/t1-$(basename $f).log 2>&1; echo "$f EXIT=$?"
done
```

任何一支變紅：**那是真的迴歸或是一個釘死舊 slug 的斷言**。若是後者，先在 report
裡寫出「舊斷言釘的是錯的形狀」的證明，再遷移它。**不准 skip。**

- [ ] **Step 7: Commit**

```bash
git add lib/md2doc.js test/md2doc.test.js
git commit -m "fix(render): heading text reaches the TOC and the slug unescaped

marked's inline text/codespan tokens carry an already-escaped `text`, while
the heading token's own `text` is raw. flattenTokenText() handed the escaped
form to three consumers that all assume plain text: the TOC label escaped it
a second time, slugifyHeading() folded the entity NAMES into the anchor
(alpha-amp-beta), and the section index carried the doubled form.

The anchors change: #alpha-amp-beta becomes #alpha-beta and #c-lt-d-gt-e
becomes #c-d-e. External links to the old anchors break. The old slugs were
the defect's own output, so keeping them would make a bug into a contract."
```

---

