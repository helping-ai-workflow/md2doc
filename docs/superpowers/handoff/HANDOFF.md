# 交接：編輯器改版 批 1（2026-10-04）

原本那台電腦送修，工作中途交接到另一台。這個分支 `feat/editor-batch1` 帶著目前所有進度。

> ⚠ `docs/superpowers/` 原本是 gitignore 的本機工作區（使用者規則：spec/plan 不進版控）。這次是使用者明確要求為了換機才放進分支。**合併前要把整個 `docs/superpowers/` 從分支移除**（`git rm -r --cached docs/superpowers && git commit`），檔案留在本機即可。

## 目前進度

| 項目 | 狀態 |
|---|---|
| 審查 E1–E10 | 全部定案，見 `specs/2026-10-04-editor-overhaul-index.md`（含每項比較頁 artifact 連結） |
| 規格 | 批 1／批 2／批 3 三份 + 總覽，在 `docs/superpowers/specs/` |
| 計畫 | 只有批 1：`docs/superpowers/plans/2026-10-04-editor-batch1.md`（14 個任務） |
| 執行方式 | 使用者選 Subagent-driven（superpowers:subagent-driven-development） |
| Task 1 | 完成，`d9f318c`，審查通過（細項見 `handoff/sdd/progress.md`） |
| Task 2 | **做到一半**，`d630b03`（wip，未驗證）。重開機打斷了實作者的驗證，接著又因換機停止 |
| Task 3–14 | 未開始 |

## 在新電腦接續

```bash
git clone https://github.com/helping-ai-workflow/md2doc.git && cd md2doc
git fetch origin feat/editor-batch1
git worktree add ../md2doc-editor-b1 feat/editor-batch1
cd ../md2doc-editor-b1 && npm install && npx playwright install chromium webkit
```

1. **還原 SDD 工作區**：superpowers 的 ledger 原本放在主 checkout 的 `.superpowers/sdd/2026-10-04-editor-batch1/`（gitignored）。在新機上執行 skill 的 `scripts/sdd-workspace docs/superpowers/plans/2026-10-04-editor-batch1.md` 取得路徑，把 `handoff/sdd/` 的檔案複製進去（`progress.md` 第一行是 ledger 身分）。
2. **還原 memory**：`handoff/memory/` 是 Claude 的專案 memory（使用者偏好與所有定案）。複製到新機 `~/.claude…/projects/<此 repo 路徑編碼>/memory/`。最重要的是 `editor-review-decisions.md` 與 `MEMORY.md`。
3. **接續 Task 2**：讀 `handoff/sdd/task-2-brief.md`，對 `d630b03` 的 diff 補完缺的部分，然後**從頭重跑驗證**（重開機前的結果不算）：
   - 殘留舊色 grep（brief Step 3 的 node 指令）
   - 反引號計數 `352 4`
   - `node test/editor-click.test.js "chrome:"`
   - `node test/editor-client-runtime.test.js`，再 `node test/editor-journey.test.js`（依序、各自導到 log）
   - 通過後把 wip commit 修成正式訊息（或另加一個 commit），寫 `task-2-report.md`，再派任務審查
4. 之後照 ledger 接 Task 3 → 14。Task 14 結束不 push 正式版、不升版，等使用者「OK 更新 repo」。

## 已知事項

- 全套測試有兩個非 F6 的 flake 重跑會綠：editor-journey「V3 前提失敗 .ed-tb-insert」、清單 Ctrl+Z「betaLIWOR」（Task 1 實作時看到，已記入 ledger 給最後審查）。
- Ruling 與 deferred minor 都在 `handoff/sdd/progress.md`，最後的整條分支審查要讀。

## 原型腳本（`handoff/prototypes/`）

審查 E1–E10 時用來截圖的 Playwright 腳本。原檔在 /tmp 被重開機清掉，這些是**從對話紀錄重播寫檔指令還原**的（41 支照原樣、`slash.js` 依原做法重建；全部 `node --check` 通過）。`commands.log.md` 是當時所有相關指令的原文，順序即執行順序，供對照。

腳本假設的本機環境（都沒有放進 repo）：

| 需要的東西 | 怎麼準備 | 為什麼沒放進來 |
|---|---|---|
| `lucide/*.svg` | `curl -sf https://unpkg.com/lucide-static@0.469.0/icons/<name>.svg`，名稱見各腳本 `ico('…')` | 可隨時取得 |
| `fonts/` + `fonts.conf` | 從 `C:\Windows\Fonts` 複製 segoeui／segoeuib／seguisb／msjh／msjhbd／consola；`fonts.conf` 要把 `monospace` 別名到 Consolas（否則截圖變襯線字，審查中踩過） | 微軟字型授權不可散布；repo 是公開的 |
| `doc/mac-tx-core.md` + `assets/` | 從 paperwork 工作區 `spec/mac-tx-core/design-doc/` 複製 | 內部設計文件，repo 是公開的 |
| `rtl-sample.v`（hlshot2.js） | `cpu_tx_pla.v` 第 1800–1818 行，去掉帶人名的註解 | 公司 RTL |
| `hl/node_modules/highlight.js` | `npm i highlight.js@11.11.1` 到 `hl/` | 依賴 |

截圖時一律 Playwright headless，**不得操作使用者的 Windows 桌面**（memory `never-drive-user-desktop`）。比較頁 artifact 都還在 claude.ai，連結在總覽索引裡。
