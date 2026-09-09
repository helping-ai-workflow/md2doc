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

async function boot(mdText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-journey-'));
  const mdPath = path.join(dir, 'doc.md');
  fs.writeFileSync(mdPath, mdText, 'utf8');
  // createEditorServer() takes a single options object ({ files, clientJs,
  // idleTimeoutMs, listenPort }), not the (paths, opts) shape the original
  // sketch assumed — see lib/editor/server.js. It returns
  // { server, port, urlFor(absPath), close() }, no bare `.url`/`.port`
  // shortcut on the caller's side; the URL for a given file comes from
  // urlFor(), which maps the resolved path back to its /edit/:id index.
  const srv = await createEditorServer({ files: [mdPath], clientJs: CLIENT_SRC });
  const url = srv.urlFor(mdPath);
  return { srv, url, mdPath };
}

async function newPage(mdText) {
  const b = await boot(mdText);
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

async function saveAndRead(ctx) {
  await ctx.page.keyboard.down('Control');
  await ctx.page.keyboard.press('KeyS');
  await ctx.page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 400));
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
// `target.closest('.ed-block[data-block-type="table"]')` is null for any
// mousemove whose target is the bubble ITSELF, and that call hides it.
// MEASURED on this repo's puppeteer, hovering the row boundary to raise the
// bubble and then pressing it:
//
//   with pressClick's own mouse.move()   bubble.hidden = true,  events []
//   pressing without moving              bubble.hidden = false, events
//                                        ["mousedown","click"], row inserted
//
// So the ONLY way to press this button with a real mouse is to arrive at it
// with the move that raises it and then not move again. The bubble's
// hide-on-hover is Task 14 / F7, already diagnosed with the same mechanism;
// this helper only has to be able to express the gesture that works.
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
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
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
      enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
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
  // 真實點擊 22 顆工具列按鈕與 ⠿ 選單的 15 個葉節點，對每一項斷言「使用者
  // 按完之後還有著力點」。
  //
  // 每一列的「必需答案」是量測出來的，不是猜的（量測腳本見 task-11 報告）：
  //
  //   caret     按完之後游標落在一個【真的編輯面】上 —— 不只是「不是 BODY」，
  //             而是 activeElement 的 class 必須含 ed-wys-armed（段落／標題／
  //             清單項）、ed-wys-cell（表格儲存格）或 ed-raw（MD 原始碼
  //             textarea）三者之一；而且工具列沒有塌回「沒有瞄準任何 block」
  //             的 4 顆。
  //   bar-only  目標型別【依設計】沒有可聚焦的編輯面 —— client.js 的
  //             convertBlockViaMenu() 自己就寫著「降級目標（quote / code）
  //             沒有可聚焦編輯面，focusBlockAtLine 會安靜 no-op；把
  //             toolbarBlockEl 指回轉換後的 block，工具列才不會塌成 4 顆」。
  //             所以 BODY 是合法答案，但工具列必須還瞄著那個 block —— 這裡
  //             不只數按鈕數，還真的再按一次「在下方插入區塊」並確認游標落
  //             在新段落上，證明那個「還瞄著」是真的能用而不只是計數好看。
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
    enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
    mode: document.body.getAttribute('data-ed-mode'),
  }));

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
    assert.strictEqual(ids.length, 22, '工具列應為 22 顆，got ' + ids.length);

    const TB_ROWS = [
      { id: 'undo',         state: 'sel',  answer: 'caret' },
      { id: 'redo',         state: 'sel',  answer: 'caret' },
      { id: 'headings',     state: 'sel',  answer: 'caret' },   // 只開 H▾ 選單，不轉換
      { id: 'quote',        state: 'sel',  answer: 'bar-only' },
      { id: 'code',         state: 'sel',  answer: 'bar-only' },
      { id: 'list',         state: 'sel',  answer: 'caret' },
      { id: 'ordered-list', state: 'sel',  answer: 'caret' },
      { id: 'check',        state: 'sel',  answer: 'caret' },
      { id: 'bold',         state: 'sel',  answer: 'caret' },
      { id: 'italic',       state: 'sel',  answer: 'caret' },
      { id: 'strike',       state: 'sel',  answer: 'caret' },
      { id: 'inline-code',  state: 'sel',  answer: 'caret' },
      // v3.2.1 Task 11b：BROKEN → caret。成因量測（見報告的時間軸）是
      // window.prompt() 關閉【之後】瀏覽器補的那一發 focusout —— 焦點其實立刻
      // 回到那個面（t=31ms 的 focusin），真正拆掉著力點的是文件層 delegator
      // 把那一發讀成「使用者離開了」而跑掉的 commit → rerenderAll()（實測走
      // applyFullRender，整個 .content 被換掉）。applyLinkToggle() 現在是一層
      // async thin wrapper，等那次 render 落地之後才把游標放回【同一個 block】
      // （連結是 block 內的 inline 編輯，block 本身活著）。實測：連結照樣寫進
      // 磁碟（[Alpha](https://example.com/)），activeElement 回到
      // P.ed-wys-armed、工具列 15 顆。
      { id: 'link',         state: 'sel',  answer: 'caret' },
      { id: 'outdent',      state: 'nest', answer: 'caret' },
      { id: 'indent',       state: 'nest', answer: 'caret' },
      { id: 'table',        state: 'sel',  answer: 'caret' },
      { id: 'insert-before', state: 'sel', answer: 'caret' },
      { id: 'insert-after', state: 'sel',  answer: 'caret' },
      { id: 'line',         state: 'sel',  answer: 'bar-only' },
      { id: 'image',        state: 'sel',  answer: 'caret' },
      { id: 'outline',      state: 'sel',  answer: 'caret' },
      { id: 'preview',      state: 'sel',  answer: 'source' },
    ];
    assert.deepStrictEqual(TB_ROWS.map((r) => r.id).slice().sort(), ids.slice().sort(),
      'V2 表必須恰好覆蓋工具列上的每一顆按鈕 —— 新增按鈕時必須同時決定它的必需答案');

    const bad = [];
    for (const row of TB_ROWS) {
      const ctx = await v2Boot(row.state);
      const dis = await ctx.page.evaluate((i) =>
        document.querySelector('[data-ed-tb="' + i + '"]').disabled, row.id);
      if (dis) {
        bad.push(row.id + ' → 在 ' + row.state + ' 狀態下是 disabled，這一列什麼都沒點到（空跑的綠燈）');
        await ctx.page.close(); ctx.srv.close();
        continue;
      }
      await pressClick(ctx.page, '[data-ed-tb="' + row.id + '"]', 80);
      await new Promise((r) => setTimeout(r, 450));
      const fail = await checkLeverage(ctx, row.id, row.answer);
      if (fail) bad.push(fail);
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
      { label: '程式碼',       answer: 'bar-only', convert: true },
      { label: '引用',        answer: 'bar-only', convert: true },
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
        enabled: Array.from(document.querySelectorAll('.ed-toolbar-btn')).filter((x) => !x.disabled).length,
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

  // ══ V3: 十四個 position:fixed 浮層，捲動後的必需答案 ══════════════════
  // lib/md2doc.js 有十四個 `position: fixed` 宣告（另有 9 處是註解裡的散文
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

  // ── live × 2：.sidebar-scrim / .reader-sidebar（抽屜打開時）──────────
  // 實測：抽屜打開時 body 仍然可以捲（overflow 是 `clip visible`，scrollY
  // 真的從 0 走到 1938），而兩者被捲動會動到的那個軸都定死在視窗上，所以
  // 捲動之後位置一格都沒動：
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

  // ── gone × 3：.ed-te-grip / .ed-te-menu / .ed-tb-insert ─────────────
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
    assertRaised(gripBefore, '.ed-te-grip');
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
    assert.ok(isGone(gripAfter), '.ed-te-grip 捲動後必須消失，got ' + JSON.stringify(gripAfter));
    assert.ok(isGone(menuAfter),
      '.ed-te-menu 捲動後必須消失（它是唯一會真的刪掉整欄整列的浮層），got ' + JSON.stringify(menuAfter));
    await ctx.page.close(); ctx.srv.close();
    console.log('journey: V3 .ed-te-grip / .ed-te-menu vanish on scroll — OK');
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
  // 量測表與裁定理由寫在 .superpowers/sdd/2026-09-07-md2doc-v3.3.0/
  // task-1-report.md。這一條把裁定釘在磁碟位元組上，理由是「丟棄」在 HEAD
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
  // 缺陷形狀（量測，見 task-3-report.md）：`noteTyping()` 沒有 timer，一段
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
    const bp = await ctx.page.evaluate((t) => {
      const tb = document.querySelector(t + ' table');
      const tr = tb.getBoundingClientRect();
      const rr = tb.tBodies[0].rows[0].getBoundingClientRect();
      return { x: tr.left, y: rr.bottom };
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
    // 這一發【不能】讓 pressClick 自己 move —— 見 pressClick() 的 opts 註解：
    // 游標一移到泡泡上，泡泡就自己隱藏，按壓會落到表格上。指標已經在
    // (bp.x, bp.y)（就是上面那一發把泡泡升起來的移動），pressClick 會斷言
    // 那個點確實落在泡泡的可見矩形內，然後原地按下去。
    await pressClick(ctx.page, '.ed-tb-insert-row', 80, { pressAtPointer: bp });
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
  // burst 把使用者打的字留在 DOM 裡直到它自己收掉，而 `stack.dirtyDepth`
  // 是 `_done.length - _savedDepth`（lineops.js），要等 undo stack 被推入／
  // 彈出一個 op、或存檔重訂基準，它才會動 —— 打字當下這些都還沒發生，所以
  // 「打了字、還沒離開這個 block」在它眼中是乾淨的。
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
    assert.strictEqual(shape.count, 22,
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
      : { max: 555, at: [{ attr: 'right', left: false, right: true },
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
    for (let i = 0; i < 3; i++) {
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
      'Alt+F10 之後三下 ArrowRight 必須停在 ❝ 上、那顆必須真的看得到、而且插入點' +
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

  // ── F4: 轉換子選單的項目在矮視窗下都必須可達 ────────────────────────
  // 量測基礎：開 ⠿ + 轉換成整段手勢從未讀過 window.innerHeight/innerWidth
  // （對照組 .ed-seltb 的路徑會讀），即 clamp 從未寫過，不是寫壞。見 task-9-brief.md。
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

  await browser.close();
}

main().then(() => console.log('editor-journey.test.js OK'))
  .catch((e) => { console.error(e); process.exit(1); });
