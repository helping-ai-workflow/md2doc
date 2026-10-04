---
name: design-options-need-rendered-examples
description: 設計／UI 討論時，每個項目要開獨立 artifact，把每個選項實際套用到真實輸出並截圖並排，才問使用者選哪個
metadata:
  node_type: memory
  type: feedback
  originSessionId: cc552bfe-c005-4ece-b528-ad08d7b94e52
  modified: 2026-09-30T18:15:48.994Z
---

設計審查或 UI 提案逐項討論時，**每一項開一個 artifact**，裡面把每個選項（含「現況」）實際套用到真實文件的輸出上、截圖或即時渲染並排，使用者看過結果才用 AskUserQuestion 問選擇。

**Why:** 2026-10-01 md2doc 版面審查，我只在一頁總覽 artifact 裡放問題截圖＋文字描述＋CSS 片段，就用 AskUserQuestion 連問 6 項；使用者打斷：「每一項提案都沒有開選項跟範例給我做選擇，應該要逐個項目開 artifact。我根本不知道你每個提案的結果長怎樣」。文字描述＋CSS 不等於看得到結果。

**How to apply:**
- 一項一個 artifact，每個選項都要有渲染結果（把 CSS 注入真實輸出後截圖，用真實內容，不要只放示意 mock）。
- 桌面／手機寬度都受影響的項目，兩種寬度都要截。
- 每個選項並排、標清楚名稱，選項名稱要跟 AskUserQuestion 裡的選項一致。
- 選項要有出處：先實測同類的成熟範例（規格文件就量 WHATWG / RFC / ECMA-262 的實際 computed style 並截圖），放進 artifact 的「參考」區，每個選項標明「有參考」或「我自己推的」。同一天使用者問「你這是自己想的還是有參考甚麼不錯的設計?」，實測後發現我推薦的「章節號淡色」三份參考都沒有，必須撤回改推。
- 同一塊 UI 的元件（例如側欄的搜尋框、結果、按鈕、麵包屑、TOC）要當成一整套設計，每個選項是一個完整系統，並附「元件 × 選項」對照表；不要一個元件一頁拆開問。使用者原話：「請連同按鈕、TOC顯示 一同全局考量設計。」
- 推薦理由若涉及 runtime 行為（例如「目前項目會不會捲出可視範圍」），先 grep 程式碼確認，不要憑推測。
- 截圖環境的字型要接近使用者的環境（WSL 可把 /mnt/c/Windows/Fonts 加進 fontconfig），不然截圖會誤導。

相關：[[brainstorming-use-askuserquestion]]
