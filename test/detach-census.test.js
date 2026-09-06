'use strict';
// v3.2.1 detach census — 會 detach 聚焦編輯面的 DOM 寫入，逐一標註處置。
//
// ⚠ 這張表是【人工維護】的。處置 (b)（抑制該同步區間的 focusout）是呼叫
// 堆疊性質而非語彙性質 —— 實測 20 個站點只有 4 個在語彙上識別得出來，所以
// 沒有任何正則或無呼叫圖的語彙工具能自動判定歸屬。新增站點【不會】被自動
// 偵測；偵測責任在「用產品」的 review 席位與 code review。不要相信這個檔案
// 會替你抓到新站點，它只保證表上既有的每一項仍然存在且仍是所標註的種類。
//
// ⚠ 2026-09-06 審查追加的、比上一段更強的一條：這張表【出生時就可能不完整】，
// 不是只有「之後新增的站點會漏」而已。初版就漏了四個站點，而那四個在 v3.2.0
// （c50f20a）已經一字不差地存在 —— 逐 needle 數過：`editEl.innerHTML = state;`
// 在 c50f20a 與 HEAD 都是 2 個、`editEl.innerHTML = burst.original;` 都是 1 個、
// `textEl.innerHTML = '';` 都是 1 個。本分支一個新站點都沒加，是表本身生下來
// 就缺了四列。
//
// 漏法有名字，下一個維護者請【按名字】查：「收了 table 變體、漏了平版雙胞胎」。
// 初版收了 tableBurstUndo()/tableBurstRedo()，卻沒收與它們逐行對稱的
// burstUndo()/burstRedo()；也收了 revertBurstAndEnd() 的 `editEl.blur();`，
// 卻沒收【同一個函式裡更前面】那一行 `editEl.innerHTML = burst.original;`
// （那一列的「已先歸零」理由蓋不到它 —— 它跑在 `currentBurst = null;` 之前）。
// 補表時的機械檢查因此是兩題，兩題都答完才算收完一列：
//   Q1 這個函式有沒有 table / 非 table 的對稱雙胞胎？雙胞胎收了沒？
//   Q2 這個【函式裡】還有沒有第二行會寫 DOM 的敘述？本列記的是哪一行？
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8')
  .split('\n');

// { fn, needle, disposition, why }
// needle 必須是該行上可辨識的片段；行號刻意不入表（會漂移）。少數站點的
// needle 文字與另一個站點逐字相同（例如 restore()/commit() 都寫
// `blockEl.innerHTML = original;`，revertBurstAndEnd()/handleBurstKeydown()
// 都寫 `editEl.blur();`，burstUndo()/burstRedo() 都寫
// `editEl.innerHTML = state;`）—— 這是量測出來的事實（兩個函式真的共用那一行
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
  { fn: 'openRawViaGutter()', needle: 'dyingBurst.editEl.innerHTML = dyingBurst.original;', disposition: 'a',
    why: 'v3.2.1 Task 2：`currentBurst = null` 在這個 innerHTML 寫入之前已先執行（`dyingBurst = currentBurst; currentBurst = null;` 之後才寫 `dyingBurst.editEl.innerHTML =`）；table 重入分支的判斷式是 `currentBurst.blockType === \'table\'`，currentBurst 已為 null 時該分支不會匹配，與 restore()/commit() 同一種「先歸零再寫」樣式' },
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
    why: '同 deleteRow()/deleteColumn()（cell）：T12/T28 測到 .ed-te-menu 點擊已先把焦點移到存活的儲存格，這裡執行時焦點已經不在被砍的欄上，零 focusout' },
  { fn: 'removeListItem()', needle: 'blockEl.parentNode.removeChild(blockEl);', disposition: 'b',
    why: '(b) DYNAMIC —— 透過 `mutateListRun(() => removeListItem(li))`（呼叫端）開的 span 抑制；T9 測到 sup=[false,true]' },
  { fn: 'performListItemDrop()', needle: 'liEls.forEach((el) => { el.parentNode.insertBefore(el, refEl); });', disposition: 'b',
    why: '(b) lexical —— 在 mutateListRun() 的 callback 內；T20 測到 sup=[false,true]' },
  { fn: "handleLiKeydown() 空項目 Enter 的 outdent 分支（不是 removeListItem()）", needle: "textEl.innerHTML = '';", disposition: 'b+d',
    why: "(b) lexical —— 寫在同一個 mutateListRun(() => { ... }) callback 內（outdentListItem(li) 成功之後那一行），整段 suppressLiFocusout 為 true。同時也是 (d)：目標 textEl 就是聚焦的 .ed-li-text 本身，probe 驅動真實手勢（巢狀項目按到空、再按 Enter）實測【這一次賦值本身】零 focusout —— 該次按鍵唯一的 blur/focusout 出現在賦值【之後】，且緊接著一組 focus/focusin 把焦點放回同一顆 .ed-li-text。旁邊原始碼那句「an innerHTML assignment on the focused node triggers the very same Chromium unfocus quirk」與這次量測不符（對照組：直接對聚焦的 contenteditable 寫 innerHTML = '' 也沒有任何 focus 事件）；本列保留 (b) 不是因為那句話成立，而是因為這一行【確實】落在 span 內，而 span 對同 callback 內 outdentListItem() 的 DOM 搬移是必要的" },
  { fn: 'leaveSourceMode()', needle: 'ta.remove();', disposition: 'none',
    why: '`ta` 本身就是聚焦的 .ed-source；T33 測到 focusout，但 handler 沒有 `.ed-source` 分支可以匹配，目前無害純屬巧合' },
  { fn: 'enterSourceMode()', needle: 'contentEl.hidden = true;', disposition: 'none',
    why: 'T33：對聚焦的 .ed-wys-armed 造成的 focusout 沒有任何處置' },
  // v3.2.1 Task 8：applyPreviewEditability() 那一列（disposition 'none'，T34）
  // 已刪除 —— preview 模式連同該函式一併移除，站點不存在了，不是漏掉。
  // ── (c) 先移開焦點 ─────────────────────────────────────────────────────
  { fn: 'revertBurstAndEnd()', needle: 'editEl.blur();', disposition: 'a+c',
    why: 'T5：`currentBurst = null` 在它之前的同一個函式裡已先執行，所以 blur() 觸發的 focusout 帶 burst=null、無重入；檔案自己的鄰近註解也記載這是 (a)+(c) 組合站點。⚠ 本列【只】登記 blur() 這一行 —— 同函式更前面那行 `editEl.innerHTML = burst.original;` 跑在歸零【之前】，這個理由蓋不到它，它自己在下面 (d) 區另有一列' },
  { fn: 'handleBurstKeydown()', needle: 'editEl.blur();', disposition: 'c',
    why: '(c) —— Enter（非 Shift）走這裡；委派的 focusout handler 把它轉成 resolveBurst() 呼叫，僅列舉、未個別驅動測量' },
  // ── (d) 寫入的目標就是聚焦元素本身 —— 根本沒有 detach ───────────────────
  // (a)/(b)/(c) 三種處置都在回答同一個問題：「detach 觸發的同步 focusout 重入
  // commit 邏輯，怎麼擋？」(d) 的答案是【那個 focusout 從來沒發生過】。
  //
  // 非 table 的 burst，currentBurst.editEl 就是那顆唯一聚焦的 contenteditable
  // —— client.js 自己在 focusout handler 裡就這樣寫：「a table burst spans MANY
  // focusable cells (unlike paragraph/heading/list, where burst.editEl IS the
  // one focused surface)」。對它寫 innerHTML 只換掉【子樹】，聚焦元素自己沒有
  // 被移除，Chromium 那個「移除聚焦節點前先跑 unfocus 修正」的步驟因此不會跑。
  // 這正是 table 雙胞胎需要 (b) 而平版不需要的原因：tableBurstUndo() 的
  // tableEl 是整個 <table>、聚焦的是儲存格（會被 detach）；burstUndo() 的
  // editEl 就是聚焦面自己（不會）。
  //
  // 【怎麼確定的】不是推論，是驅動量測（一次性 probe，已刪除）：用
  // Object.defineProperty 把 innerHTML setter 包在 editEl 這一顆節點上，賦值
  // 前後各記一次 document.activeElement 與 Selection，另在 document 上掛 capture
  // 期的 focus / focusin / blur / focusout，並計數 /api/render 與 /api/save。
  // 五個情境全部同一個結果 —— 賦值前後 activeElement 不變、兩次記錄之間沒有任何
  // focus 事件、零網路請求：
  //   1. burst 中 Ctrl+Z（burstUndo）
  //   2. burst 中 Ctrl+Z 再 Ctrl+Y（burstRedo）
  //   3. burst 中 Escape（revertBurstAndEnd 的 innerHTML 寫入）
  //   4. 插入符停在 text node 第 5 個字元時的 Ctrl+Z（確認被 detach 的是子節點）
  //   5. 對照組：直接對聚焦的 .ed-wys-armed 寫 `innerHTML = ''`
  // 情境 3 該手勢唯一的 blur/focusout 來自四行之後那個明寫的 editEl.blur()，
  // 也就是下面倒數第二列已經登記的那個站點，而那時 currentBurst 已是 null。
  //
  // 【editEl === document.activeElement 這個前提本身也查了控制流】，不是假設：
  // handleBurstKeydown() 是這三個函式【唯一】的呼叫者（各一處，同一個 if 鏈），
  // 它傳進去的是 e.target.closest('.ed-wys-armed')，而且函式開頭就
  // `if (!currentBurst || currentBurst.editEl !== editEl) return;`；委派層在它
  // 【之前】先把 .ed-wys-cell 短路給 handleTableCellKeydown()，所以 table burst
  // 根本到不了這三個函式。連「點在 armed 面裡的行內 <a> 上」都實測過
  // （<a> 是可聚焦元素，是唯一想得到的反例）：activeElement 仍是 host。
  //
  // 【placeCaretAtEnd() 補的是插入符，不是焦點】。它的函式體只有
  // createRange / selectNodeContents / collapse(false) / removeAllRanges /
  // addRange，沒有呼叫 focus()。需要它是因為量到 Chromium 在 innerHTML 賦值後
  // 把選取塌成 (editEl, 0)：情境 4 裡插入符原本在 text node 的 offset 5，賦值後
  // 變成 host 的 offset 0，執行完 placeCaretAtEnd() 後是 offset 1（＝該面唯一
  // 子節點之後，selectNodeContents + collapse(false) 的結果）。所以 (d) 不是
  // 「寫完再重新聚焦」—— 焦點沒掉過；它是「寫完把插入符收回結尾」。
  // revertBurstAndEnd() 沒有這一行，因為它接著就 blur()。
  //
  // ⚠ (d) 的安全性【整個建立在「editEl 就是聚焦元素」上，而站點那一行自己看不
  // 出這件事】。哪天非 table 的 burst 讓 editEl 變成聚焦面的祖先（table burst
  // 的 editEl 就是整個 <table>），這三行程式碼一個字都不用改就變成貨真價實的
  // detach 站點、處置也就必須從 (d) 改成 (b)。動 startBurst() 的 editEl 語意、
  // 或讓 handleBurstKeydown() 接受非聚焦的 editEl 時，要回來重判這三列。
  { fn: 'burstUndo()（tableBurstUndo() 的平版雙胞胎）', needle: 'editEl.innerHTML = state;', disposition: 'd',
    why: '(d) —— editEl 是聚焦的 .ed-wys-armed 本身，賦值只換掉它的子樹；probe 情境 1/4 實測賦值前後 activeElement 不變、零 focus 事件、零 /api/render。下一行的 placeCaretAtEnd(editEl) 收的是被塌成 (editEl, 0) 的插入符（該函式沒呼叫 focus()），不是焦點。needle 與 burstRedo() 逐字相同 —— 兩個函式真的共用這一行內容' },
  { fn: 'burstRedo()（tableBurstRedo() 的平版雙胞胎）', needle: 'editEl.innerHTML = state;', disposition: 'd',
    why: '(d) —— 與 burstUndo() 逐行對稱（burst.history.redo() 取代 undo()），同樣寫在聚焦的 editEl 自己身上、同樣接一行 placeCaretAtEnd(editEl)；probe 情境 2 實測賦值前後 activeElement 不變、零 focus 事件、零 /api/render' },
  { fn: 'revertBurstAndEnd() 的 innerHTML 寫入（不是它下面那行 blur()）', needle: 'editEl.innerHTML = burst.original;', disposition: 'd',
    why: '(d) —— 這一行跑在同函式的 `currentBurst = null;` 【之前】（順序是 history.dispose() → innerHTML → currentBurst = null → ... → blur()），所以上面那列 blur() 站點「已先歸零」的理由蓋不到它；它安全的理由不同：editEl 就是聚焦面本身。probe 情境 3 實測 Escape 當下這次賦值零 focusout、磁碟未被寫，該手勢唯一的 blur/focusout 出現在賦值之後、來自那行明寫的 editEl.blur()。這裡沒有 placeCaretAtEnd() —— 它不需要插入符，下一步就是 blur' },
];

let checks = 0;
CENSUS.forEach((row) => {
  const hits = SRC.filter((l) => l.indexOf(row.needle) !== -1).length;
  assert.ok(hits >= 1,
    'census: ' + row.fn + ' 的寫入不見了（needle: ' + row.needle + '）—— ' +
    '若這是刻意移除，請一併從普查表刪除該列並在 commit message 說明。');
  checks++;
});

// 三個不變量，值都是【當下實數】而不是寬鬆下限 —— 這張表唯一的作用就是讓漂移
// 變吵，下限留白等於把漂移吞掉。任何一條紅了，都要先確認新站點的處置再改數字。
assert.strictEqual(CENSUS.filter((r) => r.disposition === 'a').length >= 6, true,
  'census: 處置 (a) 站點數少於 6 —— 原本是 6 個（applyFullRender / applyPatch / ' +
  'restore / commit / openRawViaGutter / revertTableBurstAndEnd；不含 a+c 的 ' +
  'revertBurstAndEnd()）。少了就是有人拿掉了一個「先清 session 再寫 DOM」的站點。');

// (d) 家族（純 d 與 b+d）。2026-09-06 補表補進來的四列就是這四個，數字釘住的是
// 「table 變體有、平版沒有」那個漏法不會再默默發生一次。
assert.strictEqual(CENSUS.filter((r) => r.disposition.indexOf('d') !== -1).length, 4,
  'census: (d) 家族應為 4 個站點（burstUndo / burstRedo / revertBurstAndEnd 的 ' +
  'innerHTML 寫入 / handleLiKeydown 空項目 Enter 的 textEl 清空）');

assert.strictEqual(CENSUS.length, 25,
  'census: 站點總數應為 25。新增或刪除站點時【一定要】連同這個數字一起改，並在 ' +
  'commit message 說明是哪一個站點 —— 這條斷言存在的唯一理由是讓「表悄悄變短或 ' +
  '變長」變成紅燈。');

console.log('detach-census.test.js OK (' + checks + ' sites)');
