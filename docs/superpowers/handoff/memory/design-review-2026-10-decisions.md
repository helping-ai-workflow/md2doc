---
name: design-review-2026-10-decisions
description: 2026-10-01 md2doc HTML 版面審查 13 項定案；淺色部分 v3.8.0 發布，深色模式 v3.9.0 發布（設計有改，見 dark-mode-decisions）
metadata:
  node_type: memory
  type: project
  originSessionId: cc552bfe-c005-4ece-b528-ad08d7b94e52
  modified: 2026-10-01T02:35:17.724Z
---

2026-10-01 與使用者逐項審查 md2doc v3.7.0 HTML 輸出，13 項全部定案（第 13 項為審查中新發現）。
**狀態（2026-10-01）**：深色模式以外全部實作於 worktree `~/hp_workspace/md2doc-reader-design`（branch `feat/reader-design-review`，HEAD dcf9c9c，npm test＋test:browser 全綠），CHANGELOG 標 v3.8.0 未發布；**尚未 merge／發版**。深色模式（第 11/11b/11c 項）另開計畫。
定案總覽（對照表＋各項比較頁連結＋現況/定案淺色/定案深色截圖）：https://claude.ai/artifact/X5nMrUKPysQvAAyRLrWoDh

重點決定（細節以總覽頁為準）：
- 行寬不設上限；中文字型堆疊補正黑體＋lang 偵測/--lang
- 表格：靠上、只留橫線、無斑馬紋、tabular-nums
- 標題：H3 1.3em / H4 1.1em、上寬下窄、章節號同色＋加寬空隙
- mermaid 文件藍 base 主題；graphviz 預設 Times 換無襯線
- 手機：44px 頂列（☰＋目前章節）、手機隱藏 #
- 側欄：ECMA-262 式單一灰面板、路徑加粗取代麵包屑、TOC 單行右緣漸隱；藍＝目前位置、黃＝搜尋命中
- 行內 code：無底＋橘紅 #b93a0c、0.92em
- 焦點：文件藍 2px；隱藏的 Search/Clear tabindex=-1
- 深色模式：mermaid 深色、烘焙 SVG 白底板；右下懸浮泡泡 ◐/☀/☾ 循環（使用者選的，參考網站都放頂列）
- H1 後每行 `**Key:**` 的段落自動排兩欄（白名單）
- 手機寬表格：≤1080px 時說明欄 min-width 15em、表格橫向捲動（sticky 第一欄保留訊號名）

**Why:** 實作要回到這些決定，不要重新發明。**How to apply:** 實作前先讀總覽頁。

相關：[[design-options-need-rendered-examples]] [[html-output-is-for-screen-reading]]
