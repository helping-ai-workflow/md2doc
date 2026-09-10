## Task 2: 表格列／欄拖曳之後畫面跳到表頭

**Files:**
- Modify: `lib/editor/client.js`（`performRowDrop()` 與 `performColDrop()` 對 `restoreTableFocus()` 的呼叫）
- Test: `test/editor-client-runtime.test.js`

**Interfaces:**
- Consumes: 無
- Produces: 無（行為修正）

### 背景（已查證的部分）

`restoreTableFocus()` 全檔**只有兩個呼叫點**，兩個都是
`restoreTableFocus(liveTableEl, activeIndex);`——一個在 `performRowDrop()`，
一個在 `performColDrop()`。兩者的 `activeIndex` 算法逐字相同：

```js
const activeIndex = (currentBurst && currentBurst.activeCellEl)
  ? tableCellsOf(liveTableEl).indexOf(currentBurst.activeCellEl) : -1;
```

而 `restoreTableFocus()` 的落點：

```js
const cell = cells[cellIndex >= 0 ? Math.min(cellIndex, cells.length - 1) : 0];
if (!cell) return;
...
cell.focus();
placeCaretAtEnd(cell);
```

**候選機制**：純拖曳從未點進任何儲存格 → `activeCellEl` 為 null → `activeIndex` 為 `-1`
→ 落到 `cells[0]`（第一個表頭儲存格）→ `focus()` → 瀏覽器捲進視野。

**這條是讀碼推出來的，還沒有被驅動驗證過。Step 1 的職責就是驗證它。**

而 `performBlockDrop()` 與 `performListItemDrop()` **完全不呼叫 `focus()`、不呼叫
`scrollIntoView()`**——「拖曳手勢不製造焦點」已經是本專案在其他兩條拖曳路徑上的既有
慣例。這次是讓表格拖曳回到那個慣例。

- [ ] **Step 1: 寫會紅的測試（先重現，不要先修）**

在 `test/editor-client-runtime.test.js` 的表格拖曳測試附近加入。**先讀該檔既有的
拖曳測試怎麼寫**（找 `performRowDrop` 或「拖曳」相關的既有列，沿用它的 `pressClick` /
指標事件 helper，不要自己發明一套）。文件要夠長，讓表格在捲動之後才進畫面：

```js
// v3.4.0 §2: 拖曳手勢從頭到尾沒有焦點，不該憑空製造一個。
// restoreTableFocus() 在 activeIndex === -1 時落到 cells[0]（第一個表頭
// 儲存格）並 focus()，瀏覽器於是把它捲進視野。
await scenario('a row drag leaves the scroll position alone', LONG_DOC_WITH_TABLE,
  async (page, mdPath) => {
    await scrollToTable(page);
    const before = await page.evaluate(() => window.scrollY);
    assert.ok(before > 0, 'precondition: 表格必須在捲動之後才進畫面，' +
      '否則這一列量不到任何東西。Got scrollY=' + before);

    await dragRow(page, /* fromRowIndex */ 2, /* toRowIndex */ 1);
    await settleEditor(page);

    const after = await page.evaluate(() => ({
      scrollY: window.scrollY,
      active: document.activeElement
        ? document.activeElement.tagName + '.' +
          (document.activeElement.className || '')
        : null,
    }));
    assert.strictEqual(after.scrollY, before,
      '拖曳不得改變捲動位置。Got ' + JSON.stringify(after));
    assert.ok(!/^TH/.test(after.active || ''),
      '拖曳不得把焦點放到表頭儲存格。Got ' + JSON.stringify(after));
  });
```

同時加入**不得回歸**的那一半：

```js
// 拖曳前確實在編輯某一格時，焦點必須回到同一格 —— 這條路徑不變。
await scenario('a row drag started from an edited cell keeps that cell focused',
  LONG_DOC_WITH_TABLE, async (page, mdPath) => {
    await typeIntoCell(page, /* row */ 2, /* col */ 1, 'PROBE');
    const cellBefore = await page.evaluate(() =>
      document.activeElement.textContent);
    await dragRow(page, 2, 1);
    await settleEditor(page);
    const cellAfter = await page.evaluate(() =>
      document.activeElement ? document.activeElement.textContent : null);
    assert.strictEqual(cellAfter, cellBefore,
      '拖曳前有作用中儲存格時，焦點必須回到同一格');
  });
```

`LONG_DOC_WITH_TABLE`、`scrollToTable`、`dragRow`、`typeIntoCell` 若該檔沒有現成的，
**在該檔內建立**，並讓 `dragRow` 走真正的指標事件（`mousedown` → `mousemove` → `mouseup`），
不要用合成 `.click()`——v3.3.0 的整個發現機制就是這個差別。

- [ ] **Step 2: 回報 NEEDS_RUN 讓控制端跑**

**不要自己跑 `node test/editor-client-runtime.test.js`**（約 20 分鐘，會被 API timeout 打斷）。
回報：

```
status: NEEDS_RUN
指令: node test/editor-client-runtime.test.js
預期: 第一列 RED（scrollY 改變或 activeElement 是 TH），第二列 GREEN
```

**若控制端回報第一列在修改前就是綠的，停下來回報 `BLOCKED`**——機制猜錯了，
要重新量，不要繼續往下修。

- [ ] **Step 3: 修**

`performRowDrop()` 與 `performColDrop()` 兩處，把無條件呼叫改成有條件：

```js
    // v3.4.0 §2: 拖曳手勢從頭到尾沒有焦點。activeIndex 為 -1 代表拖曳開始時
    // 沒有任何儲存格在編輯，此時 restoreTableFocus() 會落到 cells[0]（第一個
    // 表頭儲存格）並 focus()，把畫面捲到表頭 —— 使用者回報的症狀。
    // performBlockDrop() 與 performListItemDrop() 本來就不 focus；這一行讓
    // 表格拖曳回到同一個慣例。
    if (activeIndex >= 0) restoreTableFocus(liveTableEl, activeIndex);
```

**兩處都要改**，兩處都要有這段註解（或指向同一個說明）。`restoreTableFocus()`
本身不動——`cellIndex >= 0 ? ... : 0` 那個 fallback 對它的其他潛在呼叫端仍然合理，
而現在沒有任何呼叫端會傳負值進去。

- [ ] **Step 4: 回報 NEEDS_RUN 確認轉綠**

```
status: NEEDS_RUN
指令: node test/editor-client-runtime.test.js
預期: 兩列都 GREEN，其餘不變
```

- [ ] **Step 5: Commit**

```bash
git add lib/editor/client.js test/editor-client-runtime.test.js
git commit -m "fix(editor): a table drag no longer throws the page at the header

restoreTableFocus() falls back to cells[0] — the first header cell — when
the drag never had a focused cell, then focus()es it, and the browser
scrolls it into view. Both call sites (performRowDrop, performColDrop)
computed activeIndex the same way and hit it the same way.

performBlockDrop() and performListItemDrop() call neither focus() nor
scrollIntoView(); a drag gesture not manufacturing a focus is already this
file's convention on the other two drag paths. This puts the table drags
back on it."
```

---

