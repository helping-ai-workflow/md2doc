## Task 11: backlog 第 11、12、13 項——幾何三項

**Files:**
- Modify: `lib/editor/client.js`、`lib/md2doc.js`（CSS）、`lib/editor/blockmap.js`
- Test: `test/editor-journey.test.js`、`test/blockmap.test.js`

### 範圍

| # | 症狀 | 注意 |
|---|---|---|
| 11 | `updateTableEdgeGrips()` 的守衛沒列 `.ed-tb-insert`，站在 ＋泡泡上會讓 ⠿ grip 消失 | 放寬那個 early return 會影響一個同時呼叫 `setGutterKeep()` 的行為，**那個行為在那裡未量測**——先量再改 |
| 12 | 窄視窗開側欄顯示 `.sidebar-scrim` 但沒有捲動鎖 | 是「缺一個鎖」而非「鎖被打敗」 |
| 13 | 深縮排項目裡的 table / `---` 讓 li 的 `startLine` 落在非 marker 行 | 改動前後相同；純函式，用 `blockmap.test.js` 測 |

- [ ] **Step 1: 第 13 項先做（純函式，快，可獨立驗）**

`test/blockmap.test.js` 加一條：深縮排 li 內含 table 的形狀，斷言該 li 的 `startLine`
落在 marker 行。跑 `node test/blockmap.test.js`，確認 RED，修，確認 GREEN。

- [ ] **Step 2: 第 12 項（CSS + journey 一列）**

窄視窗、開側欄、嘗試捲動背後頁面，斷言 `window.scrollY` 不變。

- [ ] **Step 3: 第 11 項——先量那個未量測的行為**

在 report 裡寫出：`setGutterKeep()` 在那條 early return 上負責什麼、放寬之後它會不會
少跑、少跑的後果是什麼。**量出來再改。** 這是 v3.3.0 的 final review 明確留下的
未量測區域。

- [ ] **Step 4: 三項各自回報 NEEDS_RUN（第 13 項不需要，純函式自己跑）**

- [ ] **Step 5: Commit（三顆，一項一顆）**

```bash
git add lib/editor/blockmap.js test/blockmap.test.js
git commit -m "fix(blockmap): a li's startLine lands on its marker line

A table or a --- inside a deeply indented list item pushed the item's
startLine onto a line that carries no marker, so every consumer that reads
the marker off startLine read the wrong line."

git add lib/md2doc.js test/editor-journey.test.js
git commit -m "fix(editor): the sidebar scrim locks the page behind it

The narrow-window drawer dimmed the page and left it scrollable. This is a
missing lock rather than a defeated one — there was never a lock."

git add lib/editor/client.js test/editor-journey.test.js
git commit -m "fix(editor): standing on the + bubble no longer hides the row grip

updateTableEdgeGrips()'s guard did not list .ed-tb-insert. Widening the
early return also changes when setGutterKeep() runs, which was never
measured there; the measurement is in this task's report."

---

## Task 12: 未裁定的調查（spec §7）

**Files:**
- Modify: 可能無（產出可能只是文件）
- Test: 可能無

### 任務

`ensureTableBurstOpen()` 只用 `startLine` 重新解析表格，姊妹路徑
`handleTableCellFocusIn()` 用複合錨點（`data-block-id` 優先、`startLine` 後備，
兩者都由 `tableIdentityOf()` 把關）並在自己的註解裡說 `startLine` 不夠。

**已被證明的**：兩者實作確實不對稱。
**沒有被證明的**：任何一次實際失敗。v3.3.0 的 final review 作者試著證偽而做不到——
驅動「表格上方的髒段落多長一行、然後按列 ＋ 泡泡」得到的是正確插入、沒有 banner，
因為那次 render 並沒有讓表格脫離文件，復原分支根本沒被走到。

- [ ] **Step 1: 嘗試找出會走進復原分支的手勢**

需要同時滿足：`ensureTableBurstOpen()` 的復原分支真的被走到，**而且** `startLine`
在那裡名到別的東西。至少嘗試三條不同的路徑，每一條都寫進 report（包含失敗的）。

- [ ] **Step 2: 二選一產出**

- 找到 → 它變成缺陷，當場修，加測試，commit
- 找不到 → 把它從 backlog 移到「刻意接受的邊界」，並在
  `ensureTableBurstOpen()` 上方留一段註解記錄嘗試過哪些路徑

**不得**在沒有重現的情況下「順手把它改成複合錨點」——那會動到一個守著資料改寫手勢的
函式，而且沒有任何測試能說明改對了。

- [ ] **Step 3: Commit**

---

## Task 13: CHANGELOG 與收尾

**Files:**
- Modify: `CHANGELOG.md`、`CLAUDE.md`（若這一批新增了需要記的鐵則）

- [ ] **Step 1: 寫 v3.4.0 的 CHANGELOG 段落**

必須包含：

- **Breaking**：heading 的 slug 改變。舉實際前後對照
  （`#alpha-amp-beta` → `#alpha-beta`、`#c-lt-d-gt-e` → `#c-d-e`），
  說明外部指向舊錨點的連結會斷，以及為什麼仍然要改
- **Added**：儲存按鈕
- **Fixed**：表格拖曳、以及 backlog 各項逐條
- **Known issues**：本批沒收的（batch 2 / 3 的內容，以及「刻意接受的邊界」那 6 項），
  照 v3.3.0 的形式誠實分成兩類

沿用 v3.3.0 的敘述風格：**講缺陷長什麼樣、為什麼會那樣、修法為什麼是那樣**，
不要只寫「修正了 X」。

- [ ] **Step 2: 更新 `package.json` 的 `test` script**

確認這一批新增的測試檔都在裡面。

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json CLAUDE.md
git commit -m "docs: v3.4.0 batch 1 changelog"
```

---

## 交付檢查

這一批做完時：

- `npm test` 全綠（**由控制端跑**，約 25 分鐘）
- `node test/editor-client-runtime.test.js` 全綠（**由控制端跑**，約 20 分鐘）
- `node test/editor-journey.test.js` 全綠（**由控制端跑**）
- 工作樹乾淨，`docs/superpowers/` 與 `.superpowers/` 一個檔都沒進 commit
- CHANGELOG 的 Known issues 誠實列出 batch 2 / 3 尚未做的東西

**到這裡就是一個可以發版的狀態。** 若要停，停在這裡。
