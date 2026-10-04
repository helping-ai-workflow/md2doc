---
name: dark-mode-decisions
description: md2doc 深色模式（v3.9.0）2026-10-02 與使用者定案的設計；取代 design-review 第 11/11b/11c 項的「跟隨系統、三段 ◐☀☾、圖表白底板」
metadata:
  type: project
---

2026-10-02 定案（推翻原第 11 項的部分內容）：
- 範圍：只做閱讀頁；`--edit` 維持淺色、不出現泡泡；PDF／列印一律淺色。
- **預設淺色、不跟隨系統**（使用者：「我想摘除系統色可以嗎? 預設淺色。」）；右下泡泡兩段 ☀ 淺色 ↔ ☾ 深色，圖示＝目前狀態，標籤英文（`Light theme (click for dark)`／`Dark theme (click for light)`，與其他閱讀頁控制項一致），選擇存 localStorage（所有 md2doc 文件共用），開頁前套用不閃白。主題屬性用 `data-md2doc-theme`（不用 `data-theme`，artifact 檢視器會在根元素寫自己的）。
- 配色：B Neutral（Docusaurus 實測底 #1b1b1d、內文 #e3e3e3；文件藍提亮 #6ea8f5）。使用者考慮過 tripwork 暖色（D），自己提出「暖色底做文件不太正式、報告怪」→ 不採用，也不在泡泡加色系選擇。
- 桌面：右下浮動泡泡（2026-10-02 使用者提議改右上，比較 A 右上浮動／B 側欄標題列／C 右下泡泡後自己選回 C；https://claude.ai/artifact/X3Yspo3cG2du8h4Eo7djq6）。
- 手機（≤1080px）：切換按鈕收進 44px 頂列右側（☰ 同一列），不用浮動泡泡；桌面維持右下泡泡（2026-10-02 四方案比較後選 B，https://claude.ai/artifact/8arACKkAFiG1hkZSiHrFMp）。
- 一般圖片（PNG 等點陣圖）與 draw.io：深色時白底板，用 box-shadow 外擴 10px（不能用 padding——會推動版面，使用者實際看到捲動跳位）。
- live 深色 mermaid 只調整標籤與作者 classDef/style/linkStyle/subgraph 樣式，不碰 mermaid 自己的箭頭與 marker；烘焙版走完整 D10。
- 圖表：mermaid 深色重畫；**graphviz、WaveDrom 也「跟隨深色」**（執行期依規則改色：黑線/黑字→淺、近白填色→透明、淺色填色保色相壓暗、作者深色填色不動，切回淺色完全還原）；draw.io 與一般圖片放白底板。
- 原型：https://claude.ai/artifact/Fmu5Y7TrbiPLdvKgSJqt3z （mac-tx-core design doc 為範例，使用者指定用它）；配色比較頁 https://claude.ai/artifact/J8qA1WWNdMshqWBAAAtK1z

**Why:** 使用者逐步改掉原定案；實作與 spec 必須照這份，不要回到「跟隨系統／白底板」。
**How to apply:** 寫 spec／plan／實作前先讀這份；淺色必須和 v3.8.0 逐項一致（computed style 比對鎖住）。

相關：[[design-review-2026-10-decisions]] [[design-options-need-rendered-examples]]
