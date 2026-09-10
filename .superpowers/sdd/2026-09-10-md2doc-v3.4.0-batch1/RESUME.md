# 換機器後從哪裡接手

**分支**：`feat/v3.4.0-batch1`，起點 `d80de09`（`main`，v3.3.0 已發布）
**暫停原因**：這台機器要送修。**不是**因為卡住或做不下去。

這份檔案與同目錄的 `progress.md`（SDD ledger）是恢復用的地圖。`progress.md` 是逐步的完整記錄，含每一條裁定與它判錯的成本；這裡只講「下一步做什麼」。

---

## 目前進度

| Task | 內容 | 狀態 |
|---|---|---|
| 1 | heading 文字雙重跳脫（TOC / slug / section index） | ✅ complete，review clean |
| 2 | 表格列／欄拖曳後畫面跳到表頭 | ⏸ **重現已就緒，缺紅與綠**。`lib/editor/client.js` 一個字未動 |
| 3 | 儲存按鈕（模型層 `toolbar-model.js`） | ✅ complete，review clean |
| 4 | 儲存按鈕（用戶端接線） | 未開始，需 runtime + journey |
| 5 | 純空白選取按 🔗 | 未開始，需 runtime |
| 6 | 列插入泡泡 stale index | 未開始，需 runtime |
| 7 | raw 編輯器丟失編輯（backlog 1、5） | 未開始，需 runtime |
| 8 | `inline-md.js` 相鄰同 tag 標記互相吞掉 | ✅ complete，review clean |
| 9 | 可達性四項（backlog 6、7、9、10） | 未開始，需 journey |
| 10 | banner 升起時工具列打不到 | 未開始，需 journey |
| 11 | 幾何三項（backlog 11、12、13） | ⏸ 第 13 項（純函式）派工中途被停，**無任何改動落地** |
| 12 | `ensureTableBurstOpen()` 不對稱的調查 | 未開始 |
| 13 | CHANGELOG 與收尾 | 未開始 |

commit（新 → 舊）：

```
51b0230 wip(test): Task 2's reproduction for the table-drag focus jump
0bed3c8 fix(editor): adjacent same-tag marks stop swallowing each other
ee19f58 feat(editor): a save button in the toolbar model
808af13 fix(render): stripHtmlTags no longer leaks HTML comments into slugs
5c93d77 fix(render): heading text reaches the TOC and the slug unescaped
```

---

## 為什麼停在這裡（很重要，不要誤判成程式碼問題）

**這台機器 `load average 27`、`nproc 16`，超額 170%**（記憶體充足，17 GB available；來源是同時開著的多個 Claude session）。

puppeteer 那套測試在 CPU 飢餓下會隨機倒。**同一棵樹、同一條指令，跑三次得到三個不同失敗點**：

| run | 完成的場景數 | 失敗 |
|---|---|---|
| `runs/t2-red2.log` | 115 | `TimeoutError: 30000ms` —— **這個是真的**，實作者新 fixture 算錯，已修 |
| `runs/t2-red3.log` | 115 | `TimeoutError: 3000ms` @ `hoverBodyRowCell`，**既有 helper、既有場景** |
| `runs/t2-red4.log` | **3** | `No element found: .ed-handle`，另一個既有場景 |

已查證：Task 2 的 diff 是**純新增 +258 行、0 刪除**，沒有動到任何既有行，所以不是被改壞的。

**在新機器上第一件事：`cat /proc/loadavg`。** 負載正常（例如 < 8 on 16 核）再跑 runtime 測試，否則得到的紅是雜訊。

---

## 立刻可做的下一步（依序）

### 1. 確認 batch 1 已完成的部分仍然綠

```bash
node test/md2doc.test.js         # Task 1
node test/toolbar-model.test.js  # Task 3
node test/inline-md.test.js      # Task 8
node test/editor-client.test.js  # 掃 client.js 的九個裸子字串
```

**絕不 pipe**（`| tail` 之類）——exit code 會變成 pipeline 尾端那支的。

### 2. 把 Task 2 收掉（需要負載正常）

`test/editor-client-runtime.test.js` 裡已有兩個場景，都在檔案最尾端：

- `a drag with no pre-focused cell ... the header scrolled off-screen leaves the scroll position alone`
- `a drag started from an edited cell keeps that cell focused`（回歸保護）

**順序不可併**：

1. 先跑一次，**目標是看到第一個場景倒在「拖曳不得改變捲動位置」那條斷言上**，帶著真實的 `scrollY` 前後值。
   - 若倒在別的地方（逾時、找不到元素），先判斷是負載雜訊還是 fixture 問題——看它倒在**誰的程式碼**上、diff 有沒有碰到它。
   - **若第一個場景直接是綠的，代表機制猜錯了**，停下來重新量，不要硬改。
2. 看到紅之後才套修法。`performRowDrop()` 與 `performColDrop()` **兩處都要改**：
   ```js
   if (activeIndex >= 0) restoreTableFocus(liveTableEl, activeIndex);
   ```
3. 再跑一次確認兩個場景都綠。

**待確認的分岔**（實作者提出，尚未驗證）：`ensureTableBurstOpen()` 自己在 burst 未開時也會對 `cells[0]` 呼叫 `focus()`，而兩個 drop 函式都先 `await` 它。所以：

- 套上修法後焦點轉綠 ⇒ 來源是 `restoreTableFocus()`，修法正確
- 仍紅且 `active` 還是 TH ⇒ 來源是 `ensureTableBurstOpen()` 那一次，**修法要換地方**

### 3. 其餘 task 照 plan 編號推進

plan 在 `docs/superpowers/plans/2026-09-10-md2doc-v3.4.0-batch1.md`（本次一併 track 進 repo）。

---

## 已知的 plan 缺陷（我自己造成的，接手時要留意）

1. **brief 裡的測試 API 有杜撰的。** Task 2 的 `scenario()` / `LONG_DOC_WITH_TABLE` / `dragRow` 在 `test/editor-client-runtime.test.js` 裡不存在；該檔真正的慣例是 `setupTableDoc` / `tableBlockSel` / `rowGripCoords` / `rowBoundaryCoords` / `dragRowTo`。**寫測試片段前先確認 helper 真的存在。**

2. **Task 1 的 brief 不足以讓它自己指定的測試轉綠。** 我驗了 marked 的 token 跳脫狀態，沒驗下游 `stripHtmlTags()` 對「未跳脫的角括號文字」會怎樣——同一條路上兩個函式的契約耦合，只看了上游。已由實作者補上並修好。

3. **Task 8 的 brief（與 backlog）對缺陷的描述是錯的。** backlog 說「產生 `\*` 跳脫」，實際上**沒有任何路徑會吐出反斜線**；真正的缺陷是相鄰同 tag 標記把星號黏成一個 CommonMark delimiter run，第一個標記整個消失。backlog 那句 `\*` 是寫筆記的人自己的 markdown 轉義。**已在 commit `0bed3c8` 的訊息裡更正。**

---

## 執行時的硬規則（照抄自 plan 的 Global Constraints，血淚換來的）

- **實作者不得執行** `npm test`（25 分鐘）、`node test/editor-client-runtime.test.js`、`node test/editor-journey.test.js`（各 20 分鐘）。跑了會在等待中被 API timeout 打斷。改成回報 `NEEDS_RUN`，由控制端跑完餵回。
- **跑測試絕不 pipe。** exit code 會變成 pipeline 尾端那支的，紅的會被回報成綠的。
- **`lib/editor/client.js` 不得出現這九個裸子字串**（`test/editor-client.test.js` 用 `includes` 裸比對，一句註解裡的 `fixed-bar` 就會因為含 `ed-bar` 讓整支變紅）：
  `ed-gutter`、`attachGutters`、`ed-bar`、`openTableEditor`、`runTableStructureOp`、`selectedBlockEl`、`dismissBar`、`showBarFor`、`updateBarButtons`
- **一律用引文錨點定位，不要用行號。**
- **間歇性紅不等於 flake。** 帶 `AssertionError` 的紅一律要查到機制。只有不帶 AssertionError 的基礎設施 flake（`ProtocolError: Runtime.callFunctionOn timed out`、`net::ERR_NETWORK_CHANGED`）適用重跑規則，而且要看到綠的重跑才算。
- **禁止用無界 `waitForFunction` 等一個可預期的最終值**（Ruling T2-2）。`test/editor-client-runtime.test.js` 沒有 per-scenario try/catch，一次逾時吃掉後面約 350 個場景，而且不留任何線索。改成 `drag → settle → 寬限 → 讀實際值 → assert.strictEqual`。
- **不准 skip / xfail 任何既有測試，不准放寬任何斷言。**

---

## 這批東西為什麼破例進了 repo

`docs/superpowers/` 與 `.superpowers/` 按規矩**永不 git track**（它們是本機工作狀態）。這一次是**使用者明確指示**「把 plan 以及當前狀態 git track（暫時無視 ignore）」，因為機器要送修、狀態必須能在另一台機器上接續。

**恢復之後，是否要把這些檔案從 repo 移除，由使用者決定。** 若要移除：`git rm -r --cached docs/superpowers .superpowers` 即可，`.gitignore` 的規則本來就還在。
