---
name: v380-followups
description: md2doc v3.8.0 版面審查最終 review 刻意留下（ship-as-is／park）的後續項目，發版後要接著處理
metadata:
  type: project
---

v3.8.0 最終 review（2026-10-01）裁定先出貨、之後再處理的項目：

- **editor-journey hover 逾時**（約 3848 / 3591 行，0 AssertionError、重跑會過）：reviewer 證明是既有時序問題——`newPage`(800) → `setViewport(1400)` → `centreTable` → hover；若 resize 事件晚於 scrollIntoView，resize handler 用載入時的舊 anchor 把捲動拉回頂端，hover 落空。base 與 head 同幀觸發都 15/15 重現。測試端解法：`setViewport` 後等兩個 rAF 再捲動。歸入編輯器後續工作。
- **搜尋跨 `.sec` span 無黃色標記**（例：搜「4.1 assumptions」）：`highlightFirstOccurrence` 只比對單一 text node，會 fallback 捲到標題。
- **多 H1 文件的 TOC 章節列不粗體**（level-1 0.95em / 400）：照第 7+8 項 D 定案出貨，使用者若反映再議。
- **深色模式**（第 11/11b/11c 項）：另開計畫。
- **編輯器 Notion-like 審查＋WebKit 點擊測試**：見 [[editor-goal-notion-like]]。

**Why:** 這些都是有意識的取捨，不是漏掉；之後看到相關症狀時不要重新診斷一遍。
**How to apply:** v3.8.0 發版後排下一輪時從這份清單開始。

相關：[[design-review-2026-10-decisions]] [[reader-click-tests-like-tripwork]]
