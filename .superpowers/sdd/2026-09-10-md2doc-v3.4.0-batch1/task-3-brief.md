## Task 3: 儲存按鈕的模型層

**Files:**
- Modify: `lib/editor/toolbar-model.js`（`BUTTONS`、`GROUPS`、`deriveState()`）
- Test: `test/toolbar-model.test.js`

**Interfaces:**
- Produces: `BUTTONS` 多一筆 `{ id: 'save', group: 'file', ... }`；`GROUPS` 多一個 `'file'`（**最前**）；`deriveState(ctx)` 讀新的 `ctx.dirty`（boolean），輸出 `state.save.disabled`。

### 背景

`deriveState()` 尾端有一段 source 模式覆寫：

```js
  if (mode === 'source') {
    for (const b of BUTTONS) {
      state[b.id].disabled = b.id !== 'preview' && b.id !== 'outline';
    }
  }
```

它自己的註解寫著「This override still runs last and still overrides every disabled
flag computed above for every other button; do not narrow it for anything but these
two ids.」

**`save` 必須成為第三個豁免，而且理由要寫下來**：原始碼模式下照樣可以有未存檔的變更
（使用者可以在 source textarea 裡打字），而在那個模式下把唯一的儲存按鈕變灰，等於
把一個有未存檔內容的模式做成沒有出口——這正是那段註解替 `outline` 舉的同一種理由
（「a disabled ☰ here would leave source mode with no way to open that drawer at all」）。

- [ ] **Step 1: 寫會紅的測試**

在 `test/toolbar-model.test.js` 加入（沿用該檔既有風格）：

```js
// v3.4.0 §3: 儲存按鈕
{
  const save = M.BUTTONS.find((b) => b.id === 'save');
  assert.ok(save, 'BUTTONS 必須有 save');
  assert.strictEqual(save.group, 'file', 'save 屬於 file 群組');
  assert.strictEqual(save.toggle, false, 'save 不是 toggle');
  assert.strictEqual(M.GROUPS[0], 'file',
    'file 群組排在最前。Got ' + JSON.stringify(M.GROUPS));
  assert.deepStrictEqual(M.GROUPS.slice(1),
    ['history', 'block', 'inline', 'indent', 'insert', 'view'],
    '既有群組順序不得改變');

  // 髒 / 乾淨
  const dirty = M.deriveState({ mode: 'edit', blockType: 'paragraph', dirty: true });
  assert.strictEqual(dirty.save.disabled, false, '有未存檔變更時 save 必須可按');
  const clean = M.deriveState({ mode: 'edit', blockType: 'paragraph', dirty: false });
  assert.strictEqual(clean.save.disabled, true, '沒有變更時 save 必須是灰的');

  // 沒有任何 block 時（rerenderAll 之後的歸零狀態）仍要能存
  const noBlock = M.deriveState({ mode: 'edit', blockType: null, dirty: true });
  assert.strictEqual(noBlock.save.disabled, false,
    'save 不得因為沒有作用中 block 就變灰 —— 未存檔的變更跟游標在哪無關');

  // 原始碼模式：save 是第三個豁免
  const src = M.deriveState({ mode: 'source', blockType: null, dirty: true });
  assert.strictEqual(src.save.disabled, false,
    '原始碼模式照樣可以有未存檔變更，儲存按鈕必須留著');
  const srcClean = M.deriveState({ mode: 'source', blockType: null, dirty: false });
  assert.strictEqual(srcClean.save.disabled, true,
    '原始碼模式下沒有變更時仍然是灰的 —— 豁免的是「不被模式強制變灰」，' +
    '不是「永遠亮著」');

  // 其餘按鈕在原始碼模式下仍然全灰（不得被這次改動放寬）
  for (const b of M.BUTTONS) {
    if (b.id === 'preview' || b.id === 'outline' || b.id === 'save') continue;
    assert.strictEqual(src[b.id].disabled, true,
      '原始碼模式下 ' + b.id + ' 仍必須是灰的');
  }
}
```

- [ ] **Step 2: 跑測試確認它紅**

```bash
node test/toolbar-model.test.js > /tmp/t3.log 2>&1; echo "EXIT=$?"; cat /tmp/t3.log
```

預期：`EXIT=1`，第一條就倒在 `BUTTONS 必須有 save`。

- [ ] **Step 3: 加按鈕與群組**

在 `BUTTONS` 陣列**最前面**（`undo` 之前）加入：

```js
  { id: 'save', group: 'file', label: '💾', icon: '💾', title: '儲存 (Ctrl+S)', toggle: false },
```

`GROUPS` 改為：

```js
const GROUPS = Object.freeze(['file', 'history', 'block', 'inline', 'indent', 'insert', 'view']);
```

`NO_BLOCK_ALLOWED` 加入 `'save'`：

```js
// Buttons that stay enabled even when there is no block at all (the zeroed
// state right after rerenderAll, before any block gets focus/selection).
// 'save' is here because unsaved changes have nothing to do with where the
// caret is — a document can be dirty with no block focused at all.
const NO_BLOCK_ALLOWED = new Set(['undo', 'redo', 'outline', 'preview', 'save']);
```

- [ ] **Step 4: 讓 `deriveState()` 讀 `ctx.dirty`**

在 `deriveState()` 開頭的 ctx 解構旁加入：

```js
  const dirty = !!c.dirty;
```

在 source 模式覆寫**之前**加入：

```js
  // v3.4.0 §3: 儲存按鈕自己就是儲存狀態指示器 —— 乾淨時灰、髒時亮。真相只有
  // 一份：client.js 的 `stack.dirtyDepth !== 0 || burstHasUncommittedEdit()`，
  // 由 ctx.dirty 帶進來。這裡不重算。
  state.save.disabled = !dirty;
```

source 模式覆寫改為：

```js
  if (mode === 'source') {
    for (const b of BUTTONS) {
      if (b.id === 'preview' || b.id === 'outline') { state[b.id].disabled = false; continue; }
      // v3.4.0 §3: save 是第三個豁免，理由與 outline 同型 —— 原始碼模式下
      // 照樣可以有未存檔的變更（使用者在 source textarea 裡打字），把唯一的
      // 儲存按鈕強制變灰，等於做出一個有未存檔內容卻沒有出口的模式。
      // 豁免的是「不被模式強制變灰」，不是「永遠亮著」：乾淨時它仍然是灰的。
      if (b.id === 'save') continue;
      state[b.id].disabled = true;
    }
  }
```

**注意**：原本那個迴圈是 `state[b.id].disabled = b.id !== 'preview' && b.id !== 'outline';`
——它會把 `preview` / `outline` 明確設成 `false`。改寫後要保留這個行為（上面的
`continue` 之前已經設 `false`）。

- [ ] **Step 5: 跑測試確認它綠**

```bash
node test/toolbar-model.test.js > /tmp/t3.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t3.log
```

預期：`EXIT=0`。

- [ ] **Step 6: 跑 `editor-client.test.js`（快，且會掃 client.js 的九個裸子字串）**

```bash
node test/editor-client.test.js > /tmp/t3b.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t3b.log
```

- [ ] **Step 7: Commit**

```bash
git add lib/editor/toolbar-model.js test/toolbar-model.test.js
git commit -m "feat(editor): a save button in the toolbar model

The button IS the save-state indicator: grey when the document matches
disk, lit when it does not. The truth stays single-sourced — client.js's
`stack.dirtyDepth !== 0 || burstHasUncommittedEdit()` arrives as ctx.dirty
and is not recomputed here.

Source mode gets a third exemption from the blanket disable, for the same
reason outline already had one: you can type into the source textarea, so
that mode can hold unsaved changes, and greying out the only save button
would make a mode that holds unsaved work with no way out of it. The
exemption is from the MODE forcing it grey, not from being grey — a clean
document still shows it disabled in source mode."
```

---

