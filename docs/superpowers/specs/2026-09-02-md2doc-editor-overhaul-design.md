# md2doc 編輯器整修設計（2026-09-02）

## 背景與目標

`md2doc --edit` 在 v3.0.0 之後，使用者回報了六類問題：

1. ⠿ 選單的圖示與文字沒有對齊（主選單有圖示、「轉換成」子選單沒有，兩層文字不在同一條垂線上）。
2. 表格左側的列 grip 不在表格邊框上（表格上緣的欄 grip 位置正確，兩軸不對稱）。
3. 部分 block 的 ⠿ 選單沒有「MD 原始碼」選項。
4. 清單項目在編號項底下縮排後，Shift+Tab 一次就再也無法 Tab 回去。
5. 各種操作反應慢、不即時。
6. 沒有可見的工具列，只能靠捷徑，而捷徑常按錯。

使用者另外提出兩個方向性需求：源頭 markdown 檔變動時要即時反映到編輯畫面；編輯的每個改動要即時反映回 markdown（Notion 式），同時保留 undo/redo，並且工具列要看得見。

參考對象是 VS Code 的 Office Viewer 擴充（`cweijan/vscode-office`，其 markdown 編輯器由 [Vditor](https://github.com/Vanessa219/vditor) 驅動）。使用者明確指出 `md2doc --edit` 的目的就是取代該擴充的缺點——尤其是「什麼都不改直接存檔就產生上千行 diff」（表格被重排欄寬、`-` 補到等寬）。

本設計涵蓋全部六類問題、兩個方向性需求，以及從參考對象比對後追加的四個項目。

---

## 根因分析

### 反應慢

每一次提交都走 `rerenderAll()`（`lib/editor/client.js:819`）：

1. `POST /api/render`，送出**整份文件**；
2. server 端 `renderMarkdown()` 重新解析全文；
3. 回來後 `contentEl.innerHTML = j.bodyHtml`，**整個 `.content` 子樹被換掉**；
4. 接著 `armEditables()` 全部重綁、`__md2docInitDiagrams()` 讓**所有 Mermaid 與 WaveDrom 圖從零重畫**（`data-processed` 標記隨舊 DOM 一起被丟棄）、reader 的 IntersectionObserver 重綁、捲動位置還原、區塊選取重建。

此外 `inlinedAssetCache`（`lib/md2doc.js:356`）宣告在 `renderMarkdown()` 函式內，所以每次 render 都會重新讀檔並重新 base64 每一張本地圖片。

以 17 KB 純文字文件實測，server 端 render 僅 8 ms。瓶頸不在 markdown 解析，而在全量 DOM 置換、圖表全部重畫，以及含 base64 的巨大回應內容。

### 源頭 markdown 變動不會反映

`lib/editor/server.js` 完全沒有檔案監看、SSE 或任何推送機制。這是尚未實作的功能，不是壞掉的功能。

### Tab 卡死

`indentListItem()` 開頭有 `if (self.listStart) return false;`。

重現路徑：文件為 `1. XXX` 加上縮排的 `- OOO`。對 `- OOO` 按 Shift+Tab 後，它落到 indent 0，成為接在 `ol` 之後的 `ul`，於是被判定為新清單的 `listStart`，該行守衛從此永久拒絕 Tab。

該守衛的註解說明它要防的是「把兩個清單合併」，但真正需要防的情況（前一個 block 不是清單項）已由 `clampIndents()` 的 `boundAt()` 回傳 `0` 擋住。這是一道擋錯對象的重複閘門。

### 部分 block 沒有「MD 原始碼」

`toggleGutterMenu()` 中：`gutterMenuMd.hidden = (blockType === 'li') || mdMultiSelected;`

清單項被永久排除，理由（程式碼中的 RULING F-O）是 `openRawEditor()` 把 block 的 `innerHTML` 換成 `<textarea>`，而 `restore()` 必須從字串重建 marker、checkbox、文字這一整套結構。多選時隱藏的理由則是該功能只作用於單一 block，對 N 個 block 是騙人的。

### 表格列 grip 不在邊框上

S4 T1 刻意將列 grip 從騎在表格左邊框上的 `[tableLeft-10, tableLeft+10]` 改成完全位於表格內的 `[tableLeft, tableLeft+20]`，原因是騎在邊框上時會覆蓋 ⠿ 右側 6 px 並贏得命中測試（grip 是 `position: fixed`、`z-index: 7`、掛在 `document.body` 上）。表格上緣的欄 grip 沒有這個衝突，因此仍騎在邊框上——兩軸的不對稱是那次修正的代價，不是意外。

### 沒有工具列

編輯器已具備 Vditor 約七成的能力，但全部散落在三個彼此獨立的隱藏入口：⠿ 選單、＋ 選單、選取文字才浮現的格式列。使用者抱怨的「捷徑常按錯」，成因不是捷徑壞掉，而是除了捷徑沒有別條路。

### 表格序列化會製造多餘 diff

`lib/editor/table-md.js` 的註解明載其發射形式為「minimal form」：`| a | b |` 單空格 padding、`|---|` 分隔列不加 padding、**破折號永不拉長到內容寬度**。

因此手工對齊過的表格，只要修改任何一格，整張表都會被壓成最小形式，該表每一行都是 diff。

這比 Office Viewer 好——後者的模型是「整份文件讀進記憶體、存檔時整份重新序列化」，所以沒改任何東西也會產生全文 diff；md2doc 的 `lineops.js` 只重寫被編輯 block 的那幾行，`test/byte-stability.test.js` 就是守這條不變量。但仍未達到零多餘 diff。

**自動存檔會放大這個問題**：目前必須主動存檔才落地，改成停手即寫之後，「碰一格髒整張表」會從偶發變成每次。因此表格欄寬保留必須排在自動存檔之前上線。

---

## 已確認的設計決策

| 決策點 | 選擇 |
|---|---|
| 本輪範圍 | 全部修整到位（六類問題 + 兩個方向性需求 + 四個追加項目） |
| 編輯寫回 markdown 的層級 | debounce 自動存檔到磁碟 |
| 反應慢的解法 | 增量 patch（server 回傳 `parts[]`，client 只置換有變動的節點） |
| 工具列範圍 | Vditor 核心子集，23 顆，統一入口；既有入口全部保留 |
| 追加項目 | 表格欄寬保留、貼上處理、圖片拖放自動存檔、全文原始碼逃生口（四項全收） |
| 「grip 沒對齊」所指 | ⠿ 選單的圖示與文字（子選單缺圖示） |
| 表格 grip 修法 | gutter 兩顆鈕全域左移，grip 騎回邊框（位移量見 §5 修正 2） |
| 清單項原始碼編輯範圍 | 只有該清單項自己那一行 |
| 外部變更的處理 | 分活處理：未編輯的 block 直接套用，正在編輯的暫緩 |

---

## §1 資料流總覽

現行（一條路徑，全量）：

```
手勢 → DOM 就地編輯（burst）→ 序列化 → lines[]
     → POST /api/render（整份）→ 整片 innerHTML 換掉
     → 全部重綁 + 所有圖表重畫 + 捲動還原 + 選取重建
```

改後（一條 patch 路徑，兩個來源）：

```
手勢 → DOM 就地編輯（burst）→ 序列化 → lines[]
                               ├→ POST /api/render → parts[] ─┐
                               └→ debounce 500 ms → /api/save  │
                                                               ├→ patchRender()
磁碟被外部改動 → fs.watch → 非自己寫的 → SSE → lines[] 更新 ──┘   只換有變的節點
```

關鍵性質：編輯與外部變更走**同一條** patch 路徑，不是兩套實作。

---

## §2 增量 render

### Server 端

`lib/md2doc.js:923` 現行為 `bodyHtml = parts.join('\n')`，其中每個 part 恰好是一個頂層 `.ed-block`（清單會展開成多個 block，但仍是同一個 part）。改為兩者都回傳：

```js
return { bodyHtml, parts, blocks };
```

`/api/render` 回傳 `{ parts, blocks }`。`bodyHtml` 保留給首次載入與非編輯模式使用。

### Client 端 `patchRender(newParts, newBlocks)`

1. 保存上次的 `lastParts`。
2. 逐項比對。長度相同時只需線性掃描；長度不同時跑一次簡化 LCS，找出 insert / delete / replace。
3. **replace**：`node.outerHTML = newParts[i]`，只有該節點被重建。
4. **insert / delete**：在對應位置插入或移除節點。
5. 對每個新建或被置換的節點呼叫 `armEditables(node)` 與 `__md2docInitDiagrams(node)`。
6. **未變動的節點完全不碰**——游標在其中就仍在其中，SVG 保留，捲動位置不需還原。

### 三個順帶解決的問題

- **Mermaid 不重畫**：`data-processed="true"` 跟著未被置換的節點保留，`__md2docInitDiagrams()` 的 pending 篩選自然跳過。
- **WaveDrom 不重畫**：現行程式碼已將處理完的 `script[type="WaveDrom"]` 改標為 `WaveDrom-done`，`ProcessAll()` 雖無法限定範圍，但只會撿到新的節點。
- **圖片不重複 base64**：`inlinedAssetCache` 從函式內提升到模組層，key 使用 `(絕對路徑, mtime)`。跨 render 共用，圖片檔異動時仍會失效重讀。

### Fallback

`rerenderAll()` 不刪除，降級為 fallback：首次載入，以及 patch 對不上時（`parts` 數量與 DOM 子節點數不一致）走它。這既是安全網，也讓既有測試有得對照。

### Teardown 縮窄

`rerenderAll()` 目前無差別歸零 `activeEditor`、`pristineInsert`、`currentBurst`、gutter 選單、insert 選單、表格 grips、選取工具列、block drag。改為**只對被置換或移除的節點**歸零——patch 已知哪些節點消失，逐一比對這些狀態指向的節點是否在其中。

這是本輪最耗時的單一項目：`test/editor-client-runtime.test.js`（21962 行）中針對「整片換掉之後必須歸零」撰寫的案例需要遷移為「只有相關節點被換掉時才歸零」。**遷移不是刪除**——那些案例守的規則仍然成立，只是條件變窄。

---

## §3 雙向即時同步

### 3a 出向：自動存檔

`lines[]` 每次變動後排一個 500 ms 的 debounce，到期呼叫 `POST /api/save`。

- 存檔狀態指示置於工具列右側：`已同步` / `儲存中…` / `存檔失敗（重試）` / `外部已更新`。
- 現有的 `setDirty()` 語意從「有未存變更」改為餵這個指示。
- **`baseMtimeMs` 守衛保留**。自動存檔下，client 手上的 base 由 server 每次存檔的回應更新；仍撞到 409 代表監看沒接到（見 3b 的 WSL 限制），改走 3c 的衝突橫幅。
- session 開始時寫一次 `<file>.md2doc.bak`（原始內容，只寫一次、絕不覆蓋）。這是自動存檔的安全網。

### 3b 入向：檔案監看與 SSE

新端點 `GET /api/events?fileId=N`，`Content-Type: text/event-stream`。

**自我回音抑制**（缺少它會造成無限迴圈）：server 每次自己寫檔後記下該內容的 hash。監看事件進來時先讀檔算 hash，等於上次自己寫的就丟棄。使用內容 hash 而非 mtime——外部工具可能寫入完全相同的內容，mtime 會變但不該觸發刷新。

**server 直接把 render 結果一併推送**：`{ type: 'external', content, parts, blocks }`。server 本來就得 render 才知道 parts，讓 client 再打一次 `/api/render` 是多餘的往返。

**WSL 限制與 fallback**：WSL2 對 `/mnt/` 底下由 Windows 程式造成的變更不會送出 inotify 事件。因此路徑以 `/mnt/` 開頭時改用 `fs.watchFile` 輪詢（間隔 1 s），其餘使用 `fs.watch`。這個判斷只寫在一處。

### 3c 分活套用

外部變更進來時：

1. 算出哪些 part 有變（與 §2 共用同一個 diff）。
2. **正在編輯的 block**（`currentBurst.blockEl` 或 `activeEditor` 指向者）從 patch 集合中扣除，記入 `pendingExternal`。
3. 其餘節點直接 patch——使用者會看到那幾行自行更新，游標不動。
4. burst 結束時（blur / Enter / Escape）處理 `pendingExternal`：
   - 使用者**未修改**該 block → 直接套用。
   - 使用者**已修改**且外部也改了同一個 block → 顯示橫幅二選一：`保留我的` / `用檔案的`。判斷依據為三方比對：上次同步的版本、外部版本、使用者版本。

---

## §4 工具列

### 視覺與位置

整組沿用 `.lightbox-bar`（`lib/md2doc.js:1919`）的視覺語言：深色半透明底、`min-width: 32px; height: 28px` 的 pill 按鈕、`is-active` 使用 `rgba(147, 197, 253, .35)` 底色加藍色 inset 邊框。新增 class `.ed-toolbar`，共用同一組數值。

位置為 `position: sticky; top: 0`，貼在 `.content` 上緣，不佔 sidebar 寬度。

### 23 顆按鈕與接線

```
undo · redo | headings▾ · quote · code · line
| bold · italic · strike · inline-code · link
| list · ordered-list · check · outdent · indent
| table · image · insert-before · insert-after
| outline · preview · export▾          [右側：存檔狀態]
```

| 按鈕 | 接到 |
|---|---|
| `undo` `redo` | 既有的文件級 undo/redo 路徑（目前僅綁 Ctrl+Z / Ctrl+Y） |
| `headings▾` | `changeHeadingDepth()`（`client.js:1774`）與 `convertBlockViaMenu()`（`client.js:2981`） |
| `quote` `code` `list` `ordered-list` `check` | `convertBlockViaMenu()`，底層走 `convert-md.js` |
| `line` | 新寫：`insertBlockBelow(blockEl, 'hr')`，＋ 選單一併補上這個 kind |
| `bold` `italic` `strike` `inline-code` `link` | 浮動選取列 `.ed-seltb` 已在使用的格式化路徑 |
| `outdent` `indent` | `indentListItem()` 與對應的 outdent |
| `table` | `insertBlockBelow(blockEl, 'table')` |
| `image` | 新寫：接 §5 追加項目 3 的資產端點 |
| `insert-before` `insert-after` | `insertBlockBelow()`（before 為新增的方向參數） |
| `outline` | 切換左側 TOC sidebar（`sidebar-toggle` 已存在） |
| `preview` | 三態切換：編輯 ⇄ 原始碼 ⇄ 預覽（見 §5 追加項目 4） |
| `export▾` | PDF / HTML，接 CLI 既有的匯出路徑 |

### 狀態同步

`is-active` 在游標移動時更新（`selectionchange` 與 `focusin`），節流 100 ms。當前 block 是 H2 時亮起 `headings▾` 並顯示 `H2`；在清單中則亮起 `list` 或 `ordered-list`。

### 既有入口

⠿ 選單、＋ 選單、浮動選取列**全部保留不動**。工具列是多一條路，不是取代。

---

## §5 六個修正與四個追加項目

### 修正 1 — ⠿ 選單圖示對齊

- `MENU_ICON_PATHS`（`client.js:2013` 上方）擴充：`paragraph`、`h1`–`h6`、`quote`、`code`、`list`、`ordered-list`、`check`、`table`。
- `openConvertSubmenu()` 建立的每一顆按鈕都掛上 `menuIconMarkup()`。子選單的按鈕本來就吃 `.ed-handle-menu-btn`，補上圖示後兩層文字自然落在同一條垂線上。
- `.ed-handle-menu-btn` 的 `padding: 0 10px` 改為 `0 10px 0 6px`（符號靠左），`gap: 8px` 改為 `4px`（一個空格寬）。

### 修正 2 — 表格列 grip 回騎邊框

`editModeLayoutCss` 三處位移加一個 token 回退：

```
.ed-insert   left: -40px → -50px
.ed-handle   left: -22px → -32px
列 grip      [tableLeft, +20] → [tableLeft-10, +10]
--ed-te-cell-pad-left   移除，第一欄 padding 回到預設 14px
```

位移量取 10 px 而非 6 px，是為了保住 `--ed-gutter-gap` 那 4 px 的呼吸空間：兩顆鈕各寬 18 px，⠿ 的右緣落在 `tableLeft-14`，grip 的左緣在 `tableLeft-10`，中間仍有 4 px。取 6 px 的話兩者會恰好接壤、零間隙，滑鼠差一個像素就會點到另一個——這正是 spec §4.2 當初寫下那 4 px 的原因。

`.content` 在編輯模式的左 padding 為 56 px，`＋` 的左緣落在 -50 px，仍在範圍內（餘 6 px）。

**實作時必須先量測再改**：上述數值是從程式碼註解記錄的既有幾何推導出來的，不是實測值。實作第一步應在 1400x900 下對真實編輯頁跑一次 `elementFromPoint()`，確認 ⠿、＋、grip 三者的實際佔位與這裡的推導一致，再套用位移。若 `.page-layout` 的左 padding 讓 `＋` 落到負的視窗座標，改採只位移 6 px 並接受零間隙。

### 修正 3 — Tab 卡死

`indentListItem()` 刪除 `if (self.listStart) return false;` 這一行。

安全性理由：它要防的「前一個 block 不是清單項卻硬縮排」，`clampIndents()` 的 `boundAt()` 已回傳 `0` 擋住——indent 被夾回原值、函式回傳 `false`、不提交。

### 修正 4 — 清單項的 MD 原始碼

- `gutterMenuMd.hidden = (blockType === 'li') || mdMultiSelected;` 的**兩個條件都移除**。
- 清單項：textarea 內容為該清單項那一行（含縮排與 marker），提交走既有的 `commitRangeEdit()`。
- restore 不再從字串重建結構——走 §2 的 patch，向 server 索取該 block 的新 HTML。
- **多選時也顯示**，編輯範圍為選取的整個行範圍。原本隱藏的理由是「它只答一個 block、對 N 個 block 是騙人的」；改為編輯整段行範圍之後，該理由消失。

### 修正 5 — 反應慢

見 §2。

### 修正 6 — 沒有工具列

見 §4。

### 追加 1 — 表格欄寬保留

`serializeTable()` 增收一個參數：被置換掉的那幾行原始文字。

- 從原始分隔列讀回每欄的 `-` 數量與冒號位置。
- 從原始資料列讀回每欄的 padding 寬度。
- 重新發射時沿用；欄數變動時，仍存在的欄保留原寬度，新欄使用 minimal form。
- 原始表格本來就是 minimal form 時，行為與現行完全一致。

### 追加 2 — 貼上處理

- `paste` 事件：clipboard 含 `text/html` 時轉成 markdown，當原始碼插入。
- `Ctrl+Shift+V` 只取 `text/plain`。
- HTML 轉 markdown 使用 `turndown`（**新增相依**；成熟、無自身相依、約 30 KB）。自行撰寫大約需要 400 行，且仍蓋不全從 Word 貼過來的巢狀表格。

### 追加 3 — 圖片拖放與貼上

- 新端點 `POST /api/asset`：`{ fileId, filename, dataBase64 }`，寫入 markdown 同目錄的 `assets/`，回傳相對路徑。
- drop 或 paste 帶有圖片時上傳，並插入 `![](assets/xxx.png)`。
- 工具列的 `image` 按鈕開啟檔案選擇，接同一條路徑。
- render 端的 base64 內嵌不需修改，它本來就吃相對路徑。

### 追加 4 — 全文原始碼逃生口

不另加按鈕，併入 `preview` 成為三態切換：編輯 ⇄ 原始碼 ⇄ 預覽。整份文件一個 textarea，離開時 `lines[]` 全數置換再走 patch。

---

## §6 測試策略與交付順序

### 測試策略

沿用既有基準：**一律 RED-first；mutation-kill 只加在會破壞資料的路徑上。**

需要 mutation-kill 的路徑：表格欄寬保留、貼上轉換、自動存檔 debounce、分活套用的三方比對、清單項原始碼提交。

純 UI 與 CSS 的項目（修正 1、修正 2、工具列版面）只需 RED-first，不加 mutation-kill。

新增測試檔（每個都必須加進 `package.json` 的 `test` script）：

- `test/patch-render.test.js`
- `test/sync.test.js`
- `test/toolbar.test.js`
- `test/paste.test.js`
- `test/asset.test.js`
- `test/table-width.test.js`

需要遷移的既有測試：`test/editor-client-runtime.test.js` 中針對「整片換掉後必須歸零」的案例，改為「只有相關節點被換掉時才歸零」。

### 交付順序

| 版本 | 內容 | 理由 |
|---|---|---|
| **v3.0.1** | 修正 1、2、3 加上追加 1（表格欄寬保留） | 全為點狀改動，不碰架構，可立即使用。表格欄寬**必須**排在自動存檔之前——否則 v3.1.0 上線後「碰一格髒整張表」會從偶發變成每次 |
| **v3.1.0** | §2 增量 render、修正 4、§3 雙向同步 | 核心。修正 4 與 §3 都依賴 §2 的 patch 路徑，綁在一起實作 |
| **v3.2.0** | §4 工具列、追加 2、追加 3、追加 4 | 工具列的 `is-active` 依賴 §2、存檔狀態指示依賴 §3，必須排在最後 |

四個追加項目全數實作，只是分三次出貨。v3.0.0 耗時過久的教訓是一次推太大、中間沒有可用的產出。

### 發布流程

依 `CLAUDE.md`：從乾淨的 main 執行 `npm version <patch|minor>`，推 main 再推 tag，由 `.github/workflows/publish.yml` 自動發布到 npm。不手動執行 `npm publish`。

---

## 不變量（本輪任何改動都不得破壞）

1. **未編輯的內容必須 byte-identical**。`lineops.js` 的 `replaceLines()` 只重寫被編輯 block 的那幾行；`test/byte-stability.test.js` 守這條。§2 動的是 DOM 顯示路徑，不是 `lines[]` 的寫入路徑，因此不影響此不變量。
2. **`--ed-gutter-*` 系列 token 只寫一次、由它們衍生其他數值**。修正 2 改的是 token 值，不是新增第二處字面量。
3. **⠿ 與 ＋ 不得掛上各自的 addEventListener**。`openRawEditor()` 的 `restore()` 會從字串重新解析 block 的 `innerHTML`，直接掛在節點上的 listener 會靜默消失。既有的委派式 listener 模式必須維持。
4. **`serializeBlocks()` 的 `unsupported` 拒絕機制不得繞過**。工具列與新的原始碼編輯路徑都必須經過同一組閘門。

---

## 已知限制

- WaveDrom 的 `ProcessAll()` 沒有限定範圍的 API，仍會掃描整份文件。因為已處理的節點會被改標為 `WaveDrom-done`，實際只會處理新節點，但這是靠標記而非 API 保證。
- 若一次編輯引入了頁面載入時不存在的圖表類型（例如原本沒有任何 `mermaid` 圍欄的文件新增了第一個），該類型的函式庫全域變數尚未載入，該 block 會維持原始標記直到重新載入頁面。此為 v3.0.0 既有限制，本輪不處理。
- `/mnt/` 底下的檔案改用輪詢監看，外部變更的反映延遲最高 1 秒。
- 文件級 undo/redo 的進入點在本設計中尚未定位到確切函式名。已確認的是 burst 層的 `burstUndo()` / `burstRedo()`（`lib/editor/client.js:5071` / `5095`）在 burst 內的歷史耗盡後會往外串接到文件級的 `UndoStack`（`lib/editor/lineops.js`）。實作第一步須先找出該串接點，工具列的 undo/redo 接同一處，不得另開第二條路徑。
