'use strict';
const path = require('path');
const assert = require('assert');
const { renderMarkdown } = require('../lib/md2doc.js');
const { buildBlockMap } = require('../lib/editor/blockmap.js');

(async () => {
  // Extend fixture with a list containing a nested sublist and a task item, so
  // the id-sequence assertion exercises per-li twin-walk synchronization.
  const md = [
    '# T', '', 'para', '',
    '| A |', '|---|', '| 1 |', '',
    '```mermaid', 'graph TD; a-->b;', '```', '',
    '- item a', '  1. nested c', '- [x] done', '',
  ].join('\n');
  const fake = path.join(__dirname, 'fixture.md'); // path only used for SRC_DIR

  const plain = await renderMarkdown(md, fake, {});
  assert.ok(!plain.bodyHtml.includes('ed-block'),
    'non-edit render has no wrappers');

  const edit = await renderMarkdown(md, fake, { editMode: true });
  const ids = [...edit.bodyHtml.matchAll(/data-block-id="(\d+)"/g)]
    .map((m) => Number(m[1]));
  const map = buildBlockMap(md);
  assert.deepStrictEqual(ids, map.blocks.map((b) => b.id),
    'one wrapper per block, in order');
  assert.ok(edit.bodyHtml.includes('data-block-type="table"'));
  assert.strictEqual(edit.blocks.length, map.blocks.length);

  // unwrapped inner content equals the plain render's content
  const stripped = edit.bodyHtml
    .replace(/<div class="ed-block"[^>]*>/g, '')
    .replace(/<\/div>\n?(?=<div class="ed-block"|$)/g, '')
    .replace(/<div class="ed-li-text">/g, '');
  assert.ok(stripped.includes('<table') && plain.bodyHtml.includes('<table'),
    'table renders in both');
  // stripped must honestly mean "edit wrappers removed": no ed-block wrapper
  // may survive. S1: every block (list items included) is a <div class="ed-block">,
  // so the single div-unwrapping regex above covers them all.
  assert.ok(!/class="ed-block"/.test(stripped),
    'stripped must contain no ed-block wrappers (div OR li)');

  // re-init hook present in the full page script
  assert.ok(edit.html.includes('__md2docInitDiagrams'),
    'diagram init exposed for re-invocation');
  assert.ok(plain.html.includes('__md2docInitDiagrams') === false ||
            plain.html.includes('__md2docInitDiagrams'),
    'hook may exist in plain mode too — allowed either way');

  const mdRef = 'x [[ref-1, §2]] y\n\ntail\n';
  const e2 = await renderMarkdown(mdRef, fake, { editMode: true });
  assert.strictEqual(e2.blocks[0].startLine, 1);
  assert.strictEqual(e2.blocks[1].startLine, 3, '[[...]] must not shift lines');

  // Helper: render md in editMode and return bodyHtml.
  async function renderEdit(m) {
    const r = await renderMarkdown(m, fake, { editMode: true });
    return r.bodyHtml;
  }

  // --- S1: edit mode emits ONE FLAT .ed-block per list item ---------------
  // No <ul>/<ol> container, no <li> at all, no block nested inside a block.
  // Reader mode is unchanged and still nests.
  {
    const bodyHtml = await renderEdit('- Alpha\n  - Bravo\n- Charlie\n');
    assert.ok(!/<ul|<ol|<li/.test(bodyHtml),
      'edit mode must not emit list containers or <li> at all, got:\n' + bodyHtml);
    const blocks = bodyHtml.match(/data-block-type="li"/g) || [];
    assert.strictEqual(blocks.length, 3, 'three items = three blocks');
    assert.ok(/Bravo/.test(bodyHtml.split('data-indent="1"')[1] || ''),
      'the nested item carries data-indent="1"');
    assert.ok(/class="ed-li-marker"/.test(bodyHtml), 'every item draws its own marker');
  }

  // per-li ed-block attrs, in the canonical order, with the inline content
  // wrapped in .ed-li-text.
  const listHtml = await renderEdit('- **a** x\n- b\n  1. c');
  assert(!/<div class="ed-block" data-block-type="list"/.test(listHtml),
    'no list-container ed-block div');
  assert(/<div class="ed-block" data-block-id="0" data-block-type="li" data-list-type="ul" data-task="0" data-indent="0" data-run-start="1" data-list-start="1" style="--ed-indent:0">/.test(listHtml),
    'first li has correct ed-block attrs, got:\n' + listHtml);
  assert(/<div class="ed-li-text"><strong>a<\/strong> x<\/div>/.test(listHtml),
    'inline wrapped in ed-li-text');
  assert(/data-list-type="ol" data-task="0" data-indent="1"/.test(listHtml),
    'nested ol li attrs');

  // R1: --ed-indent (Task 5's padding hook) and data-run-start (Task 5's
  // ordered-counter reset hook) are emitted by the renderer even though no
  // CSS consumes them yet.
  assert(/data-indent="1" data-run-start="1" style="--ed-indent:1"/.test(listHtml),
    'the nested run\'s first item is a run start and carries --ed-indent');
  {
    // §3.8 rule (b): a same-depth list-type change opens a NEW run; rule (a):
    // a deeper item never breaks the run it is nested under.
    const h = await renderEdit('- a\n- b\n\n1. c\n1. d\n');
    const starts = (h.match(/data-run-start="1"/g) || []).length;
    assert.strictEqual(starts, 2, 'two runs = two run starts, got:\n' + h);
  }
  {
    const h = await renderEdit('1. a\n   1. x\n2. b\n');
    const starts = (h.match(/data-run-start="1"/g) || []).length;
    assert.strictEqual(starts, 2,
      'the outer run and the nested run each start exactly once, got:\n' + h);
    assert.ok(!/data-indent="0" data-run-start="1"[\s\S]*data-indent="0" data-run-start="1"/.test(h),
      'the second top-level item must NOT restart the run');
  }

  {
    // Rule (d): two ADJACENT top-level list TOKENS of the same type. §3.8's
    // three operational rules cannot separate them once the <ul> containers
    // are gone (both lists are data-indent="0" data-list-type="ul"), so the
    // renderer stamps data-list-start="1" on each token's first block. Without
    // it a run scan merges the two lists and a commit re-markers a list the
    // user never touched.
    const h = await renderEdit('- a\n* c\n');
    assert.strictEqual((h.match(/data-list-start="1"/g) || []).length, 2,
      'each top-level list token stamps its own first block, got:\n' + h);
    assert.strictEqual((h.match(/data-run-start="1"/g) || []).length, 2,
      'a new list token also opens a new run');
  }
  {
    // ...and a single list must stamp exactly ONE list start, however deeply
    // it nests.
    const h = await renderEdit('- a\n  - b\n    1. c\n- d\n');
    assert.strictEqual((h.match(/data-list-start="1"/g) || []).length, 1,
      'one list token = one data-list-start, got:\n' + h);
  }

  // task li renders check chrome between the marker and ed-li-text, and
  // carries BOTH axes (data-list-type AND data-task).
  const taskHtml = await renderEdit('- [x] done');
  assert(/<span class="ed-li-marker" aria-hidden="true"><\/span><span class="ed-li-check" data-checked="1" role="checkbox" aria-checked="true"><\/span><div class="ed-li-text">done<\/div>/.test(taskHtml),
    'task check span sits between the marker and ed-li-text, got:\n' + taskHtml);
  assert(/data-task="1"/.test(taskHtml), 'a task item carries data-task="1"');

  // UNCHECKED task item: data-checked="0" / aria-checked="false" (the checked
  // case above alone leaves the unchecked branch of the check chrome untested)
  const uncheckedHtml = await renderEdit('- [ ] todo');
  assert(/<span class="ed-li-check" data-checked="0" role="checkbox" aria-checked="false"><\/span><div class="ed-li-text">todo<\/div>/.test(uncheckedHtml),
    'unchecked task check span carries data-checked="0" / aria-checked="false"');

  // ORDERED task item: both axes at once (RULING F-N).
  const olTaskHtml = await renderEdit('1. [ ] todo\n');
  assert(/data-list-type="ol"/.test(olTaskHtml) && /data-task="1"/.test(olTaskHtml),
    'ordered task items carry BOTH axes');
  assert(/class="ed-li-check"/.test(olTaskHtml), 'task items keep their checkbox span');

  // ORDERED list with a non-1 `start`: spec §3.8 deliberately DISCARDS `start`
  // (the flat model has no <ol> left to carry it), so the only thing that must
  // survive is that the items are ordered li blocks.
  const olStartHtml = await renderEdit('3. third\n4. fourth');
  assert(!/<ol/.test(olStartHtml), 'no <ol> container survives flattening');
  assert(/data-list-type="ol"/.test(olStartHtml),
    'the non-1-start ol items are still per-li ol blocks');

  // loose list: <p> must be preserved inside ed-li-text (RULING F-L)
  const looseHtml = await renderEdit('- a\n\n- b');
  assert(/<div class="ed-li-text"><p>a<\/p>/.test(looseHtml),
    'loose list keeps <p> in ed-li-text');

  // reader mode untouched
  {
    const { bodyHtml } = await renderMarkdown('- Alpha\n  - Bravo\n', fake, {});
    assert.ok(/<ul>/.test(bodyHtml) && /<li>/.test(bodyHtml), 'reader mode still nests');
  }

  console.log('editmode-render.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
