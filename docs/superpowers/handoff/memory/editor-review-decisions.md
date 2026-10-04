---
name: editor-review-decisions
description: 2026-10 編輯器（--edit）Notion-like 大改版逐項審查的定案紀錄（E1–E10）
metadata:
  type: project
---

審查清單 E1 整體視覺／E2 存檔與狀態／E3 打字手感（Enter 切段、Backspace 合併、`# ` 自動轉換、「/」選單、點空白處新增段落）／E4 ⠿ 與 ＋／E5 行內格式與連結／E6 清單待辦／E7 表格／E8 程式碼與圖表（含波形編輯器）／E9 手機編輯／E10 原始碼模式。比較 artifact：https://claude.ai/artifact/BZoLL88TS7cGvKK1rKz6rf

定案：
- E1（2026-10-04）：B 淺色紙面工具列——白底工具列與白底細環選單、23 顆全留、Lucide 線條圖示、強調色統一 #0969da、拿掉 hover 虛線框。
- E1 深色：使用者指出「你沒考慮深淺模式切換」→ 編輯模式取消 light-only（lib/md2doc.js:5952），用閱讀頁同一組 B Neutral 深色 token，選單 #2a2a2d 浮起；偏好共用 md2doc-theme。切換鈕位置：使用者選 T2 沿用右下泡泡（我推薦的是 T1 放工具列，被否決）。編輯器專屬元件（原始碼框、完成/取消、核取框、表格把手、橫幅、波形編輯器）都要跟深色；波形編輯器細節併入 E8。
- E2（2026-10-04，artifact https://claude.ai/artifact/NPMcwoxzxkUtAkPKu2GfF7）：存檔維持手動 S1（我推薦自動存檔被否決——不要再推自動存檔），右上狀態「● 有未儲存的變更 · Ctrl+S 儲存」／「✓ 已儲存」，💾 有變更時亮強調色。訊息 N2：會丟資料的錯誤＝工具列下置中淡紅卡片＋左紅條＋動作鈕、需手動關；一般提示＝底部置中中性小框 4 秒消失；文案全中文並講下一步。
- E3（2026-10-04，https://claude.ai/artifact/FeuXLhZSkzEJt5nH38qio1）：7 項行為全做——Enter 游標處切段（Shift+Enter 段內換行）、段首 Backspace 合併（標題/清單先變段落再合併）、段首 Markdown 自動轉換（# ## ### - 1. [] > ``` ---，立刻 Ctrl+Z 還原字面）、「/」選單（中英篩選）、點文件下方空白新增段落、空白文件開啟即有空段落、聚焦空段落淡灰提示「輸入文字，或按「/」選擇區塊」。「/」選單 M1 精簡單行：32px、圖示＋名稱＋右側 Markdown 符號、分組 基本/清單/區塊/圖表 共 15 項、底部按鍵提示。
- E4（https://claude.ai/artifact/JABc8UEdrTDtgNJegGQQEC）：＋ ⠿ 置中在第一行文字、24×24 點擊區、16px 圖示；點 ＋ = 下方插入空段落並開同一份「/」選單（使用者：「＋的行為跟 / 應該一樣的表單，不需要額外設計一種顯示」）；Alt+點插上方；⠿ 選單四項不變。
- E5（https://claude.ai/artifact/GdtLpkTC3U7QVEj4hofFm4）：選字工具列 6 顆 Lucide 圖示（B I S U code ｜ link）；Ctrl+K／🔗 讓工具列原地變網址欄取代 window.prompt（Enter 套用、Esc 取消、清空＝移除）；選字後貼網址即成連結；游標在連結上出小卡（開啟／編輯／移除）。行內公式、上下標不做（mac-tx-core 0 處）。
- E6（https://claude.ai/artifact/V3XXcdnArMmWQ7UociY1Ej）：項目符號逐層 • ◦ ▪ 與閱讀頁一致；鬆散清單項目（mac-tx-core 23 個）改為可直接編輯、存檔保留空行；核取框 16px 圓角＋勾號；勾選後 C2 文字變淡＋刪除線，閱讀頁同步並修掉閱讀頁待辦「圓點＋核取框」雙重符號缺陷。
- E7（https://claude.ai/artifact/AW8rGDqTBVeoiUFkd833Se）：欄/列選單改直式（欄：左插/右插/對齊三鍵同行/刪除欄紅字；列：上插/下插/刪除列紅字），開在把手旁表格內側；表格下方與右側 hover 出 ＋ 長條加列/欄；最後一格 Tab 新增列；格線 ＋ 泡泡保留；3/91 張降級表格實作時查原因。
- E8（https://claude.ai/artifact/BvXYNen9hTwZVBJStNwhme）：程式碼原地編輯＋語言 chip＋複製；Graphviz/Mermaid hover「編輯圖表」→原地原始碼＋0.5s 即時預覽；圖片 hover 小工具列（替換/替代文字/刪除）；draw.io 不變。波形編輯器：開深色會壞（白面板＋深輸入框），本輪必須換 token 外觀；**使用者要求波形編輯器介面重新設計，排入待辦另開審查**。語法上色：目前完全沒有（lib/md2doc.js:1036 註解寫 highlighted 實際只跳脫），使用者問 Notion 選語言會上色能否做到 → 提案 highlight.js 產生 HTML 時上色（閱讀頁/PDF/編輯器），配色定案 H1 GitHub（淺：關鍵字 #cf222e 數字 #0550ae 註解 #6e7781 斜體 埠名 #8250df；深：GitHub dark）。
- E9（https://claude.ai/artifact/Wuh6s6ANDbKAnhuw7P8tjD）：M1——手機頂列只留復原/重做/大綱/原始碼/深淺/存檔狀態＋存檔鈕（深淺鈕在手機進頂列，桌面才是右下泡泡）；打字時鍵盤上方工具列（＋開「/」、⠿、B I S code link、清單、待辦、縮排，可滑、右緣淡出，40×40）；⠿ 開底部區塊選單（轉換成/上移/下移/建立副本/MD 原始碼/刪除）。
- E10（https://claude.ai/artifact/A29AM532yeXZdVvUbSbK3j）：使用者「原始碼模式是不是可以移除? 不好操作」→ X1 完全移除整份原始碼模式（桌面工具列 23→22 顆、手機頂列拿掉原始碼鈕；editor-journey 有 39 處要遷移）；單一區塊仍用 ⠿→MD 原始碼；「沒有自己的來源行」提示改指向外部文字編輯器；補：沒有未存變更時偵測磁碟檔被改就自動重新載入（沿用 10s /api/ping）。highlight.js markdown 會把 snake_case 底線誤判斜體，原始碼上色不做。
- 待辦：波形編輯器介面重新設計（使用者要求，另開審查）。
- 分批（使用者核可）：批1 外觀與深色 v3.10.0 → 批2 打字與插入 v3.11.0 → 批3 程式碼圖表圖片手機 v3.12.0。三份規格＋總覽索引已寫在 docs/superpowers/specs/2026-10-04-editor-{overhaul-index,batch1-design,batch2-design,batch3-design}.md（gitignored、本機限定，永不 stage）。2026-10-04 狀態：三份皆待使用者審；審過批 1 才寫計畫。
- 設計要點：批2 用「暫時空段落」模型（Markdown 不能有空區塊，空著離開不產生 op）；批3 圖表預覽新開 /api/preview（/api/render 有 trackDrawioRefs 副作用不可借用）。
- 2026-10-04：使用者「OK 寫 plan」→ 批 1 計畫 docs/superpowers/plans/2026-10-04-editor-batch1.md（14 任務，gitignored）。寫計畫時查到並修回規格：showBanner 實為 47 處（非 62）；token 不可叫 ed-bar（editor-client.test 子字串禁用）→ ed-chrome；/api/ping 的 204 無主體有 25 處測試綁定 → mtime 改走 X-Md2doc-Mtime 標頭；.ed-conflict 保留為兩級共同 class（測試 139 處）。待使用者審計畫並選執行方式。
- 2026-10-04 換機交接：原電腦送修，使用者要求把進度丟上 PR → draft PR #44（分支 feat/editor-batch1）：d9f318c Task 1 完成、d630b03 Task 2 WIP 未驗證、c9c6217 交接資料（specs/plan/SDD ledger/原型腳本/memory，force-add 進 docs/superpowers/，合併前必須移除）。repo 維持 public（使用者需要 Actions 分鐘數）。新機接續步驟見 docs/superpowers/handoff/HANDOFF.md。

**Why:** 使用者要求每項逐一確認；設計選項必須考慮深淺兩種模式（v3.9.0 起閱讀頁已有深色）。
**How to apply:** 之後每個 E 項的原型都要同時截淺色與深色；不要再只做淺色。

相關：[[editor-goal-notion-like]] [[dark-mode-decisions]] [[design-options-need-rendered-examples]]
