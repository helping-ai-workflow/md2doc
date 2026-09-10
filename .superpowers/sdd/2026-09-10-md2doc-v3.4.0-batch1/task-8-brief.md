## Task 8: backlog 第 3 項——`inline-md.js` 的定界符長度選擇

**Files:**
- Modify: `lib/editor/inline-md.js`
- Test: `test/inline-md.test.js`

### 背景

選取起點落在 `` *`code`* `` 這類定界符相鄰處時，定界符長度選擇會產生 `\*` 跳脫。
與 v3.3.0 Task 6 修掉的「空殘留標記」**不同根因、不同檔案、不同修法**。

**v3.3.0 刻意沒有為它釘測試**，理由寫在 backlog 裡：

> 斷言今天這組錯的位元組，會讓將來真正的修法因為錯誤的理由而變紅。

所以這一 task 的順序是：**先修，修好之後才釘正確形狀的測試。** 這與其他 task 的
TDD 順序相反，是刻意的。

- [ ] **Step 1: 重現並記錄實際位元組**

`test/inline-md.test.js` 是純函式測試（快），直接跑。寫一支臨時腳本驅動出目前的
輸出，把**實際的位元組**貼進 report。不要憑記憶描述。

- [ ] **Step 2: 找出定界符長度是怎麼被選出來的**

在 `lib/editor/inline-md.js` 找負責挑 `*` / `**` / `` ` `` 長度的那一段。在 report
裡寫出：輸入是什麼、它選了什麼、為什麼那個選擇在這個形狀上是錯的。

- [ ] **Step 3: 修**

- [ ] **Step 4: 釘正確形狀的測試**

```js
// v3.4.0 / backlog 3: 選取起點與定界符相鄰時，定界符長度選擇不得產生跳脫。
// v3.3.0 刻意沒有釘這一條 —— 當時斷言錯的位元組會讓真正的修法因為錯誤的
// 理由變紅。現在釘的是修好之後的正確形狀。
assert.strictEqual(toMarkdown(SHAPE_FROM_STEP_1), EXPECTED_WITHOUT_BACKSLASH,
  '定界符相鄰的選取不得產生 \\* 跳脫');
```

`SHAPE_FROM_STEP_1` 與 `EXPECTED_WITHOUT_BACKSLASH` 用 Step 1 量到的**實際值**填入。

- [ ] **Step 5: 跑測試**

```bash
node test/inline-md.test.js > /tmp/t8.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t8.log
node test/paste-md.test.js > /tmp/t8b.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t8b.log
node test/roundtrip.test.js > /tmp/t8c.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t8c.log
node test/byte-stability.test.js > /tmp/t8d.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t8d.log
```

- [ ] **Step 6: Commit**

```bash
git add lib/editor/inline-md.js test/inline-md.test.js
git commit -m "fix(editor): a selection that starts next to a delimiter stops escaping it

The delimiter-length choice produced a backslash escape when the selection
began adjacent to one. v3.3.0 deliberately shipped no test for this: a test
asserting the wrong bytes of the day would have gone red on the real fix for
the wrong reason. The assertion added here pins the fixed shape."
```

---

