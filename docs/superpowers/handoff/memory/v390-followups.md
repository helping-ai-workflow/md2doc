---
name: v390-followups
description: md2doc v3.9.0（深色模式＋TOC 追蹤＋游標）審查時刻意留下的後續項目，下一版從這裡開始
metadata:
  node_type: memory
  type: project
  originSessionId: 6a8aa9c3-5674-44c7-ad7d-1f7216617277
  modified: 2026-10-03T18:57:15.908Z
---

v3.9.0 分支 feat/dark-mode（HEAD 9f0f431，2026-10-03）最終審查裁定留給下一版：
- TOC：M5 版面變動但沒捲動時不重算高亮（拖 splitter、只改視窗高度）→ resize 也排一次 pass；M6 點最後幾節 TOC 不會亮那一列（v3.8.0 就有）；M7 搜尋凍結中點 TOC 不換高亮（v3.8.0 就有）。
- 深色 D10：作者中間亮度填色（fill:#888,color:#222）文字被提亮後只剩 2.76:1，需要 spec 層級規則；Markdown 原生 inline `<svg>` 深色下不改色也沒白底板。
- 測試：graphviz/WaveDrom 的列印還原路徑沒有 click check；對比鎖只測桌面（手機頂列按鈕沒量）。
- editor-journey 前提 flake（「F6 前提失敗：列選單必須先有項目，got childCount=0」等）：main dc54ef7 也 1/3 失敗，既有問題，仍待查（併入 [[v380-followups]] 的 resize 時序項）。
  2026-10-04 量到疑似根因：寬度變化後 scroll anchoring 的 hold（`holdScrollAnchor`，2 個 rAF 內 restore）會把這段期間別人做的 scrollTo 拉回原錨點。實驗：800→1400 `setViewport` 後立刻 `scrollTo(12000)`，300ms 後 scrollY 變回 0 的比例 main 4/200、加了欄寬 ResizeObserver 的分支 3/200。F6 正好是 newPage(800 寬)→setViewport(1400)→馬上 scrollTo。尚未修。

**Why:** 都是有量測證據、刻意延後的決定，不是遺漏。
**How to apply:** v3.9.0 發版後排下一輪時從這份開始；動 TOC 或 D10 前先讀。

相關：[[dark-mode-decisions]] [[toc-tracking-decision]] [[v380-followups]]
