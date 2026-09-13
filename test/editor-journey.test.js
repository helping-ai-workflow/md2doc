'use strict';
// v3.2.1 journey tier — 斷言「一個人感知到什麼」，不斷言內部不變量。
// 四個感知軸：游標在哪 / 還能點什麼 / 磁碟上是什麼 / 螢幕上寫什麼。
// 刻意與 test/editor-client-runtime.test.js（機制層）分開：那一層綠著
// 而這六個缺陷全部出貨，就是分層的理由。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');
const { createEditorServer } = require('../lib/editor/server.js');
const { renderMarkdown } = require('../lib/md2doc.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'editor', 'client.js'), 'utf8');

let browser;

// `extraFiles` (optional): { 'name.drawio': '<xml…>' } written next to doc.md
// BEFORE the server renders it. Added for the v3.4.0 batch2 Task 6 rows at the
// end of this file, which need a real referenced file on disk to rewrite from
// outside the editor. Every existing call site passes one argument and is
// unaffected.
async function boot(mdText, extraFiles, srvOpts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-journey-'));
  const mdPath = path.join(dir, 'doc.md');
  if (extraFiles) {
    for (const name of Object.keys(extraFiles)) {
      fs.writeFileSync(path.join(dir, name), extraFiles[name], 'utf8');
    }
  }
  fs.writeFileSync(mdPath, mdText, 'utf8');
  // createEditorServer() takes a single options object ({ files, clientJs,
  // idleTimeoutMs, listenPort }), not the (paths, opts) shape the original
  // sketch assumed — see lib/editor/server.js. It returns
  // { server, port, urlFor(absPath), close() }, no bare `.url`/`.port`
  // shortcut on the caller's side; the URL for a given file comes from
  // urlFor(), which maps the resolved path back to its /edit/:id index.
  // `srvOpts` is merged LAST and is opt-in per scenario. Fix round 2
  // (re-review G10): the Task 6 rows at the end of this file want a longer
  // idle timeout (they deliberately sit still for two real 10s heartbeats),
  // and round 1 put that straight into this shared helper — silently
  // reconfiguring the server for ~60 pre-existing scenarios that had been
  // running against the production 30s default. Every other scenario now gets
  // exactly the server it got before.
  const srv = await createEditorServer(Object.assign({
    files: [mdPath], clientJs: CLIENT_SRC,
  }, srvOpts || {}));
  const url = srv.urlFor(mdPath);
  return { srv, url, mdPath, dir };
}

async function newPage(mdText, extraFiles, srvOpts) {
  const b = await boot(mdText, extraFiles, srvOpts);
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // v3.2.1 fix round 2, item 1 — this replaces a comment that claimed the
  // harness was BLIND to unhandled rejections. That claim was false and is
  // retracted. What is true, and what this listener is actually for:
  //
  // Several handlers in client.js are async and several call sites drop the
  // promise — buildSelToolbar()'s 🔗 button calls applyLinkToggle() without
  // awaiting or catching it — so a throw inside one becomes an unhandled
  // rejection rather than a synchronous throw. MEASURED on this repo's
  // puppeteer (24.42.0), by injecting a throw into applyLinkToggle() and
  // firing it through that very button:
  //
  //   listener REMOVED  errs = ["pageerror: Error: PROBE_INJECTED_THROW"]
  //   listener PRESENT  errs = ["unhandledrejection: Error: PROBE_INJECTED_THROW",
  //                             "pageerror: Error: PROBE_INJECTED_THROW"]
  //
  // So `page.on('pageerror')` ALREADY delivers it: puppeteer feeds that event
  // from CDP `Runtime.exceptionThrown`, which reports unhandled promise
  // rejections too — it is not `window.onerror`. The existing
  // `assert.strictEqual(ctx.errs.length, 0, …)` assertions were never blind to
  // this class.
  //
  // What the listener buys is therefore narrower than "coverage": it is an
  // explicit, LABELLED net owned by this file. The `unhandledrejection:` prefix
  // names the mechanism in the failure message, and the net does not depend on
  // the CDP client's exception mapping staying as it is across a puppeteer
  // upgrade. Cost: the same throw is now reported twice — irrelevant to an
  // `=== 0` assertion, visible in its message.
  //
  // The binding pushes into the SAME `errs` array `pageerror` feeds, so no
  // scenario needs changing. It arrives over CDP, i.e. asynchronously — a
  // rejection thrown in the same tick as an assertion can miss it. Every
  // scenario here already waits after its gesture, so in practice it lands;
  // this is a net, not a barrier.
  await page.exposeFunction('__journeyRejection', (msg) => { errs.push(msg); });
  // Which /api/save requests have been STARTED and which have COMPLETED.
  //
  // `saveAndRead()` below used to be a flat `setTimeout(400)`, which is weaker
  // than the quiescence wait that test/editor-client-runtime.test.js's R10 fix
  // condemned: Ctrl+S does not issue the save directly — the client resolves
  // whatever is open with `switchAwayFrom()` and calls `save()` only in that
  // promise's `.then` — so the 400 ms covers the dispatch only while the box is
  // idle. MEASURED in this session on the sibling suite: an unloaded save takes
  // ~249 ms end to end, so 400 ms is ~150 ms of margin for a commit, a render
  // and a save, and under load the read lands before the write. A positive
  // assertion then reds on correct product code; the assertions that pin a file
  // as UNCHANGED pass vacuously, which is worse.
  //
  // Ids rather than a count: a `/api/save` already in flight when the snapshot
  // is taken would satisfy a counter (measured on the sibling suite — released
  // after 1193 ms on the wrong save), so a waiter asks for an id GREATER than
  // the sequence it saw before it pressed.
  //
  // Only /api/save is wrapped. The render counter this suite never had is not
  // needed for this, and wrapping less keeps the page's own timing untouched.
  await page.evaluateOnNewDocument(() => {
    window.__edSaveSeq = 0;
    window.__edSaveLanded = [];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === 'string' ? input : (input && input.url) || '');
      if (!/\/api\/save\b/.test(url)) return origFetch.call(this, input, init);
      const id = ++window.__edSaveSeq;
      let settled = false;
      const settle = () => { if (!settled) { settled = true; window.__edSaveLanded.push(id); } };
      return origFetch.call(this, input, init).then((res) => {
        // Released when the BODY has been read — or, for the 409 branch that
        // answers off the status alone and never touches the body, by a clone
        // armed alongside it. Both are strictly after the server has answered.
        let asked = false;
        ['json', 'text', 'arrayBuffer', 'blob', 'formData'].forEach((m) => {
          if (typeof res[m] !== 'function') return;
          const orig = res[m].bind(res);
          res[m] = function () {
            asked = true;
            return orig().then((v) => { settle(); return v; }, (e) => { settle(); throw e; });
          };
        });
        try {
          const arm = () => { if (!asked) settle(); };
          res.clone().arrayBuffer().then(() => setTimeout(arm, 0), () => setTimeout(arm, 0));
        } catch (e) { settle(); }
        return res;
      }, (err) => { settle(); throw err; });
    };
  });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      const msg = 'unhandledrejection: ' + String((r && (r.stack || r.message)) || r);
      if (window.__journeyRejection) window.__journeyRejection(msg);
    });
  });
  await page.goto(b.url, { waitUntil: 'networkidle0' });
  return Object.assign({ page, errs }, b);
}

// ── v3.2.1 second wave (N2): the primed/unprimed axis ──────────────────────
//
// `lastParts` is null until the first render lands, so the FIRST commit after a
// page load always takes the FALLBACK route and every commit after it takes the
// PATCH route. The two routes restore focus and tear the toolbar down in a
// DIFFERENT ORDER, so a scenario that only ever measures the first commit is
// measuring the route a real session almost never uses.
//
// This is not a new lesson: test/editor-client-runtime.test.js Case 1 already
// writes it down —「the first commit after a page load always falls back …
// asserting on THAT commit would silently test the fallback」— and the first fix
// wave's V2g / V2h / V2d were built without it. C1 (a refusal keeping its caret
// but losing the whole toolbar) is invisible on the fallback route and ordinary
// on the patch route, and it shipped past both the fix and its own new tests.
//
// Every scenario below that measures a post-commit landing therefore runs TWICE.
// `primeOneCommit()` spends the fallback commit on a paragraph the scenario does
// not touch; `installPatchSpy()` + `patchRoutes()` then PROVE the gesture under
// test really took the patch route, so a primed variant that silently degrades
// back to the fallback fails instead of going quietly green.
async function primeOneCommit(ctx) {
  const t = await ctx.page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
      .find((b) => (b.textContent || '').indexOf('Tail para two') !== -1);
    if (!el) throw new Error('primeOneCommit: fixture has no 「Tail para two」 paragraph to commit');
    return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
  });
  await ctx.page.click(t + ' .ed-wys-armed');
  await new Promise((r) => setTimeout(r, 200));
  await ctx.page.keyboard.type(' PRIMED');
  await new Promise((r) => setTimeout(r, 200));
  await ctx.page.keyboard.press('Enter');   // blur → commit → render
  await new Promise((r) => setTimeout(r, 900));
}
// Two counters, because "did this render patch?" needs both halves:
//   * `renders`  — every POST to /api/render. A render that FELL BACK never
//                  calls patchmap at all (applyRenderResult() short-circuits on
//                  `lastParts`/`domMatchesLastRender()` first), so it is
//                  invisible to the patchmap spy and only shows up here.
//   * `plans`    — one entry per patchmap call, true when it produced a plan.
// Install AFTER priming, so only the gesture under test is recorded.
async function installPatchSpy(ctx) {
  await ctx.page.evaluate(() => {
    window.__plans = [];
    window.__renders = 0;
    const origPm = window.md2docPatchmap.patchmap;
    window.md2docPatchmap.patchmap = function (input) {
      const r = origPm(input);
      window.__plans.push(!!r);
      return r;
    };
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).indexOf('/api/render') !== -1) window.__renders++;
      return origFetch.apply(this, arguments);
    };
  });
}
const patchRoutes = (ctx) => ctx.page.evaluate(() =>
  ({ plans: (window.__plans || []).slice(), renders: window.__renders || 0 }));
// A gesture can issue MORE THAN ONE render (⠿ / Tab first resolve the open
// burst through switchAwayFrom(), which commits and renders, and only then run
// their own commit) — measured: an unprimed H2 + Tab issues two, the first a
// fallback and the second already a patch. So the assertions are about what the
// run CONTAINS, not about a single route:
//   primed    at least one render actually patched — otherwise the primed
//             variant has silently degraded into a second copy of the unprimed
//             one and C1's whole class is untested again.
//   unprimed  at least one render did NOT consult patchmap, i.e. fell back.
//             That is the route this file measured exclusively before N2, and
//             keeping a row on it is what makes the pair a PAIR.
const assertRoute = (r, primed, where) => {
  if (primed) {
    assert.ok(r.plans.some(Boolean),
      where + '(primed) 前提失敗：這次手勢的 render 沒有任何一發走 patch 路徑 —— ' +
      'primed 變體因此退化成 unprimed，C1 那一類缺陷就測不到了，got ' + JSON.stringify(r));
  } else {
    assert.ok(r.renders > r.plans.length,
      where + '(unprimed) 前提失敗：每一發 render 都問過 patchmap，' +
      '也就是沒有任何一發走 fallback —— 這一列就不再是 fallback 路徑的覆蓋，got ' +
      JSON.stringify(r));
  }
};

/**
 * Press Ctrl+S and return once THAT save has landed.
 *
 * See the instrumentation in `newPage()` for why a fixed sleep was the wrong
 * shape. Never returns silently on a timeout: the one documented path where
 * Ctrl+S issues no save at all is a commit that failed, and that path has
 * already put a banner on screen — anything else is a real defect and reading
 * the file past it would report it as "the gesture did nothing".
 */
async function pressSaveAndLand(ctx) {
  const startedBefore = await ctx.page.evaluate(() => window.__edSaveSeq || 0);
  await ctx.page.keyboard.down('Control');
  await ctx.page.keyboard.press('KeyS');
  await ctx.page.keyboard.up('Control');
  try {
    await ctx.page.waitForFunction(
      (n) => (window.__edSaveLanded || []).some((id) => id > n),
      { timeout: 15000 }, startedBefore);
  } catch (e) {
    const banner = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-conflict');
      return el ? (el.textContent || '') : null;
    });
    if (banner === null) {
      throw new Error('pressSaveAndLand: Ctrl+S produced no completed /api/save in 15s, ' +
        'and no banner explains why — the save really did not happen. ' +
        'Original: ' + (e && e.message));
    }
  }
  // The paint/settle grace the old fixed sleep also provided, kept because some
  // rows read the DOM — a banner, a title — straight after the save rather than
  // the file. The old shape slept a flat 400 ms from the KEYPRESS, so on a
  // landing measured at 181 ms it left ~220 ms of post-response settle; 150 ms
  // would have been a small regression for exactly those rows, on exactly the
  // loaded box this whole change is about. 250 ms restores that margin and the
  // helper is still event-driven overall (it leaves as soon as the save lands
  // plus this, instead of always sleeping 400 ms).
  await new Promise((r) => setTimeout(r, 250));
}

async function saveAndRead(ctx) {
  await pressSaveAndLand(ctx);
  return fs.readFileSync(ctx.mdPath, 'utf8');
}

// 螢幕上那條 banner 的文字，看不見時回 null。
//
// 【不要】改回 task-5 brief 寫的 `b.offsetParent !== null`：`.ed-conflict` 是
// position: fixed（lib/md2doc.js 的 `.ed-conflict` 規則），而 offsetParent 對
// fixed 元素永遠回 null。實測（本檔 F10 那一列，吞噬手勢跑完之後直接讀）：
//   {"offsetParent":null,"display":"flex","vis":"visible","w":800,"h":69.5}
// —— banner 明明佔了整條螢幕寬，offsetParent 判斷仍然說它看不見。用那個判斷
// 寫的斷言對這條 banner 恆為「沒有 banner」：要求「有」的那一半永遠紅、要求
// 「沒有」的那一半（這個檔案裡 F10 的控制組）永遠綠 —— 不論要求有或要求沒有，
// 都量不到東西。
// F10 那一句【吞噬專用】的文字，逐字對上 lib/editor/client.js 的
// `SWALLOW_MESSAGE`。showBanner() 的節點是「訊息 span ＋ 關閉鈕（✕）」，所以
// 讀回來的 textContent 帶著那個 ✕ 尾巴。
const SWALLOW_MSG = '這道 ``` 圍欄沒有閉合，它後面的內容全部被吃進' +
  '同一個程式碼區塊裡了。把收尾的圍欄補回去就會復原。';

async function visibleBannerText(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.ed-conflict');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    if (r.width === 0 || r.height === 0) return null;
    return b.textContent;
  });
}

// v3.3.0 階段 0: 合成 .click() 對「dirty burst + 真人按壓時間」那一族缺陷是盲的
// —— 真人按滑鼠有按壓時間，合成點擊沒有。實測（見 task-1 report 的量測表）
// ⠿ / ＋ 選單項在 dirty burst ＋ 按壓 80 ms 時 clickFired = 0。
// 所有 ⠿ / ＋ / 工具列的案例都必須用這支。
//
// 回傳 { heldMs } —— 【實測】的 down→up 間隔，不是要求的 holdMs。呼叫端拿它
// 跟這台機器自己的 commit round trip 比對，把「這一列到底有沒有能力紅」變成
// 案例自己的前提斷言（見下面階段 0 案例的 __renderApplyMs）。刻意在送出【放開】
// 事件之前取時間（預設路徑是 `mouse.up()`，`pressAtPointer` 路徑是 CDP 的
// `mouseReleased`），所以它是真實間隔的【下界】—— 前提斷言因此偏嚴，不會因為
// CDP 往返把自己算得比實際寬鬆。
// `opts.pressAtPointer` — `{x, y}`: press at exactly this viewport point,
// WITHOUT dispatching a mouse move first. Every assertion below runs unchanged,
// and this path adds its own: the element's rect must not have moved under
// scrollIntoViewIfNeeded(), and the point must fall inside that rect.
//
// The press and release are dispatched through CDP at that literal point.
// That is NOT a step away from real mouse input: puppeteer's own
// `Mouse.down()`/`up()` send the identical `Input.dispatchMouseEvent`, at the
// position it keeps internally. The only thing CDP buys here is that the
// coordinate becomes an argument this function can assert about, instead of
// state held inside puppeteer's `Mouse` that no assertion can reach.
//
// Why it exists: `.ed-tb-insert` (the ＋ bubbles) is appended to
// `document.body`, so `updateTableInsertBubbles()`'s
// `target.closest('.ed-block[data-block-type="table"]')` used to be null for
// any mousemove whose target was the bubble ITSELF, and that call hid it.
// MEASURED on this repo's puppeteer back then, hovering the row boundary to
// raise the bubble and then pressing it:
//
//   with pressClick's own mouse.move()   bubble.hidden = true,  events []
//   pressing without moving              bubble.hidden = false, events
//                                        ["mousedown","click"], row inserted
//
// So at that time the way to press this button with a real mouse was to
// arrive at it with the move that raises it and then not move again, and
// this option is what let the 地基 B / C1 row express that gesture.
//
// v3.3.0 F7 fixed the visibility test itself (the fallback to the table the
// hover already resolved, in updateTableInsertBubbles()), so C1 now presses
// the bubble through pressClick's own real move — see its own comment — and
// the F7 rows near the end of this file pin the hover directly. What is left
// here is a general "press at exactly this point, without moving first"
// facility with its own two assertions; grep says nothing in this file
// passes `pressAtPointer` any more.
async function pressClick(page, selector, holdMs, opts) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    // Watch the ELEMENT's own rect, not window.scrollX/Y: an ancestor
    // scroller moves the element while the window stays put. MEASURED on a
    // fixture whose button sits inside an `overflow:auto` container —
    // winScrolled false, rectMoved true, containerScrollTop 1860, the rect's
    // top going 2009 -> 149 with the document not scrollable at all
    // (scrollHeight 600 = innerHeight 600). A window-only check is silent
    // through all of that.
    const r0 = el.getBoundingClientRect();
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
    const r = el.getBoundingClientRect();
    const rectMoved = r.left !== r0.left || r.top !== r0.top;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Fix round 1, ruling T2-2: press the point INSIDE the viewport, not the
    // full (possibly off-screen) rect's centre. 量測（puppeteer 24.42.0，
    // 800×600）：puppeteer 自己的 elementHandle.click() 也是把 clickable
    // point 夾到「矩形 ∩ 視窗」的那一塊再送——一顆矩形中心在 (-5,22) 但仍
    // 留著 9.4px 可見裂縫的按鈕，puppeteer 量到的落點是 x≈4.7（裂縫正中央），
    // 不是矩形中心的 x≈-5；那道裂縫是真人滑鼠按得到的。舊版按「完整矩形中心」
    // 比真人滑鼠更嚴格，這裡改成量「可見交集」的中心，只有 scrollIntoViewIfNeeded()
    // 之後仍然【完全沒有交集】才算按不到。
    const cLeft = Math.max(r.left, 0), cTop = Math.max(r.top, 0);
    const cRight = Math.min(r.right, vw), cBottom = Math.min(r.bottom, vh);
    const cw = Math.max(0, cRight - cLeft), ch = Math.max(0, cBottom - cTop);
    return { x: cLeft + cw / 2, y: cTop + ch / 2,
             w: r.width, h: r.height, cw: cw, ch: ch, vw: vw, vh: vh,
             cLeft: cLeft, cTop: cTop, cRight: cRight, cBottom: cBottom,
             rectMoved: rectMoved };
  }, selector);
  assert.ok(box, 'pressClick: 找不到 ' + selector);
  // 元素【存在但按不到】時 puppeteer 不會抱怨，會安靜地按在別的東西上。
  // 實測 puppeteer 24.x / 800×400：`display:none` 的元素與
  // `position:absolute; top:3000px` 的元素，down / up / click 三個事件的
  // target 全部是 <body>。零矩形讓中心點變成 (0,0)，那是個 truthy 物件，
  // 所以只檢查「有沒有拿到 box」擋不住 —— 案例會按到空氣然後照樣綠，
  // 正是本 repo 已經產出過三次的空綠形狀。
  assert.ok(box.w > 0 && box.h > 0,
    'pressClick: ' + selector + ' 的矩形是 ' + box.w + '×' + box.h +
    '，按壓會落在別的元素上（元素存在但按不到）');
  // T2-2：「按不到」現在的定義是「矩形跟視窗完全沒有交集」，不是「矩形中心
  // 不在視窗內」——一顆只露出一條裂縫的元素，真人滑鼠按得到那道裂縫，這裡
  // 也必須按得到，否則這支 helper 比真人更嚴格，會擋下真人按得到的手勢。
  assert.ok(box.cw > 0 && box.ch > 0,
    'pressClick: ' + selector + ' 在 ' + box.vw + '×' + box.vh + ' 視窗內沒有任何可見交集' +
    '（矩形 ' + box.w + '×' + box.h + '，scrollIntoViewIfNeeded() 之後仍然按不到）');
  const pressAt = opts && opts.pressAtPointer;
  if (!pressAt) {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    const t0 = Date.now();
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
    const heldMs = Date.now() - t0;
    await page.mouse.up();
    return { heldMs };
  }
  // `box.c*` was measured AFTER scrollIntoViewIfNeeded() inside the same
  // evaluate; `pressAt` is the caller's coordinate from before that call. If
  // that call moved the element the comparison below is meaningless, so say so
  // instead of comparing across two frames.
  assert.strictEqual(box.rectMoved, false,
    'pressClick: scrollIntoViewIfNeeded() 把 ' + selector +
    ' 的矩形移動了，它已經不在呼叫端算 pressAtPointer 時的位置，這個比較無意義');
  assert.ok(pressAt.x >= box.cLeft && pressAt.x <= box.cRight &&
            pressAt.y >= box.cTop && pressAt.y <= box.cBottom,
    'pressClick: pressAtPointer (' + pressAt.x + ',' + pressAt.y + ') 不在 ' +
    selector + ' 的可見矩形 [' + box.cLeft + ',' + box.cRight + ']×[' +
    box.cTop + ',' + box.cBottom + '] 內 —— 按壓會落在別的元素上');
  // Same wire message `page.mouse.down()`/`up()` would send, addressed to the
  // asserted coordinate rather than to whatever position puppeteer's Mouse
  // holds. Neither form emits a `mouseMoved`; skipping the move is the
  // caller-visible contract above, not something this dispatch does.
  //
  // Two knowingly-unhandled gaps, neither reachable from any caller today:
  // `modifiers` is not forwarded (no caller passes any), and puppeteer's own
  // `Mouse` never learns about this press. Its button bookkeeping stays
  // consistent because BOTH halves go through CDP, and its position is
  // already correct because the caller is the one who moved it here. A future
  // caller that needs modifiers, or that mixes `page.mouse` into the same
  // gesture, has to close these first.
  const cdp = await page.createCDPSession();
  const ev = { x: pressAt.x, y: pressAt.y, button: 'left', buttons: 1, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, ev));
  const t0 = Date.now();
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  const heldMs = Date.now() - t0;
  await cdp.send('Input.dispatchMouseEvent',
    Object.assign({ type: 'mouseReleased' }, ev, { buttons: 0 }));
  await cdp.detach();
  return { heldMs };
}

// Fix round 2, finding 1: pressClick()'s own doc comment requires the caller
// to take `{ heldMs }` back, compare it against THIS machine's own
// fetch→DOM commit round trip, and turn "can this row even fail" into the
// row's own precondition — a press that does not outlast that round trip
// goes green on a broken build for a reason that has nothing to do with
// whatever the row claims to test. The stage-0 loop below was the only
// caller doing this; every other press against a `.ed-handle-menu-btn` /
// `.ed-insert-menu-btn` item needs the identical probe, so it is extracted
// here instead of copied.
//
// `armDetachProbe(page, itemSel, itemLabel)` tags the LAST element under
// `itemSel` whose trimmed textContent is exactly `itemLabel` with
// `[data-journey-target="1"]` (last, not first, because a submenu toggle's
// own label can appear twice once its panel is open — the top-level entry
// and the panel's own leaf share the same class), and (re)arms two
// page-global probes: a capture-phase click counter scoped to `itemSel`,
// and a `/api/render` → `.content` childList MutationObserver timing probe.
// Both are reset on every call so a second press on the same page (V2h
// presses twice: the 轉換成 toggle, then the leaf) starts from a clean
// slate; the underlying listener/fetch-wrap is installed at most once per
// page to avoid stacking duplicate listeners across repeated arms.
async function armDetachProbe(page, itemSel, itemLabel) {
  await page.evaluate((s, t) => {
    window.__itemClicks = 0;
    window.__itemClickSel = s;
    if (!window.__itemClickListenerArmed) {
      window.__itemClickListenerArmed = true;
      document.addEventListener('click', (e) => {
        if (e.target && e.target.closest && window.__itemClickSel &&
            e.target.closest(window.__itemClickSel)) window.__itemClicks++;
      }, true);
    }
    window.__renderApplyMs = [];
    // Fix round 3, finding 2: `started` must reset on every arm, not just
    // once at install time. It used to live only in the fetch wrapper's
    // closure, cleared solely by an actual `.content` childList mutation —
    // so an `/api/render` that completes WITHOUT producing one (nothing
    // reachable today, but not guaranteed never to happen in a future
    // caller) would leave it set forever; the next mutation after a later
    // re-arm would then be timed against that stale start, producing a huge
    // bogus duration and a false RED in assertDetachCapable(). Putting it on
    // `window` and resetting it in this same block — the one that already
    // runs on every arm — closes that gap for every future caller of this
    // helper, not just the two that exist today.
    window.__renderStarted = null;
    if (!window.__renderApplyMsArmed) {
      window.__renderApplyMsArmed = true;
      const contentEl = document.querySelector('.content');
      const origFetch = window.fetch;
      window.fetch = function (u) {
        if (String(u).indexOf('/api/render') !== -1 && window.__renderStarted === null) {
          window.__renderStarted = performance.now();
        }
        return origFetch.apply(this, arguments);
      };
      new MutationObserver(() => {
        if (window.__renderStarted === null) return;
        window.__renderApplyMs.push(performance.now() - window.__renderStarted);
        window.__renderStarted = null;
      }).observe(contentEl, { childList: true });
    }
    // Clear any stale tag from a PRIOR arm on this same page (V2h arms twice:
    // the 轉換成 toggle, then the leaf) before setting a fresh one — two
    // elements answering `[data-journey-target="1"]` would make pressClick()'s
    // `document.querySelector()` silently pick whichever is first in document
    // order, which is not necessarily the one this call means to press.
    document.querySelectorAll('[data-journey-target]')
      .forEach((el) => el.removeAttribute('data-journey-target'));
    const hits = Array.from(document.querySelectorAll(s)).filter((e) => e.textContent.trim() === t);
    if (!hits.length) throw new Error('前提失敗：選單開了但找不到項目 ' + t);
    hits[hits.length - 1].setAttribute('data-journey-target', '1');
  }, itemSel, itemLabel);
}

// The shared precondition itself: this press must have actually outlasted
// this machine's commit round trip, or the row has zero detection power.
async function assertDetachCapable(page, press, where) {
  const applyMs = await page.evaluate(() => window.__renderApplyMs.slice());
  assert.ok(applyMs.length > 0,
    where + ' 前提失敗：整個手勢一發 /api/render 都沒有，量不到這台機器的 commit round trip');
  const worst = Math.max.apply(null, applyMs);
  assert.ok(press.heldMs > worst,
    where + ' 前提失敗：實測按壓 ' + press.heldMs + 'ms，但這台機器把一次 commit 的 /api/render ' +
    '套用到 DOM 要 ' + Math.round(worst) + 'ms —— 按壓沒有超過 round trip，這一列在【未修版本上也會綠】，' +
    '偵測力是 0。請把 hold 調到明顯大於 ' + Math.round(worst) + 'ms。');
}

// `clicked` is the actual count of click events that reached the tagged
// item — a button detached mid-press never receives one, which is exactly
// the quantity under test, not something re-derived after the fact.
function itemClickFired(page) {
  return page.evaluate(() => (window.__itemClicks > 0 ? 'ok' : 'menu-gone'));
}

async function main() {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  // ── R1: Escape in a raw source editor must DISCARD, never commit ──────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    const sel = '.ed-block[data-block-type="paragraph"]';
    const blockId = await ctx.page.evaluate((s) =>
      document.querySelector(s).getAttribute('data-block-id'), sel);
    const one = '.ed-block[data-block-id="' + blockId + '"]';

    // open the raw editor via the ⠿ menu's MD 原始碼 item
    await ctx.page.hover(one);
    await pressClick(ctx.page, one + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      if (!b) throw new Error('MD 原始碼 item not found');
      b.click();
    });
    await ctx.page.waitForSelector(one + ' textarea.ed-raw');

    await ctx.page.evaluate((s) => {
      const ta = document.querySelector(s + ' textarea.ed-raw');
      ta.value = 'DISCARDME';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, one);
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 300));

    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('DISCARDME'), -1,
      'R1: Escape 丟棄的文字不得進入磁碟，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'R1: 不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: R1 Escape discards, never commits — OK');
  }

  // ── T21 item 1: Escape still discards, and Ctrl+Z brings it back ──────
  //
  // Escape meaning "throw this away" is not what changed and is not what
  // these rows are about — R1 above still pins it, and the first assertion in
  // each row here re-states it. What changed is that the throw-away was
  // final: driven on this branch on all three burst surfaces, Ctrl+Z ×3 and
  // Ctrl+Y ×3 after an Escape all left the typing gone, and the title had
  // gone back to 'doc', so the close-the-tab guard was off over it as well
  // The dropped Alt+F10 cursor is what puts
  // people here — Escape is the documented way out of the toolbar, and by
  // the time they press it the cursor is usually already gone — but the loss
  // is reachable from a plain Escape with no toolbar involved at all, which
  // is what these rows drive.
  //
  // The save at the end of each row is the half that a DOM-only check would
  // miss: the restored text has to be a live edit that COMMITS, not a
  // repaint. It is what pins restoreDiscardedBurst()'s focus-then-write
  // order — write first and the restored text becomes the new burst
  // baseline, and resolveBurst()'s zero-edit guard drops it on the way out.
  {
    const doc = '# Doc\n\nAlpha paragraph.\n\n- alpha\n  - beta\n\n| A | B |\n| --- | --- |\n| one | two |\n';
    const cases = [
      { label: 'paragraph',
        sel: '.ed-block[data-block-type="paragraph"] .ed-wys-armed',
        read: '.ed-block[data-block-type="paragraph"] .ed-wys-armed',
        base: 'Alpha paragraph.', typed: ' MYWORDS' },
      { label: 'list item',
        sel: '.ed-block[data-block-type="li"][data-indent="1"] .ed-li-text',
        read: '.ed-block[data-block-type="li"][data-indent="1"] .ed-li-text',
        base: 'beta', typed: 'LIWORDS' },
      { label: 'table cell',
        sel: '.ed-block[data-block-type="table"] tbody td',
        read: '.ed-block[data-block-type="table"] tbody td',
        base: 'one', typed: 'CELLWORDS' },
    ];
    for (const t of cases) {
      const ctx = await newPage(doc);
      const readText = () => ctx.page.evaluate((s2) => {
        const el = document.querySelector(s2);
        return el ? el.textContent.trim() : null;
      }, t.read);
      const title = () => ctx.page.evaluate(() => document.title);

      await ctx.page.click(t.sel);
      await new Promise((r) => setTimeout(r, 250));
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('End');
      await ctx.page.keyboard.up('Control');
      await ctx.page.keyboard.type(t.typed);
      await new Promise((r) => setTimeout(r, 250));
      assert.ok((await readText()).indexOf(t.typed.trim()) !== -1,
        t.label + '：前提失敗 —— 打的字沒進到編輯面，got ' + JSON.stringify(await readText()));

      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 350));
      assert.strictEqual(await readText(), t.base,
        t.label + '：Escape 仍然必須丟棄（這一版沒有改變它的意思），got ' +
        JSON.stringify(await readText()));

      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 400));
      assert.ok((await readText() || '').indexOf(t.typed.trim()) !== -1,
        t.label + '：Escape 之後的 Ctrl+Z 必須把打的字帶回來，got ' +
        JSON.stringify(await readText()));
      assert.ok((await title()).indexOf('●') === 0,
        t.label + '：帶回來的字是還沒提交的編輯，標題必須重新亮髒點（否則關分頁的' +
        '守衛對它是關的），got ' + JSON.stringify(await title()));

      // A second Ctrl+Z steps back through the same burst history to the
      // pre-edit baseline — the stash hands the history back, it does not
      // spend it.
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(await readText(), t.base,
        t.label + '：帶回來之後再 Ctrl+Z 必須退回打字前的基準，got ' +
        JSON.stringify(await readText()));

      // ...and Ctrl+Y forward again, then save: the restored text must reach
      // disk, which is what makes it an edit rather than a repaint.
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyY');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 400));
      const disk = await saveAndRead(ctx);
      assert.ok(disk.indexOf(t.typed.trim()) !== -1,
        t.label + '：帶回來的字必須是活的編輯 —— Ctrl+S 之後要在磁碟上，got:\n' + disk);
      assert.strictEqual(ctx.errs.length, 0, t.label + '：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: T21 Escape discards and Ctrl+Z brings it back, on all three burst surfaces — OK');
  }

  // The other side of the same switch: an Escape that discarded NOTHING must
  // not eat the Ctrl+Z after it. The stash exists for every Escape, so
  // without restoreDiscardedBurst()'s "the history had only its baseline"
  // answer this row's Ctrl+Z would be swallowed and the committed edit before
  // it would stay on screen.
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    // Real clicks, not element.click(): a synthetic click on a contenteditable
    // dispatches the event without moving focus, so the typing below would go
    // to BODY and this row would measure nothing. Selected by block id rather
    // than by nth match for the same reason of being explicit — 0 is the
    // heading, 1 and 2 are the two paragraphs.
    const first = '.ed-block[data-block-id="1"] .ed-wys-armed';
    const second = '.ed-block[data-block-id="2"] .ed-wys-armed';
    await ctx.page.click(first);
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.up('Control');
    await ctx.page.keyboard.type(' COMMITTED');
    await new Promise((r) => setTimeout(r, 250));
    // Leave the block: the edit is committed and pushed onto the document stack.
    await ctx.page.click(second);
    await new Promise((r) => setTimeout(r, 900));
    const readFirst = () => ctx.page.evaluate((s2) => {
      const el = document.querySelector(s2);
      return el ? el.textContent.trim() : null;
    }, first);
    const beforeEsc = await readFirst();
    assert.ok(beforeEsc.indexOf('COMMITTED') !== -1,
      '前提失敗：第一段的編輯應該已經提交，got ' + JSON.stringify(beforeEsc));

    // Escape out of the second paragraph without having touched it. The
    // precondition matters: if the commit's re-render had dropped focus, the
    // Escape would reach no burst at all and this row would pass while
    // measuring nothing.
    const activeBeforeEsc = await ctx.page.evaluate(() =>
      document.activeElement ? String(document.activeElement.className || '') : null);
    assert.ok(String(activeBeforeEsc).indexOf('ed-wys-armed') !== -1,
      '前提失敗：Escape 之前焦點必須還在第二段的編輯面上，got ' + JSON.stringify(activeBeforeEsc));
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 700));
    const afterUndo = await readFirst();
    assert.strictEqual(afterUndo, 'Alpha paragraph.',
      '空的 Escape 不得吃掉後面那個 Ctrl+Z —— 文件層的 undo 必須照跑，got ' +
      JSON.stringify(afterUndo));
    assert.strictEqual(ctx.errs.length, 0, '空 Escape：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: T21 an Escape that discarded nothing leaves Ctrl+Z alone — OK');
  }

  // ── openRawViaGutter: ⠿ → MD 原始碼 on a TABLE burst must discard ─────
  {
    const ctx = await newPage('# Doc\n\nAnchor para.\n\n| A | B |\n| --- | --- |\n| one | two |\n\nTail para.\n');
    await ctx.page.click('.ed-block[data-block-type="table"] .ed-wys-cell');
    await ctx.page.keyboard.type('ZZZ');
    const tsel = '.ed-block[data-block-type="table"]';
    await ctx.page.hover(tsel);
    await pressClick(ctx.page, tsel + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      if (!b) throw new Error('MD 原始碼 item not found');
      b.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    const raw = await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      return ta ? ta.value : null;
    });
    assert.strictEqual(raw && raw.indexOf('ZZZ'), -1,
      'openRawViaGutter: raw editor 不得顯示被丟棄的編輯，got: ' + JSON.stringify(raw));

    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('ZZZ'), -1,
      'openRawViaGutter: 被丟棄的編輯不得進入磁碟，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: ⠿ → MD 原始碼 discards a table burst — OK');
  }

  // ── R2: a raw-editor commit that spawns a new block must commit ONCE ──
  {
    const ctx = await newPage('# Doc\n\n```\ncode one\n```\n\nBravo paragraph.\n');
    const sel = '.ed-block[data-block-type="code"]';
    await ctx.page.hover(sel);
    await pressClick(ctx.page, sel + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      b.click();
    });
    await ctx.page.waitForSelector('textarea.ed-raw');
    await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      ta.value = '```\ncode one\n```\n\nSPAWNED tail.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 600));

    const disk = await saveAndRead(ctx);
    const hits = disk.split('SPAWNED tail.').length - 1;
    assert.strictEqual(hits, 1,
      'R2: 衍生新 block 的提交只能發生一次，出現 ' + hits + ' 次:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: raw-editor commit that spawns a block commits once — OK');
  }

  // ── 轉換：B 態（無選取）必須還原焦點；A 態（有選取）必須不動 ──────────
  {
    const ctx = await newPage('alpha one\n\nbravo two\n\ncharlie three\n');
    // B 態：純點擊進 block，再按「清單」
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await pressClick(ctx.page, '[data-ed-tb="list"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const b = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
      // Review I2: `save` excluded — it is one of NO_BLOCK_ALLOWED
      // (lib/editor/toolbar-model.js) and, unlike the other four members of
      // that set, its OWN disabled flag also tracks ctx.dirty rather than
      // being unconditionally live. A gesture that dirties the document (a
      // commit, not just a save) would otherwise make a genuine collapse-to-
      // no-block read as 5 instead of 4 and slip past every `> 4` sentinel
      // in this file — counting it back in restores the ORIGINAL meaning
      // ("did the toolbar collapse to its structural no-block floor")
      // this count has always pinned.
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn'))
        .filter((x) => !x.disabled && x.getAttribute('data-ed-tb') !== 'save').length,
    }));
    assert.notStrictEqual(b.active, 'BODY', 'B 態轉換後焦點不得掉到 BODY');
    assert.ok(b.enabled > 4, 'B 態轉換後工具列不得塌成 4 顆，got ' + b.enabled);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: conversion without a selection restores the caret — OK');
  }
  {
    const ctx = await newPage('alpha one\n\nbravo two\n\ncharlie three\n');
    // A 態：Shift+Click 立一個單塊選取，再按「清單」
    await ctx.page.keyboard.down('Shift');
    await ctx.page.click('.ed-block[data-block-id="1"]');
    await ctx.page.keyboard.up('Shift');
    await pressClick(ctx.page, '[data-ed-tb="list"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const a = await ctx.page.evaluate(() => ({
      activeIsWrapper: !!(document.activeElement &&
        document.activeElement.classList.contains('ed-block')),
      selected: document.querySelectorAll('.ed-selected').length,
    }));
    assert.strictEqual(a.activeIsWrapper, true,
      'A 態轉換後焦點必須留在 .ed-block wrapper（roving focus），不得被搬進編輯面');
    assert.strictEqual(a.selected, 1, 'A 態轉換後選取底色必須還在');
    // Delete 必須仍然刪整個 block，而不是死鍵
    await ctx.page.keyboard.press('Delete');
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('bravo two'), -1,
      'A 態轉換後 Delete 必須刪掉整個 block，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: conversion with a selection leaves the selection intact — OK');
  }

  // ── H▾ on a block that is ALREADY a heading（走 changeHeadingDepth()，
  //    不是 convertBlockViaMenu()）也不得掉焦點 ──────────────────────────
  {
    const ctx = await newPage('## Alpha heading\n\nbravo two\n');
    // 無選取：純點擊進標題本身
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await pressClick(ctx.page, '[data-ed-tb="headings"]', 80);
    await ctx.page.waitForSelector('.ed-toolbar-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-toolbar-menu-btn'))
        .find((x) => x.textContent.indexOf('標題 4') !== -1);
      if (!b) throw new Error('標題 4 item not found');
      b.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const h = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
      // Review I2: `save` excluded — see the identical comment on the
      // conversion scenario above for why.
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn'))
        .filter((x) => !x.disabled && x.getAttribute('data-ed-tb') !== 'save').length,
    }));
    assert.notStrictEqual(h.active, 'BODY', 'H▾ 改既有標題層級後焦點不得掉到 BODY');
    assert.ok(h.enabled > 4, 'H▾ 改既有標題層級後工具列不得塌成 4 顆，got ' + h.enabled);
    const disk = await saveAndRead(ctx);
    assert.notStrictEqual(disk.indexOf('#### Alpha heading'), -1,
      'H▾ 標題 4 必須真的改寫層級，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: H▾ on an existing heading keeps the caret — OK');
  }

  // ── undo：游標在被改寫區塊【內】時必須還原，區塊外則不得被動到 ────────
  {
    const ctx = await newPage('# Title\n\nAlpha paragraph.\n\nBravo paragraph.\n\nGolf paragraph.\n');
    // 在 Bravo 打字並提交（產生一個可 undo 的 op）
    await ctx.page.click('.ed-block[data-block-id="2"] .ed-wys-armed');
    await ctx.page.keyboard.type(' TWO');
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    // 把游標放回 Bravo（即將被 undo 改寫的那個 block）
    await ctx.page.click('.ed-block[data-block-id="2"] .ed-wys-armed');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 500));
    const st = await ctx.page.evaluate(() => ({
      active: document.activeElement ? document.activeElement.tagName : null,
    }));
    assert.notStrictEqual(st.active, 'BODY',
      'undo：游標落在被改寫區塊內時，焦點不得掉到 BODY');
    // 打字必須真的進得去
    await ctx.page.keyboard.type('QQ');
    await new Promise((r) => setTimeout(r, 200));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('QQ') !== -1,
      'undo 之後打的字必須進得了檔案，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: undo keeps a usable caret in the rewritten block — OK');
  }

  // ── 圖片：髒 block 上插入，必須落在該段落之後而非檔尾 ────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n\nTail paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' DIRTY');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    const imgPath = path.join(path.dirname(ctx.mdPath), 'one.png');
    fs.writeFileSync(imgPath, png);
    const [chooser] = await Promise.all([
      ctx.page.waitForFileChooser(),
      pressClick(ctx.page, '[data-ed-tb="image"]', 80),
    ]);
    await chooser.accept([imgPath]);
    await new Promise((r) => setTimeout(r, 900));

    const disk = await saveAndRead(ctx);
    const lines = disk.split('\n');
    const imgIdx = lines.findIndex((l) => l.indexOf('![') !== -1);
    const alphaIdx = lines.findIndex((l) => l.indexOf('Alpha paragraph.') !== -1);
    const bravoIdx = lines.findIndex((l) => l.indexOf('Bravo paragraph.') !== -1);
    assert.ok(imgIdx > alphaIdx && imgIdx < bravoIdx,
      '圖片必須落在 Alpha 之後、Bravo 之前，got img@' + imgIdx +
      ' alpha@' + alphaIdx + ' bravo@' + bravoIdx + ':\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: an image lands after the current block — OK');
  }

  // ── 模式：兩態循環，preview 不可達，按鈕講下一個狀態 ────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const read = () => ctx.page.evaluate(() => ({
      mode: document.body.getAttribute('data-ed-mode'),
      status: (document.querySelector('.ed-toolbar-status') || {}).textContent || '',
      label: (document.querySelector('[data-ed-tb="preview"]') || {}).title || '',
    }));
    const s0 = await read();
    assert.strictEqual(s0.mode, 'edit', '初始必須是 edit');
    await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
    await new Promise((r) => setTimeout(r, 300));
    const s1 = await read();
    assert.strictEqual(s1.mode, 'source', '第一次按進 source');
    await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await read();
    assert.strictEqual(s2.mode, 'edit', '第二次按【必須】回到 edit，preview 已移除');
    assert.ok(s1.status.length > 0 && s2.status.length > 0,
      '狀態槽位必須顯示當前模式');
    // v3.2.1 final wave, M6: `length > 0` alone passes for a bug that always
    // prints 「編輯」. 兩態的字必須【不同】才算真的在講當前模式。
    // （這一條讀的是 .textContent；上面那條 notStrictEqual 讀的是按鈕的 .title，
    //   兩者是不同的槽位。）
    assert.notStrictEqual(s1.status, s2.status,
      '狀態槽位必須隨模式改變 —— 兩態印一樣的字等於沒有在講當前模式，got ' +
      JSON.stringify([s1.status, s2.status]));
    // s0 是 mountToolbar() 之後、任何 setDocMode() 之前的值。這是
    // paintModeStatus() 掛載時那一發唯一會被測到的地方 —— 少了它，掛載時漏叫
    // paintModeStatus() 只會讓槽位空到第一次切換為止，沒有任何斷言會紅。
    assert.strictEqual(s0.status, s2.status,
      '掛載時的狀態槽位必須已經是 edit 模式的字（＝再切回 edit 時的同一個字），got ' +
      JSON.stringify([s0.status, s2.status]));
    assert.ok(s0.status.length > 0,
      '掛載時狀態槽位不得是空的 —— mountToolbar() 之後必須已經 paintModeStatus() 過');
    assert.notStrictEqual(s1.label, s2.label,
      '按鈕標示必須講【下一個】狀態，兩態下不應相同');
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the mode button is a truthful two-state toggle — OK');
  }

  // ── 捲動：滯留的浮動選取列不得還能改到文件 ──────────────────────────
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
    const ctx = await newPage('# Doc\n\nAlpha target paragraph.\n\n' + filler + '\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    // Fixture note: read the file directly here, NOT via saveAndRead(). Ctrl+S
    // runs switchAwayFrom() first, which resolves the burst this test just
    // opened by focusing the paragraph above — and since nothing was actually
    // edited, that resolution calls resetSelToolbarState() and removes
    // .ed-seltb from the DOM for a reason that has nothing to do with
    // scrolling. Doing a save here would make the "toolbar gone after scroll"
    // assertion below pass even without the scroll-listener fix (verified:
    // it does — the toolbar is confirmed gone by save, before any scroll).
    const before = fs.readFileSync(ctx.mdPath, 'utf8');
    await ctx.page.evaluate(() => window.scrollTo(0, 4000));
    await new Promise((r) => setTimeout(r, 400));
    const visible = await ctx.page.evaluate(() => {
      const tb = document.querySelector('.ed-seltb');
      if (!tb || !tb.parentNode) return null;
      const r = tb.getBoundingClientRect();
      return { top: r.top, clickable: document.elementFromPoint(
        r.left + r.width / 2, r.top + r.height / 2) === tb ||
        tb.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
    });
    assert.strictEqual(visible, null,
      '選取捲出視窗後，浮動選取列必須消失，got: ' + JSON.stringify(visible));
    const after = await saveAndRead(ctx);
    assert.strictEqual(after, before, '捲動不得改變磁碟內容');
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the floating format bar cannot act on off-screen text — OK');
  }

  // ── 捲動：選取捲回視野裡，浮動選取列就該跟著回來 ────────────────────
  //
  // 與上面那一列是同一個手勢的兩半，不衝突：上面釘的是「捲出去之後那列不得
  // 留在畫面上還能改文件」，這一列釘的是「捲回來之後那列要回得來」。v3.2.1
  // 只做了前半，而它把列從 DOM 拿掉的那一下，正好讓 onAnyScroll() 的
  // `selToolbar.parentNode` 閘門從此永遠先 return —— 於是後半不成立。
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler ' + i + '.').join('\n\n');
    const ctx = await newPage('# Doc\n\nAlpha target paragraph.\n\n' + filler + '\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus(); document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    const up = await ctx.page.evaluate(() => !!document.querySelector('.ed-seltb'));
    assert.strictEqual(up, true,
      '前提失敗：選取之後浮動列本來就該在，否則下面兩段都是空的');
    await ctx.page.evaluate(() => window.scrollTo(0, 4000));
    await new Promise((r) => setTimeout(r, 400));
    const gone = await ctx.page.evaluate(() => !document.querySelector('.ed-seltb'));
    assert.ok(gone, '捲出視窗後浮動列應消失');
    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 400));
    const back = await ctx.page.evaluate(() => {
      const s = window.getSelection();
      return {
        tb: !!document.querySelector('.ed-seltb'),
        collapsed: s.isCollapsed,
        selRectTop: Math.round(s.getRangeAt(0).getBoundingClientRect().top),
      };
    });
    assert.strictEqual(back.collapsed, false, '選取應仍在, got ' + JSON.stringify(back));
    assert.ok(back.selRectTop > 0,
      '前提失敗：捲回來之後選取本身要看得見，否則消失的理由是視窗外而不是這個缺陷, got '
      + JSON.stringify(back));
    assert.strictEqual(back.tb, true,
      '捲回來且選取仍在時，浮動列必須回來, got ' + JSON.stringify(back));
    assert.strictEqual(ctx.errs.length, 0, '不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the floating format bar comes back when you scroll back — OK');
  }

  // ── 捲動 × Task 15：捲回來的那一發不得把 Tab 壓著的那列放出來 ────────
  //
  // 上面那一列讓捲動有能力重新升起 .ed-seltb，而 Tab 走格造出來的整格選取
  // 正好就是「編輯根裡一段非 collapsed 的選取」——捲動路徑上那些檢查會放行
  // 的形狀。settled 狀態看不出差別（Tab 之後那顆非同步的 selectionchange
  // 會再把列壓下去），所以這裡數的是 .ed-seltb 有沒有被掛上 DOM。
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler ' + i + '.').join('\n\n');
    const ctx = await newPage(
      '# Doc\n\n| Alpha | Beta |\n|---|---|\n| GammaGammaGamma | DeltaDelta |\n\n'
      + filler + '\n');
    await ctx.page.click('.ed-wys-table tbody td');
    await new Promise((r) => setTimeout(r, 300));
    // 手動選取：邊界落在文字節點上，所以 Task 15 的邊界比對會放行，列會升起。
    await ctx.page.evaluate(() => {
      const td = document.querySelector('.ed-wys-table tbody td');
      const t = td.firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.length);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 350));
    const upInCell = await ctx.page.evaluate(() => !!document.querySelector('.ed-seltb'));
    assert.strictEqual(upInCell, true, '前提失敗：手動選取格內文字時浮動列該升起');
    await ctx.page.evaluate(() => window.scrollTo(0, 4000));
    await new Promise((r) => setTimeout(r, 400));
    const offInCell = await ctx.page.evaluate(() => !!document.querySelector('.ed-seltb'));
    assert.strictEqual(offInCell, false, '前提失敗：捲出視窗後浮動列該消失');
    await ctx.page.evaluate(() => {
      window.__t16scrolls = 0;
      window.__t16appends = 0;
      document.addEventListener('scroll', () => { window.__t16scrolls++; },
        { passive: true, capture: true });
      new MutationObserver((recs) => {
        recs.forEach((rec) => Array.prototype.forEach.call(rec.addedNodes, (n) => {
          if (n.nodeType === 1 && n.classList && n.classList.contains('ed-seltb')) {
            window.__t16appends++;
          }
        }));
      }).observe(document.body, { childList: true });
    });
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 400));
    // Tab 自己的 target.focus() 會把那一格捲回視野，所以此刻捲回原位是個
    // no-op、一個 scroll 事件都不會送出。改成從落點抖一下再回來。
    const y = await ctx.page.evaluate(() => Math.round(window.scrollY));
    await ctx.page.evaluate((yy) => window.scrollTo(0, yy + 40), y);
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.evaluate((yy) => window.scrollTo(0, yy), y);
    await new Promise((r) => setTimeout(r, 500));
    const t15 = await ctx.page.evaluate(() => {
      const s = window.getSelection();
      return {
        appends: window.__t16appends,
        scrolls: window.__t16scrolls,
        tb: !!document.querySelector('.ed-seltb'),
        selText: String(s),
        collapsed: s.isCollapsed,
        selRectTop: Math.round(s.getRangeAt(0).getBoundingClientRect().top),
        innerHeight: window.innerHeight,
      };
    });
    assert.ok(t15.scrolls >= 2,
      '前提失敗：抖動必須真的送出 scroll 事件, got ' + JSON.stringify(t15));
    assert.strictEqual(t15.selText, 'DeltaDelta',
      '前提失敗：Tab 之後選起來的必須是下一格整格, got ' + JSON.stringify(t15));
    assert.strictEqual(t15.collapsed, false,
      '前提失敗：Tab 選取必須非 collapsed, got ' + JSON.stringify(t15));
    assert.ok(t15.selRectTop > 0 && t15.selRectTop < t15.innerHeight,
      '前提失敗：Tab 選取必須在視窗內，否則壓著列的是視窗外分支, got ' + JSON.stringify(t15));
    assert.strictEqual(t15.appends, 0,
      'Tab 壓著的整格選取，捲動不得把 .ed-seltb 掛回 DOM, got ' + JSON.stringify(t15));
    assert.strictEqual(t15.tb, false,
      'Tab 壓著的整格選取，捲動之後浮動列仍不得在, got ' + JSON.stringify(t15));
    assert.strictEqual(ctx.errs.length, 0, '不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: scrolling back does not release the Tab-suppressed bar — OK');
  }

  // ── 粗體：選取含尾隨空格時，標記不得把空格包進去 ────────────────────
  {
    const ctx = await newPage('# Doc\n\nAlpha bold text here.\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const s = el.textContent.indexOf('bold');
      const r = document.createRange();
      r.setStart(t, s);
      r.setEnd(t, s + 5);            // 'bold ' —— 含尾隨空格
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 250));
    // Fixture note: the brief's original sequence pressed Escape here before
    // clicking away. Measured: with a WYS-armed paragraph burst open, Escape
    // reaches handleBurstKeydown() -> revertBurstAndEnd() and DISCARDS the
    // bold mark just applied, back to the pristine "Alpha bold text here."
    // — the RED run then failed for the wrong reason (no strong element at
    // all, not the predicted `**bold **`), and would still fail after the
    // real fix (a discarded edit stays discarded regardless of what the mark
    // boundary was). Escape here is not "dismiss the selection popup"; it is
    // "abandon this edit". Dropped — clicking a different block's armed
    // surface already ends the burst (via focusout) and commits normally.
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('**bold**') !== -1,
      '標記必須包住修剪後的選取，got:\n' + disk);
    assert.strictEqual(disk.indexOf('\\*'), -1,
      '不得出現跳脫的星號，got:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: bolding a selection with a trailing space — OK');
  }

  // ── T9-4: 選取起點落在既有斜體內時，切分不得留下空標記 ────────────────
  //
  // 這裡的 range 起點是 <em> 第一個 text node 的 offset 0 —— 視覺上就是斜體
  // 的第一個字元，也就是使用者一路往右拖曳時會落到的地方。
  //
  // 每一列都用整份文件做斷言，不是子字串，而理由是量出來的：連結那列若只找
  // 子字串 `[*ital* bold]`，修前的磁碟
  //   `# Doc\n\nAlpha **[*ital* bold](https://example.com) text here.\n`
  // 照樣含有它。壞掉的是連結【前面】多出來的那對 `**`，只有整份比對抓得到。
  // 粗體修前是
  //   `# Doc\n\nAlpha *****ital* bold** text here.\n`
  //
  // `poison` 是【這一列】修前真的出現過的那串殘骸，所以它在自己這一列上咬得
  // 到。之前這裡放的是一個共用的 `*****`，它在連結那列永遠不會失敗 —— 一個在
  // 自己列上不可能紅的守衛什麼都沒守到。至於跳脫的星號本身：它不在這兩列，因為
  // 跳脫是【下一次】存檔才發生的，量它要走完整個循環，見下面的 escape-cycle。
  for (const [tb, expect, poison, label] of [
    ['bold', '# Doc\n\nAlpha ***ital* bold** text here.\n', '*****', '粗體'],
    ['link', '# Doc\n\nAlpha [*ital* bold](https://example.com) text here.\n', '**[', '連結'],
  ]) {
    const ctx = await newPage('# Doc\n\nAlpha *ital* bold text here.\n');
    // 註冊在按下【之前】：window.prompt() 會擋住頁面直到有人回答它，所以一個
    // 晚註冊的 handler 換來的不是一句看得懂的斷言失敗，而是掛住＋逾時。跑完再
    // 斷言它真的被叫過 —— 否則對話框從沒開過的情況下這一列仍然可以綠。
    let dialogFired = false;
    if (tb === 'link') {
      ctx.page.once('dialog', async (d) => {
        dialogFired = true;
        try { await d.accept('https://example.com'); } catch (e) { /* already gone */ }
      });
    }
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const em = el.querySelector('em');
      const r = document.createRange();
      r.setStart(em.firstChild, 0);                       // 視覺上就是斜體第一個字元
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await pressClick(ctx.page, '[data-ed-tb="' + tb + '"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    if (tb === 'link') {
      assert.strictEqual(dialogFired, true,
        label + '：連結對話框從頭到尾沒有開過 —— 這一列什麼都沒量到，got:\n' + disk);
    }
    assert.strictEqual(disk.indexOf(poison), -1,
      label + '：不得留下空標記的殘骸（' + poison + '），got:\n' + disk);
    assert.strictEqual(disk, expect, label + '：整份文件必須就是這樣，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, label + '：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a mark starting inside an existing em leaves no empty leftover — OK');

  // ── T9-4 判別式（「沒有子元素」∧「沒有文字」）的每個子句各一列 ──────────
  //
  // 這些列守的是【不要刪過頭】：留下來的標記只有在什麼都不剩時才該消失。
  //
  // keeps-text：選取起點落在斜體中間，斜體留下的是有字的前半截。少了「沒有
  //   文字」那個子句，那截字會連著標記一起被刪掉。
  // keeps-br：斜體裡剩下的是使用者打的硬斷行 <br> —— 它的 textContent 是空的，
  //   但它不是空殼。少了「沒有子元素」那個子句，那個斷行會被刪掉。
  //   ⚠ 這一列釘住的磁碟形狀【不會】原樣讀回來：實測 marked.parseInline() 把
  //   `Alpha *\<換行>****ital* bold** text here.` 讀成
  //   `Alpha *<br>*<strong><em>ital</em> bold</strong> text here.`，也就是那對
  //   星號變成字面值。原因是「只裝著一個硬斷行的 <em>」在 markdown 裡沒有拼法
  //   —— inline-md.js 的 EM 分支無條件在兩側輸出 `*`，所以任何送去序列化的
  //   <em><br></em> 都會長成這樣，與本修無關。在「重新載入後斷行的斜體外衣掉
  //   了」與「斷行直接消失」之間，這裡選前者：不掉內容。
  //
  // ⚠ 已知的鄰居，【沒有】被任何一列釘住，而且它也會產出使用者回報的那個症狀：
  //   分隔符連讀。留下來的標記【正確地】活著（它裝著東西）時，它的收尾分隔符
  //   會緊貼著新標記的起始分隔符。實測 `Alpha *` + 反引號 c 反引號 + `ital*
  //   bold text here.`，從 `ital` 開頭起算的粗體：
  //     第一次存檔 `Alpha *`+`` `c` ``+`****ital* bold** text here.`
  //     重新載入再編輯 `Alpha \*`+`` `c` ``+`\****ital* bold** text here.Z`
  //   這不是空標記 —— <em> 裝著那個 code span，本檔的判別式正確地留下它。壞的
  //   是 `*` 後面緊接著 `***` 讀不回來，成因在 inline-md.js 怎麼挑分隔符長度，
  //   跟本修同源但不同層。刻意不加斷言：釘住現在這個（錯的）位元組，會讓將來
  //   真正的修法為了錯的理由紅掉。
  for (const [name, md, expect] of [
    ['keeps-text', '# Doc\n\nAlpha *ital* bold text here.\n',
      '# Doc\n\nAlpha *it****al* bold** text here.\n'],
    ['keeps-br', '# Doc\n\nAlpha *\\\nital* bold text here.\n',
      '# Doc\n\nAlpha *\\\n****ital* bold** text here.\n'],
  ]) {
    const ctx = await newPage(md);
    await ctx.page.evaluate((kind) => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const em = el.querySelector('em');
      const r = document.createRange();
      // keeps-br 的 <em> 是 [<br>, 'ital']，起點取 'ital' 的開頭 —— 斜體因此
      // 留下那個 <br>；keeps-text 的起點落在 'ital' 中間，斜體留下 'it'。
      if (kind === 'keeps-br') r.setStart(em.lastChild, 0);
      else r.setStart(em.firstChild, 2);
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    }, name);
    await new Promise((r) => setTimeout(r, 250));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, expect,
      name + '：留下來的標記還裝著東西，不得被刪掉，got:\n' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, name + '：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: an emptied mark goes, a mark that still holds something stays — OK');

  // ── T9-4 的其他手勢：Shift+Enter／貼上／清單裡按 Enter ────────────────
  //
  // 同一個 root cause 的其他路徑。Shift+Enter 與貼上走 deleteContents()，清單
  // 裡的 Enter 走 splitListItemAtCaret() 的「先刪再抽尾」。它們與工具列那兩列
  // 共用同一個 dropEmptied() —— 把它的內容拿掉，這些列全部一起紅。
  //
  // 修前的磁碟（實測）：
  //   Shift+Enter  `# Doc\n\nAlpha **<br> text here.\n`
  //   貼上         `# Doc\n\nAlpha **PASTED text here.\n`
  //   清單 Enter   `# Doc\n\n- Alpha **\n- *ital* rest\n- Second\n`
  // 清單那條沒有掉字：每個字元都還在正確的項目裡，壞掉的只有那對分隔符。
  {
    // Shift+Enter：選取從斜體第一個字元起算
    const ctx = await newPage('# Doc\n\nAlpha *ital* bold text here.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const em = el.querySelector('em');
      const r = document.createRange();
      r.setStart(em.firstChild, 0);
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.down('Shift');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 300));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      'br-leftover：不得留下空標記的殘骸，got:\n' + disk);
    assert.strictEqual(disk, '# Doc\n\nAlpha <br> text here.\n',
      'br-leftover：整份文件必須就是這樣，got:\n' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'br-leftover：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  {
    // 貼上：同一個選取。dispatchEvent 的回傳值就是「有沒有人 preventDefault」
    // —— 它必須是 false，否則這一列的貼上根本沒被編輯器接手，什麼都沒量到。
    const ctx = await newPage('# Doc\n\nAlpha *ital* bold text here.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const em = el.querySelector('em');
      const r = document.createRange();
      r.setStart(em.firstChild, 0);
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    const notPrevented = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const dt = new DataTransfer();
      dt.setData('text/plain', 'PASTED');
      return el.dispatchEvent(new ClipboardEvent('paste',
        { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(notPrevented, false,
      'paste-leftover：貼上事件沒有被編輯器接手（沒有人 preventDefault）—— 這一列什麼都沒量到');
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      'paste-leftover：不得留下空標記的殘骸，got:\n' + disk);
    assert.strictEqual(disk, '# Doc\n\nAlpha PASTED text here.\n',
      'paste-leftover：整份文件必須就是這樣，got:\n' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'paste-leftover：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  {
    // 清單項目裡按 Enter，caret 落在斜體第一個字元
    const ctx = await newPage('# Doc\n\n- Alpha *ital* rest\n- Second\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-li-text');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-li-text');
      const em = el.querySelector('em');
      const r = document.createRange();
      r.setStart(em.firstChild, 0); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 700));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      'li-enter-leftover：不得留下空標記的殘骸，got:\n' + disk);
    assert.strictEqual(disk, '# Doc\n\n- Alpha\n- *ital* rest\n- Second\n',
      'li-enter-leftover：整份文件必須就是這樣，got:\n' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'li-enter-leftover：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: Shift+Enter, paste and a list split leave no empty leftover either — OK');

  // ── nested-order：由深到淺的移除順序 ────────────────────────────────────
  //
  // `***ital***` 是 <em><strong>ital</strong></em>（實測 marked 的巢狀方向就是
  // 這個）。從最裡面那個 text node 的 offset 0 起算的選取會把外層與內層都清
  // 空，而外層要看得出自己空了，得先等內層被移走。順序反過來時外層先被檢查，
  // 那時它還裝著內層 —— 它會被留下來，磁碟上多一對 `**`。
  {
    const ctx = await newPage('# Doc\n\nAlpha ***ital*** bold text here.\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const inner = el.querySelector('em strong').firstChild;
      const r = document.createRange();
      r.setStart(inner, 0);
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    const disabled = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="strike"]').disabled);
    assert.strictEqual(disabled, false,
      'nested-order：刪除線按鈕必須是 enabled，否則這一列什麼都沒點到');
    await pressClick(ctx.page, '[data-ed-tb="strike"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, '# Doc\n\nAlpha ~~***ital*** bold~~ text here.\n',
      'nested-order：外層與內層的空標記都要走，而外層只有在內層先走之後才看得出自己空了，got:\n' +
      JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'nested-order：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the outer of two emptied marks goes too — OK');
  }

  // ── escape-cycle：使用者回報的字面症狀 ──────────────────────────────────
  //
  // 「檢視 markdown 後，*字號前面都有 \ 跳脫」。跳脫【不是】在留下空標記的那
  // 一次存檔發生的，是下一次：那些多出來的星號被重新讀成字面文字，再存檔時
  // escapeText() 就把它們跳脫掉。所以要量到它，必須走完整個循環 —— 存檔、重新
  // 載入、再編輯那個 block、再存檔。實測（把 dropEmptied() 的內容拿掉再跑同一
  // 列）：
  //   第一次存檔 `# Doc\n\nAlpha *****ital* bold** text here.\n`
  //   第二次存檔 `# Doc\n\nAlpha \*\****ital* bold** text here.Z\n`
  // 修好之後兩次都是 `Alpha ***ital* bold** text here.`（第二次多一個 Z），
  // 也就是這個形狀自己是位元組穩定的。
  {
    const ctx = await newPage('# Doc\n\nAlpha *ital* bold text here.\n');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const em = el.querySelector('em');
      const r = document.createRange();
      r.setStart(em.firstChild, 0);
      r.setEnd(el.lastChild, el.lastChild.data.indexOf(' text'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const first = await saveAndRead(ctx);
    assert.strictEqual(first, '# Doc\n\nAlpha ***ital* bold** text here.\n',
      'escape-cycle 前提失敗：第一次存檔就必須是乾淨的，got:\n' + JSON.stringify(first));
    // 重新載入＝從磁碟重新解析，這是跳脫唯一發生得了的地方；再打一個字讓這個
    // block 真的被重新序列化（沒被編輯過的 block 會被逐位元組原樣重播）。
    await ctx.page.goto(ctx.url, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 400));
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.type('Z');
    await new Promise((r) => setTimeout(r, 250));
    const second = await saveAndRead(ctx);
    assert.strictEqual(second.indexOf('\\*'), -1,
      'escape-cycle：重新載入再編輯之後不得出現跳脫的星號，got:\n' + JSON.stringify(second));
    assert.strictEqual(second, '# Doc\n\nAlpha ***ital* bold** text here.Z\n',
      'escape-cycle：這個形狀必須是位元組穩定的，got:\n' + JSON.stringify(second));
    assert.strictEqual(ctx.errs.length, 0, 'escape-cycle：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the reported symptom — escaped asterisks on the next save — is gone — OK');
  }

  // ── 表格「對齊」選單：捲動中斷了開啟流程，選單仍要能用 ────────────────
  // v3.2.1 fix round 1 gave runCycleAlign() a scroll-survival fix
  // (suppressEdgeMenuAutoHide + a requestAnimationFrame reposition) for
  // ensureTableBurstOpen()'s cell.focus(), which can scroll the page for
  // real before any table burst exists yet on this table. This locks that
  // fix in: forcing every td/th focus() to also scroll (deterministic
  // stand-in for the real, but timing-fragile, focus-triggered scroll;
  // real off-screen table geometry cannot be engineered reliably from
  // outside the page) with real scroll room on both sides of the table
  // (a doc with filler only BEFORE the table already caused a false pass
  // once — scrollIntoView({block:'center'}) landed exactly at max scroll,
  // making the forced scrollBy() a silent no-op).
  {
    const filler = Array.from({ length: 60 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
    const b = await boot(filler + '\n\n' + ['| A | B |', '|---|---|', '| 1 | 2 |', ''].join('\n') +
      '\n\n' + filler + '\n');
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      const orig = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (...args) {
        if (this.tagName === 'TD' || this.tagName === 'TH') window.scrollBy(0, 40);
        return orig.apply(this, args);
      };
    });
    await page.goto(b.url, { waitUntil: 'networkidle0' });
    const table0 = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      el.scrollIntoView({ block: 'center' });
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    await new Promise((r) => setTimeout(r, 100));
    const colB = await page.evaluate((ts) => {
      const table = document.querySelector(ts + ' table');
      const r = table.tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, table0);
    await page.mouse.move(colB.x, colB.y);
    await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
    const grip = await page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });

    // 1) the forced scroll must have actually moved something — the
    //    vacuous-green trap: a table already sitting at max scroll makes
    //    scrollBy() silently do nothing, and every assertion below would
    //    then be exercising the NO-scroll path instead of the fix.
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    const scrollAfter = await page.evaluate(() => window.scrollY);
    assert.notStrictEqual(scrollAfter, scrollBefore,
      '測試前提失敗：強制捲動沒有真的移動任何東西（scrollY 前後相同），' +
      '後面的斷言就測不到修好的東西，got before=' + scrollBefore + ' after=' + scrollAfter);

    const state1 = await page.evaluate((ts) => {
      const menu = document.querySelector('.ed-te-menu');
      const th = document.querySelector(ts + ' thead th:nth-child(2)');
      return {
        menuHidden: menu.hidden,
        style: th.getAttribute('style'),
        hlCount: document.querySelectorAll('.ed-te-hl').length,
      };
    }, table0);
    // 2) the menu itself must still be showing.
    assert.strictEqual(state1.menuHidden, false,
      '捲動中斷了開啟流程後，對齊選單必須仍然顯示，got: ' + JSON.stringify(state1));
    // 3) highlighted, not just visible — this is what tells a live menu
    //    apart from an inert one sitting on top of the document with no
    //    highlight and no working buttons (see the next scenario below).
    assert.ok(state1.hlCount > 0,
      '選單顯示但沒有欄位高亮，是殭屍選單而非活的選單，got hlCount=' + state1.hlCount);
    assert.ok(/left/.test(state1.style || ''),
      '第一次點擊必須套用 left 對齊，got style=' + state1.style);

    // 4) a second click must actually cycle — not silently no-op on a
    //    detached teMenuColIndex/teMenuKind.
    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    const style2 = await page.evaluate((ts) =>
      document.querySelector(ts + ' thead th:nth-child(2)').getAttribute('style'), table0);
    assert.ok(/center/.test(style2 || ''),
      '第二次點擊必須把對齊循環到 center，got style=' + style2);

    await page.close(); b.srv.close();
    console.log('journey: the align menu survives a scroll that interrupts its own opening — OK');
  }

  // ── 表格「對齊」選單：無關 burst 在中途收尾時，選單必須乾淨關閉 ───────
  // v3.2.1 fix round 2 (re-review finding): round 1's requestAnimationFrame
  // reposition above had no guard against a DIFFERENT reason the menu could
  // have closed during the same await — ensureTableBurstOpen()'s
  // switchAwayFrom() resolves whatever OTHER burst is open (here: a
  // paragraph edited but never blurred, since the grip/menu buttons'
  // mousedown preventDefault() never steals focus away from it), and
  // resolveBurst() unconditionally calls hideTableEdgeMenu() as part of its
  // "any burst resolution invalidates whatever the hover overlay was
  // tracking" cleanup — regardless of which block that burst belonged to.
  // Without a guard, the reposition step resurrected the menu anyway:
  // visible, but with zero highlight and a teMenuKind/teMenuColIndex that
  // had already been nulled — a click on it did nothing (verified against a
  // stashed 66727fc build: menu ends hidden:false, hlCount:0, and a second
  // 對齊 click left the alignment at 'left', unchanged). The fix must leave
  // it CLOSED here, matching how it already behaved before round 1 ever
  // touched this function — round 1's own scenario above is unaffected
  // because there resolveBurst() is never reached at all (no other burst is
  // open, so switchAwayFrom() no-ops before ever calling it).
  {
    const b = await boot(['Alpha paragraph text.', '', '| A | B |', '|---|---|', '| 1 | 2 |', ''].join('\n'));
    const page = await browser.newPage();
    await page.goto(b.url, { waitUntil: 'networkidle0' });

    // Leave an uncommitted, unblurred burst open on the PARAGRAPH block —
    // this is the "burst elsewhere" state resolveBurst() will resolve.
    await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="0"] .ed-wys-armed');
      el.focus();
      document.execCommand('insertText', false, 'EDITED ');
    });
    await new Promise((r) => setTimeout(r, 200));

    const table0 = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    const colB = await page.evaluate((ts) => {
      const table = document.querySelector(ts + ' table');
      const r = table.tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, table0);
    await page.mouse.move(colB.x, colB.y);
    await page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 3000 });
    const grip = await page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 3000 });

    // The paragraph is STILL focused here (mousedown preventDefault on the
    // grip/menu never stole it) — clicking 對齊 is what first forces
    // ensureTableBurstOpen()'s switchAwayFrom() to resolve it.
    const stillOnParagraph = await page.evaluate(() =>
      document.activeElement && document.activeElement.classList.contains('ed-wys-armed') &&
      document.activeElement.closest('.ed-block').getAttribute('data-block-id') === '0');
    assert.ok(stillOnParagraph,
      '測試前提失敗：開選單的手勢偷走了段落的焦點，這個場景就沒測到 burst-elsewhere 路徑');
    // v3.2.1 final wave, D8 —— 上面那一條問的是【焦點】，不是【burst 狀態】，
    // 而 client.js 的 resolveBurst() 註解自己就說得很清楚：它把 currentBurst
    // 設回 null 的時候【不會】blur 任何東西。也就是說焦點還在段落上，並不
    // 蘊含「還有一個未結算的 burst 站在那裡」；哪天有人讓某個中途步驟提前
    // 結算掉它，這個場景就會安靜地不再測到 burst-elsewhere 那條路，而上面那
    // 一條前提仍然是綠的。
    //
    // currentBurst 是 client.js 的閉包變數，頁面外讀不到。可以觀察、而且
    // 蘊含「burst 還開著且是髒的」的東西是：DOM 上那個段落已經帶著
    // 'EDITED '，而磁碟上還沒有 —— 一次未提交的編輯正站在那裡。它一旦被
    // 結算（提交或丟棄），兩邊就會一致，這一條就紅。
    const uncommitted = await page.evaluate(() =>
      (document.querySelector('.ed-block[data-block-id="0"]').textContent || '').indexOf('EDITED ') !== -1);
    assert.ok(uncommitted,
      '測試前提失敗：段落的 DOM 裡沒有那段沒提交的文字，burst 根本沒開起來');
    assert.strictEqual(fs.readFileSync(b.mdPath, 'utf8').indexOf('EDITED '), -1,
      '測試前提失敗：那段文字已經進了磁碟 —— burst 已經被結算掉了，' +
      '這個場景就不再測到 burst-elsewhere 路徑（見 resolveBurst()：它不 blur）');

    await page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 300));
    // Settle past the guarded requestAnimationFrame tick.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const state = await page.evaluate((ts) => {
      const menu = document.querySelector('.ed-te-menu');
      const th = document.querySelector(ts + ' thead th:nth-child(2)');
      return {
        menuHidden: menu.hidden,
        hlCount: document.querySelectorAll('.ed-te-hl').length,
        style: th ? th.getAttribute('style') : null,
      };
    }, table0);
    // The align itself still applies (runCycleAlign() captured tableEl/
    // colIndex as locals before the await, same defence
    // runDeleteColumn()/runDeleteRow() already use) — only the MENU's
    // resurrection is what round 2 must prevent.
    assert.ok(/left/.test(state.style || ''),
      '對齊本身必須仍然套用（用呼叫當下捕捉的區域變數），got style=' + state.style);
    assert.strictEqual(state.menuHidden, true,
      '無關的 burst 收尾合法關閉選單後，選單不可被復活成殭屍，got: ' + JSON.stringify(state));
    assert.strictEqual(state.hlCount, 0,
      '選單關閉時不該留著高亮，got hlCount=' + state.hlCount);
    // Never both hidden:false AND hlCount:0 — that exact combination is the
    // zombie the re-reviewer measured on 66727fc.
    assert.ok(!(state.menuHidden === false && state.hlCount === 0),
      '殭屍選單：可見但沒有高亮、也不再回應點擊，got: ' + JSON.stringify(state));

    await page.close(); b.srv.close();
    console.log('journey: an unrelated burst resolving mid-align closes the menu cleanly, no zombie — OK');
  }

  // ══ V2: 工具列 + ⠿ 選單全矩陣 ═════════════════════════════════════════
  // 族群級的網：Task 3 只修了 convertBlockViaMenu() 一條路徑，這一段逐一
  // 真實點擊 23 顆工具列按鈕與 ⠿ 選單的 15 個葉節點，對每一項斷言「使用者
  // 按完之後還有著力點」。
  //
  // 每一列的「必需答案」是量測出來的，不是猜的（量測腳本見 task-11 報告）：
  //
  //   caret     按完之後游標落在一個【真的編輯面】上 —— 不只是「不是 BODY」，
  //             而是 activeElement 的 class 必須含 ed-wys-armed（段落／標題／
  //             清單項）、ed-wys-cell（表格儲存格）或 ed-raw（MD 原始碼
  //             textarea）三者之一；而且工具列沒有塌回「沒有瞄準任何 block」
  //             的 4 顆。
  //   bar-only  目標沒有可聚焦的編輯面、也沒有 raw editor 可以退回去 —— BODY
  //             是合法答案，但工具列必須還瞄著那個 block。這裡不只數按鈕數，
  //             還真的再按一次「在下方插入區塊」並確認游標落在新段落上，
  //             證明那個「還瞄著」是真的能用而不只是計數好看。
  //             ⚠ quote / code / line 曾經是這一類（convertBlockViaMenu()
  //             自己寫著「降級目標沒有可聚焦編輯面，focusBlockAtLine 會安靜
  //             no-op」），Task 9 backlog #6 之後不再是 —— 那句話現在只描述
  //             focusBlockAtLine() 本身的行為，`restoreAfterStructuralOp()`
  //             接著開的 raw editor 把落點升級成 caret（見 TB_ROWS / GUTTER_ROWS
  //             各自的 review M4 註解）。目前唯一還在用這個答案的是 V2d
  //             的「🔗 in a table cell」。
  //   source    離開 edit 模式；游標必須在 .ed-source textarea 裡，工具列
  //             此時合法地只剩模式切換一顆，所以改為斷言再按一次能回到
  //             edit 且工具列復原。
  //   BROKEN    今天實測就是壞的：把【當下的壞值】（BODY + 工具列 4 顆）釘住，
  //             修好的那天這一列會變紅，逼人把它搬回 caret / bar-only。
  //             ⚠ v3.2.1 Task 11b 之後【沒有任何一列】用這個答案 —— Task 11
  //             量到的三個壞掉的入口（🔗 link / ⠿ 建立副本 / ⠿ 刪除）都修好
  //             並搬成 caret 了。checkLeverage() 末尾那一支因此暫時沒有呼叫
  //             者；留著是因為它是「下一個量到壞掉的入口」該有的形狀，不是
  //             因為現在有人在用它。
  //
  // 「按鈕在該狀態下必須是 enabled」本身也是斷言：少了它，一個被誤停用的
  // 按鈕會讓整列變成點不到任何東西的空跑，而空跑永遠是綠的。
  //
  // 兩種起始狀態，讓每一顆按鈕都在它真的 enabled 的狀態下被按：
  //   sel   段落內一段非空選取（bold 家族在這裡才 enabled）
  //   nest  巢狀清單項目內的游標（outdent / indent 只在這裡 enabled）
  const V2_SEL_MD = '# H\n\nAlpha bravo charlie delta.\n\nBravo paragraph.\n';
  const V2_NEST_MD = '# H\n\n- one item\n- two item\n  - nested item\n- three item\n\nTail para.\n';

  async function v2Boot(state) {
    const ctx = await newPage(state === 'nest' ? V2_NEST_MD : V2_SEL_MD);
    // Ruling T2-2: this matrix tests whether a toolbar button DOES something,
    // not whether the viewport is wide enough to reach it — toolbar
    // reachability is a layout question tracked separately, not an implicit
    // precondition of this matrix. 1000px gives every button clear margin.
    await ctx.page.setViewport({ width: 1000, height: 600 });
    // window.prompt() blocks the page until something answers it, and
    // applyLinkToggle() opens one — measured: without this handler the
    // 'link' row hangs until puppeteer's protocolTimeout kills the run.
    ctx.page.on('dialog', async (d) => { try { await d.accept('https://example.com/'); } catch (e) { /* already gone */ } });
    if (state === 'nest') {
      await ctx.page.evaluate(() => {
        const els = document.querySelectorAll('.ed-li-text');
        els[2].focus();                       // 'nested item' — depth 1
        const r = document.createRange();
        r.selectNodeContents(els[2]); r.collapse(false);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      });
    } else {
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
        const t = el.firstChild;
        const r = document.createRange();
        r.setStart(t, 0); r.setEnd(t, 5);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        el.focus();
        document.dispatchEvent(new Event('selectionchange'));
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    return ctx;
  }

  const readLeverage = (page) => page.evaluate(() => ({
    active: document.activeElement ? document.activeElement.tagName : null,
    activeClass: document.activeElement ? String(document.activeElement.className) : '',
    // Review I2: `save` excluded from this count — see the identical
    // comment on the "conversion restores focus" scenario earlier in this
    // file for why (NO_BLOCK_ALLOWED member whose OWN disabled flag tracks
    // ctx.dirty, which would otherwise let a dirty-but-genuinely-collapsed
    // toolbar read as 5 and slip every `<= 4` / `> 4` sentinel this
    // function feeds — TB_ROWS' checkLeverage() among them).
    enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn'))
      .filter((x) => !x.disabled && x.getAttribute('data-ed-tb') !== 'save').length,
    mode: document.body.getAttribute('data-ed-mode'),
  }));

  // v3.3.0 Task 19（Ruling T19-4）：這張表原本的 oracle 只讀「游標在哪／工具列
  // 還有幾顆亮著／在哪個模式」，對「這顆按鈕到底做了什麼」是沉默的。實測把
  // client.js 的 `case 'insert-after': return blockEl ?
  // insertBlockBelow(blockEl, 'paragraph') : undefined;` 改成 `return undefined;`：
  // 紅的是拿它當探針的那幾列 bar-only（checkLeverage() 自己會再按一次「在下方
  // 插入區塊」），insert-after 自己那一列是綠的 —— 一顆什麼都不做的按鈕，在它
  // 自己的列上通過了。
  //
  // 所以每一列多帶一個 effect(before, after)：會改文件的按鈕拿 block-type 清單、
  // 區塊文字、行內標記或 data-indent 當謂詞（效果會落到磁碟的再加一條逐位元組
  // 的 disk()），只改 chrome 的按鈕各自宣告自己的可觀察量。
  //
  // 順序上，effect 在 checkLeverage() 【之前】量，disk 在之後：
  //   * checkLeverage() 的 bar-only 分支自己會再按一次「在下方插入區塊」，那一
  //     下也會改文件形狀。
  //   * 存檔會動到 caret oracle —— 實測在 press 與 checkLeverage 之間插一次
  //     Ctrl+S，bold 那一列從 {active:'P',activeClass:'ed-wys-armed',enabled:15}
  //     變成 {active:'BODY',activeClass:'',enabled:4}。
  //   * insert-before / insert-after / table 的效果到不了磁碟（實測：按完存檔，
  //     位元組與原檔相同），所以它們的謂詞只能是 DOM 上的 block 形狀。
  const docSnap = (page) => page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('.ed-block'));
    const tg = document.querySelector('.sidebar-toggle, #sidebar-toggle');
    const clean = (s) => String(s || '').replace(/[＋⠿]/g, '')
      .replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
    return {
      types: blocks.map((b) => b.getAttribute('data-block-type')).join(','),
      indents: blocks.map((b) => String(b.getAttribute('data-indent'))).join(','),
      text: blocks.map((b) => clean(b.textContent)).join(' | '),
      marks: blocks.map((b) => Array.from(b.querySelectorAll('strong, em, del, a, code'))
        .map((e) => e.tagName + '(' + clean(e.textContent) + ')').join('+')).join(' | '),
      mode: document.body.getAttribute('data-ed-mode'),
      toolbarMenu: !!document.querySelector('.ed-toolbar-menu'),
      source: !!document.querySelector('.ed-source'),
      filePickers: document.querySelectorAll('input[type="file"]').length,
      sidebarOpen: document.body.hasAttribute('data-sidebar-open'),
      toggleExpanded: tg ? tg.getAttribute('aria-expanded') : null,
    };
  });
  // 'sel' fixture 開檔時的形狀，以及它被打過字之後的形狀。
  const V2_TEXT0 = 'H | Alpha bravo charlie delta. | Bravo paragraph.';
  const V2_TEXT_ZZ = 'H | ZZ bravo charlie delta. | Bravo paragraph.';
  const V2_NEST_TEXT0 = 'H | one item | two item | nested item | three item | Tail para.';
  const same = (b, a) => b.types === a.types && b.text === a.text && b.marks === a.marks;
  // undo / redo / indent 在原本的 fixture 上是無事可做的 no-op —— undo 沒有歷史，
  // 而 indent 原本的落點 'nested item' 按下去磁碟逐位元組不變（實測）。
  // 無事可做的按鈕與壞掉的按鈕在任何謂詞下都長得一樣，所以這三列先把事情安排
  // 出來。⚠ 打完字要先提交再按：實測「還開著髒 burst 就按工具列的 undo」落在
  // {active:'BODY',activeClass:'',enabled:4}，那是另一個題目，不是這一列要測的
  // 東西。
  const v2TypeAndCommit = async (ctx) => {
    await ctx.page.keyboard.type('ZZ');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Enter');          // blur → commit → render
    await new Promise((r) => setTimeout(r, 700));
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 300));
  };

  // 每一列共用的「必需答案」判定。回傳失敗訊息，或 null 表示通過。
  async function checkLeverage(ctx, name, answer) {
    const st = await readLeverage(ctx.page);
    const shown = name + ' → ' + JSON.stringify(st);
    if (answer === 'caret') {
      if (st.active === 'BODY') return shown + '（必需答案 caret：游標不得掉到 BODY）';
      // 「不是 BODY」還不夠 —— 焦點停在某顆按鈕或某個 wrapper 上一樣打不了字。
      if (!/\bed-wys-armed\b|\bed-wys-cell\b|\bed-raw\b/.test(st.activeClass)) {
        return shown + '（必需答案 caret：游標必須落在真的編輯面上' +
          '（ed-wys-armed / ed-wys-cell / ed-raw），不是只要不是 BODY 就好）';
      }
      if (st.enabled <= 4) return shown + '（必需答案 caret：工具列塌成 ' + st.enabled + ' 顆）';
      if (st.mode !== 'edit') return shown + '（必需答案 caret：不該離開 edit 模式）';
      return null;
    }
    if (answer === 'bar-only') {
      if (st.enabled <= 4) return shown + '（必需答案 bar-only：工具列塌成 ' + st.enabled + ' 顆）';
      if (st.mode !== 'edit') return shown + '（必需答案 bar-only：不該離開 edit 模式）';
      // 證明「工具列還瞄著」不是計數好看而已：再按一次「在下方插入區塊」，
      // 游標必須真的落在新段落上。
      //
      // v3.2.1 final wave, M8: 這一發【不再】吞掉失敗。原本的 `.catch(() => {})`
      // 讓「按鈕點不到」（被別的東西蓋住、被 detach、disabled）與「按到了但游標
      // 沒回來」共用同一個失敗訊息，而前者其實是更嚴重的那一個 —— 而且如果
      // 後續狀態剛好healthy，它會直接變成綠的。
      try {
        await pressClick(ctx.page, '[data-ed-tb="insert-after"]', 80);
      } catch (e) {
        return shown + '（必需答案 bar-only：後續驗證按不到「在下方插入區塊」' +
          '這顆按鈕本身 —— ' + String(e && e.message || e) + '）';
      }
      await new Promise((r) => setTimeout(r, 500));
      const after = await readLeverage(ctx.page);
      if (after.active === 'BODY') {
        return shown + '（必需答案 bar-only：工具列數字說還瞄著，但「在下方插入區塊」' +
          '按下去游標仍落在 BODY —— 那個「還瞄著」是假的，got ' + JSON.stringify(after) + '）';
      }
      return null;
    }
    if (answer === 'source') {
      if (st.mode !== 'source') return shown + '（必需答案 source：必須進入 source 模式）';
      if (st.activeClass.indexOf('ed-source') === -1) {
        return shown + '（必需答案 source：游標必須在 .ed-source textarea 裡）';
      }
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 400));
      const back = await readLeverage(ctx.page);
      if (back.mode !== 'edit' || back.enabled <= 4) {
        return shown + '（必需答案 source：再按一次必須回到 edit 且工具列復原，got ' +
          JSON.stringify(back) + '）';
      }
      return null;
    }
    // v3.2.1 fix round 1: BROKEN is the LAST branch, so it is also the branch a
    // misspelt answer silently falls into — and it demands BREAKAGE, so a row
    // that meant to demand health would go green while asserting the opposite.
    // Nothing below this line may be reached by accident.
    if (answer !== 'BROKEN') throw new Error('unknown 必需答案: ' + JSON.stringify(answer));
    // BROKEN —— 釘住今天量到的壞值。
    if (st.active !== 'BODY' || st.enabled !== 4) {
      return shown + '（這一列被釘成「今天已知是壞的」：BODY + 工具列 4 顆。' +
        '現在量到的不是那個值 —— 如果是修好了，把它從 BROKEN 搬到 caret / bar-only；' +
        '如果是壞成別的樣子，那是新缺陷）';
    }
    return null;
  }

  {
    const ids = await (async () => {
      const ctx = await newPage(V2_SEL_MD);
      const r = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-toolbar-btn'))
          .map((b) => b.getAttribute('data-ed-tb')).filter(Boolean));
      await ctx.page.close(); ctx.srv.close();
      return r;
    })();
    assert.strictEqual(ids.length, 23, '工具列應為 23 顆，got ' + ids.length);

    const TB_ROWS = [
      // v3.4.0 §3: `ctx.dirty` is wired now (lib/editor/client.js's
      // toolbarContext()/documentIsDirty()) — this replaces the temporary
      // 'disabled' tripwire that stood here through Task 3 (it warned this
      // exact day would come: "this row must go red ... and migrate to
      // whatever real answer clicking Save produces").
      //
      // The arrange deliberately leaves an UNCOMMITTED edit sitting in the
      // open burst (typed, never blurred/committed) rather than reusing
      // v2TypeAndCommit (the undo/redo rows below): that is the HARDER of
      // the two paths into a dirty document. Pressing save must resolve
      // (commit + re-render) this very burst before save() itself ever
      // runs — same precondition Ctrl+S already has, see save()'s own
      // dispatch comments — and that commit's render is exactly the class
      // of render that used to strand the caret on BODY: unconditionally
      // for quote/code/line and for undo/redo/image whenever a burst was
      // left open (activateToolbarCursor()'s own comment) — both now fixed
      // (Task 9 backlog #6: the raw-editor rescue for quote/code/line, and
      // undoViaToolbar()/redoViaToolbar()/imageViaToolbar() for the other
      // three). `save` must not become a fourth name needing the same fix,
      // and `answer: 'caret'` below is exactly the claim that it does not.
      { id: 'save',         state: 'sel',  answer: 'caret',
        arrange: async (ctx) => {
          await ctx.page.keyboard.type('ZZ'); // replaces the pre-selected "Alpha"
          await new Promise((r) => setTimeout(r, 250));
        },
        // The click must not itself change what is on screen — the
        // uncommitted "ZZ" was already visible before the press, and a
        // commit-then-save round-trip re-renders the same bytes.
        //
        // Review I3: the `disk` predicate below is NOT what proves the
        // click wrote anything — saveAndRead() (the loop's shared `row.disk`
        // runner) issues its OWN Ctrl+S before reading the file, so `disk`
        // would read back correct bytes even if the save BUTTON did
        // nothing at all. The actual proof that the CLICK itself persisted
        // the commit is the direct `fs.readFileSync()` the main loop does
        // for this row specifically, BEFORE saveAndRead() ever runs (see
        // "review I3" in the loop body, right after the press). `disk`
        // stays as a secondary, harmless confirmation of the same bytes
        // post-Ctrl+S.
        effect: (b, a) => same(b, a) ? null
          : '按下 save 不應該改變畫面上的任何區塊內容，got before ' +
            JSON.stringify(b) + ' after ' + JSON.stringify(a),
        disk: (d) => d === '# H\n\nZZ bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '按下工具列的 save 必須先把還沒提交的編輯提交，再把結果存到磁碟' },
      { id: 'undo',         state: 'sel',  answer: 'caret',
        arrange: v2TypeAndCommit,
        effect: (b, a) => b.text !== V2_TEXT_ZZ
          ? 'arrange 沒有把文件改成可以退回的樣子，got ' + b.text
          : (a.text === V2_TEXT0 ? null : '按下去必須把剛剛提交的那次編輯退回去，got ' + a.text) },
      { id: 'redo',         state: 'sel',  answer: 'caret',
        arrange: async (ctx) => {
          await v2TypeAndCommit(ctx);
          await pressClick(ctx.page, '[data-ed-tb="undo"]', 80);
          await new Promise((r) => setTimeout(r, 500));
          await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
          await new Promise((r) => setTimeout(r, 300));
        },
        effect: (b, a) => b.text !== V2_TEXT0
          ? 'arrange 的那一次 undo 沒有生效，redo 就沒有東西可以重做，got ' + b.text
          : (a.text === V2_TEXT_ZZ ? null : '按下去必須把被退回的那次編輯做回來，got ' + a.text) },
      // 只開 H▾ 選單，不轉換 —— 所以它的可觀察量是那張下拉，不是文件。
      { id: 'headings',     state: 'sel',  answer: 'caret',
        effect: (b, a) => !a.toolbarMenu ? 'H▾ 必須開出 .ed-toolbar-menu'
          : (same(b, a) ? null : '只開選單不得動到文件，got ' + a.types + ' / ' + a.text) },
      // Task 9 review M4: bar-only → caret. backlog #6's fix
      // (restoreAfterStructuralOp()'s `allowRawEditRescue`) now opens the
      // converted block's own raw editor when it lands with no focusable
      // WYSIWYG surface — MEASURED (review): activeClass 'ed-raw',
      // enabled 15, mode 'edit', matching 'caret''s own shape exactly.
      { id: 'quote',        state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,blockquote,paragraph' ? null
          : '選取所在的段落必須變成 blockquote，got ' + a.types },
      { id: 'code',         state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,code,paragraph' ? null
          : '選取所在的段落必須變成 code block，got ' + a.types },
      // ul / ol / task 在 DOM 上都是 li，分不出來 —— 那三列各自靠 disk() 的
      // 逐位元組比對區分（實測 '- ' / '1. ' / '- [ ] '）。
      { id: 'list',         state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,li,paragraph' ? null
          : '選取所在的段落必須變成清單項，got ' + a.types,
        disk: (d) => d === '# H\n\n- Alpha bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 ul' },
      { id: 'ordered-list', state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,li,paragraph' ? null
          : '選取所在的段落必須變成清單項，got ' + a.types,
        disk: (d) => d === '# H\n\n1. Alpha bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 ol' },
      { id: 'check',        state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,li,paragraph' ? null
          : '選取所在的段落必須變成清單項，got ' + a.types,
        disk: (d) => d === '# H\n\n- [ ] Alpha bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是待辦項' },
      { id: 'bold',         state: 'sel',  answer: 'caret',
        effect: (b, a) => a.marks === ' | STRONG(Alpha) | ' ? null
          : '選取的字必須被 STRONG 包起來，而且不得多出別的標記，got ' + a.marks,
        disk: (d) => d === '# H\n\n**Alpha** bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 **Alpha**' },
      { id: 'italic',       state: 'sel',  answer: 'caret',
        effect: (b, a) => a.marks === ' | EM(Alpha) | ' ? null
          : '選取的字必須被 EM 包起來，而且不得多出別的標記，got ' + a.marks,
        disk: (d) => d === '# H\n\n*Alpha* bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 *Alpha*' },
      { id: 'strike',       state: 'sel',  answer: 'caret',
        effect: (b, a) => a.marks === ' | DEL(Alpha) | ' ? null
          : '選取的字必須被 DEL 包起來，而且不得多出別的標記，got ' + a.marks,
        disk: (d) => d === '# H\n\n~~Alpha~~ bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 ~~Alpha~~' },
      { id: 'inline-code',  state: 'sel',  answer: 'caret',
        effect: (b, a) => a.marks === ' | CODE(Alpha) | ' ? null
          : '選取的字必須被 CODE 包起來，而且不得多出別的標記，got ' + a.marks,
        disk: (d) => d === '# H\n\n`Alpha` bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是 `Alpha`' },
      // v3.2.1 Task 11b：BROKEN → caret。成因量測（見報告的時間軸）是
      // window.prompt() 關閉【之後】瀏覽器補的那一發 focusout —— 焦點其實立刻
      // 回到那個面（t=31ms 的 focusin），真正拆掉著力點的是文件層 delegator
      // 把那一發讀成「使用者離開了」而跑掉的 commit → rerenderAll()（實測走
      // applyFullRender，整個 .content 被換掉）。applyLinkToggle() 現在是一層
      // async thin wrapper，等那次 render 落地之後才把游標放回【同一個 block】
      // （連結是 block 內的 inline 編輯，block 本身活著）。實測：連結照樣寫進
      // 磁碟（[Alpha](https://example.com/)），activeElement 回到
      // P.ed-wys-armed、工具列 15 顆。
      { id: 'link',         state: 'sel',  answer: 'caret',
        effect: (b, a) => a.marks === ' | A(Alpha) | ' ? null
          : '選取的字必須變成連結，而且不得多出別的標記，got ' + a.marks,
        disk: (d) => d === '# H\n\n[Alpha](https://example.com/) bravo charlie delta.\n\nBravo paragraph.\n'
          ? null : '磁碟上必須是對話框回答的那個網址' },
      { id: 'outdent',      state: 'nest', answer: 'caret',
        effect: (b, a) => b.indents !== 'null,0,0,1,0,null'
          ? 'nest fixture 的縮排層級不是預期的樣子，got ' + b.indents
          : (a.indents === 'null,0,0,0,0,null' && a.text === V2_NEST_TEXT0 ? null
            : '游標所在的那一項必須退一層，其他項不得被搬動，got ' +
              a.indents + ' / ' + a.text),
        disk: (d) => d === '# H\n\n- one item\n- two item\n- nested item\n- three item\n\nTail para.\n'
          ? null : '磁碟上那一項必須退回頂層' },
      // indent 換一個落點：在原本的 'nested item' 上按下去，磁碟逐位元組不變
      // （實測），那一列因此對「按鈕壞掉」是沉默的。改瞄 'three item' —— 實測
      // 它會從頂層進到第一層，磁碟上也跟著多兩格。
      { id: 'indent',       state: 'nest', answer: 'caret',
        arrange: async (ctx) => {
          await ctx.page.evaluate(() => {
            const els = document.querySelectorAll('.ed-li-text');
            els[3].focus();
            const r = document.createRange();
            r.selectNodeContents(els[3]); r.collapse(false);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            document.dispatchEvent(new Event('selectionchange'));
          });
          await new Promise((r) => setTimeout(r, 300));
        },
        effect: (b, a) => b.indents !== 'null,0,0,1,0,null'
          ? 'nest fixture 的縮排層級不是預期的樣子，got ' + b.indents
          : (a.indents === 'null,0,0,1,1,null' && a.text === V2_NEST_TEXT0 ? null
            : '游標所在的那一項必須進一層，其他項不得被搬動，got ' +
              a.indents + ' / ' + a.text),
        disk: (d) => d === '# H\n\n- one item\n- two item\n  - nested item\n  - three item\n\nTail para.\n'
          ? null : '磁碟上那一項必須縮進一層' },
      { id: 'table',        state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,paragraph,table,paragraph' ? null
          : '必須在游標那個 block 後面長出一個表格，got ' + a.types },
      { id: 'insert-before', state: 'sel', answer: 'caret',
        effect: (b, a) => a.types !== 'heading,paragraph,paragraph,paragraph'
          ? '必須多出一個段落，got ' + a.types
          : (a.text === 'H |  | Alpha bravo charlie delta. | Bravo paragraph.' ? null
            : '新段落必須落在游標那個 block 【前面】，got ' + a.text) },
      { id: 'insert-after', state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types !== 'heading,paragraph,paragraph,paragraph'
          ? '必須多出一個段落，got ' + a.types
          : (a.text === 'H | Alpha bravo charlie delta. |  | Bravo paragraph.' ? null
            : '新段落必須落在游標那個 block 【後面】，got ' + a.text) },
      // Task 9 review M4: bar-only → caret. insertBlockBelow()'s own
      // `kind === 'line'` branch now opens the new hr's raw editor — same
      // MEASURED shape as quote/code above.
      { id: 'line',         state: 'sel',  answer: 'caret',
        effect: (b, a) => a.types === 'heading,paragraph,hr,paragraph' ? null
          : '必須在游標那個 block 後面長出一條分隔線，got ' + a.types },
      // 圖片按鈕開的是一顆 hidden 的 input[type=file]（pickAndInsertImage()
      // 自己建、append 到 body），檔案要等使用者選了才進文件 —— 所以它宣告的
      // 可觀察量是「那顆挑選器出現了」。
      { id: 'image',        state: 'sel',  answer: 'caret',
        effect: (b, a) => a.filePickers > b.filePickers ? null
          : '必須開出一顆檔案挑選器，got filePickers ' + b.filePickers + ' → ' + a.filePickers },
      // 1000px 寬（見 v2Boot()）落在 toggleOutlineSidebar() 的 mobile 分支，
      // 它動的是 body 的 data-sidebar-open 與 .sidebar-toggle 的 aria-expanded。
      { id: 'outline',      state: 'sel',  answer: 'caret',
        effect: (b, a) => b.sidebarOpen
          ? '前提失敗：抽屜在按之前就是開的，這一列量不到切換'
          : (a.sidebarOpen && a.toggleExpanded === 'true' ? null
            : '必須把抽屜打開、並且讓 .sidebar-toggle 說自己 expanded，got ' +
              a.sidebarOpen + ' / ' + a.toggleExpanded) },
      { id: 'preview',      state: 'sel',  answer: 'source',
        effect: (b, a) => a.mode === 'source' && a.source ? null
          : '必須切到 source 模式並且開出 .ed-source，got ' + a.mode + ' / ' + a.source },
    ];
    assert.deepStrictEqual(TB_ROWS.map((r) => r.id).slice().sort(), ids.slice().sort(),
      'V2 表必須恰好覆蓋工具列上的每一顆按鈕 —— 新增按鈕時必須同時決定它的必需答案');
    // 沒有效果謂詞的一列就是回到舊 oracle 的一列，所以少寫一個就直接紅在這裡，
    // 而不是安靜地退化成「按下去、游標還在、算按鈕數」。
    assert.deepStrictEqual(TB_ROWS.filter((r) => typeof r.effect !== 'function')
      .map((r) => r.id), [],
      'V2 表的每一列都必須宣告自己的效果謂詞 effect(before, after)');

    const bad = [];
    for (const row of TB_ROWS) {
      const ctx = await v2Boot(row.state);
      if (row.arrange) await row.arrange(ctx);
      const dis = await ctx.page.evaluate((i) =>
        document.querySelector('[data-ed-tb="' + i + '"]').disabled, row.id);
      if (dis) {
        // `answer: 'disabled'` is the one legitimate reason a row may find
        // its button disabled (the `save` row used it through Task 3, before
        // ctx.dirty wiring landed — no row currently needs it, but the
        // branch stays: a future button that is legitimately disabled on
        // every fixture this matrix can construct has somewhere to say so).
        // Every other row still treats this branch as the bug it always
        // was: a disabled button means the row clicked nothing and its whole
        // verdict is a false green.
        if (row.answer !== 'disabled') {
          bad.push(row.id + ' → 在 ' + row.state + ' 狀態下是 disabled，這一列什麼都沒點到（空跑的綠燈）');
        }
        await ctx.page.close(); ctx.srv.close();
        continue;
      }
      if (row.answer === 'disabled') {
        bad.push(row.id + ' → 預期在 ' + row.state + ' 狀態下維持 disabled，但現在是 enabled —— ' +
          'client.js 的 ctx.dirty 佈線任務顯然已經上線，這一列必須搬到它實際點下去的答案');
        await ctx.page.close(); ctx.srv.close();
        continue;
      }
      const before = await docSnap(ctx.page);
      await pressClick(ctx.page, '[data-ed-tb="' + row.id + '"]', 80);
      await new Promise((r) => setTimeout(r, 450));
      // Review I3: read the file directly HERE, before anything below gets a
      // chance to press Ctrl+S of its own accord (saveAndRead(), which
      // `row.disk` runs through further down, issues its own Ctrl+S — a
      // save button that did nothing would still pass that check). This is
      // the one assertion that actually proves THE CLICK wrote the bytes.
      if (row.id === 'save') {
        const clickOnlyBytes = fs.readFileSync(ctx.mdPath, 'utf8');
        if (clickOnlyBytes !== '# H\n\nZZ bravo charlie delta.\n\nBravo paragraph.\n') {
          bad.push('save → 按下按鈕本身（在任何 Ctrl+S 之前）必須已經把提交後的內容存到磁碟，got:\n' +
            clickOnlyBytes);
        }
      }
      const after = await docSnap(ctx.page);
      const noEffect = row.effect(before, after);
      if (noEffect) {
        bad.push(row.id + ' → 效果謂詞不成立：' + noEffect +
          '\n    before ' + JSON.stringify(before) + '\n    after  ' + JSON.stringify(after));
      }
      const fail = await checkLeverage(ctx, row.id, row.answer);
      if (fail) bad.push(fail);
      if (row.disk) {
        const bytes = await saveAndRead(ctx);
        const wrong = row.disk(bytes);
        if (wrong) bad.push(row.id + ' → 磁碟謂詞不成立：' + wrong + '，got:\n' + bytes);
      }
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], '這些工具列按鈕的必需答案沒有成立:\n' + bad.join('\n'));
    console.log('journey: V2 toolbar matrix — OK (' + TB_ROWS.length + ' buttons)');
  }

  // ── V2b: ⠿ 選單的每一個葉節點 ────────────────────────────────────────
  {
    const GUTTER_ROWS = [
      // v3.2.1 Task 11b：兩列都從 BROKEN 搬到 caret —— 兩條路徑都補上了
      // convertBlockViaMenu() 那個 finally 形狀的 thin wrapper，但落點各自不同。
      //
      // 建立副本 → 落在【原件】上（副本插在它下面）。實測本列：activeElement
      //   回到 block 1 的 P.ed-wys-armed、工具列 15 顆；li 版本落在原件自己的
      //   .ed-li-text 上。為什麼是原件而不是副本，見 duplicateBlockViaMenu()
      //   的註解（一個手勢只能有一個答案 / 副本的行號不可定址 / 畫面不動）。
      // 刪除 → 被刪的 block 不存在了，落點是【洞上面那一個】的結尾（Notion 的
      //   答案，也是 Backspace 併行的落點）；刪掉的是文件第一個 block 時落到
      //   移上來的那一個。實測本列（V2_SEL_MD 刪 block 1）：游標落在標題上，
      //   activeElement 是 H1.heading-with-anchor ed-wys-armed、工具列 15 顆。
      { label: '建立副本',     answer: 'caret' },
      { label: '刪除',        answer: 'caret' },
      { label: 'MD 原始碼',    answer: 'caret' },
      { label: '文字',        answer: 'caret',    convert: true },
      { label: '標題 1',      answer: 'caret',    convert: true },
      { label: '標題 2',      answer: 'caret',    convert: true },
      { label: '標題 3',      answer: 'caret',    convert: true },
      { label: '標題 4',      answer: 'caret',    convert: true },
      { label: '標題 5',      answer: 'caret',    convert: true },
      { label: '標題 6',      answer: 'caret',    convert: true },
      { label: '項目符號列表',  answer: 'caret',    convert: true },
      { label: '編號列表',     answer: 'caret',    convert: true },
      { label: '待辦清單',     answer: 'caret',    convert: true },
      // Task 9 review M4 (found while fixing the identical staleness in
      // TB_ROWS above): bar-only → caret. The ⠿ menu's own 轉換成 submenu
      // calls the SAME convertBlockViaMenu() the toolbar's quote/code
      // buttons do, so backlog #6's `allowRawEditRescue` fix applies here
      // too — MEASURED, activeClass 'ed-raw', enabled 15, mode 'edit'.
      { label: '程式碼',       answer: 'caret', convert: true },
      { label: '引用',        answer: 'caret', convert: true },
    ];
    // 覆蓋率守衛：⠿ 的葉節點集合必須恰好等於上表。多一項少一項都要有人決定
    // 它的必需答案，而不是安靜地不被測到。
    {
      const ctx = await newPage(V2_SEL_MD);
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      const top = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-handle-menu-btn')).map((x) => x.textContent.trim()));
      await ctx.page.evaluate(() => {
        Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((x) => x.textContent.indexOf('轉換成') !== -1).click();
      });
      await new Promise((r) => setTimeout(r, 350));
      const all = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-handle-menu-btn')).map((x) => x.textContent.trim()));
      // 展開子選單後兩張面板同時在 DOM 裡，所以 `all` 是「頂層 + 子選單」的
      // 串接；葉節點 = all 去掉「轉換成 ›」這個開關本身。
      const leaves = all.filter((t) => t.indexOf('轉換成') === -1);
      await ctx.page.close(); ctx.srv.close();
      assert.ok(top.indexOf('轉換成 ›') !== -1, '⠿ 頂層應有「轉換成 ›」，got ' + JSON.stringify(top));
      assert.deepStrictEqual(leaves.slice().sort(), GUTTER_ROWS.map((r) => r.label).slice().sort(),
        'V2b 表必須恰好覆蓋 ⠿ 的每一個葉節點，got ' + JSON.stringify(leaves));
    }

    const bad = [];
    // Deliberately clean-burst: this loop places the cursor with a plain
    // `.click()` on `.ed-wys-armed` and never types, so there is no dirty
    // burst for a mousedown-triggered commit to race against — no detection
    // power for the ⠿/＋ detach family, and correctly not a missed
    // conversion of the in-page `.ed-handle-menu-btn` clicks below.
    for (const row of GUTTER_ROWS) {
      const ctx = await newPage(V2_SEL_MD);
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      if (row.convert) {
        await ctx.page.evaluate(() => {
          Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
            .find((x) => x.textContent.indexOf('轉換成') !== -1).click();
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      // 子選單展開後頂層仍在 DOM 裡，標籤可能重複；取最後一個 = 子選單那顆。
      await ctx.page.evaluate((L) => {
        const hits = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === L);
        if (!hits.length) throw new Error('⠿ item not found: ' + L);
        hits[hits.length - 1].click();
      }, row.label);
      await new Promise((r) => setTimeout(r, 550));
      const fail = await checkLeverage(ctx, '⠿ ' + row.label, row.answer);
      if (fail) bad.push(fail);
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], '這些 ⠿ 選單項目的必需答案沒有成立:\n' + bad.join('\n'));
    console.log('journey: V2 gutter-menu matrix — OK (' + GUTTER_ROWS.length + ' items)');
  }

  // ── V2c: 停用的工具列按鈕 —— v3.2.1 fix round 1 修好，這裡釘住修好的值 ──
  //
  // 使用者感知到的症狀與上面三列一樣（按了工具列一下就掉焦點），但成因不同，
  // 而且兩件事必須分開講，因為第一版的結論在這裡犯過錯：
  //
  //   * `mousedown` 與 `click` 對一顆 disabled 的 <button> 【完全不派發】——
  //     掛在 document 上的 capture 期監聽器各收到 0 次，整條傳播路徑都沒有。
  //     所以按鈕自己那一發 mousedown preventDefault() 跑不到，掛在
  //     `.ed-toolbar` 容器上的一發同樣跑不到。這一段的 seen === 0 就是這件事，
  //     它仍然是真的，也仍然被釘著。
  //   * 但 `pointerdown` 【有】派發（同一個監聽器收到 1 次）而且可取消，取消
  //     它會一併壓掉相容性的 mousedown 與它的預設動作 —— 也就是把焦點從
  //     contenteditable 收走那一步。修法因此是 buildToolbar() 裡 capture 期的
  //     四行 pointerdown handler，不需要 pointer-events: none、不需要動 click
  //     delegator、也不會弄丟 disabled 按鈕的 title tooltip。
  //
  // 兩態都必須healthy，因為它們的失敗長得不一樣：burst 沒被編輯過時那一發
  // focusout 走 endBurstWithoutResolve()（不 commit、不 render，工具列不塌，
  // 只掉游標）；打過字時走完整的 commit → rerenderAll()，工具列會塌成 4 顆。
  // 修好之前實測是 BODY/15 與 BODY/4，修好之後兩態都是 P.ed-wys-armed/15。
  {
    for (const dirty of [false, true]) {
      const ctx = await newPage(V2_SEL_MD);
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 250));
      if (dirty) {
        await ctx.page.keyboard.type('XY');
        await new Promise((r) => setTimeout(r, 200));
      }
      const isDisabled = await ctx.page.evaluate(() =>
        document.querySelector('[data-ed-tb="bold"]').disabled);
      assert.strictEqual(isDisabled, true,
        'V2c: 游標收合（沒有選取）時 bold 必須是 disabled，否則這個情境什麼都沒點到');
      await ctx.page.evaluate(() => {
        window.__v2c = { pointerdown: 0, mousedown: 0, click: 0 };
        ['pointerdown', 'mousedown', 'click'].forEach((n) =>
          document.addEventListener(n, () => { window.__v2c[n]++; }, true));
      });
      await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
      await new Promise((r) => setTimeout(r, 700));
      const st = await readLeverage(ctx.page);
      const counts = await ctx.page.evaluate(() => window.__v2c);
      assert.strictEqual(counts.mousedown, 0,
        'V2c(dirty=' + dirty + '): disabled 按鈕【不】派發 mousedown —— 這是為什麼修法' +
        '不能是「在 .ed-toolbar 上加一發 mousedown preventDefault()」。got ' + JSON.stringify(counts));
      assert.strictEqual(counts.click, 0,
        'V2c(dirty=' + dirty + '): disabled 按鈕也不派發 click，got ' + JSON.stringify(counts));
      assert.strictEqual(counts.pointerdown, 1,
        'V2c(dirty=' + dirty + '): pointerdown 【有】派發，而且正是修法掛的那一發 —— ' +
        '這個數字掉到 0 表示修法失去了立足點，got ' + JSON.stringify(counts));
      assert.notStrictEqual(st.active, 'BODY',
        'V2c(dirty=' + dirty + '): 按到一顆停用的按鈕不得帶走游標，got ' + JSON.stringify(st));
      assert.ok(/\bed-wys-armed\b/.test(st.activeClass),
        'V2c(dirty=' + dirty + '): 游標必須還在原來那個編輯面上，got ' + JSON.stringify(st));
      // v3.4.0 §3 / review I2: stays 15 in BOTH branches — readLeverage()'s
      // `enabled` deliberately excludes `save` (see its own comment) so
      // this count keeps meaning exactly what it always meant here
      // ("clicking a DISABLED button changes nothing"), independent of
      // whether typing 'XY' above also lit the save button itself.
      assert.strictEqual(st.enabled, 15,
        'V2c(dirty=' + dirty + '): 工具列不得改變 —— 沒有 commit、沒有 render，' +
        'got ' + JSON.stringify(st));
      assert.strictEqual(ctx.errs.length, 0, 'V2c: 不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V2c a disabled toolbar button keeps the caret — OK');
  }

  // ── V2e: 🔗 開了對話框又取消 —— 手上握著的選取必須原封不動 ──────────────
  //
  // fix round 1 item 1。willPrompt 只保證 modal 會【開】，不保證使用者按了確定；
  // Esc 取消時 body 不做任何 DOM 手術、burst 走 endBurstWithoutResolve()、沒有
  // commit 也沒有 render，焦點自己回到那個面。第一版的 wrapper 仍然無條件
  // focusBlockAtLine(line, true)，把使用者的選取塌成 block 結尾的一個游標 ——
  // 修之前實測 sel=""/collapsed=true/20→15 顆，修之後 sel="Alpha"/collapsed=false。
  // 這一段就是當初缺的那個斷言：取消是最常見的手勢，而它比接受更不該有代價。
  {
    const ctx = await newPage(V2_SEL_MD);
    ctx.page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* already gone */ } });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus(); document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    await pressClick(ctx.page, '[data-ed-tb="link"]', 80);
    await new Promise((r) => setTimeout(r, 900));
    const held = await ctx.page.evaluate(() => {
      const s = window.getSelection();
      return {
        text: s && s.rangeCount ? String(s.toString()) : '',
        collapsed: s ? s.isCollapsed : null,
        activeClass: document.activeElement ? String(document.activeElement.className || '') : '',
      };
    });
    assert.strictEqual(held.text, 'Alpha',
      'V2e: 取消連結對話框不得動到使用者的選取，got ' + JSON.stringify(held));
    assert.strictEqual(held.collapsed, false,
      'V2e: 選取必須仍是非收合的，got ' + JSON.stringify(held));
    assert.ok(/\bed-wys-armed\b/.test(held.activeClass),
      'V2e: 焦點必須仍在那個編輯面上，got ' + JSON.stringify(held));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('https://example.com') , -1,
      'V2e: 取消不得寫任何連結進磁碟，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'V2e: 不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V2e cancelling the 🔗 dialog keeps the selection — OK');
  }

  // ── V2f: ⠿ 刪除 的落點，在「下一個 block 緊接著沒有空行」的四種形狀上 ────
  //
  // fix round 1 item 2。commitRangeRemoval() 在「範圍後面那一行不是空白」時
  // 改吸收上面那一行空白，於是洞【以下】的每一個 block 也往上搬，其中第一個
  // 剛好落在 holeLine - 1 —— 也就是說「洞座標以下取最大 startLine」這個舊規則
  // 會【必然】選中洞下面那一個而不是上面那一個。四種都是合法 markdown（ATX
  // 標題／清單／圍欄程式碼／分隔線都能在沒有空行的情況下中斷一個段落），修之前
  // 實測分別落在 H2／li／BODY／BODY，修之後四種都落在洞上面的 'Alpha para.'。
  // 落點因此改成由 body 在 commit 之前捕捉並攜帶，不再從洞的座標反推。
  {
    const TAILS = [
      ['ATX heading', '# H\n\nAlpha para.\n\nBravo para.\n# H2 below\n'],
      ['list',        '# H\n\nAlpha para.\n\nBravo para.\n- item one\n- item two\n'],
      ['fenced code', '# H\n\nAlpha para.\n\nBravo para.\n```\ncode here\n```\n'],
      ['hr',          '# H\n\nAlpha para.\n\nBravo para.\n***\n'],
      ['blank (control)', '# H\n\nAlpha para.\n\nBravo para.\n\nTail para.\n'],
    ];
    // Deliberately clean-burst: neither loop below types into the target
    // block before opening ⠿ (only navigates/hovers), so there is no dirty
    // burst for a mousedown-triggered commit to race against — no detection
    // power for the ⠿/＋ detach family, and correctly not a missed
    // conversion of the in-page `.ed-handle-menu-btn` clicks below.
    for (const [name, md] of TAILS) {
      const ctx = await newPage(md);
      const id = await ctx.page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ed-block'))
          .find((b) => b.textContent.trim().startsWith('Bravo para.'));
        return el ? el.getAttribute('data-block-id') : null;
      });
      assert.ok(id !== null, 'V2f(' + name + '): fixture block not found');
      const sel = '.ed-block[data-block-id="' + id + '"]';
      await ctx.page.hover(sel);
      await pressClick(ctx.page, sel + ' .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      await ctx.page.evaluate(() => {
        const h = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === '刪除');
        h[h.length - 1].click();
      });
      await new Promise((r) => setTimeout(r, 800));
      const landed = await ctx.page.evaluate(() => {
        const a = document.activeElement;
        const b = a && a.closest ? a.closest('.ed-block') : null;
        return {
          text: b ? (b.textContent || '').replace(/[＋⠿]/g, '').trim() : null,
          activeClass: a ? String(a.className || '') : '',
        };
      });
      assert.strictEqual(landed.text, 'Alpha para.',
        'V2f(' + name + '): 刪除之後游標必須落在洞【上面】那一個 block，got ' +
        JSON.stringify(landed));
      assert.ok(/\bed-wys-armed\b/.test(landed.activeClass),
        'V2f(' + name + '): 而且必須落在真的編輯面上，got ' + JSON.stringify(landed));
      await ctx.page.close(); ctx.srv.close();
    }
    // 刪掉文件第一個 block：上面沒有東西，落點是移上來的那一個。
    {
      const ctx = await newPage('# H\n\nAlpha para.\n\nBravo para.\n');
      await ctx.page.hover('.ed-block[data-block-id="0"]');
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      await ctx.page.evaluate(() => {
        const h = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === '刪除');
        h[h.length - 1].click();
      });
      await new Promise((r) => setTimeout(r, 800));
      const landed = await ctx.page.evaluate(() => {
        const a = document.activeElement;
        const b = a && a.closest ? a.closest('.ed-block') : null;
        return { text: b ? (b.textContent || '').replace(/[＋⠿]/g, '').trim() : null,
          activeClass: a ? String(a.className || '') : '' };
      });
      assert.strictEqual(landed.text, 'Alpha para.',
        'V2f(first block): 刪掉文件第一個 block 之後，落點是移上來的那一個，got ' +
        JSON.stringify(landed));
      assert.ok(/\bed-wys-armed\b/.test(landed.activeClass),
        'V2f(first block): 必須落在真的編輯面上，got ' + JSON.stringify(landed));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V2f ⠿ 刪除 lands above the hole on every interrupt shape — OK');
  }

  // ── V2d: 🔗 在一個 TABLE 儲存格裡 —— Task 11b 那一修的另一個形狀 ────────
  //
  // V2 的 link 那一列走的是段落。同一顆按鈕在表格儲存格上會走到 caret 還原
  // 不回來的那一支，而那不是遺漏、是量出來的邊界：selToolbarEditEl 是 CELL，
  // 但還原只有「block 的起始行」可用，而 blockContentEl() 對一個 table block
  // 回傳 firstElementChild ＝ <table> 本身，它沒有 tabindex、focus() 是 no-op。
  // 所以必需答案是 bar-only：連結要正確寫進磁碟、工具列要還瞄著那張表（而且
  // bar-only 的判定會真的再按一次「在下方插入區塊」證明那個「還瞄著」能用）。
  // 修好之前這裡量到的是工具列塌成 4 顆，也就是連 bar-only 都不成立。
  // N2：primed 與 unprimed 都要跑 —— 這一列的必需答案就是 bar-only，也就是
  // 「工具列還瞄著」是它唯一交付的東西，而 C1 拿掉的正好就是那個東西。
  for (const primed of [false, true]) {
    const ctx = await newPage('# H\n\n| A | B |\n| --- | --- |\n| alpha | bravo |\n\nTail para two.\n');
    if (primed) await primeOneCommit(ctx);
    await installPatchSpy(ctx);
    ctx.page.on('dialog', async (d) => { try { await d.accept('https://example.com/'); } catch (e) { /* already gone */ } });
    await ctx.page.click('.ed-wys-cell');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      const el = cells[cells.length - 1];   // 'bravo'
      el.focus();
      const t = el.firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 350));
    const linkDisabled = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="link"]').disabled);
    assert.strictEqual(linkDisabled, false,
      'V2d: 儲存格裡有非空選取時 🔗 必須是 enabled，否則這個情境什麼都沒點到');
    await pressClick(ctx.page, '[data-ed-tb="link"]', 80);
    await new Promise((r) => setTimeout(r, 900));
    assertRoute(await patchRoutes(ctx), primed, 'V2d(primed=' + primed + ')');
    const fail = await checkLeverage(ctx, '🔗 in a table cell (primed=' + primed + ')', 'bar-only');
    assert.strictEqual(fail, null, 'V2d(primed=' + primed + '): ' + fail);
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('[bravo](https://example.com/)') !== -1,
      'V2d(primed=' + primed + '): 連結必須真的寫進磁碟，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'V2d: 不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: V2d 🔗 in a table cell — bar-only, link on disk — OK');

  // ── V2g: 標題到頂／到底時按 Tab —— 夾住的那一步不得把你踢出區塊 ──────────
  //
  // v3.2.1 final wave, I1。changeHeadingDepth() 的 `newDepth === curDepth`
  // 早退出點【在】switchAwayFrom()（提交髒 burst ＋ 重繪）之下、【在】原本那個
  // 還原之上，所以 H1 上按 Shift+Tab 與 H6 上按 Tab 這兩個再普通不過的手勢，
  // 走的是「什麼都沒改，但你的著力點沒了」。handleBurstKeydown() 傳的是原始的
  // ±1（沒有 delta === 0 的過濾，與 applyHeadingLevel() 不同），所以夾住的那
  // 一步是真的可達的。
  //
  // 修之前實測（ddac6ce，三次）：H1 + Shift+Tab 與 H6 + Tab 都是
  //   {active:'H1'/'H6', cls:'… ed-wys-armed', enabled:15}
  //     → {active:'BODY', cls:'', enabled:4}
  // 而未被夾住的對照組 H2 + Tab 是乾淨的（→ H3 / 15 顆）。修之後三者都保住
  // ed-wys-armed / 15 顆。
  //
  // ⚠ 必須先打字。乾淨的 burst 走 endBurstWithoutResolve()，不提交也不重繪，
  // 著力點本來就不會掉 —— 少了這一步這個場景會空跑成綠的。
  {
    const HEAD_ROWS = [
      ['H1 + Shift+Tab', '# Title\n\nAlpha para.\n\nTail para two.\n',      true,  'H1'],
      ['H6 + Tab',       '###### Title\n\nAlpha para.\n\nTail para two.\n', false, 'H6'],
      ['H2 + Tab (未夾住的對照組)', '## Title\n\nAlpha para.\n\nTail para two.\n', false, 'H3'],
    ];
    // N2：primed 與 unprimed 都要跑。unprimed 走 fallback、primed 走 patch，而
    // C1 只在 patch 上發作 —— 第一波的這個場景只測了 unprimed，所以它自己也漏掉了。
    for (const primed of [false, true]) {
    for (const [name0, md, shift, wantTag] of HEAD_ROWS) {
      const name = name0 + ' primed=' + primed;
      const ctx = await newPage(md);
      if (primed) await primeOneCommit(ctx);
      await installPatchSpy(ctx);
      const sel = '.ed-block[data-block-id="0"] .ed-wys-armed';
      await ctx.page.click(sel);
      await new Promise((r) => setTimeout(r, 250));
      await ctx.page.keyboard.type('X');          // 髒 burst：switchAwayFrom() 會提交＋重繪
      await new Promise((r) => setTimeout(r, 250));
      const before = await readLeverage(ctx.page);
      // review I2: stays 15 — readLeverage()'s `enabled` deliberately
      // excludes `save` (see its own comment), so typing 'X' lighting it up
      // does not move this count.
      assert.strictEqual(before.enabled, 15,
        'V2g(' + name + ') 前提：打字後工具列應是 15 顆，got ' + JSON.stringify(before));
      if (shift) await ctx.page.keyboard.down('Shift');
      await ctx.page.keyboard.press('Tab');
      if (shift) await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 700));
      const st = await readLeverage(ctx.page);
      assertRoute(await patchRoutes(ctx), primed, 'V2g(' + name + ')');
      assert.strictEqual(st.active, wantTag,
        'V2g(' + name + ')：游標必須留在（或落到）' + wantTag + '，got ' + JSON.stringify(st));
      assert.ok(/\bed-wys-armed\b/.test(st.activeClass),
        'V2g(' + name + ')：而且必須是一個真的編輯面，got ' + JSON.stringify(st));
      assert.strictEqual(st.enabled, 15,
        'V2g(' + name + ')：工具列不得塌成 4 顆 —— primed 變體上這一條是 C1，' +
        '游標還在但整條工具列已經被 applyPatch() 的 resetToolbarBlock() 收掉了，got ' +
        JSON.stringify(st));
      // 夾住的那兩列必須是真的 no-op：磁碟上的 # 數量不能變。
      const disk = await saveAndRead(ctx);
      const hashes = (disk.split('\n')[0].match(/^#+/) || [''])[0].length;
      // 兩列夾住的 → 層級不動（H1 / H6）；對照組 → H2 真的變成 H3。
      // `wantTag` 已經是「按完之後該是什麼」，兩種情形共用同一個數字。
      assert.strictEqual(hashes, Number(wantTag.slice(1)),
        'V2g(' + name + ')：標題層級必須是 ' + wantTag + '，got #×' + hashes + ' —— \n' + disk);
      assert.strictEqual(ctx.errs.length, 0,
        'V2g(' + name + ')：不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    }
    console.log('journey: V2g a clamped Tab on a heading keeps the caret — OK');
  }

  // ── V2h: 被拒絕的 ⠿ 操作 —— 拒絕不得順手拿走你的著力點 ──────────────────
  //
  // v3.2.1 final wave, I2。三個 v3.2.1 wrapper 的 finally 【有】被跑到，但
  // `focusLine` 在拒絕路徑上是 null，於是 focusBlockAtLine() 被跳過、
  // reaimToolbarBlockAtLine(null) 第一行就 return —— 而 resolveGutterOperands()
  // 裡的 switchAwayFrom() 早就提交並重繪過了。使用者看到的是：按了一個【亮著的】
  // 選單項目，得到一條橫幅告訴他不行，同時失去游標與整條工具列。
  //
  // 修之前實測（ddac6ce，硬換行的 li 上按 轉換成 → 引用，該項目 disabled === false）：
  //   {active:'DIV', cls:'ed-li-text ed-wys-armed', enabled:16}
  //     → {active:'BODY', cls:'', enabled:4}，橫幅「此清單含不支援的格式，無法調整結構」
  // 修之後 activeElement 回到那個 .ed-li-text、工具列 16 顆，橫幅照舊。
  //
  // 三個 wrapper 各測一條：轉換成（convertBlockViaMenu）、建立副本
  // （duplicateBlockViaMenu）、刪除（deleteBlockViaGutter）。硬換行的 li 是
  // §4.1 對這三者共同的拒絕條件，所以同一個 fixture 能同時打到三條路。
  {
    const HARD_WRAPPED = '# H\n\n- alpha item that is\n  hard wrapped here\n- bravo item\n\nTail para two.\n';
    const ROWS = [
      ['轉換成 → 引用', '引用', true],
      ['建立副本',      '建立副本', false],
      ['刪除',          '刪除', false],
    ];
    // N2：primed 與 unprimed 都要跑 —— 見 primeOneCommit() 的註解。C1 的三個
    // 受害者就是這三條路徑，而它們在 unprimed（fallback）上全都是綠的。
    for (const primed of [false, true]) {
    for (const [name0, label, viaConvert] of ROWS) {
      const name = name0 + ' primed=' + primed;
      const ctx = await newPage(HARD_WRAPPED);
      if (primed) await primeOneCommit(ctx);
      await installPatchSpy(ctx);
      const id = await ctx.page.evaluate(() =>
        document.querySelector('.ed-block[data-block-type="li"]').getAttribute('data-block-id'));
      const sel = '.ed-block[data-block-id="' + id + '"]';
      const before0 = fs.readFileSync(ctx.mdPath, 'utf8');
      await ctx.page.click(sel + ' .ed-li-text');
      await new Promise((r) => setTimeout(r, 250));
      await ctx.page.keyboard.type('X');        // 髒 burst → switchAwayFrom() 提交＋重繪
      await new Promise((r) => setTimeout(r, 250));
      const before = await readLeverage(ctx.page);
      assert.ok(/\bed-wys-armed\b/.test(before.activeClass),
        'V2h(' + name + ') 前提：游標必須在 li 的編輯面上，got ' + JSON.stringify(before));
      await ctx.page.hover(sel);
      await pressClick(ctx.page, sel + ' .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn');
      if (viaConvert) {
        // Fix round 1 (C1) + round 2 (finding 2): same class
        // (`.ed-handle-menu-btn`), same still-dirty burst as the label press
        // below — the 轉換成 toggle is itself a menu item, not panel chrome,
        // so it is just as susceptible and gets the same real press, with its
        // OWN pass/fail signal. Without a dedicated assertion here, a real
        // detach at THIS press surfaces three steps downstream as the
        // leaf-item-enabled precondition failing with "got MISSING" —
        // reporting a real regression as a vacuous-green fixture problem
        // instead of naming what happened.
        //
        // No assertDetachCapable() round-trip precondition here (unlike the
        // leaf press below and stage 0): MEASURED — on the fixed build,
        // opening the 轉換成 submenu fires zero `/api/render` calls
        // (`window.__renderApplyMs` stays empty). It's a pure client-side UI
        // toggle with no content mutation, so there is nothing asynchronous
        // for a real press to race against on a healthy build; unlike the
        // leaf press, whose own eventual action always commits+renders even
        // when its mousedown is correctly protected. `itemClickFired()` alone
        // is the right (and sufficient) signal here: on a healthy build the
        // click is synchronous and always registers, so a `menu-gone` here
        // means THIS press's own mousedown escaped the delegated
        // preventDefault list (MEASURED: dropping only
        // `.ed-handle-menu-btn`/`.ed-insert-menu-btn` from that list — with
        // `.ed-handle` itself still in it, so opening the menu is unaffected
        // — already reproduces `menu-gone` here); less likely, the earlier
        // ⠿ open itself lost a race. Either way it is a real regression, not
        // a machine-speed false negative: if this machine were ever slow
        // enough to rob THIS press of detection power, the SAME row's leaf
        // press three lines below carries its own `assertDetachCapable()`
        // and would go loudly red there instead — that's the actual
        // protection behind not giving the toggle a round-trip precondition
        // of its own, not an assumption that this press can't lose a race.
        await armDetachProbe(ctx.page, '.ed-handle-menu-btn', '轉換成 ›');
        await pressClick(ctx.page, '[data-journey-target="1"]', 80);
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(await itemClickFired(ctx.page), 'ok',
          'V2h(' + name + ') 轉換成 toggle：選單在 mouseup 前就消失了');
      }
      // 前提：這一項必須是【亮著的】。灰掉的項目點不下去，這個場景就沒測到東西。
      const dis = await ctx.page.evaluate((L) => {
        const h = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === L);
        return h.length ? h[h.length - 1].disabled : 'MISSING';
      }, label);
      assert.strictEqual(dis, false,
        'V2h(' + name + ') 前提：這個選單項目必須是 enabled，否則整列是空跑的綠燈，got ' +
        JSON.stringify(dis));
      // Fix round 1, C1: this is the actual susceptible press — the item
      // itself (`.ed-handle-menu-btn`), not the ⠿ that opened the menu (that
      // was already in wireBlockSelection()'s delegated preventDefault list
      // before Task 1; only the item class was missing). This fixture already
      // carries a dirty burst (typed 'X' above), so tag the real target and
      // drive it through a genuine press-hold-release instead of an in-page
      // synthetic .click() — a synthetic click cannot reproduce a detach that
      // only happens between a real mousedown and mouseup. Round 2, finding 1:
      // the press's own round-trip precondition is checked below via
      // assertDetachCapable(), same as the toggle above and stage 0.
      await armDetachProbe(ctx.page, '.ed-handle-menu-btn', label);
      const leafPress = await pressClick(ctx.page, '[data-journey-target="1"]', 80);
      await new Promise((r) => setTimeout(r, 800));
      await assertDetachCapable(ctx.page, leafPress, 'V2h(' + name + ')');
      assert.strictEqual(await itemClickFired(ctx.page), 'ok',
        'V2h(' + name + ')：選單在 mouseup 前就消失了');
      const st = await ctx.page.evaluate(() => ({
        active: document.activeElement ? document.activeElement.tagName : null,
        activeClass: document.activeElement ? String(document.activeElement.className || '') : '',
        // Review I2: `save` excluded — see the identical comment on the
        // "conversion restores focus" scenario earlier in this file for
        // why. This fixture types 'X' before reaching this scenario (it is
        // what the C1 primed variant needs), which would otherwise light
        // `save` and hide a real collapse-to-no-block behind a count of 5.
        enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn'))
          .filter((x) => !x.disabled && x.getAttribute('data-ed-tb') !== 'save').length,
        banner: (document.querySelector('.ed-conflict') || {}).textContent || '',
      }));
      assertRoute(await patchRoutes(ctx), primed, 'V2h(' + name + ')');
      // 前提之二：這真的是一次【拒絕】，不是一次成功。橫幅必須是 §4.1 那一條。
      assert.ok(st.banner.indexOf('無法調整結構') !== -1,
        'V2h(' + name + ') 前提：必須真的被 §4.1 拒絕（橫幅），否則測到的是成功路徑，got ' +
        JSON.stringify(st));
      assert.ok(/\bed-wys-armed\b/.test(st.activeClass),
        'V2h(' + name + ')：被拒絕之後游標必須留在原來那個編輯面上，got ' + JSON.stringify(st));
      assert.ok(st.enabled > 4,
        'V2h(' + name + ')：被拒絕之後工具列不得塌成 4 顆 —— primed 變體上這一條是 C1，' +
        '游標還在（上一條是綠的）但整條工具列已經被 applyPatch() 的 ' +
        'resetToolbarBlock() 收掉了，got ' + JSON.stringify(st));
      // 拒絕 ＝ 檔案只該帶著剛剛那次打字，不該有任何結構改動。
      const disk = await saveAndRead(ctx);
      // 拒絕之後磁碟與原檔的唯一差別，必須是剛剛打進去的那些 X（primed 時再加上
      // 那次無關提交寫的 ' PRIMED'）—— 兩者都拿掉之後必須逐位元組相同。這比
      // 「行數沒變」強：它連硬換行的第二行、清單標記、項目數都一起釘住了。
      assert.strictEqual(disk.replace(/X/g, '').replace(/ PRIMED/g, ''), before0,
        'V2h(' + name + ')：拒絕不得改動結構，去掉剛打的 X / PRIMED 之後必須與原檔相同，got:\n' + disk);
      assert.strictEqual(ctx.errs.length, 0,
        'V2h(' + name + ')：不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    }
    console.log('journey: V2h a refused ⠿ operation keeps the caret and the bar — OK');
  }

  // ── NF-3: 拒絕之後，工具列必須描述【游標所在】的那個 block ──────────────
  //
  // restoreAfterStructuralOp() 的 heldSurface 分支挑的是游標自己的 block
  //（`heldSurface.closest('.ed-block')`），不是 resolveGutterOperands() 交出來
  // 的 `anchorLine`。它自己的註解說兩者在量過的路徑上是同一個 block —— 上面
  // V2h 那些列的形狀是「⠿ 按在游標【所在】的那個 li 上」，兩者因此指同一個
  // block —— 實測在那個形狀上把那兩行換成 reaimToolbarBlockAtLine(anchorLine)，
  // V2h 讀的那些量（activeElement 的 class、工具列 enabled、橫幅）逐項不變。
  //
  // 這一列把兩者分開：髒 burst 留在【段落 A】，⠿ 按在另一個 hard-wrapped 的
  // li B 上（§4.1 的拒絕條件長在 B 身上）。實測（primed、1000×700）：
  //   原碼    工具列的「清單」aria-pressed=false、「縮排」是 disabled
  //   mutant  「清單」aria-pressed=true、「縮排」是 enabled
  // 兩邊的游標都留在 A 的 .ed-wys-armed 上，橫幅也都是 §4.1 那一條 —— 使用者
  // 看得到的差別就是那條 bar 在講一個他人不在的 block。
  //
  // 這一列只跑 primed。unprimed 走 fallback：focus 掉到 BODY、heldSurface 是
  // null，restoreAfterStructuralOp() 因此走 focusBlockAtLine(anchorLine) 那一
  // 支，把游標真的搬進 B（實測 blk 是那個 li、DIV.ed-li-text ed-wys-armed）。
  // 那時候工具列瞄著 B 是對的，兩種寫法的答案一致，手勢就分不開它們。
  //
  // 為什麼不用「按下去看文件怎麼變」當謂詞：這個拒絕之後按工具列按鈕，原碼與
  // mutant 都是 activeElement 掉回 BODY、磁碟逐位元組不變（實測按「在下方插入
  // 區塊」與按「引用」各一次），所以那條路上沒有可鑑別的效果可以量。
  {
    const NF3_MD = '# H\n\nAlpha paragraph.\n\n- alpha item that is\n  hard wrapped here\n' +
      '- bravo item\n\nTail para two.\n';
    const ctx = await newPage(NF3_MD);
    await ctx.page.setViewport({ width: 1000, height: 700 });
    await primeOneCommit(ctx);
    await installPatchSpy(ctx);
    const aId = await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
        .find((x) => (x.textContent || '').indexOf('Alpha paragraph') !== -1);
      if (!b) throw new Error('NF-3 fixture 裡找不到 Alpha paragraph');
      return b.getAttribute('data-block-id');
    });
    const bId = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-type="li"]').getAttribute('data-block-id'));
    assert.notStrictEqual(aId, bId, 'NF-3 前提：段落 A 與 li B 必須是不同的 block');
    const A = '.ed-block[data-block-id="' + aId + '"]';
    const B = '.ed-block[data-block-id="' + bId + '"]';
    await ctx.page.click(A + ' .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.type('X');          // 髒 burst 留在 A
    await new Promise((r) => setTimeout(r, 250));
    const before = await readLeverage(ctx.page);
    assert.ok(/\bed-wys-armed\b/.test(before.activeClass),
      'NF-3 前提：髒 burst 必須真的開在 A 的編輯面上，got ' + JSON.stringify(before));
    // ⠿ 開在 B 上 —— 這是 anchorLine 與游標所在 block 分家的那一步。
    await ctx.page.hover(B);
    await pressClick(ctx.page, B + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await armDetachProbe(ctx.page, '.ed-handle-menu-btn', '轉換成 ›');
    await pressClick(ctx.page, '[data-journey-target="1"]', 80);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await itemClickFired(ctx.page), 'ok',
      'NF-3 轉換成 toggle：選單在 mouseup 前就消失了');
    // 250ms 而不是 V2h 那些列的 80ms：assertDetachCapable() 要求按壓長過這台
    // 機器把一次 commit 的 /api/render 套用到 DOM 的時間，而那個數字在冷開的
    // 行程上量到過 141ms（隔離副本、單跑這一列）。
    await armDetachProbe(ctx.page, '.ed-handle-menu-btn', '引用');
    const leafPress = await pressClick(ctx.page, '[data-journey-target="1"]', 250);
    await new Promise((r) => setTimeout(r, 800));
    await assertDetachCapable(ctx.page, leafPress, 'NF-3');
    assert.strictEqual(await itemClickFired(ctx.page), 'ok',
      'NF-3：選單在 mouseup 前就消失了');
    assertRoute(await patchRoutes(ctx), true, 'NF-3');
    const st = await ctx.page.evaluate((sel) => {
      const btn = (id) => document.querySelector('[data-ed-tb="' + id + '"]');
      const ae = document.activeElement;
      const blk = ae && ae.closest ? ae.closest('.ed-block') : null;
      return {
        cls: ae ? String(ae.className || '') : '',
        caretBlock: blk ? blk.getAttribute('data-block-id') : null,
        wantBlock: document.querySelector(sel).getAttribute('data-block-id'),
        listPressed: btn('list').getAttribute('aria-pressed'),
        indentOff: btn('indent').disabled,
        quoteOff: btn('quote').disabled,
        listOff: btn('list').disabled,
        banner: (document.querySelector('.ed-conflict') || {}).textContent || '',
      };
    }, A);
    // 前提之一：這真的是一次 §4.1 的拒絕，不是一次成功。
    assert.ok(st.banner.indexOf('無法調整結構') !== -1,
      'NF-3 前提：必須真的被 §4.1 拒絕（橫幅），否則量到的是成功路徑，got ' +
      JSON.stringify(st));
    // 前提之二：游標留在 A。它要是被搬走了，「工具列該講 A」這個問題就換了
    // 題目 —— 那正是 unprimed 那條路的形狀。
    assert.strictEqual(st.caretBlock, st.wantBlock,
      'NF-3 前提：拒絕之後游標必須還在 A 這個 block 裡，got ' + JSON.stringify(st));
    assert.ok(/\bed-wys-armed\b/.test(st.cls),
      'NF-3 前提：游標必須還在真的編輯面上，got ' + JSON.stringify(st));
    // 前提之三：bar 沒有整條塌掉。塌掉的 bar 什麼都不 pressed，下面那條
    // 「清單不得亮著」就會白過。
    assert.strictEqual(st.quoteOff, false,
      'NF-3 前提：工具列必須還瞄著某個 block（引用鈕是 enabled），got ' + JSON.stringify(st));
    assert.strictEqual(st.listOff, false,
      'NF-3 前提：工具列必須還瞄著某個 block（清單鈕是 enabled），got ' + JSON.stringify(st));
    // 正題：bar 講的是游標所在的段落，不是 ⠿ 按下去的那個 li。
    assert.strictEqual(st.listPressed, 'false',
      'NF-3：游標在段落裡，工具列的「清單」不得亮著 —— 亮著代表 bar 瞄的是 ⠿ ' +
      '按下去的那個 li（anchorLine），不是游標所在的 block，got ' + JSON.stringify(st));
    assert.strictEqual(st.indentOff, true,
      'NF-3：游標在段落裡，「縮排」必須是 disabled —— 它是 enabled 代表 bar 瞄的是 ' +
      '那個 li，got ' + JSON.stringify(st));
    assert.strictEqual(ctx.errs.length, 0,
      'NF-3：不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: NF-3 a refusal aims the bar at the block the caret is in — OK');
  }

  // ── V2i: 🔗 套用在【段落】上 —— C1 的第二個發生點 ────────────────────────
  //
  // 第二波 C1。applyLinkToggle() 的 `stillHeld` 閘門原本把
  // reaimToolbarBlockAtLine(line) 一起包在裡面，所以「著力點還在」時什麼都不
  // 還原 —— 而在 patch 路徑上 applyPatch() 先把焦點交還給新的面、之後才跑
  // resetToolbarBlock()，「焦點還在」與「工具列塌成 4 顆」因此是【同時成立】的
  // 常態，不是矛盾。
  //
  // ⚠ V2d（同一顆按鈕、表格儲存格）測不到這一個：那裡 blockContentEl() 對
  //   table 回傳不可聚焦的 <table>，所以還原之後 activeElement 是 BODY，
  //   `stillHeld` 為 false，舊碼本來就會走到 reaim 那一支。實測 477fa1b 上
  //   V2d 的 primed 變體是【綠的】。段落才是那個會保住焦點的形狀。
  //
  // 實測 477fa1b：unprimed P.ed-wys-armed / 15 顆（綠），primed
  // P.ed-wys-armed / 4 顆（紅）。修好之後兩者都是 15 顆。
  for (const primed of [false, true]) {
    const ctx = await newPage('# H\n\nAlpha bravo charlie.\n\nTail para two.\n');
    if (primed) await primeOneCommit(ctx);
    await installPatchSpy(ctx);
    ctx.page.on('dialog', async (d) => { try { await d.accept('https://example.com/'); } catch (e) { /* already gone */ } });
    const pid = await ctx.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
        .find((b) => (b.textContent || '').indexOf('Alpha bravo') !== -1);
      return el.getAttribute('data-block-id');
    });
    const one = '.ed-block[data-block-id="' + pid + '"] .ed-wys-armed';
    await ctx.page.click(one);
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.evaluate((sl) => {
      const el = document.querySelector(sl);
      const t = el.firstChild;
      const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus(); document.dispatchEvent(new Event('selectionchange'));
    }, one);
    await new Promise((r) => setTimeout(r, 300));
    const dis = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="link"]').disabled);
    assert.strictEqual(dis, false,
      'V2i(primed=' + primed + ') 前提：有非空選取時 🔗 必須是 enabled，否則這一列什麼都沒點到');
    await pressClick(ctx.page, '[data-ed-tb="link"]', 80);
    await new Promise((r) => setTimeout(r, 1100));
    assertRoute(await patchRoutes(ctx), primed, 'V2i(primed=' + primed + ')');
    const fail = await checkLeverage(ctx, '🔗 on a paragraph (primed=' + primed + ')', 'caret');
    assert.strictEqual(fail, null, 'V2i(primed=' + primed + '): ' + fail);
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('[Alpha](https://example.com/)') !== -1,
      'V2i(primed=' + primed + '): 連結必須真的寫進磁碟，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0,
      'V2i: 不得有 pageerror / unhandledrejection: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: V2i 🔗 on a paragraph keeps caret AND bar on both render routes — OK');

  // ══ V3: 十六個 position:fixed 浮層，捲動後的必需答案 ══════════════════
  // lib/md2doc.js 有十六個 `position: fixed` 宣告（另有若干處是註解裡的散文
  // 提及）。client.js 只有【一個】捲動監聽器（onAnyScroll），所以「捲動之後
  // 每個浮層各自變成什麼」是一個族群，而不是十四個互不相干的問題。
  //
  // 必需答案三種：
  //   live               捲動後仍在、仍可見。這些浮層的幾何是【捲動不變】的
  //                      （top/left/right/inset 定死在視窗邊緣），捲動根本
  //                      不可能把它們留在過期座標上；而且每一個都是使用者
  //                      當下必須還能操作的東西。
  //   gone               捲動後必須消失。這些浮層的座標是從
  //                      getBoundingClientRect() 算出來的視窗座標，捲動之後
  //                      就指向錯的東西 —— 其中 .ed-te-menu 會真的刪掉整欄
  //                      整列資料。
  //   reposition-or-gone .ed-seltb 沒有能把它重新升起來的驅動（捲動不觸發
  //                      selectionchange），純隱藏會讓它永遠回不來；所以選取
  //                      還在視窗內時要跟著移動，整個捲出視窗才消失。
  //   gone-on-drag-end   兩個 drop indicator。兩者在拖曳中的捲動都原地不動
  //                      （實測），但【理由不同，不要混為一談】：
  //                      ．表格列拖曳 —— onAnyScroll() 開頭就是
  //                        `if (tePointer && tePointer.dragging) return;`，
  //                        整個函式體被跳過，是刻意放行。
  //                      ．區塊拖曳 —— 區塊拖曳用的是 `blockDragState`
  //                        （client.js:9108/9136），不是 `tePointer`
  //                        （只在 client.js:9920 由表格 grip 設定），所以那道
  //                        early-return 對它不成立：onAnyScroll() 會整個跑完，
  //                        只是它做的四件事（hideTableGrips /
  //                        hideTableInsertBubbles / hideTableEdgeMenu /
  //                        closeToolbarMenu）與那個 rAF 都【沒有碰到】
  //                        blockDropIndicator。這是比「刻意放行」更弱的前提。
  //                      三個前提都寫成斷言：(1) 捲動後 top 不變（原本這件事
  //                      只活在註解裡）；(2) pointer-events 是 none，所以過期
  //                      的線畫錯位置也點不到、不會動到資料；(3) 拖曳結束後
  //                      必須收乾淨，而且此後的捲動不得讓它復活。
  //
  // 覆蓋率守衛：直接從 lib/md2doc.js 掃出所有 `position: fixed` 宣告並比對
  // 下表的 selector 集合。有人加第十五個浮層時這裡會紅，逼他決定它的必需
  // 答案，而不是安靜地多一個沒人測過的浮層。
  const OVERLAY_RULES = [
    { sel: '.ed-toolbar',              after: 'live' },
    { sel: '.ed-toolbar-status',       after: 'live' },
    { sel: '.sidebar-toggle',          after: 'live-in-reader-gone-in-edit' },
    { sel: '.lightbox',                after: 'live' },
    { sel: '.sidebar-scrim',           after: 'live' },
    { sel: '.reader-sidebar',          after: 'live' },
    { sel: '.ed-conflict',             after: 'live' },
    { sel: '.ed-te-grip',              after: 'gone' },
    { sel: '.ed-te-menu',              after: 'gone' },
    { sel: '.ed-tb-insert',            after: 'gone' },
    { sel: '.ed-toolbar-menu',         after: 'gone' },
    { sel: '.ed-te-drop-indicator',    after: 'gone-on-drag-end' },
    { sel: '.ed-block-drop-indicator', after: 'gone-on-drag-end' },
    { sel: '.ed-seltb',                after: 'reposition-or-gone' },
    // v3.4.0 batch3 Task 6。兩者都由 `journey: wave/T6j` 這一列驅動（在本檔
    // 尾端的 wave 區塊裡，因為它需要那邊的 fixture 與開啟手勢）。
    //
    // .ed-wave-edit-btn = gone：它的座標是從被 hover 的那張圖的
    //   getBoundingClientRect() 算出來的【視窗座標】，捲動之後就指向錯的東西
    //   ——跟 .ed-te-grip 同一個家族。client.js 的 scroll listener 直接把它收掉。
    //
    // .ed-wave-overlay = live：`inset: 0` 的 modal，幾何與捲動無關，而且使用者
    //   當下必須還能操作它。
    //
    // ⚠ 疊放關係（本 session 實測，不是推論）：`.ed-wave-overlay` 是
    //   z-index 998，`.ed-conflict` 是 999，所以**磁碟衝突橫幅蓋在波形編輯器
    //   上面**——overlay 開著時把橫幅升起來，elementFromPoint 打在橫幅矩形
    //   中心拿到的是橫幅自己的 <button>（`inBanner: true`），滑鼠點得到。
    //   鍵盤也點得到：overlay 的 focus trap 的範圍**刻意不是 overlay 自己**，
    //   而是「modal 這一層」＝ overlay ＋ 現場的每一條 .ed-conflict。
    //   ⚠ 這裡**刻意不釘按鍵次數**。前一版寫「Tab 第 32 下」，那個數字是
    //   focusable 名單的函數（本檔 fixture 目前 49 個），fixture 一改就漂，
    //   而且沒有任何斷言在看它——量到的是 47（T6k 的合成 banner，接在它整圈
    //   走完之後）與 50（T6l 的真 banner，從記載的起點算）。要斷言的是
    //   「到得了」，那由 `wave/T6k` 與 `wave/T6l` 各自斷言，不是由一個註解裡
    //   的數字。
    //   這一條不是可有可無的：橫幅是使用者解決磁碟衝突的唯一出口，而這個分支
    //   在 batch 2 已經為「一個 fixed 浮層蓋掉它」付過一次代價。
    { sel: '.ed-wave-edit-btn',        after: 'gone' },
    { sel: '.ed-wave-overlay',         after: 'live' },
  ];
  {
    // 宣告 vs 散文：先把註解整個抹掉，再找 `position: fixed`。
    //
    // 【不要】改回「行首必須是 position: 且必須以分號結尾」那種寫法。那個寫法
    // 只認得一種書寫風格，實測有三種乾淨插入的規則會讓它靜默漏掉（三種都試過，
    // 舊寫法一律仍回報 14）：
    //   (1) 宣告不在行首   `.x { z-index: 5; position: fixed; }`
    //   (2) 帶 !important  `.x { position: fixed !important; }`  ← `\s*;` 不匹配
    //   (3) 收尾沒有分號   `.x { top: 0; position: fixed }`
    // 也就是說它只在「一顆浮層剛好照著現有 14 個的排版寫」時才紅，而註解卻
    // 宣稱第十五個浮層一定會紅 —— 正是這個分支反覆出過的假註解。
    //
    // 抹註解的方式：`/* … */` 整段（CSS 註解與 JS 區塊註解都在內，含
    // `.sidebar-scrim (position:fixed; inset:0; …)` 這種【帶分號】的散文提及），
    // 加上【整行】以 // 起頭的 JS 行註解。刻意不抹行中的 // ，否則 `https://`
    // 之類的字串會被截斷、把後面的大括號一起吃掉。
    const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'md2doc.js'), 'utf8');
    const stripped = cssSrc
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
    const found = [];
    const declRe = /position\s*:\s*fixed\b/g;
    let m;
    while ((m = declRe.exec(stripped))) {
      // selector = 這條宣告所屬規則的 `{` 前面那一段，邊界取最近的
      // } / { / ; / 反引號（template literal 起頭）。
      const open = stripped.lastIndexOf('{', m.index);
      if (open === -1) { found.push(null); continue; }
      let from = 0;
      for (const ch of ['}', '{', ';', '`']) {
        const i = stripped.lastIndexOf(ch, open - 1);
        if (i > from) from = i;
      }
      found.push(stripped.slice(from + 1, open).replace(/\s+/g, ' ').trim());
    }
    assert.deepStrictEqual(found.slice().sort(), OVERLAY_RULES.map((r) => r.sel).slice().sort(),
      'V3 表必須恰好覆蓋 lib/md2doc.js 裡每一個 position:fixed 浮層，got ' + JSON.stringify(found));
  }

  const V3_FILL = Array.from({ length: 40 }, (_, i) => 'Filler line ' + i + '.').join('\n\n');
  const V3_TABLE_MD = V3_FILL + '\n\n' +
    ['| Alpha | Bravo |', '|---|---|', '| one | two |', '| three | four |', ''].join('\n') +
    '\n\n' + V3_FILL + '\n';
  // 一個浮層的可見狀態。`dom:false` = 已從 DOM 移除；`hidden`/`display:none`
  // = 還在 DOM 裡但不畫出來。兩者都算 gone。
  const OVERLAY_STATE = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { dom: false };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      dom: true, hidden: !!el.hidden, display: cs.display, pointerEvents: cs.pointerEvents,
      top: Math.round(r.top), left: Math.round(r.left),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const overlayState = (page, sel) => page.evaluate(OVERLAY_STATE, sel);
  const isGone = (s) => !s.dom || s.hidden || s.display === 'none' || (s.w === 0 && s.h === 0);
  const isLive = (s) => s.dom && !s.hidden && s.display !== 'none' && s.w > 0 && s.h > 0;
  // 每一列共用的「升起來了嗎」前提檢查。少了它，一個根本沒升起來的浮層在
  // 「捲動後必須消失」的斷言下永遠是綠的 —— 那正是空跑的綠燈。
  const assertRaised = (s, sel) => assert.ok(isLive(s),
    'V3 前提失敗：' + sel + ' 根本沒有升起來，捲動後的斷言就沒測到東西，got ' + JSON.stringify(s));

  async function centreTable(page) {
    const ts = await page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-type="table"]');
      el.scrollIntoView({ block: 'center' });
      return '.ed-block[data-block-id="' + el.getAttribute('data-block-id') + '"]';
    });
    await new Promise((r) => setTimeout(r, 150));
    return ts;
  }
  // 捲動必須真的移動了東西，否則後面每一條斷言都是在測「沒捲動」那條路徑。
  async function scrollBy(page, dy) {
    const before = await page.evaluate(() => window.scrollY);
    await page.evaluate((d) => window.scrollBy(0, d), dy);
    await new Promise((r) => setTimeout(r, 420));
    const after = await page.evaluate(() => window.scrollY);
    assert.notStrictEqual(after, before,
      'V3 前提失敗：捲動沒有真的移動任何東西（scrollY 前後都是 ' + before + '）');
    return after;
  }

  // ── live × 3：.ed-toolbar / .ed-toolbar-status（寬視窗）─────────────
  {
    const ctx = await newPage('# H\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    for (const sel of ['.ed-toolbar', '.ed-toolbar-status']) {
      const before = await overlayState(ctx.page, sel);
      assertRaised(before, sel);
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await scrollBy(ctx.page, 2000);
      const after = await overlayState(ctx.page, sel);
      assert.ok(isLive(after), sel + ' 捲動後必須仍然可見，got ' + JSON.stringify(after));
      assert.strictEqual(after.top, before.top,
        sel + ' 捲動後必須留在同一個視窗座標，got top=' + after.top + ' was ' + before.top);
    }
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-toolbar / .ed-toolbar-status stay live across a scroll — OK');
  }

  // ── T11-2: .sidebar-toggle survives in reader, is gone in edit ──────
  // Before T11-2 this row asserted the mobile drawer toggle stayed `live` at
  // <=1080px in EDIT mode too, because editModeLayoutCss carried no override
  // of its own yet. Measured on THIS build at both 1080x900 and 800x900:
  // document.elementFromPoint() at the toggle's own rect centre returns
  // .ed-toolbar (z-index 101 over the toggle's 100), never the toggle — a
  // real pointer click could never land on it there, so the fix hides it in
  // edit mode outright rather than only nudging its z-index. See the
  // matching comment beside `.sidebar-toggle { display: none; }` in
  // editModeLayoutCss (lib/md2doc.js) for the full measurement.
  {
    const ctx = await newPage('# H\n\n## Sub\n\n' + V3_FILL + '\n');
    for (const w of [800, 1400]) {
      await ctx.page.setViewport({ width: w, height: 800 });
      await new Promise((r) => setTimeout(r, 250));
      const s = await overlayState(ctx.page, '.sidebar-toggle');
      assert.ok(isGone(s),
        '.sidebar-toggle 在 edit 模式下必須永遠是 gone（不再是視窗寬度的函式），width=' + w +
        ' got ' + JSON.stringify(s));
    }
    await ctx.page.close(); ctx.srv.close();
  }
  // The other half of the same census answer, checked directly against
  // renderMarkdown()'s own HTML rather than inferred from the edit-mode
  // result above: reader-mode output (no editMode) must NOT carry the
  // edit-only override, so the pre-existing mobile drawer toggle there is
  // unaffected, while edit-mode output must carry it (otherwise the `gone`
  // assertions above would be exercising a rule the shipped edit HTML does
  // not actually contain).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-journey-census-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# H\n\n## Sub\n\nAlpha.\n', 'utf8');
    const mdText = fs.readFileSync(mdPath, 'utf8');
    const readerOut = await renderMarkdown(mdText, mdPath, {});
    const editOut = await renderMarkdown(mdText, mdPath, { editMode: true });
    const overrideRe = /\.sidebar-toggle\s*\{\s*display:\s*none;\s*\}/;
    assert.ok(!overrideRe.test(readerOut.html),
      'reader-mode 輸出不得含 T11-2 的 edit-only override —— .sidebar-toggle 必須留給既有的 ' +
      '@media (max-width: 1080px) 規則決定，census 的「reader 存活」才站得住');
    assert.ok(overrideRe.test(editOut.html),
      'edit 模式輸出必須含 T11-2 的 override，否則上面 gone 斷言測到的東西和真正出貨的 HTML 不是同一份');
  }
  console.log('journey: T11-2 .sidebar-toggle survives in reader, is gone in edit — OK');

  // ── T21 item 4: the page reserves the toolbar's band and nothing else ──
  // The row T11-2 never grew. editModeLayoutCss hid .sidebar-toggle but its
  // '@media (max-width: 1080px)' rule went on reserving the 60px that button
  // used to occupy, on top of the toolbar's own --ed-toolbar-h. Nothing
  // measured .page-layout, so three green batches went past it. Measured on
  // that build: padding-top 104px against a
  // 44px toolbar at 1080/1000/800, i.e. a 60px band with nothing painted in
  // it, and a 105px toolbar-bottom-to-first-block gap there against 45px at
  // 1200 wide.
  //
  // The reservation is checked against the toolbar's OWN measured height
  // rather than a literal 44: the point is that the page clears the fixed
  // chrome it actually has, which is what stays true if --ed-toolbar-h is
  // ever retuned. The display check on .sidebar-toggle is the licence for
  // the small number — a build that shows that button again at these widths
  // needs its 60px back, and must fail here rather than silently overlap.
  {
    const ctx = await newPage('# H\n\n## Sub\n\nAlpha.\n');
    const widths = [1400, 1081, 1080, 800];
    const bands = {};
    for (const w of widths) {
      await ctx.page.setViewport({ width: w, height: 800 });
      await new Promise((r) => setTimeout(r, 250));
      bands[w] = await ctx.page.evaluate(() => {
        const pl = document.querySelector('.page-layout');
        const tb = document.querySelector('.ed-toolbar');
        const tg = document.querySelector('.sidebar-toggle');
        return {
          paddingTop: Math.round(parseFloat(getComputedStyle(pl).paddingTop) || 0),
          toolbarH: tb ? Math.round(tb.getBoundingClientRect().height) : null,
          toggleDisplay: tg ? getComputedStyle(tg).display : '(absent)',
        };
      });
    }
    for (const w of widths) {
      assert.strictEqual(bands[w].toggleDisplay, 'none',
        w + '×800：.sidebar-toggle 必須是 display:none —— .page-layout 只保留工具列高度的' +
        '前提就是它不在版面上，got ' + JSON.stringify(bands[w]));
      assert.strictEqual(bands[w].paddingTop, bands[w].toolbarH,
        w + '×800：.page-layout 的 padding-top 必須剛好等於 .ed-toolbar 的高度 —— ' +
        '多出來的每一 px 都是沒有東西畫進去的死空間，got ' + JSON.stringify(bands[w]));
    }
    assert.strictEqual(bands[800].paddingTop, bands[1400].paddingTop,
      '1080px 斷點不得改變 edit 模式的頂部保留量（該斷點在 reader 模式是替 ' +
      '.sidebar-toggle 讓位，而 edit 模式沒有那顆按鈕），got ' + JSON.stringify(bands));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: T21 .page-layout reserves the toolbar band and nothing else — OK');

  // ── T11-2: edit mode 下側欄必須有辦法打開 ────────────────────────────
  for (const w of [1080, 800]) {
    const ctx = await newPage('# Doc\n\n## Sub\n\nAlpha.\n');
    await ctx.page.setViewport({ width: w, height: 900 });
    await new Promise((r) => setTimeout(r, 200));
    const hit = await ctx.page.evaluate(() => {
      const t = document.querySelector('.sidebar-toggle');
      if (!t || getComputedStyle(t).display === 'none') return 'hidden';
      const r = t.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el && (el === t || t.contains(el)) ? 'clickable' : 'occluded';
    });
    assert.notStrictEqual(hit, 'occluded',
      w + '×900：.sidebar-toggle 不得是「看得到但點不到」的狀態');
    // Ruling T11-2: the assertion above passes just as well when
    // .sidebar-toggle is plain absent (hit === 'hidden', what the fix above
    // produces) as it would if the button were clickable — it says nothing
    // about whether edit mode still has a working way to open the drawer.
    // That is what this checks: the toolbar's own outline button (id
    // 'outline', ☰, `[data-ed-tb="outline"]`) must exist, be enabled, and
    // actually be the element its own centre point hit-tests to — the same
    // test .sidebar-toggle was just put through, aimed at its replacement.
    const outlineHit = await ctx.page.evaluate(() => {
      const b = document.querySelector('[data-ed-tb="outline"]');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { present: true, disabled: b.disabled, hit: el === b || b.contains(el) };
    });
    assert.ok(outlineHit.present,
      w + '×900：工具列的 outline (☰) 按鈕必須存在 —— 拿掉 .sidebar-toggle 之後它是側欄僅剩的入口');
    assert.strictEqual(outlineHit.disabled, false,
      w + '×900：outline (☰) 不得 disabled，否則側欄在 edit 模式下沒有任何入口，got ' +
      JSON.stringify(outlineHit));
    assert.ok(outlineHit.hit,
      w + '×900：outline (☰) 必須是自己中心點的 hit-test 結果，否則跟 .sidebar-toggle 犯一樣的錯，got ' +
      JSON.stringify(outlineHit));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the sidebar toggle is never visible-but-unclickable in edit mode, ' +
    'and the toolbar outline button is its working replacement at both widths — OK');

  // ── T11-2 step 5: source mode 隱藏抽屜的 TOC 與 search-results，只留 reader-tools ──
  // 量測基礎（brief）：enterSourceMode() 讓 contentEl.hidden = true；在那個
  // 狀態下點 TOC 最後一個連結 scrollBefore/scrollAfter 都是 0、textarea 的
  // scrollTop 前後不變（3924 → 3924），search 同理（找的是一個
  // display:none 的 .content）。這裡驗證 lib/md2doc.js 那條
  // `body[data-ed-mode="source"] .toc, body[data-ed-mode="source"]
  // .search-results { display: none !important; }` 規則真的擋住了兩者，
  // 而 .reader-tools（搜尋輸入列）維持原樣 —— 先真的跑一次搜尋讓
  // #search-results 的 `hidden` 屬性變成 false，免得這一列在規則被拿掉時
  // 也是空跑的綠燈（`hidden` 屬性本身就會讓 computed display 是 none）。
  {
    const ctx = await newPage('# Doc\n\n## Sub\n\nAlpha.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      document.getElementById('doc-search-input').value = 'Sub';
      document.getElementById('doc-search-submit').click();
    });
    await new Promise((r) => setTimeout(r, 250));
    const readState = () => ctx.page.evaluate(() => {
      const g = (sel) => {
        const el = document.querySelector(sel);
        return el ? { display: getComputedStyle(el).display, hidden: !!el.hidden } : null;
      };
      return { toc: g('.toc'), search: g('.search-results'), tools: g('.reader-tools') };
    });
    const before = await readState();
    assert.strictEqual(before.search.hidden, false,
      'T11-2 step5 前提失敗：送出搜尋後 #search-results 的 hidden 屬性應為 false，got ' +
      JSON.stringify(before));
    assert.notStrictEqual(before.toc.display, 'none', 'T11-2 step5 前提失敗：edit 模式下 .toc 一開始就是 none');
    assert.notStrictEqual(before.tools.display, 'none', 'T11-2 step5 前提失敗：edit 模式下 .reader-tools 一開始就是 none');
    await ctx.page.evaluate(() => document.querySelector('[data-ed-tb="preview"]').click());
    await new Promise((r) => setTimeout(r, 300));
    const mode = await ctx.page.evaluate(() => document.body.getAttribute('data-ed-mode'));
    assert.strictEqual(mode, 'source', 'T11-2 step5 前提失敗：按下 preview 沒有真的切到 source 模式');
    const inSource = await readState();
    assert.strictEqual(inSource.toc.display, 'none',
      'source 模式下 .toc 必須是 display:none，got ' + JSON.stringify(inSource));
    assert.strictEqual(inSource.search.display, 'none',
      'source 模式下 .search-results 必須是 display:none（即使 hidden 屬性仍是 false），got ' +
      JSON.stringify(inSource));
    assert.notStrictEqual(inSource.tools.display, 'none',
      'source 模式下 .reader-tools 必須留著（裁定：只留 reader-tools），got ' + JSON.stringify(inSource));
    // 切回 edit：兩區必須恢復。
    await ctx.page.evaluate(() => document.querySelector('[data-ed-tb="preview"]').click());
    await new Promise((r) => setTimeout(r, 300));
    const after = await readState();
    assert.notStrictEqual(after.toc.display, 'none', '切回 edit 模式後 .toc 必須恢復，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: T11-2 step5 source mode hides the drawer TOC and search-results, keeps reader-tools — OK');
  }

  // ── live × 2：.sidebar-scrim / .reader-sidebar（抽屜打開時仍可見）──────
  // window.scrollBy() cannot stand in for a real gesture under
  // overflow:hidden — see the lightbox lock row below, which measured this
  // first: it moves the page BY DEFINITION regardless of the CSS lock, so it
  // is the right tool for "does the overlay survive a scroll" and the wrong
  // one for "is scrolling actually blocked". This row keeps window.scrollBy()
  // for exactly the former question; the lock itself is a separate row below.
  //   .sidebar-scrim   `inset: 0` —— 四個邊都定死。
  //   .reader-sidebar  只定死 top / left / bottom 三個邊（lib/md2doc.js
  //                    :2104），寬度是 `width: 85%; max-width: 360px`。
  //                    垂直軸兩端都釘住，所以垂直捲動一樣動不到它。
  // 它們必須留著 —— scrim 是關掉抽屜的唯一點擊目標。
  {
    const ctx = await newPage('# H\n\n## Sub\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 800, height: 800 });
    await new Promise((r) => setTimeout(r, 250));
    // .sidebar-toggle 在 edit 模式下被 .ed-toolbar（z-index 101 > 100）蓋住，
    // 滑鼠點不到它 —— 實測 elementFromPoint 回的是 .ed-toolbar-btn。這裡要測
    // 的是抽屜打開之後的捲動行為，不是那個遮擋，所以用 DOM click 繞過。
    await ctx.page.evaluate(() => document.querySelector('.sidebar-toggle').click());
    await new Promise((r) => setTimeout(r, 450));
    const open = await ctx.page.evaluate(() => document.body.getAttribute('data-sidebar-open'));
    assert.notStrictEqual(open, null, 'V3 前提失敗：抽屜沒有打開，scrim/sidebar 就沒升起來');
    for (const sel of ['.sidebar-scrim', '.reader-sidebar']) {
      const before = await overlayState(ctx.page, sel);
      assertRaised(before, sel);
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await scrollBy(ctx.page, 1500);
      const after = await overlayState(ctx.page, sel);
      assert.ok(isLive(after), sel + ' 捲動後必須仍然可見，got ' + JSON.stringify(after));
      assert.strictEqual(after.top + '/' + after.left, before.top + '/' + before.left,
        sel + ' 捲動後必須留在同一個視窗座標，got ' + JSON.stringify(after));
    }
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .sidebar-scrim / .reader-sidebar stay live across a scroll — OK');
  }

  // ── lock：窄視窗抽屜打開時真實手勢不得捲動底下的文件 ────────────────
  // Task 11 (backlog #12): body[data-sidebar-open] / html[data-sidebar-open]
  // both go `overflow: hidden`, mirroring the lightbox's own two-rule shape
  // a few hundred lines below (body[data-lightbox-open] /
  // html[data-lightbox-open], next to the 'overflow-x: clip' comment) and for
  // the identical reason: documentElement, not body, is the element a real
  // gesture scrolls, so a body-only rule would not have closed the gap. JS
  // mirrors data-sidebar-open onto documentElement in setSidebarOpen(),
  // matching openLightbox/closeLightbox.
  //
  // This is a MISSING lock, not a defeated one: there was never any rule
  // here before this task, and the row above never covered it — it only
  // ever asked whether the overlays kept their viewport position, using
  // window.scrollBy(), which (per the comment on that row) moves the page
  // regardless of any lock. PageDown / End go through page.keyboard.press(),
  // which drives the real input pipeline the lock is meant to stop.
  {
    const ctx = await newPage('# H\n\n## Sub\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 800, height: 800 });
    await new Promise((r) => setTimeout(r, 250));

    // Precondition: the same PageDown must move the page BEFORE the drawer
    // opens. Without this, a fixture that stopped being taller than the
    // viewport would leave scrollY at 0 before and after, and the
    // locked-state assertions below would pass for the wrong reason.
    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    await ctx.page.keyboard.press('PageDown');
    await new Promise((r) => setTimeout(r, 250));
    const preOpenY = await ctx.page.evaluate(() => window.scrollY);
    assert.ok(preOpenY > 0,
      '前提失敗：抽屜關著時 PageDown 沒有真的捲動文件（scrollY=' + preOpenY +
      '），下面「鎖住」的斷言測不到東西');

    // Review round 2, M3: open the drawer while scrollY is still NON-zero
    // (deliberately do NOT reset to 0 first) and assert it does not move.
    // `overflow: hidden` is a hold-in-place lock — it does not itself alter
    // scroll position — but a `position: fixed`-based lock (a plausible
    // future rewrite) WOULD snap the page back to the top when engaged, and
    // every assertion below resets to 0 before checking, so none of them
    // would ever notice that regression without this one.
    // Final-review C1: `.sidebar-toggle` is `display: none` in edit mode
    // (T11-2 ruling, MEASURED above at line ~3038-3040 — NOT merely occluded
    // by `.ed-toolbar`'s higher z-index, an earlier draft of this comment's
    // claim, now retracted). The toolbar's ☰ outline button
    // (`.ed-toolbar [data-ed-tb="outline"]`) is the only entry point a real
    // edit-mode user has to this drawer, so drive the real one instead of a
    // DOM click on a button the user can never reach.
    await ctx.page.evaluate(() =>
      document.querySelector('.ed-toolbar [data-ed-tb="outline"]').click());
    await new Promise((r) => setTimeout(r, 450));
    const open = await ctx.page.evaluate(() => document.body.getAttribute('data-sidebar-open'));
    assert.notStrictEqual(open, null, '前提失敗：抽屜沒有打開');
    const yAtOpen = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(yAtOpen, preOpenY,
      '打開抽屜本身不得移動捲動位置（不是 position:fixed 那種會把頁面拉回頂端的鎖法），' +
      'got before=' + preOpenY + ' after=' + yAtOpen);

    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    await ctx.page.keyboard.press('PageDown');
    await new Promise((r) => setTimeout(r, 250));
    const afterPageDown = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(afterPageDown, 0,
      '抽屜開著時 PageDown 不得捲動底下的文件，got ' + afterPageDown);

    // End jumps straight to the bottom instead of advancing by a viewport at
    // a time — a different code path from PageDown, checked separately.
    await ctx.page.keyboard.press('End');
    await new Promise((r) => setTimeout(r, 250));
    const afterEnd = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(afterEnd, 0,
      '抽屜開著時 End 不得捲動底下的文件，got ' + afterEnd);

    // Closing the drawer must release the lock — otherwise the fix would
    // have traded one stuck state (unlocked-forever) for another
    // (locked-forever).
    await ctx.page.evaluate(() => document.querySelector('.sidebar-scrim').click());
    await new Promise((r) => setTimeout(r, 300));
    const closedAttr = await ctx.page.evaluate(() => document.body.getAttribute('data-sidebar-open'));
    assert.strictEqual(closedAttr, null, '抽屜必須真的關上，scrim 點擊沒有生效');
    await ctx.page.keyboard.press('PageDown');
    await new Promise((r) => setTimeout(r, 250));
    const afterClose = await ctx.page.evaluate(() => window.scrollY);
    assert.ok(afterClose > 0,
      '抽屜關上後 PageDown 必須恢復正常捲動，got ' + afterClose);

    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the sidebar drawer actually locks the page behind it — OK');
  }

  // ── live：.lightbox ─────────────────────────────────────────────────
  // lightbox 開著時 lib/md2doc.js 的 `body[data-lightbox-open] { overflow:
  // hidden; }` 只作用在 <body> 上 —— 捲動的捲動容器是 documentElement，它的
  // overflow 仍是 `clip visible`，所以【文件照樣捲得動】：實測開著 lightbox
  // 時 window.scrollBy(0, 1500) 讓 scrollY 從 0 走到 1048，capture 階段收到
  // 一個 scroll 事件。這一列問的就是「這個捲動不得把 lightbox 拆掉」。
  //
  // ⚠ 不要改回「捲它自己的 .lightbox-stage」：實測 stage 在 zoom 1 下被縮到
  // 剛好容納整張圖（1×1 與 1600×1200 兩種圖都量過：scrollHeight ===
  // clientHeight === 744、scrollWidth === clientWidth === 1400），s.scrollTop
  // = 40 會被夾回 0 且【一個 scroll 事件都不發】。stage 要真的能捲必須先驅動
  // 縮放控制，那是 test/lightbox.test.js 的地盤（它已經斷言縮放後
  // stage.scrollWidth > stage.clientWidth）。
  {
    // boot() (not newPage()) so the png exists BEFORE the first render:
    // md2doc inlines local image srcs at render time and prints
    // "[WARN] image not found, left as-is" when the file is missing yet.
    const b = await boot('# H\n\n![x](one.png)\n\n' + V3_FILL + '\n');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    fs.writeFileSync(path.join(path.dirname(b.mdPath), 'one.png'), png);
    const ctx = Object.assign({ page: await browser.newPage() }, b);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.goto(b.url, { waitUntil: 'networkidle0' });
    await ctx.page.click('.content img');
    await new Promise((r) => setTimeout(r, 500));
    const before = await overlayState(ctx.page, '.lightbox');
    assertRaised(before, '.lightbox');
    // 和其他每一列一樣走共用的 scrollBy()，它會斷言 scrollY 真的變了 ——
    // 少了這道前提，一個根本沒發生的捲動會讓下面的斷言永遠是綠的。
    await scrollBy(ctx.page, 1500);
    const after = await overlayState(ctx.page, '.lightbox');
    assert.ok(isLive(after), '.lightbox 捲動後必須仍然可見，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .lightbox survives a document scroll — OK');
  }

  // ── lock：lightbox 開著時真實手勢不得捲動底下的文件 ────────────────
  // v3.2.1 removed the only assertion covering `body[data-lightbox-open] {
  // overflow: hidden; }` (commit 70ba7a6) because it checked
  // getComputedStyle(document.body).overflow === 'hidden' — the rule
  // existing, not any scroll actually being blocked — and the row above
  // already established that documentElement, not body, is the element a
  // real gesture scrolls. Now that lib/md2doc.js also locks documentElement
  // itself (the `html[data-lightbox-open]` rule next to the `overflow-x:
  // clip` comment), this row re-pins the coverage as a fact: after a real
  // gesture, window.scrollY does not move.
  //
  // window.scrollBy() cannot stand in for the gesture — it moves the page
  // under overflow:hidden by definition (that is why the .lightbox row
  // above uses it to test the overlay survives a scroll, not to test a
  // lock). PageDown and End go through page.keyboard.press(), which drives
  // the real input pipeline.
  {
    const ctx = await newPage('# Doc\n\n![x](data:image/png;base64,'
      + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)\n\n'
      + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });

    // Precondition (Ruling T12-1): the same PageDown must move the page
    // BEFORE the lightbox opens. Without this, a fixture that stopped being
    // taller than the viewport would leave scrollY at 0 before and after,
    // and the locked-state assertions below would pass for the wrong reason.
    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    await ctx.page.keyboard.press('PageDown');
    await new Promise((r) => setTimeout(r, 250));
    const preOpenY = await ctx.page.evaluate(() => window.scrollY);
    assert.ok(preOpenY > 0,
      'V3 前提失敗：lightbox 關著時 PageDown 沒有真的捲動文件（scrollY=' + preOpenY +
      '），下面「鎖住」的斷言測不到東西');

    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    await ctx.page.click('.content img');
    await new Promise((r) => setTimeout(r, 400));
    const open = await ctx.page.evaluate(() => {
      const box = document.querySelector('.lightbox');
      return !!box && !box.hidden;
    });
    assert.ok(open, 'lightbox 應已開啟');

    await ctx.page.keyboard.press('PageDown');
    await new Promise((r) => setTimeout(r, 250));
    const afterPageDown = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(afterPageDown, 0,
      'lightbox 開著時 PageDown 不得捲動底下的文件，got ' + afterPageDown);

    // End jumps straight to the bottom instead of advancing by a viewport
    // at a time — a different code path from PageDown. Pre-fix on this
    // fixture it leaked further than PageDown's 700px: measured 1048px.
    await ctx.page.keyboard.press('End');
    await new Promise((r) => setTimeout(r, 250));
    const afterEnd = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(afterEnd, 0,
      'lightbox 開著時 End 不得捲動底下的文件，got ' + afterEnd);

    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the lightbox actually locks the page behind it — OK');
  }

  // ── live：.ed-conflict ──────────────────────────────────────────────
  // 存檔／render 失敗的橫幅是 z-index 999（全檔最高），而且是使用者唯一能
  // 知道「剛剛那次編輯沒有套用」的東西。幾何是 top/left/right 定死，捲動不
  // 可能讓它過期。升起方式：把 server 關掉再逼一次 render。
  {
    const ctx = await newPage('# H\n\nAlpha paragraph.\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' X');
    ctx.srv.close();
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForSelector('.ed-conflict', { timeout: 8000 });
    const before = await overlayState(ctx.page, '.ed-conflict');
    assertRaised(before, '.ed-conflict');
    await scrollBy(ctx.page, 1200);
    const after = await overlayState(ctx.page, '.ed-conflict');
    assert.ok(isLive(after), '.ed-conflict 捲動後必須仍然可見，got ' + JSON.stringify(after));
    assert.strictEqual(after.top, before.top, '.ed-conflict 捲動後必須留在同一個視窗座標');
    await ctx.page.close();
    console.log('journey: V3 .ed-conflict stays live across a scroll — OK');
  }

  // ── gone × 3：.ed-te-grip-col / .ed-te-menu / .ed-tb-insert ─────────
  // 列軸的 grip 由下面它自己那一列驅動 —— 這裡查的是 `-col`。
  {
    // grip：把游標移到表頭儲存格中央。
    const ctx = await newPage(V3_TABLE_MD);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    const ts = await centreTable(ctx.page);
    const cell = await ctx.page.evaluate((t) => {
      const r = document.querySelector(t + ' table').tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, ts);
    await ctx.page.mouse.move(cell.x, cell.y);
    await ctx.page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 4000 });
    const gripBefore = await overlayState(ctx.page, '.ed-te-grip-col');
    assertRaised(gripBefore, '.ed-te-grip-col');
    // menu：點那顆 grip。
    const g = await ctx.page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(g.x, g.y);
    await ctx.page.mouse.down(); await ctx.page.mouse.up();
    await ctx.page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 4000 });
    const menuBefore = await overlayState(ctx.page, '.ed-te-menu');
    assertRaised(menuBefore, '.ed-te-menu');
    await scrollBy(ctx.page, 200);
    const gripAfter = await overlayState(ctx.page, '.ed-te-grip-col');
    const menuAfter = await overlayState(ctx.page, '.ed-te-menu');
    assert.ok(isGone(gripAfter),
      '.ed-te-grip-col 捲動後必須消失，got ' + JSON.stringify(gripAfter));
    assert.ok(isGone(menuAfter),
      '.ed-te-menu 捲動後必須消失（它是唯一會真的刪掉整欄整列的浮層），got ' + JSON.stringify(menuAfter));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-te-grip-col / .ed-te-menu vanish on scroll — OK');
  }
  {
    // ＋ 泡泡：只在距離表格邊界 TB_EDGE_PX(10) 內才升起 —— 欄泡泡在表格
    // 【上緣】、對齊某個表頭儲存格的【右緣】。移到儲存格中央是升不起來的。
    const ctx = await newPage(V3_TABLE_MD);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    const ts = await centreTable(ctx.page);
    const p = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      const tr = tb.getBoundingClientRect();
      const cr = tb.tHead.rows[0].cells[0].getBoundingClientRect();
      return { x: cr.right, y: tr.top + 3 };
    }, ts);
    await ctx.page.mouse.move(p.x - 60, p.y);
    await ctx.page.mouse.move(p.x, p.y);
    await new Promise((r) => setTimeout(r, 400));
    const before = await overlayState(ctx.page, '.ed-tb-insert-col');
    assertRaised(before, '.ed-tb-insert');
    await scrollBy(ctx.page, 200);
    const after = await overlayState(ctx.page, '.ed-tb-insert-col');
    assert.ok(isGone(after), '.ed-tb-insert 捲動後必須消失，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-tb-insert vanishes on scroll — OK');
  }

  // ── gone：.ed-te-grip-row —— 上面那一列驅的是欄軸 ────────────────────
  //
  // 上面那一列的訊息寫 `.ed-te-grip`，查詢的卻是 `.ed-te-grip-col`：列軸的
  // grip 在那裡沒有升起來過，所以 hideTableGrips() 漏收列軸也照樣綠。實測
  // （把 hideTableGrips() 裡的 `rowGrip.hidden = true;` 拿掉）：上面那一列
  // 綠，這一列紅。
  //
  // fixture 的形狀不是隨手挑的。header-only 的表格會 withhold 列 grip
  //（updateTableEdgeGrips() 的 `rowEl !== headerRow ||
  // bodyRowsOf(tableEl).length > 0`，理由寫在它自己的註解裡：拖走 thead 的
  // 那一列會讓表格降級消失），而欄 grip 照樣升起 —— 實測 header-only 的
  // 表格上 row 是 hidden、col 是 display:grid。所以這裡用帶著 body 列的
  // V3_TABLE_MD（one/two 與 three/four），hover 起點落在儲存格內，並且真的
  // 從一列移到另一列。
  //
  // 幾何實測（1400×800、V3_TABLE_MD、centreTable() 之後）：grip 20×28、
  // left 落在表格左緣減去自己一半寬（80 → 70），縱向對齊被 hover 的那一列
  // 的中線（列 382..419 時 top=386；指標移到 419..456 那一列時變成 424）。
  // 按下去之後看得到的選單項目是「刪除列」。
  {
    const ctx = await newPage(V3_TABLE_MD);
    await ctx.page.setViewport({ width: 1400, height: 800 });
    const ts = await centreTable(ctx.page);
    const bodyRows = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      return tb.tBodies.length ? tb.tBodies[0].rows.length : 0;
    }, ts);
    assert.ok(bodyRows > 1,
      '列 grip 前提失敗：fixture 的表格必須有可以 hover 的 body 列，而且不只一列 —— ' +
      'header-only 的表格是列 grip 被 withhold、欄 grip 照升的形狀，' +
      '在那種 fixture 上這一列會變成空跑的綠燈，got bodyRows=' + bodyRows);
    const cellAt = (i) => ctx.page.evaluate((a) => {
      const r = document.querySelector(a.t + ' table').tBodies[0].rows[a.i]
        .cells[0].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { t: ts, i: i });
    // grip 與它此刻該對齊的那一列，一起量回來。
    const rowGeom = (i) => ctx.page.evaluate((a) => {
      const g = document.querySelector('.ed-te-grip-row');
      const tb = document.querySelector(a.t + ' table');
      const gr = g.getBoundingClientRect();
      const rr = tb.tBodies[0].rows[a.i].getBoundingClientRect();
      return { gripMid: gr.top + gr.height / 2, gripLeft: gr.left, gripW: gr.width,
        rowMid: rr.top + rr.height / 2, tableLeft: tb.getBoundingClientRect().left };
    }, { t: ts, i: i });
    const first = await cellAt(0);
    await ctx.page.mouse.move(first.x, first.y);
    await ctx.page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 4000 });
    const gripBefore = await overlayState(ctx.page, '.ed-te-grip-row');
    assertRaised(gripBefore, '.ed-te-grip-row');
    const g0 = await rowGeom(0);
    assert.ok(Math.abs(g0.gripLeft - (g0.tableLeft - g0.gripW / 2)) <= 1,
      '.ed-te-grip-row 必須跨在表格左邊界上（left = 表格左緣 − 自己一半寬），got ' +
      JSON.stringify(g0));
    assert.ok(Math.abs(g0.gripMid - g0.rowMid) <= 1,
      '.ed-te-grip-row 必須縱向對齊被 hover 的那一列，got ' + JSON.stringify(g0));
    // 指標移到另一列：grip 必須跟過去。少了這一步，一個釘死在表頭高度上不動
    // 的 grip 也能讓上面那條「對齊」斷言在第一列上成立。
    const second = await cellAt(1);
    await ctx.page.mouse.move(second.x, second.y);
    await new Promise((r) => setTimeout(r, 250));
    const g1 = await rowGeom(1);
    assert.notStrictEqual(Math.round(g1.gripMid), Math.round(g0.gripMid),
      '.ed-te-grip-row 換一列 hover 之後必須移動，got ' + JSON.stringify({ g0: g0, g1: g1 }));
    assert.ok(Math.abs(g1.gripMid - g1.rowMid) <= 1,
      '.ed-te-grip-row 必須跟著指標所在的那一列走，got ' + JSON.stringify(g1));
    // 按下去：量的是使用者【看得到】的項目。showRowMenu() 把 teAlignBtn 設成
    // hidden（對齊是欄軸的事），而它仍留在 .ed-te-menu 的 children 裡 ——
    // 實測 [{刪除列,shown:true},{對齊,shown:false}]，所以照 children 數就會
    // 把一顆看不到的按鈕算進來。
    const gp = await ctx.page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(gp.x, gp.y);
    await ctx.page.mouse.down(); await ctx.page.mouse.up();
    await ctx.page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 4000 });
    const menuBefore = await overlayState(ctx.page, '.ed-te-menu');
    assertRaised(menuBefore, '.ed-te-menu（列軸）');
    const items = await ctx.page.evaluate(() =>
      Array.from(document.querySelector('.ed-te-menu').children)
        .map((c) => ({ label: c.textContent.trim(), shown: c.offsetParent !== null })));
    assert.deepStrictEqual(items.filter((i) => i.shown).map((i) => i.label), ['刪除列'],
      '列 grip 按下去之後看得到的選單項目變了，got ' + JSON.stringify(items));
    await scrollBy(ctx.page, 200);
    const gripAfter = await overlayState(ctx.page, '.ed-te-grip-row');
    const menuAfter = await overlayState(ctx.page, '.ed-te-menu');
    assert.ok(isGone(gripAfter),
      '.ed-te-grip-row 捲動後必須消失（欄軸那一列看不到列軸漏收），got ' +
      JSON.stringify(gripAfter));
    assert.ok(isGone(menuAfter),
      '.ed-te-menu（列軸）捲動後必須消失 —— 它是會真的刪掉整列的那個選單，got ' +
      JSON.stringify(menuAfter));
    assert.strictEqual(ctx.errs.length, 0,
      '列 grip：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-te-grip-row follows the hovered row and vanishes on scroll — OK');
  }

  // ── gone：.ed-toolbar-menu（H▾ 下拉）────────────────────────────────
  {
    const ctx = await newPage('# H\n\n' + V3_FILL + '\n');
    await ctx.page.setViewport({ width: 1400, height: 800 });
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await pressClick(ctx.page, '[data-ed-tb="headings"]', 80);
    await ctx.page.waitForSelector('.ed-toolbar-menu', { timeout: 4000 });
    const before = await overlayState(ctx.page, '.ed-toolbar-menu');
    assertRaised(before, '.ed-toolbar-menu');
    await scrollBy(ctx.page, 300);
    const after = await overlayState(ctx.page, '.ed-toolbar-menu');
    assert.ok(isGone(after), '.ed-toolbar-menu 捲動後必須消失，got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-toolbar-menu vanishes on scroll — OK');
  }

  // ── V3b: onAnyScroll 的 `capture: true` ─────────────────────────────
  //
  // v3.2.1 final wave, D16。上面每一列捲的都是【文件】，而文件層的 scroll
  // 事件在 capture 與 bubble 兩個階段都會經過 document 上的監聽器 —— 所以把
  // client.js 那一行的 `capture: true` 改掉，上面十一列一列都不會紅。
  //
  // 真正只有 capture 期才收得到的是【內層可捲元素】的 scroll：scroll 事件從
  // 元素上派發時【不冒泡】（只有 document / window 的那一發會）。閱讀側邊欄
  // 的 .toc-list 就是這樣一個元素，而它在編輯模式下是可以被使用者捲的。
  //
  // 這一列因此捲 .toc-list（不動 window.scrollY，並且斷言它真的沒動），然後
  // 問一個 onAnyScroll() 才會做的事有沒有發生。用 H▾ 下拉當觀測點而不是表格
  // grip：兩者都在 onAnyScroll() 的同一個函式體裡（hideTableGrips /
  // hideTableInsertBubbles / hideTableEdgeMenu / closeToolbarMenu 四件事一起
  // 跑），但下拉不需要把滑鼠停在表格上、也不受抽屜遮擋影響，前提比較好立。
  //
  // 實測：把 `capture: true` 改成 `capture: false` 之後這一列會紅
  //（.ed-toolbar-menu 捲完仍然 live）；上面十一列全綠。
  {
    const headings = Array.from({ length: 30 }, (_, i) => '## Section ' + i + '\n\nBody ' + i + '.\n').join('\n');
    const ctx = await newPage('# H\n\n' + headings);
    await ctx.page.setViewport({ width: 800, height: 700 });
    await new Promise((r) => setTimeout(r, 300));
    // 讓工具列瞄準一個 block，H▾ 才會是 enabled。用 focus() 而不是滑鼠點擊：
    // 800px 下 .ed-toolbar 蓋著文件頂端，滑鼠點擊會打到工具列自己。
    await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="0"] .ed-wys-armed').focus());
    await new Promise((r) => setTimeout(r, 250));
    // 抽屜：.sidebar-toggle 被 .ed-toolbar 蓋住（見上面那一列的註解），用 DOM click。
    await ctx.page.evaluate(() => document.querySelector('.sidebar-toggle').click());
    await new Promise((r) => setTimeout(r, 450));
    const pre = await ctx.page.evaluate(() => {
      const l = document.querySelector('.toc-list');
      return l ? { found: true, scrollH: l.scrollHeight, clientH: l.clientHeight } : { found: false };
    });
    assert.ok(pre.found, 'V3b 前提失敗：抽屜裡找不到 .toc-list');
    assert.ok(pre.scrollH > pre.clientH + 20,
      'V3b 前提失敗：.toc-list 根本捲不動，這一列就沒測到內層捲動，got ' + JSON.stringify(pre));
    const hDisabled = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="headings"]').disabled);
    assert.strictEqual(hDisabled, false, 'V3b 前提失敗：H▾ 是 disabled，下拉開不起來');
    await ctx.page.evaluate(() => document.querySelector('[data-ed-tb="headings"]').click());
    await ctx.page.waitForSelector('.ed-toolbar-menu', { timeout: 4000 });
    const before = await overlayState(ctx.page, '.ed-toolbar-menu');
    assertRaised(before, '.ed-toolbar-menu (V3b)');
    const moved = await ctx.page.evaluate(() => {
      const l = document.querySelector('.toc-list');
      const y0 = window.scrollY, t0 = l.scrollTop;
      l.scrollTop = 120;
      return { y0: y0, t0: t0, t1: l.scrollTop };
    });
    assert.notStrictEqual(moved.t1, moved.t0,
      'V3b 前提失敗：.toc-list 的 scrollTop 沒有真的移動，got ' + JSON.stringify(moved));
    await new Promise((r) => setTimeout(r, 450));
    const y1 = await ctx.page.evaluate(() => window.scrollY);
    assert.strictEqual(y1, moved.y0,
      'V3b 前提失敗：這一捲把【文件】也捲了，那就退回成上面十一列已經涵蓋的形狀，got ' +
      y1 + ' was ' + moved.y0);
    const after = await overlayState(ctx.page, '.ed-toolbar-menu');
    assert.ok(isGone(after),
      'V3b: .toc-list 這種內層捲動也必須關掉浮層 —— scroll 事件不冒泡，只有 ' +
      'document 上 capture 期的監聽器收得到它。這一條紅了，通常表示 onAnyScroll ' +
      '的 `capture: true` 被拿掉了。got ' + JSON.stringify(after));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3b an inner .toc-list scroll still closes the overlays (capture phase) — OK');
  }

  // ── reposition-or-gone：.ed-seltb ───────────────────────────────────
  // 兩件事：位置行為（捲一點跟著走、整個捲出視窗才消失）＋【資料完整性】
  // （捲動後在那個滯留位置按下去，磁碟不得改變）。
  //
  // 資料完整性那一條上面「the floating format bar cannot act on off-screen
  // text」也在守，但那是【那一個場景】自己的斷言 —— 它哪天被整理掉，這張表
  // 就什麼都不剩了。brief 要求它「列進表以免被拆掉」，所以這裡自己做一次真的
  // 點擊與比對，而不是用註解指向別人。
  {
    for (const dy of [60, 3000]) {
      const ctx = await newPage(V3_TABLE_MD);
      await ctx.page.setViewport({ width: 1400, height: 800 });
      await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="5"] .ed-wys-armed');
        el.scrollIntoView({ block: 'center' });
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        el.focus();
        document.dispatchEvent(new Event('selectionchange'));
      });
      await new Promise((r) => setTimeout(r, 350));
      const before = await overlayState(ctx.page, '.ed-seltb');
      assertRaised(before, '.ed-seltb');
      await scrollBy(ctx.page, dy);
      const after = await overlayState(ctx.page, '.ed-seltb');
      if (dy === 60) {
        assert.ok(isLive(after),
          '.ed-seltb 選取仍在視窗內時必須留著（純隱藏會讓它永遠回不來），got ' + JSON.stringify(after));
        assert.strictEqual(after.top, before.top - dy,
          '.ed-seltb 必須跟著選取一起移動 ' + dy + 'px，got top=' + after.top + ' was ' + before.top);
      } else {
        assert.ok(isGone(after),
          '.ed-seltb 選取整個捲出視窗後必須消失，got ' + JSON.stringify(after));
        // 資料完整性：在浮動列【原本】的位置真的按一下，磁碟不得改變。
        // 磁碟基準直接讀檔、不走 saveAndRead()：Ctrl+S 會先跑
        // switchAwayFrom()，那本身就會收掉這次 burst，基準就不再是「捲動前」
        // 的狀態（同上面那個既有場景的 fixture note）。
        assert.ok(before.top > 60,
          'V3 前提失敗：.ed-seltb 原本的位置落在工具列高度內（top=' + before.top +
          '），等一下那一下會按到工具列而不是滯留的浮動列');
        const diskBefore = fs.readFileSync(ctx.mdPath, 'utf8');
        await ctx.page.mouse.click(before.left + before.w / 2, before.top + before.h / 2);
        await new Promise((r) => setTimeout(r, 300));
        const diskAfter = await saveAndRead(ctx);
        assert.strictEqual(diskAfter, diskBefore,
          '在滯留的 .ed-seltb 位置按下去不得改到文件，got:\n' + diskAfter);
      }
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V3 .ed-seltb repositions with its selection, then goes — OK');
  }

  // ── gone-on-drag-end × 2：兩個 drop indicator ───────────────────────
  {
    const drags = [
      {
        sel: '.ed-te-drop-indicator',
        why: 'onAnyScroll() 被 tePointer.dragging 的 early-return 整個跳過',
        // 表格列拖曳：從列 grip 起手。
        raise: async (page) => {
          const ts = await centreTable(page);
          const cell = await page.evaluate((t) => {
            const r = document.querySelector(t + ' table').tBodies[0].rows[0].cells[0].getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }, ts);
          await page.mouse.move(cell.x, cell.y);
          await page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 4000 });
          return page.evaluate(() => {
            const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        },
      },
      {
        sel: '.ed-block-drop-indicator',
        why: 'onAnyScroll() 整個跑完，但它做的事都沒有碰到 blockDropIndicator',
        // 區塊拖曳：從 ⠿ 起手。
        raise: async (page) => {
          await page.evaluate(() =>
            document.querySelector('.ed-block[data-block-id="5"]').scrollIntoView({ block: 'center' }));
          await new Promise((r) => setTimeout(r, 150));
          await page.hover('.ed-block[data-block-id="5"]');
          return page.evaluate(() => {
            const r = document.querySelector('.ed-block[data-block-id="5"] .ed-handle').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          });
        },
      },
    ];
    for (const d of drags) {
      const ctx = await newPage(V3_TABLE_MD);
      await ctx.page.setViewport({ width: 1400, height: 800 });
      const start = await d.raise(ctx.page);
      await ctx.page.mouse.move(start.x, start.y);
      await ctx.page.mouse.down();
      await ctx.page.mouse.move(start.x, start.y + 40);
      await ctx.page.mouse.move(start.x, start.y + 80);
      await new Promise((r) => setTimeout(r, 250));
      const dragging = await overlayState(ctx.page, d.sel);
      assertRaised(dragging, d.sel);
      // 前提 1：原地不動可以被接受的唯一理由是它點不到 —— 把那個理由釘住。
      assert.strictEqual(dragging.pointerEvents, 'none',
        d.sel + ' 必須是 pointer-events:none —— 捲動中它會留在過期座標上，' +
        '能被點到就代表過期的線可以動到資料，got ' + JSON.stringify(dragging));
      // 前提 2：拖曳中的捲動確實不動它（理由見上面表格註解，兩個 indicator
      // 不同）。這件事原本只寫在註解裡、沒有任何斷言看著。
      await scrollBy(ctx.page, 200);
      const midDrag = await overlayState(ctx.page, d.sel);
      assert.ok(isLive(midDrag),
        d.sel + ' 拖曳中的捲動不得讓它消失（它要等放開才收），got ' + JSON.stringify(midDrag));
      assert.strictEqual(midDrag.top, dragging.top,
        d.sel + ' 拖曳中的捲動實測不會移動它（' + d.why + '）—— ' +
        'top 變了代表 onAnyScroll 的行為與這一列的前提不再相符，got top=' +
        midDrag.top + ' was ' + dragging.top);
      // 前提 3：放開之後必須收乾淨。
      await ctx.page.mouse.up();
      await new Promise((r) => setTimeout(r, 600));
      const dropped = await overlayState(ctx.page, d.sel);
      assert.ok(isGone(dropped),
        d.sel + ' 拖曳結束後必須收乾淨，got ' + JSON.stringify(dropped));
      // 前提 4：此後的捲動不得讓它復活。
      await scrollBy(ctx.page, 200);
      const afterScroll = await overlayState(ctx.page, d.sel);
      assert.ok(isGone(afterScroll),
        d.sel + ' 拖曳結束後的捲動不得讓它復活，got ' + JSON.stringify(afterScroll));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: V3 both drop indicators are inert while stale and gone after the drop — OK');
  }

  // ══ V4: 行內標記的性質測試 ═══════════════════════════════════════════
  // 陳述必須是程式碼【真正擁有】的性質。applyMarkToggle() 是切換不是套用：
  // 選取落在同 tag 既有標記【內】會解包（wholeSelectionMark → unwrapElement），
  // 跨越同 tag 既有標記會擴張並移除（overlappingMarks → extendRangeOverMarks）。
  // 所以性質只對「端點既不在、也不跨越同 tag 既有標記」的選取成立：
  //
  //   套用 → 序列化 → 重新解析，必須產生涵蓋【修剪後】選取的該標記。
  //
  // 推論是另外三個案例，不是這條性質的一部分：全空白 no-op、collapsed
  // no-op、重疊選取移除標記。
  //
  // 生成器涵蓋兩種邊界來源，因為 trimRangeToText() 的字元步進在兩者下走的是
  // 不同的分支（它自己的註解就寫著「實測人類拖曳選取 105 次都不會產生元素
  // 邊界，但編輯器自己的 reselectAndReposition() 會」）：
  //   text     人類拖曳留下的選取 —— startContainer/endContainer 都是 text node
  //   element  reselectAndReposition() 留下的選取 —— 先套斜體，
  //            wrapRangeIn() 回傳的 selectNodeContents(<em>) 讓兩個邊界容器
  //            都變成【元素】。此時端點在 <em> 內、但不在任何 <strong> 內，
  //            所以對 STRONG 而言性質仍然成立。
  //
  // 種子固定，所以失敗永遠可重現；換種子＝換一批案例。
  const V4_SEED = 20261026;
  const v4Rand = (() => {
    let s = V4_SEED;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  })();
  // 只用字母與空白：這條性質測的是【邊界修剪】，不是 markdown 跳脫規則，
  // 而含有 * _ ` [ 的字面文字會讓序列化加上跳脫、把失敗訊息變成另一個題目。
  const V4_TEXT = 'Alpha bravo charlie delta echo foxtrot golf hotel india.';
  const V4_MD = '# H\n\n' + V4_TEXT + '\n\nTail paragraph here.\n';

  async function v4Apply(ctx, start, end, viaItalic) {
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const picked = await ctx.page.evaluate((a, z) => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const r = document.createRange();
      r.setStart(t, a); r.setEnd(t, z);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
      return { text: r.toString(), startType: r.startContainer.nodeType };
    }, start, end);
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(picked.startType, 3,
      'V4 前提失敗：人類拖曳來源的選取起點必須是 text node，got nodeType ' + picked.startType);
    let boundarySource = 'text';
    if (viaItalic) {
      await pressClick(ctx.page, '[data-ed-tb="italic"]', 80);
      await new Promise((r) => setTimeout(r, 350));
      const b = await ctx.page.evaluate(() => {
        const r = window.getSelection().getRangeAt(0);
        return { s: r.startContainer.nodeType, e: r.endContainer.nodeType, text: r.toString() };
      });
      // 這正是這一半案例存在的理由：斷言它真的變成元素邊界。如果哪天
      // reselectAndReposition() 改成留下 text 邊界，這一半就退化成上一半的
      // 重複，而不是安靜地繼續綠著。
      assert.strictEqual(b.s + '/' + b.e, '1/1',
        'V4 前提失敗：套斜體後的選取應是元素邊界（reselectAndReposition），got ' + JSON.stringify(b));
      boundarySource = 'element';
    }
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 350));
    return { picked: picked.text, boundarySource };
  }

  async function v4Commit(ctx) {
    // 點另一個 block 的編輯面就會結束並提交這次 burst（focusout 路徑），
    // 這也是上面「粗體：選取含尾隨空格」案例用的收尾方式。
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 450));
    return saveAndRead(ctx);
  }

  {
    const cases = [];
    for (let i = 0; i < 18; i++) {
      let a, b;
      do {
        a = Math.floor(v4Rand() * V4_TEXT.length);
        b = Math.floor(v4Rand() * V4_TEXT.length);
        if (a > b) { const t = a; a = b; b = t; }
      } while (V4_TEXT.slice(a, b).trim().length === 0);
      cases.push({ a: a, b: b, viaItalic: i >= 12 });
    }
    // 隨機挑出來的切片有沒有真的踩到「前導空白」「尾隨空白」「兩端都有」
    // 「兩端都沒有」四種形狀，是【運氣】—— 第一個試過的種子 (20260905) 的
    // 12 個 text 邊界案例裡一個前導空白都沒有，等於整批都沒考到修剪的那一半。
    // 所以把「四種形狀 × 兩種邊界來源共 8 格都要有人」寫成斷言：換種子的人
    // 會被擋下來，而不是安靜地生出一批不涵蓋修剪的案例。
    const shapeOf = (raw) => ((/^\s/.test(raw) ? 'L' : '') + (/\s$/.test(raw) ? 'T' : '')) || 'N';
    for (const src of [false, true]) {
      const shapes = new Set(cases.filter((c) => c.viaItalic === src)
        .map((c) => shapeOf(V4_TEXT.slice(c.a, c.b))));
      assert.deepStrictEqual(Array.from(shapes).sort(), ['L', 'LT', 'N', 'T'],
        'V4 生成器在 ' + (src ? 'element' : 'text') + ' 邊界來源下必須涵蓋四種空白形狀，got ' +
        JSON.stringify(Array.from(shapes)));
    }
    const bad = [];
    for (const c of cases) {
      const ctx = await newPage(V4_MD);
      const trimmed = V4_TEXT.slice(c.a, c.b).trim();
      const label = '[' + c.a + ',' + c.b + ') ' + JSON.stringify(V4_TEXT.slice(c.a, c.b));
      const r = await v4Apply(ctx, c.a, c.b, c.viaItalic);
      // 序列化：提交把這次 burst 寫回磁碟。
      const disk = await v4Commit(ctx);
      // 重新解析：提交會把 markdown 重新渲染回 DOM，所以【提交之後】的 DOM
      // 才是「序列化 → 重新解析」的結果。這一讀必須在 v4Commit() 之後 ——
      // 提交【之前】讀到的是 applyMarkToggle() 剛剛改過的同一個編輯中節點
      // （用 data-probe 印記量過：提交前印記還在，提交後才變 null，也就是
      // 元素真的被重建了），那個讀法問的是「我剛剛改的 DOM 長什麼樣」，
      // 而磁碟又正是從那個 DOM 序列化出來的 —— 兩者互相蘊含，斷言等於死碼。
      const dom = await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-block[data-block-id="1"]');
        return el ? Array.from(el.querySelectorAll('strong')).map((s) => s.textContent) : null;
      });
      const marker = c.viaItalic ? '***' : '**';
      const want = marker + trimmed + marker;
      // 三條各自獨立（不是 else if）：磁碟那條沒過的時候，重新解析那條仍然
      // 要有機會自己說話，否則它永遠躲在前一條後面、永遠不會被觀察到。
      if (disk.indexOf(want) === -1) {
        bad.push(label + ' (' + r.boundarySource + ') 序列化缺少 ' + JSON.stringify(want) + '，disk:\n' + disk);
      }
      if (!dom || dom.indexOf(trimmed) === -1) {
        bad.push(label + ' (' + r.boundarySource + ') 重新解析後沒有涵蓋修剪後選取的 <strong>，got ' +
          JSON.stringify(dom));
      }
      if (disk.indexOf('\\*') !== -1) {
        bad.push(label + ' (' + r.boundarySource + ') 出現跳脫的星號，disk:\n' + disk);
      }
      await ctx.page.close(); ctx.srv.close();
    }
    assert.deepStrictEqual(bad, [], 'V4 性質不成立的選取:\n' + bad.join('\n'));
    console.log('journey: V4 mark property holds over ' + cases.length +
      ' generated selections (12 text-boundary, 6 element-boundary) — OK');
  }

  // ── V4 推論 1：全空白選取是 no-op ───────────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    const ws = V4_TEXT.indexOf(' ');
    const r = await v4Apply(ctx, ws, ws + 1, false);
    assert.strictEqual(r.picked, ' ', 'V4 前提失敗：這個案例的選取必須恰好是一個空白');
    const html = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(html.indexOf('<strong>'), -1,
      '全空白選取必須是 no-op（trimRangeToText 回 false），got ' + html);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1, '全空白選取不得寫出任何標記，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — an all-whitespace selection is a no-op — OK');
  }

  // ── V4 推論 2：collapsed 選取是 no-op ───────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.firstChild, 5); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 300));
    const disabled = await ctx.page.evaluate(() =>
      document.querySelector('[data-ed-tb="bold"]').disabled);
    assert.strictEqual(disabled, true, 'collapsed 選取下粗體按鈕必須是 disabled');
    // 上面那條「按鈕必須是 disabled」是【獨立可紅】的一道：把
    // hasFormattableSelection() 的 collapsed 判斷拿掉，它就會紅。
    //
    // 下面用 DOM click 繞過停用狀態，考的是「即使有人硬按下去也不能長出標記」
    // 這個【行為】，而不是任何一道特定的閘門 —— 實測 applyMarkToggle() 裡的
    // `if (range.collapsed) return;` 和它下面的 `if (!trimRangeToText(range))
    // return;` 兩道各自都足以擋下來（把前者拿掉，collapsed 的 range 產不出
    // 任何 parts，trimRangeToText() 回 false，結果一模一樣、仍然沒有
    // <strong>）。所以這段不宣稱它在考前者。
    await ctx.page.evaluate(() => document.querySelector('[data-ed-tb="bold"]').click());
    await new Promise((r) => setTimeout(r, 300));
    const html = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(html.indexOf('<strong>'), -1,
      'collapsed 選取必須是 no-op，got ' + html);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1, 'collapsed 選取不得寫出任何標記，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — a collapsed selection is a no-op — OK');
  }

  // ── V4 推論 3：重疊選取【移除】標記 ─────────────────────────────────
  {
    const ctx = await newPage(V4_MD);
    const start = V4_TEXT.indexOf('bravo');
    await v4Apply(ctx, start, start + 5, false);
    const marked = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.ok(marked.indexOf('<strong>bravo</strong>') !== -1,
      'V4 前提失敗：重疊案例需要先有一個 <strong>bravo</strong>，got ' + marked);
    // 從 <strong> 內部延伸到它【外面】—— 端點跨越既有同 tag 標記，正是性質
    // 明確排除、而推論要求「移除」的那一類。
    const overlapped = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const st = el.querySelector('strong');
      const r = document.createRange();
      r.setStart(st.firstChild, 2);
      r.setEnd(st.nextSibling, 6);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      return r.toString();
    });
    assert.ok(overlapped.indexOf('avo') === 0,
      'V4 前提失敗：重疊選取必須真的從 <strong> 內部起頭，got ' + JSON.stringify(overlapped));
    await new Promise((r) => setTimeout(r, 300));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 350));
    const after = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.strictEqual(after.indexOf('<strong>'), -1,
      '重疊選取必須把整個既有標記移除（extendRangeOverMarks → unwrapElement），got ' + after);
    const disk = await v4Commit(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      '重疊選取之後磁碟上不得留下任何 <strong>，disk:\n' + disk);
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V4 corollary — an overlapping selection removes the mark — OK');
  }

  // ── 階段 0: dirty burst ＋ 真人按壓時間下，⠿ 與 ＋ 的選單項必須真的動作 ──
  //
  // 缺陷在【選單項】的那一下按壓上，不在開選單的那一下：`.ed-handle` /
  // `.ed-insert` 早就在 wireBlockSelection() 的委派 preventDefault 清單裡，
  // `.ed-handle-menu-btn` / `.ed-insert-menu-btn`（＝選單項本身的 class）不在。
  // 所以開選單用 page.click() 即可，被測的那一下才用 pressClick()。
  // `clicked` 是【真的抵達選單項的 click 事件數】——按壓期間被 detach 的
  // 按鈕收不到 click，這正是要測的量，不是事後再補一發合成點擊。
  for (const [openBtn, itemSel, itemText, label] of [
    ['.ed-handle', '.ed-handle-menu-btn', '建立副本', '⠿ 建立副本'],
    ['.ed-insert', '.ed-insert-menu-btn', '段落', '＋ 段落'],
  ]) {
    for (const hold of [0, 80]) {
      const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
      const one = '.ed-block[data-block-id="1"]';
      const before = await ctx.page.evaluate(() =>
        document.querySelectorAll('.ed-block').length);
      await ctx.page.click(one + ' .ed-wys-armed');
      await ctx.page.keyboard.type('zz');          // 讓 burst 變 dirty
      await new Promise((r) => setTimeout(r, 120));
      await ctx.page.hover(one);
      await new Promise((r) => setTimeout(r, 120));
      await ctx.page.click(one + ' ' + openBtn);
      await ctx.page.waitForSelector(one + ' ' + itemSel);
      await armDetachProbe(ctx.page, itemSel, itemText);
      const press = await pressClick(ctx.page, '[data-journey-target="1"]', hold);
      await new Promise((r) => setTimeout(r, 500));
      const clicked = await itemClickFired(ctx.page);
      const after = await ctx.page.evaluate(() =>
        document.querySelectorAll('.ed-block').length);
      // 前提：這一列必須【有能力】抓到缺陷。缺陷的形狀是「commit 的 render
      // 在 mouseup 之前就把 block 換掉」，所以按壓必須比這台機器的
      // fetch→DOM 換好還久。在 round trip 超過按壓時間的機器上，未修版本
      // 的這一列會【前後都綠】—— 網子靜靜失去偵測力而沒有任何人被告知。
      // 這條斷言把那個情境變成一次響亮的失敗（訊息直接說要調大 hold）。
      if (hold > 0) await assertDetachCapable(ctx.page, press, label + '（hold=' + hold + 'ms）');
      assert.strictEqual(clicked, 'ok',
        label + '（hold=' + hold + 'ms）：選單在 mouseup 前就消失了');
      assert.ok(after > before,
        label + '（hold=' + hold + 'ms）：block 數應增加，got ' + before + ' → ' + after);
      assert.strictEqual(ctx.errs.length, 0,
        label + '（hold=' + hold + 'ms）：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: ' + label + ' survives a real mouse press — OK');
  }

  // ── 階段 0 的開放決定裁定 (a)：⠿ → MD 原始碼 維持【丟棄】語意 ──────────
  //
  // 這一條把裁定釘在磁碟位元組上，理由是「丟棄」在 HEAD
  // 上【真人永遠碰不到】：實測按壓 0 / 5 ms 時 mousedown 的 blur 搶先提交
  // （磁碟拿到那些字；表格連沒碰過的分隔列都被重新序列化成 `|---|`），
  // 按壓 80 ms 時整個手勢死掉、raw 編輯器根本沒開。修好委派清單之後三個
  // 按壓時間走的是同一條丟棄分支，所以這裡三個都測。
  //
  // 這一族的偵測力【不】綁在按壓時間上：hold=0 那一列在未修版本上就已經紅
  // （raw 顯示 "Alpha paragraph.zz"），所以不需要上面那條 round-trip 前提
  // 斷言 —— 換一台機器頂多讓 80ms 那列變得跟 0ms 那列同義，紅的還是紅的。
  for (const [md, blockSel, surfaceSel, typed, label] of [
    ['# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n',
     '.ed-block[data-block-id="1"]', '.ed-wys-armed', 'zz', '段落'],
    ['# Doc\n\nAnchor para.\n\n| A | B |\n| --- | --- |\n| one | two |\n\nTail para.\n',
     '.ed-block[data-block-type="table"]', '.ed-wys-cell', 'ZZZ', '表格'],
  ]) {
    for (const hold of [0, 5, 80]) {
      const where = '⠿ → MD 原始碼 / ' + label + '（hold=' + hold + 'ms）';
      const ctx = await newPage(md);
      await ctx.page.click(blockSel + ' ' + surfaceSel);
      await ctx.page.keyboard.type(typed);
      await new Promise((r) => setTimeout(r, 150));
      await ctx.page.hover(blockSel);
      await new Promise((r) => setTimeout(r, 120));
      await pressClick(ctx.page, blockSel + ' .ed-handle', 80);
      await ctx.page.waitForSelector(blockSel + ' .ed-handle-menu-btn');
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', hold);
      await new Promise((r) => setTimeout(r, 600));
      const seen = await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        return { raw: ta ? ta.value : null, title: document.title };
      });
      assert.notStrictEqual(seen.raw, null,
        where + '：raw 編輯器必須真的開起來（HEAD 上 hold=80 時整個手勢死掉）');
      assert.strictEqual(seen.raw.indexOf(typed), -1,
        where + '：raw 編輯器不得顯示被丟棄的打字，got ' + JSON.stringify(seen.raw));
      assert.strictEqual(seen.title.indexOf('●'), -1,
        where + '：丟棄之後分頁標題不得有未存檔標記，got ' + JSON.stringify(seen.title));
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, md,
        where + '：丟棄語意要求磁碟逐位元組不變，got:\n' + disk);
      assert.strictEqual(ctx.errs.length, 0,
        where + '：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: ⠿ → MD 原始碼 discards a dirty ' + label +
      ' burst under a real mouse press — OK');
  }

  // ── 地基 B: undo 一個標記不得連同剛打的整句一起丟掉 ──────────────────
  //
  // 缺陷形狀（量測）：`noteTyping()` 沒有 timer，一段
  // 打字自己永遠不會 checkpoint；而 mark toggle 在【改完 DOM 之後】才 snap，
  // 於是那一筆 snapshot 同時裝著「打的字」與「粗體」。一次 undo 把兩者一起
  // 退掉，段落回到全新狀態。
  //
  // 這幾列【不】用 armDetachProbe()/assertDetachCapable() 的前提斷言。那對
  // helper 量的是 `/api/render` → `.content` childList 的 commit round trip，
  // 而這個手勢一發 `/api/render` 都沒有：包住 window.fetch 實測，從開頁到
  // 手勢做完為止 `/api/render` 的呼叫數是 0（工具列與原生 Ctrl+B 兩條都是），
  // 所以 assertDetachCapable() 會直接卡在它自己的「一發都沒有」前提上。
  // 這幾列測的是 undo 粒度，不是按壓跟 commit 賽跑 —— 缺陷在 mouseup 之後
  // 才由 Ctrl+Z 顯現，按壓長短改變不了它。hold 仍用 80ms 以符合本檔案的
  // 真實滑鼠按壓慣例。
  //
  // `markRe` 是每一列自己的前提：實測這幾條路徑產出的標籤【不同】（工具列
  // 走 wrapRangeIn() 給 <strong>，原生 execCommand 給 <b>／<i>／<u>），
  // 用一條寬鬆到全部都收的 regex 會讓「按了但什麼都沒發生」也算過。
  const nativeKey = (code) => async (page) => {
    await page.keyboard.down('Control');
    await page.keyboard.press(code);
    await page.keyboard.up('Control');
  };
  for (const [label, applyMark, markRe] of [
    ['工具列', async (page) => { await pressClick(page, '[data-ed-tb="bold"]', 80); },
     /<strong>typed<\/strong>/],
    // 原生 Ctrl+B／I／U：md2doc 沒有這三個綁定 —— handleBurstKeydown() 只對
    // Tab／Enter／Escape／Ctrl+Z／Ctrl+Y 有分支，其餘按鍵直接落到瀏覽器自己
    // 的 execCommand。實測（Chromium / puppeteer 24.42.0，就是下面這個手勢）
    // 三者各派 `beforeinput`/`input` 一次，inputType 依序是 formatBold／
    // formatItalic／formatUnderline，且 beforeinput 當下 innerHTML 還沒有那顆
    // 標籤 —— 這條路徑一個 snapBurstIfActive() 呼叫端都不經過。Ctrl+B 是
    // brief 列的驗收條件；Ctrl+I／Ctrl+U 是同機制的順帶，一起釘在這裡而不是
    // 只寫在註解裡宣稱。
    ['原生 Ctrl+B', nativeKey('KeyB'), /<b>typed<\/b>/],
    ['原生 Ctrl+I', nativeKey('KeyI'), /<i>typed<\/i>/],
    ['原生 Ctrl+U', nativeKey('KeyU'), /<u>typed<\/u>/],
  ]) {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.type(' typed sentence');
    await new Promise((r) => setTimeout(r, 500));   // 超過 400ms 的 noteTyping 門檻
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const t = el.firstChild;
      const i = el.textContent.indexOf('typed');
      const r = document.createRange();
      r.setStart(t, i); r.setEnd(t, i + 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 200));
    await applyMark(ctx.page);
    await new Promise((r) => setTimeout(r, 250));
    // 前提：標記真的套上去了。少了這一發，一個「按了但什麼都沒發生」的
    // 手勢會讓底下兩條斷言【原封不動地綠】—— 字還在、也沒有標記標籤，
    // 正是本 repo 已經產出過三次的空綠形狀。
    const marked = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.ok(markRe.test(marked),
      label + ' 前提失敗：' + markRe + ' 沒套上去，這一列量不到 undo 粒度，got: ' +
      JSON.stringify(marked));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 250));
    const text = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').textContent);
    assert.ok(text.indexOf('typed sentence') !== -1,
      label + '：undo 只該退掉粗體，不該退掉打的字，got: ' + JSON.stringify(text));
    const html = await ctx.page.evaluate(() =>
      document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed').innerHTML);
    assert.ok(!/<(strong|b|em|i|u)\b/.test(html),
      label + '：undo 之後不得留著標記標籤，got: ' + JSON.stringify(html));
    assert.strictEqual(ctx.errs.length, 0,
      label + '：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: undo of a mark (' + label +
      ') keeps the sentence you just typed — OK');
  }

  // ── 地基 B / C1: 表格結構性變動也不得吃掉剛打進儲存格的字 ─────────────
  //
  // 那七個表格結構操作（insert/delete row+col、align、row+col drag）不走
  // snapBurstIfActive()，而是直接 currentBurst.history.snap('<reason>')，所以
  // 它們不在 brief 的 12 個呼叫端清單裡，修 12 個的時候整族被漏掉。缺陷形狀
  // 一模一樣：往儲存格打字（打字自己永遠不 checkpoint）→ 插一列 → 一次
  // Ctrl+Z，剛打的字跟著那一列一起不見。
  //
  // 這一列只驅動 insert-row 一個；ablation 實測它 red 的正是
  // `insert-row-pre` 一個（單獨拿掉它 → FAIL；拿掉其餘六個、留著它 → PASS），
  // 其餘六個由同一個成對形狀承擔，report 有記。
  {
    const ctx = await newPage('# Doc\n\nAnchor para.\n\n' +
      '| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n\nTail para.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    const TSEL = '.ed-block[data-block-type="table"]';
    await ctx.page.click(TSEL + ' .ed-wys-cell');
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.type('TYPED');
    await new Promise((r) => setTimeout(r, 500));   // 超過 400ms 的 noteTyping 門檻
    // ＋ 列泡泡：只在距表格【左緣】TB_EDGE_PX(10) 內、且對齊某條列邊界時升起。
    // 起點壓在那條帶子的最外圈（左緣往左 TB_EDGE_PX）—— 泡泡叫得起來，而
    // 指標還沒踩到泡泡本身，接下來才有「伸手過去」這段路可走。
    const bp = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      const tr = tb.getBoundingClientRect();
      const rr = tb.tBodies[0].rows[0].getBoundingClientRect();
      return { x: tr.left - 10, y: rr.bottom };
    }, TSEL);
    await ctx.page.mouse.move(bp.x - 60, bp.y);
    await ctx.page.mouse.move(bp.x, bp.y);
    await new Promise((r) => setTimeout(r, 400));
    // 前提一：泡泡真的升起來了，而且指的是我們以為的那條邊界。
    // `afterRowIndex` 就是 onRowInsertBubbleClick() 讀來決定插在哪裡的那個
    // dataset —— 我們瞄的是第一條 body 列的下緣，所以它必須是 '0'。少了這條
    // 斷言，泡泡瞄在別條邊界上這一列照樣會綠。
    const bub = await ctx.page.evaluate(() => {
      const b = document.querySelector('.ed-tb-insert-row');
      return { hidden: b.hidden, after: b.dataset.afterRowIndex };
    });
    assert.strictEqual(bub.hidden, false,
      'C1 前提失敗：＋ 列泡泡沒升起來，got ' + JSON.stringify(bub));
    assert.strictEqual(bub.after, '0',
      'C1 前提失敗：＋ 列泡泡瞄的不是第一條 body 列的下緣，got ' + JSON.stringify(bub));
    // v3.3.0 F7 之前，這一發不能讓 pressClick 自己 move：指標一移到泡泡上，
    // 泡泡就把自己收掉，按壓就落不到它身上，所以當時走的是「原地按下去」
    // 的 pressAtPointer 路徑。F7 把可見性判斷修好之後，這裡走的就是使用者
    // 真的做的那件事 —— 讓 pressClick 自己把指標移上泡泡再按。把 F7 那個
    // 修正拿掉重跑，這一列會停在下面「插列沒發生（按到空氣）」那條前提上，
    // 所以它量的確實是那一段真實的移動。
    await pressClick(ctx.page, '.ed-tb-insert-row', 80);
    await new Promise((r) => setTimeout(r, 400));
    const ins = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      return { rows: tb.tBodies[0].rows.length,
               text: tb.textContent.replace(/\s+/g, ' ') };
    }, TSEL);
    // 前提二：列真的插進去了。少了它，一個「按到空氣」的手勢會讓下面那條
    // 斷言原封不動地綠 —— 字當然還在，因為根本沒有結構變動去吃掉它。
    assert.strictEqual(ins.rows, 3,
      'C1 前提失敗：插列沒發生（按到空氣），got ' + JSON.stringify(ins));
    assert.ok(ins.text.indexOf('TYPED') !== -1,
      'C1 前提失敗：插列之後打的字就已經不見了，got ' + JSON.stringify(ins));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 300));
    const undone = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      return { rows: tb.tBodies[0].rows.length,
               text: tb.textContent.replace(/\s+/g, ' ') };
    }, TSEL);
    assert.ok(undone.text.indexOf('TYPED') !== -1,
      'C1：undo 只該退掉插進去的那一列，不該退掉打進儲存格的字，got: ' +
      JSON.stringify(undone));
    assert.strictEqual(undone.rows, 2,
      'C1：那一次 undo 必須真的把插進去的列退掉，got ' + JSON.stringify(undone));
    assert.strictEqual(ctx.errs.length, 0,
      'C1：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: undo of a table row insert keeps what you typed in a cell — OK');
  }

  // ── 地基 B / I2: 原生 Ctrl+B 後【400ms 內】繼續打字，undo 不得連粗體一起退 ──
  //
  // 上面那四列（套標記 → 停 250ms → Ctrl+Z）釘不住 `snap('native-format')`，
  // 而理由【不是】那個停頓清掉了什麼：`noteTyping()` 尾端無條件
  // `isPendingSnap = true`，全 `lib/editor/history.js` 只有 `snap()`／
  // `start()`／`dispose()` 會把它指回 false，沒有 timer 會清它。把
  // `createBurstHistory` 包起來實測（`nopost` build、停 250ms 之後）：
  // `undo()` 那一發是 `size 2->2` —— 沒掉，也就是 undo 自己的 `flushTyping()`
  // 推了一筆又 pop 掉一筆，pending capture 一直都在。
  //
  // 真正的理由是：指令之後【沒有再打字】時，被沖出來的那份 capture 跟
  // post-snap 會推的那一筆【完全相同】，所以 undo 兩邊都退到同一格。
  // 會紅的是這個手勢 —— Ctrl+B 之後【不停】繼續打字，被沖出來的那份變成
  // 「粗體 + XY」，pop 之後就少退一格，粗體跟著被帶走。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const SEL = '.ed-block[data-block-id="1"] .ed-wys-armed';
    await ctx.page.click(SEL);
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.type(' typed sentence');
    await new Promise((r) => setTimeout(r, 500));
    await ctx.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const t = el.firstChild;
      const i = el.textContent.indexOf('typed');
      const r = document.createRange();
      r.setStart(t, i); r.setEnd(t, i + 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    }, SEL);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyB');
    await ctx.page.keyboard.up('Control');
    // 這裡【刻意沒有 sleep】：整列的重點就是下一個按鍵落在 noteTyping() 的
    // 400ms 窗口【裡面】。
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.type('XY');
    const gapMs = Date.now() - t0;
    // 前提：那段間隔真的在窗口內。在慢到 ≥400ms 的機器上這一列會【修前也綠】，
    // 偵測力歸零 —— 這條斷言把那個情境變成一次響亮的失敗。
    assert.ok(gapMs < 400,
      'I2 前提失敗：Ctrl+B 到最後一個按鍵之間量到 ' + gapMs + 'ms，已經超過 ' +
      'noteTyping() 的 400ms 門檻，這一列在未修版本上也會綠，偵測力是 0');
    const after = await ctx.page.evaluate((sel) =>
      document.querySelector(sel).innerHTML, SEL);
    assert.ok(/<b>typed<\/b>/.test(after) && after.indexOf('XY') !== -1,
      'I2 前提失敗：粗體或後續打字沒生效，got ' + JSON.stringify(after));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 250));
    const undone = await ctx.page.evaluate((sel) =>
      document.querySelector(sel).innerHTML, SEL);
    assert.ok(/<b>typed<\/b>/.test(undone),
      'I2：undo 只該退掉 Ctrl+B 之後打的字，粗體必須留著，got: ' +
      JSON.stringify(undone));
    // 上面那條【單獨】會被一次什麼都沒做的 Ctrl+Z 滿足 —— `after` 本來就
    // 已經含著 <b>typed</b>。這條才是這一列真正的內容：Ctrl+B 之後打的
    // 'XY' 必須被退掉。
    assert.strictEqual(undone.indexOf('XY'), -1,
      'I2：那一次 Ctrl+Z 必須真的退掉 Ctrl+B 之後打的字，got: ' +
      JSON.stringify(undone));
    assert.strictEqual(ctx.errs.length, 0,
      'I2：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: undo after Ctrl+B + more typing keeps the bold — OK');
  }

  // ── N4: 巢狀清單的尾隨空白不得讓上一項的內容被覆蓋 ────────────────────
  //
  // marked 把巢狀 list token 的 `raw` 最後一行的尾隨空白剝掉，外層 `item.text`
  // 卻留著，所以 blockmap.js 的 indexOf 找不到 → 整串後代的行號【上移一行】→
  // 送出時 bystanderCarryOver() 拿 `lines.slice()` 重播的是【上一項】。
  // 磁碟實測（修前）：
  //   '- alpha\n  - beta\n  - \n'   --Enter-->  '- alpha\n  - alpha\n-\n'
  //   '- alpha\n  - beta\n  - x \n' --Enter-->  '- alpha\n  - alpha\n  - x\n  -\n'
  //   '- alpha\n  - beta\n  - \n'   --Tab-->    '- alpha\n  - alpha\n    - beta\n'
  // 三發都把 beta 換成了 alpha。斷言看的就是磁碟：beta 必須還在，alpha 不得變兩份。
  for (const [md, gesture, label] of [
    ['# H\n\n- alpha\n  - beta\n  - \n- gamma\n', 'Enter', '空項 + Enter'],
    ['# H\n\n- alpha\n  - beta\n  - x \n- gamma\n', 'Enter', '非空項 + Enter'],
    ['# H\n\n- alpha\n  - beta\n  - \n- gamma\n', 'Tab',   '空項 + Tab'],
  ]) {
    const ctx = await newPage(md);
    const before = fs.readFileSync(ctx.mdPath, 'utf8');
    // 前提：3 號真的是那個【最後一個巢狀項】。少了它，fixture 一漂移這一列就
    // 變成在點 beta，三條斷言會原封不動地綠 —— 偵測力歸零。
    const clicked = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="3"]');
      if (!el) return null;
      return { indent: el.getAttribute('data-indent'),
               type: el.getAttribute('data-block-type'),
               text: (el.querySelector(':scope > .ed-li-text') || {}).textContent };
    });
    assert.deepStrictEqual(clicked,
      { indent: '1', type: 'li', text: md.indexOf('- x ') !== -1 ? 'x' : '' },
      label + ' 前提失敗：3 號不是那個尾隨空白的巢狀項，got ' + JSON.stringify(clicked));
    await ctx.page.click('.ed-block[data-block-id="3"] .ed-li-text');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.page.keyboard.press(gesture);
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.split('\n').filter((l) => l.indexOf('beta') !== -1).length, 1,
      label + '：beta 不得消失，before=' + JSON.stringify(before) + ' after=' + JSON.stringify(disk));
    assert.strictEqual(disk.split('\n').filter((l) => l.trim() === '- alpha').length, 1,
      label + '：alpha 不得被複製，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0,
      label + '：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a trailing space in a nested list no longer eats the item above — OK');

  // ── N4: a document that is ALREADY degraded when it opens ─────────────────
  //
  // blockmap.js empties the whole subtree and flags it `unlocatable` when it
  // cannot locate an item's nested list. Nothing in the corpus reaches that
  // branch — no markdown found so far makes the search fail — so the path had
  // no end-to-end exercise at all, and the refusal wording it routes to had
  // never been RENDERED by anything.
  //
  // This row renders it. `lib/editor/blockmap.js` looks `marked.lexer` up at
  // call time and the harness runs the editor server IN THIS PROCESS, so
  // wrapping the lexer for the duration of the row makes the server serve a
  // genuinely degraded document — the open-time case, which is the one a
  // /api/render-only signal would miss. The wrapper prefixes every nested list
  // token's `raw` with text that appears nowhere in the parent's `item.text`,
  // which is exactly the condition the widened search cannot recover from; the
  // production code is untouched.
  //
  // Restore matters more here than in test/blockmap.test.js: `npm test` forks a
  // process per file, but every row in THIS file shares one process, so a leaked
  // wrapper would degrade every nested list served after it. Hence the
  // `finally`, and hence the two checks after it — one on buildBlockMap
  // directly, one on a freshly served page.
  {
    const { marked } = require('marked');
    const { buildBlockMap } = require('../lib/editor/blockmap.js');
    const realLexer = marked.lexer;
    const MD = '# H\n\n- alpha\n  - beta\n    - deep\n- gamma\n';
    try {
      marked.lexer = function () {
        const toks = realLexer.apply(this, arguments);
        // Degrade THIS row's document and nothing else. Buys one thing: a row
        // added later inside this block — between the wrapper and its
        // `finally` — runs against a NORMAL editor instead of a silently
        // degraded one. Does NOT buy a loud failure: such a row would still
        // pass with the wrapper installed, it just would not be measuring what
        // it thought. `marked.lexer(src)` takes the markdown as its first
        // argument, and this fixture reaches it unchanged: md2doc.js's only
        // transform between the file's bytes and the lex is the '[[...]]'
        // citation rewrite that builds `mdPre`, and this string has no
        // '[[...]]'. That is not left as reasoning either — if the guard
        // rejected the fixture, the `served` precondition below would fail,
        // because the served payload would then carry no degraded block.
        if (arguments[0] !== MD) return toks;
        const walk = (lt) => {
          for (const it of lt.items || []) {
            for (const tk of it.tokens || []) {
              if (tk.type === 'list') { tk.raw = ' UNFINDABLE\n' + tk.raw; walk(tk); }
            }
          }
        };
        for (const t of toks) if (t.type === 'list') walk(t);
        return toks;
      };
      const ctx = await newPage(MD);
      // 前提：伺服器真的送出了降級的文件。少了它，wrapper 沒生效時下面每一條
      // 斷言都會用一份正常文件去測，然後安靜地綠。
      const served = await ctx.page.evaluate(() => window.__ED__.blocks);
      assert.deepStrictEqual(
        served.filter((b) => b.unlocatable === true).map((b) => b.indent), [0, 1, 2],
        'N4 open-time 前提失敗：GET /edit/:id 的 payload 沒有帶降級的整棵子樹，got ' +
        JSON.stringify(served));
      const target = await ctx.page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.ed-block[data-block-type="li"]'))
          .find((x) => {
            const r = window.__ED__.blocks.find((q) => q.id === Number(x.getAttribute('data-block-id')));
            return r && r.unlocatable === true;
          });
        return b ? '.ed-block[data-block-id="' + b.getAttribute('data-block-id') + '"]' : null;
      });
      assert.ok(target, 'N4 open-time 前提失敗：畫面上找不到那個降級的 li');
      await ctx.page.click(target + ' > .ed-li-text');
      await new Promise((r) => setTimeout(r, 400));
      const banner = await ctx.page.evaluate(() => {
        const d = document.querySelector('.ed-conflict');
        return d ? d.textContent.trim() : null;
      });
      // 這是本列的內容：降級子樹拿到的是【它自己那句】，不是同行巢狀那句。
      assert.strictEqual(banner, '這段巢狀清單對不到自己的來源行，無法刪除或直接編輯' + '✕',
        'N4：點進一個降級的清單項，必須出現降級專用的那句話 —— 不是 ' +
        '「此項目沒有自己的來源行…」（那句屬於 - - a 那種同行巢狀，它真的沒有來源行），' +
        'got ' + JSON.stringify(banner));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('textarea.ed-raw').length), 0,
        'N4：降級的區塊不得開出 raw textarea —— 反轉範圍會讓 commit 變成插入');
      assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), MD,
        'N4：被拒絕的手勢必須讓檔案逐位元組不變');
      // 血濺範圍：降級停在子樹，兄弟項照常可編輯。
      await ctx.page.evaluate(() => {
        const d = document.querySelector('.ed-conflict button');
        if (d) d.click();
      });
      await new Promise((r) => setTimeout(r, 200));
      const gsel = await ctx.page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.ed-block[data-block-type="li"]'))
          .find((x) => (x.textContent || '').indexOf('gamma') !== -1);
        return '.ed-block[data-block-id="' + b.getAttribute('data-block-id') + '"]';
      });
      await ctx.page.click(gsel + ' > .ed-li-text');
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(
        await ctx.page.evaluate((sel) => !!document.querySelector(sel + ' .ed-wys-armed'), gsel),
        true, 'N4：- gamma 沒有 unlocatable 的子項，必須照常可編輯');
      assert.strictEqual(
        await ctx.page.evaluate(() => !!document.querySelector('.ed-conflict')), false,
        'N4：點 - gamma 不該出現任何拒絕橫幅');
      assert.strictEqual(ctx.errs.length, 0,
        'N4 open-time：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    } finally {
      marked.lexer = realLexer;
    }
    // 還原檢查一：直接問 buildBlockMap。
    const sane = buildBlockMap('- a\n  - b\n- c\n').blocks;
    assert.strictEqual(sane.filter((b) => b.unlocatable).length, 0,
      'N4：lexer wrapper 必須還原 —— 洩漏的話這個檔案後面每一列的巢狀清單都會被降級，got ' +
      JSON.stringify(sane));
    // 還原檢查二：真的再送一份文件出去。單元層綠而伺服器仍然壞掉是可能的
    // （例如 wrapper 被別的模組實例接住），所以兩層都要問。
    const fresh = await newPage('# H\n\n- one\n  - two\n- three\n');
    assert.deepStrictEqual(
      await fresh.page.evaluate(() =>
        window.__ED__.blocks.filter((b) => b.type === 'li').map((b) => [b.startLine, b.endLine])),
      [[3, 3], [4, 4], [5, 5]],
      'N4：還原之後伺服器必須再度送出正常的行範圍');
    await fresh.page.close(); fresh.srv.close();
  }
  console.log('journey: a document that opens already degraded refuses with its own wording — OK');

  // ── F9: 點 code block 開 raw 編輯器，caret 必須落在圍欄【裡面】 ──────────
  //
  // 缺陷：openRawEditor() 收尾一律把 caret 放到值的結尾。對 fenced code 那個
  // 位置在【收尾 fence 之後】，所以使用者點進去打的第一個字直接落在收尾那一
  // 行上，圍欄不再閉合、文件後半被吞進 code block —— 那正是下面 F10 那一列
  // 要偵測的形狀，F9 是它的上游。
  //
  // T5-1：不能只斷言「caret 不在結尾」。差一個字元的 caret 仍然在收尾 fence
  // 那一行上，一樣壞。所以這裡釘死【確切】的落點，再真的打一個字進去、把
  // 「打的字進了程式碼本文、沒進圍欄」一路證到磁碟上 ——「caret 有比較好一
  // 點」不是這個修法的承諾，「你打的字進得去程式碼」才是。
  {
    const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\nBravo.\n';
    const ctx = await newPage(MD);
    // 前提：點下去的真的是一個佔 5..7 行的 code block。fixture 一漂移（圍欄
    // 被解析成段落、行號位移）這一列就變成在測段落的 caret 契約，而段落的
    // 落點本來就是值的結尾 —— 下面每一條斷言都會原封不動地綠。
    assert.deepStrictEqual(
      await ctx.page.evaluate(() =>
        window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
      ['heading[1,1]', 'paragraph[3,3]', 'code[5,7]', 'paragraph[9,9]'],
      'F9 前提失敗：fixture 沒有給出一個佔 5..7 行的 code block');
    await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
    await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
      { timeout: 5000 });
    const sel = await ctx.page.evaluate(() => {
      const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
      return { start: ta.selectionStart, end: ta.selectionEnd, len: ta.value.length, v: ta.value };
    });
    assert.strictEqual(sel.v, '```js\nconst a = 1;\n```',
      'F9 前提失敗：textarea 的種子不是那三行原始碼，got ' + JSON.stringify(sel.v));
    // 內容區的開頭 ＝ 開頭 fence 那一行的下一行行首 ＝ '```js\n'.length。
    assert.deepStrictEqual({ start: sel.start, end: sel.end }, { start: 6, end: 6 },
      'F9：caret 必須【正好】落在開頭 fence 的下一行行首（offset 6），不是值的' +
      '結尾（' + sel.len + '），也不是任何「靠近結尾但還在收尾 fence 那一行上」' +
      '的位置，got ' + JSON.stringify(sel));
    await ctx.page.keyboard.type('Z');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 600));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, '# Doc\n\nAlpha.\n\n```js\nZconst a = 1;\n```\n\nBravo.\n',
      'F9：打進去的那個字必須落在程式碼本文，兩道圍欄與後面的段落都要逐位元組' +
      '存活，got:\n' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'F9：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the raw editor opens INSIDE the fence, never past the closing one — OK');
  }

  // ── F10: 一次編輯吞掉文件後半時，必須給使用者可見的信號 ─────────────────
  //
  // T5-2：「畫面上有一條 .ed-conflict」不算通過。lib/editor/client.js 裡那個
  // class 有好幾個互不相干的來源（磁碟衝突、render 失敗、save 失敗、手勢失去
  // 目標、清單／表格的結構性拒絕、burst 降級成原始碼編輯、工具列插圖的失敗），
  // 所以這
  // 一列釘死那句【吞噬專用】的話，並且先跑一個控制組：同一份 fixture、同一個
  // raw 編輯器、同一個提交手勢，只是這次的編輯沒有吞掉任何東西 —— 控制組要求
  // 畫面上一條 banner 都不能有，這才證明信號是被【吞噬】點起來的，不是被
  // 「提交發生了」點起來的。
  {
    const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\n## Next\n\nBravo.\n';
    // 控制組：改動 code block 的【本文】，圍欄不動。
    {
      const ctx = await newPage(MD);
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 5,
        'F10 控制組前提失敗：fixture 應該渲染出五個區塊');
      await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
      await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
        { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
        ta.value = ta.value.replace('const a = 1;', 'const a = 2;');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 700));
      // 前提：這次提交真的落地了。少了它，一個什麼都沒提交的控制組會用
      // 「沒有 banner」原封不動地綠。
      const cDisk = await saveAndRead(ctx);
      assert.strictEqual(cDisk, '# Doc\n\nAlpha.\n\n```js\nconst a = 2;\n```\n\n## Next\n\nBravo.\n',
        'F10 控制組前提失敗：這次編輯必須真的提交到磁碟，got:\n' + JSON.stringify(cDisk));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 5,
        'F10 控制組前提失敗：沒有吞噬的編輯不得改變區塊數');
      assert.strictEqual(
        await visibleBannerText(ctx.page), null,
        'F10 控制組：沒有吞掉任何東西的編輯不得升起任何 banner —— 升起來就代表' +
        '這條信號是被「提交發生了」點起來的，對吞噬沒有偵測力');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制組：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // 吞噬組：把收尾 fence 改成 ``` MID，圍欄不再閉合。
    {
      const ctx = await newPage(MD);
      await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
      await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
        { timeout: 5000 });
      const seeded = await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
        ta.value = ta.value.replace(/```$/m, '``` MID');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return ta.value;
      });
      assert.strictEqual(seeded, '```js\nconst a = 1;\n``` MID',
        'F10 前提失敗：破壞收尾 fence 的那個 replace 沒有打中，got ' + JSON.stringify(seeded));
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 700));
      // 前提：吞噬真的發生了。行數沒少而區塊少了 —— 這一列如果哪天 fixture
      // 漂移到不再吞噬，這條會先紅，而不是讓 banner 斷言變成無主張。
      const after = await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length);
      assert.strictEqual(after, 3,
        'F10 前提失敗：未閉合的圍欄應該把 ## Next / Bravo. 吞進 code block，' +
        '區塊數應從 5 掉到 3，got ' + after);
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk.split('\n').length, MD.split('\n').length,
        'F10 前提失敗：這一列的形狀是「區塊少了、行數沒少」，行數變了就不是它，got:\n' +
        JSON.stringify(disk));
      const banner = await visibleBannerText(ctx.page);
      // showBanner() 的節點是「訊息 span ＋ 關閉鈕（✕）」，所以 textContent 帶尾巴。
      assert.strictEqual(banner, SWALLOW_MSG + '✕',
        'F10：吞噬必須升起【吞噬那一句】。任何其他 .ed-conflict（磁碟衝突／' +
        'render 失敗／save 失敗／手勢失去目標／結構性拒絕／降級成原始碼編輯／' +
        '插圖失敗）' +
        '都不算數，got ' + JSON.stringify(banner));
      assert.strictEqual(ctx.errs.length, 0, 'F10：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: an edit that swallows the tail raises its own visible signal — OK');
  }

  // ── F9 fix round 1 (J2): 空的圍欄，以及「以收尾圍欄結尾但不是以開頭圍欄起頭」
  //     的跨區塊 span —— 這些形狀在第一版底下仍然會把圍欄打壞 ───────────────
  //
  // 空圍欄（```js 緊接著 ```）的本文區【一行都沒有】，所以原始碼裡不存在任何
  // 安全的 offset：落在結尾會踩到收尾圍欄，落在「開頭圍欄的下一行行首」踩到的
  // 是同一行。裁定是給它一行本文，rawEditorSeed() 因此是這一族唯一會改動
  // textarea 種子的分支 —— 而那一行不得讓文件變髒、不得寫進磁碟，下面第二段
  // 就是在守這件事。
  {
    const MD = '# Doc\n\nAlpha.\n\n```js\n```\n\nBravo.\n';
    const ctx = await newPage(MD);
    assert.deepStrictEqual(
      await ctx.page.evaluate(() =>
        window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
      ['heading[1,1]', 'paragraph[3,3]', 'code[5,6]', 'paragraph[8,8]'],
      'F9b 前提失敗：fixture 沒有給出一個佔 5..6 行的【空】code block');
    await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
    await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
      { timeout: 5000 });
    const sel = await ctx.page.evaluate(() => {
      const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
      return { v: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });
    assert.deepStrictEqual(sel, { v: '```js\n\n```', start: 6, end: 6 },
      'F9b：空圍欄必須被種進一行本文，caret 落在那一行 —— 原始碼裡沒有其他安全' +
      '的落點（兩端都在圍欄標記上），got ' + JSON.stringify(sel));
    await ctx.page.keyboard.type('Z');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 600));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, '# Doc\n\nAlpha.\n\n```js\nZ\n```\n\nBravo.\n',
      'F9b：打進去的字必須落在程式碼本文，兩道圍欄與後面的段落逐位元組存活，got:\n' +
      JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'F9b：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 種進去那一行的代價：開起來看一眼就關掉，不得變髒、不得寫檔。這裡測的是
  // Escape 與「點到別的區塊」（不是所有的關法）
  // —— Escape 走 cancelAndMaybeDiscard()，點到別的區塊走 switchAwayFrom() 的
  // hasChanges() 判斷，而 hasChanges() 正是這個修法動到的東西。
  for (const [how, close] of [
    ['Escape', async (ctx) => { await ctx.page.keyboard.press('Escape'); }],
    ['點到別的區塊', async (ctx) => {
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
    }],
  ]) {
    const MD = '# Doc\n\nAlpha.\n\n```js\n```\n\nBravo.\n';
    const ctx = await newPage(MD);
    const title0 = await ctx.page.evaluate(() => document.title);
    assert.strictEqual(title0.indexOf('●'), -1,
      'F9c 前提失敗：剛開檔就已經是髒的，title=' + JSON.stringify(title0));
    await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
    await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
      { timeout: 5000 });
    await close(ctx);
    await new Promise((r) => setTimeout(r, 700));
    const title1 = await ctx.page.evaluate(() => document.title);
    assert.strictEqual(title1, title0,
      'F9c（' + how + '）：只是開起來看一眼，種進去那一行不得讓文件變髒，got ' +
      JSON.stringify(title1));
    assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), MD,
      'F9c（' + how + '）：關掉之前磁碟必須逐位元組不變');
    assert.strictEqual(await saveAndRead(ctx), MD,
      'F9c（' + how + '）：按下 Ctrl+S 之後磁碟仍必須逐位元組不變 —— 種進去那一行' +
      '寫到檔案裡比它要修的缺陷更糟');
    assert.strictEqual(ctx.errs.length, 0, 'F9c：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 另一種形狀：⠿ 的「MD 原始碼」框出一段【跨區塊】的 span，它以一道光禿禿的
  // 收尾圍欄結尾、但不是以開頭圍欄起頭。結尾落點會落在那道收尾圍欄上。
  {
    const MD = '# Doc\n\nAlpha.\n\n```js\ncode\n```\n\nTail.\n';
    const ctx = await newPage(MD);
    await ctx.page.keyboard.down('Shift');
    await ctx.page.click('.ed-block[data-block-id="1"]');
    await ctx.page.click('.ed-block[data-block-id="2"]');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(
      await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
      'F9d 前提失敗：Shift+Click 沒有立出兩個區塊的選取');
    await ctx.page.hover('.ed-block[data-block-id="1"]');
    await new Promise((r) => setTimeout(r, 150));
    await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
    await ctx.page.evaluate(() => {
      const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((e) => e.textContent.trim() === 'MD 原始碼');
      if (!it) throw new Error('F9d 前提失敗：⠿ 選單裡沒有 MD 原始碼');
      it.setAttribute('data-journey-target', '1');
    });
    await pressClick(ctx.page, '[data-journey-target="1"]', 0);
    await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
    const sel = await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      return { v: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });
    assert.strictEqual(sel.v, 'Alpha.\n\n```js\ncode\n```',
      'F9d 前提失敗：span 不是「段落 ＋ 圍欄」那兩個區塊，got ' + JSON.stringify(sel.v));
    // 'Alpha.\n\n```js\ncode' 的長度 —— 收尾圍欄那一行【之前】那一行的行尾。
    assert.deepStrictEqual({ start: sel.start, end: sel.end }, { start: 18, end: 18 },
      'F9d：以收尾圍欄結尾的 span，caret 不得落在那一行上，got ' + JSON.stringify(sel));
    await ctx.page.keyboard.type('Z');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 700));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, '# Doc\n\nAlpha.\n\n```js\ncodeZ\n```\n\nTail.\n',
      'F9d：打進去的字必須落在程式碼本文，收尾圍欄逐位元組存活，got:\n' +
      JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0, 'F9d：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: every fenced shape the raw editor opens on keeps its fences — OK');

  // ── F10 fix round 1 (J1): 這條信號不得在普通編輯上亂叫，而且必須能退場 ────
  //
  // 出貨的第一版判別式是純計數（Δblocks < 0 且 Δlines >= 0）。拿 40c9569 的
  // client 跑同一批（CLIENT_OVERRIDE）量到：S1、S2、R1 在它上面會叫，而磁碟位
  // 元組完全正確；S3、C3、C10 在它上面【本來就是靜默的】—— 它們守的不是那一
  // 版，而是每一版都不准叫 —— 拿 40c9569／588ae30／fd2913f／f10792e 的 client
  // 逐一跑過，S3、C3、C10 在它們上面都是靜默的。下面每一列都是控制列（斷言
  // banner 不出現），
  // 差別只在它們各自能抓到哪一版的退步。
  //
  // 誤報住在全文原始碼（M↓／`[data-ed-tb="preview"]`）
  // 與逐區塊的 raw 編輯器（⠿ →「MD 原始碼」）。
  {
    const enterSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
    };
    const leaveSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
    };
    const openRawViaGutter = async (ctx, sel) => {
      await ctx.page.hover(sel);
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, sel + ' .ed-handle', 80);
      await ctx.page.waitForSelector(sel + ' .ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 5000 });
    };
    const DOC = '# Doc\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
    // S1 / S2 / C5：全文原始碼裡把某些行的【字】清掉，行本身留著。
    for (const [label, from, expected] of [
      ['S1 中間那一段', 'Bravo.', '# Doc\n\nAlpha.\n\n\n\nCharlie.\n'],
      ['S2 最後那一段', 'Charlie.', '# Doc\n\nAlpha.\n\nBravo.\n\n\n'],
    ]) {
      const ctx = await newPage(DOC);
      await enterSource(ctx);
      await ctx.page.evaluate((f) => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace(f, '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, from);
      await leaveSource(ctx);
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, expected,
        'F10 控制列 ' + label + ' 前提失敗：這次編輯必須真的落到磁碟上（區塊少了' +
        '一個、行數沒少），got:\n' + JSON.stringify(disk));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 控制列 ' + label + '：把一行的字清掉、行留著，什麼都沒有被吞噬 —— ' +
        '不得升起任何 banner。純計數的判別式在這裡會叫。');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制列 ' + label + '：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // S3：全文原始碼裡把兩段之間的空行填掉 —— 兩段併成一段。
    {
      const ctx = await newPage(DOC);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('Alpha.\n\nBravo.', 'Alpha.\nBravo.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, '# Doc\n\nAlpha.\nBravo.\n\nCharlie.\n',
        'F10 控制列 S3 前提失敗：兩段必須真的併起來，got:\n' + JSON.stringify(disk));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 控制列 S3：把兩段併成一段是使用者自己要的，不得升起任何 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制列 S3：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // R1：逐區塊的 raw 編輯器裡把一段清成空字串。
    //
    // ⚠ 這一列的提交必須是【真的按壓】（`pressClick`）。MEASURED（在
    // applyRenderResult() 裡插一個計數器，同一個手勢跑兩次）：
    //   pressClick 提交   renders=1
    //   合成 el.click()   renders=0
    // 也就是說改成合成 click 之後，在斷言執行的那個時間點【一次 render 都還
    // 沒發生過】，「banner 不出現」會因為根本沒有東西可以升 banner 而成立 ——
    // 這一列會安靜地變成一條沒有主張的斷言（磁碟仍然是對的，因為後面
    // saveAndRead() 的 Ctrl+S 才把 blur → commit → render 這一串帶起來）。
    {
      const ctx = await newPage(DOC);
      await openRawViaGutter(ctx, '.ed-block[data-block-id="1"]');
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-block[data-block-id="1"] textarea.ed-raw');
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 900));
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, '# Doc\n\n\n\nBravo.\n\nCharlie.\n',
        'F10 控制列 R1 前提失敗：那一段必須真的被清空（區塊少了一個、行數沒少），' +
        'got:\n' + JSON.stringify(disk));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 控制列 R1：把一段清空是普通編輯，不得升起任何 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制列 R1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // C3：在最後一個區塊【之後】打進一道還沒閉合的圍欄 —— 形狀成立，但它後面
    // 沒有東西可以吃。這一列守的是判別式的另一半（效果）。
    {
      const ctx = await newPage(DOC);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value + '```\n';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, '# Doc\n\nAlpha.\n\nBravo.\n\nCharlie.\n```\n',
        'F10 控制列 C3 前提失敗：那道圍欄必須真的寫進去，got:\n' + JSON.stringify(disk));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 控制列 C3：文件確實以一道沒閉合的圍欄收尾，但它後面沒有東西被吃掉 —— ' +
        '對它喊吞噬是說謊');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制列 C3：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // C10：一份【開檔時就已經沒閉合】的文件，之後做一次不相干的刪除。
    {
      const ctx = await newPage('# Doc\n\nAlpha.\n\nBravo.\n\n```js\ncode\n');
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('Bravo.\n\n', '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, '# Doc\n\nAlpha.\n\n```js\ncode\n',
        'F10 控制列 C10 前提失敗：那一段必須真的被刪掉，got:\n' + JSON.stringify(disk));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 控制列 C10：這份文件【一開檔】就沒閉合，這次手勢沒有把任何東西吞進去 —— ' +
        '不得因為區塊變少就誣賴它');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 控制列 C10：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: the swallow signal stays silent on ordinary edits — OK');
  }

  // ── F10 fix round 1 (J1 的後半): banner 必須能退場 ─────────────────────
  //
  // 它不是 refusal banner，dismissRefusalBanner() 碰不到它。退場的條件是【圍欄
  // 補回去了】，不是「後來有一次成功的編輯」—— 圍欄還開著的時候後面的內容就
  // 還被吃著，那時候把警告收掉才是說謊。三段都驅動：升起 → 還開著時做別的
  // 編輯（留著）→ 補回收尾圍欄（退場），外加使用者自己按 ✕。
  {
    const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\n## Next\n\nBravo.\n';
    const CODE = '.ed-block[data-block-type="code"]';
    // banner 是 position: fixed; top: 0（lib/md2doc.js 的 `.ed-conflict` 規則），
    // 升起來之後蓋住頁面頂端。MEASURED（800×600，在 pressClick() 會按的那個點
    // ——「矩形 ∩ 視窗」的中心 (792.1, 22) —— 上呼叫 document.elementFromPoint）：
    //   banner 升起前   ed-toolbar-btn
    //   banner 升起後   ed-conflict（矩形 800×69.5）
    // 也就是說這條 banner 在的時候，工具列那一排真人按不到。這一段測的是
    // banner 的生命週期而不是按壓機制，所以開編輯器走合成 click（委派的 click
    // 處理器對 clientX/clientY 為 0 的合成事件的處理見 client.js 那段註解）、
    // 提交走鍵盤 Ctrl+Enter，兩者都不經過那個被蓋住的點。
    const openCode = async (ctx) => {
      await ctx.page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) throw new Error('找不到 code block');
        el.click();
      }, CODE);
      await ctx.page.waitForSelector(CODE + ' textarea.ed-raw', { timeout: 5000 });
    };
    const commitCode = async (ctx, value) => {
      await ctx.page.evaluate((s, v) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = v;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      }, CODE, value);
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 900));
    };
    {
      const ctx = await newPage(MD);
      await openCode(ctx);
      await commitCode(ctx, '```js\nconst a = 1;\n``` MID');
      assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
        'F10 退場 前提失敗：吞噬必須先升起那句話');
      // 還開著的時候做一次別的編輯：警告必須留著。
      await openCode(ctx);
      await commitCode(ctx, '```js\nconst a = 2;\n``` MID\n\n## Next\n\nBravo.');
      assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
        'F10 退場：圍欄還開著的時候，一次成功的編輯【不得】把警告收掉 —— ' +
        '後面的內容還被吃著');
      // 補回收尾圍欄：警告必須退場。
      await openCode(ctx);
      await commitCode(ctx, '```js\nconst a = 2;\n```');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 退場：圍欄補回去之後警告必須自己消失，got ' +
        JSON.stringify(await visibleBannerText(ctx.page)));
      const disk = await saveAndRead(ctx);
      assert.strictEqual(disk, '# Doc\n\nAlpha.\n\n```js\nconst a = 2;\n```\n',
        'F10 退場：收尾之後的磁碟內容，got:\n' + JSON.stringify(disk));
      assert.strictEqual(ctx.errs.length, 0,
        'F10 退場：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const ctx = await newPage(MD);
      await openCode(ctx);
      await commitCode(ctx, '```js\nconst a = 1;\n``` MID');
      assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
        'F10 ✕ 前提失敗：吞噬必須先升起那句話');
      await ctx.page.evaluate(() => {
        const b = document.querySelector('.ed-conflict button[aria-label="Dismiss"]');
        if (!b) throw new Error('F10 ✕ 前提失敗：banner 上沒有 ✕');
        b.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'F10 ✕：使用者按 ✕ 必須收掉這條 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'F10 ✕：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: the swallow signal retires when the fence is closed again — OK');
  }

  // ── F9 fix round 2 (K1): 巢狀圍欄不得被誤判成空圍欄 ──────────────────────
  //
  // 空圍欄那個分支會【改動 textarea 的種子】，所以它的判斷不能只看「下一行長得
  // 像圍欄」：`~~~` 開頭、下一行是 ` ``` ` 的巢狀圍欄，那個 ` ``` ` 是【本文】，
  // 不是收尾。588ae30 把它當成空圍欄、種進一行空白，而那一行在提交時真的寫到
  // 磁碟（實測 `588ae30` 的種子是 '~~~\n\n```\nx\n```\n~~~'、磁碟拿到
  // '~~~\nZ\n```\n…'）。收尾圍欄必須跟開頭圍欄同字元、不比它短 —— 見
  // closesFence()。
  {
    const MD = '# Doc\n\nAlpha.\n\n~~~\n```\nx\n```\n~~~\n\nBravo.\n';
    const ctx = await newPage(MD);
    assert.deepStrictEqual(
      await ctx.page.evaluate(() =>
        window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
      ['heading[1,1]', 'paragraph[3,3]', 'code[5,9]', 'paragraph[11,11]'],
      'K1 前提失敗：fixture 沒有給出一個佔 5..9 行的巢狀圍欄');
    await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
    await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
      { timeout: 5000 });
    const sel = await ctx.page.evaluate(() => {
      const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
      return { v: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });
    assert.strictEqual(sel.v, '~~~\n```\nx\n```\n~~~',
      'K1：巢狀圍欄不是空圍欄，textarea 的種子必須跟原始碼逐位元組相同 —— ' +
      '種進去的那一行會寫到使用者的檔案裡，got ' + JSON.stringify(sel.v));
    assert.deepStrictEqual({ start: sel.start, end: sel.end }, { start: 4, end: 4 },
      'K1：caret 落在開頭圍欄的下一行行首，也就是本文的第一行，got ' + JSON.stringify(sel));
    await ctx.page.keyboard.type('Z');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n~~~\nZ```\nx\n```\n~~~\n\nBravo.\n',
      'K1：磁碟上不得多出任何一行 —— 588ae30 在這裡會多一行空白');
    assert.strictEqual(ctx.errs.length, 0, 'K1：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a nested fence is not an empty fence, and nothing is injected — OK');

  // ── F10 fix round 2 (K2): 使用者自己把尾巴刪掉，不是被吞噬 ───────────────
  //
  // 第二版的判別式是「形狀 ∧ 區塊少了」。往檔尾 trim 也滿足它：區塊 4~5 掉到
  // 3、文件也真的以沒閉合的圍欄收尾 —— 但圍欄後面本來就沒東西了，是使用者自己
  // 刪的。那時候那句話的每一個子句都是假的。判別式的效果那一半因此換成【歸屬】：
  // 新的尾端圍欄本文裡，有沒有哪一行本來活在 code block 外面、現在不在外面了。
  //
  // 下面每一列都先用磁碟位元組證明那次編輯真的落地，再斷言 banner 不出現。
  // 拿 588ae30 的 client 跑同一批（CLIENT_OVERRIDE）：X4／P1／P7 在它上面是紅的
  // （banner=YES），P2 在它上面就已經是綠的 —— P2 守的是「刪掉收尾圍欄，而它
  // 後面本來就沒東西」這個更窄的形狀，兩版都靜默，它在這裡是防迴歸而不是紅轉綠。
  {
    const FDOC = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\n## Next\n\nBravo.\n';
    const CODE = '.ed-block[data-block-type="code"]';
    const enterSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
    };
    const leaveSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
    };
    // X4 / P1 / P2：全文原始碼裡往檔尾 trim。
    // X4：從收尾圍欄一路刪到檔尾。
    {
      const ctx = await newPage(FDOC);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.slice(0, ta.value.indexOf('```\n\n## Next'));
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n',
        'K2 控制列 X4 前提失敗：這次刪除必須真的落到磁碟上');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'K2 控制列 X4：圍欄後面本來就沒東西了，是使用者自己刪的 —— ' +
        '「後面的內容全部被吃進去」與「補回收尾圍欄就會復原」兩句都是假的，不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'K2 控制列 X4：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // P1：從 code 本文中間一路刪到檔尾。
    {
      const ctx = await newPage(FDOC);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.slice(0, ta.value.indexOf('const a = 1;')) + 'const a';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n```js\nconst a',
        'K2 控制列 P1 前提失敗：這次刪除必須真的落到磁碟上');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'K2 控制列 P1：圍欄後面本來就沒東西了，是使用者自己刪的 —— ' +
        '「後面的內容全部被吃進去」與「補回收尾圍欄就會復原」兩句都是假的，不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'K2 控制列 P1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // P2：刪掉收尾圍欄，而它後面本來就沒有東西。
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n';
      const ctx = await newPage(MD);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace(/```\n$/, '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n',
        'K2 控制列 P2 前提失敗：收尾圍欄必須真的被刪掉');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'K2 控制列 P2：收尾圍欄後面本來就沒東西，不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0,
        'K2 控制列 P2：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // P7：⠿ 跨區塊 span，把「圍欄 ＋ 它後面的東西」整段換成只剩開頭圍欄與本文。
    {
      const ctx = await newPage(FDOC);
      await ctx.page.keyboard.down('Shift');
      await ctx.page.click(CODE);
      await ctx.page.click('.ed-block[data-block-id="4"]');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 3,
        'K2 控制列 P7 前提失敗：Shift+Click 沒有框出「圍欄到最後一段」那個 span');
      await ctx.page.hover(CODE);
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, CODE + ' .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('K2 控制列 P7 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        ta.value = '```js\nconst a = 1;';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      });
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n',
        'K2 控制列 P7 前提失敗：那個 span 必須真的被換掉');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'K2 控制列 P7：使用者把圍欄後面的東西連同收尾一起換掉了，沒有東西被吃進去');
      assert.strictEqual(ctx.errs.length, 0,
        'K2 控制列 P7：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: trimming your own tail through the closing fence raises nothing — OK');

    // ── 反面：歸屬測試不得把真吞噬也一起變安靜 ────────────────────────────
    // TP3 是最常見的那一種（只刪掉收尾圍欄那一行），TP5 是 588ae30 漏掉的那一格
    // （新圍欄正好吃掉一個區塊，區塊數因此不減）。
    const SW = SWALLOW_MSG + '✕';
    {
      const ctx = await newPage(FDOC);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('```\n\n## Next', '## Next');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n## Next\n\nBravo.\n',
        'TP3 前提失敗：只刪掉收尾圍欄那一行');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'TP3：只刪掉收尾圍欄那一行是最常見的真吞噬 —— ## Next 與 Bravo. 被吃進去了');
      assert.strictEqual(ctx.errs.length, 0, 'TP3：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const ctx = await newPage('# Doc\n\nAlpha.\n\nBravo.\n\nCharlie.\n');
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('Charlie.', '```\nCharlie.');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\nBravo.\n\n```\nCharlie.\n',
        'TP5 前提失敗：那道圍欄必須真的插進去');
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 4,
        'TP5 前提失敗：這一格的重點正是【區塊數不變】（吃掉一個、生出一個），' +
        '所以任何靠計數的判別式在這裡都是瞎的');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'TP5：Charlie. 被吃進新的圍欄裡了，即使區塊數沒變也必須說');
      assert.strictEqual(ctx.errs.length, 0, 'TP5：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: a real swallow still speaks, even when the block count does not move — OK');

    // ── F10 fix round 2 (K3): 收尾圍欄必須跟開頭圍欄配對 ──────────────────
    //
    // FENCE_BARE_RE 舊版不看字元也不看長度，下面每一個後果都驅動過：
    //  FN1 —— 一份以光禿禿 '~~~' 結尾的文件裡，把 ``` 的收尾打壞（真吞噬）會被
    //         當成「圍欄有收好」而【靜默】。
    //  G7  —— 一份【開檔時就沒閉合】的文件（```js 開頭、尾巴那行 '~~~' 其實是
    //         本文）在開檔時被誤判成「收好了」，於是之後一個無辜的手勢會被誣賴
    //         成吞噬 —— 繞過了 C10 那一列。
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\n## Next\n\n~~~\ntilde\n~~~\n';
      const ctx = await newPage(MD);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('```\n\n## Next', '``` MID\n\n## Next');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n``` MID\n\n## Next\n\n~~~\ntilde\n~~~\n',
        'FN1 前提失敗：收尾圍欄必須真的被打壞');
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 3,
        'FN1 前提失敗：吞噬必須真的發生（5 個區塊掉到 3 個）');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'FN1：文件尾端那行光禿禿的 ~~~ 收不掉一道 ``` 圍欄 —— 不得因此把真吞噬吞掉');
      assert.strictEqual(ctx.errs.length, 0, 'FN1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const MD = '# Doc\n\nAlpha.\n\nBravo.\n\n```js\ncode\n~~~\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,3]', 'paragraph[5,5]', 'code[7,9]'],
        'G7 前提失敗：fixture 的那道 ```js 圍欄必須是【沒閉合】的，尾巴那行 ~~~ 是本文');
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        // 把 Bravo. 搬到圍欄後面：它從 code block 外面跑進了裡面，所以【歸屬】
        // 那一項會說「被吃掉了」。讓這一列靜默的是「這道圍欄不是這次編輯打
        // 開的」，而那個判斷在開檔時就要靠 closesFence() 認出尾巴那行光禿禿的
        // ~~~ 收不掉一道 ``` 圍欄。單獨拿掉「上一次 render 之後不是這個形狀」
        // 那一項，這一列就叫；單獨拿掉 closesFence() 的字元檢查【不會】讓它叫
        // （那一項是別的列在守），所以這裡不寫成「少了任一半都會叫」。
        ta.value = ta.value.replace('Bravo.\n\n', '').replace('~~~\n', '~~~\nBravo.\n');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\ncode\n~~~\nBravo.\n',
        'G7 前提失敗：Bravo. 必須真的被搬到圍欄後面（因此進了那個 code block）');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'G7：這份文件【一開檔】就沒閉合，那道圍欄不是這次編輯打開的 —— 不得誣賴' +
        '它吞噬。把開檔時那行光禿禿的 ~~~ 當成收尾（588ae30 就是）會讓這一列叫。');
      assert.strictEqual(ctx.errs.length, 0, 'G7：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: a closing fence has to match the one it closes — OK');
  }

  // ── F10: 判別式的每一個合取項各自被一列釘住 ────────────────────────────
  //
  // 上面那些控制列釘的是 `nowUnclosed`（S1／S2／R1 那族）與歸屬那一項（K2 的
  // X4／P1／P2／P7）。下面補上剩下的那些：
  //  * 「上一次 render 之後不是這個形狀」—— 少了它，一份【一開檔就沒閉合】的
  //    文件會在使用者把一段搬到圍欄後面時被喊吞噬。那次搬移是使用者自己做的，
  //    而且那道圍欄不是這次編輯打開的，所以「補回收尾圍欄就會復原」講不通。
  //  * 歸屬測試的後半「這一行【現在】已經不在 code block 外面了」—— 少了它，
  //    使用者把最後一段換成一道沒閉合的圍欄、而圍欄本文剛好跟文件別處某一段
  //    一字不差時，那一段明明還好端端在外面，卻會被算成被吃掉。
  {
    const openRawViaGutter = async (ctx, sel) => {
      await ctx.page.hover(sel);
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, sel + ' .ed-handle', 80);
      await ctx.page.waitForSelector(sel + ' .ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector(sel + ' textarea.ed-raw', { timeout: 5000 });
    };
    // PIN-len：收尾圍欄不得比開頭短。'````' 開頭、下一行是 '```'（短一個）——
    // 那是【本文】不是收尾。少了長度那條，空圍欄的判斷會誤判、種一行空白進使用者
    // 的檔案（跟 K1 同一個壞法，只是換成長度差而不是字元差）。
    {
      const MD = '# Doc\n\nAlpha.\n\n````\n```\nx\n```\n````\n\nBravo.\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,3]', 'code[5,9]', 'paragraph[11,11]'],
        'PIN-len 前提失敗：fixture 沒有給出一個 ```` 開頭、內含 ``` 的 code block');
      await pressClick(ctx.page, '.ed-block[data-block-type="code"]', 80);
      await ctx.page.waitForSelector('.ed-block[data-block-type="code"] textarea.ed-raw',
        { timeout: 5000 });
      const sel = await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-block[data-block-type="code"] textarea.ed-raw');
        return { v: ta.value, start: ta.selectionStart };
      });
      assert.deepStrictEqual(sel, { v: '````\n```\nx\n```\n````', start: 5 },
        'PIN-len：種子必須跟原始碼逐位元組相同，caret 落在本文第一行，got ' +
        JSON.stringify(sel));
      await ctx.page.keyboard.type('Z');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 700));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n````\nZ```\nx\n```\n````\n\nBravo.\n',
        'PIN-len：磁碟上不得多出任何一行');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-len：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // PIN-indent：收尾圍欄縮排四格就不再是收尾（marked 的 ` {0,3}`）。使用者把它
    // 縮排四格＝把後面的東西吃進去，必須說。
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\ncode\n```\n\n## Next\n\nBravo.\n';
      const ctx = await newPage(MD);
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('```\n\n## Next', '    ```\n\n## Next');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\ncode\n    ```\n\n## Next\n\nBravo.\n',
        'PIN-indent 前提失敗：收尾圍欄必須真的被縮排四格');
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 3,
        'PIN-indent 前提失敗：吞噬必須真的發生');
      assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
        'PIN-indent：縮排四格的 ``` 不是收尾圍欄，這是真吞噬');
      assert.strictEqual(ctx.errs.length, 0,
        'PIN-indent：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // PIN-run：marked 讓收尾那一串後面再跟任意個 ` 或 ~，所以 '```~~' 收得掉一道
    // ``` 圍欄。不認這一條的話，⠿ span 的 caret 會落在那一行的行尾，打一個字就把
    // 它變成 '```~~Z'（不再是收尾），後面的 Tail. 被吃進去。
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\ncode\n```~~\n\nTail.\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,3]', 'code[5,7]', 'paragraph[9,9]'],
        'PIN-run 前提失敗：marked 必須認 ```~~ 是那道圍欄的收尾');
      await ctx.page.keyboard.down('Shift');
      await ctx.page.click('.ed-block[data-block-id="1"]');
      await ctx.page.click('.ed-block[data-block-id="2"]');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
        'PIN-run 前提失敗：Shift+Click 沒有框出「段落 ＋ 圍欄」那個 span');
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('PIN-run 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      const sel = await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        return { v: ta.value, start: ta.selectionStart };
      });
      assert.deepStrictEqual(sel, { v: 'Alpha.\n\n```js\ncode\n```~~', start: 18 },
        'PIN-run：caret 必須落在程式碼本文行尾，不是那道 ```~~ 收尾上，got ' +
        JSON.stringify(sel));
      await ctx.page.keyboard.type('Z');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\ncodeZ\n```~~\n\nTail.\n',
        'PIN-run：收尾與 Tail. 都要逐位元組存活');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-run：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // PIN-tail：空圍欄長在跨區塊 span 的【尾端】時也要種一行本文。少了它，caret
    // 落在開頭圍欄那一行的行尾，使用者打的第一個字進了 info string 而不是程式碼。
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\n```\n\nTail.\n';
      const ctx = await newPage(MD);
      await ctx.page.keyboard.down('Shift');
      await ctx.page.click('.ed-block[data-block-id="1"]');
      await ctx.page.click('.ed-block[data-block-id="2"]');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
        'PIN-tail 前提失敗：Shift+Click 沒有框出「段落 ＋ 空圍欄」那個 span');
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('PIN-tail 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      const sel = await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        return { v: ta.value, start: ta.selectionStart };
      });
      assert.deepStrictEqual(sel, { v: 'Alpha.\n\n```js\n\n```', start: 14 },
        'PIN-tail：span 尾端的空圍欄也要被種進一行本文，caret 落在那一行，got ' +
        JSON.stringify(sel));
      await ctx.page.keyboard.type('Z');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\n```js\nZ\n```\n\nTail.\n',
        'PIN-tail：打的字必須進程式碼本文，不是 info string');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-tail：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // PIN-shape：最後一個區塊【不是】一道沒閉合的圍欄，但歸屬那一項自己會說
    // 「外面的份數少了」。文件裡 'Alpha.' 有兩份（一份單獨成段、一份是最後那段
    // 的第二行），使用者把第一份 ⠿ 轉換成 › 程式碼 —— 它跑進圍欄裡，外面的份數
    // 2→1。那是使用者自己要的轉換，不是吞噬；擋下它的正是「文件現在以一道沒閉合
    // 的圍欄收尾」這一項。
    {
      const MD = '# Doc\n\nAlpha.\n\nBravo.\nAlpha.\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,3]', 'paragraph[5,6]'],
        'PIN-shape 前提失敗：最後那一段必須是兩行，第二行跟上面那一段一字不差');
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.indexOf('轉換成') !== -1);
        if (!it) throw new Error('PIN-shape 前提失敗：⠿ 選單裡沒有 轉換成');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await new Promise((r) => setTimeout(r, 400));
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === '程式碼');
        if (!it) throw new Error('PIN-shape 前提失敗：轉換成的子選單裡沒有 程式碼');
        it.click();
      });
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\n```\nAlpha.\n```\n\nBravo.\nAlpha.\n',
        'PIN-shape 前提失敗：第一份 Alpha. 必須真的被包進圍欄裡');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'PIN-shape：使用者自己按了「轉換成 › 程式碼」，外面的份數當然少一份 —— ' +
        '文件並沒有以一道沒閉合的圍欄收尾，不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-shape：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const MD = '# Doc\n\nAlpha.\n\n```js\ncode\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,3]', 'code[5,6]'],
        'PIN-prev 前提失敗：fixture 必須是一份【開檔時就沒閉合】的文件');
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('Alpha.\n\n', '').replace('code\n', 'code\nAlpha.\n');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\n```js\ncode\nAlpha.\n',
        'PIN-prev 前提失敗：Alpha. 必須真的被搬到圍欄後面（因此進了 code block）');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'PIN-prev：這道圍欄不是這次編輯打開的（文件一開檔就沒閉合），使用者是自己' +
        '把那一段搬進去的 —— 不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-prev：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const MD = '# Doc\n\nAlpha.\n\nBravo.\n\nCharlie.\n';
      const ctx = await newPage(MD);
      await openRawViaGutter(ctx, '.ed-block[data-block-id="3"]');
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-block[data-block-id="3"] textarea.ed-raw');
        ta.value = '```\nAlpha.';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nAlpha.\n\nBravo.\n\n```\nAlpha.\n',
        'PIN-now 前提失敗：最後一段必須真的變成一道沒閉合的圍欄，本文是 Alpha.');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'PIN-now：圍欄本文那行 Alpha. 跟上面那一段一字不差，但上面那一段還好端端' +
        '在 code block 外面 —— 沒有東西被吃掉，不得升起 banner');
      assert.strictEqual(ctx.errs.length, 0, 'PIN-now：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: each half of the swallow discriminant has a row that pins it — OK');
  }

  // ── F10 fix round 3 (L1): 歸屬要算【數量】，問「有沒有」正反都會說謊 ──────
  //
  // 上一版問的是「這一行以前在 code block 外面，而現在不在外面了」。那個問法：
  //  * 往檔尾 trim 時，只要圍欄本文有一行【也】出現在被刪掉的尾巴裡就會叫 ——
  //    散文重複了它自己用圍欄展示的那道指令，是這個形狀最普通的樣子。
  //  * 真吞噬時，只要被吃掉的每一行文件別處都還有一份，就完全不叫。
  //  * 被吃掉的是縮排式 code block 時也不叫（上一版把它算成「本來就在 code 裡」）。
  //
  // 改成算數量之後每一種都對了。下面把它們逐一釘住：誤報那些當控制列（不得出現
  // banner），漏報那些反過來（必須出現）。漏報那些在 588ae30 上是會叫的 —— 它
  // 們是上一版
  // （fd2913f）自己引進的迴歸。
  {
    const NL = '\n';
    const SW = SWALLOW_MSG + '✕';
    const CODE = '.ed-block[data-block-type="code"]';
    const enterSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
    };
    const leaveSource = async (ctx) => {
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
    };
    const rawEditCode = async (ctx, mutate) => {
      await pressClick(ctx.page, CODE, 80);
      await ctx.page.waitForSelector(CODE + ' textarea.ed-raw', { timeout: 5000 });
      await ctx.page.evaluate((s, body) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        // eslint-disable-next-line no-new-func
        ta.value = new Function('v', 'return (' + body + ')(v);')(ta.value);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, CODE, mutate.toString());
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 900));
    };
    // 這一份 fixture 的重點：'npm test' 在圍欄【本文裡】與圍欄【後面】各有一份。
    const DUP = '# Doc' + NL + NL + 'Run this:' + NL + NL + '```sh' + NL + 'npm test' + NL +
                '```' + NL + NL + 'npm test' + NL;
    // FP2：全文原始碼裡從收尾圍欄一路刪到檔尾。
    {
      const ctx = await newPage(DUP);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.slice(0, ta.value.indexOf('```\n\nnpm test'));
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nRun this:\n\n```sh\nnpm test\n',
        'L1 控制列 FP2 前提失敗：尾巴必須真的被刪掉');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'L1 控制列 FP2：使用者刪掉了自己的尾巴，圍欄後面沒有東西被吃進去 —— ' +
        '圍欄本文那行 npm test 剛好也出現在被刪掉的尾巴裡，不得因此誤判');
      assert.strictEqual(ctx.errs.length, 0,
        'L1 控制列 FP2：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FP1：⠿ 跨區塊 span，把「圍欄 ＋ 它後面那一段」整段換成只剩開頭圍欄與本文。
    {
      const ctx = await newPage(DUP);
      await ctx.page.keyboard.down('Shift');
      await ctx.page.click(CODE);
      await ctx.page.click('.ed-block[data-block-id="3"]');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
        'L1 控制列 FP1 前提失敗：Shift+Click 沒有框出「圍欄 ＋ 它後面那一段」');
      await ctx.page.hover(CODE);
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, CODE + ' .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('L1 控制列 FP1 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        ta.value = '```sh\nnpm test';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      });
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\nRun this:\n\n```sh\nnpm test\n',
        'L1 控制列 FP1 前提失敗：那個 span 必須真的被換掉');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'L1 控制列 FP1：同一個形狀走 ⠿ 的路 —— 一樣沒有東西被吃進去');
      assert.strictEqual(ctx.errs.length, 0,
        'L1 控制列 FP1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FN-A：真吞噬，但被吃掉的那一行上面還有一份。
    {
      const MD = '# Doc' + NL + NL + 'Alpha.' + NL + NL + '```js' + NL + 'x' + NL + '```' + NL +
                 NL + 'Alpha.' + NL;
      const ctx = await newPage(MD);
      await rawEditCode(ctx, (v) => v.replace(/```$/m, '``` MID'));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nAlpha.\n\n```js\nx\n``` MID\n\nAlpha.\n',
        'L1 FN-A 前提失敗：收尾圍欄必須真的被打壞');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'L1 FN-A：下面那個 Alpha. 真的被吃進去了 —— 上面還留著一份不代表沒被吃掉');
      assert.strictEqual(ctx.errs.length, 0, 'L1 FN-A：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FN-E：被吃掉的【每一行】上面都還有一份 —— 上一版整個吞噬都消音。
    {
      const MD = '# Doc' + NL + NL + '- item' + NL + NL + 'Note.' + NL + NL + '```js' + NL +
                 'x' + NL + '```' + NL + NL + '- item' + NL + NL + 'Note.' + NL;
      const ctx = await newPage(MD);
      await enterSource(ctx);
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('```\n\n- item', '``` MID\n\n- item');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await leaveSource(ctx);
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\n- item\n\nNote.\n\n```js\nx\n``` MID\n\n- item\n\nNote.\n',
        'L1 FN-E 前提失敗：收尾圍欄必須真的被打壞');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'L1 FN-E：被吃掉的每一行上面都還有一份，份數卻少了 —— 必須說');
      assert.strictEqual(ctx.errs.length, 0, 'L1 FN-E：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FN-C：被吃掉的是一個【縮排式】code block。
    {
      const MD = '# Doc' + NL + NL + '```js' + NL + 'x' + NL + '```' + NL + NL + '    indented' + NL;
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'code[3,5]', 'code[7,7]'],
        'L1 FN-C 前提失敗：fixture 必須是「圍欄 ＋ 縮排式 code block」兩個 code 區塊');
      await rawEditCode(ctx, (v) => v.replace(/```$/m, '``` MID'));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\n```js\nx\n``` MID\n\n    indented\n',
        'L1 FN-C 前提失敗：收尾圍欄必須真的被打壞');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'L1 FN-C：縮排式 code block 是文件裡看得見的內容，被圍欄吃掉一樣是吞噬 —— ' +
        '不得因為它的 type 也是 code 就算成「本來就在 code 裡」');
      assert.strictEqual(ctx.errs.length, 0, 'L1 FN-C：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: absorption is counted, not merely detected — OK');
  }

  // ── F10 fix round 3 (L2): 收尾圍欄的規則以 marked 為準 ────────────────────
  //
  // `j.blocks` 就是 marked 的 tokenizer 產出的，所以 closesFence() 只要跟它講的
  // 不一樣，判別式就會拿一份跟畫面上不同的文件在推理。MEASURED（把候選行放進
  // '```\nx\n<候選>\nAFTER\n'，看 buildBlockMap 有沒有把 AFTER 留在外面）：收尾行
  // 後面跟一個 tab 時 marked 說【沒收】。上一版的 `[ \t]*` 說收了 —— 那正是 K3
  // 的 FN1 形狀，只是換一個字元。
  {
    const TAB = String.fromCharCode(9);
    const MD = '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```\n\n## Next\n\nBravo.\n';
    const ctx = await newPage(MD);
    await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
    await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
    await ctx.page.evaluate((tab) => {
      const ta = document.querySelector('.ed-source');
      ta.value = ta.value.replace('```\n\n## Next', '```' + tab + '\n\n## Next');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, TAB);
    await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
    await new Promise((r) => setTimeout(r, 900));
    assert.strictEqual(await saveAndRead(ctx),
      '# Doc\n\nAlpha.\n\n```js\nconst a = 1;\n```' + TAB + '\n\n## Next\n\nBravo.\n',
      'L2 前提失敗：收尾圍欄後面必須真的多了一個 tab');
    assert.strictEqual(
      await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 3,
      'L2 前提失敗：marked 不認這個收尾，吞噬必須真的發生（5 個區塊掉到 3 個）');
    assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
      'L2：收尾圍欄後面跟一個 tab 時 marked 說沒收 —— 我們必須跟它一致，否則真吞噬靜默');
    assert.strictEqual(ctx.errs.length, 0, 'L2：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the closing-fence rule follows marked, tab and all — OK');
  }

  // ── F9 fix round 3 (L3): 反引號圍欄的 info string 不得含反引號 ────────────
  //
  // 這條規則之前沒有任何一列釘住。它會壞在哪裡：'``` a`b' 這一行 marked 當它是
  // 【段落】（反引號圍欄的 info string 不能含反引號），下一行才是真正的開頭圍欄。
  // 少了這條規則，rawEditorSeed() 會把段落那一行當成開頭圍欄、跟後面那道真的收尾
  // 圍欄配成一對，caret 因此落在【真開頭圍欄】那一行的行首 —— 打一個字就把
  // '```js' 變成 'Z```js'，開頭圍欄消失，收尾那道 ``` 反而變成開頭，後面的 Tail.
  // 被吃進去（實測 ablation 之後 blocks 從
  // heading paragraph code[4,6] paragraph 變成 heading paragraph[3,5] code[6,8]）。
  {
    const MD = '# Doc\n\n``` a`b\n```js\ncode\n```\n\nTail.\n';
    const ctx = await newPage(MD);
    assert.deepStrictEqual(
      await ctx.page.evaluate(() =>
        window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
      ['heading[1,1]', 'paragraph[3,3]', 'code[4,6]', 'paragraph[8,8]'],
      'L3 前提失敗：marked 必須把 ``` a`b 當段落、把下一行當開頭圍欄');
    await ctx.page.keyboard.down('Shift');
    await ctx.page.click('.ed-block[data-block-id="1"]');
    await ctx.page.click('.ed-block[data-block-id="2"]');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(
      await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
      'L3 前提失敗：Shift+Click 沒有框出「段落 ＋ 圍欄」那個 span');
    await ctx.page.hover('.ed-block[data-block-id="1"]');
    await new Promise((r) => setTimeout(r, 150));
    await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
    await ctx.page.evaluate(() => {
      const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((e) => e.textContent.trim() === 'MD 原始碼');
      if (!it) throw new Error('L3 前提失敗：⠿ 選單裡沒有 MD 原始碼');
      it.setAttribute('data-journey-target', '1');
    });
    await pressClick(ctx.page, '[data-journey-target="1"]', 0);
    await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
    const sel = await ctx.page.evaluate(() => {
      const ta = document.querySelector('textarea.ed-raw');
      return { v: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });
    assert.strictEqual(sel.v, '``` a`b\n```js\ncode\n```',
      'L3 前提失敗：span 不是那兩個區塊，got ' + JSON.stringify(sel.v));
    // '``` a`b\n```js\ncode' 的長度 —— 程式碼本文那一行的行尾。
    assert.deepStrictEqual({ start: sel.start, end: sel.end }, { start: 18, end: 18 },
      'L3：caret 必須落在程式碼本文的行尾，不是真開頭圍欄那一行的行首，got ' +
      JSON.stringify(sel));
    await ctx.page.keyboard.type('Z');
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('Enter');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 700));
    assert.strictEqual(await saveAndRead(ctx), '# Doc\n\n``` a`b\n```js\ncodeZ\n```\n\nTail.\n',
      'L3：兩道圍欄與 Tail. 都要逐位元組存活');
    assert.strictEqual(ctx.errs.length, 0, 'L3：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: a backtick in the info string is not a fence opener — OK');
  }

  // ── F10 fix round 4 (M1): 歸屬要【逐行】判，不是把前後半各自加總再比 ──────
  //
  // 上一版把 wasOut／nowOut 與 prevTotal／nowTotal 各自在尾端圍欄本文的所有行上
  // 加總，再比一次。加總會讓不同行互相抵銷，不論哪個方向都出事：
  //  * 真吞噬靜默：code block 裡有一行重複（`}` 是日常樣子），使用者一次編輯刪掉
  //    其中一份【並且】刪掉收尾圍欄。被吃掉的 Bravo. 那一行自己前後半都成立，卻被
  //    那個消失的 `}` 拉低了總數而被抵銷掉。
  //  * 誤報回來：往檔尾 trim 的同一次編輯裡把本文某一行複製一份 —— 被 trim 掉的
  //    那一行滿足前半、複製出來的那一行撐起後半，湊出一個沒有任何一行自己成立的
  //    「真」。那正是 K2 那族誤報。
  //
  // 改成逐行、命中就 return true：一行要自己同時滿足前半與後半才算數。
  {
    const NL = '\n';
    const SW = SWALLOW_MSG + '✕';
    const CODE = '.ed-block[data-block-type="code"]';
    // '}' 在 code block 裡重複出現；使用者刪掉後面那一份與收尾圍欄。
    const DUPBRACE = '# Doc' + NL + NL + '```js' + NL + 'if (a) {' + NL + '}' + NL +
                     'if (b) {' + NL + '}' + NL + '```' + NL + NL + 'Bravo.' + NL;
    const EATEN = '# Doc\n\n```js\nif (a) {\n}\nif (b) {\n\nBravo.\n';
    // FN-agg：全文原始碼。
    {
      const ctx = await newPage(DUPBRACE);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'code[3,8]', 'paragraph[10,10]'],
        'FN-agg 前提失敗：fixture 沒有給出「重複 } 的 code block ＋ 後面一段」');
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('}\n```\n', '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), EATEN,
        'FN-agg 前提失敗：那一份 } 與收尾圍欄必須真的被刪掉');
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 2,
        'FN-agg 前提失敗：Bravo. 必須真的被吃進 code block');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'FN-agg：Bravo. 被吃掉了。它自己在圍欄外面的份數 1→0、整份文件的份數沒少，' +
        '兩半都成立 —— 不得因為同一次編輯讓另一行的 } 少了一份就把它抵銷掉');
      assert.strictEqual(ctx.errs.length, 0, 'FN-agg：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FN-agg2：同一次編輯走逐區塊的 raw 編輯器。
    {
      const ctx = await newPage(DUPBRACE);
      await pressClick(ctx.page, CODE, 80);
      await ctx.page.waitForSelector(CODE + ' textarea.ed-raw', { timeout: 5000 });
      await ctx.page.evaluate((s) => {
        const ta = document.querySelector(s + ' textarea.ed-raw');
        ta.value = '```js\nif (a) {\n}\nif (b) {';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }, CODE);
      await pressClick(ctx.page, '.ed-block[data-block-id="0"] .ed-wys-armed', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx), EATEN,
        'FN-agg2 前提失敗：raw 編輯器那次提交必須落到磁碟上');
      assert.strictEqual(await visibleBannerText(ctx.page), SW,
        'FN-agg2：同一個吞噬走 ⠿／點擊那條路一樣要說');
      assert.strictEqual(ctx.errs.length, 0, 'FN-agg2：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // FP-agg：往檔尾 trim，同一次編輯把本文某一行複製一份。
    {
      const MD = '# Doc' + NL + NL + 'Run this:' + NL + NL + '```sh' + NL + 'setup' + NL +
                 'npm test' + NL + '```' + NL + NL + 'npm test' + NL;
      const ctx = await newPage(MD);
      await ctx.page.keyboard.down('Shift');
      await ctx.page.click(CODE);
      await ctx.page.click('.ed-block[data-block-id="3"]');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-selected').length), 2,
        'FP-agg 前提失敗：Shift+Click 沒有框出「圍欄 ＋ 它後面那一段」');
      await ctx.page.hover(CODE);
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, CODE + ' .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('FP-agg 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        ta.value = '```sh\nsetup\nsetup\nnpm test';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
      });
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\nRun this:\n\n```sh\nsetup\nsetup\nnpm test\n',
        'FP-agg 前提失敗：那個 span 必須真的被換掉');
      assert.strictEqual(await visibleBannerText(ctx.page), null,
        'FP-agg：圍欄後面什麼都沒有了，是使用者自己 trim 掉的 —— 被 trim 掉的 ' +
        'npm test 滿足前半、被複製的 setup 撐起後半，那是兩行湊出來的「真」，' +
        '沒有任何一行自己成立');
      assert.strictEqual(ctx.errs.length, 0, 'FP-agg：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: absorption is judged per line, not by two sums that cancel — OK');
  }

  // ── F9／F10 fix round 5 (N4): fenceOpenerOf() 剩下的規則也各有一列 ─────────
  //
  // 「最多三個前導空格」與「至少三個圍欄字元」原本沒有任何一列釘住 —— 單獨把
  // 它們 ablate 掉，整份案例照樣全綠。下面補上。
  {
    // 縮排四格的 ```sh 對 marked 而言是【縮排式】code block，不是圍欄。少了前導
    // 空格上限那一條，它會被當成 fenced —— 於是它那些行在上一份 render 裡就被算
    // 成「已經在圍欄裡」，被真的圍欄吃進去時判別式就看不見。
    {
      const MD = '# Doc\n\n```js\nx\n```\n\n    ```sh\n    echo\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'code[3,5]', 'code[7,8]'],
        'PIN-o-indent 前提失敗：fixture 必須是「圍欄 ＋ 縮排式 code block」');
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await ctx.page.waitForSelector('.ed-source', { timeout: 6000 });
      await ctx.page.evaluate(() => {
        const ta = document.querySelector('.ed-source');
        ta.value = ta.value.replace('```\n\n    ```sh', '``` MID\n\n    ```sh');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await pressClick(ctx.page, '[data-ed-tb="preview"]', 80);
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await saveAndRead(ctx),
        '# Doc\n\n```js\nx\n``` MID\n\n    ```sh\n    echo\n',
        'PIN-o-indent 前提失敗：收尾圍欄必須真的被打壞');
      assert.strictEqual(
        await ctx.page.evaluate(() => document.querySelectorAll('.ed-block').length), 2,
        'PIN-o-indent 前提失敗：那個縮排式 code block 必須真的被吃進去');
      assert.strictEqual(await visibleBannerText(ctx.page), SWALLOW_MSG + '✕',
        'PIN-o-indent：縮排四格的 ```sh 不是圍欄，它那兩行本來活在圍欄外面');
      assert.strictEqual(ctx.errs.length, 0,
        'PIN-o-indent：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // 以【一個】波浪號開頭的段落不是開頭圍欄。少了「至少三個圍欄字元」那一條，
    // rawEditorSeed() 會把它當開頭圍欄，caret 落到下一行行首 —— 使用者打的字
    // 跑到別行去。
    {
      const MD = '# Doc\n\n~/bin/foo\nis the path\n\nTail.\n';
      const ctx = await newPage(MD);
      assert.deepStrictEqual(
        await ctx.page.evaluate(() =>
          window.__ED__.blocks.map((b) => b.type + '[' + b.startLine + ',' + b.endLine + ']')),
        ['heading[1,1]', 'paragraph[3,4]', 'paragraph[6,6]'],
        'PIN-o-len 前提失敗：那兩行必須是同一個段落，marked 不把 ~/bin/foo 當圍欄');
      await ctx.page.hover('.ed-block[data-block-id="1"]');
      await new Promise((r) => setTimeout(r, 150));
      await pressClick(ctx.page, '.ed-block[data-block-id="1"] .ed-handle', 80);
      await ctx.page.waitForSelector('.ed-handle-menu-btn', { timeout: 5000 });
      await ctx.page.evaluate(() => {
        const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .find((e) => e.textContent.trim() === 'MD 原始碼');
        if (!it) throw new Error('PIN-o-len 前提失敗：⠿ 選單裡沒有 MD 原始碼');
        it.setAttribute('data-journey-target', '1');
      });
      await pressClick(ctx.page, '[data-journey-target="1"]', 0);
      await ctx.page.waitForSelector('textarea.ed-raw', { timeout: 5000 });
      const sel = await ctx.page.evaluate(() => {
        const ta = document.querySelector('textarea.ed-raw');
        return { v: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
      });
      assert.deepStrictEqual(sel, { v: '~/bin/foo\nis the path', start: 21, end: 21 },
        'PIN-o-len：這不是圍欄，caret 維持結尾落點，got ' + JSON.stringify(sel));
      await ctx.page.keyboard.type('Z');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 800));
      assert.strictEqual(await saveAndRead(ctx), '# Doc\n\n~/bin/foo\nis the pathZ\n\nTail.\n',
        'PIN-o-len：打的字必須落在段落結尾，不是被搬到下一行行首');
      assert.strictEqual(ctx.errs.length, 0,
        'PIN-o-len：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: the fence-opener rules are pinned too — OK');
  }

  // ── N5: 打了字還沒離開 block 時，關掉分頁必須被攔 ──────────────────
  // burst 把使用者打的字留在 DOM 裡直到它自己收掉，而 `stack.isDirty()`
  // （lineops.js）問的是 undo stack 現在站的位置是不是上一次存檔寫出去的那個，
  // 要等 undo stack 被推入／彈出一個 op、或存檔重訂基準，它才會動 —— 打字當下
  // 這些都還沒發生，所以「打了字、還沒離開這個 block」在它眼中是乾淨的。
  // MEASURED at 2519204（這一列還沒進去的時候）：
  //   mid-burst   title "doc"    navBlocked false   page.url() "about:blank"
  //   blur 之後    title "● doc"  navBlocked true    page.url() 沒有變
  // 也就是說整條關分頁的路徑，對「還沒 blur 的那一筆」完全沒有網。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' unsaved');
    await new Promise((r) => setTimeout(r, 200));
    const title = await ctx.page.title();
    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    // 這一發導航可能跑得比 evaluate() 自己的回覆還快，把執行環境拆掉、讓這個
    // 呼叫 reject（"Execution context was destroyed"）。那是時序，不是產品狀態
    // —— 吞掉它，這一列的判決才會留在下面的斷言上，而不是變成看起來像 harness
    // 壞掉的錯誤。MEASURED at 2519204（沒有網的那一版）：這個呼叫是 resolve
    // 的，導航也真的走完了。所以它是被容忍，不是被依賴。
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(title.indexOf('●'), 0,
      'tab title 必須在 burst 開著時就顯示 ●，got ' + JSON.stringify(title));
    assert.strictEqual(navBlocked, true, '打了字還沒 blur 時，導航必須被攔');
    assert.strictEqual(ctx.errs.length, 0,
      'N5：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 控制組：只是把游標點進去、一個字都沒打。判別式裡「現在的面 !== 開 burst
  // 當下那一份」就是這一半在釘的。實測（把那一條拿掉、其餘不動）：● 這一半
  // 仍然是綠的 —— 光是點進去不會產生任何 mutation，標題沒有人去重畫 —— 紅的
  // 是下面那一條，因為 beforeunload 是【當下】現算的：使用者什麼都沒改，卻
  // 被一個關不掉的離站對話框擋住。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const title = await ctx.page.title();
    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(title.indexOf('●'), -1,
      'N5 控制組：什麼都沒打的時候不得出現 ●，got ' + JSON.stringify(title));
    assert.strictEqual(navBlocked, false, 'N5 控制組：什麼都沒改就不得攔導航');
    assert.strictEqual(ctx.errs.length, 0,
      'N5 控制組：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 表格 cell 也是同一個 burst 底座，而它走的是另一個開場函數 —— 少了那一邊
  // 的接線，在 cell 裡打字一樣不會亮 ●。
  {
    const ctx = await newPage('# Doc\n\n| A | B |\n| --- | --- |\n| one | two |\n');
    await ctx.page.click('.ed-block[data-block-type="table"] td');
    await ctx.page.keyboard.type('X');
    await new Promise((r) => setTimeout(r, 250));
    const title = await ctx.page.title();
    assert.strictEqual(title.indexOf('●'), 0,
      'N5 表格：在 cell 裡打字就必須亮 ●，got ' + JSON.stringify(title));
    assert.strictEqual(ctx.errs.length, 0,
      'N5 表格：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 反過來的一半：burst 自己被 Ctrl+Z 收回原狀（面被整段換掉，不是逐字改），
  // ● 必須跟著消失，離站警告也不能再擋。少了它，使用者撤銷完自己的輸入之後
  // 仍然會被一個沒有東西可救的對話框攔住。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type('ZZ');
    await new Promise((r) => setTimeout(r, 500));
    const titleTyped = await ctx.page.title();
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 500));
    const title = await ctx.page.title();
    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(titleTyped.indexOf('●'), 0,
      'N5 撤銷 前提失敗：撤銷之前必須真的是髒的，got ' + JSON.stringify(titleTyped));
    assert.strictEqual(title.indexOf('●'), -1,
      'N5 撤銷：撤回原狀之後 ● 必須消失，got ' + JSON.stringify(title));
    assert.strictEqual(navBlocked, false, 'N5 撤銷：撤回原狀之後不得再攔導航');
    assert.strictEqual(ctx.errs.length, 0,
      'N5 撤銷：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 存檔是這道網的出口：Ctrl+S 會先把 burst 收掉再寫檔（那段理由寫在
  // keydown 裡 Ctrl+S 那條分支上，不在 save() 自己頭上），所以打完字直接存
  // 的人，字要真的落到磁碟上，● 要熄掉，離站也不能再被擋。這一半同時釘住判別式最前面那個「currentBurst 還在不在」——
  // 少了它，save() 尾巴那一發 setDirty() 會在 burst 已經收掉之後去讀
  // null.editEl。實測（把那一條拿掉、其餘不動）：頁面丟出
  // `TypeError: Cannot read properties of null (reading 'editEl')`，堆疊是
  // burstHasUncommittedEdit ← setDirty ← save，而存完之後標題讀回來仍然是
  // "● doc"。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' typed');
    await new Promise((r) => setTimeout(r, 200));
    const disk = await saveAndRead(ctx);
    await new Promise((r) => setTimeout(r, 300));
    const title = await ctx.page.title();
    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(disk, '# Doc\n\nAlpha paragraph. typed\n',
      'N5 存檔 前提失敗：打的字必須真的落到磁碟上，got ' + JSON.stringify(disk));
    assert.strictEqual(title.indexOf('●'), -1,
      'N5 存檔：存完之後 ● 必須熄掉，got ' + JSON.stringify(title));
    assert.strictEqual(navBlocked, false, 'N5 存檔：存完之後不得再攔導航');
    assert.strictEqual(ctx.errs.length, 0,
      'N5 存檔：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // ── N5-undo: 撤銷到存檔點【之前】，再打一筆，不得讓文件回報成乾淨的 ────
  //
  // v3.4.0 batch3 Task 7 fix 2。這是一個【既有】缺陷，v3.3.0 就在線上，而且
  // 整條路徑跟波形編輯器一點關係都沒有 —— `_savedDepth` 是一個指向 undo stack
  // 的絕對索引，歷史一旦倒退到它前面再長出別的分支，深度算術就會從下面走回 0。
  // MEASURED（修之前）：打字、提交、Ctrl+S、Ctrl+Z、再打一筆普通的編輯 ——
  // `documentIsDirty()` 回 false、● 熄掉、存檔鈕變灰、beforeunload 不再攔，
  // 衝突 banner 的 Reload 會把「被撤銷掉的那次存檔」跟「新打的這一筆」一起丟掉。
  //
  // 這一列走的是離站對話框，跟 N5 家族其他列同一支觀測器。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' ONE');
    await new Promise((r) => setTimeout(r, 200));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk, '# Doc\n\nAlpha paragraph. ONE\n',
      'N5-undo 前提失敗：第一筆必須真的存進磁碟，got ' + JSON.stringify(disk));
    assert.strictEqual((await ctx.page.title()).indexOf('●'), -1,
      'N5-undo 前提失敗：存完之後 ● 要先熄掉');

    // 撤銷到存檔點之前。記憶體從此跟磁碟不一樣。
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 1200));
    const undone = await ctx.page.evaluate(() => ({
      title: document.title,
      text: document.querySelector('.content').textContent || '',
    }));
    assert.strictEqual(undone.text.indexOf('ONE'), -1,
      'N5-undo 前提失敗：Ctrl+Z 要真的退掉那一筆');
    assert.strictEqual(undone.title.indexOf('●'), 0,
      'N5-undo 前提失敗：退到存檔點之前就必須是髒的，got ' + JSON.stringify(undone.title));

    // 一筆普通的編輯 —— 修之前就是這一發把髒度從 -1 走回 0 的。
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.type(' TWO');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 1200));
    const after = await ctx.page.evaluate(() => ({
      title: document.title,
      text: document.querySelector('.content').textContent || '',
    }));
    assert.ok(after.text.indexOf('TWO') !== -1,
      'N5-undo 前提失敗：第二筆要真的在畫面上');
    assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), disk,
      'N5-undo 前提失敗：磁碟上還是第一筆那一份 —— 記憶體跟磁碟真的不一樣');
    assert.strictEqual(after.title.indexOf('●'), 0,
      'N5-undo：記憶體跟磁碟不一樣的時候 ● 不得熄掉，got ' + JSON.stringify(after.title));

    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(navBlocked, true,
      'N5-undo：離站必須被攔 —— 修之前這裡連一個對話框都不會跳，Reload 直接把' +
      '兩筆都丟掉');
    assert.strictEqual(ctx.errs.length, 0,
      'N5-undo：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: N5-undo an undo past a save point cannot make a later edit read clean — OK');
  }
  // ── N5-inflight: 存檔來回途中按 Ctrl+Z，回覆到達時不得把文件標成已存檔 ──
  //
  // v3.4.0 batch3 Task 7 fix 3。也是【既有】缺陷：`markSaved()` 以前是在 200
  // 到達那一刻才去讀 undo stack 的深度，而一次存檔來回是好幾百毫秒 —— 中間按
  // Ctrl+Z 是很平常的事。MEASURED（修之前）：回覆把「撤銷之後」的深度當成存檔
  // 點，三道網同時失效 —— ● 熄掉、beforeunload 不再攔、而且 `mtimeMs` 才剛被
  // 更新，所以連衝突檢查也不會擋。關掉分頁就把使用者親手撤銷掉的那筆編輯留在
  // 磁碟上。
  //
  // 窗口是用「延後 /api/save 的【回覆】」做出來的，不是靠時間賽跑：請求照常
  // 立刻送出（送出去的位元組因此是撤銷【之前】那一份，這正是本列的前提），
  // 只有 resolve 被押後。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.evaluate(() => {
      const orig = window.fetch;
      window.__heldSave = 0;
      window.fetch = function (input, init) {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (/\/api\/save\b/.test(url) && window.__heldSave === 0) {
          window.__heldSave = 1;
          // 送出是立刻的；只有回覆被押後。
          return orig.call(this, input, init).then((res) => new Promise((r) => {
            window.__heldSave = 2;
            setTimeout(() => r(res), 2500);
          }));
        }
        return orig.call(this, input, init);
      };
    });

    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' INFLIGHT');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyS');
    await ctx.page.keyboard.up('Control');
    // 等到請求真的送出去了（而回覆還被押著）再按 Ctrl+Z。
    //
    // 刻意【不】用 `waitForFunction`：這個檔案第一個 throw 就會終止整輪，而
    // TimeoutError 什麼都不會告訴你 —— 印出來的只有「Timeout 8000ms exceeded」，
    // 分不出是「Ctrl+S 沒送出去」「攔截沒裝上」還是「已經回來了」。輪詢之後把
    // 真正的值讀出來斷言，紅的時候就會直接說是哪一種。
    let held = 0;
    for (let i = 0; i < 80; i++) {
      held = await ctx.page.evaluate(() => window.__heldSave);
      if (held === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.strictEqual(held, 2,
      'N5-inflight 前提失敗：/api/save 的請求要真的送出去、而且回覆被押著。' +
      '0 = Ctrl+S 根本沒送出存檔請求，1 = 送出去了但 fetch 還沒 resolve。Got ' + held);
    const onDisk = fs.readFileSync(ctx.mdPath, 'utf8');
    assert.strictEqual(onDisk, '# Doc\n\nAlpha paragraph. INFLIGHT\n',
      'N5-inflight 前提失敗：送出去的那一份必須是撤銷【之前】的位元組，而且已經' +
      '落到磁碟上了，got ' + JSON.stringify(onDisk));

    await ctx.page.keyboard.down('Control');
    await ctx.page.keyboard.press('KeyZ');
    await ctx.page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 1000));
    const mid = await ctx.page.evaluate(() => ({
      text: document.querySelector('.content').textContent || '',
      held: window.__heldSave,
    }));
    assert.strictEqual(mid.text.indexOf('INFLIGHT'), -1,
      'N5-inflight 前提失敗：Ctrl+Z 要真的退掉那一筆');

    // 讓押著的 200 到達。
    await new Promise((r) => setTimeout(r, 3000));
    const after = await ctx.page.evaluate(() => ({
      title: document.title,
      text: document.querySelector('.content').textContent || '',
    }));
    assert.strictEqual(after.text.indexOf('INFLIGHT'), -1,
      'N5-inflight 前提失敗：回覆到達不得把文字變回來');
    assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), onDisk,
      'N5-inflight 前提失敗：磁碟上還是送出去的那一份 —— 記憶體跟磁碟真的不一樣');
    assert.strictEqual(after.title.indexOf('●'), 0,
      'N5-inflight：回覆到達時要標的是【送出去那一刻】的深度，不是回覆到達時的' +
      '深度 —— 磁碟上有一筆使用者已經撤銷掉的編輯，所以 ● 必須亮著，got ' +
      JSON.stringify(after.title));

    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(navBlocked, true,
      'N5-inflight：離站也必須被攔 —— 修之前這是本任務唯一一個三道網同時失效的' +
      '序列（連 mtimeMs 都已經前進，衝突檢查也擋不住）');
    assert.strictEqual(ctx.errs.length, 0,
      'N5-inflight：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: N5-inflight a Ctrl+Z inside a save round-trip is not marked as saved — OK');
  }
  // 邊緣選單的「對齊」寫一個屬性，其他什麼都不動：runCycleAlign() 只 snap()
  // burst 的歷史，cycleColumnAlign() 把 `style="text-align:…"` 寫進整欄的
  // 儲存格，然後 burst 就那樣開著。面上的文字與子節點沒有變化（下面的前提
  // 斷言把這件事釘住），所以只盯著文字與子節點的監看看不見它。
  // 實測（把監看的 attributes 那一項拿掉、其餘不動、同樣用真滑鼠驅動）：
  // title 停在 "doc"，而 navBlocked 仍然是 true —— 判別式看得見這筆編輯，
  // 分頁標題看不見。那個組合同時也證明這一列的 ● 不是 commit 給的。
  {
    const ctx = await newPage('# Doc\n\n| A | B |\n| --- | --- |\n| one | two |\n');
    const colB = await ctx.page.evaluate(() => {
      const table = document.querySelector('.ed-block[data-block-type="table"] table');
      const r = table.tHead.rows[0].cells[1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(colB.x, colB.y);
    await ctx.page.waitForSelector('.ed-te-grip-col:not([hidden])', { timeout: 5000 });
    const grip = await ctx.page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-col').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(grip.x, grip.y);
    await ctx.page.mouse.down(); await ctx.page.mouse.up();
    await ctx.page.waitForSelector('.ed-te-menu:not([hidden])', { timeout: 5000 });
    await ctx.page.click('.ed-te-menu-align');
    await new Promise((r) => setTimeout(r, 500));
    const shape = await ctx.page.evaluate(() => {
      const table = document.querySelector('.ed-block[data-block-type="table"] table');
      const cells = Array.prototype.map.call(table.querySelectorAll('tr'),
        (tr) => (tr.cells[1] ? tr.cells[1].getAttribute('style') : null));
      const menu = document.querySelector('.ed-te-menu');
      return { cells: cells, menuOpen: !!(menu && !menu.hidden),
               text: table.textContent };
    });
    const title = await ctx.page.title();
    let navBlocked = false;
    ctx.page.once('dialog', async (d) => { navBlocked = true; await d.dismiss(); });
    await ctx.page.evaluate(() => { window.location.href = 'about:blank'; })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    assert.deepStrictEqual(shape,
      { cells: ['text-align:left', 'text-align:left'], menuOpen: true, text: '\n\nAB\nonetwo\n' },
      'N5 對齊 前提失敗：整欄的 style 必須真的被寫進去、選單必須還開著、而且' +
      '面上的文字一個字都不能動（否則這一列量到的就不是「只寫屬性」），got ' +
      JSON.stringify(shape));
    assert.strictEqual(title.indexOf('●'), 0,
      'N5 對齊：只寫 style 屬性也算改過，必須亮 ●，got ' + JSON.stringify(title));
    assert.strictEqual(navBlocked, true, 'N5 對齊：只寫 style 屬性也必須攔導航');
    assert.strictEqual(ctx.errs.length, 0,
      'N5 對齊：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: closing the tab mid-burst is blocked and the title shows ● — OK');

  // ══ F12：窄視窗下的工具列 ══════════════════════════════
  //
  // 這一組量的是【幾何】：一顆按鈕算「拿得到」的條件是它的 rect 落在
  // 視窗內，而不是「沒被任何東西蓋住」。兩者不同，而這裡取前者是刻意的：
  // 模式槽（.ed-toolbar-status）真的會蓋在按鈕上面，但它帶著
  // pointer-events: none，所以 hit test 落在按鈕、不落在槽上。因此【被槽蓋住
  // 也算拿得到】。那條 pointer-events 規則的承重性由 lib/md2doc.js 裡
  // .ed-toolbar-status 自己的註解記下的驅動量測守著，不在這一列。
  for (const w of [820, 640, 420]) {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.setViewport({ width: w, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const shape = await ctx.page.evaluate(() => {
      const bar = document.querySelector('.ed-toolbar');
      const btns = Array.from(bar.querySelectorAll('.ed-toolbar-btn'));
      const slot = document.querySelector('.ed-toolbar-status');
      const max = bar.scrollWidth - bar.clientWidth;
      const seen = new Set();
      const clear = new Set();
      const look = () => {
        const sr = slot.getBoundingClientRect();
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const onScreen = r.left >= 0 && r.right <= window.innerWidth;
          if (onScreen) seen.add(b.getAttribute('data-ed-tb'));
          // 半像素的鬆度，不是隨手放的：捲到底時最後一顆按鈕的右緣量到剛好
          // 越過槽的左緣 0.109px，820／640／420 三個寬度都一樣 —— 那正是按鈕列
          // 自身寬度的小數部分，而 scrollWidth 只回整數，所以永遠有這麼一截
          // 捲不掉。0.109 在 dpr 1 上連一個裝置像素都不到；鬆度取 0.5 是為了
          // 不把它算成「被蓋住」，同時仍然擋得住任何一個像素起跳的真重疊。
          if (onScreen && (r.right <= sr.left + 0.5 || r.left >= sr.right - 0.5)) {
            clear.add(b.getAttribute('data-ed-tb'));
          }
        }
      };
      for (let sl = 0; sl <= max; sl += 8) { bar.scrollLeft = sl; look(); }
      bar.scrollLeft = max; look();
      bar.scrollLeft = 0;
      const ids = btns.map((b) => b.getAttribute('data-ed-tb'));
      return {
        count: btns.length,
        unreachable: ids.filter((id) => !seen.has(id)),
        neverClear: ids.filter((id) => !clear.has(id)),
      };
    });
    // 前提：這一列在「工具列沒有任何按鈕」時會自動空過 —— btns 是空的、
    // 兩個差集也都是空的。先把數量釘住，前提倒了就要大聲紅。
    assert.strictEqual(shape.count, 23,
      w + '×900 F12 前提失敗：工具列必須真的有按鈕可掃，got ' + shape.count);
    assert.deepStrictEqual(shape.unreachable, [],
      w + '×900：這些按鈕在整個捲動範圍內都拿不到: ' + JSON.stringify(shape.unreachable));
    // padding-right 自己的釘子。只改 justify-content 就能讓上一列綠，所以
    // 若沒有這一列，padding-right 是沒有人看著的。它承諾的不是「永不重疊」，
    // 而是「存在一個捲動位置，讓這顆按鈕完全不在槽下面」。
    assert.deepStrictEqual(shape.neverClear, [],
      w + '×900：這些按鈕找不到任何一個捲動位置能逃出模式槽的足跡: ' +
      JSON.stringify(shape.neverClear));
    assert.strictEqual(ctx.errs.length, 0,
      w + '×900 F12：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: every toolbar button is reachable at 820/640/420 — OK');

  // 捲動提示：兩端的漸層只在那一側真的還藏著東西時亮。斷的是 computed
  // background-image，不是屬性也不是那兩個 custom property —— 那是整條鏈的
  // 末端：client.js 寫屬性、md2doc.js 的狀態規則把 custom property 點亮、
  // background-image 把它畫出來。只斷屬性的話，一個沒有對應 CSS 的屬性也會綠；
  // 只斷 custom property 的話，把 background-image 整條刪掉也還是綠。
  //
  // v3.4.0 §3: 420px 的 max 555 → 522（.ed-toolbar 的 gap 6px → 3px 之後
  // scrollWidth 變小）。改之前先讀過 paintToolbarOverflow()（lib/editor/
  // client.js）：它的判準是 `sl > 1` 亮 left、`sl < max - 1` 亮 right —— 中間
  // 取樣點 Math.round(max/2) 要能同時亮兩側，靠的是離那兩個邊界夠遠，不是
  // 剛好卡在門檻上。522 時中間取樣點是 261，離 1 與 521 都還很遠，不是薄冰；
  // 用一支獨立量測腳本（runs/t3-scrollhint.js）在 820/640/420 分別重新測過
  // `at` 圖案，三個寬度都還是「只右／兩側都亮／只左」，不是剛好卡在邊緣才過。
  // 這裡只釘 420（跟 1400 一樣是這條既有測試唯一驗的兩個寬度）；820/640 這條
  // 測試本來就沒有釘 max，這次也沒有新增。
  for (const w of [1400, 420]) {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.setViewport({ width: w, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const seen = await ctx.page.evaluate(async () => {
      const bar = document.querySelector('.ed-toolbar');
      const max = bar.scrollWidth - bar.clientWidth;
      const out = [];
      for (const sl of [0, Math.round(max / 2), max]) {
        bar.scrollLeft = sl;
        await new Promise((r) => setTimeout(r, 60));
        const bgi = getComputedStyle(bar).backgroundImage;
        out.push({
          attr: bar.getAttribute('data-ed-tb-overflow'),
          left: bgi.indexOf('linear-gradient(to right, rgba(0, 0, 0, 0.55)') !== -1,
          right: bgi.indexOf('linear-gradient(to left, rgba(0, 0, 0, 0.55)') !== -1,
        });
      }
      bar.scrollLeft = 0;
      return { max: max, at: out };
    });
    const want = w === 1400
      ? { max: 0, at: [{ attr: '', left: false, right: false },
                       { attr: '', left: false, right: false },
                       { attr: '', left: false, right: false }] }
      : { max: 522, at: [{ attr: 'right', left: false, right: true },
                         { attr: 'left right', left: true, right: true },
                         { attr: 'left', left: true, right: false }] };
    assert.deepStrictEqual(seen, want,
      w + '×900：捲動提示必須只在那一側還有藏著的按鈕時亮，got ' + JSON.stringify(seen));
    assert.strictEqual(ctx.errs.length, 0,
      w + '×900 捲動提示：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the toolbar says which end still has buttons behind it — OK');

  // 視窗變寬把藏起來的按鈕全還回來了，提示就必須熄掉。這一段不捲、也不動
  // 任何會讓 deriveState() 改變的東西（游標留在原地），所以只有 resize
  // 監聽器能把它熄掉 —— 拿掉那個監聽器這一列就紅。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.setViewport({ width: 420, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const before = await ctx.page.evaluate(
      () => document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-overflow'));
    await ctx.page.setViewport({ width: 1400, height: 900 });
    await new Promise((r) => setTimeout(r, 300));
    const after = await ctx.page.evaluate(
      () => document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-overflow'));
    assert.strictEqual(before, 'right',
      '前提失敗：420 寬、捲到最左時右側提示必須是亮的，got ' + JSON.stringify(before));
    assert.strictEqual(after, '',
      '視窗變寬到裝得下整列之後，捲動提示必須熄掉，got ' + JSON.stringify(after));
    assert.strictEqual(ctx.errs.length, 0,
      '捲動提示 resize：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: widening the window puts the scroll hint out — OK');

  // 按鈕自己的字變寬也會生出新的捲動空間 —— H 鍵在段落上寫 H、在標題上寫 H1。
  // 這一段既不捲也不 resize，游標從段落移到標題而已，所以只有
  // updateToolbar() 收尾那一發重畫能把右側提示點回來。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.setViewport({ width: 420, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.evaluate(() => {
      const bar = document.querySelector('.ed-toolbar');
      bar.scrollLeft = bar.scrollWidth - bar.clientWidth;
    });
    await new Promise((r) => setTimeout(r, 150));
    const snap = () => ctx.page.evaluate(() => {
      const bar = document.querySelector('.ed-toolbar');
      return { attr: bar.getAttribute('data-ed-tb-overflow'),
               label: bar.querySelector('[data-ed-tb="headings"]').textContent,
               room: bar.scrollWidth - bar.clientWidth - bar.scrollLeft };
    });
    const onPara = await snap();
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 300));
    const onHeading = await snap();
    assert.deepStrictEqual(onPara, { attr: 'left', label: 'H', room: 0 },
      '前提失敗：段落上捲到底時右側必須是熄的，got ' + JSON.stringify(onPara));
    assert.deepStrictEqual(onHeading, { attr: 'left right', label: 'H1', room: 7 },
      '標題把 H 撐成 H1、右邊多出捲動空間，提示就必須跟著亮回來，got ' +
      JSON.stringify(onHeading));
    assert.strictEqual(ctx.errs.length, 0,
      '捲動提示 label：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a wider button label lights the scroll hint back up — OK');

  // ══ F12：工具列的鍵盤入口 ═══════════════════════════════════════
  //
  // 游標是【虛擬】的：沒有任何按鈕拿到 DOM 焦點，插入點原地不動。所以這一組
  // 每一列都同時斷「到得了那顆按鈕」與「編輯面沒有被動到」——後者是這個設計
  // 存在的理由，不是附帶條件。
  const F12_MD = '# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n';
  const f12Enter = async (page) => {
    await page.keyboard.down('Alt');
    await page.keyboard.press('F10');
    await page.keyboard.up('Alt');
    await new Promise((r) => setTimeout(r, 150));
  };
  const f12Snap = (page) => page.evaluate(() => {
    const bar = document.querySelector('.ed-toolbar');
    const cur = bar.querySelector('.ed-toolbar-btn[data-ed-tb-cursor]');
    const slot = bar.querySelector('.ed-toolbar-status').getBoundingClientRect();
    const r = cur ? cur.getBoundingClientRect() : null;
    return {
      at: bar.getAttribute('data-ed-tb-keynav'),
      cursors: Array.from(bar.querySelectorAll('.ed-toolbar-btn[data-ed-tb-cursor]'))
        .map((b) => b.getAttribute('data-ed-tb')),
      who: document.activeElement
        ? document.activeElement.tagName + '.' + (document.activeElement.className || '') : 'null',
      onScreen: r ? (r.left >= 0 && r.right <= window.innerWidth) : null,
      clearOfSlot: r ? (r.right <= slot.left + 0.5 || r.left >= slot.right - 0.5) : null,
      scrolled: Math.round(bar.scrollLeft) > 0,
    };
  });

  // K1：Step 8 的本體。打字 → 進工具列 → 走到 ❝（沒有任何鍵盤快捷鍵可以代勞
  // 的一顆）→ 回編輯面 → 繼續打 → 存檔。整段期間磁碟必須一個位元組都沒動，
  // 打的字必須還在。順帶釘住入口手勢的兩個合取項：少了 Alt 的 F10 不得進去，
  // 帶了 Alt 但不是 F10 的鍵也不得進去。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.setViewport({ width: 420, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.type(' typed');
    await new Promise((r) => setTimeout(r, 200));
    const diskBefore = fs.readFileSync(ctx.mdPath, 'utf8');
    await ctx.page.keyboard.press('F10');
    await new Promise((r) => setTimeout(r, 150));
    const bareF10 = await f12Snap(ctx.page);
    await ctx.page.keyboard.down('Alt');
    await ctx.page.keyboard.press('ArrowRight');
    await ctx.page.keyboard.up('Alt');
    await new Promise((r) => setTimeout(r, 150));
    const altOther = await f12Snap(ctx.page);
    await f12Enter(ctx.page);
    // v3.4.0 §3: 4 hops, not 3 — the document is dirty here (' typed' is
    // still an uncommitted burst edit), so `save` (BUTTON_DEFS' new first
    // button) is enabled and is where entry now lands; undo/redo/headings/
    // quote follow it in that order, one hop each.
    for (let i = 0; i < 4; i++) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
    }
    const atQuote = await f12Snap(ctx.page);
    // 游標必須真的畫得出來。斷 computed outline，而不是斷屬性 —— 只斷屬性的話
    // 把樣式整條刪掉也還是綠。
    const paint = await ctx.page.evaluate(() => {
      const on = document.querySelector('.ed-toolbar-btn[data-ed-tb-cursor]');
      const off = Array.from(document.querySelectorAll('.ed-toolbar-btn'))
        .find((b) => !b.hasAttribute('data-ed-tb-cursor'));
      const read = (el) => {
        if (!el) return 'no such button';
        const cs = getComputedStyle(el);
        return cs.outlineStyle + ' ' + cs.outlineWidth;
      };
      return { on: read(on), off: read(off) };
    });
    const diskDuring = fs.readFileSync(ctx.mdPath, 'utf8');
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const left = await f12Snap(ctx.page);
    await ctx.page.keyboard.type(' more');
    await new Promise((r) => setTimeout(r, 250));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(bareF10.at, null,
      'F10 少了 Alt 不得成為入口手勢，got ' + JSON.stringify(bareF10));
    assert.strictEqual(altOther.at, null,
      '帶 Alt 但不是 F10 的鍵不得成為入口手勢，got ' + JSON.stringify(altOther));
    assert.deepStrictEqual(
      { at: atQuote.at, cursors: atQuote.cursors, who: atQuote.who,
        onScreen: atQuote.onScreen, clearOfSlot: atQuote.clearOfSlot },
      { at: 'quote', cursors: ['quote'], who: 'P.ed-wys-armed',
        onScreen: true, clearOfSlot: true },
      'Alt+F10 之後四下 ArrowRight 必須停在 ❝ 上、那顆必須真的看得到、而且插入點' +
      '不得離開編輯面，got ' + JSON.stringify(atQuote));
    assert.strictEqual(paint.on, 'solid 2px',
      '游標所在的按鈕必須畫出外框，got ' + JSON.stringify(paint));
    assert.notStrictEqual(paint.off, paint.on,
      '沒有游標的按鈕不得跟有游標的長得一樣，got ' + JSON.stringify(paint));
    assert.strictEqual(diskDuring, diskBefore,
      '光是逛工具列不得寫磁碟，got ' + JSON.stringify(diskDuring));
    assert.deepStrictEqual({ at: left.at, cursors: left.cursors },
      { at: null, cursors: [] },
      'Escape 必須把工具列的鍵盤游標收乾淨，got ' + JSON.stringify(left));
    assert.strictEqual(disk, '# Doc\n\nAlpha paragraph. typed more\n\nBravo paragraph.\n',
      '逛完工具列回到編輯面，打的字必須還在、而且能繼續打，got ' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K1：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the toolbar is reachable from the keyboard and gives the caret back — OK');

  // K2：走到列尾那顆。420 寬時 M↓ 在靜止位置根本不在畫面上 —— 這一列斷的是
  // 游標每一站都被捲進「按鈕真正站得住」的那條帶子裡（畫面內，且不在模式槽
  // 底下），而不只是「屬性寫對了」。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.setViewport({ width: 420, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    const stops = [];
    for (let i = 0; i < 22; i++) {
      const s = await f12Snap(ctx.page);
      stops.push(s);
      if (s.at === 'preview') break;
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
    }
    const last = stops[stops.length - 1];
    // 再走回來。往左走有自己的邊界判斷，往右那一條蓋不到它：少了它，游標會
    // 停在被切掉的左緣外面。
    const backStops = [];
    for (let i = 0; i < 22; i++) {
      await ctx.page.keyboard.press('ArrowLeft');
      await new Promise((r) => setTimeout(r, 90));
      const s2 = await f12Snap(ctx.page);
      backStops.push(s2);
      if (s2.at === 'undo') break;
    }
    const bad = stops.concat(backStops).filter((s) => !s.onScreen || !s.clearOfSlot)
      .map((s) => s.at);
    assert.deepStrictEqual(bad, [],
      '鍵盤游標停過的每一站都必須被捲到看得見、且不在模式槽底下，got ' +
      JSON.stringify(bad));
    assert.strictEqual(backStops[backStops.length - 1].at, 'undo',
      '往左走必須走得回列首，got ' + JSON.stringify(backStops.map((x) => x.at)));
    assert.deepStrictEqual(
      { at: last.at, scrolled: last.scrolled, who: last.who },
      { at: 'preview', scrolled: true, who: 'P.ed-wys-armed' },
      '往右走必須真的走到列尾那顆，而且工具列必須為了它捲動過，got ' +
      JSON.stringify(last));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K2：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the keyboard cursor scrolls the bar to the button it lands on — OK');

  // K3：鍵盤按下去跟滑鼠按下去要是同一件事。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
    }
    const at = await f12Snap(ctx.page);
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 900));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(at.at, 'quote',
      'K3 前提失敗：Enter 之前游標必須在 ❝ 上，got ' + JSON.stringify(at));
    assert.strictEqual(disk, '# Doc\n\n> Alpha paragraph.\n\nBravo paragraph.\n',
      '在游標上按 Enter 必須跟按那顆按鈕是同一件事，got ' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K3：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: Enter on the keyboard cursor does what pressing the button does — OK');

  // K4：游標腳下那顆被 updateToolbar() 關掉時。真焦點在這裡會被瀏覽器丟回
  // BODY，而從 BODY 按 Tab 又拿不回來；虛擬游標改成走到下一顆還開著的。
  // 原始碼模式曾經是這件事最極端的一格：整列只剩一顆是開著的。T11-2 之後
  // 剩兩顆——'outline'（☰，BUTTON_DEFS 裡排在 'preview' 之前）也留著，因為
  // 拿掉 .sidebar-toggle 之後它是側欄在 edit 模式下唯一的入口。游標從
  // 'quote' 往前找第一顆還開著的按鈕，中間的 code/list/…/image 全部
  // disabled，所以停在 'outline'，不是 'preview'。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
    }
    const before = await f12Snap(ctx.page);
    await ctx.page.click('.ed-toolbar [data-ed-tb="preview"]');
    await new Promise((r) => setTimeout(r, 900));
    const after = await f12Snap(ctx.page);
    const enabled = await ctx.page.evaluate(() => Array.from(
      document.querySelectorAll('.ed-toolbar-btn')).filter((b) => !b.disabled)
      .map((b) => b.getAttribute('data-ed-tb')));
    assert.strictEqual(before.at, 'quote',
      'K4 前提失敗：切模式之前游標必須在 ❝ 上，got ' + JSON.stringify(before));
    assert.deepStrictEqual(enabled, ['outline', 'preview'],
      'K4 前提失敗：原始碼模式下必須恰好剩 outline 與 preview 這兩顆是開著的，got ' +
      JSON.stringify(enabled));
    assert.deepStrictEqual({ at: after.at, cursors: after.cursors },
      { at: 'outline', cursors: ['outline'] },
      '腳下那顆被關掉時，游標必須自己走到「下一顆」還開著的按鈕上 —— BUTTON_DEFS 裡 outline 排在 ' +
      'preview 之前，所以是 outline，got ' + JSON.stringify(after));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K4：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the keyboard cursor steps off a button that just went dead — OK');

  // K5：被排除的那個機制（把 .ed-toolbar 加進 focusout 豁免）就是死在這一段
  // 上 —— 打字、移焦工具列、點進【第三個地方】、再打字，磁碟少了一個字。
  // 虛擬游標沒有「離開工具列」這個焦點事件可言，所以走的還是原本那條路。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.type('A');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    // v3.4.0 §3: 2 hops, not 1 — the document is dirty here ('A' is still an
    // uncommitted burst edit), so entry now lands on `save` (BUTTON_DEFS'
    // new first button) instead of `undo`; one more hop reaches `redo`,
    // which is what this scenario actually needs to be "somewhere on the
    // bar" for its own assertion below.
    await ctx.page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 90));
    await ctx.page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 120));
    const inBar = await f12Snap(ctx.page);
    await ctx.page.click('.ed-block[data-block-id="2"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 400));
    const afterClick = await f12Snap(ctx.page);
    await ctx.page.keyboard.type('B');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 700));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(inBar.at, 'redo',
      'K5 前提失敗：點第三個地方之前，鍵盤游標必須真的在工具列上，got ' +
      JSON.stringify(inBar));
    assert.deepStrictEqual({ at: afterClick.at, cursors: afterClick.cursors },
      { at: null, cursors: [] },
      '點到別的地方就是交還鍵盤，游標必須收掉，got ' + JSON.stringify(afterClick));
    assert.strictEqual(disk, '# Doc\n\nAlpha paragraph.A\n\nBBravo paragraph.\n',
      '逛過工具列再去第三個地方打字，兩邊的字都必須落到磁碟上，got ' +
      JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K5：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: visiting the bar then typing somewhere else loses nothing — OK');

  // K6：Escape 的名次。H▾ 是從工具列裡升起來的選單，所以它先退場，鍵盤模式
  // 才退場；兩發 Escape 都不得走到「還原 burst」那一支 —— 沒提交的字必須還在。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.type(' kept');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    // v3.4.0 §3: 3 hops, not 2 — the document is dirty here (' kept' is
    // still an uncommitted burst edit), so entry now lands on `save`
    // (BUTTON_DEFS' new first button); undo then redo then headings follow
    // it one hop each, so one more ArrowRight than before reaches `headings`.
    await ctx.page.keyboard.press('ArrowRight');
    await ctx.page.keyboard.press('ArrowRight');
    await ctx.page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 150));
    const atH = await f12Snap(ctx.page);
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    const menuUp = await ctx.page.evaluate(
      () => !!document.querySelector('.ed-toolbar-menu'));
    // Enter 還是那顆按鈕自己的開關：再按一次要把選單收起來，而不是收了又開。
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    const readMenu = () => ctx.page.evaluate(() => ({
      menu: !!document.querySelector('.ed-toolbar-menu'),
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
    }));
    const menuToggled = await readMenu();
    // Space 是另一顆按下去的鍵，開關的責任跟 Enter 一樣 —— 各自釘一次，
    // 因為那道「路過就把選單收掉」的閘門是分別把兩顆排除在外的。
    await ctx.page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, 400));
    const spaceOpened = await readMenu();
    await ctx.page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, 400));
    const spaceToggled = await readMenu();
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 250));
    const one = await ctx.page.evaluate(() => ({
      menu: !!document.querySelector('.ed-toolbar-menu'),
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
    }));
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 250));
    const two = await ctx.page.evaluate(() => ({
      menu: !!document.querySelector('.ed-toolbar-menu'),
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      text: document.querySelector('.ed-block[data-block-id="1"]')
        .textContent.replace(/[＋⠿\n]/g, ''),
    }));
    assert.strictEqual(atH.at, 'headings',
      'K6 前提失敗：Enter 之前游標必須在 H 上，got ' + JSON.stringify(atH));
    assert.strictEqual(menuUp, true, 'K6 前提失敗：Enter 必須真的把 H▾ 打開');
    assert.deepStrictEqual(menuToggled, { menu: false, at: 'headings' },
      '再按一次 Enter 必須把 H▾ 收起來、游標留在 H 上，got ' +
      JSON.stringify(menuToggled));
    assert.deepStrictEqual(spaceOpened, { menu: true, at: 'headings' },
      'Space 也必須開得起 H▾，got ' + JSON.stringify(spaceOpened));
    assert.deepStrictEqual(spaceToggled, { menu: false, at: 'headings' },
      '再按一次 Space 必須把 H▾ 收起來，而不是收了又開，got ' +
      JSON.stringify(spaceToggled));
    assert.deepStrictEqual(one, { menu: false, at: 'headings' },
      '第一發 Escape 只收選單，鍵盤模式要留著，got ' + JSON.stringify(one));
    assert.deepStrictEqual(two,
      { menu: false, at: null, text: 'Alpha paragraph. kept' },
      '第二發 Escape 退出鍵盤模式，而且不得走到還原 burst，got ' + JSON.stringify(two));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K6：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: Escape takes the H▾ menu first and the keyboard mode second — OK');

  // K7：三種狀態都到得了，而且進去不動任何東西。原始碼模式的插入點在整份
  // 文件的 textarea 上；區塊選取模式下，選取在進工具列之後原封不動，Escape
  // 的名次是「先退工具列、再清選取」。順帶釘住「打字就交還鍵盤」。
  //
  // T11-2: 這裡從 -1 重新進入鍵盤模式（enterToolbarKeynav() 是
  // moveToolbarCursor(1) 從頭掃），原始碼模式下第一顆還開著的按鈕現在是
  // 'outline'（BUTTON_DEFS 排序在 'preview' 之前），不再是 'preview' —— 那
  // 是本檔案 K4 已經釘住的同一個排序事實，這裡是同一件事的另一個入口。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-toolbar [data-ed-tb="preview"]');
    await new Promise((r) => setTimeout(r, 800));
    await f12Enter(ctx.page);
    const inSource = await f12Snap(ctx.page);
    assert.deepStrictEqual(
      { at: inSource.at, who: inSource.who },
      { at: 'outline', who: 'TEXTAREA.ed-source' },
      '原始碼模式下也必須進得了工具列，而且插入點留在原始碼上，got ' +
      JSON.stringify(inSource));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K7 source：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.evaluate(() => window.__edTestSetSelection(3, 5));
    await new Promise((r) => setTimeout(r, 200));
    const selBefore = await ctx.page.evaluate(() => window.__edTestGetSelection());
    await f12Enter(ctx.page);
    const inSel = await f12Snap(ctx.page);
    const selAfter = await ctx.page.evaluate(() => window.__edTestGetSelection());
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const afterOne = {
      at: await ctx.page.evaluate(
        () => document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav')),
      sel: await ctx.page.evaluate(() => window.__edTestGetSelection()),
    };
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 200));
    const afterTwo = await ctx.page.evaluate(() => window.__edTestGetSelection());
    assert.strictEqual(inSel.at, 'undo',
      '區塊選取狀態下也必須進得了工具列，got ' + JSON.stringify(inSel));
    assert.deepStrictEqual(selAfter, selBefore,
      '進工具列不得動到區塊選取，got ' + JSON.stringify(selAfter));
    assert.strictEqual(afterOne.at, null,
      '第一發 Escape 退的是工具列，got ' + JSON.stringify(afterOne));
    assert.deepStrictEqual(afterOne.sel, selBefore,
      '第一發 Escape 不得順手清掉選取，got ' + JSON.stringify(afterOne.sel));
    assert.strictEqual(afterTwo, null,
      '第二發 Escape 才清選取，got ' + JSON.stringify(afterTwo));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K7：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    await ctx.page.keyboard.type('Z');
    await new Promise((r) => setTimeout(r, 250));
    const back = await ctx.page.evaluate(() => ({
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      text: document.querySelector('.ed-block[data-block-id="1"]')
        .textContent.replace(/[＋⠿\n]/g, ''),
    }));
    assert.deepStrictEqual(back, { at: null, text: 'Alpha paragraph.Z' },
      '模式沒有指名的鍵要把鍵盤整個交還出去：模式收掉，字照樣打進去，got ' +
      JSON.stringify(back));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K7 handback：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    const on = await f12Snap(ctx.page);
    await f12Enter(ctx.page);
    const off = await f12Snap(ctx.page);
    assert.strictEqual(on.at, 'undo',
      '前提失敗：第一發 Alt+F10 必須進得去，got ' + JSON.stringify(on));
    assert.deepStrictEqual({ at: off.at, cursors: off.cursors },
      { at: null, cursors: [] },
      '再按一次入口手勢就出來 —— 那顆鍵不在模式指名的清單裡，走的是交還那一支，' +
      'got ' + JSON.stringify(off));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K7 toggle：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: edit, source and block-selection all reach the bar — OK');

  // K8：游標腳下那顆若是關著的，Enter 不得把它按下去。這一格是【人造】的 ——
  // 走位本身會跳過關著的按鈕、updateToolbar() 收尾又會把游標推離剛被關掉的
  // 那顆，所以產品路徑走不到這裡。這一列直接把那顆按鈕設成 disabled 再按，
  // 量的是那道防線本身的契約：滑鼠這邊由瀏覽器不派送 disabled 按鈕的 click
  // 事件擋著，鍵盤這邊沒有人替它擋。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
    }
    const at = await f12Snap(ctx.page);
    await ctx.page.evaluate(() => {
      document.querySelector('.ed-toolbar-btn[data-ed-tb-cursor]').disabled = true;
    });
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 900));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(at.at, 'quote',
      'K8 前提失敗：Enter 之前游標必須在 ❝ 上，got ' + JSON.stringify(at));
    assert.strictEqual(disk, F12_MD,
      '關著的按鈕即使在游標底下也不得被 Enter 按下去，got ' + JSON.stringify(disk));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K8：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: Enter refuses a button that is switched off under the cursor — OK');

  // K9：選單升起來以後，游標提示與選單不得各說各話。修之前：交還鍵盤那一支
  // 把游標提示收掉、H▾ 卻還立在畫面上，於是那個狀態下只有 Escape 有用。
  // 兩條路各釘一列 —— 沒被指名的鍵（交還）與方向鍵（游標走開）。
  for (const gesture of ['x', 'ArrowRight']) {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    await ctx.page.keyboard.press('ArrowRight');
    await ctx.page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    const opened = await ctx.page.evaluate(() => ({
      menu: !!document.querySelector('.ed-toolbar-menu'),
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
    }));
    await ctx.page.keyboard.press(gesture);
    await new Promise((r) => setTimeout(r, 300));
    const after = await ctx.page.evaluate(() => ({
      menu: !!document.querySelector('.ed-toolbar-menu'),
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      cursors: Array.from(document.querySelectorAll('.ed-toolbar-btn[data-ed-tb-cursor]'))
        .map((b) => b.getAttribute('data-ed-tb')),
      text: document.querySelector('.ed-block[data-block-id="1"]')
        .textContent.replace(/[＋⠿\n]/g, ''),
    }));
    assert.deepStrictEqual(opened, { menu: true, at: 'headings' },
      'K9 前提失敗：Enter 必須把 H▾ 打開而且游標停在 H 上，got ' +
      JSON.stringify(opened));
    if (gesture === 'x') {
      assert.deepStrictEqual(after,
        { menu: false, at: null, cursors: [], text: 'Alpha paragraph.x' },
        '沒被指名的鍵要把選單跟游標一起收掉，字照樣打進去，got ' +
        JSON.stringify(after));
    } else {
      assert.deepStrictEqual(
        { menu: after.menu, at: after.at, cursors: after.cursors, text: after.text },
        { menu: false, at: 'quote', cursors: ['quote'], text: 'Alpha paragraph.' },
        '游標往前走，選單就不該留在原來那顆底下，got ' + JSON.stringify(after));
    }
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K9：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the H▾ menu and the keyboard cursor go down together — OK');

  // K10：Shift 被排除在交還規則外，所以 Shift+方向鍵還是走工具列游標，
  // 而不是掉下去變成區塊選取的延伸。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    await ctx.page.keyboard.down('Shift');
    await ctx.page.keyboard.press('ArrowRight');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 250));
    const after = await ctx.page.evaluate(() => ({
      at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      sel: window.__edTestGetSelection(),
    }));
    assert.deepStrictEqual(after, { at: 'redo', sel: null },
      'Shift+方向鍵在模式裡走的是工具列游標，而且不得生出區塊選取，got ' +
      JSON.stringify(after));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K10：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: Shift+arrow stays on the toolbar cursor — OK');

  // K11：【單獨】按下一顆修飾鍵 —— 不是和別的鍵組成和弦，就是那一顆自己。
  // 瀏覽器對這個動作照樣派送 keydown，`e.key` 就是那顆鍵的名字，而交還規則
  // 排除的正是這四個名字。少了排除，使用者在模式裡剛按下 Ctrl 準備打和弦，
  // 游標就已經沒了。
  //
  // 前提斷言不可省：若這台瀏覽器根本不為裸按的修飾鍵派送 keydown，下面那串
  // 斷言會在「什麼都沒發生」的情況下自動全綠，看起來像釘住了其實沒有。所以
  // 先斷「這四發 keydown 真的到了」。
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    await ctx.page.evaluate(() => {
      window.__f12Keys = [];
      document.addEventListener('keydown', (e) => { window.__f12Keys.push(e.key); }, true);
    });
    const readAt = () => ctx.page.evaluate(
      () => document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    const record = [];
    for (const mod of ['Control', 'Meta', 'Shift', 'Alt']) {
      await ctx.page.keyboard.down(mod);
      await new Promise((r) => setTimeout(r, 120));
      const held = await readAt();
      await ctx.page.keyboard.up(mod);
      await new Promise((r) => setTimeout(r, 150));
      record.push({ mod: mod, held: held, released: await readAt() });
    }
    const dispatched = await ctx.page.evaluate(() => window.__f12Keys);
    await ctx.page.keyboard.press('ArrowRight');
    await new Promise((r) => setTimeout(r, 150));
    const steered = await readAt();
    assert.deepStrictEqual(dispatched, ['Control', 'Meta', 'Shift', 'Alt'],
      'K11 前提失敗：裸按修飾鍵必須真的派送 keydown，否則下面整串斷言是空的，' +
      'got ' + JSON.stringify(dispatched));
    assert.deepStrictEqual(record, [
      { mod: 'Control', held: 'undo', released: 'undo' },
      { mod: 'Meta', held: 'undo', released: 'undo' },
      { mod: 'Shift', held: 'undo', released: 'undo' },
      { mod: 'Alt', held: 'undo', released: 'undo' },
    ], '單獨按一顆修飾鍵不得把工具列的鍵盤游標收掉，got ' + JSON.stringify(record));
    assert.strictEqual(steered, 'redo',
      '四發裸按之後模式必須還開著、還走得動，got ' + JSON.stringify(steered));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K11：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a bare modifier press leaves the keyboard cursor alone — OK');

  // K12 (v3.4.0 §3): `save` is now BUTTON_DEFS' own FIRST button (group
  // 'file', listed ahead of 'history'), so it is the one moveToolbarCursor()
  // would land the Alt+F10 roving cursor on first — UNLESS it is disabled,
  // in which case the walk's existing skip-disabled logic must step past it
  // exactly the way it already steps past any other disabled button. Two
  // halves, same fixture: a clean document must skip it (landing on 'undo'
  // instead, same as every pre-v3.4.0 F12 scenario above that opens on a
  // clean doc), and a dirty one must actually reach it.
  {
    const ctx = await newPage(F12_MD);
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await f12Enter(ctx.page);
    const clean = await f12Snap(ctx.page);
    assert.notStrictEqual(clean.at, 'save',
      '乾淨文件上，Alt+F10 的游標不得落在灰掉的 save 按鈕上，got ' + JSON.stringify(clean));
    assert.strictEqual(clean.at, 'undo',
      '乾淨文件上，Alt+F10 的游標必須落在第一顆還亮著的按鈕（undo）上，got ' +
      JSON.stringify(clean));
    // Escape only retires the virtual cursor — real DOM focus/caret never
    // left the block this whole time (see this section's own opening
    // comment: "沒有任何按鈕拿到 DOM 焦點，插入點原地不動"), so typing lands
    // directly in the still-armed surface and dirties the document via the
    // same uncommitted-burst path documentIsDirty() measures.
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.page.keyboard.type('Z');
    await new Promise((r) => setTimeout(r, 250));
    await f12Enter(ctx.page);
    const dirty = await f12Snap(ctx.page);
    assert.strictEqual(dirty.at, 'save',
      '文件變髒之後，Alt+F10 的游標必須落在亮起來的 save 按鈕上（BUTTON_DEFS 排序第一），got ' +
      JSON.stringify(dirty));
    assert.strictEqual(ctx.errs.length, 0,
      'F12 K12：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the keyboard cursor reaches save, and skips it when it is dead — OK');

  // ── F4: 轉換子選單的項目在矮視窗下都必須可達 ────────────────────────
  // 量測基礎：開 ⠿ + 轉換成整段手勢從未讀過 window.innerHeight/innerWidth
  // （對照組 .ed-seltb 的路徑會讀），即 clamp 從未寫過，不是寫壞。
  {
    const filler = Array.from({ length: 40 }, (_, i) => 'Filler ' + i + '.').join('\n\n');
    const ctx = await newPage('# Doc\n\n' + filler + '\n');
    await ctx.page.setViewport({ width: 1400, height: 700 });
    await ctx.page.evaluate(() => window.scrollTo(0, 0));
    const target = await ctx.page.evaluate(() => {
      const bs = Array.from(document.querySelectorAll('.ed-block'));
      const b = bs.find((e) => e.getBoundingClientRect().top > 400
                            && e.getBoundingClientRect().top < 650);
      return b ? b.getAttribute('data-block-id') : null;
    });
    assert.ok(target, 'fixture 應有一個 blockTop 落在 400–650 的 block');
    const blockSel = '.ed-block[data-block-id="' + target + '"]';
    await ctx.page.hover(blockSel);
    await new Promise((r) => setTimeout(r, 150));
    // 偏離 brief Step 1：brief 原文直接 pressClick `.ed-handle-menu-btn`，但那個
    // class 只長在【已經展開的】選單項目上（lib/editor/client.js 的 item()
    // 與 openConvertSubmenu() 兩處建立），⠿ 本身的 class 是 `.ed-handle`
    // （client.js 同一個檔案）。本檔其他場景（例如上面的 R1）一律先
    // pressClick `.ed-handle` 展開選單、waitForSelector `.ed-handle-menu-btn`
    // 之後才找項目；F4 照那個既有順序走，不是抄 brief 的字面選擇器。
    await pressClick(ctx.page, blockSel + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    const found = await ctx.page.evaluate(() => {
      // 注意：選單項的 class 是 .ed-handle-menu-btn —— `.ed-handle-menu-item`
      // 整個 repo 查無此 class（Task 1 實測）。
      const it = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((e) => e.textContent.trim().indexOf('轉換成') === 0);
      if (!it) return false;
      // 偏離 brief Step 1：brief 原文送 mouseenter，但 openConvertSubmenu()
      // 的 hover 展開是委派在 .ed-handle-menu 上的單一 mouseover 監聽
      // （lib/editor/client.js 的 el.addEventListener('mouseover', …)），
      // 不是 mouseenter；合成的 mouseenter 送到監聽的是 mouseover 事件類型
      // 上，事件類型不合，監聽永遠收不到。
      it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    });
    // Ruling T9-2: 找不到就先斷言，不要讓下面的 dispatch 用 TypeError 假冒
    // product finding。
    assert.ok(found, 'F4 前提失敗：找不到文字以「轉換成」開頭的 .ed-handle-menu-btn');
    await new Promise((r) => setTimeout(r, 250));
    const result = await ctx.page.evaluate(() => {
      const sub = document.querySelector('.ed-handle-submenu');
      if (!sub) return { childCount: 0, off: -1 };
      const off = Array.from(sub.children).filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > window.innerHeight || r.top < 0;
      }).length;
      return { childCount: sub.children.length, off: off };
    });
    // Ruling T9-1: 子選單是空的話 off === 0 會白過，所以先斷子選單真的有項目。
    assert.ok(result.childCount > 0,
      'F4 前提失敗：子選單必須先有項目，斷言才有意義，got childCount=' + result.childCount);
    assert.strictEqual(result.off, 0, '子選單有 ' + result.off + ' 項落在視窗外');
    assert.strictEqual(ctx.errs.length, 0, 'F4：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the convert submenu stays inside the viewport — OK');

  // ── F5 (fix round 1, Ruling T9-5): H▾ 下拉在矮視窗下都必須可達 ──────────
  // 量測基礎：見 task-9-fix1.md 附的表 —— 修前 700px 是 0/6，200px 變成 1/6。
  // 這裡選 200px：低於此高度落進 .ed-toolbar-menu 的 max-height/overflow-y
  // 保底（F1 的 flex-shrink 先於捲動），off 不必是 0；200px 這一格是 shift-to-fit
  // 單獨就該打平的那一格。
  {
    const ctx = await newPage('## Alpha heading\n\nbravo two\n');
    await ctx.page.setViewport({ width: 1400, height: 200 });
    await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 150));
    await pressClick(ctx.page, '[data-ed-tb="headings"]', 80);
    await ctx.page.waitForSelector('.ed-toolbar-menu-btn');
    await new Promise((r) => setTimeout(r, 150));
    const geo = await ctx.page.evaluate(() => {
      const menu = document.querySelector('.ed-toolbar-menu');
      if (!menu) return { childCount: 0, off: -1 };
      const off = Array.from(menu.children).filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > window.innerHeight || r.top < 0;
      }).length;
      return { childCount: menu.children.length, off: off };
    });
    // Ruling T9-1：選單是空的話 off === 0 會白過，先斷選單真的有項目。
    assert.ok(geo.childCount > 0,
      'F5 前提失敗：H▾ 選單必須先有項目，斷言才有意義，got childCount=' + geo.childCount);
    assert.strictEqual(geo.off, 0, 'H▾ 選單有 ' + geo.off + ' 項落在視窗外');
    const found = await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-toolbar-menu-btn'))
        .find((x) => x.textContent.indexOf('標題 6') !== -1);
      if (!b) return false;
      b.click();
      return true;
    });
    // Ruling T9-2：找不到就先斷言，不要讓下面的 disk 讀取用一個空的點擊結果
    // 假冒 product finding。
    assert.ok(found, 'F5 前提失敗：找不到「標題 6」');
    await new Promise((r) => setTimeout(r, 400));
    const disk = await saveAndRead(ctx);
    assert.notStrictEqual(disk.indexOf('###### Alpha heading'), -1,
      'F5：點「標題 6」必須真的改寫層級，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'F5：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the H▾ dropdown stays inside the viewport — OK');

  // ── F6 (fix round 1, Ruling T9-5): 列 grip 選單在矮視窗下都必須可達 ──────
  // 量測基礎：見 task-9-fix1.md —— row-edge 在 700/300/150px 都是 off 1/2，
  // 條件是目標列的 top 落在視窗下緣 40px 內、grip 仍按得到。不點進任何 cell
  // （不開 burst）：既有的 V3 drop-indicator 場景已經證實 hover + 等 grip
  // 出現這個順序才是可靠的路徑，點進 cell 開 burst 會讓 burst 自己的
  // resolve/blur 生命週期在稍後把 grip 收掉。
  {
    const teRows = Array.from({ length: 20 }, (_, i) => '| r' + i + 'a | r' + i + 'b |').join('\n');
    const ctx = await newPage('# Doc\n\n| A | B |\n| --- | --- |\n' + teRows + '\n');
    const H = 700;
    await ctx.page.setViewport({ width: 1400, height: H });
    const rowInfo = await ctx.page.evaluate((h) => {
      const table = document.querySelector('.ed-block[data-block-type="table"] table');
      const trs = Array.from(table.querySelectorAll('tbody tr'));
      for (const tr of trs) {
        const before = tr.getBoundingClientRect().top + window.scrollY;
        window.scrollTo(0, before - (h - 25));
        const r = tr.getBoundingClientRect();
        const td = tr.querySelector('td');
        const cr = td.getBoundingClientRect();
        if (r.top > 0 && r.top < h && (h - r.top) < 40) {
          return { x: cr.left + cr.width / 2, y: Math.max(cr.top + 2, Math.min(cr.bottom - 2, h - 2)) };
        }
      }
      return null;
    }, H);
    assert.ok(rowInfo, 'F6 前提失敗：fixture 應能找到一列 top 落在視窗下緣 40px 內的 row');
    await ctx.page.mouse.move(rowInfo.x, rowInfo.y);
    await ctx.page.waitForSelector('.ed-te-grip-row:not([hidden])', { timeout: 4000 });
    const gripFound = await ctx.page.evaluate(() => {
      const g = document.querySelector('.ed-te-grip-row');
      return !!(g && !g.hidden);
    });
    // Ruling T9-2：grip 找不到／還是隱藏的話，先斷言，不要讓下面拿它的矩形
    // 算出一組假座標再點下去。
    assert.ok(gripFound, 'F6 前提失敗：列 grip 沒有升起來');
    const gripBox = await ctx.page.evaluate(() => {
      const r = document.querySelector('.ed-te-grip-row').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.click(gripBox.x, gripBox.y);
    await new Promise((r) => setTimeout(r, 200));
    const result = await ctx.page.evaluate(() => {
      const menu = document.querySelector('.ed-te-menu');
      if (!menu || menu.hidden) return { childCount: 0, off: -1 };
      const off = Array.from(menu.children).filter((c) => {
        const r = c.getBoundingClientRect();
        return r.bottom > window.innerHeight || r.top < 0;
      }).length;
      return { childCount: menu.children.length, off: off };
    });
    // Ruling T9-1：選單是空的話 off === 0 會白過，先斷選單真的有項目。
    assert.ok(result.childCount > 0,
      'F6 前提失敗：列選單必須先有項目，斷言才有意義，got childCount=' + result.childCount);
    assert.strictEqual(result.off, 0, '列選單有 ' + result.off + ' 項落在視窗外');
    assert.strictEqual(ctx.errs.length, 0, 'F6：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the row-edge menu stays inside the viewport — OK');

  // ── F2: 行內標記按鈕必須說出選取【已經】是什麼 ───────────────────────────
  //
  // 修前量測（1400×900）：選取落在 STRONG／EM／純文字上，兩條工具列的
  // rendered state 位元組完全相同；主工具列那五顆連 aria-pressed 屬性都沒有
  // （BUTTON_DEFS 上全是 toggle: false，寫入那一支根本輪不到它們）。
  //
  // 四態各一列。WHOLE／NONE 是 brief 的那兩格；PARTIAL 與 INERT 是補的，
  // 而 INERT 的關鍵一格是【全空白選取落在既有 mark 內】—— applyMarkToggle()
  // 三支分支只有第三支被 trimRangeToText() 守住，前兩支照樣跑完，所以那一格
  // 的 B 必須是「按得下去而且已按下」，同一個選取的 I 才是 INERT。無條件畫
  // INERT 會停用一顆本來會動的按鈕。
  {
    const ctx = await newPage('# Doc\n\nAlpha **bold text** and *ital* and plain words.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    // 這個 fixture 的段落 childNodes 是 ['Alpha ', <strong>bold text</strong>,
    // ' and ', <em>ital</em>, ' and plain words.']；下面每個 offset 都指名其中
    // 一個節點。每一列都先斷言選到的字串，選錯了就不會靜靜白過。
    const readState = async (mk) => {
      await ctx.page.evaluate(mk);
      await new Promise((r) => setTimeout(r, 200));
      return ctx.page.evaluate(() => {
        const tb = (id) => {
          const b = document.querySelector('[data-ed-tb="' + id + '"]');
          return { pressed: b.getAttribute('aria-pressed'), disabled: b.disabled };
        };
        const stb = (cls) => {
          const b = document.querySelector('.ed-seltb .' + cls);
          if (!b) return null;
          return { pressed: b.getAttribute('aria-pressed'),
                   ariaDisabled: b.getAttribute('aria-disabled'),
                   disabled: b.disabled };
        };
        return { bold: tb('bold'), italic: tb('italic'), link: tb('link'),
                 seltbB: stb('ed-seltb-b'), seltbI: stb('ed-seltb-i'),
                 sel: window.getSelection().toString() };
      });
    };
    const setSel = (fn) => ctx.page.evaluate(fn);

    // WHOLE：整段選取落在 <strong> 內。
    const whole = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.selectNodeContents(el.childNodes[1]);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Ruling T9-1：選取不是我們以為的那一段時，下面每一格都會白過。
    assert.strictEqual(whole.sel, 'bold text', 'F2/WHOLE 前提失敗：選到的是 ' + JSON.stringify(whole.sel));
    assert.strictEqual(whole.bold.pressed, 'true', 'F2/WHOLE：整段落在 STRONG 內時 B 應 aria-pressed=true');
    assert.strictEqual(whole.bold.disabled, false, 'F2/WHOLE：B 必須按得下去');
    assert.strictEqual(whole.italic.pressed, 'false', 'F2/WHOLE：同一段選取的 I 應 aria-pressed=false');
    assert.strictEqual(whole.italic.disabled, false, 'F2/WHOLE：I 必須按得下去');
    assert.ok(whole.seltbB, 'F2/WHOLE 前提失敗：.ed-seltb 沒有升起來');
    assert.strictEqual(whole.seltbB.pressed, 'true', 'F2/WHOLE：.ed-seltb 的 B 也要說 true');
    assert.strictEqual(whole.seltbB.ariaDisabled, null, 'F2/WHOLE：.ed-seltb 的 B 不得帶 aria-disabled');
    assert.strictEqual(whole.seltbI.pressed, 'false', 'F2/WHOLE：.ed-seltb 的 I 應 false');

    // PARTIAL：選取跨過 <strong> 的左邊界 —— 一半在標記外、一半在裡面。
    const partial = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[0], 2);
      r.setEnd(el.childNodes[1].firstChild, 4);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(partial.sel, 'pha bold', 'F2/PARTIAL 前提失敗：選到的是 ' + JSON.stringify(partial.sel));
    assert.strictEqual(partial.bold.pressed, 'mixed',
      'F2/PARTIAL：只覆蓋一部分 STRONG 時 B 應 aria-pressed=mixed');
    assert.strictEqual(partial.bold.disabled, false, 'F2/PARTIAL：B 必須按得下去');
    assert.strictEqual(partial.italic.pressed, 'false', 'F2/PARTIAL：同一段選取的 I 應 false');
    assert.strictEqual(partial.seltbB.pressed, 'mixed', 'F2/PARTIAL：.ed-seltb 的 B 也要說 mixed');
    assert.strictEqual(partial.seltbB.ariaDisabled, null, 'F2/PARTIAL：.ed-seltb 的 B 不得帶 aria-disabled');

    // NONE：純文字選取，兩端都沒有空白 —— 按下去會【包】出一個新標記。
    const none = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[4], 5);
      r.setEnd(el.childNodes[4], 10);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(none.sel, 'plain', 'F2/NONE 前提失敗：選到的是 ' + JSON.stringify(none.sel));
    assert.strictEqual(none.bold.pressed, 'false', 'F2/NONE：純文字選取時 B 應 aria-pressed=false');
    assert.strictEqual(none.bold.disabled, false, 'F2/NONE：B 必須按得下去');
    assert.strictEqual(none.italic.pressed, 'false', 'F2/NONE：I 應 false');
    assert.strictEqual(none.italic.disabled, false, 'F2/NONE：I 必須按得下去');
    assert.strictEqual(none.seltbB.pressed, 'false', 'F2/NONE：.ed-seltb 的 B 應 false');
    assert.strictEqual(none.seltbB.ariaDisabled, null, 'F2/NONE：.ed-seltb 的 B 不得帶 aria-disabled');

    // INERT（純文字）：全空白選取，applyMarkToggle() 走第三支而 trimRangeToText()
    // 拒絕它 —— 按下去文件一個位元組都不會變。
    const inertPlain = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[4], 4);
      r.setEnd(el.childNodes[4], 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(inertPlain.sel, ' ', 'F2/INERT 前提失敗：選到的是 ' + JSON.stringify(inertPlain.sel));
    assert.strictEqual(inertPlain.bold.disabled, true, 'F2/INERT：全空白選取時 B 應停用');
    assert.strictEqual(inertPlain.italic.disabled, true, 'F2/INERT：全空白選取時 I 應停用');
    assert.strictEqual(inertPlain.bold.pressed, 'false', 'F2/INERT：停用的 B 仍應說 false，不得漏寫屬性');
    // 🔗 不走 applyMarkToggle()：applyLinkToggleBody() 的第三支直接
    // window.prompt() + extractRangeInto()，沿路沒有任何 trim 守衛，全空白選取
    // 照樣開對話框並包出 <a> —— 停用它才是把一顆會動的按鈕畫死。
    assert.strictEqual(inertPlain.link.disabled, false,
      'F2/INERT：🔗 沒有 trim 守衛，全空白選取時不得停用');
    // ⚠ .ed-seltb 用 aria-disabled，不得用 disabled 屬性：B／I／S／U／<>／🔗
    // 各自靠自己的 mousedown preventDefault() 保住選取，而 disabled button
    // 根本不派發 mousedown。實測（真滑鼠 move/down/80ms/up，document 上掛
    // capture 計數器）——出貨版：
    //   {"active":"P.ed-wys-armed","sel":" ","seltb":true,"downs":1,"clicks":1}
    // 同一發但那顆帶著 disabled：
    //   {"active":"BODY.","sel":" ","seltb":false,"downs":0,"clicks":0}
    // 焦點掉到 BODY、浮動列不見了，而且整條傳遞路徑收不到任何 mousedown。
    assert.strictEqual(inertPlain.seltbB.ariaDisabled, 'true', 'F2/INERT：.ed-seltb 的 B 應 aria-disabled=true');
    assert.strictEqual(inertPlain.seltbB.disabled, false, 'F2/INERT：.ed-seltb 的 B 不得使用 disabled 屬性');
    assert.strictEqual(inertPlain.seltbI.ariaDisabled, 'true', 'F2/INERT：.ed-seltb 的 I 應 aria-disabled=true');
    assert.strictEqual(inertPlain.seltbI.disabled, false, 'F2/INERT：.ed-seltb 的 I 不得使用 disabled 屬性');

    // INERT 的判別式必須是 per-tag 的：同一個【全空白】選取落在 <strong> 裡面，
    // B 走的是第一支（unwrap，會成功），I 走的才是被守住的第三支。
    const inertInMark = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[1].firstChild, 4);
      r.setEnd(el.childNodes[1].firstChild, 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(inertInMark.sel, ' ', 'F2/INERT-in-mark 前提失敗：選到的是 ' + JSON.stringify(inertInMark.sel));
    assert.strictEqual(inertInMark.bold.disabled, false,
      'F2/INERT-in-mark：全空白但落在 STRONG 內 —— B 走 unwrap 那一支，不得停用');
    assert.strictEqual(inertInMark.bold.pressed, 'true',
      'F2/INERT-in-mark：B 應 aria-pressed=true');
    assert.strictEqual(inertInMark.italic.disabled, true,
      'F2/INERT-in-mark：同一個選取的 I 走的是被守住的那一支，應停用');
    assert.strictEqual(inertInMark.seltbB.ariaDisabled, null,
      'F2/INERT-in-mark：.ed-seltb 的 B 不得帶 aria-disabled');
    assert.strictEqual(inertInMark.seltbI.ariaDisabled, 'true',
      'F2/INERT-in-mark：.ed-seltb 的 I 應 aria-disabled=true');

    // aria-disabled 要收得回去：從 INERT 回到 NONE 之後屬性必須不見，不是只
    // 在進入 INERT 時寫上去。
    const backToNone = await readState(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[4], 5);
      r.setEnd(el.childNodes[4], 10);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(backToNone.sel, 'plain', 'F2/back-to-NONE 前提失敗：選到的是 ' + JSON.stringify(backToNone.sel));
    assert.strictEqual(backToNone.seltbI.ariaDisabled, null,
      'F2/back-to-NONE：離開 INERT 之後 .ed-seltb 的 I 必須把 aria-disabled 拿掉');
    assert.strictEqual(backToNone.italic.disabled, false,
      'F2/back-to-NONE：離開 INERT 之後主工具列的 I 必須重新啟用');

    // 按下去之後那顆按鈕要改口：真人按壓（pressClick）取消 WHOLE 態的粗體，
    // 按鈕必須從 true 變回 false。
    await setSel(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.selectNodeContents(el.childNodes[1]);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 200));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const afterPress = await ctx.page.evaluate(() => {
      const b = document.querySelector('[data-ed-tb="bold"]');
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      return { pressed: b.getAttribute('aria-pressed'),
               strongs: el ? el.querySelectorAll('strong').length : -1 };
    });
    assert.strictEqual(afterPress.strongs, 0, 'F2/after-press 前提失敗：粗體沒有被取消掉');
    assert.strictEqual(afterPress.pressed, 'false',
      'F2/after-press：取消粗體之後 B 必須改口說 false');

    assert.strictEqual(ctx.errs.length, 0, 'F2：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the inline mark buttons say what the selection already is — OK');

  // ── F2d: 全空白選取落在 <strong> 內時，按 B 真的會 unwrap ────────────────
  //
  // 這是 F2 那格「不得無條件畫 INERT」背後的行為本身：INERT 的判別式只在
  // applyMarkToggle() 會走第三支時成立，而這個選取走的是第一支。不量這一列
  // 的話，「前兩支照樣跑完」就只是一句沒有量測的機制敘述。
  {
    const ctx = await newPage('# Doc\n\nAlpha **bold text** and plain words.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    const before = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[1].firstChild, 4);   // <strong>bold text</strong> 裡的那個空格
      r.setEnd(el.childNodes[1].firstChild, 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      const b = document.querySelector('[data-ed-tb="bold"]');
      return { sel: s.toString(), strongs: el.querySelectorAll('strong').length,
               disabled: b.disabled };
    });
    assert.strictEqual(before.sel, ' ', 'F2d 前提失敗：選到的是 ' + JSON.stringify(before.sel));
    assert.strictEqual(before.strongs, 1, 'F2d 前提失敗：fixture 應該只有一個 <strong>');
    assert.strictEqual(before.disabled, false, 'F2d 前提失敗：B 這時不該是停用的');
    await new Promise((r) => setTimeout(r, 200));
    await pressClick(ctx.page, '[data-ed-tb="bold"]', 80);
    await new Promise((r) => setTimeout(r, 400));
    const after = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      return { strongs: el ? el.querySelectorAll('strong').length : -1,
               text: el ? el.textContent : null };
    });
    assert.strictEqual(after.strongs, 0,
      'F2d：全空白選取落在 <strong> 內時按 B 必須把它拆掉（走的是第一支，不是被守住的第三支）');
    assert.strictEqual(after.text, 'Alpha bold text and plain words.',
      'F2d：拆掉標記不得動到文字，got ' + JSON.stringify(after.text));
    const disk = await saveAndRead(ctx);
    assert.strictEqual(disk.indexOf('**'), -1,
      'F2d：磁碟上不該再有 ** —— got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'F2d：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: an all-whitespace selection inside a mark still unwraps it — OK');

  // ── F2e: .ed-seltb 自己那顆按下去之後也要改口 ──────────────────────────────
  //
  // 主工具列的按鈕 click handler 尾巴掛著 `.then(updateToolbar)`；.ed-seltb 的
  // B／I／S／U／<>／🔗【沒有】—— 它們直接呼叫 applyMarkToggle()，重畫是靠
  // reselectAndReposition() 重設選取之後【非同步】飛回來的 selectionchange。
  // 那是另一條機制，F2 的 after-press 那一格量不到它。這裡用真滑鼠按壓
  // .ed-seltb 的 B，兩個方向各一次：WHOLE→拆掉（true 要變 false）、
  // NONE→包起來（false 要變 true）。
  //
  // 中途沒有任何同步的重畫可以冒充它：applyMarkToggle() 那條路上只有
  // snapBurstIfActive()（只叫 history.snap()）與 reselectAndReposition()
  // （只 setRange + positionSelToolbar()），而文件層的 click 委派在
  // `e.target.closest('.ed-seltb')` 就 return 了。實測把
  // reselectAndReposition() 的 removeAllRanges／addRange 拿掉（其餘不動）：
  // 這一列紅，而同一次跑動裡 F2 那格按主工具列的 after-press 仍然綠 —— 兩條
  // 重畫路徑真的是分開的。
  {
    const ctx = await newPage('# Doc\n\nAlpha **bold text** and plain words.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    const readB = () => ctx.page.evaluate(() => {
      const b = document.querySelector('.ed-seltb .ed-seltb-b');
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      return { pressed: b ? b.getAttribute('aria-pressed') : null,
               strongs: el ? el.querySelectorAll('strong').length : -1,
               sel: window.getSelection().toString() };
    });

    // WHOLE → 按 B → 拆掉
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange(); r.selectNodeContents(el.childNodes[1]);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await new Promise((r) => setTimeout(r, 250));
    const wholeBefore = await readB();
    assert.strictEqual(wholeBefore.sel, 'bold text',
      'F2e 前提失敗：選到的是 ' + JSON.stringify(wholeBefore.sel));
    assert.strictEqual(wholeBefore.pressed, 'true', 'F2e 前提失敗：按之前 B 應該是 true');
    await pressClick(ctx.page, '.ed-seltb .ed-seltb-b', 80);
    await new Promise((r) => setTimeout(r, 500));
    const wholeAfter = await readB();
    assert.strictEqual(wholeAfter.strongs, 0, 'F2e：按下去必須真的把 <strong> 拆掉');
    assert.strictEqual(wholeAfter.pressed, 'false',
      'F2e：.ed-seltb 的 B 拆掉標記之後必須自己改口說 false');

    // NONE → 按 B → 包起來
    // 拆掉 <strong> 之後這個區塊的 text node 被切成好幾段（unwrapElement()
    // 把子節點原地插回去，並不合併），所以要走訪找出帶著 'plain' 的那一段，
    // 不能再假設它是 firstChild。
    const found = await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const walk = (n, out) => { if (n.nodeType === 3) out.push(n);
        else for (let x = n.firstChild; x; x = x.nextSibling) walk(x, out); return out; };
      const t = walk(el, []).find((n) => n.data.indexOf('plain') !== -1);
      if (!t) return false;
      const i = t.data.indexOf('plain');
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      return true;
    });
    assert.ok(found, 'F2e 前提失敗：拆掉標記之後找不到含 plain 的 text node');
    await new Promise((r) => setTimeout(r, 250));
    const noneBefore = await readB();
    assert.strictEqual(noneBefore.sel, 'plain',
      'F2e 前提失敗：選到的是 ' + JSON.stringify(noneBefore.sel));
    assert.strictEqual(noneBefore.pressed, 'false', 'F2e 前提失敗：按之前 B 應該是 false');
    await pressClick(ctx.page, '.ed-seltb .ed-seltb-b', 80);
    await new Promise((r) => setTimeout(r, 500));
    const noneAfter = await readB();
    assert.strictEqual(noneAfter.strongs, 1, 'F2e：按下去必須真的包出一個 <strong>');
    assert.strictEqual(noneAfter.pressed, 'true',
      'F2e：.ed-seltb 的 B 包出標記之後必須自己改口說 true');

    const disk = await saveAndRead(ctx);
    assert.notStrictEqual(disk.indexOf('**plain**'), -1,
      'F2e：磁碟上應該有 **plain** —— got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'F2e：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the floating bar changes its mind after its own button is pressed — OK');

  // ── F2c: .ed-seltb 的 U 不在主工具列的 state 裡，不得被 sig 早退擋掉 ──────
  //
  // updateToolbar() 把 state 序列化成 sig 之後只在變了才寫 DOM，而那份 state
  // 只有主工具列那些按鈕。.ed-seltb 多一顆 U —— 選取在純文字與 <u> 之間移動
  // 時，主工具列那五顆的答案全都是 none，sig 逐位元組相同、早退成立，U 卻該
  // 從 false 變成 true。所以 paintSelToolbarMarks() 必須在早退之前跑。
  {
    const ctx = await newPage('# Doc\n\nplain <u>under</u> text here.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    const readU = async (mk) => {
      await ctx.page.evaluate(mk);
      await new Promise((r) => setTimeout(r, 200));
      return ctx.page.evaluate(() => {
        const u = document.querySelector('.ed-seltb .ed-seltb-u');
        const bar = Array.from(document.querySelectorAll('[data-ed-tb]')).map((b) => [
          b.getAttribute('data-ed-tb'), b.getAttribute('aria-pressed'),
          b.disabled, b.textContent, b.title]);
        return { u: u ? u.getAttribute('aria-pressed') : null, bar: bar,
                 sel: window.getSelection().toString() };
      });
    };
    const outside = await readU(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[2], 1); r.setEnd(el.childNodes[2], 5);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(outside.sel, 'text', 'F2c 前提失敗：選到的是 ' + JSON.stringify(outside.sel));
    assert.strictEqual(outside.u, 'false', 'F2c：純文字上 U 應 false');
    const inside = await readU(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.selectNodeContents(el.childNodes[1]);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    assert.strictEqual(inside.sel, 'under', 'F2c 前提失敗：選到的是 ' + JSON.stringify(inside.sel));
    // 前提：主工具列在這兩個選取之間【整條都沒有變】—— 只要有一顆變了，
    // updateToolbar() 的 sig 就不同、早退不成立，這一列就不是在量它想量的
    // 東西。所以比的是每顆按鈕的 aria-pressed / disabled / 文字 / title。
    assert.deepStrictEqual(inside.bar, outside.bar,
      'F2c 前提失敗：兩個選取之間主工具列的狀態變了，sig 早退量不到');
    assert.ok(inside.bar.length > 0, 'F2c 前提失敗：主工具列一顆按鈕都沒讀到');
    assert.strictEqual(inside.u, 'true',
      'F2c：選取整段落在 <u> 內時 .ed-seltb 的 U 必須說 true');
    assert.strictEqual(ctx.errs.length, 0, 'F2c：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the floating bar repaints a button the fixed bar has no opinion about — OK');

  // ── F2b: 量 mark 身分不得動到使用者的選取（trimRangeToText 的 cloneRange）─
  //
  // trimRangeToText() 回 true 時會 setStart/setEnd 改掉【傳進去的】Range，而
  // selectionMarkStates() 每次 selectionchange 都會叫它一次。傳 live range 的
  // 話，使用者每按一次 Shift+→ 就會被偷偷把選取的前後空白吃掉，下一按就從錯
  // 的地方接續。這裡用真鍵盤把選取一格一格拉過 <strong>，兩種斷言：每一步
  // 派發 selectionchange 前後的邊界必須逐位元組相同（whole/overlapping/trim
  // 三支都不得寫入），而且選到的字串必須一次長一個字。
  {
    const ctx = await newPage('# Doc\n\nAlpha **bold text** and *ital* and plain words.\n');
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.evaluate(() => {
      const el = document.querySelector('.ed-block[data-block-id="1"] .ed-wys-armed');
      const r = document.createRange();
      r.setStart(el.childNodes[0], 5);   // 'Alpha' 之後、那個空格之前
      r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      el.focus();
    });
    await new Promise((r) => setTimeout(r, 150));
    const want = [' ', ' b', ' bo', ' bol', ' bold', ' bold ', ' bold t'];
    await ctx.page.keyboard.down('Shift');
    for (let i = 0; i < want.length; i++) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 90));
      const step = await ctx.page.evaluate(() => {
        const snap = () => {
          const s = window.getSelection();
          const r = s.getRangeAt(0);
          return { str: s.toString(), so: r.startOffset, eo: r.endOffset,
                   sn: r.startContainer.nodeName, en: r.endContainer.nodeName };
        };
        const before = snap();
        document.dispatchEvent(new Event('selectionchange'));
        return { before: before, after: snap() };
      });
      assert.deepStrictEqual(step.after, step.before,
        'F2b：第 ' + (i + 1) + ' 步的 selectionchange 改掉了使用者的選取 —— ' +
        JSON.stringify(step));
      assert.strictEqual(step.after.str, want[i],
        'F2b：第 ' + (i + 1) + ' 步應選到 ' + JSON.stringify(want[i]) +
        '，實際 ' + JSON.stringify(step.after.str));
    }
    await ctx.page.keyboard.up('Shift');
    assert.strictEqual(ctx.errs.length, 0, 'F2b：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: measuring the marks leaves the selection alone — OK');


  // ── F8: 有待提交的編輯時，第一次點進表格必須落在【被點的】那一格 ────────
  //
  // 使用者回報的字面症狀：在段落裡打完字之後第一次點進表格，游標落在左上角
  // 那一格，接著打的字蓋掉欄位標題、而且進了磁碟。
  //
  // 機制（instrument 過：在 handleTableCellFocusIn() 的 `await switching` 兩側
  // 放探針量的）：mousedown 讓髒段落
  // focusout -> switchAwayFrom() -> 提交 -> applyRenderResult()。page load
  // 之後的第一次提交時 `lastParts` 還是 null，所以那一發交給 applyFullRender()，
  // 它的 `contentEl.innerHTML =` 把 .content 整片換掉；探針在
  // handleTableCellFocusIn() 的 `await switching` 兩側記到 route
  // ["applyFullRender"]、`document.body.contains(cellEl)` false。舊碼在那之後
  // 用 `tableCellsOf(liveTableEl)[0]` 復原，於是落在表頭第一格。
  //
  // 兩個變體都留著：unprimed 是【偵測器】—— 它走的正是上面那條
  // applyFullRender 路徑；primed 先花掉那一發 fallback，之後的提交走 patch、
  // 被點的 td 不會被 detach，所以它修好之前就是綠的。它是【控制組】，控的是
  // 「這一修不得把本來就正確的 patch 路徑弄壞」。
  // v3.3.0 Task 19：這一行 scrollIntoView() 是刻意的，不要當雜訊刪掉。下面那
  // 一發是 page.mouse.click(x, y)，座標來自那一格【當下】的
  // getBoundingClientRect()，所以落點跟著 fixture 有多長、以及前一步把畫面捲到
  // 哪裡走；這一行把落點與那兩件事脫鉤。
  //
  // 它在【現在這個 fixture 上】不是這一列的偵測力來源，而這句話是量出來的：
  // 把 client.js 的復原改回 pre-fix 的 `tableCellsOf(liveTableEl)[0]`（1400×1000、
  // 髒 burst 留在表格【後面】那個段落上、用 filler 把表格推出視窗），有沒有這
  // 一行，缺陷都照樣被抓到 —— 落點都是表頭那一格 'A'。也就是說在這台機器的
  // puppeteer 上，座標落在視窗外的 mouse.click 仍然打到了那一格（兩個方向都量
  // 過：那一格的 client y 是 -117 與 1299）。
  const t13LastCellClick = async (page) => {
    await page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      cells[cells.length - 1].scrollIntoView({ block: 'center' });
    });
    const box = await page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      const r = cells[cells.length - 1].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await new Promise((r) => setTimeout(r, 500));
  };
  const t13Landed = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains('ed-wys-cell')) {
      return 'not-a-cell:' + (a && a.tagName);
    }
    return a.textContent.trim();
  });
  // ⠿ -> MD 原始碼，把 block 1 的來源換成 `value` 並【留著不提交】——
  // 之後那一下點進表格的 mousedown 才是提交它的人。
  const t13DirtyRaw = async (ctx, value) => {
    const sel = '.ed-block[data-block-id="1"]';
    await ctx.page.hover(sel);
    await pressClick(ctx.page, sel + ' .ed-handle', 80);
    await ctx.page.waitForSelector('.ed-handle-menu-btn');
    await ctx.page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
        .find((x) => x.textContent.indexOf('原始碼') !== -1);
      if (!b) throw new Error('MD 原始碼 item not found');
      b.click();
    });
    await ctx.page.waitForSelector('textarea.ed-raw');
    await ctx.page.evaluate((v) => {
      const ta = document.querySelector('textarea.ed-raw');
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await new Promise((r) => setTimeout(r, 250));
  };
  const T13_TABLE = '| A | B |\n|---|---|\n| c1 | c2 |\n| c3 | c4 |\n';
  for (const primed of [false, true]) {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\n' + T13_TABLE);
    if (primed) {                       // 先做一次無關的 commit，讓 lastParts 非 null
      await ctx.page.click('.ed-block[data-block-id="0"] .ed-wys-armed');
      await ctx.page.keyboard.type('X');
      await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 400));
    }
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type('zz');
    await new Promise((r) => setTimeout(r, 150));
    await t13LastCellClick(ctx.page);
    const landed = await t13Landed(ctx.page);
    assert.strictEqual(landed, 'c4',
      'F8(primed=' + primed + ')：點最後一格應落在 c4，got ' + landed);
    // 使用者感知到的傷害是【磁碟上的欄位標題被打的字蓋掉】，所以落點對了之後
    // 還要把字真的打下去、存檔、讀回來。
    await ctx.page.keyboard.type('QQ');
    await new Promise((r) => setTimeout(r, 200));
    const disk = await saveAndRead(ctx);
    assert.ok(/\|\s*A\s*\|\s*B\s*\|/.test(disk),
      'F8(primed=' + primed + ')：欄位標題被覆蓋了，磁碟上是:\n' + disk);
    assert.ok(disk.indexOf('QQ') !== -1,
      'F8(primed=' + primed + ') 前提失敗：打的字根本沒進磁碟，這一列什麼都沒量到:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0,
      'F8(primed=' + primed + ')：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: the first click into a table lands where you clicked — OK');

  // ── F8 的復原錨點：兩個 handle 各有對方接不住的提交形狀 ──────────────────
  //
  // 復原分兩半：先認回這張表，再認回那一格。認回【那一格】用的是 (row, col)
  // 座標；認回【這張表】則量過兩個 handle，量到的結論是誰也蓋不住誰，所以
  // 出貨的是 data-block-id 先問、blockElAtLine(startLine) 接手。下面兩列各
  // 釘住其中一邊：拿掉哪一個，就有一列紅。
  //
  // 行數變、block 數不變：raw 把一行的段落換成三行的段落。表格的
  // data-block-id 沒動，startLine 往後位移。
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\n' + T13_TABLE);
    await t13DirtyRaw(ctx, 'one\nmore\nlines');
    await t13LastCellClick(ctx.page);
    const landed = await t13Landed(ctx.page);
    assert.strictEqual(landed, 'c4',
      'F8/行數位移：表格的 data-block-id 沒變、startLine 變了，仍要落在 c4，got ' + landed);
    assert.strictEqual(ctx.errs.length, 0, 'F8/行數位移：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // block 數變、行數不變：raw 把兩行的段落換成兩行的兩個標題。表格的
  // startLine 沒動，data-block-id 從 2 變 3 —— blockmap 每次 render 都從 0
  // 重編號，這正是 ensureTableBurstOpen() 的 S1 註解寫下來的那件事。
  {
    const ctx = await newPage('# Doc\n\nAlpha para one\ncontinued line.\n\n' + T13_TABLE);
    await t13DirtyRaw(ctx, '# One\n# Two');
    await t13LastCellClick(ctx.page);
    const landed = await t13Landed(ctx.page);
    assert.strictEqual(landed, 'c4',
      'F8/block 數位移：表格的 startLine 沒變、data-block-id 變了，仍要落在 c4，got ' + landed);
    assert.strictEqual(ctx.errs.length, 0, 'F8/block 數位移：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  // 同一個位移形狀，但文件裡有【兩張】表：舊 id 現在指到的是隔壁那張表，而
  // (row, col) 座標在那張表裡也存在。tableIdentityOf() 是攔住這一發的東西；
  // 拿掉它，游標會落在使用者沒碰過的那張表的 c1。
  {
    const ctx = await newPage('# Doc\n\nAlpha para one\ncontinued line.\n\n'
      + T13_TABLE + '\n| Q |\n|---|\n| q1 |\n');
    await t13DirtyRaw(ctx, '# One\n# Two');
    await t13LastCellClick(ctx.page);
    const landed = await t13Landed(ctx.page);
    assert.strictEqual(landed, 'q1',
      'F8/兩張表：舊 id 指到隔壁那張表，游標不得落在那裡，got ' + landed);
    assert.strictEqual(ctx.errs.length, 0, 'F8/兩張表：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
  }
  console.log('journey: a table the commit renumbered or moved is still recognised — OK');

  // ── F7: ＋ 泡泡不得在使用者伸手過去的半路上自己消失 ─────────────────────
  //
  // 泡泡本體與 row grip 都是掛在 document.body 上的 position: fixed 浮層，
  // 就畫在「把泡泡叫出來」的那條帶子上面。指標一碰到它們，mousemove 的
  // target 就不再是表格的後代，可見性判斷因而收掉使用者正伸手要按的那顆
  // 泡泡；下一個 mousemove 又打回底下的儲存格、泡泡再升起來，所以整段接近
  // 的路上它一閃一閃，按下去那一刻在不在，取決於最後一個移動事件剛好落在
  // 哪一邊。
  //
  // 【量測，1400×1000，表格左緣 412】row 泡泡置中在它提供的那條列邊界上、
  // 橫向落在 x∈[403,421]，而觸發帶是 x∈[402,422]、y 為該邊界 ±10 —— 泡泡
  // 幾乎蓋滿整條帶子，只剩最外一圈叫得動它而不踩到它。column 帶子更窄：
  // 表格上緣【以上】的 target 實測是 MAIN.content，不在表格 block 裡，
  // 所以只有上緣往下那一半叫得動泡泡，而那一半又被泡泡自己蓋掉大半。
  // 所以下面每一列的起點都刻意壓在帶子的最外圈。
  //
  // 每一列都用【真的把指標移過去】的多步移動，並且獨立盯住泡泡的 hidden
  // 屬性：路上被藏起來過就算紅。停下來之後的可點性另外斷言，但它單獨看會
  // 受奇偶影響 —— 未修時 target 在泡泡與底下元素之間逐事件交替，停在哪一
  // 邊由落在泡泡上的事件數的奇偶決定。屬性觀察不受這件事影響。
  {
    // 走一趟「伸手過去」：先把指標放在 `from` 把泡泡叫起來，裝上盯著
    // hidden 的 MutationObserver，再用多步移動走到 `to`。
    const reachForBubble = async (page, sel, from, to, steps) => {
      await page.mouse.move(from.x - 60, from.y);
      await page.mouse.move(from.x, from.y);
      await new Promise((r) => setTimeout(r, 250));
      const raised = await overlayState(page, sel);
      const aim = await page.evaluate((s) => {
        const b = document.querySelector(s);
        window.__f7Hides = 0;
        // 只數「本來沒有 hidden、現在有了」這種轉換。實測：對一顆已經藏
        // 起來的泡泡再寫一次 hidden = true，MutationObserver 照樣收到
        // record（oldValue 是 ""），所以用「現在是不是藏著」去數，會把那
        // 種畫面上什麼都沒發生的寫入也算進來。
        window.__f7Obs = new MutationObserver((ms) => {
          for (const m of ms) if (m.oldValue === null) window.__f7Hides++;
        });
        window.__f7Obs.observe(b,
          { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
        return { after: b.dataset.afterRowIndex, col: b.dataset.colIndex };
      }, sel);
      await page.mouse.move(to.x, to.y, { steps });
      await new Promise((r) => setTimeout(r, 250));
      const hides = await page.evaluate(() => {
        window.__f7Obs.disconnect();
        return window.__f7Hides;
      });
      const rest = await overlayState(page, sel);
      // 只有還活著的浮層才問得出可點性：display:none 的元素矩形全是 0
      // （實測就是 l/t/w/h 全 0），拿它的「中心」去問 elementFromPoint，
      // 問到的是頁面左上角那一點，跟這顆泡泡點不點得到無關。直接判成
      // 不可點，讓失敗訊息落在 `rest` 上。
      const reachable = isLive(rest) ? await page.evaluate((s) => {
        const b = document.querySelector(s);
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!(el && (el === b || b.contains(el)));
      }, sel) : false;
      return { raised, aim, hides, rest, reachable };
    };
    const F7_MD = '# Doc\n\n| A | B |\n|---|---|\n| c1 | c2 |\n| c3 | c4 |\n';

    // 列泡泡：從帶子最外圈（表格左緣往左 TB_EDGE_PX，那裡是
    // .ed-block::before 的走廊，target 仍是表格 block 本身）橫著伸手到泡泡
    // 正中心。
    {
      const ctx = await newPage(F7_MD);
      await ctx.page.setViewport({ width: 1400, height: 1000 });
      const g = await ctx.page.evaluate(() => {
        const tb = document.querySelector('.ed-block[data-block-type="table"] table');
        return { left: tb.getBoundingClientRect().left,
          boundary: tb.tBodies[0].rows[0].getBoundingClientRect().bottom };
      });
      const out = await reachForBubble(ctx.page, '.ed-tb-insert-row',
        { x: g.left - 10, y: g.boundary }, { x: g.left, y: g.boundary }, 9);
      assert.ok(isLive(out.raised),
        'F7/列 前提失敗：泡泡根本沒升起來，這一列什麼都沒量到，got ' + JSON.stringify(out.raised));
      assert.strictEqual(out.aim.after, '0',
        'F7/列 前提失敗：泡泡瞄的不是第一條 body 列的下緣，got ' + JSON.stringify(out.aim));
      assert.strictEqual(out.hides, 0,
        'F7/列：伸手過去的路上泡泡不得自己消失，實際被藏起來的次數 ' + out.hides);
      assert.ok(out.reachable,
        'F7/列：指標停在泡泡上時它必須還在、還點得到，got ' + JSON.stringify(out.rest));
      assert.strictEqual(ctx.errs.length, 0, 'F7/列：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }

    // 欄泡泡：只有表格上緣【往下】那一側叫得動它，而泡泡自己蓋掉其中大半，
    // 所以起點壓在 top + TB_EDGE_PX，再直直往上伸手到泡泡正中心。
    {
      const ctx = await newPage(F7_MD);
      await ctx.page.setViewport({ width: 1400, height: 1000 });
      const g = await ctx.page.evaluate(() => {
        const tb = document.querySelector('.ed-block[data-block-type="table"] table');
        return { top: tb.getBoundingClientRect().top,
          right: tb.rows[0].cells[0].getBoundingClientRect().right };
      });
      const out = await reachForBubble(ctx.page, '.ed-tb-insert-col',
        { x: g.right, y: g.top + 10 }, { x: g.right, y: g.top }, 11);
      assert.ok(isLive(out.raised),
        'F7/欄 前提失敗：泡泡根本沒升起來，這一列什麼都沒量到，got ' + JSON.stringify(out.raised));
      assert.strictEqual(out.aim.col, '0',
        'F7/欄 前提失敗：泡泡瞄的不是第一欄的右緣，got ' + JSON.stringify(out.aim));
      assert.strictEqual(out.hides, 0,
        'F7/欄：伸手過去的路上泡泡不得自己消失，實際被藏起來的次數 ' + out.hides);
      assert.ok(out.reachable,
        'F7/欄：指標停在泡泡上時它必須還在、還點得到，got ' + JSON.stringify(out.rest));
      assert.strictEqual(ctx.errs.length, 0, 'F7/欄：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }

    // 同一條帶子上的第二個 body 層浮層：row grip 跨在表格左邊界上，它的
    // 矩形比泡泡寬，所以帶子裡有一小塊是「還在泡泡的觸發範圍內、但踩到的
    // 是 grip」。指標經過那裡時泡泡同樣不得消失。
    {
      const ctx = await newPage(F7_MD);
      await ctx.page.setViewport({ width: 1400, height: 1000 });
      const g = await ctx.page.evaluate(() => {
        const tb = document.querySelector('.ed-block[data-block-type="table"] table');
        return { left: tb.getBoundingClientRect().left,
          boundary: tb.tBodies[0].rows[0].getBoundingClientRect().bottom };
      });
      const out = await reachForBubble(ctx.page, '.ed-tb-insert-row',
        { x: g.left + 10, y: g.boundary + 5 }, { x: g.left + 9.5, y: g.boundary + 6 }, 1);
      assert.ok(isLive(out.raised),
        'F7/grip 前提失敗：泡泡根本沒升起來，這一列什麼都沒量到，got ' + JSON.stringify(out.raised));
      // 前提：指標停的那一點踩到的【真的】是 row grip。少了它，一個落在
      // 儲存格上的落點會讓下面兩條斷言原封不動地綠 —— 那條路徑由列泡泡
      // 自己那一列負責，grip 這一半就沒測到。
      const underPointer = await ctx.page.evaluate((p) => {
        const el = document.elementFromPoint(p.x, p.y);
        return el ? el.tagName + '.' + String(el.className || '') : 'null';
      }, { x: g.left + 9.5, y: g.boundary + 6 });
      assert.ok(underPointer.indexOf('ed-te-grip-row') !== -1,
        'F7/grip 前提失敗：指標停的那一點踩到的不是 row grip，got ' + underPointer);
      assert.strictEqual(out.hides, 0,
        'F7/grip：指標踩到 row grip 時泡泡不得消失，實際被藏起來的次數 ' + out.hides);
      assert.ok(out.reachable,
        'F7/grip：指標踩到 row grip 時泡泡必須還在、還點得到，got ' + JSON.stringify(out.rest));
      assert.strictEqual(ctx.errs.length, 0, 'F7/grip：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: the ＋ bubble survives you reaching for it — OK');
  }

  // ── backlog #11 (T14-5 closed): standing ON the ＋ bubble must not hide
  // the ⠿ row grip ────────────────────────────────────────────────────────
  // The F7 block above is the SYMMETRIC, already-fixed half: the BUBBLE
  // surviving the pointer's approach (updateTableInsertBubbles()). This is
  // the half T14-5 deferred — updateTableEdgeGrips()'s own guard did not
  // list '.ed-tb-insert', so once the pointer actually landed ON the bubble,
  // the GRIP fell through to hideTableGrips() and vanished, along with the
  // module-level refs (gripRowTableEl/gripRowEl) it needs to redraw itself
  // when the pointer leaves the bubble again.
  {
    const ctx = await newPage('# Doc\n\n| A | B |\n|---|---|\n| c1 | c2 |\n| c3 | c4 |\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    const headerCellPt = await ctx.page.evaluate(() => {
      const table = document.querySelector('.ed-block[data-block-type="table"] table');
      const th = table.tHead.rows[0].cells[0];
      const r = th.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ctx.page.mouse.move(headerCellPt.x, headerCellPt.y);
    await ctx.page.mouse.move(headerCellPt.x + 1, headerCellPt.y + 1);
    await new Promise((r) => setTimeout(r, 250));
    const gripBefore = await overlayState(ctx.page, '.ed-te-grip-row');
    assertRaised(gripBefore, '.ed-te-grip-row');

    // The row-insert bubble for "after the header row" — the one boundary
    // whose grip can ever be the HEADER row's (headerGripBlock()'s own gate).
    const rowBubblePt = await ctx.page.evaluate(() => {
      const table = document.querySelector('.ed-block[data-block-type="table"] table');
      const headerRow = table.tHead.rows[0];
      const r = headerRow.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return { x: tableRect.left, y: r.bottom };
    });
    await ctx.page.mouse.move(rowBubblePt.x, rowBubblePt.y, { steps: 3 });
    await new Promise((r) => setTimeout(r, 250));
    const onBubble = await ctx.page.evaluate(() => {
      const bubble = document.querySelector('.ed-tb-insert-row');
      const rowGrip = document.querySelector('.ed-te-grip-row');
      return { bubbleHidden: bubble.hidden, rowGripHidden: rowGrip.hidden };
    });
    assert.strictEqual(onBubble.bubbleHidden, false,
      '前提失敗：泡泡自己沒有升起來，got ' + JSON.stringify(onBubble));
    assert.strictEqual(onBubble.rowGripHidden, false,
      '指標停在 ＋ 泡泡上時 row grip 不得消失，got ' + JSON.stringify(onBubble));

    // Leaving the bubble back onto the header cell must still find a live,
    // correctly-anchored grip. Review round 2, M1: this does NOT prove the
    // module state survived the visit to the bubble — re-hovering the
    // header cell takes the onValidCell branch, which unconditionally
    // RECOMPUTES gripRowTableEl/gripRowEl/the grip's own rect from the cell,
    // so the same rect would come back even in a world where the bubble had
    // torn everything down and this test just rebuilt it. All the detecting
    // power for "did the grip survive" is in the onBubble.rowGripHidden
    // assertion above; this second check only guards that the grip still
    // functions normally afterward — a real, if weaker, regression net (a
    // gesture that left gripRowTableEl pointing at a stale/detached element
    // would fail it), just not proof of state continuity.
    await ctx.page.mouse.move(headerCellPt.x, headerCellPt.y);
    await ctx.page.mouse.move(headerCellPt.x - 1, headerCellPt.y);
    await new Promise((r) => setTimeout(r, 250));
    const gripAfter = await overlayState(ctx.page, '.ed-te-grip-row');
    assert.ok(isLive(gripAfter),
      '離開泡泡回到表頭儲存格後，row grip 必須恢復正常，got ' + JSON.stringify(gripAfter));
    assert.strictEqual(gripAfter.left, gripBefore.left,
      'row grip 的錨定必須沒被弄壞，got ' + JSON.stringify({ before: gripBefore, after: gripAfter }));

    assert.strictEqual(ctx.errs.length, 0, '不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: standing on the ＋ bubble no longer hides the row grip — OK');
  }

  // ── F5/F6: Tab 走完表格就離開它，落點是「整格被選起來」 ──────────────────
  //
  // F6 = 格內 Tab 的落點。舊行為把游標塞在目標格【結尾】，所以「Tab 過去直接
  // 打字」是附加而不是取代。
  // F5 = 最後一格的 Tab（與第一格的 Shift+Tab）是死鍵：索引被 clamp 回原格，
  // handler 照樣 preventDefault()，連瀏覽器自己的 Tab 巡覽都被吃掉。
  {
    const ctx = await newPage('# Doc\n\n| A | B |\n|---|---|\n| c1 | c2 |\n\nAfter paragraph.\n');
    await ctx.page.click('.ed-wys-table thead th');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.type('ZZ');
    await new Promise((r) => setTimeout(r, 250));
    const cell = await ctx.page.evaluate(() => document.activeElement.textContent.trim());
    assert.strictEqual(cell, 'ZZ',
      'F6：Tab 的落點必須是整格被選起來，打字取代而非附加；got ' + JSON.stringify(cell));
    // A → B → c1 → c2：再兩次 Tab 停在最後一格
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 200));
    const atLast = await ctx.page.evaluate(() => document.activeElement.textContent.trim());
    assert.strictEqual(atLast, 'c2',
      'F5 前提失敗：這一列要量的是【最後一格】的 Tab，可是走到的不是它，got ' + JSON.stringify(atLast));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 900));
    const out = await ctx.page.evaluate(() => {
      const a = document.activeElement;
      return { cls: a ? a.className : null, txt: a ? a.textContent.trim() : null };
    });
    assert.ok(out.cls && out.cls.indexOf('ed-wys-armed') !== -1,
      'F5：最後一格的 Tab 必須離開表格，落在下一個有可聚焦面的 block，got ' + JSON.stringify(out));
    assert.strictEqual(out.txt, 'After paragraph.',
      'F5：落點必須是那個段落本身，got ' + JSON.stringify(out));
    // 跨 block 的落點是【內容起點的游標】，不是整段選取 —— 打字插在最前面。
    await ctx.page.keyboard.type('QQ');
    await new Promise((r) => setTimeout(r, 300));
    const typed = await ctx.page.evaluate(() => document.activeElement.textContent);
    assert.strictEqual(typed, 'QQAfter paragraph.',
      'F5：跨 block 的落點必須是內容起點的游標，got ' + JSON.stringify(typed));
    assert.strictEqual(ctx.errs.length, 0, 'F5/F6：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: Tab walks the cells, selects each one, then leaves the table — OK');
  }

  // 頭尾對稱：第一格的 Shift+Tab 要往回跨出去。這一列的表格是【乾淨的】，所以
  // 走的是「沒有提交、目標元素從頭到尾沒被換掉」那一支。
  {
    const ctx = await newPage('Before paragraph.\n\n| A | B |\n|---|---|\n| c1 | c2 |\n\nAfter paragraph.\n');
    await ctx.page.click('.ed-wys-table thead th');
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.down('Shift');
    await ctx.page.keyboard.press('Tab');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 700));
    const out = await ctx.page.evaluate(() => {
      const a = document.activeElement;
      return { cls: a ? a.className : null, txt: a ? a.textContent.trim() : null };
    });
    assert.ok(out.cls && out.cls.indexOf('ed-wys-armed') !== -1,
      'F5：第一格的 Shift+Tab 必須離開表格，got ' + JSON.stringify(out));
    assert.strictEqual(out.txt, 'Before paragraph.',
      'F5：Shift+Tab 的落點必須是【前一個】有可聚焦面的 block，got ' + JSON.stringify(out));
    assert.strictEqual(ctx.errs.length, 0, 'F5/反向：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: Shift+Tab in the first cell leaves the table backwards — OK');
  }

  // ── T21 item 2: one more Tab after the landing moves on, it does not edit ─
  //
  // Task 15 gave Tab a cross-block landing and stopped there: the Tab AFTER
  // the landing was still read by the block it had just landed on, so a key
  // being used to navigate rewrote the document. Driven on the fixture
  // before the fix: the table's last body cell,
  // then Tab ×4, took '### Build snippet' to '######' and Ctrl+S wrote that;
  // backwards, Shift+Tab ×2 from the first header cell outdented
  // '  - epsilon' to '- epsilon' on disk. Both silent — a heading changing
  // size and the title's dot were the only tells.
  //
  // The two rows after these are the other half of the same switch: the
  // landing's mark is spent by anything that is not another Tab, so the
  // heading-depth and list-indent contracts are untouched for a block the
  // user is actually working in.
  {
    const ctx = await newPage('| A | B |\n|---|---|\n| c1 | c2 |\n\n### Build snippet\n\nAfter paragraph.\n');
    await ctx.page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      cells[cells.length - 1].focus();
    });
    await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; i < 4; i++) {
      await ctx.page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 450));
    }
    const out = await ctx.page.evaluate(() => {
      const h = document.querySelector('.ed-block[data-block-type="heading"] .ed-wys-armed');
      const a = document.activeElement;
      return { headingTag: h ? h.tagName : null, title: document.title,
        activeText: a ? a.textContent.trim() : null };
    });
    assert.strictEqual(out.headingTag, 'H3',
      'T21：走過標題的 Tab 不得改它的層級，got ' + JSON.stringify(out));
    assert.strictEqual(out.activeText, 'After paragraph.',
      'T21：後續的 Tab 必須【繼續走】到下一個 block，不是停在標題上，got ' + JSON.stringify(out));
    assert.strictEqual(out.title.indexOf('●'), -1,
      'T21：只是走過去不得把文件弄髒，got ' + JSON.stringify(out));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('### Build snippet') !== -1,
      'T21：磁碟上的標題必須原封不動，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'T21/Tab：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: T21 a Tab after the landing keeps walking, it does not retitle — OK');
  }

  {
    const ctx = await newPage('- alpha\n  - epsilon\n\n| A | B |\n|---|---|\n| c1 | c2 |\n');
    await ctx.page.evaluate(() => { document.querySelectorAll('.ed-wys-cell')[0].focus(); });
    await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.down('Shift');
      await ctx.page.keyboard.press('Tab');
      await ctx.page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 450));
    }
    const out = await ctx.page.evaluate(() => {
      const lis = Array.from(document.querySelectorAll('.ed-block[data-block-type="li"]'))
        .map((b) => b.getAttribute('data-indent') + ':' + b.textContent.trim().replace(/[＋⠿]/g, ''));
      const a = document.activeElement;
      return { lis, title: document.title, activeText: a ? a.textContent.trim() : null };
    });
    assert.deepStrictEqual(out.lis, ['0:alpha', '1:epsilon'],
      'T21：走過清單項目的 Shift+Tab 不得改它的縮排，got ' + JSON.stringify(out));
    assert.strictEqual(out.activeText, 'alpha',
      'T21：後續的 Shift+Tab 必須【繼續往回走】，got ' + JSON.stringify(out));
    const disk = await saveAndRead(ctx);
    assert.ok(disk.indexOf('  - epsilon') !== -1,
      'T21：磁碟上的縮排必須原封不動，got:\n' + disk);
    assert.strictEqual(ctx.errs.length, 0, 'T21/Shift+Tab：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: T21 a Shift+Tab after the landing keeps walking backwards — OK');
  }

  // The mark is spent by any key that is not Tab: type into the block you
  // landed on and Tab means heading depth again.
  {
    const ctx = await newPage('| A | B |\n|---|---|\n| c1 | c2 |\n\n### Build snippet\n\nAfter paragraph.\n');
    await ctx.page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      cells[cells.length - 1].focus();
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 450));
    await ctx.page.keyboard.type('X');
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 450));
    const tag = await ctx.page.evaluate(() => {
      const h = document.querySelector('.ed-block[data-block-type="heading"] .ed-wys-armed');
      return h ? h.tagName : null;
    });
    assert.strictEqual(tag, 'H4',
      'T21：在落點上打過字之後，Tab 必須恢復成「改標題層級」，got ' + JSON.stringify(tag));
    await ctx.page.close(); ctx.srv.close();
  }

  // ...and by pointing at it. A click that lands on the same surface does not
  // open a new burst, so nothing else would clear the mark.
  {
    const ctx = await newPage('| A | B |\n|---|---|\n| c1 | c2 |\n\n### Build snippet\n\nAfter paragraph.\n');
    await ctx.page.evaluate(() => {
      const cells = document.querySelectorAll('.ed-wys-cell');
      cells[cells.length - 1].focus();
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 450));
    await pressClick(ctx.page, '.ed-block[data-block-type="heading"] .ed-wys-armed', 80);
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 450));
    const tag = await ctx.page.evaluate(() => {
      const h = document.querySelector('.ed-block[data-block-type="heading"] .ed-wys-armed');
      return h ? h.tagName : null;
    });
    assert.strictEqual(tag, 'H4',
      'T21：在落點上點過一下之後，Tab 必須恢復成「改標題層級」，got ' + JSON.stringify(tag));
    assert.strictEqual(ctx.errs.length, 0, 'T21/clear：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: T21 the landing mark is spent by typing and by pointing — OK');
  }

  // 降級 block（圍欄、引言、分隔線）沒有可聚焦面，Tab 要跳過它們；下一個
  // 表格的落點是它的【第一格】。
  {
    const ctx = await newPage('| A | B |\n|---|---|\n| c1 | c2 |\n\n```js\nconst x = 1;\n```\n\n' +
      '> a quote\n\n---\n\n| P | Q |\n|---|---|\n| p1 | q1 |\n');
    await ctx.page.evaluate(() => {
      const t = document.querySelectorAll('.ed-wys-table')[0];
      const cells = t.querySelectorAll('th, td');
      cells[cells.length - 1].focus();
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 700));
    const out = await ctx.page.evaluate(() => {
      const a = document.activeElement;
      const t2 = document.querySelectorAll('.ed-wys-table')[1];
      return { cls: a ? a.className : null, txt: a ? a.textContent.trim() : null,
        isSecondTablesFirstCell: !!t2 && t2.querySelectorAll('th, td')[0] === a };
    });
    assert.ok(out.cls && out.cls.indexOf('ed-wys-cell') !== -1,
      'F5：Tab 必須跳過降級 block，落在下一個表格的儲存格，got ' + JSON.stringify(out));
    assert.ok(out.isSecondTablesFirstCell,
      'F5：跨進表格的落點必須是它的第一格，got ' + JSON.stringify(out));
    assert.strictEqual(ctx.errs.length, 0, 'F5/跳過降級：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: Tab skips degraded blocks and lands in the next table — OK');
  }

  // T15-7：後面沒有任何有可聚焦面的 block 時原地不動，而且【繼續】
  // preventDefault() —— 交還給瀏覽器的 Tab 會走進每個區塊後面的 gutter 按鈕。
  //
  // 這一列是【存活保證】，不是缺陷列：修之前它就是綠的，因為被 clamp 回原格的
  // 死鍵在螢幕上跟「找不到落點所以不動」長得一模一樣。它會紅的對象是一個把這
  // 個按鍵交還給瀏覽器的修法 —— 已用「Tab 分支不呼叫 preventDefault()」單獨
  // ablate 過，那一改就讓它紅。
  {
    const ctx = await newPage('| A | B |\n|---|---|\n| c1 | c2 |\n\n```js\nconst x = 1;\n```\n');
    await ctx.page.evaluate(() => {
      window.__tabPrevented = null;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') window.__tabPrevented = e.defaultPrevented;
      });
      const cells = document.querySelectorAll('.ed-wys-cell');
      cells[cells.length - 1].focus();
    });
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 600));
    const out = await ctx.page.evaluate(() => ({
      prevented: window.__tabPrevented,
      cls: document.activeElement ? document.activeElement.className : null,
      txt: document.activeElement ? document.activeElement.textContent.trim() : null,
    }));
    assert.strictEqual(out.prevented, true,
      'T15-7：找不到落點時 Tab 仍必須被吃掉，got ' + JSON.stringify(out));
    assert.ok(out.cls && out.cls.indexOf('ed-wys-cell') !== -1 && out.txt === 'c2',
      'T15-7：找不到落點時必須原地不動，got ' + JSON.stringify(out));
    assert.strictEqual(ctx.errs.length, 0, 'T15-7：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: Tab with nowhere to go stays put and stays swallowed — OK');
  }

  // T15-5：Tab 造出來的整格選取不得讓浮動的 .ed-seltb 每按一次就彈一次；
  // 使用者自己重新選一次同樣的範圍時它必須照樣出現。
  {
    const ctx = await newPage(
      '# Doc\n\n| Alpha | Beta |\n|---|---|\n| c1 | GammaGammaGamma |\n\nAfter paragraph.\n');
    await ctx.page.click('.ed-wys-table thead th');
    await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; i < 3; i++) {   // Alpha → Beta → c1 → GammaGammaGamma
      await ctx.page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 250));
    const sup = await ctx.page.evaluate(() => {
      const b = document.querySelector('.ed-toolbar-btn[data-ed-tb="bold"]');
      return { seltb: !!document.querySelector('.ed-seltb'),
        selText: String(window.getSelection()), boldEnabled: !!b && !b.disabled };
    });
    assert.strictEqual(sup.selText, 'GammaGammaGamma',
      'T15-5 前提失敗：Tab 之後選起來的必須是整格，這一列什麼都沒量到，got ' + JSON.stringify(sup));
    assert.strictEqual(sup.seltb, false,
      'T15-5：Tab 造出來的整格選取不得讓 .ed-seltb 彈出來，got ' + JSON.stringify(sup));
    assert.strictEqual(sup.boldEnabled, true,
      'T15-5：.ed-seltb 被抑制時，主工具列的 B 仍必須是可按的，got ' + JSON.stringify(sup));

    // T15-6 的殘留，量到的成因是【瀏覽器自己】而不是這個抑制：在已經有選取的
    // 地方按下去再拖，Chromium 起的是「把選取的文字拖走」，dragstart 就位、全程
    // 一次 selectionchange 也沒有 —— 抑制在不在都一樣。
    const geom = await ctx.page.evaluate(() => {
      window.__dnd = [];
      ['dragstart', 'dragend'].forEach((t) =>
        document.addEventListener(t, () => window.__dnd.push(t)));
      const tn = document.querySelectorAll('.ed-wys-cell')[3].firstChild;
      const r = document.createRange();
      r.selectNodeContents(tn);
      const rect = r.getBoundingClientRect();
      return { l: rect.left, r: rect.right, y: rect.top + rect.height / 2 };
    });
    await ctx.page.mouse.move(geom.l + 1, geom.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move((geom.l + geom.r) / 2, geom.y);
    await ctx.page.mouse.move(geom.r - 1, geom.y);
    await ctx.page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    const inside = await ctx.page.evaluate(() => ({
      dnd: window.__dnd.slice(), seltb: !!document.querySelector('.ed-seltb') }));
    assert.ok(inside.dnd.indexOf('dragstart') !== -1,
      'T15-6 前提失敗：從選取【內部】按下去起的應該是瀏覽器的文字拖曳，' +
      '這一列的殘留說明就沒有量到，got ' + JSON.stringify(inside));

    // 使用者先點一下（選取塌成游標）再拖 —— 抑制必須解除。
    await ctx.page.mouse.click((geom.l + geom.r) / 2, geom.y);
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.mouse.move(geom.l + 1, geom.y);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move((geom.l + geom.r) / 2, geom.y);
    await ctx.page.mouse.move(geom.r - 1, geom.y);
    await ctx.page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    const rel = await ctx.page.evaluate(() => ({
      seltb: !!document.querySelector('.ed-seltb'), selText: String(window.getSelection()) }));
    assert.strictEqual(rel.selText, 'GammaGammaGamma',
      'T15-6 前提失敗：先點一下再拖沒有選到整格，got ' + JSON.stringify(rel));
    assert.strictEqual(rel.seltb, true,
      'T15-6：使用者自己重新選取整格內容時 .ed-seltb 必須出現，got ' + JSON.stringify(rel));
    assert.strictEqual(ctx.errs.length, 0, 'T15-5：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the Tab selection keeps .ed-seltb down, a hand-made one raises it — OK');
  }

  // 同一個解除條件，改走鍵盤（沒有滑鼠、沒有瀏覽器的文字拖曳可以混淆）：
  // ArrowLeft 把選取塌成游標，Shift+End 再選回一模一樣的整格內容。
  {
    const ctx = await newPage(
      '# Doc\n\n| Alpha | Beta |\n|---|---|\n| c1 | GammaGammaGamma |\n\nAfter paragraph.\n');
    await ctx.page.click('.ed-wys-table thead th');
    await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; i < 3; i++) {
      await ctx.page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 250));
    const sup = await ctx.page.evaluate(() => ({
      seltb: !!document.querySelector('.ed-seltb'), selText: String(window.getSelection()) }));
    assert.strictEqual(sup.selText, 'GammaGammaGamma',
      'T15-5/鍵盤 前提失敗：Tab 之後選起來的必須是整格，got ' + JSON.stringify(sup));
    assert.strictEqual(sup.seltb, false,
      'T15-5/鍵盤：Tab 造出來的整格選取不得讓 .ed-seltb 彈出來，got ' + JSON.stringify(sup));
    await ctx.page.keyboard.press('ArrowLeft');
    await new Promise((r) => setTimeout(r, 300));
    await ctx.page.keyboard.down('Shift');
    await ctx.page.keyboard.press('End');
    await ctx.page.keyboard.up('Shift');
    await new Promise((r) => setTimeout(r, 400));
    const rel = await ctx.page.evaluate(() => ({
      seltb: !!document.querySelector('.ed-seltb'), selText: String(window.getSelection()) }));
    assert.strictEqual(rel.selText, 'GammaGammaGamma',
      'T15-6/鍵盤 前提失敗：Shift+End 沒有選回整格，got ' + JSON.stringify(rel));
    assert.strictEqual(rel.seltb, true,
      'T15-6/鍵盤：使用者自己選回整格內容時 .ed-seltb 必須出現，got ' + JSON.stringify(rel));
    assert.strictEqual(ctx.errs.length, 0, 'T15-5/鍵盤：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: collapsing then reselecting by keyboard raises .ed-seltb again — OK');
  }

  // ── Task 9 backlog #6: quote / code / line strand the caret on BODY after
  // activation, with nothing to click into and (by keyboard) nowhere to Tab
  // to; undo / redo / image do the same ONLY when there is an uncommitted
  // edit (switchAwayFrom()'s own commit-and-render is what drops it). Every
  // case below is driven through pressClick() (real press-hold-release,
  // §0's own "dirty burst + real press timing" class of defect) rather than
  // a synthetic .click(), since three of the six scenarios are dirty bursts.
  {
    const sel = '.ed-block[data-block-type="paragraph"] .ed-wys-armed';

    // quote / code / line: a CLEAN burst (just a click, no typing) is enough
    // — activateToolbarCursor()'s own comment: "quote, code and line end on
    // BODY … with a clean burst and with a dirty one alike." Each id gets
    // its own fresh page (converting/inserting once is enough per id).
    for (const id of ['quote', 'code', 'line']) {
      const c = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
      await c.page.click(sel);
      await new Promise((r) => setTimeout(r, 200));
      await pressClick(c.page, '.ed-toolbar [data-ed-tb="' + id + '"]', 80);
      await new Promise((r) => setTimeout(r, 300));
      const tag = await c.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'BODY',
        'T9-6 (' + id + ')：按完不得把 caret 留在 BODY，got ' + JSON.stringify({ tag }));
      // The raw editor is quote/code/line's real (only) editing surface —
      // prove it actually took the caret, not merely SOME element.
      assert.strictEqual(tag, 'TEXTAREA',
        'T9-6 (' + id + ')：caret 必須落在該 block 自己的 raw editor 裡，got ' + JSON.stringify({ tag }));
      assert.strictEqual(c.errs.length, 0, 'T9-6 (' + id + ')：不得有 pageerror: ' + c.errs.join(' | '));
      await c.page.close(); c.srv.close();
    }

    // undo over a DIRTY burst: switchAwayFrom()'s own auto-commit-then-
    // render is what drops the caret — see undoViaToolbar()'s own comment.
    {
      const c = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
      await c.page.click(sel);
      await new Promise((r) => setTimeout(r, 200));
      await c.page.keyboard.press('End');
      await c.page.keyboard.type(' PRIMED');
      await new Promise((r) => setTimeout(r, 200));
      await pressClick(c.page, '.ed-toolbar [data-ed-tb="undo"]', 80);
      await new Promise((r) => setTimeout(r, 300));
      const tag = await c.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'BODY',
        'T9-6 (undo/dirty)：按完不得把 caret 留在 BODY，got ' + JSON.stringify({ tag }));
      assert.strictEqual(c.errs.length, 0, 'T9-6 (undo/dirty)：不得有 pageerror: ' + c.errs.join(' | '));
      await c.page.close(); c.srv.close();
    }

    // image over a DIRTY burst: imageViaToolbar()'s own await resolves right
    // after switchAwayFrom(), well before any file is actually chosen — the
    // native file dialog is swallowed so this probes the same caret-drop
    // point without needing a real file chooser.
    {
      const c = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
      await c.page.click(sel);
      await new Promise((r) => setTimeout(r, 200));
      await c.page.keyboard.press('End');
      await c.page.keyboard.type(' DIRTY');
      await new Promise((r) => setTimeout(r, 200));
      await c.page.evaluate(() => {
        HTMLInputElement.prototype.click = function () {
          if (this.type === 'file') return;
          return HTMLElement.prototype.click.call(this);
        };
      });
      await pressClick(c.page, '.ed-toolbar [data-ed-tb="image"]', 80);
      await new Promise((r) => setTimeout(r, 300));
      const tag = await c.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'BODY',
        'T9-6 (image/dirty)：按完不得把 caret 留在 BODY，got ' + JSON.stringify({ tag }));
      assert.strictEqual(c.errs.length, 0, 'T9-6 (image/dirty)：不得有 pageerror: ' + c.errs.join(' | '));
      await c.page.close(); c.srv.close();
    }

    console.log('journey: quote/code/line and undo/image over a dirty burst give the caret back — OK');
  }

  // ── Task 9 backlog #7: the H▾ dropdown's six items must be reachable and
  // operable by keyboard, not mouse-only. ArrowDown/ArrowUp now move a
  // cursor INSIDE the open panel (own index, own attribute
  // data-ed-tb-menu-cursor — the bar's own toolbarRovingIndex stays parked
  // on `headings` throughout, per K6's own pinned assertion a few dozen
  // lines above this one), and Enter/Space activate the highlighted item —
  // but ONLY once the panel cursor has actually moved. With nothing
  // highlighted yet, Enter/Space still just toggle the H▾ button itself
  // (K6's exact pinned shape), so this row is deliberately layered on top of
  // K6 rather than replacing any of it.
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const enterKeynav = async () => {
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('F10');
      await ctx.page.keyboard.up('Alt');
      await new Promise((r) => setTimeout(r, 150));
    };
    const menuState = () => ctx.page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.ed-toolbar-menu-btn'));
      return {
        open: !!document.querySelector('.ed-toolbar-menu'),
        at: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
        cursorIdx: items.findIndex((b) => b.hasAttribute('data-ed-tb-menu-cursor')),
      };
    });

    await ctx.page.click('.ed-block[data-block-type="paragraph"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    await enterKeynav();
    let at = await ctx.page.evaluate(() =>
      document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    let guard = 0;
    while (at !== 'headings' && guard++ < 30) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 120));
      at = await ctx.page.evaluate(() =>
        document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    }
    assert.strictEqual(at, 'headings', 'T9-7 前提失敗：走不到 headings 按鈕，got ' + at);

    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 300));
    const opened = await menuState();
    assert.strictEqual(opened.open, true, 'T9-7：Enter 必須打開 H▾ 面板，got ' + JSON.stringify(opened));
    assert.strictEqual(opened.cursorIdx, -1,
      'T9-7：剛打開時面板裡不得有任何項目帶游標，got ' + JSON.stringify(opened));

    await ctx.page.keyboard.press('ArrowDown');
    await new Promise((r) => setTimeout(r, 200));
    const firstItem = await menuState();
    assert.strictEqual(firstItem.cursorIdx, 0,
      'T9-7：ArrowDown 必須把面板游標移到第一項（標題 1），got ' + JSON.stringify(firstItem));

    await ctx.page.keyboard.press('ArrowDown');
    await new Promise((r) => setTimeout(r, 200));
    const secondItem = await menuState();
    assert.strictEqual(secondItem.cursorIdx, 1,
      'T9-7：再一次 ArrowDown 必須移到第二項（標題 2），got ' + JSON.stringify(secondItem));

    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 400));
    const afterActivate = await menuState();
    assert.strictEqual(afterActivate.open, false,
      'T9-7：Enter 在已高亮的項目上必須把面板收起來，got ' + JSON.stringify(afterActivate));
    const converted = await ctx.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.ed-block'))
        .find((b) => (b.textContent || '').indexOf('Alpha paragraph') !== -1);
      const h = el && el.querySelector('h1,h2,h3,h4,h5,h6');
      return { type: el && el.getAttribute('data-block-type'), tag: h ? h.tagName : null };
    });
    assert.deepStrictEqual(converted, { type: 'heading', tag: 'H2' },
      'T9-7：鍵盤選到的第二項必須真的把該區塊轉成 H2，got ' + JSON.stringify(converted));
    assert.strictEqual(ctx.errs.length, 0, 'T9-7：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: the H▾ dropdown items are keyboard-reachable — OK');
  }

  // ── Task 9 backlog #9: the outline drawer had a keyboard route to OPEN
  // it (the toolbar's `outline` button, reachable since F12 keynav shipped)
  // but none to OPERATE what is inside it — TOC links and the search box.
  // A bare Tab with nothing focused is deliberately swallowed elsewhere in
  // this file (§3.5's block-indent contract), so a keyboard user who never
  // clicked into a real control had no Tab destination once the drawer was
  // open. Fix: activating `outline` BY KEYBOARD moves real DOM focus onto
  // `#doc-search-input` (lib/md2doc.js's reader-sidebar markup) — scoped to
  // the keyboard path only, so a mouse click on the same button still does
  // not steal focus from whatever burst the mouse user had open.
  {
    const ctx = await newPage(
      '# Doc\n\n## Section One\n\nAlpha paragraph.\n\n## Section Two\n\nBravo paragraph.\n');
    const enterKeynav = async () => {
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('F10');
      await ctx.page.keyboard.up('Alt');
      await new Promise((r) => setTimeout(r, 150));
    };
    const activeInfo = () => ctx.page.evaluate(() => {
      const ae = document.activeElement;
      return { tag: ae ? ae.tagName : null, id: ae ? ae.id : null };
    });

    await enterKeynav();
    let at = await ctx.page.evaluate(() =>
      document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    let guard = 0;
    while (at !== 'outline' && guard++ < 30) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 120));
      at = await ctx.page.evaluate(() =>
        document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    }
    assert.strictEqual(at, 'outline', 'T9-9 前提失敗：走不到 outline 按鈕，got ' + at);

    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 300));
    const afterOpen = await activeInfo();
    assert.strictEqual(afterOpen.id, 'doc-search-input',
      'T9-9：鍵盤打開抽屜後真實 DOM focus 必須落在 #doc-search-input，got ' + JSON.stringify(afterOpen));

    await ctx.page.keyboard.type('Alpha');
    await new Promise((r) => setTimeout(r, 200));
    const searchVal = await ctx.page.evaluate(() =>
      (document.getElementById('doc-search-input') || {}).value);
    assert.strictEqual(searchVal, 'Alpha',
      'T9-9：打開抽屜之後打字必須落進 search box，got ' + JSON.stringify(searchVal));
    assert.strictEqual(ctx.errs.length, 0, 'T9-9：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: opening the outline drawer by keyboard lands inside it — OK');
  }

  // ── Task 9 backlog #10: a stray key must not silently drop the toolbar's
  // keyboard cursor. MEASURED (v3.3.0): ArrowUp / ArrowDown / Tab / Home /
  // End / 'a' / Backspace all dropped [data-ed-tb-cursor] AND the bar's own
  // data-ed-tb-keynav with nothing on screen marking it — the bar looked
  // exactly as it did before Alt+F10 was pressed. The fix does BOTH halves
  // of v3.3.0's own ruling ("一併處理，加上可見的信號"): Home/End now move
  // the cursor to the first/last enabled button (a useful thing to do with
  // them, not merely "harmless"), and every OTHER stray key still exits the
  // mode but now raises a visible .ed-conflict banner saying so — EXCEPT
  // Tab (review I3, below this row): Tab is asserted separately since it
  // exits keynav WITHOUT a banner (a legitimate ARIA-toolbar "leave"
  // gesture, not a stray key with nowhere to go).
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    const enterKeynav = async () => {
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('F10');
      await ctx.page.keyboard.up('Alt');
      await new Promise((r) => setTimeout(r, 150));
    };
    const cursorState = () => ctx.page.evaluate(() => ({
      cursor: !!document.querySelector('[data-ed-tb-cursor]'),
      keynav: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      banner: !!document.querySelector('.ed-conflict'),
    }));
    // Task 9 review I3: `Tab` is asserted separately below — it exits
    // keynav WITHOUT a banner (a legitimate ARIA-toolbar "leave" gesture,
    // not a stray key with nowhere to go — Tab moving real DOM focus IS
    // its own visible signal), so it no longer belongs in this shared loop.
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'a', 'Backspace']) {
      // Known clean slate: Escape exits keynav if a prior iteration left it
      // on (Home/End no longer exit it), and dismiss any leftover banner —
      // otherwise Alt+F10's own toggle semantics would turn THIS iteration's
      // entry chord into an exit instead.
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 150));
      await ctx.page.evaluate(() => {
        const b = document.querySelector('.ed-conflict button');
        if (b) b.click();
      });
      await new Promise((r) => setTimeout(r, 150));
      await enterKeynav();
      const before = await cursorState();
      assert.ok(before.cursor, key + '：前提失敗 —— Alt+F10 沒有點亮鍵盤游標，got ' +
        JSON.stringify(before));
      await ctx.page.keyboard.press(key);
      await new Promise((r) => setTimeout(r, 200));
      const after = await cursorState();
      assert.ok(after.cursor || after.banner,
        key + ' 不得靜靜丟掉鍵盤游標 —— 要嘛游標還在，要嘛有可見的信號，got ' +
        JSON.stringify(after));
    }

    // Tab (review I3): exits keynav cleanly with NO banner.
    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 150));
    await ctx.page.evaluate(() => {
      const b = document.querySelector('.ed-conflict button');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 150));
    await enterKeynav();
    const beforeTab = await cursorState();
    assert.ok(beforeTab.cursor, 'Tab：前提失敗 —— Alt+F10 沒有點亮鍵盤游標，got ' + JSON.stringify(beforeTab));
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 200));
    const afterTab = await cursorState();
    assert.deepStrictEqual(afterTab, { cursor: false, keynav: null, banner: false },
      'Tab 必須乾淨退出 keynav、不升 banner，got ' + JSON.stringify(afterTab));

    assert.strictEqual(ctx.errs.length, 0, 'T9-10：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: a stray key inside toolbar keynav says the cursor is going away — OK');
  }

  // ── Task 9 review I2: #9 lands real focus in #doc-search-input while
  // toolbarRovingIndex stays >= 0 (F12's cursor is virtual, so nothing
  // clears it just because real focus moved) — and #10 taught Home/End to
  // navigate the bar. Combined, a keyboard user who opens the drawer and
  // immediately presses Home/End/ArrowLeft to edit their search text gets
  // the BAR's cursor moving instead of the input's own text cursor. Fixed
  // by toolbarKeynavBlockedByRealControl(): any keydown while a genuine
  // standalone control (INPUT/TEXTAREA/SELECT) holds focus quietly ends
  // keynav first, with no banner (this is legitimate control use, not a
  // stray key with nowhere to go).
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const enterKeynav = async () => {
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('F10');
      await ctx.page.keyboard.up('Alt');
      await new Promise((r) => setTimeout(r, 150));
    };
    const searchState = () => ctx.page.evaluate(() => {
      const s = document.getElementById('doc-search-input');
      return {
        active: document.activeElement === s,
        selectionStart: s ? s.selectionStart : null,
        keynav: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
      };
    });

    await enterKeynav();
    let at = await ctx.page.evaluate(() =>
      document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    let guard = 0;
    while (at !== 'outline' && guard++ < 30) {
      await ctx.page.keyboard.press('ArrowRight');
      await new Promise((r) => setTimeout(r, 120));
      at = await ctx.page.evaluate(() =>
        document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    }
    await ctx.page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 300));

    await ctx.page.evaluate(() => {
      const s = document.getElementById('doc-search-input');
      s.value = 'needle';
      s.setSelectionRange(6, 6);
    });
    await new Promise((r) => setTimeout(r, 150));

    await ctx.page.keyboard.press('Home');
    await new Promise((r) => setTimeout(r, 200));
    const afterHome = await searchState();
    assert.strictEqual(afterHome.selectionStart, 0,
      'I2：Home 必須移動搜尋框自己的文字游標，不得被工具列吃掉，got ' + JSON.stringify(afterHome));
    assert.strictEqual(afterHome.active, true,
      'I2：真實 focus 必須還在搜尋框上，got ' + JSON.stringify(afterHome));
    assert.strictEqual(ctx.errs.length, 0, 'I2：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: a real control focused inside the drawer keeps its own keys — OK');
  }

  // ── Task 9 review I3: the keynav-exit banner (backlog #10) sits at
  // z-index:999 over the toolbar's own z-index:101 — MEASURED, 22-23 of 23
  // buttons' own centre points hit-test to the banner, not the button — and
  // a keyboard user had no way to take it down (Escape did not dismiss it,
  // and a bare Tab is swallowed elsewhere with nothing real focused). Fix:
  // Escape now dismisses it (dismissKeynavExitBanner()), and Tab — a
  // legitimate "leave the toolbar" gesture per the ARIA toolbar pattern,
  // not a stray key with nowhere to go — no longer raises it at all (it
  // still exits keynav, unchanged).
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    const enterKeynav = async () => {
      await ctx.page.keyboard.down('Alt');
      await ctx.page.keyboard.press('F10');
      await ctx.page.keyboard.up('Alt');
      await new Promise((r) => setTimeout(r, 150));
    };
    const state = () => ctx.page.evaluate(() => ({
      banner: !!document.querySelector('.ed-conflict'),
      keynav: document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'),
    }));

    await enterKeynav();
    await ctx.page.keyboard.press('ArrowUp');
    await new Promise((r) => setTimeout(r, 250));
    const afterStray = await state();
    assert.strictEqual(afterStray.banner, true,
      'I3 前提失敗：真正無處可去的鍵仍必須升起 banner，got ' + JSON.stringify(afterStray));

    await ctx.page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 250));
    const afterEscape = await state();
    assert.strictEqual(afterEscape.banner, false,
      'I3：Escape 必須能收掉 keynav-exit banner，got ' + JSON.stringify(afterEscape));

    await enterKeynav();
    await ctx.page.keyboard.press('Tab');
    await new Promise((r) => setTimeout(r, 250));
    const afterTab = await state();
    assert.strictEqual(afterTab.keynav, null, 'I3：Tab 仍必須退出 keynav，got ' + JSON.stringify(afterTab));
    assert.strictEqual(afterTab.banner, false,
      'I3：Tab 是合法離開手勢，不得升起 banner，got ' + JSON.stringify(afterTab));
    assert.strictEqual(ctx.errs.length, 0, 'I3：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: Escape dismisses the keynav banner, Tab never raises it — OK');
  }

  // ── Task 10 (backlog #8): "banner 升起時工具列整條打不到". `.ed-conflict`
  // is `position:fixed; top:0; z-index:999`, and `.ed-toolbar` is
  // `top:0; height:44px; z-index:101` — same band, banner wins the paint.
  // MEASURED (task-10-toolbar-probe.js) before the fix: ALL 23 toolbar
  // buttons' own centre points hit-tested to the banner, not the button,
  // for BOTH the keynav-exit banner (Task 9's #10) and the real
  // save-conflict banner (showConflictBanner()) — `.ed-conflict` has
  // exactly one producer (showBanner()), shared by every banner family, so
  // a fix scoped to one message would not have proven anything about the
  // others. Fix: `.ed-conflict` now sits at `top: var(--ed-toolbar-h)`
  // (lib/md2doc.js) — the same floor `.ed-te-menu`/`.ed-seltb` already use
  // to stay out of that band — so it renders as a band directly BELOW the
  // toolbar instead of on top of it. Not a z-index change: the banner is
  // still the topmost thing on the page, it simply no longer shares the
  // toolbar's own band to be on top OF.
  {
    const ctx = await newPage('# H\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });
    const BUTTON_IDS = [
      'save', 'undo', 'redo', 'headings', 'quote', 'code', 'list', 'ordered-list',
      'check', 'bold', 'italic', 'strike', 'inline-code', 'link', 'outdent',
      'indent', 'table', 'insert-before', 'insert-after', 'line', 'image',
      'outline', 'preview',
    ];
    const hitTestAllButtons = () => ctx.page.evaluate((ids) => {
      const out = {};
      for (const id of ids) {
        const b = document.querySelector('.ed-toolbar [data-ed-tb="' + id + '"]');
        if (!b) { out[id] = 'MISSING'; continue; }
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[id] = (el === b) ? 'own-button'
          : (el && el.closest && el.closest('.ed-conflict')) ? 'BANNER'
          : (el ? el.tagName + '.' + (el.className || '') : 'null');
      }
      return out;
    }, BUTTON_IDS);
    const bannerCount = (hits) => Object.values(hits).filter((v) => v === 'BANNER').length;

    // Trigger 1: the keynav-exit banner — Alt+F10 into keynav mode, then a
    // stray key with nowhere to go (ArrowUp).
    await ctx.page.keyboard.down('Alt');
    await ctx.page.keyboard.press('F10');
    await ctx.page.keyboard.up('Alt');
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.keyboard.press('ArrowUp');
    await new Promise((r) => setTimeout(r, 250));
    const bannerUp1 = await ctx.page.evaluate(() => !!document.querySelector('.ed-conflict'));
    assert.strictEqual(bannerUp1, true,
      'T10 前提失敗：keynav-exit banner 沒有升起');
    const hits1 = await hitTestAllButtons();
    assert.strictEqual(bannerCount(hits1), 0,
      'T10：keynav-exit banner 升起時，23 顆工具列按鈕必須仍打得到自己，got ' +
      JSON.stringify(hits1));

    // Dismiss and switch to trigger 2: the real save-conflict banner
    // (showConflictBanner(), via a closed server under an in-flight commit).
    await ctx.page.evaluate(() => {
      const b = document.querySelector('.ed-conflict button');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 200));
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' X');
    ctx.srv.close();
    await new Promise((r) => setTimeout(r, 250));
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForSelector('.ed-conflict', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 200));
    const hits2 = await hitTestAllButtons();
    assert.strictEqual(bannerCount(hits2), 0,
      'T10：真正的存檔衝突 banner 升起時，23 顆工具列按鈕必須仍打得到自己，got ' +
      JSON.stringify(hits2));

    assert.strictEqual(ctx.errs.length, 0, 'T10：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close();
    console.log('journey: the toolbar is still reachable under any banner — OK');
  }

  // ── Task 10 follow-up: moving `.ed-conflict` to `top: var(--ed-toolbar-h)`
  // puts it in the SAME band `.ed-toolbar-menu` (the H▾ dropdown) already
  // floats in (`top = r.bottom + 4`, i.e. right at that floor) — without a
  // mitigation, raising a banner while the dropdown is open would reproduce
  // backlog #8 one layer down. showBanner() now also closes
  // hideTableGrips()/hideTableInsertBubbles()/hideTableEdgeMenu()/
  // closeToolbarMenu() (the same bundle onAnyScroll() already uses)
  // whenever a new banner appears, so the dropdown is gone, not painted
  // over. MEASURED (task-10-menu-collision-probe.js) with those four calls
  // temporarily removed: the dropdown stayed open (`.ed-toolbar-menu`
  // present) while the banner covered it — a real regression this row pins.
  {
    const ctx = await newPage('# H\n\nAlpha paragraph.\n\nBravo paragraph.\n');
    await ctx.page.setViewport({ width: 1400, height: 900 });

    // Arm the block and type into it FIRST (uncommitted) so committing
    // later needs no second click on the block — a second click would
    // itself go through wireToolbarTracking()'s own "click outside
    // .ed-toolbar/.ed-toolbar-menu closes the menu" handler and pass this
    // row for the wrong reason. Toolbar buttons preventDefault() on
    // mousedown specifically so clicking one does not steal focus from the
    // content (buildToolbar()'s own comment), so real DOM focus stays in
    // this block through the dropdown click below.
    await ctx.page.click('.ed-block[data-block-id="1"] .ed-wys-armed');
    await ctx.page.keyboard.type(' X');
    await new Promise((r) => setTimeout(r, 150));

    await ctx.page.click('.ed-toolbar [data-ed-tb="headings"]');
    await new Promise((r) => setTimeout(r, 200));
    const menuOpenBefore = await ctx.page.evaluate(() => !!document.querySelector('.ed-toolbar-menu'));
    assert.strictEqual(menuOpenBefore, true, 'T10 前提失敗：H▾ 選單沒有打開');

    // Raise the real conflict banner via Enter (a keydown, not a click) —
    // the only thing that can close the dropdown here is showBanner()'s
    // own closeToolbarMenu() call.
    ctx.srv.close();
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForSelector('.ed-conflict', { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 200));
    const after = await ctx.page.evaluate(() => ({
      banner: !!document.querySelector('.ed-conflict'),
      menu: !!document.querySelector('.ed-toolbar-menu'),
    }));
    assert.strictEqual(after.banner, true, 'T10：banner 必須升起，got ' + JSON.stringify(after));
    assert.strictEqual(after.menu, false,
      'T10：showBanner() 必須收掉開著的 H▾ 選單，不是畫在它上面，got ' + JSON.stringify(after));

    assert.strictEqual(ctx.errs.length, 0, 'T10：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close();
    console.log('journey: a banner closes an open H▾ dropdown instead of painting over it — OK');
  }

  // ── Task 9 review I4: the backlog #6 raw-editor rescue in
  // restoreAfterStructuralOp() must stay scoped to convertBlockViaMenu()
  // (the toolbar's quote/code conversion, the one gesture backlog #6 names)
  // — it must NOT spill into 建立副本 (duplicate) or 刪除 (delete) via the
  // ⠿ gutter menu, even when either lands on a quote/code block. MEASURED
  // before this scoping: 建立副本 on a code block, 建立副本 on a
  // blockquote, and 刪除 landing on a surviving blockquote all went
  // BODY → TEXTAREA.ed-raw — philosophically consistent but never asked
  // for, and risking backlog #5's still-open Escape-discards-uncommitted-
  // edit gap right after a DESTRUCTIVE gesture.
  {
    const clickGutterMenuItem = async (page, blockSel, label) => {
      await page.hover(blockSel);
      await pressClick(page, blockSel + ' .ed-handle', 80);
      await page.waitForSelector('.ed-handle-menu-btn');
      await page.evaluate((lbl) => {
        const items = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === lbl);
        items[items.length - 1].click();
      }, label);
    };

    {
      const ctx = await newPage('# Doc\n\n```\ncode line\n```\n\nAfter.\n');
      await clickGutterMenuItem(ctx.page, '.ed-block[data-block-type="code"]', '建立副本');
      await new Promise((r) => setTimeout(r, 400));
      const tag = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'TEXTAREA',
        'I4 (建立副本/code)：不得自動開啟 raw editor，got ' + JSON.stringify({ tag }));
      assert.strictEqual(ctx.errs.length, 0, 'I4 (建立副本/code)：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const ctx = await newPage('# Doc\n\n> quoted line\n\nAfter.\n');
      await clickGutterMenuItem(ctx.page, '.ed-block[data-block-type="blockquote"]', '建立副本');
      await new Promise((r) => setTimeout(r, 400));
      const tag = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'TEXTAREA',
        'I4 (建立副本/blockquote)：不得自動開啟 raw editor，got ' + JSON.stringify({ tag }));
      assert.strictEqual(ctx.errs.length, 0, 'I4 (建立副本/blockquote)：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const ctx = await newPage('# Doc\n\n> quoted line\n\nDelete me.\n');
      await clickGutterMenuItem(ctx.page, '.ed-block[data-block-type="paragraph"]', '刪除');
      await new Promise((r) => setTimeout(r, 400));
      const tag = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.notStrictEqual(tag, 'TEXTAREA',
        'I4 (刪除/blockquote 鄰居)：不得自動開啟 raw editor，got ' + JSON.stringify({ tag }));
      assert.strictEqual(ctx.errs.length, 0, 'I4 (刪除/blockquote 鄰居)：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
    }
    // Regression guard: the ACTUAL backlog #6 gesture must still work.
    {
      const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
      await ctx.page.click('.ed-block[data-block-type="paragraph"] .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await pressClick(ctx.page, '.ed-toolbar [data-ed-tb="quote"]', 80);
      await new Promise((r) => setTimeout(r, 400));
      const tag = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.strictEqual(tag, 'TEXTAREA',
        'I4 迴歸守衛：toolbar 的 quote 轉換仍必須開啟 raw editor，got ' + JSON.stringify({ tag }));
      await ctx.page.close(); ctx.srv.close();
    }
    console.log('journey: the raw-editor rescue stays scoped to the toolbar quote/code conversion — OK');
  }

  // ── Task 9 review M3: toggleOutlineSidebar() must tell a keyboard
  // activation apart from a mouse click by WHICH DEVICE fired THIS call,
  // not by whether keynav happens to be on — `toolbarRovingIndex >= 0` is
  // true after Alt+F10 regardless of whether the very next input is a
  // keypress or a mouse click, so the first cut of backlog #9's fix
  // treated a mouse click as keyboard whenever keynav was still on from an
  // earlier keypress, stealing focus into the search box in direct
  // contradiction of its own commit message ("a mouse click on the same
  // button must not steal focus"). Fixed with an explicit `viaKeyboard`
  // parameter threaded from activateToolbarCursor() (the one call path
  // that IS the keyboard route) through runToolbarAction() to
  // toggleOutlineSidebar().
  {
    const ctx = await newPage('# Doc\n\nAlpha paragraph.\n');
    await ctx.page.click('.ed-block[data-block-type="paragraph"] .ed-wys-armed');
    await new Promise((r) => setTimeout(r, 200));
    const focusedBefore = await ctx.page.evaluate(() => document.activeElement.className);

    // Alt+F10 turns keynav ON, but the user reaches for the MOUSE instead
    // of pressing Enter.
    await ctx.page.keyboard.down('Alt');
    await ctx.page.keyboard.press('F10');
    await ctx.page.keyboard.up('Alt');
    await new Promise((r) => setTimeout(r, 200));
    const keynavOn = await ctx.page.evaluate(() =>
      document.querySelector('.ed-toolbar').getAttribute('data-ed-tb-keynav'));
    assert.notStrictEqual(keynavOn, null, 'M3 前提失敗：Alt+F10 之後 keynav 必須是開的，got ' + keynavOn);

    await ctx.page.click('.ed-toolbar [data-ed-tb="outline"]');
    await new Promise((r) => setTimeout(r, 300));
    const after = await ctx.page.evaluate(() => ({
      cls: document.activeElement.className,
      inSidebar: !!(document.activeElement.closest &&
        document.activeElement.closest('[data-reader-sidebar]')),
    }));
    assert.strictEqual(after.inSidebar, false,
      'M3：keynav 開著時用滑鼠點 ☰ 不得把 focus 搶進側欄，got ' + JSON.stringify(after));
    assert.strictEqual(after.cls, focusedBefore,
      'M3：滑鼠點 ☰ 不得動到原本的 focus，got ' + JSON.stringify({ focusedBefore, after }));
    assert.strictEqual(ctx.errs.length, 0, 'M3：不得有 pageerror: ' + ctx.errs.join(' | '));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: a mouse click on outline never steals focus, even with keynav still on — OK');
  }


  // ── v3.4.0 batch2 Task 6 fix round 1 — the .drawio background re-bake ────
  //
  // Ruling B2-6: the previous round shipped requirement (c) verified by code
  // reading alone, and review finding F1 is the proof that reading is not
  // enough — a mechanism that never fired on its main path read perfectly
  // fine. Every row below drives the REAL 10s heartbeat (no test-only
  // trigger hook exists in client.js, deliberately: a test that drives a
  // different path from the shipped one proves nothing) and reads the actual
  // value before asserting, never a bare waitForFunction on a value it could
  // have predicted.
  {
    const DRAWIO_MD = '# Doc\n\n![d](d.drawio)\n\nTail para two.\n';
    // A ```html fence whose CONTENT quotes `class="drawio"`. MEASURED: marked
    // escapes the angle brackets but not the quotes, so the literal survives
    // verbatim into this block's part — which is what made round 1's text
    // regex select it as a diagram block (G1/G3).
    const FENCE_MD = '# Doc\n\n![d](d.drawio)\n\n```html\n' +
      '<div class="drawio" data-x="1"></div>\n```\n\nTail para two.\n';
    const CODE_SEL = '.ed-block[data-block-type="code"]';
    const TWO_DIAGRAM_MD = '# Doc\n\n![a](a.drawio)\n\n![b](b.drawio)\n\nTail para two.\n';
    // Fix round 3 (re-review2 H2/H1): two diagrams in ONE block, and a diagram
    // inside a TABLE cell. Both shapes are asserted in their own rows before
    // anything else, because both were claimed impossible at some point.
    const TWO_IN_ONE_MD = '# Doc\n\n![a](a.drawio) ![b](b.drawio)\n\nTail para two.\n';
    const TABLE_MD = '# Doc\n\n| ![d](d.drawio) | x |\n|---|---|\n| y | z |\n\nTail para two.\n';
    const HEARTBEAT_WAIT = 15000;   // one real 10s tick + a headless bake
    // Scoped to these rows only (re-review G10). They sit still for a real
    // heartbeat (two of them for two), and createEditorServer()'s 30s default
    // is close enough to that to turn a slow bake into a mystery
    // ERR_CONNECTION_REFUSED. No other scenario in this file is affected.
    const DRAWIO_SRV_OPTS = { idleTimeoutMs: 10 * 60 * 1000 };
    const diagram = (name, id, value) =>
      '  <diagram name="' + name + '" id="' + id + '">\n' +
      '    <mxGraphModel dx="800" dy="600" grid="0" page="1" pageWidth="850" pageHeight="1100">\n' +
      '      <root>\n' +
      '        <mxCell id="0" /><mxCell id="1" parent="0" />\n' +
      '        <mxCell id="' + id + '-c" value="' + value + '" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">\n' +
      '          <mxGeometry x="80" y="80" width="160" height="60" as="geometry" />\n' +
      '        </mxCell>\n' +
      '      </root>\n' +
      '    </mxGraphModel>\n' +
      '  </diagram>\n';
    const mxfile = (...ds) =>
      '<mxfile host="app.diagrams.net" modified="2026-09-10T00:00:00.000Z" version="24.0.0">\n' +
      ds.join('') + '</mxfile>\n';
    const ARCH_FLOW = mxfile(diagram('Architecture', 'p1', 'ARCH_BOX'),
                             diagram('Flow', 'p2', 'FLOW_BOX'));
    const FLOW_ARCH = mxfile(diagram('Flow', 'p2', 'FLOW_BOX'),
                             diagram('Architecture', 'p1', 'ARCH_BOX'));
    const ARCH_TIMING = mxfile(diagram('Architecture', 'p1', 'ARCH_BOX'),
                               diagram('Timing', 'p3', 'TIMING_BOX'));
    const SINGLE_V1 = mxfile(diagram('Only', 'p1', 'SINGLE_BOX'),
                             diagram('Second', 'p2', 'SECOND_BOX'));
    const SINGLE_V2 = mxfile(diagram('Only', 'p1', 'CHANGED_BOX'),
                             diagram('Second', 'p2', 'SECOND_BOX'));
    const OTHER_V1 = mxfile(diagram('Other', 'p9', 'OTHER_BOX'));
    const OTHER_V2 = mxfile(diagram('Other', 'p9', 'OTHER_CHANGED'));
    const rewriteDrawio = (ctx, xml) =>
      fs.writeFileSync(path.join(ctx.dir, 'd.drawio'), xml, 'utf8');
    // Which mark the diagram on screen is actually painting. Returns a
    // STRING in every case (including the failure cases) so a wrong answer
    // prints what it really was instead of a timeout.
    // MEASURED: every page's baked SVG is in the DOM at once (the hidden ones
    // carry `hidden`, not `display:none` from a parent that is absent), and
    // textContent reads hidden text too — so this has to read the VISIBLE
    // page's subtree or it reports two marks at once and can never tell a
    // page switch from a re-bake.
    const shownMark = (page) => page.evaluate(() => {
      const box = document.querySelector('.drawio');
      if (!box) return 'NO_DRAWIO_BOX';
      const vis = box.querySelector('.drawio-page:not([hidden])');
      const t = (vis || box).textContent || '';
      const hits = ['ARCH_BOX', 'FLOW_BOX', 'TIMING_BOX', 'SINGLE_BOX', 'CHANGED_BOX', 'SECOND_BOX']
        .filter((m) => t.indexOf(m) !== -1);
      return hits.length === 1 ? hits[0] : 'HITS:' + JSON.stringify(hits);
    });
    // The NAME of the single visible page, by the same rule.
    const shownPage = (page) => page.evaluate(() => {
      const box = document.querySelector('.drawio[data-drawio-pages]');
      if (!box) return 'NO_PAGED_BOX';
      let names;
      try { names = JSON.parse(atob(box.getAttribute('data-drawio-pages') || '')); }
      catch (e) { return 'BAD_PAGES_ATTR'; }
      const pages = box.querySelectorAll('.drawio-page');
      const vis = [];
      for (let i = 0; i < pages.length; i++) if (!pages[i].hidden) vis.push(names[i]);
      return vis.length === 1 ? String(vis[0]) : 'VISIBLE:' + JSON.stringify(vis);
    });
    // The page-name list the CURRENT box carries. The discriminator that tells
    // "the re-bake landed and the reader stayed on their page" apart from
    // "nothing happened at all" — on a reorder those two look identical if
    // you only read the visible page's name.
    const pagesAttr = (page) => page.evaluate(() => {
      const box = document.querySelector('.drawio[data-drawio-pages]');
      if (!box) return 'NO_PAGED_BOX';
      try { return JSON.parse(atob(box.getAttribute('data-drawio-pages') || '')).join('|'); }
      catch (e) { return 'BAD_PAGES_ATTR'; }
    });
    // The navigation is `display: none` until `.drawio:hover` (lib/md2doc.js),
    // so a bare page.click() on a button fails with "Node is either not
    // clickable or not an Element". Hover the box first, exactly as a reader
    // does; the pointer stays inside `.drawio` on the way to the button.
    const pickPage = async (page, nth) => {
      await page.hover('.drawio');
      await new Promise((r) => setTimeout(r, 150));
      await page.click('.drawio-sheetbar button:nth-child(' + nth + ')');
      await new Promise((r) => setTimeout(r, 200));
    };
    // Every diagram on the page, in document order, by the mark its visible
    // page paints. A string in every case, including the failure ones.
    const bothMarks = (page) => page.evaluate(() =>
      Array.from(document.querySelectorAll('.drawio')).map((box) => {
        const vis = box.querySelector('.drawio-page:not([hidden])');
        const t = ((vis || box).textContent || '');
        const hits = ['ARCH_BOX', 'FLOW_BOX', 'TIMING_BOX', 'SINGLE_BOX', 'CHANGED_BOX',
          'SECOND_BOX', 'OTHER_BOX', 'OTHER_CHANGED'].filter((m) => t.indexOf(m) !== -1);
        return hits.length === 1 ? hits[0] : 'HITS:' + JSON.stringify(hits);
      }).join('|'));
    // Draw one rectangle over the SECOND diagram through the reader's own
    // lightbox annotation tools, then Escape — which is what writes
    // `.anno-inline-wrap` into that `.drawio-page` (lib/md2doc.js's
    // annoSyncInline()). Uses only real gestures; no internal API is poked.
    const annotateSecondDiagram = async (page) => {
      const box = await page.evaluate(() => {
        const b = document.querySelectorAll('.drawio')[1];
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
      await new Promise((r) => setTimeout(r, 600));
      await page.evaluate(() => { document.querySelector('[data-anno-tool="r"]').click(); });
      await new Promise((r) => setTimeout(r, 200));
      const stage = await page.evaluate(() => {
        const s = document.querySelector('.lightbox-stage');
        const r = s.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(stage.x - 60, stage.y - 40);
      await page.mouse.down();
      await page.mouse.move(stage.x + 60, stage.y + 40, { steps: 8 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));
      await page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 500));
    };
    const sheetTabs = (page) => page.evaluate(() =>
      Array.from(document.querySelectorAll('.drawio-sheetbar button')).map((b) => b.textContent).join('|'));

    // F1 (BLOCKING) — the headline user story, and the one the shipped code
    // could not do: open a document, DO NOT edit it, change the .drawio in
    // Draw.io. `lastParts` was null until this tab's first commit, so the
    // re-bake was fetched, paid for and discarded while the server's baseline
    // advanced past it — the diagram stayed wrong for the whole session.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': SINGLE_V1 }, DRAWIO_SRV_OPTS);
      const before = await shownMark(ctx.page);
      assert.strictEqual(before, 'SINGLE_BOX',
        'F1 前提失敗：初始頁面必須已經烤出原始的 .drawio 內容');
      rewriteDrawio(ctx, SINGLE_V2);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const after = await shownMark(ctx.page);
      assert.strictEqual(after, 'CHANGED_BOX',
        'F1：開著文件、完全不編輯、外部改掉 .drawio —— 這條主路徑必須真的更新畫面');
      assert.strictEqual(ctx.errs.length, 0, 'F1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/F1 an untouched tab really does re-bake a changed .drawio — OK');
    }

    // (c) / F6 — the reader's open page survives a re-bake that REORDERED the
    // pages, and no banner is raised for an outcome that is not a loss.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': ARCH_FLOW }, DRAWIO_SRV_OPTS);
      await pickPage(ctx.page, 2);
      const picked = await shownPage(ctx.page);
      assert.strictEqual(picked, 'Flow', '(c) 前提失敗：切到第二頁必須真的切過去');
      rewriteDrawio(ctx, FLOW_ARCH);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const attr = await pagesAttr(ctx.page);
      assert.strictEqual(attr, 'Flow|Architecture',
        '(c) 前提失敗：重烤必須真的套用到畫面上（否則「還在同一頁」只是因為什麼都沒發生）');
      const kept = await shownPage(ctx.page);
      assert.strictEqual(kept, 'Flow',
        '(c)：重烤之後頁序變了，但使用者開著的那一頁還在 —— 必須留在同一頁');
      const banner = await visibleBannerText(ctx.page);
      assert.strictEqual(banner, null,
        '(c)：頁還在的時候不得升起「分頁已不存在」的 banner，got ' + JSON.stringify(banner));
      assert.strictEqual(ctx.errs.length, 0, '(c)：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/(c) a reordered re-bake keeps the reader on the same page — OK');
    }

    // (c) / Ruling B2-P1 — the page really was deleted: fall back to the
    // first page AND say so visibly. Both outcomes must not be silent.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': ARCH_FLOW }, DRAWIO_SRV_OPTS);
      await pickPage(ctx.page, 2);
      assert.strictEqual(await shownPage(ctx.page), 'Flow', '前提失敗：必須先切到 Flow');
      rewriteDrawio(ctx, ARCH_TIMING);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const attr = await pagesAttr(ctx.page);
      assert.strictEqual(attr, 'Architecture|Timing',
        'B2-P1 前提失敗：重烤必須真的套用到畫面上');
      const landed = await shownPage(ctx.page);
      assert.strictEqual(landed, 'Architecture',
        'B2-P1：使用者開著的那一頁被刪掉時必須退回第一頁');
      const banner = await visibleBannerText(ctx.page);
      assert.strictEqual(typeof banner === 'string' && banner.indexOf('分頁已不存在') !== -1, true,
        'B2-P1：而且必須看得見一條說明 —— 靜默跳頁正是這條規則禁止的，got ' + JSON.stringify(banner));
      assert.strictEqual(ctx.errs.length, 0, 'B2-P1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/(c) a deleted page falls back to page 1 with a visible banner — OK');
    }

    // A refresh arriving while the user is editing must not move the caret.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': SINGLE_V1 }, DRAWIO_SRV_OPTS);
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type('TYPED');
      await new Promise((r) => setTimeout(r, 200));
      const beforeFocus = await ctx.page.evaluate(() => {
        const ae = document.activeElement;
        const blk = ae && ae.closest ? ae.closest('.ed-block') : null;
        return (ae ? ae.className : 'NONE') + '@' +
          (blk ? blk.getAttribute('data-block-id') : 'NONE');
      });
      assert.strictEqual(beforeFocus.indexOf('ed-wys-armed') !== -1, true,
        '前提失敗：必須真的有一個 WYSIWYG 編輯面獲得焦點，got ' + beforeFocus);
      rewriteDrawio(ctx, SINGLE_V2);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const afterFocus = await ctx.page.evaluate(() => {
        const ae = document.activeElement;
        const blk = ae && ae.closest ? ae.closest('.ed-block') : null;
        return (ae ? ae.className : 'NONE') + '@' +
          (blk ? blk.getAttribute('data-block-id') : 'NONE');
      });
      assert.strictEqual(afterFocus, beforeFocus,
        '背景刷新絕不可以把使用者手上的焦點搬走');
      const after = await shownMark(ctx.page);
      assert.strictEqual(after, 'CHANGED_BOX',
        '而且刷新本身仍然要發生 —— 使用者在別的區塊打字不是跳過整輪的理由');
      assert.strictEqual(ctx.errs.length, 0, '不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio a background refresh never moves document.activeElement — OK');
    }

    // F2 — the retry. The old server advanced the staleness baseline on the
    // ping that REPORTED stale, before any client had acted on it, so every
    // one of the client's bail paths lost the change permanently while the
    // client comment promised "the next 10s tick tries again". Here the first
    // /api/render after the signal is failed at the network layer (one of the
    // real bail paths, at client.js's `catch (e) { return; }`), and the
    // second heartbeat must still be told.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': SINGLE_V1 }, DRAWIO_SRV_OPTS);
      await ctx.page.evaluate(() => {
        window.__renderCalls = 0;
        const orig = window.fetch;
        window.fetch = function (u, o) {
          if (String(u).indexOf('/api/render') !== -1) {
            window.__renderCalls++;
            if (window.__renderCalls === 1) return Promise.reject(new Error('INJECTED_NETWORK_FAILURE'));
          }
          return orig.apply(this, arguments);
        };
      });
      rewriteDrawio(ctx, SINGLE_V2);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const midMark = await shownMark(ctx.page);
      const midCalls = await ctx.page.evaluate(() => window.__renderCalls);
      assert.strictEqual(midCalls >= 1, true,
        'F2 前提失敗：第一拍必須真的送出過 /api/render（否則注入的失敗根本沒發生），got ' + midCalls);
      assert.strictEqual(midMark, 'SINGLE_BOX',
        'F2 前提失敗：那一發被注入的網路失敗必須真的讓這輪放棄，got ' + midMark);
      // Longer than one beat ON PURPOSE. Fix round 2 (re-review G1b) backs off
      // after a bail that already PAID for a fetch — the first one waits
      // DRAWIO_BACKOFF_BASE_MS * 2 = 20s — so the retry lands on a later tick
      // than the next one. That delay is the whole point of the backoff; what
      // this row pins is that the update is DELAYED, never dropped.
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT + 25000));
      const finalMark = await shownMark(ctx.page);
      assert.strictEqual(finalMark, 'CHANGED_BOX',
        'F2：用戶端放棄了一輪之後，下一次心跳必須再報一次 stale 並且這次成功 —— ' +
        '基準線只能在用戶端確認套用之後才前進');
      assert.strictEqual(ctx.errs.length, 0, 'F2：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/F2 a bailed refresh is genuinely retried on the next heartbeat — OK');
    }

    // F5 — the background notice must never destroy the disk-conflict banner.
    // showBanner()'s first statement removes whatever banner is up, and the
    // conflict banner is the user's only route to resolving a conflict on the
    // one data-safety-critical path this editor has (it carries Reload).
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': ARCH_FLOW }, DRAWIO_SRV_OPTS);
      await pickPage(ctx.page, 2);
      assert.strictEqual(await shownPage(ctx.page), 'Flow', 'F5 前提失敗：必須先切到 Flow');
      // An external write to the MARKDOWN moves its mtime, so the next save
      // fails the mtime guard and raises the conflict banner for real.
      fs.writeFileSync(ctx.mdPath, DRAWIO_MD + '\nAppended outside the editor.\n', 'utf8');
      // A 409 is a COMPLETED save — `save()` answers off the status alone and
      // never reads the body, which is exactly what the clone-armed net in
      // newPage()'s instrumentation is for — so this waits for the save like
      // every other site rather than guessing 600 ms.
      await pressSaveAndLand(ctx);
      const conflict = await visibleBannerText(ctx.page);
      assert.strictEqual(typeof conflict === 'string' && conflict.indexOf('File changed on disk') !== -1, true,
        'F5 前提失敗：必須真的先升起磁碟衝突 banner，got ' + JSON.stringify(conflict));
      // Now make the background path WANT to raise its own notice.
      rewriteDrawio(ctx, ARCH_TIMING);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const stillConflict = await visibleBannerText(ctx.page);
      assert.strictEqual(
        typeof stillConflict === 'string' && stillConflict.indexOf('File changed on disk') !== -1, true,
        'F5：背景刷新不得把磁碟衝突 banner（連同它的 Reload 按鈕）換掉，got ' + JSON.stringify(stillConflict));
      const reloadBtns = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-conflict button')).map((b) => b.textContent).join('|'));
      assert.strictEqual(reloadBtns.indexOf('Reload') !== -1, true,
        'F5：Reload 按鈕必須還在 —— 那是使用者解衝突的唯一入口，got ' + reloadBtns);
      // And the DOM update itself still happened underneath it.
      const landed = await shownPage(ctx.page);
      assert.strictEqual(landed, 'Architecture',
        'F5：延後的只是那條訊息，重烤本身仍然要套用');
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/F5 a background notice never clobbers the conflict banner — OK');
    }


    // G1 / G3 (fix round 2) — a block whose rendered markup merely QUOTES
    // `class="drawio"` must not be treated as a diagram block by anything.
    //
    // MEASURED on this renderer: marked escapes `<`/`>` inside a fenced code
    // block but leaves `"` alone, so a ```html fence containing
    // `<div class="drawio" …>` really does emit the literal verbatim into its
    // part — the false positive is reachable, not theoretical. Round 1's loop
    // selected that block by a text regex while the pre-fetch guard asked the
    // DOM, and the two disagreeing is what turned an editing surface parked in
    // that block into a full /api/render + headless-Chromium bake every 10
    // seconds forever, with the diagram never updating.
    {
      const ctx = await newPage(FENCE_MD, { 'd.drawio': SINGLE_V1 }, DRAWIO_SRV_OPTS);
      const before = await shownMark(ctx.page);
      assert.strictEqual(before, 'SINGLE_BOX', 'G1 前提失敗：初始頁面必須已經烤好');
      // Park a real editing surface inside the quoting block, via the same
      // ⠿ → MD 原始碼 route a user takes.
      await ctx.page.hover(CODE_SEL);
      await pressClick(ctx.page, CODE_SEL + ' .ed-handle', 80);
      await new Promise((r) => setTimeout(r, 300));
      const opened = await ctx.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.ed-handle-menu-btn'))
          .filter((x) => x.textContent.trim() === 'MD 原始碼');
        if (!items.length) return 'NO_MENU_ITEM';
        items[items.length - 1].click();
        return 'clicked';
      });
      assert.strictEqual(opened, 'clicked',
        'G1 前提失敗：⠿ 選單必須真的開著而且有「MD 原始碼」這一項，got ' + opened);
      await new Promise((r) => setTimeout(r, 400));
      const surface = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.strictEqual(surface, 'TEXTAREA',
        'G1 前提失敗：必須真的有一個原始碼編輯面獲得焦點，got ' + surface);
      // Tag the quoting block's NODE. An expando does not survive
      // replaceWith(), so this is how "was it swapped" is read back.
      await ctx.page.evaluate((sel) => {
        document.querySelector(sel).__drawioProbe = 'kept';
      }, CODE_SEL);

      rewriteDrawio(ctx, SINGLE_V2);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));

      const after = await shownMark(ctx.page);
      assert.strictEqual(after, 'CHANGED_BOX',
        'G1：引用了這段標記文字的區塊不得讓整輪刷新放棄 —— 舊版會每 10 秒重跑一次 ' +
        '完整 render + headless 烘焙，而圖永遠不更新');
      const stillOpen = await ctx.page.evaluate(() => document.activeElement.tagName);
      assert.strictEqual(stillOpen, 'TEXTAREA',
        'G1：而且那個原始碼編輯面必須原封不動，got ' + stillOpen);
      const probe = await ctx.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.__drawioProbe) : 'NO_BLOCK';
      }, CODE_SEL);
      assert.strictEqual(probe, 'kept',
        'G3：只是文字上含有這段標記的區塊不得被整個換掉，got ' + probe);
      assert.strictEqual(ctx.errs.length, 0, 'G1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/G1 a block that merely quotes the markup is not a diagram block — OK');
    }

    // G4 (fix round 2) — one external write must not re-swap every OTHER
    // diagram on the page. The bootstrap seed is the HTML parser's
    // re-serialisation, so the cheap `parts[i] === lastParts[i]` equality
    // never fires on an unedited tab; without a bake-level comparison, a
    // change to a.drawio replaced the block holding b.drawio too.
    {
      const ctx = await newPage(TWO_DIAGRAM_MD,
        { 'a.drawio': SINGLE_V1, 'b.drawio': ARCH_FLOW }, DRAWIO_SRV_OPTS);
      const marks = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.drawio')).map((box) => {
          const vis = box.querySelector('.drawio-page:not([hidden])');
          return ((vis || box).textContent || '').trim();
        }).join('|'));
      assert.strictEqual(marks, 'SINGLE_BOX|ARCH_BOX',
        'G4 前提失敗：兩張圖都必須先烤出來，got ' + marks);
      await ctx.page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('.drawio'));
        boxes.forEach((b, i) => { b.closest('.ed-block').__drawioProbe = 'block' + i; });
      });
      fs.writeFileSync(path.join(ctx.dir, 'a.drawio'), SINGLE_V2, 'utf8');
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const after = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.drawio')).map((box) => {
          const vis = box.querySelector('.drawio-page:not([hidden])');
          const blk = box.closest('.ed-block');
          return ((vis || box).textContent || '').trim() + '/' + String(blk && blk.__drawioProbe);
        }).join('|'));
      assert.strictEqual(after, 'CHANGED_BOX/undefined|ARCH_BOX/block1',
        'G4：改了 a.drawio 只能換掉 a 那個區塊（所以它的標記不見了）；' +
        'b.drawio 那個區塊必須原封不動（標記還在），got ' + after);
      assert.strictEqual(ctx.errs.length, 0, 'G4：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/G4 one external write only re-swaps the diagram that changed — OK');
    }


    // H2 (fix round 3) — TWO diagrams in ONE block, and it is the SECOND one
    // that changes. `![a](a.drawio) ![b](b.drawio)` on one markdown line is a
    // single paragraph block holding two `.drawio` boxes (verified by render).
    // Round 2 fingerprinted only `querySelector('.drawio')` — the first — so
    // this comparison came back equal, the loop skipped the block, `applied`
    // stayed true, the tab ACKED, and the server advanced its baseline past an
    // update the DOM never took. Silent, permanent, and F2's invariant broken
    // from the client side. Measured against both commits by the re-reviewer:
    // bd22ec6 updated B on the first beat, 945ca23 never did.
    {
      const ctx = await newPage(TWO_IN_ONE_MD,
        { 'a.drawio': SINGLE_V1, 'b.drawio': OTHER_V1 }, DRAWIO_SRV_OPTS);
      const before = await bothMarks(ctx.page);
      assert.strictEqual(before, 'SINGLE_BOX|OTHER_BOX',
        'H2 前提失敗：一個區塊裡必須真的有兩張圖，got ' + before);
      const boxesPerBlock = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block'))
          .map((b) => b.querySelectorAll('.drawio').length).join('|'));
      assert.strictEqual(boxesPerBlock, '0|2|0',
        'H2 前提失敗：兩張圖必須落在同一個區塊裡（否則測到的是已經會過的那一種），got ' + boxesPerBlock);
      fs.writeFileSync(path.join(ctx.dir, 'b.drawio'), OTHER_V2, 'utf8');
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const after = await bothMarks(ctx.page);
      assert.strictEqual(after, 'SINGLE_BOX|OTHER_CHANGED',
        'H2：同一個區塊裡的第二張圖改變時必須真的更新 —— 舊版把它當成「沒變」跳過、' +
        '然後還 ack 回去，伺服器基準線越過了一個畫面從未顯示的版本，永久且無聲，got ' + after);
      assert.strictEqual(ctx.errs.length, 0, 'H2：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/H2 the second diagram in one block is not silently skipped — OK');
    }

    // H1 (fix round 3) — a `.drawio` in a table cell makes the whole TABLE
    // block replaceable by this path. Round 2's report claimed 「一個 drawio
    // 區塊永遠不是表格」 and skipped the table resets on that basis; rendering
    // `| ![d](d.drawio) | x |` falsifies it, and this row pins the shape.
    //
    // It ALSO pins the reason the dangling-grip scenario that finding
    // described is not reachable today, because that reason is an invariant
    // somebody could change without noticing: the grips, the edge menu and
    // the row/column drag all require `ed-wys-table`, and a table holding a
    // baked diagram never gets it — `canWysiwygForTable()` is
    // `serializeTable(...).unsupported.length === 0`.
    //
    // WHICH NODE is unsupported matters, because it is what a future change
    // would have to move (fix round 4, re-review3 M1 — the earlier version of
    // this comment named the wrong one). MEASURED, real page +
    // `md2docTableMd.serializeTable()`:
    //   the drawio table   unsupported ["svg"]   armed false
    //   a plain neighbour  unsupported []        armed true
    // It is the baked `<svg>`, NOT the `<div class="drawio">` wrapper:
    // lib/editor/inline-md.js handles `DIV` explicitly and recurses into it,
    // while `svg` reaches the fall-through that pushes onto `unsupported`.
    // (A bake that FAILED emits `<div class="drawio drawio-failed"><p>…`, and
    // `P` reaches the same fall-through, so that shape is degraded too.) So
    // the trigger to watch for is inline-md.js learning to serialise inline
    // `svg` — not anything about `<div>`. If that lands, this row goes red
    // and whoever changed it is pointed at the scoped resets in
    // refreshStaleDrawio() that go live with it.
    {
      const ctx = await newPage(TABLE_MD, { 'd.drawio': SINGLE_V1 }, DRAWIO_SRV_OPTS);
      const shape = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-block'))
          .map((b) => b.getAttribute('data-block-type') + ':' + b.querySelectorAll('.drawio').length)
          .join('|'));
      assert.strictEqual(shape, 'heading:0|table:1|paragraph:0',
        'H1：表格儲存格裡的 drawio 真的會產生一個 table 區塊 —— 「drawio 區塊永遠不是表格」是錯的，got ' + shape);
      const armed = await ctx.page.evaluate(() => {
        const t = document.querySelector('.ed-block[data-block-type="table"] table');
        return t ? (t.classList.contains('ed-wys-table') ? 'armed' : 'degraded') : 'NO_TABLE';
      });
      assert.strictEqual(armed, 'degraded',
        'H1：帶 drawio 的表格必須是 degraded —— 實測 serializeTable() 的 unsupported 是 ' +
        '["svg"]（烘焙出來的 <svg>，不是 .drawio 那個 <div>：inline-md.js 會遞迴進 DIV）。' +
        '這正是握把 / 邊選單 / 列拖曳在它身上永遠起不來的原因；一旦這裡變成 armed ' +
        '（最可能的來源是 inline-md.js 學會序列化行內 svg），' +
        'refreshStaleDrawio() 裡那幾道 scoped reset 就從防禦性變成活的，got ' + armed);
      // Hover the row band the way a reader would. MEASURED: nothing comes up.
      const rowBox = await ctx.page.evaluate(() => {
        const tr = document.querySelector('.ed-block[data-block-type="table"] tbody tr');
        const r = tr.getBoundingClientRect();
        return { x: r.left + 8, y: r.top + r.height / 2 };
      });
      await ctx.page.mouse.move(rowBox.x, rowBox.y);
      await new Promise((r) => setTimeout(r, 300));
      const gripsUp = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-te-grip-row, .ed-te-grip-col, .ed-te-menu'))
          .filter((g) => !g.hidden).length);
      assert.strictEqual(gripsUp, 0,
        'H1：degraded 表格上滑過列不得升起任何握把 / 邊選單，got ' + gripsUp);
      rewriteDrawio(ctx, SINGLE_V2);
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const after = await shownMark(ctx.page);
      assert.strictEqual(after, 'CHANGED_BOX',
        'H1：表格區塊裡的 drawio 一樣要重烤 —— 這條路徑真的會整個換掉一個 table 區塊，got ' + after);
      assert.strictEqual(ctx.errs.length, 0, 'H1：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/H1 a diagram in a table cell re-bakes, and that table never arms — OK');
    }

    // H3 (fix round 3) — the reader's annotations are drawn INTO
    // `.drawio-page`. An UNRELATED write must leave them alone; the annotated
    // diagram's OWN change must still update AND say that the annotations went.
    {
      const ctx = await newPage(TWO_DIAGRAM_MD,
        { 'a.drawio': SINGLE_V1, 'b.drawio': OTHER_V1 }, DRAWIO_SRV_OPTS);
      await annotateSecondDiagram(ctx.page);
      const annotated = await ctx.page.evaluate(() =>
        document.querySelectorAll('.drawio-page .anno-inline-wrap').length);
      assert.strictEqual(annotated, 1,
        'H3 前提失敗：註記必須真的畫進 .drawio-page 裡，got ' + annotated);
      // (1) unrelated write: a.drawio changes, b's annotations must survive.
      fs.writeFileSync(path.join(ctx.dir, 'a.drawio'), SINGLE_V2, 'utf8');
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const kept = await ctx.page.evaluate(() =>
        document.querySelectorAll('.drawio-page .anno-inline-wrap').length);
      assert.strictEqual(kept, 1,
        'H3：改的是別的檔案，讀者自己畫的註記必須原封不動，got ' + kept);
      const marksNow = await bothMarks(ctx.page);
      assert.strictEqual(marksNow, 'CHANGED_BOX|OTHER_BOX',
        'H3 前提失敗：而那次改動本身仍然要套用，got ' + marksNow);
      const bannerNow = await visibleBannerText(ctx.page);
      assert.strictEqual(bannerNow, null,
        'H3：沒有東西被丟掉的時候不得升起「註記已移除」的訊息，got ' + JSON.stringify(bannerNow));
      // (2) the annotated diagram's own bytes change: it updates, the
      // annotations cannot follow, and the reader is told.
      fs.writeFileSync(path.join(ctx.dir, 'b.drawio'), OTHER_V2, 'utf8');
      await new Promise((r) => setTimeout(r, HEARTBEAT_WAIT));
      const marksAfter = await bothMarks(ctx.page);
      assert.strictEqual(marksAfter, 'CHANGED_BOX|OTHER_CHANGED',
        'H3：被註記的那張圖自己變了時仍然必須重烤，got ' + marksAfter);
      const banner = await visibleBannerText(ctx.page);
      assert.strictEqual(typeof banner === 'string' && banner.indexOf('註記') !== -1, true,
        'H3：使用者自己畫的東西被丟掉不可以無聲 —— 必須看得見一條說明，got ' + JSON.stringify(banner));
      assert.strictEqual(ctx.errs.length, 0, 'H3：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/H3 annotations survive an unrelated write and are announced when dropped — OK');
    }

    // F9 — the page navigation is rebuilt after an ORDINARY edit commit. It
    // used to be created once at page load and destroyed by the first
    // innerHTML swap, so a user who typed one character lost it for the rest
    // of the session — which made preserving the open page across a
    // background re-bake largely academic.
    {
      const ctx = await newPage(DRAWIO_MD, { 'd.drawio': ARCH_FLOW }, DRAWIO_SRV_OPTS);
      const tabsBefore = await sheetTabs(ctx.page);
      assert.strictEqual(tabsBefore, 'Architecture|Flow',
        'F9 前提失敗：載入時必須先有切頁列，got ' + tabsBefore);
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' EDITED');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1500));
      const tabsAfter = await sheetTabs(ctx.page);
      assert.strictEqual(tabsAfter, 'Architecture|Flow',
        'F9：一次普通的編輯提交之後切頁列必須還在（舊版是永久消失），got ' + tabsAfter);
      assert.strictEqual(ctx.errs.length, 0, 'F9：不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: drawio/F9 the page navigation survives an ordinary edit commit — OK');
    }
  }

  // ── v3.4.0 batch3 Task 6: the wavedrom editing surface ─────────────────
  //
  // EVERY fixture below has a GROUP in it. That is not decoration: the flattened
  // lane index and the group tree are the two things this batch's silent
  // defects have lived between, and a group-free fixture cannot express any of
  // them — it reads as coverage and proves nothing.
  {
    const WAVE_MD = [
      '# W', '',
      '```wavedrom',
      '{ signal: [',
      "  { name: 'clk', wave: 'p....' },  // 主時脈",
      "  ['bus',",
      "    { name: 'req', wave: '0.1.0' },",
      "    { name: 'dat', wave: 'x.3.x', data: ['D'] }",
      '  ],',
      // A lane whose FIRST cycle is a bare repeater. The engine draws it as x
      // until the run recovers — `levelsOf` models exactly that — so a drawing
      // that painted the wave characters instead would show 0 here and the
      // preview beside it would show x. That disagreement is the whole reason
      // the preview is on screen, and this is the lane that can express it.
      "  { name: 'ack', wave: '.0..1' },",
      // A `|` gap. The engine draws a discontinuity marker for it and
      // `levelsOf` deliberately erases it (it answers what a cycle SHOWS), so
      // this is the one axis where the two pictures can differ on a lane whose
      // LEVELS agree exactly — and it is invisible to a comparison that only
      // looks at levels.
      "  { name: 'gap', wave: '01|10' },",
      // `{}` — WaveDrom's own blank-row spacer, and the shape that separates
      // "this lane has no `wave` key" from "its wave is the empty string". The
      // engine draws NOTHING for it and one `x` cycle for the empty string;
      // round 1 drew one `x` for both and put a solid brick on a row the
      // preview left blank. The fixture has to be non-rectangular to say that,
      // which is why the comparison below is per-lane.
      '  {}',
      '] }',
      '```', '',
      'Tail para two.', '',
    ].join('\n');

    // Open the editor the way a person does: hover the rendered diagram, then
    // press the affordance that appears. Real pointer events throughout —
    // v3.3.0's entire discovery mechanism was the difference between these and
    // a synthetic .click().
    const openWave = async (page) => {
      await page.waitForSelector('.wavedrom-diagram');
      // Park the pointer somewhere else first. The affordance is raised by a
      // `mouseover`, which only fires when the element under the pointer
      // CHANGES — after a scroll the pointer has not moved, so a move to the
      // diagram's (new) coordinates can be a no-op and the button never comes
      // back. That is the product's real behaviour and matches `.ed-te-grip`;
      // it is the harness that has to be honest about the gesture.
      await page.mouse.move(2, 2);
      await new Promise((r) => setTimeout(r, 60));
      const box = await page.$eval('.wavedrom-diagram', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.waitForSelector('.ed-wave-edit-btn:not([hidden])');
      await pressClick(page, '.ed-wave-edit-btn');
      await page.waitForSelector('.ed-wave-overlay');
      await new Promise((r) => setTimeout(r, 250));
    };

    // The centre of one cell, in viewport coordinates, plus whether that point
    // is actually ON the drawing. The canvas is a scroll container inside a
    // fixed-width column: MEASURED in this session, a press 116px past its clip
    // landed on the preview column instead, the mousedown listener never fired,
    // and the result was indistinguishable from "the paint refused". Without
    // this flag that is a silently green scenario.
    const cellPoint = async (page, lane, cycle) => {
      const at = await page.evaluate((l, c) => {
        const svg = document.querySelector('.ed-wave-canvas');
        const wrap = document.querySelector('.ed-wave-canvas-wrap');
        if (!svg || !wrap) return null;
        const r = svg.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        const lh = r.height / Number(svg.getAttribute('data-lane-count'));
        const cw = r.width / Number(svg.getAttribute('data-cycle-count'));
        const x = r.left + c * cw + cw / 2;
        const y = r.top + l * lh + lh / 2;
        return { x: x, y: y,
          visible: x >= w.left && x <= w.right && y >= w.top && y <= w.bottom };
      }, lane, cycle);
      assert.ok(at, 'cellPoint: 畫布不在畫面上');
      assert.strictEqual(at.visible, true,
        'cellPoint: lane ' + lane + ' cycle ' + cycle +
        ' 的中心點落在畫布的可視範圍外，按下去會按到別的欄位（看起來會跟「塗不上去」一模一樣）');
      return at;
    };

    // A real press-drag-release across a range of cycles.
    const dragCells = async (page, lane, from, to) => {
      const a = await cellPoint(page, lane, from);
      const b = await cellPoint(page, lane, to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, a.y);
      await page.mouse.move(b.x, b.y);
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 250));
    };

    const paintCell = async (page, lane, cycle, ch) => {
      await pressClick(page, '.ed-wave-brush[data-brush="' + ch + '"]');
      const at = await cellPoint(page, lane, cycle);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 250));
    };

    // T6a — it opens, it opens on document.body, and a painted cell reaches the
    // state the file is written from.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      assert.ok(await ctx.page.$('.ed-wave-overlay'), 'T6a: 編輯器必須開起來');

      // The overlay may not live inside .content: everything in there is read
      // back as this tab's own render and serialised into the user's markdown.
      const where = await ctx.page.$eval('.ed-wave-overlay', (el) => ({
        parent: el.parentElement.tagName,
        inContent: document.querySelector('.content').contains(el),
      }));
      assert.strictEqual(where.parent, 'BODY',
        'T6a: overlay 必須掛在 document.body 上。Got ' + where.parent);
      assert.strictEqual(where.inContent, false,
        'T6a: overlay 不得在 .content 裡面（.content 會被序列化回使用者的 markdown）');

      await paintCell(ctx.page, 0, 2, '1');
      const wave = await ctx.page.$eval('.ed-wave-canvas',
        (el) => el.getAttribute('data-wave-0'));
      assert.ok(wave && wave[2] === '1',
        'T6a: 塗過的那一格必須反映在狀態上。Got ' + JSON.stringify(wave));
      // One gesture, one write-back — not a session's worth saved up. Task 5
      // measured the store's refusal rate climbing with the number of
      // structural operations stacked before a patch (8.0% at 1-3 ops, 17.0%
      // at 1-6), so a patch that only happens at the end makes refusal the
      // normal path.
      const per = await ctx.page.$eval('.ed-wave-overlay', (el) => ({
        gestures: el.getAttribute('data-wave-gestures'),
        patch: el.getAttribute('data-wave-patch'),
      }));
      assert.strictEqual(per.gestures, '1',
        'T6a: 一個手勢就是一次 apply。Got ' + per.gestures);
      assert.strictEqual(per.patch, 'ok',
        'T6a: 那個手勢自己就要產出 patch，不是留到最後才算。Got ' + per.patch);
      assert.strictEqual(ctx.errs.length, 0, 'T6a: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6a the overlay opens on document.body and a painted cell reaches the state — OK');
    }

    // T6b — the hand-drawn waveform and the engine's own preview agree, cycle by
    // cycle, before AND after an edit.
    //
    // The comparison is against the preview's own brick ids (its
    // `<use xlink:href="#…">` list, two half-bricks per cycle, the second of
    // which carries the level). `data-bricks-N` is what this editor decided to
    // draw. If the two ever disagree the user has two pictures on screen and no
    // way to tell which one the file means.
    {
      // Read both pictures PER LANE.
      //
      // The previous shape of this helper flattened the preview's whole `<use>`
      // list and indexed it as `uses[(i*cycles + c)*2 + 1]`, guarded by
      // `uses === lanes × cycles × 2`. That is only a cycle index while every
      // lane emits the same number of cycles, and the very defect this row
      // exists for — a spacer row the engine draws nothing for — makes the
      // diagram non-rectangular. Adding the spacer to the fixture killed the
      // old helper on its own pre-assertion (16 vs 24) rather than on the
      // disagreement: the axis was uncovered by construction, the same shape as
      // round 1's filtered-out gaps.
      //
      // The engine publishes the per-lane structure itself: `wavelane_draw_<i>_<index>`
      // holds lane i's bricks and `wavegap_<i>_<index>` its gap markers, in the
      // codec's own display order. Asking those directly needs no rectangle.
      const bricks = async (page) => {
        const got = await page.evaluate(() => {
          const svg = document.querySelector('.ed-wave-canvas');
          const lanes = Number(svg.getAttribute('data-lane-count'));
          const href = (u) => (u.getAttribute('xlink:href') || u.getAttribute('href') || '').slice(1);
          const drawn = [], engine = [], drawnGaps = [], engineGaps = [], missing = [];
          let totalUses = 0;
          for (let i = 0; i < lanes; i++) {
            drawn.push(svg.getAttribute('data-bricks-' + i));
            drawnGaps.push(svg.getAttribute('data-gaps-' + i));
            const g = document.getElementById('wavelane_draw_' + i + '_9000');
            if (g === null) { missing.push(i); engine.push(null); engineGaps.push(null); continue; }
            const u = Array.prototype.map.call(g.querySelectorAll('use'), href);
            totalUses += u.length;
            // A cycle is a PAIR of half-bricks and the second carries the level.
            const row = [];
            for (let k = 1; k < u.length; k += 2) row.push(u[k]);
            engine.push(row.join(' '));
            // …and the gap markers of that same lane, as cycle indices: the
            // engine places one at the centre of its own cycle, 40px wide, so
            // `translate(x)` is `(cycle + 0.5) * 40`. (Only true while nothing
            // rescales the engine — pinned by the `unmodelled` assertion below.)
            const gg = document.getElementById('wavegap_' + i + '_9000');
            const at = gg === null ? [] : Array.prototype.map.call(gg.querySelectorAll('use'),
              (x) => {
                const m = /translate\(\s*(-?[0-9.]+)/.exec(x.getAttribute('transform') || '');
                return m === null ? 'NaN' : String((Number(m[1]) / 40) - 0.5);
              });
            engineGaps.push(at.join(' '));
          }
          // ── what was actually PAINTED ───────────────────────────────────
          //
          // Everything above reads `data-bricks-<i>` — the canvas's own
          // description of itself, written at the top of `drawLane` BEFORE it
          // paints anything. Measured with a mutant that returns straight after
          // that attribute block: the canvas paints 0 non-gridline shapes
          // (pristine: 25) and every assertion in this row still passes,
          // `lanes === engineLanes` included. An editor that draws nothing is
          // indistinguishable from a correct one when both halves of the
          // comparison come from the same source.
          //
          // So this reads the SHAPES. The cycle grid comes from the painted
          // `.ed-wave-grid` lines rather than from any attribute, the row height
          // comes from that grid's own extent divided by the ENGINE's lane
          // count, and each cycle is classified by what is painted over its
          // midpoint — a rect is x, a polygon is a bus, a clock path is a clock,
          // and a plain line is read as high/mid/low by which third of its row
          // it sits in. Transition edges are vertical and sit ON a boundary, so
          // a cycle's midpoint never falls inside one; gap markers and bus
          // labels are excluded by class (gaps have their own per-cycle
          // comparison above).
          const gridXs = Array.prototype.map.call(
            svg.querySelectorAll('.ed-wave-grid'), (g) => Number(g.getAttribute('x1')))
            .sort((a, b) => a - b);
          const gridBottom = Math.max.apply(null, Array.prototype.map.call(
            svg.querySelectorAll('.ed-wave-grid'), (g) => Number(g.getAttribute('y2'))));
          const engineLaneCount = document.querySelectorAll(
            '[id^="wavelane_draw_"][id$="_9000"]').length;
          const rowH = engineLaneCount > 0 ? gridBottom / engineLaneCount : 0;
          const shapes = Array.prototype.filter.call(svg.children, (el) => {
            const cls = el.getAttribute('class') || '';
            return cls.indexOf('ed-wave-grid') === -1 &&
              cls.indexOf('ed-wave-selection') === -1 &&
              cls.indexOf('ed-wave-gap') === -1 &&
              cls.indexOf('ed-wave-buslabel') === -1 &&
              cls.indexOf('ed-wave-edge') === -1;
          }).map((el) => {
            const b = el.getBBox();
            return { tag: el.tagName, cls: el.getAttribute('class') || '',
              x0: b.x, x1: b.x + b.width, cy: b.y + b.height / 2,
              y0: b.y, y1: b.y + b.height };
          });
          const painted = [];
          const paintedCounts = [];
          for (let i = 0; i < engineLaneCount; i++) {
            const top = i * rowH;
            paintedCounts.push(shapes.filter(
              (sh) => sh.cy >= top && sh.cy < top + rowH).length);
            const row = [];
            for (let c = 0; c + 1 < gridXs.length; c++) {
              const mx = (gridXs[c] + gridXs[c + 1]) / 2;
              const hit = shapes.find((sh) => sh.x0 <= mx && mx <= sh.x1 &&
                sh.cy >= top && sh.cy < top + rowH);
              if (hit === undefined) { row.push(''); continue; }
              if (hit.tag === 'rect') { row.push('x'); continue; }
              if (hit.tag === 'polygon') { row.push('bus'); continue; }
              if (hit.tag === 'path') {
                row.push(hit.cls.indexOf('ed-wave-clock') !== -1 ? 'clock' : '?');
                continue;
              }
              const third = (hit.cy - top) / rowH;
              row.push(third < 1 / 3 ? 'hi' : (third < 2 / 3 ? 'mid' : 'lo'));
            }
            painted.push(row.join(' '));
          }
          return { drawn: drawn, engine: engine, missing: missing,
            painted: painted, paintedCounts: paintedCounts,
            shapeCount: shapes.length,
            gridCount: gridXs.length,
            lanes: lanes,
            engineLanes: document.querySelectorAll(
              '[id^="wavelane_draw_"][id$="_9000"]').length,
            drawnGaps: drawnGaps, engineGaps: engineGaps, totalUses: totalUses,
            hasWave: Array.from({ length: lanes },
              (_, i) => svg.getAttribute('data-haswave-' + i)),
            levels: svg.getAttribute('data-levels-3'),
            wave: svg.getAttribute('data-wave-3'),
            waves: Array.from({ length: lanes },
              (_, i) => svg.getAttribute('data-wave-' + i)),
            unmodelled: document.querySelector('.ed-wave-overlay')
              .getAttribute('data-wave-unmodelled'),
            preview: document.querySelector('.ed-wave-preview')
              .getAttribute('data-wave-preview') };
        });
        // Three pre-assertions, and each one rules out a different way for the
        // comparison below to be true without having compared anything.
        assert.strictEqual(got.preview, 'ok',
          'T6b: 預覽必須真的畫出來了。Got ' + got.preview);
        assert.deepStrictEqual(got.missing, [],
          'T6b: 每一條 lane 都必須在預覽裡有自己的 wavelane_draw_<i>_9000，' +
          '否則 index 對不上、下面在比空氣。Got ' + JSON.stringify(got.missing));
        // …and the count itself has to come from the ENGINE, not from the thing
        // under test. `missing` only checks the indices the loop visits, and the
        // loop runs to the canvas's own `data-lane-count` — so a drawing that
        // dropped a whole lane would shorten the loop, agree on every lane it
        // still had, and stay green with the engine's extra lane group sitting
        // there unexamined. Both are 6 on this fixture and nobody had written
        // that down.
        assert.strictEqual(got.lanes, got.engineLanes,
          'T6b: 手繪的 lane 數必須等於引擎畫出來的 lane 數。Got ' +
          got.lanes + ' vs ' + got.engineLanes);
        assert.ok(got.totalUses > 0,
          'T6b: 預覽必須真的畫出 brick。Got ' + got.totalUses);
        assert.ok(got.engine.filter((row) => row !== '').length > 1,
          'T6b: 至少要有兩條 lane 真的畫了東西，否則整排都是「空 vs 空」。Got ' +
          JSON.stringify(got.engine));
        // period / phase / hscale change what the ENGINE paints and the drawing
        // does not model them; they also rescale the gap arithmetic above.
        assert.strictEqual(got.unmodelled, '',
          'T6b: 這個 fixture 不得帶 period/phase/hscale。Got ' +
          JSON.stringify(got.unmodelled));
        // Gaps, per lane and by POSITION — not a document-wide count. A count
        // stays green when the marker is drawn one cycle to the left or on the
        // neighbouring lane, which is exactly the class of bug it was there for.
        assert.deepStrictEqual(got.drawnGaps, got.engineGaps,
          'T6b: 斷點記號必須逐 lane、逐 cycle 對上\ndrawn : ' +
          JSON.stringify(got.drawnGaps) + '\nengine: ' + JSON.stringify(got.engineGaps));

        // The painted half. `expected` is derived from the ENGINE's own bricks,
        // so neither side of this comparison comes from the canvas's attributes.
        const familyOf = (brick) => {
          if (brick === '') return '';
          if (brick === 'xxx') return 'x';
          if (brick.slice(0, 4) === 'vvv-') return 'bus';
          if (brick === 'nclk' || brick === 'pclk') return 'clock';
          if (brick === '111' || brick === 'uuu') return 'hi';
          if (brick === '000' || brick === 'ddd') return 'lo';
          if (brick === 'zzz') return 'mid';
          return '?' + brick;
        };
        // Both sides are padded to the number of cycle COLUMNS the drawing has,
        // so the comparison stays positional: a lane the engine gives three
        // bricks on must be painted on exactly those three columns and blank on
        // the rest, and a lane it gives none on (the `{}` spacer) must be blank
        // everywhere rather than merely "not compared".
        const columns = got.gridCount - 1;
        const padTo = (arr) => {
          const out = arr.slice(0, columns);
          while (out.length < columns) out.push('');
          return out.join(' ');
        };
        const expected = got.engine.map((row) =>
          padTo((row === '' ? [] : row.split(' ')).map(familyOf)));
        assert.ok(got.gridCount > 1,
          'T6b: cycle 格線必須真的畫出來了，否則下面是拿空格線在分格。Got ' + got.gridCount);
        assert.ok(got.shapeCount > 0,
          'T6b: 畫布上必須真的有形狀，不只是屬性。Got ' + got.shapeCount);

        // …and EXACTLY as many shapes per lane as the engine's bricks call for,
        // not merely "at least one per cycle". `painted` samples one point per
        // cycle, so a drawing that leaks an extra shape between two correct ones
        // reads as correct — measured on a mutant that appends one stray rect
        // per run: `shapeCount` went 16 → 32 and every other assertion here
        // stayed green.
        //
        // The expected count is the number of RUNS in the engine's own row:
        // `drawLane` emits one shape per run of equal bricks, and clocks never
        // merge because each `p` cycle is a whole clock period. Edges, gap
        // markers and bus labels are excluded from `shapes` by class, so the
        // two sides count the same things.
        const runsOf = (row) => {
          const bricks = row === '' ? [] : row.split(' ');
          let n = 0;
          for (let k = 0; k < bricks.length; k++) {
            const clock = bricks[k] === 'nclk' || bricks[k] === 'pclk';
            if (k === 0 || clock || bricks[k] !== bricks[k - 1]) n++;
          }
          return n;
        };
        const expectedCounts = got.engine.map(runsOf);
        assert.deepStrictEqual(got.paintedCounts, expectedCounts,
          'T6b: 每一條 lane 畫出來的形狀【數量】必須剛好等於引擎那一列的 run 數\n' +
          'painted : ' + JSON.stringify(got.paintedCounts) + '\n' +
          'expected: ' + JSON.stringify(expectedCounts));
        // …and nothing painted outside every row band, which the per-lane sums
        // above cannot see on their own.
        assert.strictEqual(got.shapeCount,
          expectedCounts.reduce((a, b) => a + b, 0),
          'T6b: 不得有形狀畫在所有 lane 的範圍之外。Got ' + got.shapeCount +
          ' vs ' + expectedCounts.reduce((a, b) => a + b, 0));
        assert.deepStrictEqual(got.painted, expected,
          'T6b: 畫出來的【形狀】必須跟引擎逐格對上（不是只有 data-bricks 屬性對上）\n' +
          'painted : ' + JSON.stringify(got.painted) + '\n' +
          'expected: ' + JSON.stringify(expected));
        return got;
      };

      const ctx = await newPage(WAVE_MD);
      const dupBefore = await ctx.page.evaluate(() => {
        const seen = new Map();
        for (const el of document.querySelectorAll('[id]')) {
          seen.set(el.id, (seen.get(el.id) || 0) + 1);
        }
        return Array.from(seen.values()).filter((n) => n > 1).length;
      });
      await openWave(ctx.page);
      // The preview is a SECOND engine render into a page that already carries
      // one. Rendered at index 0 with the skin re-emitted it put 240 duplicate
      // `id`s into a document that had 0 — measured — including a second
      // definition of every brick symbol the first diagram's `<use>`s resolve
      // against. Its own index and the shared skin bring that back to 0.
      const dupAfter = await ctx.page.evaluate(() => {
        const seen = new Map();
        for (const el of document.querySelectorAll('[id]')) {
          seen.set(el.id, (seen.get(el.id) || 0) + 1);
        }
        return Array.from(seen.values()).filter((n) => n > 1).length;
      });
      assert.strictEqual(dupBefore, 0, 'T6b 前提失敗：開之前這一頁本來就沒有重複的 id');
      assert.strictEqual(dupAfter, 0,
        'T6b: 預覽不得在頁面上留下重複的 id。Got ' + dupAfter);
      const before = await bricks(ctx.page);
      // The fixture can express the defect: `ack` is written `.0..1` and the
      // engine draws it x x x x 1. A drawing that painted the characters would
      // read 0 here and this row would catch it.
      assert.strictEqual(before.wave, '.0..1', 'T6b 前提失敗：fixture 的 ack 必須是 .0..1');
      assert.strictEqual(before.levels, 'xxxx1',
        'T6b: 開頭是 repeater 的 lane，引擎畫的是 x 直到恢復。Got ' + before.levels);
      assert.deepStrictEqual(before.drawn, before.engine,
        'T6b: 自己畫的波形必須跟旁邊的 WaveDrom 預覽逐格一致\ndrawn : ' +
        JSON.stringify(before.drawn) + '\nengine: ' + JSON.stringify(before.engine));

      // …and it still agrees after an edit. `=` on a lane INSIDE the group, so
      // the lane index that got painted had to survive the flattening.
      await paintCell(ctx.page, 1, 4, '=');
      const after = await bricks(ctx.page);
      assert.notDeepStrictEqual(after.drawn, before.drawn,
        'T6b 前提失敗：那一筆編輯必須真的改到畫面，否則「編輯後仍一致」是空的');
      assert.deepStrictEqual(after.drawn, after.engine,
        'T6b: 編輯之後也必須逐格一致\ndrawn : ' + JSON.stringify(after.drawn) +
        '\nengine: ' + JSON.stringify(after.engine));

      // The gap axis is only covered if the fixture actually HAS one drawn, on
      // a lane this comparison names.
      assert.ok(after.engineGaps.some((x) => x !== ''),
        'T6b 前提失敗：fixture 必須真的帶一個 `|`，否則斷點那條斷言是空的。Got ' +
        JSON.stringify(after.engineGaps));
      // …and the spacer axis likewise: one lane with no `wave` key at all,
      // which the engine draws nothing for.
      assert.ok(after.hasWave.indexOf('0') !== -1,
        'T6b 前提失敗：fixture 必須帶一條沒有 wave 的 lane。Got ' +
        JSON.stringify(after.hasWave));
      const spacer = after.hasWave.indexOf('0');
      assert.strictEqual(after.drawn[spacer], '',
        'T6b: 沒有 wave 的 lane 引擎什麼都不畫，手繪也不准畫。Got ' +
        JSON.stringify(after.drawn[spacer]));
      assert.strictEqual(after.engine[spacer], '',
        'T6b 前提失敗：引擎對那條 lane 真的什麼都沒畫。Got ' +
        JSON.stringify(after.engine[spacer]));

      // …and an ALL-EMPTY diagram, which is two clicks away and which round 1
      // drew as four blank rows while the engine drew four x cycles. Select
      // every cycle of one lane and delete — `deleteCycles` narrows every lane
      // at once, so the whole diagram empties.
      await dragCells(ctx.page, 0, 0, 4);
      await pressClick(ctx.page, '.ed-wave-cycle-delete');
      await new Promise((r) => setTimeout(r, 300));
      const emptied = await bricks(ctx.page);
      for (let i = 0; i < emptied.hasWave.length; i++) {
        if (emptied.hasWave[i] !== '1') continue;
        assert.strictEqual(emptied.waves[i], '',
          'T6b 前提失敗：刪掉全部 cycle 之後 lane ' + i + ' 的 wave 該是空的。Got ' +
          JSON.stringify(emptied.waves[i]));
      }
      // The spacer is untouched by a cycle operation and still draws nothing,
      // so this leg also pins that「空字串」and「沒有這個鍵」stay apart.
      assert.strictEqual(emptied.hasWave[spacer], '0',
        'T6b: 刪 cycle 不得替沒有 wave 的 lane 生一個出來');
      assert.strictEqual(emptied.drawn[spacer], '',
        'T6b: 全空之後那條 spacer 仍然什麼都不畫。Got ' + JSON.stringify(emptied.drawn[spacer]));
      assert.deepStrictEqual(emptied.drawn, emptied.engine,
        'T6b: 空的 lane 是「一格 x」不是「什麼都不畫」\ndrawn : ' +
        JSON.stringify(emptied.drawn) + '\nengine: ' + JSON.stringify(emptied.engine));
      assert.strictEqual(ctx.errs.length, 0, 'T6b: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6b the hand-drawn waveform and the WaveDrom preview agree cycle by cycle, gaps and an emptied diagram included — OK');
    }

    // T6c — a group can be joined at its HEAD and never at its TAIL, and the UI
    // says which before the button is pressed.
    //
    // The asymmetry is `laneInsertPath`'s and is a consequence of flattened
    // indexing, not a bug to paper over. What can be got wrong is letting the
    // two look the same — this batch has already shipped one comparison that
    // made two different insert positions indistinguishable — so this row
    // asserts the DIFFERENCE first and only then what each one does.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      const labels = await ctx.page.evaluate(() =>
        Array.from(document.querySelectorAll('.ed-wave-lane-add')).map((b) => ({
          at: b.getAttribute('data-insert-at'),
          lands: b.getAttribute('data-lands-in'),
          title: b.title,
        })));
      const head = labels.find((l) => l.at === '1');
      const tail = labels.find((l) => l.at === '3');
      assert.ok(head && tail, 'T6c 前提失敗：群組的頭與尾都要有一顆 ＋。Got ' +
        JSON.stringify(labels));
      assert.notStrictEqual(head.lands, tail.lands,
        'T6c: 群組的頭與尾必須指向不同的落點，否則這個案例分辨不出任何東西。Got ' +
        JSON.stringify([head, tail]));
      assert.strictEqual(head.lands, 'bus',
        'T6c: 群組第一條 lane 前面插入會進群組。Got ' + JSON.stringify(head));
      assert.strictEqual(tail.lands, '',
        'T6c: 群組最後一條 lane 後面插入會落在群組外。Got ' + JSON.stringify(tail));
      assert.ok(tail.title.indexOf('群組外') !== -1,
        'T6c: 按下之前就要說清楚會落在群組外。Got ' + JSON.stringify(tail.title));

      const span = () => ctx.page.evaluate(() => {
        const g = document.querySelector('.ed-wave-group');
        return g === null ? null : g.getAttribute('data-group-from') + '-' +
          g.getAttribute('data-group-to');
      });
      assert.strictEqual(await span(), '1-2', 'T6c 前提失敗：群組一開始蓋住 row 1-2');

      await pressClick(ctx.page, '.ed-wave-lane-add[data-insert-at="3"]');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(await span(), '1-2',
        'T6c: 在群組尾巴新增的 lane 不得被吸進群組裡');
      const said = await ctx.page.$eval('.ed-wave-overlay',
        (el) => el.getAttribute('data-wave-status'));
      assert.ok(said.indexOf('群組外') !== -1,
        'T6c: 新增之後也要說它落在哪裡。Got ' + JSON.stringify(said));

      // And the head really does join, so the pair above is a real asymmetry
      // and not two spellings of the same behaviour.
      await pressClick(ctx.page, '.ed-wave-lane-add[data-insert-at="1"]');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(await span(), '1-3',
        'T6c: 在群組頭插入的 lane 必須真的進群組（群組因此多蓋一列）');
      assert.strictEqual(ctx.errs.length, 0, 'T6c: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6c a lane joins a group at its head and never at its tail, and says so first — OK');
    }

    // T6d — a block whose WaveJSON cannot be read still opens, and says what the
    // parser said and WHERE. A button that silently does nothing is the worst
    // outcome available here: the block looks editable and simply is not.
    {
      const BROKEN_MD = [
        '# W', '',
        '```wavedrom',
        '{ signal: [',
        "  { name: 'clk', wave: 'p....' },",
        "  ['bus',",
        "    { name: 'req', wave: '0.1.0' }",
        '  ',            // the group is never closed
        '] }',
        '```', '',
        'Tail para two.', '',
      ].join('\n');
      const ctx = await newPage(BROKEN_MD);
      await openWave(ctx.page);
      const got = await ctx.page.evaluate(() => {
        const o = document.querySelector('.ed-wave-overlay');
        const w = document.querySelector('.ed-wave-parse-where');
        return {
          state: o.getAttribute('data-wave-state'),
          msg: (document.querySelector('.ed-wave-parse-message') || {}).textContent || '',
          offset: w === null ? null : w.getAttribute('data-wave-offset'),
          where: w === null ? '' : w.textContent,
          excerpt: (document.querySelector('.ed-wave-parse-excerpt') || {}).textContent || '',
          hasCanvas: !!document.querySelector('.ed-wave-canvas'),
        };
      });
      assert.strictEqual(got.state, 'unreadable',
        'T6d: 讀不回來的區塊必須開出一個說明用的編輯器。Got ' + got.state);
      assert.strictEqual(got.hasCanvas, false,
        'T6d: 讀不回來的時候不得假裝有東西可以編輯');
      assert.ok(got.msg.length > 0 && got.msg.indexOf('讀不回來') !== -1,
        'T6d: 必須把 parser 的話原樣說出來。Got ' + JSON.stringify(got.msg));
      assert.ok(got.offset !== null && /^[0-9]+$/.test(got.offset),
        'T6d: offset 必須說出來。Got ' + JSON.stringify(got.offset));
      assert.ok(got.where.indexOf('offset ' + got.offset) !== -1,
        'T6d: 畫面上要看得到那個 offset。Got ' + JSON.stringify(got.where));
      assert.ok(got.excerpt.length > 0,
        'T6d: 只有 offset 對人沒有用，必須連那一行一起給。Got ' + JSON.stringify(got.excerpt));
      assert.strictEqual(ctx.errs.length, 0, 'T6d: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6d an unreadable wavedrom block opens an editor that says why and where — OK');
    }

    // ── fix round 1 ────────────────────────────────────────────────────
    //
    // T6e, T6f and T6g are one defect wearing three faces: the overlay lives
    // OUTSIDE `.content` so it cannot be serialised into the user's markdown,
    // and that same position puts it outside every assumption the surrounding
    // editor makes about where focus and keys can be. The answer is not three
    // patches — it is that the editor now says what it owns while it is open
    // and the surrounding code ASKS.

    // T6e — a Backspace typed into a wave field must not delete the user's
    // blocks. Measured before the fix: 3 blocks became 2, the tail paragraph
    // was gone, and the keystroke never reached the input at all.
    {
      const ctx = await newPage(WAVE_MD);
      const tailLine = await ctx.page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .find((b) => (b.textContent || '').indexOf('Tail para two') !== -1);
        return Number(el.getAttribute('data-block-id'));
      });
      const lineOf = await ctx.page.evaluate((id) => window.__ED__.blocks
        .find((b) => b.id === id).startLine, tailLine);
      const blockCount = () => ctx.page.evaluate(() =>
        document.querySelectorAll('.ed-block').length);
      const before = await blockCount();
      assert.ok(before >= 3, 'T6e 前提失敗：fixture 要有夠多的 block。Got ' + before);

      await ctx.page.evaluate((l) => window.__edTestSetSelection(l, l), lineOf);
      assert.notStrictEqual(await ctx.page.evaluate(() => window.__edTestGetSelection()), null,
        'T6e 前提失敗：必須真的有一組站著的 block 選取');

      await openWave(ctx.page);
      // Opening the editor settles the document and drops a selection the user
      // can no longer see.
      assert.strictEqual(await ctx.page.evaluate(() => window.__edTestGetSelection()), null,
        'T6e: 開啟波形編輯器時要把看不見的 block 選取收掉');

      // …and even with one deliberately standing again, a key typed into a
      // wave field is the field's.
      await ctx.page.evaluate((l) => window.__edTestSetSelection(l, l), lineOf);
      await pressClick(ctx.page, '.ed-wave-lane-name[data-focus-key="lane-name-0"]');
      await ctx.page.keyboard.press('Backspace');
      await new Promise((r) => setTimeout(r, 250));
      const after = await blockCount();
      const value = await ctx.page.$eval('.ed-wave-lane-name[data-focus-key="lane-name-0"]',
        (el) => el.value);
      assert.strictEqual(after, before,
        'T6e: 在波形欄位裡按 Backspace 不得刪掉使用者的 block。Got ' + after + ' / ' + before);
      assert.strictEqual(value, 'cl',
        'T6e: 那一下 Backspace 必須真的進到欄位裡（clk -> cl）。Got ' + JSON.stringify(value));
      assert.strictEqual(ctx.errs.length, 0, 'T6e: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6e a Backspace typed into a wave field never deletes the document — OK');
    }

    // T6e2 — the same guard, with no wave editor anywhere near it. The
    // block-selection branch's stated invariant is「focus is on a block wrapper
    // and not on any text surface」, and the reader's own search box is a text
    // surface outside `.content` that predates all of this. It was in the same
    // hole.
    {
      const ctx = await newPage(WAVE_MD);
      const lineOf = await ctx.page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.ed-block[data-block-type="paragraph"]'))
          .find((b) => (b.textContent || '').indexOf('Tail para two') !== -1);
        const id = Number(el.getAttribute('data-block-id'));
        return window.__ED__.blocks.find((b) => b.id === id).startLine;
      });
      const before = await ctx.page.evaluate(() =>
        document.querySelectorAll('.ed-block').length);
      await ctx.page.evaluate((l) => window.__edTestSetSelection(l, l), lineOf);
      await ctx.page.evaluate(() => {
        const box = document.getElementById('doc-search-input');
        box.focus();
        box.value = 'abc';
      });
      await ctx.page.keyboard.press('Backspace');
      await new Promise((r) => setTimeout(r, 250));
      const after = await ctx.page.evaluate(() => ({
        blocks: document.querySelectorAll('.ed-block').length,
        search: document.getElementById('doc-search-input').value,
      }));
      assert.strictEqual(after.blocks, before,
        'T6e2: 在搜尋框裡按 Backspace 不得刪掉 block。Got ' + after.blocks + ' / ' + before);
      assert.strictEqual(after.search, 'ab',
        'T6e2: 那一下必須進到搜尋框。Got ' + JSON.stringify(after.search));
      assert.strictEqual(ctx.errs.length, 0, 'T6e2: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6e2 the block-selection keys stay out of every text field, not just the ones in .content — OK');
    }

    // T6f — Ctrl+Z inside the overlay is the WAVEFORM's undo. Before the fix it
    // rolled back the markdown document behind the modal.
    {
      const ctx = await newPage(WAVE_MD);
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' EDITED');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const edited = () => ctx.page.evaluate(() =>
        (document.querySelector('.content').textContent || '').indexOf('EDITED') !== -1);
      assert.strictEqual(await edited(), true, 'T6f 前提失敗：那一筆編輯要先真的落地');

      await openWave(ctx.page);
      const wave0Before = await ctx.page.$eval('.ed-wave-canvas',
        (el) => el.getAttribute('data-wave-0'));
      await paintCell(ctx.page, 0, 2, '1');
      const painted = await ctx.page.$eval('.ed-wave-canvas',
        (el) => el.getAttribute('data-wave-0'));
      assert.ok(painted[2] === '1', 'T6f 前提失敗：要先有一筆波形編輯可以退。Got ' + painted);
      assert.notStrictEqual(painted, wave0Before,
        'T6f 前提失敗：那一筆塗抹要真的改到 wave');

      await ctx.page.evaluate(() => document.querySelector('.ed-wave-head-text').focus());
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('z');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const got = await ctx.page.evaluate(() => ({
        wave0: document.querySelector('.ed-wave-canvas').getAttribute('data-wave-0'),
        overlay: !!document.querySelector('.ed-wave-overlay'),
        doc: (document.querySelector('.content').textContent || '').indexOf('EDITED') !== -1,
      }));
      assert.strictEqual(got.overlay, true, 'T6f: overlay 要還在');
      assert.strictEqual(got.wave0, wave0Before,
        'T6f: Ctrl+Z 要退掉波形那一筆（回到塗之前的樣子）。Got ' + JSON.stringify(got.wave0));
      assert.strictEqual(got.doc, true,
        'T6f: Ctrl+Z 不得退掉 modal 後面那份 markdown 文件');
      assert.strictEqual(ctx.errs.length, 0, 'T6f: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6f Ctrl+Z inside the overlay undoes the waveform, not the document — OK');
    }

    // T6g — Escape mid-drag, then release. Before the fix the release still ran
    // the paint, into a store that was no longer on screen and through a
    // callback whose owner had been torn down: a page-level TypeError, plus two
    // leaked document listeners per cancelled drag.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      const a = await cellPoint(ctx.page, 0, 1);
      const b = await cellPoint(ctx.page, 0, 3);
      const wave0 = await ctx.page.$eval('.ed-wave-canvas',
        (el) => el.getAttribute('data-wave-0'));
      await ctx.page.mouse.move(a.x, a.y);
      await ctx.page.mouse.down();
      await ctx.page.mouse.move(b.x, b.y);
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(await ctx.page.$('.ed-wave-overlay'), null,
        'T6g 前提失敗：Escape 要把 overlay 收掉');
      await ctx.page.mouse.up();
      await ctx.page.mouse.move(b.x + 5, b.y);
      await ctx.page.mouse.move(b.x + 40, b.y + 10);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(ctx.errs.length, 0,
        'T6g: 拖到一半 Escape 再放開，不得有 pageerror: ' + ctx.errs.join(' | '));

      // The release must not have run the paint. Re-opening the block cannot
      // show that on its own: a gesture that arrives after the overlay came
      // down has no seam to write through (it is COUNTED as stray and returns
      // before commitRangeEdit), so the reopened editor reads the same source
      // either way and the comparison below is true whatever happened. What
      // DOES separate the two is whether a gesture ever reached the caller
      // after the overlay came down.
      //
      // v3.4.0 batch3 Task 7 correction: the sentence that stood here said
      // 「nothing writes back to the document yet」, which was a statement about
      // the FEATURE and is no longer true — an ordinary gesture now commits.
      // What makes this particular comparison toothless is narrower and
      // survives Task 7: no seam, no write. The `stray` assertion below is
      // still the one with teeth.
      const stray = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(stray.open, false, 'T6g: overlay 已經關掉了');
      assert.strictEqual(stray.stray, 0,
        'T6g: 編輯器關掉之後不得再有任何手勢送出來（那一筆是使用者取消掉的）。Got ' +
        stray.stray);

      // Re-open: the edit that was in flight must not have landed, and a
      // COMPLETED drag must still register — otherwise「沒有手勢」would be
      // satisfied by an editor that never reports anything at all.
      await openWave(ctx.page);
      const again = await ctx.page.$eval('.ed-wave-canvas',
        (el) => el.getAttribute('data-wave-0'));
      assert.strictEqual(again, wave0,
        'T6g: 被取消的那一筆塗抹不得寫進文件。Got ' + JSON.stringify(again));
      await dragCells(ctx.page, 0, 1, 3);
      const live = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(live.seam !== null && live.seam.gestured, true,
        'T6g 前提失敗：正常完成的拖曳必須有手勢送到 seam，否則上面那條 0 是空的。Got ' +
        JSON.stringify(live));
      assert.strictEqual(live.stray, 0, 'T6g: 正常的手勢不算 stray。Got ' + live.stray);
      assert.strictEqual(ctx.errs.length, 0, 'T6g: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6g Escape mid-drag cancels the paint and leaves nothing behind — OK');
    }

    // T6h — a gesture must not drop the keyboard cursor. The lane list is
    // rebuilt on every repaint, so before the fix committing a rename with
    // Enter left focus on document.body — which is also the state that turns
    // the next Backspace into「delete the selected blocks」.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await pressClick(ctx.page, '.ed-wave-lane-name[data-focus-key="lane-name-0"]');
      await ctx.page.keyboard.type('X');
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 300));
      const got = await ctx.page.evaluate(() => ({
        key: document.activeElement.getAttribute
          ? document.activeElement.getAttribute('data-focus-key') : null,
        tag: document.activeElement.tagName,
        value: document.activeElement.value,
      }));
      assert.strictEqual(got.key, 'lane-name-0',
        'T6h: 改完名字游標要留在同一個欄位。Got ' + JSON.stringify(got));
      assert.strictEqual(got.value, 'clkX', 'T6h: 欄位內容要是改過的那個。Got ' + got.value);

      // …and the ＋ hands the keyboard to the lane it just made.
      await pressClick(ctx.page, '.ed-wave-lane-add[data-insert-at="1"]');
      await new Promise((r) => setTimeout(r, 300));
      const added = await ctx.page.evaluate(() => document.activeElement.getAttribute
        ? document.activeElement.getAttribute('data-focus-key') : null);
      assert.strictEqual(added, 'lane-name-1',
        'T6h: 新增 lane 之後游標要落在新那一條的名字欄。Got ' + JSON.stringify(added));

      // …and walking a lane all the way to an EDGE. The last press of that walk
      // targets a button that is `disabled` at the edge, and `.focus()` on a
      // disabled button is inert — measured before the fix, three ▲ put the
      // cursor on `lane-up-2`, `lane-up-1` and then BODY, mid-gesture, and the
      // fourth press did nothing at all. Focus on body is the state that turns
      // the next Backspace into「delete the selected blocks」.
      const focusKey = () => ctx.page.evaluate(() => document.activeElement.getAttribute
        ? document.activeElement.getAttribute('data-focus-key') : null);
      const laneCount = await ctx.page.evaluate(() => Number(
        document.querySelector('.ed-wave-canvas').getAttribute('data-lane-count')));
      assert.ok(laneCount >= 3, 'T6h 前提失敗：要有夠多 lane 才走得到邊。Got ' + laneCount);
      // push lane 2 to the top
      for (let at = 2; at > 0; at--) {
        await pressClick(ctx.page, '.ed-wave-lane-up[data-focus-key="lane-up-' + at + '"]');
        await new Promise((r) => setTimeout(r, 250));
        const k = await focusKey();
        assert.notStrictEqual(k, null,
          'T6h: ▲ 走到第 ' + at + ' 步時游標掉到 body 上了');
      }
      assert.strictEqual(await focusKey(), 'lane-down-0',
        'T6h: 推到頂之後 ▲ 已經 disabled，游標要交給同一列還活著的 ▼。Got ' +
        JSON.stringify(await focusKey()));
      // and to the bottom
      const last = laneCount - 1;
      for (let at = 0; at < last; at++) {
        await pressClick(ctx.page, '.ed-wave-lane-down[data-focus-key="lane-down-' + at + '"]');
        await new Promise((r) => setTimeout(r, 250));
        assert.notStrictEqual(await focusKey(), null,
          'T6h: ▼ 走到第 ' + at + ' 步時游標掉到 body 上了');
      }
      assert.strictEqual(await focusKey(), 'lane-up-' + last,
        'T6h: 推到底之後 ▼ 已經 disabled，游標要交給 ▲。Got ' + JSON.stringify(await focusKey()));
      assert.strictEqual(ctx.errs.length, 0, 'T6h: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6h a committed gesture hands the keyboard cursor back — OK');
    }

    // T6i — the three properties the drawing does not model. The editor used to
    // ship an hscale CONTROL whose effect the canvas ignored; it is gone, and a
    // document carrying any of the three now says so instead of drawing a
    // confident wrong picture.
    {
      const SCALED_MD = [
        '# W', '',
        '```wavedrom',
        '{ config: { hscale: 2 },',
        '  signal: [',
        "    { name: 'clk', wave: 'p...', period: 2 },",
        "    ['bus', { name: 'req', wave: '0.1.', phase: 0.5 }]",
        '  ] }',
        '```', '',
        'Tail para two.', '',
      ].join('\n');
      const ctx = await newPage(SCALED_MD);
      await openWave(ctx.page);
      const got = await ctx.page.evaluate(() => ({
        unmodelled: document.querySelector('.ed-wave-overlay')
          .getAttribute('data-wave-unmodelled'),
        noticeHidden: document.querySelector('.ed-wave-unmodelled').hidden,
        notice: document.querySelector('.ed-wave-unmodelled').textContent,
        hscaleControls: document.querySelectorAll('.ed-wave-hscale').length,
        canvas: !!document.querySelector('.ed-wave-canvas'),
      }));
      assert.strictEqual(got.hscaleControls, 0,
        'T6i: 不得留著一個畫布根本不理會的 hscale 控制項。Got ' + got.hscaleControls);
      assert.strictEqual(got.canvas, true, 'T6i: 其他東西還是可以編輯');
      assert.strictEqual(got.noticeHidden, false, 'T6i: 提示必須看得見');
      for (const what of ['config.hscale', 'period', 'phase']) {
        assert.ok(got.unmodelled.indexOf(what) !== -1,
          'T6i: 提示要指名 ' + what + '。Got ' + JSON.stringify(got.unmodelled));
        assert.ok(got.notice.indexOf(what) !== -1,
          'T6i: 畫面上的字要指名 ' + what + '。Got ' + JSON.stringify(got.notice));
      }
      // …and a document carrying none of them says nothing at all, so the
      // notice is a signal and not wallpaper.
      await ctx.page.close(); ctx.srv.close();
      const plain = await newPage(WAVE_MD);
      await openWave(plain.page);
      const quiet = await plain.page.evaluate(() => ({
        unmodelled: document.querySelector('.ed-wave-overlay')
          .getAttribute('data-wave-unmodelled'),
        hidden: document.querySelector('.ed-wave-unmodelled').hidden,
      }));
      assert.strictEqual(quiet.unmodelled, '', 'T6i: 沒用到的文件不得跳提示');
      assert.strictEqual(quiet.hidden, true, 'T6i: 提示要收起來');
      assert.strictEqual(plain.errs.length, 0, 'T6i: 不得有 pageerror: ' + plain.errs.join(' | '));
      await plain.page.close(); plain.srv.close();
      console.log('journey: wave/T6i the editor says which properties the drawing does not model, and ships no control for them — OK');
    }

    // ── fix round 2 ────────────────────────────────────────────────────

    // T6j — the two new `position: fixed` layers answer the V3 census, and
    // nothing DROPPED on the modal reaches the document behind it.
    //
    // The V3 roster above lists `.ed-wave-edit-btn` as `gone` and
    // `.ed-wave-overlay` as `live`; this is the row that drives both. It lives
    // here rather than in the V3 section because it needs this block's fixture
    // and its opening gesture.
    {
      const WAVE_SCROLL_MD = WAVE_MD +
        Array.from({ length: 40 }, (_, i) => 'Filler line ' + i + '.').join('\n\n') + '\n';
      const ctx = await newPage(WAVE_SCROLL_MD);
      await ctx.page.waitForSelector('.wavedrom-diagram');
      const hoverDiagram = async () => {
        const box = await ctx.page.$eval('.wavedrom-diagram', (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await ctx.page.mouse.move(box.x, box.y);
        await new Promise((r) => setTimeout(r, 200));
      };

      // .ed-wave-edit-btn — gone. Its position comes from the hovered diagram's
      // own getBoundingClientRect(), i.e. viewport coordinates that a scroll
      // makes point at the wrong thing; same family as `.ed-te-grip`.
      await hoverDiagram();
      const btnBefore = await overlayState(ctx.page, '.ed-wave-edit-btn');
      assertRaised(btnBefore, '.ed-wave-edit-btn');
      await scrollBy(ctx.page, 900);
      const btnAfter = await overlayState(ctx.page, '.ed-wave-edit-btn');
      assert.ok(isGone(btnAfter),
        '.ed-wave-edit-btn 捲動後必須消失（它的座標會過期），got ' + JSON.stringify(btnAfter));

      // .ed-wave-overlay — live, at the same viewport coordinates, and the
      // document behind it does not scroll at all while it is up.
      //
      // The lock is the answer to a gap a state predicate over EVENTS cannot
      // close: native wheel scrolling is not delivered to any listener this file
      // guards, and measured, one wheel gesture over the panel took the document
      // behind it from `scrollY 0` to `800`. Nothing is mutated by that, but the
      // roster above classifies `.ed-wave-edit-btn` as `gone` precisely because
      // a scroll invalidates coordinates, and the same scroll moves where the
      // user lands when the overlay closes.
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 250));
      const scrollable = await ctx.page.evaluate(() =>
        document.documentElement.scrollHeight > window.innerHeight);
      assert.strictEqual(scrollable, true,
        'T6j 前提失敗：這份文件本來就要捲得動，否則「鎖住」什麼都沒證明');
      await openWave(ctx.page);
      const ovBefore = await overlayState(ctx.page, '.ed-wave-overlay');
      assertRaised(ovBefore, '.ed-wave-overlay');
      // The gesture, not a programmatic call. What the lock removes is the
      // user-agent's own scrolling mechanism, which is what R2 named: pointer
      // over the panel, one wheel, `scrollY 0 → 800`. MEASURED here, both ways
      // round: with `overflow: hidden` on the root a wheel leaves `scrollY` at 0
      // while `window.scrollBy(0, 900)` still moves it to 900 — that is what
      // `hidden` means, and `clip` measured identically in this Chromium. A
      // script calling `scrollBy` is the page's own code and not the hand this
      // was about, and nothing on the overlay's path does.
      const panelBox = await ctx.page.$eval('.ed-wave-panel', (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await ctx.page.mouse.move(panelBox.x, panelBox.y);
      await ctx.page.mouse.wheel({ deltaY: 800 });
      await new Promise((r) => setTimeout(r, 400));
      const lockedY = await ctx.page.evaluate(() => window.scrollY);
      assert.strictEqual(lockedY, 0,
        'T6j: modal 開著時滾輪不得捲動後面那份文件。Got ' + lockedY);

      // …and now a scroll that the lock does NOT block, because the `live`
      // half of this census row is only meaningful across a page that really
      // moved. The version this comment replaced deleted the scroll when it
      // added the lock, and then compared `top` before and after a scroll the
      // line above asserts did not happen. Measured on a sandbox whose only
      // change was `.ed-wave-overlay { position: absolute }`: THE VERSION THIS
      // REPLACED passed — it missed the defect — while this shape fails it at
      // `top -900 === 0`. That is the class this row exists for and the one this
      // branch already paid for once. `scrollBy` moves while a wheel does not:
      // that is what `overflow: hidden` means, measured both ways.
      await scrollBy(ctx.page, 900);
      const ovAfter = await overlayState(ctx.page, '.ed-wave-overlay');
      assert.ok(isLive(ovAfter),
        '.ed-wave-overlay 捲動後必須仍然可見，got ' + JSON.stringify(ovAfter));
      assert.strictEqual(ovAfter.top, ovBefore.top,
        '.ed-wave-overlay 捲動後必須留在同一個視窗座標，got top=' + ovAfter.top);
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 250));

      // A file dropped on the panel. Before the state-based gate this reached
      // the document's own `drop` listener and inserted an image into `.content`
      // behind the modal — measured, 4 blocks became 5 with the overlay still up
      // and saying nothing about it.
      const dropPng = (sel) => ctx.page.evaluate((s2) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
          'probe.png', { type: 'image/png' }));
        const ev = new DragEvent('drop',
          { bubbles: true, cancelable: true, dataTransfer: dt });
        document.querySelector(s2).dispatchEvent(ev);
        return ev.defaultPrevented;
      }, sel);
      const blockCount = () => ctx.page.evaluate(() =>
        document.querySelectorAll('.ed-block').length);
      const before = await blockCount();
      const preventedOnPanel = await dropPng('.ed-wave-panel');
      await new Promise((r) => setTimeout(r, 900));
      assert.strictEqual(await blockCount(), before,
        'T6j: 丟在 modal 上的檔案不得寫進後面那份文件');
      assert.strictEqual(preventedOnPanel, false,
        'T6j: 那個 drop 必須被【婉拒】（不 preventDefault），而不是被吞掉');

      // The control leg, and the reason the assertions above are not vacuous:
      // with NO overlay open the same scroll moves the page and the same
      // synthetic drop really does insert.
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(await ctx.page.$('.ed-wave-overlay'), null,
        'T6j 前提失敗：Escape 要把 overlay 收掉');
      // The SAME wheel gesture, so the control leg and the locked leg differ in
      // exactly one thing: whether the modal is up.
      await ctx.page.mouse.move(panelBox.x, panelBox.y);
      await ctx.page.mouse.wheel({ deltaY: 800 });
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(await ctx.page.evaluate(() => window.scrollY) > 0,
        'T6j 前提失敗：關掉之後同一個滾輪手勢必須捲得動，否則「鎖住」那條是空的');
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 200));
      const preventedOnBlock = await dropPng('.ed-block[data-block-type="paragraph"]');
      await new Promise((r) => setTimeout(r, 2500));
      assert.strictEqual(preventedOnBlock, true,
        'T6j 前提失敗：沒有 modal 時這個 drop 必須被接走，否則上面那條是空的');
      assert.ok(await blockCount() > before,
        'T6j 前提失敗：沒有 modal 時同一個 drop 真的會多一個 block，' +
        '否則「modal 時不會多」什麼都沒證明。Got ' + (await blockCount()) + ' / ' + before);
      assert.strictEqual(ctx.errs.length, 0, 'T6j: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6j the two fixed layers answer the scroll census, and a file dropped on the modal never reaches the document — OK');
    }

    // T6k — the modal focus model, and the one layer that is allowed above it.
    //
    // `role="dialog"` + `aria-modal="true"` was a promise the panel did not
    // keep: nothing was focused on open (measured: activeElement was BODY), so
    // the surrounding editor still owned every key, and its own「nothing
    // focused」branch then swallowed Tab so none of the dialog's controls could
    // be reached at all.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      const opened = await ctx.page.evaluate(() => ({
        cls: document.activeElement.className,
        inOverlay: document.querySelector('.ed-wave-overlay').contains(document.activeElement),
      }));
      assert.strictEqual(opened.inOverlay, true,
        'T6k: 開起來的瞬間焦點就必須在 dialog 裡。Got ' + JSON.stringify(opened));
      assert.strictEqual(opened.cls, 'ed-wave-panel',
        'T6k: 初始焦點是 dialog 自己（ARIA 的預設），不是第一顆按鈕。Got ' +
        JSON.stringify(opened.cls));

      // Walk PAST the end of the dialog and back round. Three presses prove
      // nothing: the overlay is the last thing in `body`, so native tabbing
      // also stays inside it for the first ~N presses and a short walk is
      // satisfied by having no trap at all — measured, a trap-less build passes
      // a three-press check. What separates them is the wrap: with a trap the
      // last control leads back to the first, without one it leads out into the
      // page behind the modal.
      const focusCount = await ctx.page.evaluate(() => {
        const FOC = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
        return Array.prototype.filter.call(
          document.querySelector('.ed-wave-overlay').querySelectorAll(FOC),
          (el) => !el.disabled && !el.hidden && el.getClientRects().length > 0).length;
      });
      assert.ok(focusCount > 5,
        'T6k 前提失敗：dialog 要有夠多控制項，繞一圈才有意義。Got ' + focusCount);
      let escaped = null;
      let landedOnAControl = false;
      for (let i = 0; i < focusCount + 3; i++) {
        await ctx.page.keyboard.press('Tab');
        const at = await ctx.page.evaluate(() => ({
          inOverlay: document.querySelector('.ed-wave-overlay').contains(document.activeElement),
          key: document.activeElement.getAttribute
            ? document.activeElement.getAttribute('data-focus-key') : null,
          tag: document.activeElement.tagName,
        }));
        if (at.key !== null) landedOnAControl = true;
        if (!at.inOverlay && escaped === null) escaped = { press: i + 1, at: at };
      }
      assert.strictEqual(escaped, null,
        'T6k: Tab 必須留在 dialog 裡整整一圈（而且不得被外面那條「沒有東西 focus」的' +
        '分支吞掉）。逃出去了：' + JSON.stringify(escaped));
      assert.strictEqual(landedOnAControl, true,
        'T6k: Tab 必須真的落在控制項上，不能只是停在 dialog 自己身上');

      // The conflict banner is the ONE layer allowed above this modal, and it
      // has to stay reachable both ways. `.ed-conflict` is what showBanner()
      // builds — a div of that class on document.body with its own buttons —
      // and what is under test here is the STACKING and the TRAP SCOPE, both of
      // which depend only on the class and on being on body, so the banner is
      // constructed directly rather than by provoking a disk conflict.
      const stack = await ctx.page.evaluate(() => {
        const el = document.createElement('div');
        el.className = 'ed-conflict';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Reload';
        el.appendChild(b);
        document.body.appendChild(el);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const cs = getComputedStyle(el);
        return {
          bannerZ: cs.zIndex, bannerPos: cs.position,
          overlayZ: getComputedStyle(document.querySelector('.ed-wave-overlay')).zIndex,
          hitInBanner: el.contains(hit),
        };
      });
      assert.strictEqual(stack.bannerPos, 'fixed', 'T6k 前提失敗：橫幅是 position: fixed');
      assert.ok(Number(stack.bannerZ) > Number(stack.overlayZ),
        'T6k: 磁碟衝突橫幅必須疊在波形編輯器【上面】（它是使用者解決衝突的唯一出口）。Got ' +
        stack.bannerZ + ' vs ' + stack.overlayZ);
      // What is asserted is「命中測試落在橫幅【裡面】」, deliberately not which
      // child. MEASURED: on this row's own banner (one Reload button) the centre
      // is the BUTTON; on the banner `showConflictBanner()` really builds
      // (message span + Reload + ✕) it is the SPAN. Both mean the same thing —
      // the modal is not intercepting the banner's own rect — and naming a tag
      // would pin a fact about this fixture rather than about the stacking.
      assert.strictEqual(stack.hitInBanner, true,
        'T6k: 橫幅矩形中心的命中測試必須落在橫幅自己身上，否則滑鼠點不到它');

      // …and the keyboard. A trap scoped to the overlay alone would paint the
      // banner on top and still make its buttons unreachable.
      let reached = -1;
      for (let i = 0; i < 80; i++) {
        await ctx.page.keyboard.press('Tab');
        const inBanner = await ctx.page.evaluate(() =>
          document.querySelector('.ed-conflict').contains(document.activeElement));
        if (inBanner) { reached = i + 1; break; }
      }
      assert.notStrictEqual(reached, -1,
        'T6k: focus trap 的範圍必須含現場的 .ed-conflict，否則衝突橫幅用鍵盤永遠按不到');
      assert.strictEqual(ctx.errs.length, 0, 'T6k: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6k the dialog takes the keyboard, keeps it, and lets the conflict banner through — OK');
    }

    // T6k2 — the UNREADABLE panel owns undo too. It has no store to move, and
    // returning early used to hand Ctrl+Z straight to the editor behind the
    // modal: measured, a committed paragraph edit rolled back with the panel
    // still on screen.
    {
      const BROKEN_MD = [
        '# W', '',
        '```wavedrom',
        '{ signal: [',
        "  { name: 'clk', wave: 'p....' },",
        "  ['bus',",
        "    { name: 'req', wave: '0.1.0' }",
        '  ',
        '] }',
        '```', '',
        'Tail para two.', '',
      ].join('\n');
      const ctx = await newPage(BROKEN_MD);
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' EDITED');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const edited = () => ctx.page.evaluate(() =>
        (document.querySelector('.content').textContent || '').indexOf('EDITED') !== -1);
      assert.strictEqual(await edited(), true, 'T6k2 前提失敗：那一筆編輯要先真的落地');

      await openWave(ctx.page);
      assert.strictEqual(await ctx.page.$eval('.ed-wave-overlay',
        (el) => el.getAttribute('data-wave-state')), 'unreadable',
        'T6k2 前提失敗：這個區塊要開出「讀不回來」的面板');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('z');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 400));
      assert.strictEqual(await edited(), true,
        'T6k2: 讀不回來的面板上按 Ctrl+Z，不得退掉 modal 後面那份 markdown 文件');
      assert.ok(await ctx.page.$('.ed-wave-overlay'), 'T6k2: 面板要還在');
      assert.strictEqual(ctx.errs.length, 0, 'T6k2: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6k2 the unreadable panel owns undo as well, so the document behind it stays put — OK');
    }

    // ── fix round 3 ────────────────────────────────────────────────────

    // T6l — Ctrl+S is not the modal's to swallow, and a disk conflict that
    // arises DURING a wave session still reaches the user.
    //
    // Round 2 made ownership a state, and the state then swallowed a gesture
    // that was never the editor's: measured, Ctrl+S with the overlay open put
    // nothing on disk, and Escape-then-Ctrl+S did. The second-order cost was
    // worse — `showConflictBanner()` has exactly ONE producer, the 409 branch of
    // `save()`, and the toolbar's save control sits under an `inset: 0` backdrop
    // and outside the focus trap. With Ctrl+S swallowed there was no route at
    // all by which a conflict arising mid-session could be announced.
    {
      const ctx = await newPage(WAVE_MD);
      const disk = () => fs.readFileSync(ctx.mdPath, 'utf8');
      // Deliberately NOT pressSaveAndLand(): this row's whole subject is
      // whether the keystroke reaches disk at all, so it watches the DISK and
      // must not be handed a helper that waits for the save first — that would
      // make the observation depend on the thing being observed.
      const ctrlS = async () => {
        await ctx.page.keyboard.down('Control');
        await ctx.page.keyboard.press('KeyS');
        await ctx.page.keyboard.up('Control');
      };
      // Wait for the FILE, not for a quiet page: the thing under test is
      // whether the keystroke reached disk, so the disk is what is watched.
      const diskBecomes = async (needle, ms) => {
        const until = Date.now() + ms;
        for (;;) {
          if (disk().indexOf(needle) !== -1) return true;
          if (Date.now() > until) return false;
          await new Promise((r) => setTimeout(r, 100));
        }
      };

      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' MARKA');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      assert.strictEqual(disk().indexOf('MARKA'), -1,
        'T6l 前提失敗：提交還沒有寫進磁碟，所以下面那次存檔才是被測的東西');

      await openWave(ctx.page);
      await ctrlS();
      assert.strictEqual(await diskBecomes('MARKA', 8000), true,
        'T6l: overlay 開著時按 Ctrl+S 必須真的寫進磁碟。Disk:\n' + disk());

      // …and a conflict that arises now. Rewriting the file underneath makes
      // the editor's `baseMtimeMs` stale, so the next save is a 409 — the one
      // thing that produces this banner.
      await new Promise((r) => setTimeout(r, 1100));
      fs.writeFileSync(ctx.mdPath, disk() + '\nEXTERNAL EDIT\n', 'utf8');
      assert.strictEqual(await ctx.page.$('.ed-conflict'), null,
        'T6l 前提失敗：現在還不該有 banner');
      await ctrlS();
      await ctx.page.waitForSelector('.ed-conflict', { timeout: 10000 });
      const banner = await ctx.page.evaluate(() => {
        const el = document.querySelector('.ed-conflict');
        return {
          text: el.textContent || '',
          buttons: Array.prototype.map.call(el.querySelectorAll('button'),
            (b) => b.textContent),
          overlayStillUp: !!document.querySelector('.ed-wave-overlay'),
          z: Number(getComputedStyle(el).zIndex),
          overlayZ: Number(getComputedStyle(document.querySelector('.ed-wave-overlay')).zIndex),
        };
      });
      assert.ok(banner.text.indexOf('changed on disk') !== -1,
        'T6l: 那必須是磁碟衝突那條 banner。Got ' + JSON.stringify(banner.text));
      assert.ok(banner.buttons.indexOf('Reload') !== -1,
        'T6l: banner 上要有 Reload 可以按。Got ' + JSON.stringify(banner.buttons));
      assert.strictEqual(banner.overlayStillUp, true,
        'T6l: banner 升起來不得把使用者手上的波形編輯器無預警關掉');
      assert.ok(banner.z > banner.overlayZ,
        'T6l: banner 必須疊在 modal 上面。Got ' + banner.z + ' vs ' + banner.overlayZ);
      // …and it is reachable from inside the trap, which is what makes it an
      // announcement rather than a decoration.
      let reached = -1;
      for (let i = 0; i < 120; i++) {
        await ctx.page.keyboard.press('Tab');
        const inBanner = await ctx.page.evaluate(() =>
          document.querySelector('.ed-conflict').contains(document.activeElement));
        if (inBanner) { reached = i + 1; break; }
      }
      assert.notStrictEqual(reached, -1,
        'T6l: 真正的衝突 banner 也必須 Tab 得到');
      assert.strictEqual(ctx.errs.length, 0, 'T6l: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6l Ctrl+S still saves through the modal, and a conflict raised mid-session is announced and reachable — OK');
    }

    // T6m — Escape with the cursor on the conflict banner is the banner's
    // Escape, not the dialog's.
    //
    // The banner is inside the focus trap on purpose, and round 2 then had the
    // dialog claim every Escape unconditionally: measured, someone who
    // Tab-walked over to read the banner and pressed Escape to back out lost the
    // whole editing session while the banner they were looking at stayed up.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await ctx.page.evaluate(() => {
        const el = document.createElement('div');
        el.className = 'ed-conflict';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Reload';
        el.appendChild(b);
        document.body.appendChild(el);
        b.focus();
      });
      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(await ctx.page.evaluate(() =>
        document.querySelector('.ed-conflict').contains(document.activeElement)), true,
        'T6m 前提失敗：游標要先在 banner 上');
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 250));
      const after = await ctx.page.evaluate(() => ({
        overlay: !!document.querySelector('.ed-wave-overlay'),
        banner: !!document.querySelector('.ed-conflict'),
        stillOnBanner: document.querySelector('.ed-conflict')
          ? document.querySelector('.ed-conflict').contains(document.activeElement) : false,
      }));
      assert.strictEqual(after.overlay, true,
        'T6m: 在 banner 上按 Escape 不得把整個波形編輯器關掉');
      assert.strictEqual(after.banner, true, 'T6m: banner 還在（它自己沒有 Escape）');
      assert.strictEqual(after.stillOnBanner, true, 'T6m: 游標也留在原地');

      // …and Escape from inside the DIALOG still closes it, so the exemption is
      // about where the key came from and not about Escape having stopped
      // working.
      await ctx.page.evaluate(() =>
        document.querySelector('.ed-wave-close').focus());
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 250));
      assert.strictEqual(await ctx.page.$('.ed-wave-overlay'), null,
        'T6m: 從 dialog 裡按 Escape 仍然要關掉它');
      assert.strictEqual(ctx.errs.length, 0, 'T6m: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T6m Escape on the conflict banner is the banner\'s, not the dialog\'s — OK');
    }

    // ── v3.4.0 batch3 Task 7: the write-back ───────────────────────────────
    //
    // Tasks 1-6 built a store that can turn a drawing into a minimal patch and
    // a modal that computes one per gesture. Nothing wrote it anywhere. These
    // rows are that seam: one gesture is one commit on the document's own undo
    // stack, Ctrl+S is still the only thing that touches disk, Escape takes the
    // session back off again and one Ctrl+Z puts it back, a refusal is raised
    // by name instead of being papered over, and — the one that had no net at
    // all before — the conflict banner's Reload cannot throw a drawing away in
    // silence.

    // T7a — one gesture, one commit; Ctrl+S is what reaches disk, and the
    // comment beside the lane survives the round trip.
    //
    // The comment is the point of the whole codec layer, not decoration: a
    // write-back that re-serialised the block would take `// 主時脈` with it,
    // and the block would still parse, so nothing downstream would notice.
    {
      const ctx = await newPage(WAVE_MD);
      const before = fs.readFileSync(ctx.mdPath, 'utf8');
      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');

      const mid = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(mid.seam === null ? null : mid.seam.ops, 1,
        'T7a: 一個手勢就是一次 commit。Got ' + JSON.stringify(mid.seam));
      assert.strictEqual(mid.unwritten, false,
        'T7a: 這個 patch 是寫得回去的，不該被記成「沒寫回去」');
      assert.strictEqual(mid.dirty, true,
        'T7a: 畫下去的那一刻文件就必須是髒的 —— 這是 Reload／關分頁那道網的依據');

      // 還沒有人叫它存檔，所以磁碟不得動。
      assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), before,
        'T7a: 寫回是寫進記憶體裡的文件，不是寫進磁碟');

      await pressClick(ctx.page, '.ed-wave-close');
      await ctx.page.waitForFunction(
        () => document.querySelector('.ed-wave-overlay') === null, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 800));
      // 關掉編輯器本身也不得落磁碟 —— 這一半是 brief 的第二條。
      assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8'), before,
        'T7a: 關閉編輯器不得自己落磁碟 —— 只有 Ctrl+S 才可以');

      const md = await saveAndRead(ctx);
      assert.ok(md.indexOf('// 主時脈') !== -1,
        'T7a: 註解必須存活（最小 patch 的整個理由）。Got:\n' + md);
      // 'p....' 的第 2 格塗成 1，第 3 格的重複符號因此失去它在重複的東西，
      // codec 把它展開回 p —— 這個值是本 session 直接跑 wave-store 量到的，
      // 不是推算的。
      assert.ok(md.indexOf("wave: 'p.1p.'") !== -1,
        'T7a: 改動必須落到磁碟，而且是就地改那一個字串。Got:\n' + md);
      assert.strictEqual(ctx.errs.length, 0, 'T7a: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7a one gesture is one commit, Ctrl+S is what reaches disk, and the lane comment survives — OK');
    }

    // T7b — Escape 丟棄，而且丟乾淨：文件回到原樣、● 熄掉。然後 Ctrl+Z 把它
    // 拿回來，連編輯器一起。
    //
    // 「拿回來」這一半刻意不只斷言 overlay 又出現：一個什麼都沒放回去、只是
    // 重開一個空編輯器的實作也會讓那條斷言變綠。所以最後是去讀磁碟。
    {
      const ctx = await newPage(WAVE_MD);
      const before = fs.readFileSync(ctx.mdPath, 'utf8');
      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      const during = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title }));
      assert.strictEqual(during.s.dirty, true, 'T7b 前提失敗：畫完就該是髒的');
      assert.strictEqual(during.title.indexOf('●'), 0,
        'T7b 前提失敗：畫完標題就該亮 ●，got ' + JSON.stringify(during.title));

      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 600));
      const afterEsc = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title }));
      assert.strictEqual(afterEsc.s.open, false, 'T7b: Escape 要關掉編輯器');
      assert.strictEqual(afterEsc.s.stashed, true,
        'T7b: Escape 丟掉的東西必須停放起來，否則 Ctrl+Z 沒有東西可以拿');
      assert.strictEqual(afterEsc.s.dirty, false,
        'T7b: Escape 要把這一整段 session 從 undo stack 上拿掉，文件回到原樣');
      assert.strictEqual(afterEsc.title.indexOf('●'), -1,
        'T7b: 回到原樣之後 ● 必須熄掉，got ' + JSON.stringify(afterEsc.title));

      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await ctx.page.waitForSelector('.ed-wave-overlay', { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 400));
      const back = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(back.open, true,
        'T7b: Escape 之後的 Ctrl+Z 必須把丟掉的編輯拿回來（重開編輯器）');
      assert.strictEqual(back.stashed, false,
        'T7b: 停放是一次性的 —— 拿回來之後不得再留著');
      assert.strictEqual(back.dirty, true,
        'T7b: 拿回來的編輯是一筆真的、還沒存檔的改動');

      const md = await saveAndRead(ctx);
      assert.ok(md.indexOf("wave: 'p.1p.'") !== -1,
        'T7b: 拿回來的必須是【畫過的那份】，不是一個空編輯器。Got:\n' + md);
      assert.ok(md.indexOf('// 主時脈') !== -1, 'T7b: 註解一樣要活著');
      assert.notStrictEqual(md, before, 'T7b: 而且它真的跟原檔不一樣');
      assert.strictEqual(ctx.errs.length, 0, 'T7b: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7b Escape takes the session back off the document and one Ctrl+Z puts it back with the editor — OK');
    }

    // T7c — 衝突 banner 上的 Reload 不得無聲丟掉畫好的波形。
    //
    // 這是 Task 6 量到的洞：真的畫完之後文件【不是】髒的、磁碟 byte-identical、
    // 按 Reload 連一個 beforeunload 對話框都不會跳 —— 因為那道網問的是 `lines`，
    // 而波形從來沒有進過 `lines`。寫回一落地它就自己補上了，這兩列是去證明它
    // 真的補上了，而且【沒畫東西的時候不會亂攔】。
    //
    // 控制組先跑，而且是分開的一顆 page：沒有被攔的那一次，頁面是真的會重新
    // 載入的。
    const raiseConflict = async (ctx) => {
      // 讓下一次存檔變成 409：那是 showConflictBanner() 唯一的產生點。
      await new Promise((r) => setTimeout(r, 1100));
      fs.writeFileSync(ctx.mdPath,
        fs.readFileSync(ctx.mdPath, 'utf8') + '\nEXTERNAL EDIT\n', 'utf8');
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyS');
      await ctx.page.keyboard.up('Control');
      await ctx.page.waitForSelector('.ed-conflict', { timeout: 10000 });
    };
    const pressReload = async (ctx) => {
      // 按的是 banner 上那顆真的按鈕，不是直接呼叫 location.reload()：這一列
      // 的主詞就是那顆按鈕。
      await ctx.page.evaluate(() => {
        const bs = document.querySelectorAll('.ed-conflict button');
        for (const b of bs) if (b.textContent === 'Reload') { b.click(); return; }
        throw new Error('no Reload button on the banner');
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    };
    {
      // 控制組：編輯器開著，但一筆都沒畫 —— 按 Reload 不得被攔。
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await raiseConflict(ctx);
      let blocked = false;
      ctx.page.once('dialog', async (d) => { blocked = true; await d.dismiss(); });
      const cleanBefore = await ctx.page.evaluate(() => window.__edTestWaveState().dirty);
      await pressReload(ctx);
      assert.strictEqual(cleanBefore, false,
        'T7c 控制組前提失敗：什麼都沒畫的時候文件不該是髒的');
      assert.strictEqual(blocked, false,
        'T7c 控制組：什麼都沒畫就不得攔 Reload —— 那是一個關不掉的對話框');
      await ctx.page.close(); ctx.srv.close();
    }
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      await raiseConflict(ctx);
      const armed = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(armed.dirty, true,
        'T7c 前提失敗：畫過之後文件必須是髒的，否則下面那道網沒有依據');
      assert.strictEqual(armed.open, true,
        'T7c 前提失敗：banner 升起來不得把編輯器關掉（T6l 已經釘過）');
      let blocked = false;
      ctx.page.once('dialog', async (d) => { blocked = true; await d.dismiss(); });
      await pressReload(ctx);
      assert.strictEqual(blocked, true,
        'T7c: 畫過波形之後按 Reload 必須被攔下來 —— 使用者不得在沒有被告知的' +
        '情況下失去畫好的東西');
      // 取消之後東西還在原地：被攔住而失去現場，跟沒被攔住一樣糟。
      const after = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(after.open, true, 'T7c: 取消離站之後編輯器要還在');
      assert.strictEqual(after.dirty, true, 'T7c: 畫的東西也要還在');
      assert.strictEqual(ctx.errs.length, 0, 'T7c: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7c the conflict banner\'s Reload cannot silently discard a drawn waveform — OK');
    }

    // T7d — 寫不回去的那一步：升起可見的說明、指名行號、等使用者確認，而且
    // 【不得】偷偷把整個區塊重寫掉。
    //
    // 驅動方式是同一個位置連按兩次「＋」。第二次之所以一定被拒絕，是因為兩條
    // 新 lane 插在來源的同一個位元組位置上，誰先誰後沒有定義 —— 本 session
    // 直接跑 wave-store 確認過這個 fixture 會回 ok:false，理由是
    // 「the same path ["signal",1,1] appears in two edits」。而且那個位置在
    // 群組 bus 裡面，所以它同時也是「插入點會落進群組」那條不對稱規則的現場。
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await pressClick(ctx.page, '[data-focus-key="lane-add-1"]');
      await new Promise((r) => setTimeout(r, 400));
      const one = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(one.seam === null ? null : one.seam.ops, 1,
        'T7d 前提失敗：第一次插入必須是寫得回去的。Got ' + JSON.stringify(one.seam));
      assert.strictEqual(one.unwritten, false, 'T7d 前提失敗：第一次不該被拒絕');

      await pressClick(ctx.page, '[data-focus-key="lane-add-1"]');
      await new Promise((r) => setTimeout(r, 400));
      const two = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(two.seam === null ? null : two.seam.ops, 1,
        'T7d: 第二次寫不回去，就不得多出一次 commit —— 那會是偷偷重寫整個區塊');
      assert.strictEqual(two.unwritten, true,
        'T7d: 寫不回去這件事必須被記住，它就是 beforeunload 那道網的另一半');
      assert.strictEqual(two.dirty, true,
        'T7d: 螢幕上有一步是檔案沒有的，這時候離站必須被攔');

      const banner = await visibleBannerText(ctx.page);
      assert.ok(banner !== null, 'T7d: 拒絕必須升起看得見的說明，不是只寫在狀態列');
      assert.ok(banner.indexOf('沒有') !== -1 && banner.indexOf('寫回') !== -1,
        'T7d: 說明要講清楚它【沒有】寫回去。Got ' + JSON.stringify(banner));
      assert.ok(/第 \d+–\d+ 行/.test(banner),
        'T7d: 說明要指名是哪一段行號。Got ' + JSON.stringify(banner));
      assert.ok(banner.indexOf('appears in two edits') !== -1,
        'T7d: store 的拒絕理由要原封不動傳到使用者面前。Got ' + JSON.stringify(banner));
      assert.ok(banner.indexOf('知道了') !== -1,
        'T7d: 要有一顆確認鈕可以按。Got ' + JSON.stringify(banner));

      // 按下確認只收掉那條 banner，不收掉「還有一步沒寫回去」這個事實。
      await ctx.page.evaluate(() => {
        const bs = document.querySelectorAll('.ed-conflict button');
        for (const b of bs) if (b.textContent === '知道了') { b.click(); return; }
        throw new Error('no 知道了 button');
      });
      await new Promise((r) => setTimeout(r, 250));
      const acked = await ctx.page.evaluate(() => ({
        banner: document.querySelector('.ed-conflict') !== null,
        s: window.__edTestWaveState(),
      }));
      assert.strictEqual(acked.banner, false, 'T7d: 按了知道了，banner 要收掉');
      assert.strictEqual(acked.s.unwritten, true,
        'T7d: 但「有一步沒寫回去」不會因為讀過說明就消失');
      assert.strictEqual(acked.s.dirty, true, 'T7d: 所以離站也還是要被攔');

      // 磁碟上只能有寫得回去的那一步。
      const md = await saveAndRead(ctx);
      const added = md.match(/name: ""/g) || [];
      assert.strictEqual(added.length, 1,
        'T7d: 檔案裡只能有第一次插入的那一條 lane。Got:\n' + md);
      assert.ok(md.indexOf('// 主時脈') !== -1, 'T7d: 註解一樣要活著');
      assert.strictEqual(ctx.errs.length, 0, 'T7d: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7d a refusal is raised by name, waits to be acknowledged, and never rewrites the block — OK');
    }

    // ── fix round 1 ────────────────────────────────────────────────────────

    // T7e — F1. Ctrl+S is the one gesture the modal deliberately does not
    // swallow, and the Escape arithmetic did not keep up with it.
    //
    // `markSaved()` sets `_savedDepth` to an ABSOLUTE index, so popping this
    // session's ops below it makes `dirtyDepth` NEGATIVE — which still reads as
    // dirty, so nothing looks wrong — and the next ordinary commit walks it back
    // up through exactly zero. MEASURED before this fix, on this very sequence:
    // documentIsDirty() answered false, the title dropped its ●, and the real
    // conflict banner's real Reload raised no dialog at all and destroyed the
    // typed edit while the disk still held the waveform the user had Escaped
    // away. One gesture is enough; the row drives the minimal form.
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      const saved = await saveAndRead(ctx);
      assert.ok(saved.indexOf("wave: 'p.1p.'") !== -1,
        'T7e 前提失敗：這一發 Ctrl+S 必須真的把波形寫進磁碟。Got:\n' + saved);
      const afterSave = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(afterSave.dirty, false,
        'T7e 前提失敗：存完檔之後文件應該是乾淨的');

      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 600));
      const afterEsc = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title }));
      assert.strictEqual(afterEsc.s.open, false, 'T7e 前提失敗：Escape 要關掉編輯器');
      assert.strictEqual(afterEsc.s.dirty, true,
        'T7e 前提失敗：Escape 把記憶體裡的波形丟掉了，磁碟上還留著 —— 兩邊不一樣，' +
        '這時候文件本來就是髒的');

      // 一筆普通的編輯。舊版就是在這一步把髒度走回 0 的。
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' IMPORTANT');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const afterEdit = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title,
        onScreen: (document.querySelector('.content').textContent || '')
          .indexOf('IMPORTANT') !== -1,
      }));
      assert.strictEqual(afterEdit.onScreen, true,
        'T7e 前提失敗：那一筆編輯要真的在畫面上');
      assert.strictEqual(afterEdit.s.dirty, true,
        'T7e: 一筆普通的編輯不得把文件變回「乾淨」—— 螢幕上有 IMPORTANT，磁碟上沒有');
      assert.strictEqual(afterEdit.title.indexOf('●'), 0,
        'T7e: ● 也不得熄掉，got ' + JSON.stringify(afterEdit.title));
      assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8').indexOf('IMPORTANT'), -1,
        'T7e 前提失敗：那一筆編輯還沒有落到磁碟');

      // …所以真正的 Reload 必須被攔下來。
      await raiseConflict(ctx);
      let blocked = false;
      ctx.page.once('dialog', async (d) => { blocked = true; await d.dismiss(); });
      await pressReload(ctx);
      assert.strictEqual(blocked, true,
        'T7e: 存檔發生在 session 中間，之後的普通編輯一樣不得無聲地被 Reload 丟掉');
      const survived = await ctx.page.evaluate(() =>
        (document.querySelector('.content').textContent || '').indexOf('IMPORTANT') !== -1);
      assert.strictEqual(survived, true, 'T7e: 取消離站之後那筆編輯要還在');
      assert.strictEqual(ctx.errs.length, 0, 'T7e: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7e a save taken inside a wave session cannot make a later edit read clean — OK');
    }

    // T7f — F2. 關閉時那一次 render 失敗，文件不得因此變成一份 block map 指不到
    // 的東西。
    //
    // 保住使用者畫的東西（不 rollback）是對的判斷，但 `blocks` 原本只有在
    // render【成功】時才會被結算。MEASURED：+1 行的 session 配上一次失敗的
    // render，下一筆普通段落編輯就提交到收尾圍欄後面那一行空白上，分隔行被吃掉、
    // 段落被複製，完全沒有警告。這一列用 +2 行，因為那時候陳舊的 block map 指到
    // 的是【收尾圍欄本身】。
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await pressClick(ctx.page, '[data-focus-key="lane-add-0"]');
      await new Promise((r) => setTimeout(r, 400));
      await pressClick(ctx.page, '[data-focus-key="lane-add-6"]');
      await new Promise((r) => setTimeout(r, 400));
      const two = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(two.seam === null ? null : two.seam.ops, 2,
        'T7f 前提失敗：兩次插入都要寫得回去（各加一行）。Got ' + JSON.stringify(two.seam));

      // 讓【下一次】 /api/render 失敗，其餘照常。
      await ctx.page.evaluate(() => {
        const orig = window.fetch;
        window.__failNextRender = true;
        window.fetch = function (input, init) {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          if (window.__failNextRender && /\/api\/render\b/.test(url)) {
            window.__failNextRender = false;
            return Promise.reject(new TypeError('probe: render aborted'));
          }
          return orig.call(this, input, init);
        };
      });
      await pressClick(ctx.page, '.ed-wave-close');
      await ctx.page.waitForFunction(
        () => document.querySelector('.ed-wave-overlay') === null, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 900));

      const failed = await ctx.page.evaluate(() => ({
        banner: (document.querySelector('.ed-conflict') || {}).textContent || null,
        code: window.__edTestBlockSpan(1),
        para: window.__edTestBlockSpan(2),
        stillFailing: window.__failNextRender,
      }));
      assert.strictEqual(failed.stillFailing, false,
        'T7f 前提失敗：那一次 render 真的要被擋掉（否則這一列什麼都沒測到）');
      assert.ok(failed.banner !== null && failed.banner.indexOf('畫面沒有重畫成功') !== -1,
        'T7f 前提失敗：失敗的 render 要升起「東西還在文件裡」那條 banner。Got ' +
        JSON.stringify(failed.banner));
      // 直接斷言那條不變式：每個 block 還是指得到自己的文字。
      assert.strictEqual(failed.para.text, 'Tail para two.',
        'T7f: render 失敗之後，block map 仍然必須指得到那個段落自己 —— 舊版指到的' +
        '是收尾圍欄。Got ' + JSON.stringify(failed.para));
      assert.deepStrictEqual(
        { s: failed.code.startLine, e: failed.code.endLine }, { s: 3, e: 16 },
        'T7f: 被編輯的那個區塊保留 startLine、由 endLine 吸收行數變化。Got ' +
        JSON.stringify(failed.code));

      // …而「下一筆普通編輯不得落在錯的地方」是這一切真正的判準。
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' ZZZ');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const md = await saveAndRead(ctx);
      const dupes = md.split('Tail para two.').length - 1;
      assert.strictEqual(dupes, 1,
        'T7f: 那個段落只能出現一次 —— 出現兩次就是提交落在分隔行上、把段落複製了。' +
        'Got:\n' + md);
      assert.ok(md.indexOf('```\n\nTail para two. ZZZ') !== -1,
        'T7f: 收尾圍欄後面那一行空白也必須還在。Got:\n' + md);
      assert.ok(md.indexOf(' ZZZ') !== -1, 'T7f 前提失敗：那一筆編輯要真的存進去');
      assert.strictEqual(ctx.errs.length, 0, 'T7f: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7f a failed close render keeps the drawing and still leaves a block map the next edit can trust — OK');
    }

    // T7f2 — F2 的第二個症狀：失敗的 render 之後再打開編輯器，拿到的必須是完整
    // 的 block body。MEASURED（舊版）：seam 回報 4..14，真正的 body 是 4..16，
    // store 被餵了一份被截斷的來源，`.ed-wave-canvas` 根本沒有建出來。
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await pressClick(ctx.page, '[data-focus-key="lane-add-0"]');
      await new Promise((r) => setTimeout(r, 400));
      await pressClick(ctx.page, '[data-focus-key="lane-add-6"]');
      await new Promise((r) => setTimeout(r, 400));
      await ctx.page.evaluate(() => {
        const orig = window.fetch;
        window.__failNextRender = true;
        window.fetch = function (input, init) {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          if (window.__failNextRender && /\/api\/render\b/.test(url)) {
            window.__failNextRender = false;
            return Promise.reject(new TypeError('probe: render aborted'));
          }
          return orig.call(this, input, init);
        };
      });
      await pressClick(ctx.page, '.ed-wave-close');
      await ctx.page.waitForFunction(
        () => document.querySelector('.ed-wave-overlay') === null, { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 900));

      // `.content` 還停在 session 之前那一次 render，所以那張圖還畫得出 hover，
      // 開啟手勢跟平常一樣。
      await openWave(ctx.page);
      const reopened = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(),
        canvas: document.querySelector('.ed-wave-canvas') !== null,
        lanes: document.querySelector('.ed-wave-overlay')
          ? document.querySelector('.ed-wave-overlay').getAttribute('data-wave-lanes') : null,
      }));
      assert.strictEqual(reopened.canvas, true,
        'T7f2: 重新打開必須拿到完整的 body，畫布要建得出來。Got ' +
        JSON.stringify(reopened));
      assert.deepStrictEqual(
        { s: reopened.s.seam.startLine, e: reopened.s.seam.endLine }, { s: 4, e: 15 },
        'T7f2: seam 要涵蓋真正的 body（原本 10 行 + 2 條新 lane）。Got ' +
        JSON.stringify(reopened.s.seam));
      assert.strictEqual(reopened.lanes, '8',
        'T7f2: 六條原本的 lane 加兩條新的都要在。Got ' + JSON.stringify(reopened.lanes));
      assert.strictEqual(ctx.errs.length, 0, 'T7f2: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7f2 re-opening after a failed close render reads the whole block body — OK');
    }

    // T7g — F3. 一個被丟掉的 wave session 不得吃掉使用者原本就有的 redo。
    //
    // `push()` 會清掉 `_undone`，而 `discardTop()` 沒辦法把它放回去。MEASURED
    // （舊版，含控制組）：打字、提交、Ctrl+Z，然後開 wave 畫一筆再 Escape ——
    // Ctrl+Y 什麼都回不來；沒有中間那段 wave session 的話它會回來。文件在
    // session 前後是逐位元組相同的，使用者沒有理由預期 redo 被吃掉。
    {
      const ctx = await newPage(WAVE_MD);
      await ctx.page.click('.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' EDITED');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 1200));
      const undone = await ctx.page.evaluate(() =>
        (document.querySelector('.content').textContent || '').indexOf('EDITED') !== -1);
      assert.strictEqual(undone, false, 'T7g 前提失敗：Ctrl+Z 要先真的退掉那筆編輯');

      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 600));
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyY');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 1200));
      const md = await saveAndRead(ctx);
      assert.ok(md.indexOf('EDITED') !== -1,
        'T7g: 被丟掉的 wave session 不得連使用者原本的 redo 一起吃掉。Got:\n' + md);
      assert.ok(md.indexOf("wave: 'p....'") !== -1,
        'T7g: 而被 Escape 掉的波形不得跟著回來。Got:\n' + md);
      assert.strictEqual(ctx.errs.length, 0, 'T7g: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7g a discarded wave session hands back the redo branch it cleared — OK');
    }

    // T7h — F5. 在編輯器裡把自己畫的東西撤銷回原樣，● 要熄掉。
    //
    // MEASURED（舊版）：塗一格再按編輯器自己的「復原」，文件的位元組回到原狀，
    // 但 `ops` 從 1 變 2、`dirty` 一直是 true、● 在這個 session 剩下的時間裡再也
    // 沒有熄過。偏安全的方向，但那是在告訴使用者有一筆他沒有的未存檔改動。
    {
      const ctx = await newPage(WAVE_MD);
      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      const painted = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title }));
      assert.strictEqual(painted.s.dirty, true, 'T7h 前提失敗：畫完要是髒的');
      assert.strictEqual(painted.title.indexOf('●'), 0, 'T7h 前提失敗：● 要亮著');

      await pressClick(ctx.page, '.ed-wave-undo');
      await new Promise((r) => setTimeout(r, 500));
      const undone = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title,
        wave0: document.querySelector('.ed-wave-canvas').getAttribute('data-wave-0'),
      }));
      assert.strictEqual(undone.wave0, 'p....',
        'T7h 前提失敗：編輯器自己的復原要真的退回原樣。Got ' + JSON.stringify(undone.wave0));
      assert.strictEqual(undone.s.seam.ops, 0,
        'T7h: 回到原樣的 session 要把自己的 op 從 undo stack 上收回去。Got ' +
        JSON.stringify(undone.s.seam));
      assert.strictEqual(undone.s.dirty, false,
        'T7h: 位元組跟原檔一樣的時候文件不得還說自己是髒的');
      assert.strictEqual(undone.title.indexOf('●'), -1,
        'T7h: ● 要熄掉，got ' + JSON.stringify(undone.title));

      // 而且收回去之後還能繼續畫 —— 收的是 op，不是 session。
      await paintCell(ctx.page, 0, 3, '1');
      const again = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(again.seam.ops, 1,
        'T7h: 收回去之後再畫一筆仍然是一次 commit。Got ' + JSON.stringify(again.seam));
      assert.strictEqual(again.dirty, true, 'T7h: 而且又髒起來了');
      assert.strictEqual(ctx.errs.length, 0, 'T7h: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7h a session that comes back to the bytes it started from stops claiming to be dirty — OK');
    }

    // ── fix round 2 ────────────────────────────────────────────────────────

    // T7i — MUST-FIX 1. The same hole as T7e, reached from a NEGATIVE baseline.
    //
    // Fix round 1 decided "did a save land inside this session?" by arithmetic:
    // `dirtyDepth === baseDirtyDepth + ops`. That implication only runs the way
    // it was used when the baseline is non-negative, and a user reaches a
    // negative one by pressing Ctrl+Z once after a save. MEASURED against the
    // real stack: the predicate read `1 === -1 + 2`, answered「沒有存檔」, popped
    // blind, and reproduced F1's original outcome straight through the fixed
    // code. The predicate is now two POSITION comparisons against the session's
    // own baseline, which have no sign to get wrong.
    {
      const ctx = await newPage(WAVE_MD);
      const tail = '.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed';
      await ctx.page.click(tail);
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' ONE');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const disk1 = await saveAndRead(ctx);
      assert.ok(disk1.indexOf('ONE') !== -1, 'T7i 前提失敗：第一筆要真的存進磁碟');

      // 一發普通的 Ctrl+Z，退到存檔點【之前】—— 這就是負的基準點。
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 1200));
      const rewound = await ctx.page.evaluate(() => ({
        dirty: window.__edTestWaveState().dirty,
        text: document.querySelector('.content').textContent || '',
      }));
      assert.strictEqual(rewound.text.indexOf('ONE'), -1,
        'T7i 前提失敗：Ctrl+Z 要真的退掉那一筆');
      assert.strictEqual(rewound.dirty, true,
        'T7i 前提失敗：退到存檔點之前，記憶體跟磁碟不一樣');

      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      const midSession = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(midSession.dirty, true,
        'T7i: 編輯器開著、剛畫了一筆，文件不得回報成乾淨的（負基準點上，' +
        '舊的深度算術在這一步就已經讀成 0 了）');

      await saveAndRead(ctx);                 // 存檔【發生在 session 中間】
      await paintCell(ctx.page, 0, 3, '1');
      const before = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(before.seam.ops, 2, 'T7i 前提失敗：兩筆都要寫得回去');

      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 700));
      const afterEsc = await ctx.page.evaluate(() => window.__edTestWaveState());
      assert.strictEqual(afterEsc.open, false, 'T7i 前提失敗：Escape 要關掉編輯器');
      assert.strictEqual(afterEsc.dirty, true,
        'T7i 前提失敗：Escape 把畫的東西丟掉了，磁碟上還留著，所以是髒的');

      // 一筆普通的編輯 —— 舊的算術就是在這裡把髒度走回 0 的。
      await ctx.page.click(tail);
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' TWO');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      const after = await ctx.page.evaluate(() => ({
        s: window.__edTestWaveState(), title: document.title,
        text: document.querySelector('.content').textContent || '',
      }));
      assert.ok(after.text.indexOf('TWO') !== -1, 'T7i 前提失敗：第二筆要在畫面上');
      assert.strictEqual(fs.readFileSync(ctx.mdPath, 'utf8').indexOf('TWO'), -1,
        'T7i 前提失敗：第二筆還沒落磁碟');
      assert.strictEqual(after.s.dirty, true,
        'T7i: 從負的基準點開始的 session 一樣不得讓後面的編輯讀成乾淨的');
      assert.strictEqual(after.title.indexOf('●'), 0,
        'T7i: ● 也不得熄掉，got ' + JSON.stringify(after.title));

      await raiseConflict(ctx);
      let blocked = false;
      ctx.page.once('dialog', async (d) => { blocked = true; await d.dismiss(); });
      await pressReload(ctx);
      assert.strictEqual(blocked, true,
        'T7i: 所以 Reload 必須被攔 —— 這一列跟 T7e 的差別只有一發 Ctrl+Z');
      assert.strictEqual(ctx.errs.length, 0, 'T7i: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7i a session opened from a negative baseline still cannot make a later edit read clean — OK');
    }

    // T7j — R1. Escape 的【另一條】分支也要把 redo 還回去。
    //
    // T7g 走的是「可以直接把 op 收掉」那條；session 中間存過檔就會走 revert
    // commit 那條，而它原本什麼都沒還。兩條結束時 `lines` 都跟 `seam.baseLines`
    // 逐位元組相同，所以使用者在這裡的處境跟 F3 一模一樣：一份沒有變的文件，
    // 加上一個被默默吃掉的 redo。差別只在中間那一發 Ctrl+S。
    {
      const ctx = await newPage(WAVE_MD);
      const tail = '.ed-block[data-block-type="paragraph"]:last-child .ed-wys-armed';
      await ctx.page.click(tail);
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.type(' EDITED');
      await new Promise((r) => setTimeout(r, 200));
      await ctx.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyZ');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 1200));
      assert.strictEqual(await ctx.page.evaluate(() =>
        (document.querySelector('.content').textContent || '').indexOf('EDITED') !== -1),
        false, 'T7j 前提失敗：Ctrl+Z 要先真的退掉那筆編輯');

      await openWave(ctx.page);
      await paintCell(ctx.page, 0, 2, '1');
      await saveAndRead(ctx);                 // 這一發就是讓 Escape 走另一條分支的東西
      await paintCell(ctx.page, 0, 3, '1');
      await ctx.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 700));

      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('KeyY');
      await ctx.page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 1200));
      const md = await saveAndRead(ctx);
      assert.ok(md.indexOf('EDITED') !== -1,
        'T7j: session 中間存過檔的 Escape 一樣不得吃掉使用者原本的 redo。Got:\n' + md);
      assert.ok(md.indexOf("wave: 'p....'") !== -1,
        'T7j: 而被 Escape 掉的波形不得跟著回來。Got:\n' + md);
      assert.strictEqual(ctx.errs.length, 0, 'T7j: 不得有 pageerror: ' + ctx.errs.join(' | '));
      await ctx.page.close(); ctx.srv.close();
      console.log('journey: wave/T7j the revert-commit Escape hands back the redo branch too — OK');
    }
  }

  await browser.close();
}

main().then(() => console.log('editor-journey.test.js OK'))
  .catch((e) => { console.error(e); process.exit(1); });
