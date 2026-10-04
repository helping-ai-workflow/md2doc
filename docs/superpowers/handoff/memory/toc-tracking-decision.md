---
name: toc-tracking-decision
description: md2doc 左側 TOC 追蹤 2026-10-02 定案：閱讀線追蹤＋手風琴展開＋目前列置中（修 v3.8.0 高亮消失與往上捲慢半拍）
metadata:
  type: project
---

使用者回報「捲動文件時 TOC 展開會從低位置跳回高位置，有時高亮跑到 TOC 框下看不見」。實測根因（v3.8.0）：① 單一 H1 被 TOC 攤平後，追蹤仍把 H1 當目前章節 → 高亮整片消失（全文捲動 33–64 個影格無高亮）；② IntersectionObserver 只從「這批變化的標題」挑 → 往上捲慢半拍、跳；③ 經過的章節全部保持展開（最多 38 節）＋只在出框時貼邊捲 → 高亮在框內 0–95% 之間跳。
定案（可操作比較 https://claude.ai/artifact/JJrjjoinaQMK9ABHKEcYW2 ，使用者：「手風琴+置中還不錯」）：閱讀線（視窗 35%）追蹤、只展開目前路徑（手風琴）、目前列置中約 40%（框內平滑、出框立即）。實測兩引擎：0 個無高亮影格、0 次出框、最多同時展開 4 節。

**Why:** 使用者在預覽中實際看到閃爍與跳動。
**How to apply:** 實作在 v3.9.0（feat/dark-mode 之後同分支）；點擊測試要鎖住「每格都有高亮、永遠在框內、往上捲正確、展開數有上限」。

相關：[[dark-mode-decisions]] [[reader-click-tests-like-tripwork]]
