## Task 8 report — `inline-md.js` 定界符長度選擇（backlog 第 3 項）

**status**: DONE（含 review 三個 Minor 的處置，見檔案最下方 addendum）
**commit（最終，已 amend）**: `0bed3c8962862335cd6d7722e59fdb5a6838d5b8`
**commit（review 前的舊版，已被 amend 取代，只留紀錄）**: `0e4052aaba8fd3e883b29947764a4e35595f9e82`

### 測試 EXIT

| 測試 | EXIT |
|---|---|
| `node test/inline-md.test.js` | 0 |
| `node test/paste-md.test.js` | 0 |
| `node test/roundtrip.test.js` | 0 |
| `node test/byte-stability.test.js` | 0 |

### Step 1：重現並記錄實際位元組

臨時腳本（用 `test/inline-md.test.js` 同款 `el()` DOM stub 驅動 `serializeInline`）：

```js
const shape = el('p', {},
  el('em', {}, el('code', {}, 'code')),
  el('em', {}, 'text'));
serializeInline(shape).md
```

輸入 DOM 形狀：`<em><code>code</code></em><em>text</em>` —— 正是 backlog 舉的
`` *`code`* `` 這一段，緊接著（**DOM 相鄰、無分隔字元**）另一個 `<em>text</em>`。這正是
「選取起點落在既有標記邊界」在實際手勢裡最自然會產生的 DOM：先把 `code` 斜體化，遊標落
在那個 `</em>` 右邊界，再選下一段文字斜體化，瀏覽器不會把兩個 `<em>` 合併（第一個裝著
`<code>`）。

**修正前實際輸出**（逐字）：

```
*`code`**text*
```

**餵進 `marked.parseInline()` 的結果**（也是逐字量到的，不是憑印象）：

```
*<code>code</code>*<em>text</em>
```

第一個 `<em>` **整個消失**——它的開／關兩個 `*` 都被 reparse 成字面上的星號字元，只有第二
個 `<em>` 活下來。也就是說，存檔 → reload 之後，畫面上會看到字面的 `*code*`（星號本身可
見），而不是斜體。這不是「多一個跳脫字元」那麼輕微，是整個標記在 round-trip 上憑空消失。

（backlog 原文寫的「`\*` 跳脫」，追到 v3.3.0 `progress.md` T6-7 那段紀錄後可以還原成因：
那句話是**寫紀錄的人自己**要在自己的 markdown 筆記裡指出「畫面上出現一個字面星號」，若不
加反斜線那個星號會被他自己的筆記工具吃成斜體標記——所以他寫的是他自己筆記裡的跳脫，不是
`inline-md.js` 輸出裡真的含有反斜線。逐位元組驗證過：目前程式碼裡完全沒有任何路徑會對
`EM`/`STRONG` 的定界符本身輸出反斜線，`escapeText()` 只作用在純文字節點；上面貼的兩行才是
`inline-md.js` 真正吐出來、餵進 marked 之後真正觀測到的位元組。)

其餘同族確認過的形狀（同一支臨時腳本量出來，逐字）：

```
<strong>a</strong><strong>b</strong>  DOM
"**a****b**"                          修正前輸出
"<strong>a****b</strong>"             marked.parseInline —— 兩個 <strong> 併成一個，"****" 變成字面文字

<em>a</em><em>b</em>                  DOM
"*a**b*"                              修正前輸出
"<em>a**b</em>"                       marked.parseInline —— 第二個 <em> 消失，"**" 變成字面文字
```

### Step 2：定界符長度是怎麼被選出來的，為什麼錯

錨點：`lib/editor/inline-md.js` 的 `walkChildren()`，`STRONG`/`B` 與 `EM`/`I` 兩個分支
（修正前）：

```js
if (name === 'STRONG' || name === 'B') {
  out += '**' + walkChildren(node.childNodes, unsupported) + '**';
  ...
}
if (name === 'EM' || name === 'I') {
  out += '*' + walkChildren(node.childNodes, unsupported) + '*';
  ...
}
```

**輸入**：兩個相鄰（DOM 上緊鄰、之間沒有任何字元節點）的 `EM`/`STRONG` 節點。
**它選了什麼**：每個節點只看自己的 tag 名稱，無條件輸出固定長度的定界符（`EM` 永遠 1 個
`*`、`STRONG` 永遠 2 個 `*`），對「這段輸出即將接在什麼字元後面」完全沒有感知——這裡根本
沒有「選擇」邏輯，是「寫死」。
**為什麼在這個形狀上是錯的**：CommonMark 的 emphasis 掃描器讀的是**扁平字元流**，不是
DOM/AST；它把「連續相同字元」定義成一個 delimiter run，整串一起配對。當節點 A 的收尾 `*`
後面緊接著節點 B 的開頭 `*`（中間沒有任何分隔字元），這兩個各自獨立、語意上分別是「關掉
A」「打開 B」的單字元事件，在輸出的字元流裡會**物理上黏成一個長度 ≥2 的單一 run**。marked
自己的 flanking／配對演算法接下來是對**這個合併後的 run** 做配對，不是對 DOM 原本想表達
的兩個獨立事件配對——量到的結果是：`EM`+`EM` 相鄰時中間的 `**` 被 marked 判定成噪音字面
文字、第二個 `<em>` 連著它自己整段內容一起被吞掉；`STRONG`+`STRONG` 相鄰時中間的 `****`
同樣被吞成字面文字，兩個 `<strong>` 併成一個。

### Step 3：修

同一個錨點加一道邊界守衛 `starBoundaryGuard(out)`：在 `STRONG`/`EM` 即將輸出自己的開頭
定界符之前，檢查目前這一層 `walkChildren()` 呼叫自己的 `out` 累積字串最後一個字元是不是
`*`；如果是，先插入一個空的 HTML 註解 `<!-- -->` 當作 run 的物理隔斷，再輸出自己的定界符。

```js
function starBoundaryGuard(out) {
  return out.charAt(out.length - 1) === '*' ? '<!-- -->' : '';
}
```

選 `<!-- -->` 而不是切換成 `_`/`__`（曾經在同一支臨時腳本裡試過）的原因，逐一量過：
- `<!-- -->` 本身不含任何 `*` 字元，插進去之後兩側的 `*` 物理上不再相鄰，run 一定會斷開，
  跟兩側原本是什麼字元完全無關（不需要重算 CommonMark flanking 規則）。
- 切成 `_`/`__` 曾經在同一批相鄰形狀上驗過確實能解掉原始 bug，**但**多量了一個邊界情況：
  `_` 系列的 emphasis 有 CommonMark 的 intraword 限制，如果切換後的收尾 `_` 緊接著（沒有
  空白）一個字母數字字元，那個 `_` 完全**關不掉**——實測 `` *`code`*_text_word `` 餵進
  `marked.parseInline()` 後，`_text_word` 整段原封不動留在輸出裡（沒有被解析成任何東西），
  而同一個形狀換成 `<!-- -->` 版本（`` *`code`*<!-- -->*text*word ``）能正確解析出
  `<em>text</em>word`。因為 `*` 系列的 emphasis 沒有 intraword 限制，用 `<!-- -->` 隔開後
  仍然用 `*`，不會踩到這個坑。
- 這個守衛只看**本層** `out`（`walkChildren` 每次遞迴呼叫自己的局部變數），所以巢狀
  `STRONG>EM`（既有測試 `'***both***'`）完全不受影響：`EM` 是 `STRONG` 內容的第一個、也是
  唯一一個子節點，它自己那層遞迴的 `out` 一開始是空字串，不會摸到外層 `STRONG` 剛輸出的
  `**`。逐字驗過：`serializeInline(el('p', {}, el('strong', {}, el('em', {}, 'both')))).md`
  修正後仍然是 `'***both***'`，一個字元都沒變。
- 讀回來也是惰性的：`walkChildren()` 本來就只處理 `nodeType === 3`（文字）與
  `nodeType === 1`（元素），其他型別（含 `<!-- -->` 對應的 `nodeType === 8` comment node）
  一律 `continue` 跳過——不會進 `unsupported` 清單（`canWysiwyg` 仍為 `true`），也不會在下
  一次存檔時被重新序列化出來；如果 DOM 裡還留著這個 comment node，下一次存檔時它會被跳過、
  兩個 `EM` 之間依然沒有分隔字元，同一道守衛會**重新**判斷、重新插一個——不會累積、不會
  外洩。

唯一已知、刻意接受的不精確：`out.charAt(out.length - 1) === '*'` 這個判斷無法分辨「活的」
`*` 跟「已轉義的」`\*`（純字串比對最後一個字元，兩者最後一個字元都是 `*`）。CommonMark 的
反斜線跳脫規則會把 `\*` 整個從 delimiter-run 掃描裡移除，所以緊接著一個活的 `*` 其實**不
需要**隔開也不會誤配對；這道守衛在這種情況下會插入一個**用不到但無害**的 `<!-- -->`（多
幾個位元組，不影響正確性、不影響 `canWysiwyg`、不影響任何既有測試）。這一點寫進程式碼自己
的註解裡了，沒有另外處理，因為要精確分辨「前面有偶數個反斜線」需要往回掃描整個已輸出字串，
複雜度換來的唯一好處是省幾個位元組，不值得。

### Step 4 / 5：測試與跑法

新增區塊在 `test/inline-md.test.js` 尾端（`console.log('inline-md.test.js OK')` 之前）：
釘住上面 Step 1 量到的確切 DOM 形狀與修正後的確切輸出字串
`'*`code`*<!-- -->*text*'`、STRONG-STRONG 同族形狀、以及兩條 regression guard（巢狀
`***both***` 不受影響、無邊界情況的單一 `*x*` 不受影響）。四支必跑測試（`inline-md`、
`paste-md`、`roundtrip`、`byte-stability`）全部 `EXIT=0`，都遵守「不 pipe，先寫檔案再讀」
的規則。

### Concerns

- 我沒有找到任何字面上真的輸出反斜線的路徑——backlog 用詞「`\*` 跳脫」與我逐位元組量到的
  實際輸出（純字面星號消失、不是反斜線轉義）不一致，已在上面 Step 1 追到並寫出原因（追溯
  到 v3.3.0 `progress.md` T6-7 那句話本身用的是**筆記作者自己**的轉義，不是程式輸出的轉
  義）。這不影響修法本身（同一個根因、同一個檔案、同一族「定界符相鄰」症狀），但如果你原本
  預期看到程式碼路徑真的產生一個 `\*` 字元，這裡要先講清楚：沒有，那個判讀是走歷史紀錄反推
  出來的，只此一處推測，其餘全部是跑出來的。
- `<!-- -->` 這個修法會在**所有**「星號結尾接星號開頭」的相鄰情況都插入分隔（包含某些原本
  不換也不會壞的組合，例如 `*a*` 後面接 `**b**`——3 個星號原本就能正確配對），不是只在真正
  會壞掉的最小子集才插入。換來的是不必重算 CommonMark 的 flanking／intraword 規則、邏輯
  简单到一行判斷就能涵蓋整族相鄰形狀。多出來的位元組是空的 HTML 註解，不影響任何既有測試
  斷言（都逐一驗證過），也不影響 `canWysiwyg`。如果你希望更「精簡」（只在真正需要時才插
  入），那是下一輪可以做的收斂，目前沒有做。
- 沒有動 `test/editor-client-runtime.test.js`（另一個 task 進行中的工作，依指示未碰、未
  stage、未在這裡討論內容）。

---

## Addendum — review 回來後的三個 Minor（裁定現在做，不進 fix loop排隊）

Review 結論：Critical 0、Important 0（在本 task 範圍內）、既有測試零放寬。獨立驗證了
「backlog 的『`\*` 跳脫』描述不準確」這件事，並且另外做了 100 個上下文的暴力掃描：**同 tag
相鄰 50/50 全壞、跨 tag 相鄰 50/50 全正常**——嚴重度比我原本 report 裡寫的更高（不是「多幾
個位元組」，是**存檔後整個標記從檔案裡消失**）。`<!-- -->` 的代價也被 reviewer 逐項驗過：
不會累積（4 輪固定點）、渲染不可見、不汙染 heading slug、實際插入率 75/12516（0.60%）、
過度插入只有 1.3%（不是我自陳的「一半」）。

### Minor 3（最優先）：commit subject 說了一件不存在的事 —— 已處置：amend

原 subject `fix(editor): a selection that starts next to a delimiter stops
escaping it` 是照抄 brief 預先寫好的句子，但整個 task 的調查結果推翻了「有 escaping」這個
前提——從頭到尾沒有任何程式碼路徑對這個 bug 輸出過反斜線。`git commit --amend`（尚未
push，改得動）換成準確描述真實缺陷的 subject/body：

```
fix(editor): adjacent same-tag marks stop swallowing each other
```

body 寫清楚真正機制（兩個相鄰的星號輸出黏成一個 CommonMark delimiter run、marked 用自己
的規則重新配對、第一個標記整個消失，不是多一個逃脫字元），以及「`\*` 跳脫」那句話追溯到
v3.3.0 `progress.md` 是**筆記作者自己**要在自己的散文裡顯示一個字面星號所需的 markdown
轉義，不是對 `inline-md.js` 輸出位元組的主張。同一次 amend 也把 Minor 1／Minor 2 的程式碼
與測試改動摺進同一個 commit（原本兩顆改動也都動在同兩個檔案上，摺成一顆乾淨的 commit 比
另開兩顆小 commit 更符合這裡「一個 task 一個邏輯改動」的慣例）。**最終 SHA**：
`0bed3c8962862335cd6d7722e59fdb5a6838d5b8`。

### Minor 2：「不會累積」釘成測試 —— 已處置

`test/inline-md.test.js` 新增一個區塊（"review Minor 2" 註解開頭）：建一個已經含
`{ nodeType: 8 }`（COMMENT_NODE）stub 的 DOM，模擬「上一輪守衛留下的 `<!-- -->` 被
marked 讀回 DOM 之後、下一次編輯再存檔」這個真實場景，斷言 `serializeInline()` 的輸出跟
乾淨 DOM（沒有殘留 comment）**逐位元組相同**——不是「還能 parse」，是完全一樣的字串，這才
真的排除線性增長。另外多測了「兩個殘留 comment 排在一起」，同樣收斂到跟單一 comment 一樣
的輸出，證明這道守衛是看 `out` 的**結尾字元**在判斷，不是看走過幾個 comment node，所以不論
殘留幾個都收斂到同一個固定點。實測值（逐字，來自本 task 自己的臨時腳本，不是憑印象）：

```
serializeInline(<em><code>code</code></em><em>text</em>).md
  === '*`code`*<!-- -->*text*'
```

帶一個殘留 comment node 或兩個殘留 comment node，輸出都跟上面這行**逐位元組相同**。

### Minor 1：`\*` 的假觸發，換成 regex —— 已處置，regex 自己先驗證過

原本的守衛只看 `out` 最後一個字元是不是 `*`，分不清「活的定界符」跟「`escapeText()` 已經
轉義過的字面星號」。文字節點 `'a*'`（使用者字面打了一個星號，沒有斜體意圖）緊接著一個 EM，
修正前的天真判斷會誤觸發——而且這個假觸發**比真的 bug 更常見**（打一個字面星號再切換斜體，
比兩個標記真的黏在一起自然得多）。

換成 reviewer 給的 regex，**自己先驗證過**（獨立的臨時腳本，12 組手構造的形狀，涵蓋 0／1／
2／3 個反斜線的各種奇偶組合、空字串、單一星號、雙星號結尾），全部符合預期（逐一列在
`/tmp/claude-.../scratchpad/regex_probe.js` 的輸出裡，這裡摘要）：

```
/(?:^|[^\\])(?:\\\\)*\*$/
```

| 輸入字串（實際字元） | 預期「結尾是活的星號？」 | 結果 |
|---|---|---|
| `x*` | 是 | OK |
| `x\*`（1 個反斜線轉義星號） | 否 | OK |
| `x\\*`（2 個反斜線＝1 個字面反斜線，星號仍活） | 是 | OK |
| `*`（開頭就是星號） | 是 | OK |
| ``（空字串） | 否 | OK |
| `\*` | 否 | OK |
| `\\*` | 是 | OK |
| `\\\*`（3 個反斜線＋星號） | 否 | OK |
| `a**`（雙星號結尾） | 是 | OK |
| `a\**`（轉義星號＋活星號） | 是 | OK |
| `` `code`* ``（真實 EM/CODE 邊界） | 是 | OK |
| `a\\`（結尾是轉義反斜線，沒有星號） | 否 | OK |

再用真實的 `serializeInline()` 跑過三個場景（`test/inline-md.test.js` 的 "review Minor 1"
區塊釘住這些，實測值逐字）：

```
serializeInline(<p>a*<em>x</em></p>).md === 'a\\**x*'      // 不觸發守衛，且本來就 round-trip 正確
marked.parseInline('a\\**x*') === 'a*<em>x</em>'            // 驗證：字面星號 + 真斜體，語意正確
serializeInline(<p>a\*<em>x</em></p>).md 不含 '<!-- -->'    // 反斜線也被逃脫的情況同樣不誤觸發
serializeInline(<em><code>code</code></em><em>text</em>).md 仍含 '<!-- -->'  // 真的 bug 仍然被守住（regex 正例）
```

### 四支測試（改完後重跑，逐一 EXIT）

| 測試 | EXIT |
|---|---|
| `node test/inline-md.test.js` | 0 |
| `node test/paste-md.test.js` | 0 |
| `node test/roundtrip.test.js` | 0 |
| `node test/byte-stability.test.js` | 0 |

沒有跑 `npm test` 或 puppeteer 那三支，沒有碰 `test/editor-client-runtime.test.js`，沒有派
子 agent。
