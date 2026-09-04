'use strict';
const assert = require('assert');
const { stripBlockId, patchmap } = require('../lib/editor/patchmap.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };

// 產生一個 part 字串，形狀與 md2doc.js:911 相同
const P = (id, type, body) =>
  `<div class="ed-block" data-block-id="${id}" data-block-type="${type}">\n${body}\n</div>`;
const B = (id, type, startLine, endLine) => ({ id, type, startLine, endLine });

// ── stripBlockId ────────────────────────────────────────────────
eq(stripBlockId(P(3, 'paragraph', '<p>a</p>')),
   '<div class="ed-block" data-block-type="paragraph">\n<p>a</p>\n</div>',
   'stripBlockId 只剔除 data-block-id，其餘原樣');
eq(stripBlockId('<div data-block-id="0" data-block-id="11">'), '<div>',
   'stripBlockId 是 global 的');

// ── 案例 1：就地改一段，區塊數不變 ───────────────────────────────
{
  const oldParts = [P(0, 'heading', '<h1>H</h1>'), P(1, 'paragraph', '<p>a</p>'), P(2, 'paragraph', '<p>c</p>')];
  const newParts = [P(0, 'heading', '<h1>H</h1>'), P(1, 'paragraph', '<p>b</p>'), P(2, 'paragraph', '<p>c</p>')];
  const oldBlocks = [B(0, 'heading', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5)];
  const newBlocks = [B(0, 'heading', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5)];
  const r = patchmap({ oldBlocks, newBlocks, oldParts, newParts, editRange: { startLine: 3, endLine: 3, delta: 0 } });
  eq(r.keepPrefix, 1, '案例1 前綴 1');
  eq(r.keepSuffix, 1, '案例1 後綴 1');
  eq(r.replaceSpan.oldStart, 1, '案例1 中段起於 1');
  eq(r.replaceSpan.oldEnd, 1, '案例1 中段止於 1');
  eq(r.replaceSpan.newParts, [newParts[1]], '案例1 中段新 parts');
  eq(r.idDelta, 0, '案例1 idDelta 0');
}

// ── 案例 2：中間插入一段，區塊數 +1（剔除 data-block-id 才留得住後綴）──
{
  const oldParts = [P(0, 'heading', '<h1>H</h1>'), P(1, 'paragraph', '<p>a</p>'), P(2, 'paragraph', '<p>c</p>')];
  const newParts = [P(0, 'heading', '<h1>H</h1>'), P(1, 'paragraph', '<p>a</p>'),
                    P(2, 'paragraph', '<p>NEW</p>'), P(3, 'paragraph', '<p>c</p>')];
  const oldBlocks = [B(0, 'heading', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5)];
  const newBlocks = [B(0, 'heading', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5), B(3, 'paragraph', 7, 7)];
  const r = patchmap({ oldBlocks, newBlocks, oldParts, newParts, editRange: { startLine: 5, endLine: 4, delta: 2 } });
  eq(r.keepPrefix, 2, '案例2 前綴 2');
  eq(r.keepSuffix, 1, '案例2 後綴 1（靠剔除 data-block-id 才成立）');
  eq(r.replaceSpan.newParts, [newParts[2]], '案例2 中段恰為新插入那一段');
  eq(r.idDelta, 1, '案例2 idDelta +1');
}

// ── 案例 3：插入型提交（op 倒置區間，中段寬度 0）─────────────────
{
  const oldParts = [P(0, 'paragraph', '<p>a</p>')];
  const newParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>NEW</p>')];
  const oldBlocks = [B(0, 'paragraph', 1, 1)];
  const newBlocks = [B(0, 'paragraph', 1, 1), B(1, 'paragraph', 3, 3)];
  const r = patchmap({ oldBlocks, newBlocks, oldParts, newParts, editRange: { startLine: 2, endLine: 1, delta: 2 } });
  eq(r.keepPrefix, 1, '案例3 前綴 1');
  eq(r.keepSuffix, 0, '案例3 後綴 0');
  eq(r.replaceSpan.oldEnd, r.replaceSpan.oldStart - 1, '案例3 中段是寬度 0 的插入點');
  eq(r.replaceSpan.newParts, [newParts[1]], '案例3 中段新 parts');
}

// ── 案例 4：刪除，區塊數 -1 ─────────────────────────────────────
{
  const oldParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>b</p>'), P(2, 'paragraph', '<p>c</p>')];
  const newParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>c</p>')];
  const oldBlocks = [B(0, 'paragraph', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5)];
  const newBlocks = [B(0, 'paragraph', 1, 1), B(1, 'paragraph', 3, 3)];
  const r = patchmap({ oldBlocks, newBlocks, oldParts, newParts, editRange: { startLine: 3, endLine: 3, delta: -2 } });
  eq(r.keepPrefix, 1, '案例4 前綴 1');
  eq(r.keepSuffix, 1, '案例4 後綴 1');
  eq(r.replaceSpan.newParts, [], '案例4 中段沒有新 parts');
  eq(r.idDelta, -1, '案例4 idDelta -1');
}

// ── 案例 5：檔頭編輯（無前綴）與檔尾編輯（無後綴）────────────────
{
  const mk = (bodies) => bodies.map((b, i) => P(i, 'paragraph', `<p>${b}</p>`));
  const bl = (n) => Array.from({ length: n }, (_, i) => B(i, 'paragraph', i * 2 + 1, i * 2 + 1));
  const head = patchmap({
    oldBlocks: bl(3), newBlocks: bl(3),
    oldParts: mk(['a', 'b', 'c']), newParts: mk(['Z', 'b', 'c']),
    editRange: { startLine: 1, endLine: 1, delta: 0 },
  });
  eq(head.keepPrefix, 0, '檔頭編輯無前綴');
  eq(head.keepSuffix, 2, '檔頭編輯後綴 2');
  const tail = patchmap({
    oldBlocks: bl(3), newBlocks: bl(3),
    oldParts: mk(['a', 'b', 'c']), newParts: mk(['a', 'b', 'Z']),
    editRange: { startLine: 5, endLine: 5, delta: 0 },
  });
  eq(tail.keepPrefix, 2, '檔尾編輯前綴 2');
  eq(tail.keepSuffix, 0, '檔尾編輯無後綴');
}

// ── 案例 6：整份置換（無前綴無後綴）─────────────────────────────
{
  const oldParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>b</p>')];
  const newParts = [P(0, 'paragraph', '<p>X</p>'), P(1, 'paragraph', '<p>Y</p>')];
  const bl = [B(0, 'paragraph', 1, 1), B(1, 'paragraph', 3, 3)];
  const r = patchmap({ oldBlocks: bl, newBlocks: bl, oldParts, newParts, editRange: { startLine: 1, endLine: 3, delta: 0 } });
  eq(r.keepPrefix, 0, '整份置換無前綴');
  eq(r.keepSuffix, 0, '整份置換無後綴');
  eq(r.replaceSpan.newParts.length, 2, '整份置換中段含全部新 parts');
}

// ── 案例 7：widen —— 中段不連續時取涵蓋區間 ─────────────────────
{
  const oldParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>b</p>'),
                    P(2, 'paragraph', '<p>c</p>'), P(3, 'paragraph', '<p>d</p>')];
  const newParts = [P(0, 'paragraph', '<p>a</p>'), P(1, 'paragraph', '<p>B</p>'),
                    P(2, 'paragraph', '<p>c</p>'), P(3, 'paragraph', '<p>D</p>')];
  const bl = [B(0, 'paragraph', 1, 1), B(1, 'paragraph', 3, 3), B(2, 'paragraph', 5, 5), B(3, 'paragraph', 7, 7)];
  const r = patchmap({ oldBlocks: bl, newBlocks: bl, oldParts, newParts, editRange: { startLine: 3, endLine: 7, delta: 0 } });
  eq(r.keepPrefix, 1, 'widen 前綴 1');
  eq(r.keepSuffix, 0, 'widen 後綴 0（最後一項不符）');
  eq(r.replaceSpan.oldStart, 1, 'widen 中段自 1 起');
  eq(r.replaceSpan.oldEnd, 3, 'widen 中段涵蓋到 3，中間沒變的 c 一併重繪');
}

// ── 案例 8：Blocker 2 —— data-list-start 消失/長出必須 widen ─────
{
  const li = (id, extra) =>
    `<div class="ed-block" data-block-id="${id}" data-block-type="li"${extra} data-indent="0">\n<span>x</span>\n</div>`;
  const oldParts = [li(0, ''), li(1, ' data-list-start="1"')];
  const newParts = [li(0, ''), li(1, '')];
  const bl = [B(0, 'li', 1, 1), B(1, 'li', 3, 3)];
  const r = patchmap({ oldBlocks: bl, newBlocks: bl, oldParts, newParts, editRange: { startLine: 1, endLine: 1, delta: 0 } });
  eq(r.keepSuffix, 0, 'data-list-start 消失必須 widen —— 剔除 data-block-id 不會掩蓋它');
}

// ── 案例 9：結構守衛失敗回 null ─────────────────────────────────
{
  const bl = [B(0, 'paragraph', 1, 1)];
  eq(patchmap({ oldBlocks: bl, newBlocks: bl, oldParts: ['a', 'b'], newParts: ['a'], editRange: {} }), null,
     'oldParts.length !== oldBlocks.length 回 null');
  eq(patchmap({ oldBlocks: bl, newBlocks: bl, oldParts: ['a'], newParts: ['a', 'b'], editRange: {} }), null,
     'newParts.length !== newBlocks.length 回 null');
  eq(patchmap({ oldBlocks: bl, newBlocks: bl, oldParts: null, newParts: ['a'], editRange: {} }), null,
     'oldParts 不存在（首次載入）回 null');
}

console.log(`patchmap.test.js OK (${checks} checks)`);
