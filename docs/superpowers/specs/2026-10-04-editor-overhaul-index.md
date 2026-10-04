# 編輯器改版總覽（2026-10）

`md2doc --edit` 的 Notion-like 改版。2026-10-04 逐項審查 E1–E10，每項都在 artifact 上把選項套到 mac-tx-core 真實編輯畫面（淺色＋深色）後由使用者定案。本檔是索引：定案、比較頁、分批、待辦。細節在各批規格。

## 規格

| 批次 | 檔案 | 版本 | 狀態 |
|---|---|---|---|
| 批 1 外觀與深色 | `2026-10-04-editor-batch1-design.md` | v3.10.0 | 待使用者審規格 |
| 批 2 打字與插入 | `2026-10-04-editor-batch2-design.md` | v3.11.0 | 待使用者審規格 |
| 批 3 程式碼、圖表、圖片、手機 | `2026-10-04-editor-batch3-design.md` | v3.12.0 | 待使用者審規格 |

順序固定 1 → 2 → 3；每批各自「規格 → 計畫 → 實作 → 發版」，並補 Chromium＋WebKit 編輯器點擊檢查。理由：深色一開放，所有編輯器元件（含波形編輯器）必須同時換色，否則出現半套主題（E8 實測波形編輯器在深色下白面板配深色輸入框）；批 1 風險最低、可單獨發版；批 2 的核心按鍵行為放在穩定的外觀之上做，回歸比較好判讀。

## 定案與比較頁

| 項目 | 定案 | 落在 | 比較頁 |
|---|---|---|---|
| E1 整體視覺 | B 淺色紙面：白底工具列與白底細環選單、Lucide 圖示、強調色統一 `#0969da`、拿掉 hover 虛線框；編輯模式開放深色（閱讀頁同一組 B Neutral），選單 `#2a2a2d` 浮起；桌面切換鈕沿用右下泡泡（使用者選 T2，我原推薦放工具列） | 批 1 | https://claude.ai/artifact/BZoLL88TS7cGvKK1rKz6rf |
| E2 存檔與訊息 | 維持手動存檔（使用者選 S1，我原推薦自動存檔），狀態欄「● 有未儲存的變更 · Ctrl+S 儲存／✓ 已儲存」、💾 有變更時亮；訊息分兩級：錯誤卡片（會丟修改，需手動關）＋提示小框（4 秒消失）；文案全中文並講下一步 | 批 1 | https://claude.ai/artifact/NPMcwoxzxkUtAkPKu2GfF7 |
| E3 打字手感 | 7 項全做：Enter 切段、段首 Backspace 合併、段首 Markdown 自動轉換、「/」選單、點空白處新增段落、空白文件即有空段落（使用者回報的缺陷）、空段落提示；「/」選單 M1 精簡單行 | 批 2 | https://claude.ai/artifact/FeuXLhZSkzEJt5nH38qio1 |
| E4 ⠿ 與 ＋ | 置中第一行、24×24；＋ 開同一份「/」選單（使用者：「＋的行為跟 / 應該一樣的表單，不需要額外設計一種顯示」），Alt＋點插上方 | 對齊：批 1；行為：批 2 | https://claude.ai/artifact/JABc8UEdrTDtgNJegGQQEC |
| E5 行內格式與連結 | 選字工具列 6 顆圖示；Ctrl+K 原地網址欄取代 `window.prompt`；貼網址即成連結；連結小卡；公式與上下標不做 | 圖示：批 1；連結：批 2 | https://claude.ai/artifact/GdtLpkTC3U7QVEj4hofFm4 |
| E6 清單與待辦 | 符號逐層 • ◦ ▪；核取框 16px＋勾號；勾選後變淡＋刪除線（閱讀頁同步並修雙重符號）；鬆散清單可直接編輯 | 樣式：批 1；鬆散：批 2 | https://claude.ai/artifact/V3XXcdnArMmWQ7UociY1Ej |
| E7 表格 | 直式欄／列選單（含插入、對齊三鍵、紅字刪除）；尾端 ＋ 長條；最後一格 Tab 新增列；格線泡泡保留 | 批 2 | https://claude.ai/artifact/AW8rGDqTBVeoiUFkd833Se |
| E8 程式碼與圖表 | 語法上色 H1 GitHub 配色（閱讀頁／PDF／編輯器）；程式碼原地編輯＋語言＋複製；Graphviz／Mermaid「編輯圖表」原始碼＋即時預覽；圖片小工具列；波形編輯器換 token 外觀；draw.io 不變 | 上色與波形外觀：批 1；其餘：批 3 | https://claude.ai/artifact/BvXYNen9hTwZVBJStNwhme |
| E9 手機 | M1：頂列精簡（復原、重做、大綱、深淺、存檔）＋鍵盤上方工具列＋底部區塊選單（含上移／下移） | 批 3 | https://claude.ai/artifact/Wuh6s6ANDbKAnhuw7P8tjD |
| E10 原始碼模式 | 完全移除（使用者：「不好操作」）；沒有未存變更時，磁碟檔被外部修改就自動重新載入；原始碼上色不做（highlight.js 會把 snake_case 底線誤判成斜體） | 批 1 | https://claude.ai/artifact/A29AM532yeXZdVvUbSbK3j |

## 審查中量到、各批要處理的事實

- 空白 md 開編輯模式是 0 個區塊，無法輸入（批 2）。
- 編輯模式完全沒有深色；強制設 `data-md2doc-theme` 也不變，因為 `renderMarkdown` 在 editMode 跳過 `applyReaderTheme`，且 `SKIP_SELECTOR` 排除 `.ed-`（批 1）。
- 編輯器 CSS 約 70 種顏色常值、185 處使用（批 1）。
- 47 個 `showBanner` 呼叫點共用紅色橫幅；衝突、存檔失敗、渲染失敗是英文（批 1）。
- 編輯器 `ul` 每層都是 `•`，閱讀頁逐層 ● ○ ■（批 1）。
- 閱讀頁待辦項目同時畫圓點與核取框（批 1）。
- 程式碼完全沒有上色，`lib/md2doc.js` 的 code renderer 註解寫 syntax-highlighted 但只做跳脫（批 1）。
- 原始碼模式：固定 630px 高雙捲軸、大綱被藏（批 1 移除）。
- mac-tx-core 240 個清單項目中 23 個降級，主要是鬆散清單（`list-md.js` 主動拒絕 `P`）（批 2）。
- 表格選單只有刪除與對齊、列選單蓋到側欄、最後一格 Tab 離開表格（批 2）；91 張表中 3 張降級，原因待查（批 2 計畫時查）。
- ⠿ ＋ 貼頂端、18×20（批 1）。
- `/api/render` 有 `trackDrawioRefs` 副作用，圖表預覽不能借用（批 3 新增 `/api/preview`）。
- 手機：工具列 23 顆只看得到 9–10 顆、⠿ ＋ hover-only、大綱與深淺鈕找不到（批 3；批 1 先讓深淺泡泡在手機可見）。

## 待辦（未進任何一批）

- **波形編輯器介面重新設計**：使用者要求，另開一次逐項審查（筆刷列、關聯線、側欄、狀態列、鍵盤操作）。批 1 只換它的顏色 token 讓深色不壞。
- 原始碼上色（若未來要做，需用 md2doc 自己的 Markdown 解析位置，不用 highlight.js 的 markdown）。
- 多段落清單項目、含原始 HTML 的清單項目、混文字的圖片段落、行內公式與上下標的編輯。
- 既有後續（另見 memory `v380-followups`、`v390-followups`）：TOC M5–M7、D10 中間亮度填色、inline svg、editor-journey F6 flake、搜尋跨 `.sec`、多 H1 粗體。

## 審查用的原型工具（本機暫存，不進版控）

原型以 Playwright 開真實 `md2doc --edit`，把 CSS／DOM 注入頁面截圖；淺深色以 `applyReaderTheme` 改寫編輯頁 HTML 模擬。Windows 字型（Segoe UI、微軟正黑、Consolas）以 fontconfig 載入，`monospace` 必須別名到 Consolas，否則截圖會變襯線字（審查中踩過一次）。不得操作使用者的 Windows 桌面。
