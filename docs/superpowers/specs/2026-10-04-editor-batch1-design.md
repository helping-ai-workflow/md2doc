# 編輯器改版 批 1：外觀與深色（v3.10.0）

日期：2026-10-04
來源：2026-10 編輯器逐項審查 E1–E10（每項皆經使用者以 artifact 比較後定案）
本文件只涵蓋批 1。批 2（打字與插入，v3.11.0）、批 3（程式碼圖表與手機，v3.12.0）各自另寫規格。

## 1. 目標

讓 `md2doc --edit` 的外觀與閱讀頁成為同一套：白紙底、同一個強調色、同一組深淺主題、同一套線條圖示，並移除不好用的整份原始碼模式。完成後：

- 編輯模式可以切深色，所有編輯器元件（含波形編輯器）都跟著換色，沒有半套主題的畫面。
- 工具列、選單、選字工具列換成白底細環＋Lucide 線條圖示。
- 存檔狀態看得到；錯誤與提示分兩級。
- 程式碼區塊有語法上色（閱讀頁、PDF、編輯器）。
- 清單符號與待辦樣式在閱讀頁與編輯器一致。

成功標準：第 9 節的測試全綠，且 `npm run test:browser` 在 Chromium 與 WebKit 兩個引擎、桌面與手機兩種寬度下通過新加的編輯器點擊檢查。

## 2. 範圍

### 批 1 要做

| 審查項 | 內容 |
|---|---|
| E1 | B 淺色紙面外觀、深色模式開放給編輯模式、Lucide 圖示、強調色統一、拿掉 hover 虛線框、波形編輯器換 token 外觀 |
| E2 | 工具列右側存檔狀態、💾 有變更時亮起、訊息分兩級（錯誤卡片／提示小框）、英文訊息改中文 |
| E4（部分） | ⠿ ＋ 對齊第一行文字、24×24 點擊區、16px 圖示 |
| E5（部分） | 選字工具列 6 顆換圖示、連結前分隔線 |
| E6（部分） | 編輯器項目符號逐層變化、核取框 16px＋勾號、勾選後文字變淡＋刪除線（閱讀頁同步）、修閱讀頁待辦雙重符號 |
| E8（部分） | 語法上色（highlight.js，GitHub 配色） |
| E10 | 移除整份原始碼模式；沒有未存變更時磁碟檔被改就自動重新載入 |

### 不在批 1

- 批 2：E3 打字行為與「/」選單、＋ 開「/」、Ctrl+K 網址欄與連結小卡、鬆散清單可編輯、表格直式選單與尾端長條。
- 批 3：程式碼原地編輯、圖表原始碼＋預覽、圖片小工具列、手機頂列與鍵盤上方工具列。
- 待辦（另開審查）：波形編輯器介面重新設計。批 1 只換它的顏色 token，不動它的版面與操作。
- 原始碼上色：不做（highlight.js 的 markdown 會把 snake_case 底線誤判成斜體，實測整片變斜體）。

## 3. 深色開放到編輯模式（E1 地基）

### 3.1 現況

- `lib/md2doc.js` 的 `renderMarkdown` 尾端：`if (!opts.editMode && !opts.noTheme) bakedHtml = applyReaderTheme(bakedHtml);` — 編輯模式不跑主題 post-pass，註解寫明「Edit mode is light-only」。
- `lib/theme/tokens.js` 的 `SKIP_SELECTOR = /(^|[\s,>+~(])(html\.ed-|\.ed-|\.lightbox)/` — 選擇器含 `.ed-` 的規則一律不改寫。
- 編輯器 CSS：閱讀頁 `<style>` 裡 94 條 `.ed-*` 規則（29 種顏色常值、91 處），加上 `editModeLayoutCss`（797 行，多為 `.ed-wave-*`；41 種常值、94 處）。

### 3.2 設計

1. 編輯模式也呼叫 `applyReaderTheme`（`noTheme` 的 light-lock 測試照舊）。
2. `SKIP_SELECTOR` 拿掉 `html\.ed-` 與 `\.ed-`，只留 `\.lightbox`（燈箱本來就是深色）。
3. 編輯器的每一個顏色常值都必須屬於 `THEME_TOKENS` 的某個角色或 `KEEP_LITERALS`；`test/reader-design.test.js` 的 allow-list 檢查自動延伸到 `.ed-*` 規則，不需要新機制。
4. 新增的角色以 `ed-` 開頭，集中成一段，避免和閱讀頁角色混淆。初版角色（淺 / 深）：

| 角色 | 用途 | 淺 | 深 |
|---|---|---|---|
| `ed-chrome` | 工具列底（不叫 `ed-bar`：`test/editor-client.test.js` 以子字串禁止 client.js 出現 `ed-bar`） | `#ffffff` | `#1b1b1d` |
| `ed-surface` | 選單、選字工具列、卡片 | `#ffffff` | `#2a2a2d` |
| `ed-ring` | 選單細環（box-shadow 第一層） | `rgba(31,35,40,.12)` | `rgba(255,255,255,.10)` |
| `ed-shadow` | 選單陰影（第二層） | `rgba(31,35,40,.10)` | `rgba(0,0,0,.55)` |
| `ed-hover` | 按鈕 hover 底 | `#f3f5f7` | `#303134` |
| `ed-glyph` | ⠿ ＋ 等低調圖示 | `#8c959f` | `#7d8086` |
| `ed-field` | 原始碼框、輸入欄底 | `#f6f8fa` | `#232325` |
| `ed-sel` | 多選底色 | `rgba(9,105,218,.10)` | `rgba(110,168,245,.16)` |
| `ed-range` | 表格範圍選取 | `rgba(9,105,218,.14)` | `rgba(110,168,245,.20)` |
| `ed-err` / `ed-err-bg` / `ed-err-ink` | 錯誤卡片 | `#cf222e` / `#ffebe9` / `#82071e` | `#ff8a8a` / `#3a2224` / `#ffc9c9` |
| `ed-ok` | 「已儲存」勾號 | `#1a7f37` | `#6fdd8b` |
| `ed-dirty` | 「未儲存」圓點 | `#9a6700` | `#e3b341` |

強調色、文字、淡字、分隔線直接沿用既有角色 `accent`、`fg`、`muted`、`rule`、`active-bg`、`active-fg`。波形編輯器的 41 種常值逐一歸類：能對到既有或上表角色的歸過去，其餘（波形筆刷的語意色，例如 `#d8ead3` 綠、`#f7d6e4` 粉）新增 `ed-wave-*` 角色並給深色值。實作計畫要附一張「常值 → 角色」的完整對照表，不留未歸類。

5. 深色值的對比：文字類角色在對應底色上 ≥ 4.5:1，圖示與邊框 ≥ 3:1，以 `test/theme.test.js` 既有的對比計算函式驗證。

### 3.3 切換鈕

- 桌面：沿用閱讀頁的右下泡泡（`TOGGLE_HTML`），編輯模式同樣顯示。
- 手機：閱讀頁手機版把切換鈕放進 `.mobile-bar`，但編輯模式隱藏了 `.mobile-bar`。批 1 先在手機也顯示右下泡泡；批 3 的手機頂列再把它收進頂列。
- 偏好鍵沿用 `md2doc-theme`，閱讀頁與編輯頁共用。

## 4. 編輯器外觀（E1）

- 工具列：白底（`ed-chrome`）＋底部 1px `rule`，拿掉深色膠囊。按鈕 32×32、無框、圓角 6px；hover `ed-hover`；pressed `active-bg`＋`active-fg`；disabled 透明度 .38 不變。分隔線 1px×20px `rule`。
- 選單（⠿ 選單、轉換成子選單、＋ 選單、H▾ 選單、表格選單）與選字工具列：`ed-surface` 底、圓角 8px、`box-shadow: 0 0 0 1px ed-ring, 0 8px 24px ed-shadow`，按鈕無框。
- 圖示：Lucide v0.469.0（ISC），只收用到的約 30 個，存成 `lib/editor/icons.js`（name → SVG 字串，含授權註記）。`toolbar-model.js` 的 `icon` 欄改成圖示名稱，`label`／`title` 不變。⠿ 用 `grip-vertical`、＋ 用 `plus`。
- 強調色：所有 `#3b82f6` 系（聚焦外框、游標、多選、範圍選取、拖放指示線、核取框、表格 ＋ 泡泡）改用 `accent` 角色；鍵盤導覽外框 `#6ea8fe` 也改 `accent`。
- 拿掉 `.ed-block:hover { outline: 1px dashed #b0b0b0 }`。
- MD 原始碼框（單一區塊的 `.ed-raw`）：`ed-field` 底、`rule` 框、字型改用閱讀頁程式碼字型（Cascadia Mono／Consolas），完成／取消鈕改成同一套按鈕樣式。

## 5. 存檔狀態與訊息（E2）

### 5.1 存檔狀態

維持手動存檔（Ctrl/Cmd+S 或 💾）。工具列右側狀態欄改顯示存檔狀態（原本顯示「編輯／原始碼」，原始碼模式移除後不再需要）：

| 狀態 | 顯示 |
|---|---|
| 沒有變更 | `✓ 已儲存`（勾號 `ed-ok`） |
| 有變更 | `● 有未儲存的變更 · Ctrl+S 儲存`（圓點 `ed-dirty`；Mac 顯示 ⌘S） |
| 儲存中 | `儲存中…` |
| 儲存失敗 | 紅字 `無法儲存`，並出錯誤卡片 |

💾 在有變更時套 pressed 樣式（`active-bg`＋`accent`）。分頁標題的「● 」保留。狀態欄有 `role="status"`。

### 5.2 訊息分兩級

`showBanner` 目前 47 個呼叫點（審查時說 62 是把註解裡的提及也算進去了）共用一條紅色橫幅。拆成兩個出口，但兩者都保留 `.ed-conflict` 基底 class（測試有 139 處以它找橫幅），以 `data-level="error|notice"` 區分外觀：

- `showError(message, actionLabel, onAction)`：會讓修改不見或沒套用的情況——磁碟衝突、存檔失敗（3 種）、修改沒套用（render failed 4 種）、手勢被丟棄（`DROPPED_GESTURE_MESSAGE`）、沒閉合的圍欄吞噬（`SWALLOW_MESSAGE`）。外觀：工具列下方置中卡片，`ed-err-bg` 底、左側 3px `ed-err` 條、圖示、訊息、動作鈕、✕；`role="alert"`；手動關閉。
- `showNotice(message)`：拒絕或說明類——含不支援的格式、清單結構無法調整、選取不連續、沒有選取、貼上表格太大、沒有自己的來源行等。外觀：底部置中的 `ed-surface` 小框＋資訊圖示，`role="status"`，4 秒後自動消失，滑過時暫停計時。

實作計畫要列出 47 個呼叫點各自歸哪一級；拿不準的歸 `showError`（寧可醒目）。既有依賴 `.ed-conflict` 的旗標（`activeBannerIsRefusal`、`activeBannerIsSwallow`、`activeBannerIsKeynavExit`）與 Esc 優先序要對應搬到新元件，行為不變。

### 5.3 文案

英文訊息改成中文，並講下一步：

| 情況 | 改寫 |
|---|---|
| 磁碟衝突 | 這個檔案剛在別處被修改。重新載入會帶入新內容，並捨棄你在這裡還沒儲存的變更。〔重新載入〕 |
| 存檔失敗（連線） | 無法儲存：連不到編輯伺服器。變更還在這個分頁裡，請稍後再按 Ctrl+S。 |
| 存檔失敗（回應格式） | 無法儲存：伺服器回傳的內容無法解析。變更還在這個分頁裡。 |
| 存檔失敗（其他） | 無法儲存：〈原因〉。變更還在這個分頁裡。 |
| 修改沒套用 | 這次修改沒有套用：〈原因〉。文件維持修改前的樣子。 |

（E2 選的是手動存檔，所以沒有自動重試。）

## 6. 區塊把手、選字工具列、清單（E4／E5／E6 部分）

- ⠿ ＋：按鈕 24×24、圖示 16px；垂直置中在區塊第一行文字（以第一個可編輯元素的 `line-height` 與相對位移計算，標題、段落、清單項各自正確）；水平位置由既有變數推得：`--ed-gutter-btn` 18→24px、`--ed-gutter-gap` 4→0px、`--ed-gutter-shift` 維持 10px，得到 ⠿ 在 -34px、＋ 在 -58px。
- 選字工具列：B I S U、行內程式碼、連結 6 顆，按鈕 30×30、圖示 16px，連結前 1px 分隔線；狀態樣式（pressed／mixed／inert）語意不變。
- 項目符號：編輯器 `ul` 依 `data-indent` 逐層 `•`、`◦`、`▪`，第 4 層起循環；顏色 `muted`。
- 核取框：16px、圓角 4px、1.5px `ed-glyph` 框；勾選時 `accent` 底＋白色勾號（CSS 背景 SVG）。
- 勾選後：該項文字 `muted`＋刪除線。編輯器與閱讀頁都套用。
- 閱讀頁待辦雙重符號：marked 產生的 `<li><input type="checkbox" disabled>` 仍帶項目圓點。修正為待辦項目不畫圓點，核取框改成跟編輯器同一個樣式（`appearance: none` 自繪），勾選後文字樣式同上。

## 7. 語法上色（E8 部分）

- 依賴：`highlight.js` 11.11.1（BSD-3-Clause），只 `require` core 與註冊語言，不打包全部語言。
- 註冊語言：verilog（含 SystemVerilog 關鍵字）、systemverilog 別名、python、bash/shell、c、cpp、json、yaml、tcl、makefile、javascript、diff、plaintext。未註冊或沒有標語言的區塊維持純文字（不做自動偵測，避免猜錯）。
- 位置：`renderer.code` 的預設分支（現在只做 HTML 跳脫、註解卻寫 syntax-highlighted），產生 HTML 時就上色，閱讀頁不需要額外 JS；PDF 由同一份 HTML 產生，一併有色。順手修正那句與程式不符的註解。
- 顏色：H1 GitHub 配色，以 `THEME_TOKENS` 角色表達（`syn-keyword`、`syn-number`、`syn-comment`、`syn-string`、`syn-type`、`syn-title`）：

| 角色 | 淺 | 深 |
|---|---|---|
| `syn-keyword` | `#cf222e` | `#ff7b72` |
| `syn-number` | `#0550ae` | `#79c0ff` |
| `syn-comment` | `#6e7781`（斜體） | `#8b949e`（斜體） |
| `syn-string` | `#0a3069` | `#a5d6ff` |
| `syn-type` | `#953800` | `#ffa657` |
| `syn-title` | `#8250df` | `#d2a8ff` |

- 編輯模式：批 1 的程式碼區塊仍點擊開 MD 原始碼框（原地編輯在批 3），但顯示時就是上色的；`/api/render` 回來的區塊同樣上色。
- 必須保證上色不改變 `textContent`：編輯器從 DOM 讀回 Markdown 的路徑（若有用到 code 區塊的 DOM 文字）不能被 `<span>` 影響。實作計畫要找出所有讀 `pre code` 文字的地方逐一確認。

## 8. 移除整份原始碼模式（E10）

### 8.1 移除

- `toolbar-model.js` 的 `preview` 按鈕（`M↓`／`✎`）拿掉，工具列 23 → 22 顆。依 CLAUDE.md「Changing a Count」先全 repo 搜尋 23 這個數與按鈕 id 集合（`TB_ROWS` 等完整性斷言），一併遷移。
- `client.js` 的 `enterSourceMode`、`leaveSourceMode`、`setDocMode`、`cycleDocMode`、`paintModeStatus` 與 `docMode` 狀態、`body[data-ed-mode]` 屬性、`textarea.ed-source` 及其 CSS、`body[data-ed-mode="source"]` 的 TOC／搜尋隱藏規則。
- 測試：`editor-journey.test.js`（39 處）、`toolbar-model.test.js`（10 處）、`detach-census.test.js`（1 處）裡跟原始碼模式相關的情境刪除或改寫；刪除前逐一確認該情境測的是原始碼模式本身，不是借道原始碼模式去測別的功能（若是後者，改用 ⠿ → MD 原始碼重寫，不得直接刪）。
- 「沒有自己的來源行」等指向原始碼的提示改成：「這一段請用文字編輯器修改，存檔後這裡會自動更新。」

### 8.2 磁碟檔被外部修改時

現況：只有按存檔時才會從 409 得知衝突；沒有未存變更時，畫面不會更新。

設計：

- `/api/ping`（現有、每 10 秒一次）以回應標頭 `X-Md2doc-Mtime` 帶回目前檔案的 `mtimeMs`（204 與 200 都帶）。不改回應主體：既有 25 處測試綁著「無 draw.io 變更時回空的 204」。
- 用戶端比對自己的 `baseMtimeMs`：
  - 不同且 `documentIsDirty()` 為假 → 重新載入文件內容並保留捲動位置（以目前閱讀線所在標題為錨），顯示提示小框「檔案在別處被修改，已重新載入。」
  - 不同且有未存變更 → 立刻顯示 5.3 的磁碟衝突錯誤卡片（不再等到存檔才發現）。
- 波形編輯器開著時不自動重新載入，只在關閉後再檢查一次。

## 9. 測試

### 9.1 單元／渲染（`npm test`）

- `theme.test.js` 與 `reader-design.test.js`：`.ed-*` 規則納入 allow-list 檢查；新角色的淺深對比門檻。
- 編輯模式輸出含主題 post-pass（`:root` 變數、切換鈕、早期腳本）。
- 語法上色：verilog 區塊輸出 `hljs-keyword` 等 span；未註冊語言輸出純文字；上色前後 `textContent` 相同；閱讀頁不含額外的上色 JS。
- 待辦清單：閱讀頁待辦項目沒有圓點；勾選項套 `muted`＋刪除線。
- 原始碼模式移除：輸出不含 `ed-source`、`data-ed-mode`；工具列 22 顆。
- `/api/ping` 回應帶 `X-Md2doc-Mtime` 標頭，204 仍無主體。

### 9.2 編輯器點擊檢查（`npm run test:browser`）

新檔 `test/editor-click.test.js`，比照 `reader-click.test.js`：Chromium 與 WebKit、1440×900 與 390×844，以 DOM 幾何與計算樣式斷言，不比截圖。加進 `test:browser` script 與 `.github/workflows/browser.yml` 的觸發路徑（`lib/editor/**`）。至少涵蓋：

1. 編輯模式有切換鈕；點了之後 `data-md2doc-theme="dark"`，工具列、選單、選字工具列、MD 原始碼框、波形編輯器面板的背景色與文字色都改成深色值，且文字對比 ≥ 4.5:1（實測計算樣式）。
2. 工具列 22 顆按鈕都含 `svg`，沒有 emoji 字元；在 1440 寬全部可見。
3. ⠿ ＋ 的中心點落在第一行文字的垂直範圍內（段落、H1、H2、清單項各一），`elementFromPoint` 命中按鈕本身。
4. 選字工具列 6 顆、連結前有分隔線。
5. 有變更時狀態欄文字與 💾 pressed；Ctrl+S 後變「已儲存」。
6. 觸發一個提示類訊息（例如選取不連續）：底部小框出現、4 秒後消失、不在工具列下方；觸發存檔失敗（攔截 `/api/save` 回 500）：錯誤卡片出現、要按 ✕ 才關。
7. 核取框點擊切換、勾選後文字有刪除線；閱讀頁同樣的文件待辦項目沒有圓點。
8. 外部修改磁碟檔（測試直接寫檔）：無變更時 ≤ 12 秒內畫面更新；有變更時出現衝突卡片。

每個新情境都要確認真的出現在輸出裡（CLAUDE.md：「The test exists」不等於「the test ran」）。

## 10. 文件與發版

- `CLAUDE.md` 的「Dark Mode」一節：刪掉「edit mode is light-only」與 `.ed-` 跳過規則的敘述，改寫成新規則；「Editor Client」相關段落若提到原始碼模式一併更新。
- `CHANGELOG.md` 寫 v3.10.0：Added（編輯模式深色、語法上色、存檔狀態、外部修改自動重新載入）、Changed（外觀、訊息分級、清單樣式）、Removed（整份原始碼模式）。
- 版本：minor（v3.10.0），依 repo 的 Release Flow。

## 11. 風險

- **改寫範圍大**：約 70 種顏色常值、185 處使用要歸類。對策：計畫裡先產出完整對照表並由 allow-list 測試把關，漏一個就紅。
- **`.ed-` 規則被改寫後的副作用**：有些 `.ed-*` 規則可能刻意依賴固定淺色（例如波形畫布的對比假設）。對策：逐條檢查，需要固定的放 `KEEP_LITERALS` 並寫理由。
- **上色 span 影響編輯器讀回**：見 7 節最後一點。
- **移除原始碼模式的測試遷移**：見 8.1 的「先確認測的是什麼再刪」。
- **長測試套件與編輯同時進行**：依 CLAUDE.md，跑 `npm test` 期間不得有其他程序改同一個工作樹；實作在獨立 worktree 進行。
