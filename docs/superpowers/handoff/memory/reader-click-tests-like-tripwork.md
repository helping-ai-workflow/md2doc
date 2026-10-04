---
name: reader-click-tests-like-tripwork
description: "md2doc must verify its reader UI with its own click-through browser tests (like tripwork's tests_browser), not rely on the user to find UI bugs"
metadata:
  node_type: memory
  type: feedback
  originSessionId: cc552bfe-c005-4ece-b528-ad08d7b94e52
  modified: 2026-10-01T05:53:14.451Z
---

md2doc 的閱讀模式 UI 要由 repo 自己的點擊測試驗證：實際點每一個互動元件（桌面＋手機寬度），從 DOM 量幾何／狀態後斷言；不要等使用者打開頁面才發現問題。

**Why:** 2026-10-01 v3.8.0 實作途中，使用者說：「本 repo 應該要像 /home/user/hp_workspace/tripwork 一樣自己做點擊測試，而不是使用者幫忙除錯」。同一輪裡 active 父列變深灰、header 按鈕焦點框被裁、PDF 每頁印出手機頂列、縮放後閱讀位置跑掉，都是靠截圖／reviewer 才發現，不是測試先紅。

**How to apply:**
- 參考 tripwork `tests_browser/`（Playwright，Chromium＋WebKit，desktop 1366×768 / phone 390×844，`page.click` 真實點擊，斷言用 DOM 幾何「Geometry comes from the DOM, never from screenshots」，CI `browser.yml` 只在影響頁面的路徑變更時跑）。
- 改到 lib/md2doc.js 的閱讀 UI（CSS、側欄、TOC、搜尋、手機頂列、燈箱）時，同一個改動就要在點擊測試裡加/更新對應的點擊情境，並在宣告完成前跑過。
- 截圖只拿來給使用者看設計，不當驗收證據。

相關：[[design-options-need-rendered-examples]] [[design-review-2026-10-decisions]]
