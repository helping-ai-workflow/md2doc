'use strict';
// v3.2.1 detach census — 會 detach 聚焦編輯面的 DOM 寫入，逐一標註處置。
//
// ⚠ 這張表是【人工維護】的。處置 (b)（抑制該同步區間的 focusout）是呼叫
// 堆疊性質而非語彙性質 —— 實測 20 個站點只有 4 個在語彙上識別得出來，所以
// 沒有任何正則或無呼叫圖的語彙工具能自動判定歸屬。新增站點【不會】被自動
// 偵測；偵測責任在「用產品」的 review 席位與 code review。不要相信這個檔案
// 會替你抓到新站點，它只保證表上既有的每一項仍然存在且仍是所標註的種類。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8')
  .split('\n');

// { fn, needle, disposition, why }
// needle 必須是該行上可辨識的片段；行號刻意不入表（會漂移）。少數站點的
// needle 文字與另一個站點逐字相同（例如 restore()/commit() 都寫
// `blockEl.innerHTML = original;`，revertBurstAndEnd()/handleBurstKeydown()
// 都寫 `editEl.blur();`）—— 這是量測出來的事實（兩個函式真的共用那一行
// 逐字內容），不是抄寫錯誤；hits >= 1 的斷言容許這種情況，不強求 hits === 1。
const CENSUS = [
  // ── (a) 先清 session 再寫 DOM ──────────────────────────────────────────
  { fn: 'applyFullRender()', needle: "contentEl.innerHTML = j.parts.join('\\n');", disposition: 'a',
    why: 'fallback 全量置換；v3.2.1 Task 3 把 activeEditor 清除上移到它之前。currentBurst 在兩種情況下都未覆蓋 —— branch1/branch3 的 7 個重入實測靠 switching 單飛快取遮蓋，不是靠這次的 teardown 順序關閉' },
  { fn: 'applyPatch()', needle: 'contentEl.removeChild(children[i]);', disposition: 'a',
    why: '只移除 replaceSpan；activeEditor teardown 是條件式（`document.body.contains(blockEl) && blockEl.querySelector(\'.ed-raw\')`）且必須在 DOM patch 之後求值，不得比照 Task 3 上移' },
  { fn: 'openRawEditor()', needle: "blockEl.innerHTML = '';", disposition: 'none',
    why: 'UNMEASURED as a detacher —— 37 次驅動手勢裡這裡永遠是在 activeElement === BODY 時執行到的（T35, G2），不需要處置' },
  { fn: 'restore()', needle: 'blockEl.innerHTML = original;', disposition: 'a',
    why: 'Escape/✕ 丟棄；這是 R1 —— T1 disk 落到 "Hello paraXYZ"、T37 disk 落到 "| one | two |TTT"，REENTRY branch6 兩次都是 ae=true。v3.2.1 Task 1 把 activeEditor 清除上移到它之前' },
  { fn: 'commit()', needle: 'blockEl.innerHTML = original;', disposition: 'a',
    why: '`activeEditor = null` 在寫入之前；T32 測到 focusout 落在 ed-cancel、無分支匹配、disk 乾淨' },
  { fn: 'openRawViaGutter()', needle: 'dyingBurst.editEl.innerHTML = dyingBurst.original;', disposition: 'none',
    why: 'v3.2.1 Task 2；VARIANT B 測到 focusout -> REENTRY branch1，baseline 則因按鈕 mousedown 已先搬走焦點而在 BODY 上執行、不需要處置' },
  { fn: 'revertTableBurstAndEnd()', needle: 'tableEl.innerHTML = burst.original;', disposition: 'a',
    why: 'T6：focusout 帶 burst=null，無重入' },
  { fn: 'tableBurstUndo()', needle: 'tableEl.innerHTML = state;', disposition: 'b',
    why: '(b) lexical —— 在 suppressTableFocusout = true/false 這對指派之間；T3 測到 sup=[true,false]' },
  { fn: 'tableBurstRedo()', needle: 'tableEl.innerHTML = state;', disposition: 'b',
    why: '(b) lexical —— 同一個 suppressTableFocusout span；T3 測到 sup=[true,false]' },
  { fn: 'retagCell()', needle: 'next.appendChild(cell.firstChild);', disposition: 'b',
    why: '(b) DYNAMIC —— 只有透過呼叫者 rebuildTableSections()（再上一層 performRowDrop()）開的 suppressTableFocusout span 才被抑制，本身不在任何 span 的語彙範圍內' },
  { fn: 'rebuildTableSections()', needle: '(i === 0 ? thead : tbody).appendChild(row);', disposition: 'b',
    why: '(b) DYNAMIC —— T13 測到 sup=[true,false]；detach 的寫入是這一行而非 performRowDrop() 自己的程式碼' },
  { fn: 'performColDrop()', needle: 'cells.forEach((c) => row.appendChild(c));', disposition: 'b',
    why: '(b) lexical —— 在自己的 suppressTableFocusout = true/false 之間；T18 測到 sup=[true,false]' },
  { fn: 'deleteRow()', needle: 'rowEl.parentElement.removeChild(rowEl);', disposition: 'none',
    why: 'T12/T28：.ed-te-menu 點擊先把焦點移到存活的儲存格，這裡執行時焦點已經不在被砍的列上，零 focusout' },
  { fn: 'deleteColumn()', needle: 'if (cell) row.removeChild(cell);', disposition: 'none',
    why: '同 deleteRow()：T12/T28 測到焦點在點擊當下已先移出被砍的欄，這裡執行時零 focusout' },
  { fn: 'deleteColumn()', needle: 'cg.removeChild(cg.children[colIndex]);', disposition: 'none',
    why: 'colgroup 的 <col> 從不可聚焦（同一份量測也用來排除 8741 reorderColgroup），這一行本身不可能 detach 任何聚焦節點' },
  { fn: 'removeListItem()', needle: 'blockEl.parentNode.removeChild(blockEl);', disposition: 'b',
    why: '(b) DYNAMIC —— 透過 `mutateListRun(() => removeListItem(li))`（呼叫端）開的 span 抑制；T9 測到 sup=[false,true]' },
  { fn: 'performListItemDrop()', needle: 'liEls.forEach((el) => { el.parentNode.insertBefore(el, refEl); });', disposition: 'b',
    why: '(b) lexical —— 在 mutateListRun() 的 callback 內；T20 測到 sup=[false,true]' },
  { fn: 'leaveSourceMode()', needle: 'ta.remove();', disposition: 'none',
    why: '`ta` 本身就是聚焦的 .ed-source；T33 測到 focusout，但 handler 沒有 `.ed-source` 分支可以匹配，目前無害純屬巧合' },
  { fn: 'enterSourceMode()', needle: 'contentEl.hidden = true;', disposition: 'none',
    why: 'T33：對聚焦的 .ed-wys-armed 造成的 focusout 沒有任何處置' },
  { fn: 'applyPreviewEditability()', needle: "surfaces[i].setAttribute('contenteditable', editable ? 'true' : 'false');", disposition: 'none',
    why: 'T34：focusout -> REENTRY branch3（synthetic focus）；在出貨的模式循環裡不會與存活的 burst 同時發生，故未觀察到有害後果' },
  // ── (c) 先移開焦點 ─────────────────────────────────────────────────────
  { fn: 'revertBurstAndEnd()', needle: 'editEl.blur();', disposition: 'a+c',
    why: 'T5：`currentBurst = null` 在它之前的同一個函式裡已先執行，所以 blur() 觸發的 focusout 帶 burst=null、無重入；檔案自己的鄰近註解也記載這是 (a)+(c) 組合站點' },
  { fn: 'handleBurstKeydown()', needle: 'editEl.blur();', disposition: 'c',
    why: '(c) —— Enter（非 Shift）走這裡；委派的 focusout handler 把它轉成 resolveBurst() 呼叫，僅列舉、未個別驅動測量' },
];

let checks = 0;
CENSUS.forEach((row) => {
  const hits = SRC.filter((l) => l.indexOf(row.needle) !== -1).length;
  assert.ok(hits >= 1,
    'census: ' + row.fn + ' 的寫入不見了（needle: ' + row.needle + '）—— ' +
    '若這是刻意移除，請一併從普查表刪除該列並在 commit message 說明。');
  checks++;
});

assert.strictEqual(CENSUS.filter((r) => r.disposition === 'a').length >= 4, true,
  'census: 處置 (a) 至少應有四個站點');

console.log('detach-census.test.js OK (' + checks + ' sites)');
