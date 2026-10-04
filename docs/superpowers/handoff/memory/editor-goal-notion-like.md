---
name: editor-goal-notion-like
description: md2doc 編輯模式（--edit）的產品目標是 Notion-like 體驗；驗收要對照 Notion 核心互動清單＋跨引擎點擊測試
metadata:
  node_type: memory
  type: project
  originSessionId: cc552bfe-c005-4ece-b528-ad08d7b94e52
  modified: 2026-10-01T06:02:31.566Z
---

使用者 2026-10-01 明確說編輯模式「目標是 notion-like 體驗」，並問編輯模式是否也要加入點擊測試。

現況（2026-10-01 實測）：editor-journey.test.js 約 191 情境／780 次點擊按鍵、editor-client-runtime.test.js 約 222 情境／775 次，全部是 puppeteer＝只有 Chromium，視窗幾乎都是 1400 寬；沒有 WebKit（contenteditable 跨引擎差異最大處）；也沒有對照 Notion 核心互動清單的覆蓋盤點。

**Why:** 測試目前驗證的是「已做出的行為」，回答不了「是否達到 Notion 水準」。

**How to apply:**
- 編輯器相關工作先問：這個互動在 Notion 怎麼做？我們是否一致？有沒有點擊測試？
- 規劃中的後續（v3.8.0 之後）：一輪「編輯器 Notion-like 審查」（比照 2026-10 版面審查流程：每項開 artifact、渲染實例、參考實測、定案）→ 覆蓋矩陣 → 重用 reader 的 Playwright 點擊測試框架（test/reader-click.test.js）寫編輯器核心互動在 Chromium＋WebKit 的點擊測試。

2026-10-04 使用者啟動編輯器大改版：「全部大檢整，所有項目都逐一確認跟討論，我的 tripwork plugin 已經有很不錯的UX，說不定有些東西能參考？」→ 範圍＝編輯器全部介面逐項審查（比照 2026-10 版面審查：每項 artifact、套真實輸出、量參考），參考來源加入 tripwork 閱讀頁 UX；用 /frontend-design 討論。
盤點（2026-10-04）缺：「/」選單、Markdown 輸入自動轉換、Enter 切段、Backspace 合併、連結 popover（現為 window.prompt）、自動存檔、程式碼／mermaid／graphviz 視覺編輯；有：⠿ 把手＋轉換成、＋ 插入、多選、表格把手、波形編輯器。
使用者回報缺陷（2026-10-04，Playwright 重現）：空白 md 開編輯模式 0 個區塊，點擊／打字都無反應；短文件點文件下方空白處也不會新增區塊。Notion 是點空白處即新增段落 → 列為 E3 必修。
E1 視覺比較 artifact：https://claude.ai/artifact/BZoLL88TS7cGvKK1rKz6rf（目前／A 深色＋Lucide／B 淺色紙面（推薦）／C 沉浸式）。

相關：[[reader-click-tests-like-tripwork]] [[design-options-need-rendered-examples]] [[design-review-2026-10-decisions]]
