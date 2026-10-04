## Global Constraints

- `docs/superpowers/specs/`、`docs/superpowers/plans/` 永不 `git add`（`.gitignore` 已含 `docs/superpowers/`）。
- 工作在 worktree `/home/user/hp_workspace/md2doc-editor-b1`，分支 `feat/editor-batch1`，從 `main`（`ba72389`，v3.9.1）切出。任何 subagent 的第一步必須 `cd /home/user/hp_workspace/md2doc-editor-b1`。
- `lib/md2doc.js` 的 `<style>` 與 `editModeLayoutCss` 都在 JS template literal 裡：**不得新增反引號，不得新增會被吃掉的反斜線**。每個動到 `lib/md2doc.js` 的任務結束前，用 `node -e "const s=require('fs').readFileSync('lib/md2doc.js','utf8');console.log((s.match(/\x60/g)||[]).length,(s.match(/\\\\\x60/g)||[]).length)"` 確認輸出仍是 `352 4`（Task 11 起是 `354 4`，見該任務；其他任務都不得改變計數），並實際渲染一份文件（`node bin/md2doc.js test/fixtures/… --out /tmp/x.html` 或 render 測試）確認 exit 0。
- `lib/editor/client.js` 含 NUL 位元組：搜尋用 `grep -a`；計數或「不存在」檢查用 node `String.indexOf`，不用 `grep -o | wc -l`。
- `client.js` 裡不得出現子字串：`ed-bar`、`openTableEditor`、`runTableStructureOp`、`selectedBlockEl`、`dismissBar`、`showBarFor`、`updateBarButtons`（`test/editor-client.test.js` 以 `includes` 檢查，連註解也算）。新角色名稱因此用 `ed-chrome` 不用 `ed-bar`。
- `client.js` 必須仍含：`__ED__`、`Ctrl`、`beforeunload`、`/api/save`、`/api/render`、`/api/ping`、`409`、`__md2docInitDiagrams`、`ed-raw`、`ed-wys-cell`、`ed-tb-insert`、`wireBlockSelection`、`ed-selected`、`md2docSelection`。
- 主題屬性是 `data-md2doc-theme`，偏好鍵 `md2doc-theme`；不得用 `data-theme`。
- 不得跑兩個長測試套件或一邊改檔一邊跑 `npm test`（CLAUDE.md：會讀到混合版本）。
- 跑全套：`rtk proxy npm test`（不要讓 RTK 摘要輸出）；點擊檢查：`npm run test:browser`。
- `git diff` 要檢查刪除時一律導到檔案再讀，不要 pipe。
- 每個任務一個以上 commit；commit 訊息英文，結尾加：
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01B7CMwWwLPVYwZdw2TntFdd`。
- 不改波形編輯器的版面與操作，只換顏色（使用者另開審查）。
- 存檔維持手動（E2 定案 S1），不做自動存檔、不做自動重試。

## Review Focus

1. **編輯模式下 Mermaid 區塊重畫後的深色**：主題 runtime 接管 mermaid 的淺／深快取，而編輯器在 `/api/render` 局部重建時會重新初始化圖表（`__md2docInitDiagrams`）。使用者在深色下改了文件裡別的段落，Mermaid 圖應維持深色、不閃回淺色。→ Task 3 的點擊檢查。
2. **勾選的待辦底下有未勾的子項目**：刪除線只該畫在勾選那一項自己的文字上，子項目不能被劃掉（CSS `text-decoration` 會傳給子孫，無法在子層取消）。→ Task 10 的單元與點擊檢查。
3. **提示小框 4 秒自動消失 vs. 依賴橫幅的既有流程**：Esc 優先序、`activeBannerIsRefusal`、鍵盤導覽離開提示在小框消失後要回到「沒有橫幅」的狀態，不能殘留旗標讓下一次 Esc 被吃掉。→ Task 8 的 runtime 測試。
4. **外部修改自動重新載入時正好在打字**：使用者游標在段落裡但還沒提交（burst 未送出）時，`documentIsDirty()` 已為真，必須走衝突卡片而不是重新載入。→ Task 9 的單元與點擊檢查。
5. **未標語言或標了未註冊語言的程式碼區塊**：必須原樣輸出純文字，不得猜語言、不得丟例外；`lang` 帶額外字（例如 ```` ```verilog title=x ````）只取第一個字。→ Task 11 的單元測試。

