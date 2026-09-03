# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v3.1.0 — 2026-09-03

編輯器一直缺一個工具列——那是使用者回報最多的一件事。這一版把它補上，順帶把
「從別處貼進來」「把圖片拖進來」「我就是要直接改原始碼」這三條路一起接通。

### Added

- **工具列。** 22 顆按鈕，分成六組（history／block／inline／indent／insert／view），
  固定在畫面頂端。它掛在 `document.body` 而不是 `.content` 裡：每次提交都會把
  `.content` 的內容整個換掉，掛在裡面的工具列會在第一次提交時消失且沒有東西會把它
  帶回來。每次重繪之後工具列追蹤的區塊會歸零，回到「沒有選定區塊」的狀態——
  undo／redo／大綱／預覽仍可按，其餘按鈕變灰。
- **貼上會把 HTML 轉成 markdown。** 剪貼簿帶 `text/html` 時，那才是真正的內容來源：
  先轉成 markdown（turndown，另補上 GFM 的刪除線與表格兩條規則），再依內容決定落點。
  單行、不含任何 markdown 語法的貼上仍舊原地插入游標處（從瀏覽器複製一個詞貼進句子中間
  必須維持原本的行為）；其餘一律當成結構，以**原始碼**的形式落在游標所在區塊的下方，
  走的是既有的 `commitBlockInsertion()`／`replaceLines()` 管線，因此經過序列化器原本的
  每一道閘門，而不是把一堆外來節點塞進 WYSIWYG DOM。表格儲存格內的貼上刻意維持純文字
  ——一個儲存格裝不下一個區塊。`Ctrl+Shift+V` 強制純文字貼上。
- **把圖片拖進來。** 新的 `POST /api/asset` 端點把圖片寫進文件旁邊的 `assets/`
  目錄，並在游標所在區塊下方落一行 `![](assets/…)`。檔名經過 sanitize 與去重
  （同名的第二張圖變成 `-2`），路徑不得逸出 `assets/`（字串與 `realpath` 兩道檢查，
  後者擋的是預先放好的 symlink），寫入用 `wx` 旗標。接受的格式是 PNG／JPEG／GIF／WebP；
  **SVG 刻意不收**——SVG 可以夾帶 `<script>`，而這份白名單是「攻擊者可控的 MIME 字串」
  與「寫進磁碟的檔案」之間唯一的閘門。工具列的 🖼 按鈕走同一條路。
- **整份文件的原始碼模式。** 工具列最右邊的 👁 在「編輯 → 原始碼 → 預覽」三個狀態之間
  循環。原始碼模式把整份文件放進一個 textarea；離開時的全量置換走的是每一次編輯都走的
  同一條 `replaceLines()` 管線，所以它是**一個** undo 步驟，而且沒有第二個寫 `lines`
  的人。離開時若渲染失敗，textarea 會原地留著、內容不動——一次失敗的往返不該是那個
  把整份文件的編輯丟掉的東西。

### Fixed

- **清單項的 ⠿ 選單重新提供「MD 原始碼」。** 先前的 RULING F-O 永久隱藏了清單項的這個
  逃生口，理由是 `openRawEditor()` 會把區塊的 innerHTML 換成 textarea，還原時得靠一個
  捕捉下來的字串手工重建 marker／checkbox／文字那一整套 chrome。這一版是把那個前提拿掉，
  不是繞過它：清單項改成 raw-edit 一段**明確的行範圍**、經 `commitRangeEdit()` 提交、
  以**重新渲染**還原，於是序列化器從頭到尾沒有碰過 textarea，也沒有任何 chrome 是手工
  重建的。RULING F-O 在另外兩種情況仍然成立，兩者都各自保有原本的拒絕行為與覆蓋：
  沒有對應原始行的清單項，以及序列化器無法原樣往返的內容。

### Known issues

- **編輯器仍然慢，這一版沒有改。** 每一次提交都會重新渲染**整份文件**（一次
  `POST /api/render`，然後 `.content` 的內容整個換掉），所以文件愈長，每個字、每次
  Enter 的延遲就愈明顯。這是已知且刻意留著的：增量渲染是另一個版本的題目，不是這一版
  的範圍。看到這裡的人請不要把它當成漏掉的東西。
- **工具列右側沒有存檔狀態指示。** 那個位置是**刻意**留空的，等後續版本填。目前唯一的
  未存檔提示仍是分頁標題前面那顆 `●`。同樣不是漏掉的東西。
- **`export` 按鈕從工具列拿掉了。** 規格原本列了它，但瀏覽器裡沒有任何可達的匯出目標可
  接（PDF／HTML 匯出是 CLI 那一側的事），所以與其放一顆按下去沒有作用的按鈕，不如不放。
  工具列因此是 22 顆而不是 23 顆。

## v3.0.2 — 2026-09-03

v3.0.1 兩輪 review 的遺留項。

### Fixed

- **刪掉一欄或改掉一個表頭名稱，會清掉整張表的欄寬記憶。** 表頭配對原本是逐格對照，
  一旦對不上就停在原地，於是「原始表格有一欄沒被配到」這個條件同時涵蓋了刪欄、改名
  與換欄序三種操作，全部被當成換欄序處理、整張表退回 minimal form。改成往前掃描的
  子序列比對之後，刪欄與改名只影響該欄自己，其餘欄位保留作者手工對齊的寬度；換欄序
  仍然整張退化。表頭配對仍然是靠文字比對，撞名時寬度還是可能落在錯誤的欄位上——見
  下方 Known issues。
- **清單縮排夾取拿到過期的區塊集合時會給出確信的錯誤答案。** `computeIndentClamp()`
  現在會先確認交給它的集合仍然就是它衍生自的那條清單 run（同元素、同順序）；不是
  就拒絕作答，而不是拿一份已經不存在的版面去算 §3.4 rule 2 的作用範圍。五個呼叫點
  今天都通過這道檢查；批次刪除、轉換與 ⠿ 拖曳三站各有情境需要真的位移後方手足，
  分別有行為式測試釘住這道檢查不會誤拒。Tab／Shift+Tab（批次與游標各一個呼叫點）
  目前沒有需要位移後方手足的情境，這道檢查在那兩站不誤拒是由整份套件的行為覆蓋，
  不是靠針對性案例。
- **表格表頭那一列的 grip 會讓 ⠿ 短暫淡出。** 指標從表格往左移向 ⠿ 時會先穿過 grip
  探出表格邊界的那 10px，`elementFromPoint` 回傳的是 grip 而不是區塊，`:hover` 因此
  中斷。grip 必須是 `document.body` 的子節點才能在表格捲動時保持固定，所以這用一條
  狀態規則解決：指標停留在**表頭列** grip 的作用區內時，該區塊的 gutter 保持點亮。
  資料列的 grip 與欄 grip 都不觸發（它們與 ⠿ 不同高）。

### Known issues

- **表頭配對是靠文字比對，撞名時可能讓寬度落在錯誤的欄位、甚至讓整張表退化。**
  三種已測到的情形：①表頭本來就有重複名稱時，刪欄後存活欄可能繼承到同名另一欄的
  寬度；②改名產生的新名稱若跟另一欄撞名（`X, Y` → `X, X`），整張表退化成 minimal
  form；③拖曳列升格表頭時，若該列某格文字跟原表頭某欄同名，那一欄會誤繼承舊欄的
  寬度、其餘欄退化。GFM 未定義重複表頭的語意，這條限制目前沒有解法。
- 上述狀態規則點亮的是 ⠿ 與 ＋，救不回 `:hover` 本身，所以 `.ed-block:hover` 的虛線
  外框在那段走廊仍會閃一下。

## v3.0.1 — 2026-09-02

A bugfix release for `md2doc --edit`, aimed squarely at the thing that makes this
editor worth using: editing one block must not rewrite any other bytes.

### Fixed

- **清單 Tab 在 Shift+Tab 之後失效。** `indentListItem()` 拒絕所有 list-start 區塊的 Tab，
  所以一個縮排在編號項底下的項目符號，Shift+Tab 之後落到 indent 0 就成為新清單的第一項，
  再也無法縮排回去。拒絕規則收窄成「前一個區塊不是清單項，或兩張清單之間隔著空行」——
  後者才是原規則真正要防的情況，而且它讀的是檔案的行號相鄰性，不是 DOM。多選 Tab 走的
  `memberIndentHeadroom()` 是同一條規則的另一條軸，一併收窄。
- **「轉換成」子選單沒有圖示，兩層選單的文字不對齊。** 子選單每一列現在都帶一個與
  `CONVERT_TARGETS` id 對應的圖示，圖示靠左，文字距圖示一個空格。同時修掉一個 cascade
  缺陷：`.content svg { margin: 0 auto }` 的優先權壓過裸的 `.ed-menu-icon`，圖示因此被塞了
  置中的 auto margin，偏移量會隨標籤長度在 11–40px 之間晃。
- **表格左側的列 grip 不在表格邊框上。** v2.12.0 為了避開 ⠿ 的命中測試把 grip 整個推進
  表格內，導致它與表格上緣的欄 grip 不對稱。改成把 gutter 的 ＋／⠿ 兩顆鈕往左移
  （`--ed-gutter-shift`），從源頭消除重疊：grip 騎回邊框、⠿ 與它之間保有 4px 間隙、
  第一欄取回預設 padding。順帶修好 `.ed-block::before` 沒有跟著位移造成的一條 10px
  hover 死區——它壓在 ＋ 自己的左半邊，在每個清單列底部與高標題的垂直中段都會出現。

### Changed

- **表格重新序列化時保留作者原本的欄寬。** 先前不論原始表格長什麼樣，一律輸出 minimal form（單空格 padding、
  分隔列不拉長），所以手工對齊過的表格只要改一格，整張表的每一行都是 diff。
  現在序列化器會讀取該表格目前的原始行，並在**每一欄在每一列都是同寬、且該寬度大於 3**
  時，把它當成 padding 下限沿用；空格填充的分隔列（Prettier 與 VS Code 產出的那種，破折號兩側帶空格）在對齊未變且寬度未變時原樣保留，不再被改寫。內容變長的欄位只會變寬，不會被截斷。
- 沒有原始來源、原始來源無法解析、或**欄位順序被調換**時，整張表仍回退成 minimal form。表頭改名與欄位刪除在 v3.0.2 已處理。

### Internal

- `lib/editor/client.js` 中 `tableIdentityOf()` 的兩個分隔符從字面控制位元組改成 `'\x01'`
  / `'\x00'` 轉義。執行期值不變，但 `grep` 不再把這個 9600 行的檔案判定為 binary 並靜默
  截斷輸出。

### Known issues

- 表格**表頭那一列**的 grip 顯示時，它會蓋住 ⠿ 進場走廊的 10px。滑鼠從表格往左移向 ⠿ 時
  會看到 ⠿ 短暫淡出再淡回。⠿ 不會變成點不到，資料列的 grip 也沒有這個問題。grip 必須是
  `document.body` 的子節點才能在表格捲動時保持固定，所以這無法用幾何解決，要靠狀態規則。
  這條限制在 v3.0.2 已處理。

## v3.0.0 — 2026-09-01

3.0.0 is a milestone, not a break. The `md2doc` command takes the same arguments and
writes the same files, and everything a reader or a PDF ever sees is unchanged (two
measured caveats are spelled out at the bottom of this entry). What the number marks is
that the editor's block model is finished: a block can now be created, converted,
duplicated, deleted, selected as part of a set — and, from this release, **moved**.

### Added

- **Drag a block's ⠿ to reorder it.** Press the handle and pull: a blue line follows the
  pointer and marks the seam the block will land in, and letting go drops it there. The
  whole move is a single Ctrl+Z however far it travelled, and the document it produces
  has the same blank lines it had — a move is a re-ordering of the file's own lines, not
  a delete and a re-type. A press that never travels far enough to count as a drag still
  opens the ⠿ menu, so nothing that worked before works differently. Pressing Escape
  mid-drag, releasing outside the window, or switching away from the window all abandon
  the gesture and leave the document exactly as it was. Dropping a block onto one you
  were in the middle of typing in keeps both halves: the edit is saved and the block
  still moves where you aimed it.
- **Dragging one block of a selection moves the whole selection.** With a set standing,
  pressing the ⠿ of any block in it moves every block in the set — together, in their own
  order, in one Ctrl+Z — and the blue wash follows them to their new position, so the
  next keystroke still acts on the same blocks rather than on whatever now sits where
  they used to be. Pressing the ⠿ of a block *outside* the set collapses the selection
  onto that block first and moves it alone, which is what the set already does for every
  other ⠿ operation.
- **List items reorder inside their own list.** Dragging an item past its siblings
  renumbers an ordered list as it goes, keeps a task item's checkbox state, and leaves
  the item's own children where they are instead of dragging a whole subtree nobody
  grabbed. A list held read-only because it contains something the editor cannot rewrite
  refuses a drag exactly as it already refuses a conversion.
- **The pointer shows the drag.** The cursor becomes a grabbing hand for as long as the
  gesture is live, and goes back on every way out of it.
- **Holding Shift, Ctrl or Alt changes nothing about the ⠿.** A modified press drags
  exactly like an unmodified one, which is what a table's row and column grips have
  always done; a modified press that never travels far enough still opens the ⠿ menu.
  Before this release a modified press on the handle did nothing at all until it was
  released, so nothing has been taken away — it is written down here because it had
  never been written down anywhere.
- **A move that cannot be made says so, and says which problem it hit.** Four separate
  messages, because they have four opposite remedies and one sentence would send most
  people to fix the wrong end of the gesture:
  - dropping a block between two items of one list — `無法把區塊放進清單項目之間` (aim
    somewhere else);
  - moving a block out from between two list items, which would silently fuse them into
    one list and freeze the whole thing read-only —
    `移走這個區塊會讓上下兩串清單接在一起，無法搬移` (leave that one where it is);
  - dragging a list item out of the list it belongs to — `清單項目只能在所屬清單內搬移`;
  - dropping a set where the item just below the landing point would be left without its
    parent — `落點的子項目會失去上層項目，無法搬移到這裡`.
- **The refusals a selection already had now cover dragging it too.** A selection that
  mixes list items with other blocks, that skips a block in the middle, that spans two
  separate lists, or that covers a read-only list refuses a drag with exactly the message
  it already refuses the ⠿ menu with, rather than a fifth wording for the same problem.
  Every refusal leaves the file byte-identical, and no drag ends without either moving
  something or putting a message on screen — dropping a block back where it already was
  is the one silent outcome, and it is silent because nothing happened and nothing needed
  to.

### Known limits

- **Moves that cross a list boundary are refused in this release rather than attempted.**
  Dragging a list item out of its list, dropping a paragraph into the middle of one, or
  moving a block whose departure would join two lists together all stop with one of the
  messages above and write nothing at all. Doing them correctly needs a rule for the
  blank line at a list/non-list seam that the design does not yet have, and inventing one
  at the end of the rework is how the two worst defects of this series got in. That rule,
  and the moves that depend on it, are 3.1.0's first job.

### Notes for anyone diffing the output

Both of these were measured, and neither changes what a reader sees.

- **The generated HTML's `<style>` block is not byte-identical to v2.12.0's.** It gains
  the drop indicator's and the grabbing cursor's rules, plus one inert custom property
  (`--ed-te-grip-row-w: 20px`) that one hard-coded `20px` now refers to. Every selector
  involved names a class only edit mode ever puts in a document, and the custom property
  resolves to the number it replaced, so nothing renders differently — but "the CSS is
  unchanged" would be false. Everything outside `<style>` is byte-for-byte what v2.12.0
  produced, on both a list-heavy fixture and this repo's own README.
- **In edit mode a table's first column sits about 10px further right, and clicking its
  left padding now presses the row grip instead of placing a caret.** The row-drag grip
  used to straddle the table's left border, which put its outer half on top of the
  block's own ⠿ — the right 6px of every ⠿ started a table row drag instead of a block
  gesture, which is a defect S4 could not ship around. The grip now sits entirely inside
  the table, and the first column is padded past it so it still never covers cell text.
  Reader and PDF output are untouched: none of this exists outside edit mode.

## v2.12.0 — 2026-08-31

### Added

- **Blocks can be selected as a set, and one gesture then acts on all of them.**
  Press inside a block and drag past its edge, or Shift+Click a second block: every
  block in between takes a semi-transparent blue wash with its text still readable
  underneath. Shift+↑ / ↓ then grows and shrinks the set a block at a time, and Esc
  clears it. With a set standing, the ⠿ menu's `轉換成`, `建立副本` and `刪除` act on
  the whole set, and so do Tab, Shift+Tab, Delete and Backspace. Each of them is a
  single Ctrl+Z, however many blocks it touched — including selecting the whole
  document and pressing Delete, which empties it and takes one Ctrl+Z to bring back.
- **Tab over a selection keeps the blocks' relationship to each other.** The whole
  set moves by one shared step — the largest step every item in the set can take on
  its own — so three selected siblings stay siblings instead of folding into one
  another, and a set holding an item that cannot move does not move at all rather
  than half-moving. Selecting three items that are already as deep as their parent
  allows and pressing Tab is a no-op, even when a shallower item further down the
  selection could have moved on its own; pressing Tab on that item by itself still
  moves it. On headings the same key steps every heading in the set a level down or
  up, stopping at 標題 1 and 標題 6.
- **The selection stays put across the redraw its own operation causes.** After a
  batch convert, duplicate or indent the set lands on the lines the operation
  produced, the keyboard still works without touching the mouse, and the page does
  not jump. An undo or redo clears it, so you are never left with a highlight over
  a document that has changed underneath it.
- **A batch that cannot be done says so instead of doing nothing.** Selections that
  mix list items with other blocks, that skip a block in the middle, that span two
  separate lists, or that cover a list already frozen read-only are refused with a
  message on screen, and not one byte of the file is written. `轉換成` over a
  selection that contains a **table**, a **horizontal rule** or a **raw HTML block**
  is refused the same way, naming which of the three it found: none of those three
  has ever offered `轉換成` on its own ⠿ — no target can carry a table's cells, and
  a rule or an HTML block has no content to move into one — and a set they happen to
  be part of does not change that. Previously such a selection was converted
  silently: a selected rule became the line `- ---`, which is read back as a rule
  again, so the file changed and the block did not. Duplicating, deleting or
  indenting a selection containing any of the three is unaffected.
- **`MD 原始碼` is withheld while several blocks are selected.** It rewrites one
  block's source lines, so over a set it would silently answer for the block the ⠿
  was pressed on and ignore the rest. A set of exactly one block, or a set standing
  elsewhere in the document, still offers it.
- **Every ⠿ menu item now leads with an icon** — a turning arrow for `轉換成 ›`,
  two offset cards for `建立副本`, a bin for `刪除`, angle brackets for `MD 原始碼`.
  They are drawn in the item's own colour, so they follow the menu rather than
  being pinned to one theme.
- **`轉換成 ›` opens its submenu on hover**, without a click. Moving diagonally
  towards a target further down the panel keeps it open the whole way, including
  across the few pixels of gap between the item and the panel; settling on another
  item closes it. A click still toggles it, as before.

### Fixed

- **Esc with the ⠿ menu open threw away what you had just typed.** The menu's own
  Esc handler was unreachable while any edit surface held focus — which is always,
  because the menu deliberately keeps focus where it was — so the key fell through
  to the editor and reverted the block instead, leaving the menu on screen. Esc now
  resolves the thing nearest the front: a table drag, then a menu, then a block
  selection, and only then the block being edited.
- **Ctrl+S followed by Ctrl+Z did nothing.** Saving an untouched block leaves it
  focused with no edit in progress, and in that state the undo key was captured by
  the block and then discarded. Undo and redo now reach the document whenever there
  is no edit in progress to own them.
- **A refusal message no longer outlives the gesture that raised it.** "This
  selection cannot be operated on as a batch" and its siblings are dismiss-only
  notices, so one could still be sitting on screen after a later gesture had
  successfully changed the document — describing a state that no longer existed.
  Any structural edit that succeeds now clears a standing refusal. Conflict,
  render-failure and save-failure banners are untouched: those describe the file or
  the connection, not one gesture, and still wait to be dismissed.

## v2.11.1 — 2026-08-31

### Fixed

- **Tab no longer walks out of the document.** Pressing Tab or Shift+Tab moved the
  browser's own focus ring onto a gutter `＋` or `⠿` button — the caret left the
  block and the next keystroke went nowhere. Two independent causes: a surface that
  is still focused and still armed after Ctrl+S has no open burst, and the key
  handler bailed out of the whole document handler with it; and after a commit,
  an Escape, a Ctrl+Z, or a click on a bullet marker nothing is focused at all, and
  there was no Tab branch for that case anywhere. Tab is now consumed in both
  states, and the two gutter buttons — mouse-only affordances that had become
  sequential focus stops simply by being `<button>`s — are out of the tab order.
  Every Tab that already worked still works: indent, outdent, the clamp's no-ops,
  a run-wide refusal, a hard-wrapped item, and type-then-Tab.
- **The `⠿` sits closer to the block, and the gutter no longer has a dead band.**
  The `＋`/`⠿` pair now occupies the geometry the design spec always specified
  (`[blockLeft−40, blockLeft−4]` instead of `[blockLeft−54, blockLeft−18]`). More
  importantly the gutter is now one continuous hover zone: moving the pointer out
  of the text towards the `⠿` used to cross 18px that belonged to neither the block
  nor a button, so both buttons faded out under the cursor on the way to them
  (measured: opacity 0 for ~270 ms of a real pointer travel). The same fix closes
  two related holes — the bottom ~5px of every list row, and the whole vertical
  middle of a multi-line heading, neither of which could reach a button at all.
- **Enter then Tab on the new empty list item no longer destroys the item above
  it.** An empty item is written as a bare `-`, and directly under its parent's own
  text that line is not a list marker at all: CommonMark reads a line of nothing
  but dashes at an open paragraph's column as a setext heading underline. Pressing
  Enter and then Tab on `- beta` therefore saved `- beta` followed by `  -`, which
  reads back as `<li><h2>beta</h2></li>` — the new item gone and the parent
  re-typed as a heading, from two ordinary keystrokes. Only that one position is affected and
  only that one position changes: an empty item nested as the first child of a
  deeper level now carries a zero-width space, which is content to the parser and
  invisible to the reader, and is removed again on the way back in so it never
  becomes part of what the user types.

### Changed

- The `⠿` menu's duplicate item is now labelled `建立副本` (Notion's own
  Traditional Chinese term), matching `轉換成` and `刪除`.

## v2.11.0 — 2026-08-30

### Added

- **Any block can now be turned into any other block type.** The ⠿ handle opens a
  vertical menu whose `轉換成 ›` submenu carries all twelve types — 文字,
  標題 1 through 標題 6, 項目符號列表, 編號列表, 待辦清單, 程式碼, 引用 — and every
  block type can reach every one of them: a paragraph becomes a heading, a code
  block becomes a bulleted list, a list item becomes a quote, and back again. The
  block's text is moved across verbatim rather than re-generated, so characters
  markdown would otherwise escape (`~5px`, `snake_case`) come through a conversion
  unchanged, and the whole thing is a single Ctrl+Z.
- **`複製` duplicates a block.** For a list item the copy is inserted after the
  item's entire subtree, so the original keeps its children, and the copy carries
  the item's type, indent and checkbox state. Ordered lists renumber themselves
  around it. One undo, like every other gesture.
- **The `＋` button works on list items.** It used to be hidden on them, so a list
  was the one place in the document you could not insert from. A new item inherits
  the anchor's list type and indent and lands after the anchor's whole subtree, so
  inserting under a parent no longer breaks its children off.
- **List items get the same gutter as every other block.** Edit mode now draws each
  item as its own full-width row with the ⠿ and ＋ on one vertical axis at every
  nesting depth, instead of nested list markup in which a deep item had no handle
  at all. A table block is the one block with no `轉換成` — there is no type that
  could carry its cells.
- **Tab and Shift+Tab do the indenting.** Inside a list they indent and outdent the
  item (children stay where they are and become siblings); on a heading they step
  the level down and up. The `−` / `+` buttons the old menu carried for heading
  level are gone, and so is its `✕` — the menu closes on Esc or a click outside.
- **Task lists and ordered lists are independent.** `1. [ ] a` round-trips as an
  ordered task item instead of losing one of the two, and a mixed run
  (`1. plain / 2. [ ] task / 3. plain`) stays a single list with continuous
  numbering.

### Fixed

- **A conversion can no longer freeze a list read-only.** Turning a block into a
  list next to an existing list of the same type left the blank line between them
  standing, and markdown does not read that blank as a separator — it reads it as
  an instruction to make the combined list *loose*. Every item then rendered as a
  paragraph, and from that moment every structural edit anywhere in that list was
  refused, with no message saying why. The separator is now absorbed so the run
  stays tight and editable. The opposite direction is handled with it: converting
  an item out of a list puts blank lines back where they are needed, including at
  the run's outer edges, where the converted text would otherwise be swallowed
  back into the item above it.
- **A menu gesture is no longer dropped when the block has unsaved edits.** Typing
  in a block and then pressing ⠿ or ＋ without clicking away first answered
  「文件已更新，請重試這個操作」 and did nothing — on all four of 轉換成, 複製,
  刪除 and ＋. The editor was committing your typing first and then failing to
  recognise the very block it had just rewritten. The gesture now lands on top of
  your own edit.
- **A conversion refuses out loud instead of guessing.** An indented (unfenced)
  code block, a list item spanning more than one line, and a list that already
  contains something the editor cannot represent each show a banner and change
  nothing, rather than producing a plausible-looking block with content silently
  dropped. Converting to 程式碼 also lengthens the fence when the text itself
  contains one, so a code sample that carries a fence of its own no longer breaks
  out of the block it was just converted into.
- **Deleting a list item deletes the list item.** The ⠿ menu's 刪除 used to splice
  out the block's line range: on a paragraph followed by a three-item numbered
  list it removed the paragraph and all three items; it left a child indented under
  nothing, which markdown then reads as a code block; and it left the surviving
  items carrying their old numbers on disk while the screen showed the new ones.
- **A line you did not touch is never rewritten.** Editing one item of a list used
  to re-generate the whole list, which put backslashes in front of `~` and `_` in
  the items around it. Untouched lines now keep their own bytes, and a hard line
  break (two trailing spaces) survives an edit of its own block.
- **A failed commit no longer rolls back somebody else's edit,** and a block that
  owns no source line of its own refuses to be deleted or raw-edited instead of
  quietly removing a blank line belonging to a different block.
- **A wide ordinal stays in its own column.** `10.` no longer pushes its row's text
  out of alignment with the rest of the list, and a marker that outgrows its column
  overflows into the gutter rather than onto its own text.
- **The table row grip is back on the table's border line, and every row uses the
  same rule.** v2.10.1 moved it fully inside the table's left edge, where a 20px
  grip sat on top of the first cell's 14px padding and bit ~5px into the cell's
  text; the header row additionally carried a downward offset that no other row
  had. Both are gone: every row's grip — header included — is centred on the
  table's left border, exactly mirroring how the column grip is centred on the
  top border. The grip now clears the first cell's text by 4.5px at the default
  layout.
- **The block gutter has its own room instead of borrowing the sidebar's.** In
  edit mode the content column now carries 48px of left padding and the ⠿ / ＋
  buttons live inside it, 8px clear of the row grip. Previously the gutter hung
  outside the content box on top of the sidebar splitter, and the 6px overlap it
  created with the row grip was what motivated v2.10.1's inset in the first
  place — the overlap is now impossible by geometry rather than avoided by a
  special case. Reader and PDF output are unaffected: the padding is emitted only
  for edit-mode renders.

## v2.10.1 — 2026-08-28

### Added

- **The table header row now has a drag grip too.** Every row — header included —
  shows a 6-dot grip at its left edge, and dragging any row to the top makes it
  the header (the old header becomes a data row). It is a **pure move**: the same
  cell nodes are re-laid across `<thead>`/`<tbody>`, so nothing is re-serialized
  and per-column alignment follows its column.
- **Columns can be dragged to reorder.** The column grip now drags as well as
  opening its menu; `<colgroup>` is kept in sync so column widths do not shift
  out from under the move, and alignment travels with the column.

### Fixed

- **Saving no longer rewrites a whole file's line endings.** The file's one EOL is
  now picked by majority vote when the document loads, instead of "any CRLF
  anywhere wins" — a 10,000-line LF file with one stray CRLF line used to get all
  10,000 lines rewritten on the next save. Saving still joins the whole file with
  that single detected EOL (`lines` is kept `\r`-free throughout; only `/api/save`
  re-attaches it — spec §3.11); the vote is what keeps the rewrite down to the
  minority lines instead of all of them.
- **Clicking the header grip no longer opens an inapplicable menu.** The row
  menu's only item is "delete row" and a header can never be deleted, so the
  header grip now just highlights the row instead. Two things were fixed
  alongside it: the highlight is painted on the row's **cells**, not on the
  `<tr>` — every `<th>` (and the sticky first column's `<td>`) paints its own
  opaque background on top of the row box, so a row-level highlight was
  literally zero pixels of change; and with that highlight showing and no menu
  open, `Esc` used to fall through to the focused cell's own Escape branch and
  revert the whole table burst, discarding everything typed into it.
- **A table gesture can no longer rewrite a DIFFERENT table.** Every table
  structure op (insert, delete, align, row drag, column drag) first commits
  whatever editor is open elsewhere, and that commit re-renders the document —
  which renumbers every block id. The op then re-resolved "its" table by the id
  it had captured *before* the commit, so a commit that added a block above
  (splitting a paragraph in the MD 原始碼 editor, say) made that id name the
  neighbouring table, and the gesture landed there: columns reordered, or a
  data row promoted to header, in a table the user never touched. The table is
  now re-resolved by its start line and checked against the identity captured
  before the commit; a gesture that cannot be matched back is dropped instead.
- **A refused delete no longer canonically rewrites the table.** "刪除列 /
  刪除欄" on the last row/column shows a banner and deletes nothing — but the
  selection highlight it left standing had already been baked into the burst's
  "nothing changed yet" baseline, so the next click elsewhere (which strips the
  highlight) registered as an edit and re-serialized the whole table into its
  minimal form. Hand padding and hand-written alignment vanished from a table
  the user had only clicked on. That baseline now ignores selection chrome
  entirely.
- **A drag can no longer emit a headerless or ragged table.** A column move now
  abandons the whole operation if any row is too short, instead of skipping that
  row and reordering the rest — which left the columns misaligned while every row
  still had its original cell count, so the ragged-table guard could not see it.

### Known behaviours

- After a row or column reorder the caret lands on the same cell **ordinal**
  rather than following the cell that moved.
- The leftmost ~20px of the first column is covered by the row grip (it sits just
  **inside** the table's left border, because the space outside belongs to the
  block's own ⠿ handle), so a click in that strip does not place the caret.

## v2.10.0 — 2026-08-27

The Phase 3 editor work below shipped across v2.9.0 and v2.10.0; both of those
releases went out with it still sitting under `## Unreleased`, so neither tag's
changelog mentioned it. Recorded here after the fact.

### Added

- **Phase 3: Notion-grade editing** — click anywhere in a paragraph/heading/list/
  table to type directly (no "select then edit" step). Rendered formatting shows
  as you type; focus leaving the block auto-commits. Ctrl+Z/Y step through local
  block history then cascade to document level. ⠿ block menu offers heading depth
  control and MD 原始碼 escape hatch.
- **List structural editing** — Enter splits items, Shift+Enter inserts `<br>`,
  Tab/Shift+Tab indent/outdent; empty-item Enter removes it. Removing all items
  deletes the block cleanly.
- **Table always-on editing** — every cell permanently editable; Tab/Shift+Tab
  navigate between cells (within table stays in burst); ＋ bubbles on edges insert
  rows/columns; edge-click menus delete and cycle alignment (columns) or delete
  (rows); row-edge drag reorders body rows. Edited tables emit gate-compatible
  minimal form (single-space padding, minimal separators).
- **Burst undo with cascade** — Ctrl+Z/Y within a block step through that block's
  local session history; once exhausted, the next step cascades to document-level
  undo/redo stack.
- **Block-level insert and delete** — a ＋ button next to every block's ⠿ handle
  opens a menu (段落/標題/清單/表格/程式碼) to insert a new block directly below,
  with the cursor landing in it immediately; the ⠿ menu gained a 刪除 item to
  delete the whole block (absorbing one adjacent blank line, mirroring the
  existing empty-list-removal line math). Both are a single Ctrl+Z step.

## v2.8.1 — 2026-08-24

### Fixed

- **Mermaid diagrams lost their theme colors in the popup.** Mermaid scopes its
  embedded CSS to the svg's `#id`; the lightbox clone dropped the id and the
  theme died. The clone now takes a `lightbox-<id>` rename with the scoped
  selectors rewritten to match.
- **Dragging a shape left a ghost at the old spot.** During an `m`-mode gesture
  the raster clone reverts to the unannotated base image (the overlay renders
  the live shapes); release re-bakes.

### Changed

- **Stroke widths are now office-like absolute values.** S/M/L = 1/2/4 px at
  fit zoom (was a multiplier on an auto-thickened base that got chunky on
  fit-enlarged vector art). Arrow heads and the selection UI scale down
  accordingly.

## v2.8.0 — 2026-08-24

### Added

- **Annotations stay on the inline figure after Esc.** Closing the lightbox
  overlays the drawings on the in-document image/diagram (same-viewBox svg,
  click-through). In-memory only — reload starts clean; Clear + Esc removes it.
- **Stroke color and width pickers.** Five color swatches (red/blue/green/
  orange/black) and S/M/L widths. New shapes take the current style; with a
  shape selected in `m` mode the pickers restyle it, undoably. Arrow heads
  follow the stroke color.
- **⧉ Copy button.** Composites artwork + annotations to a PNG on the
  clipboard — works for raster images and vector diagrams alike (vector at 2x).

### Fixed

- **Right-click "Copy image" in the lightbox missed the drawings.** The shown
  raster clone is now re-baked (image + shapes → PNG data URI) on every
  committed op, so the native copy includes the annotations.

## v2.7.0 — 2026-08-24

### Added

- **Lightbox annotations.** Mark up any popped-out diagram or image with the
  shared-whiteboard shortcut set: `f` freehand, `e` ellipse, `r` rectangle,
  `l` line, `a` arrow, `m` select/move/resize (Del deletes), `Ctrl+Z`/`Ctrl+Y`
  undo/redo, and a Clear button (one undoable op). Shapes live in image
  coordinates so they ride every zoom, survive close/reopen of the same image
  within the page visit, and reset on reload. Esc is layered: cancel the
  in-progress stroke → drop the selection → close the lightbox.

## v2.6.1 — 2026-08-24

### Changed

- **TOC horizontal scrollbar.** The TOC list now shows a thin native horizontal
  scrollbar when a title overflows, so the mouse can drag it directly —
  shift+wheel still works. Doubles as the "more text clipped" hint.

## v2.6.0 — 2026-08-24

### Added

- **Drag the sidebar/content divider to resize.** The 32px gutter between the
  sidebar and the document is now a splitter: invisible until hovered (a thin
  blue line + `col-resize` cursor), drag to set the sidebar width (180px–50vw),
  double-click to reset. The chosen width persists across reloads via
  `localStorage`. Hidden in the collapsed rail, the mobile drawer, and print.
- **TOC horizontal peek with shift+wheel.** Deep headings no longer ellipsize —
  titles keep their natural single-line width and the list clips them at the
  edge (no horizontal scrollbar). Shift+wheel scrolls the TOC sideways to read
  the clipped tails; the position stays where you leave it and defaults to the
  far left.

### Changed

- **Compact search results.** The search label is now just "Search", snippets
  shrink to ~25 chars before / ~45 after the hit, clamp to two lines, and the
  matched keyword is highlighted with `<mark>`.

## v2.5.0 — 2026-08-21

### Added

- **Click a diagram or image to open it full-screen.** Spec artwork is drawn far
  wider than the text column, so the inline copy is unreadably small. Clicking
  any image, Mermaid, Graphviz or WaveDrom graphic now pops it into a modal
  stage that zooms and scrolls.
  - Wheel scrolls, shift+wheel scrolls sideways, ctrl/cmd+wheel zooms around the
    pointer, and dragging pans. Toolbar buttons and the `+` `-` `0` `1` keys do
    the same; `Esc`, the ✕ and a click on the backdrop close it.
  - Zoom resizes the artwork rather than applying a CSS transform, so the scroll
    extent grows with it — under a transform the enlarged edges cannot be
    scrolled into view at all.
  - Vector art opens scaled to fill the window (a 480px-wide waveform is exactly
    what needs enlarging, and SVG upscales losslessly); a raster image opens at
    actual size, where going past 100% only buys blur.
  - An image wrapped in a link stays a link. The overlay is built on first use,
    is hidden in print, and never reaches the PDF output.

## v2.4.2 — 2026-08-21

### Fixed

- **Zooming no longer loses your place.** Browser zoom (and any window resize)
  reflows the text column but leaves the pixel scroll offset untouched, so the
  passage being read slid out of view — measured at 252 px of drift on a real
  spec for one zoom step, with the browser's own scroll anchoring contributing
  nothing. The reader runtime now remembers which block sat at the top of the
  reading column and restores it after the reflow, re-applying it a frame later
  so late-settling images and diagrams cannot knock it loose again.
  - The anchor is re-captured on scroll, throttled to one `requestAnimationFrame`
    and resolved with `elementFromPoint` (falling back to a binary search over
    the headings), so it costs one hit-test per painted frame rather than a
    walk of the document.
  - A height-only resize — a mobile browser hiding its toolbar, a devtools dock —
    reflows nothing and is deliberately left alone, since correcting the scroll
    there would only jerk the page.

## v2.4.1 — 2026-08-20

### Fixed

- **Markdown images now render.** `![alt](assets/pic.png)` was emitted with its
  relative src verbatim, but the HTML is written somewhere else entirely (the OS
  temp dir by default, or wherever `--out` points), so the browser resolved the
  path against the wrong directory and every local image silently failed to
  load. Local image references are now resolved against the **source markdown's**
  directory and inlined as base64 `data:` URIs — the same self-contained
  principle the embedded CSS / KaTeX fonts already follow, and the only form
  that also survives the puppeteer PDF path (which renders from its own temp
  HTML). Applies to markdown `![...]()` images and to author-written `<img>`
  tags (common in specs for `width=`).
  - Covers `src` **and** `srcset` (a browser prefers `srcset`, so leaving it
    relative breaks the image even when `src` is inlined), on `<img>` and on
    `<source>` inside `<picture>`.
  - Remote (`http(s)://`, protocol-relative) and pre-baked `data:` srcs pass
    through untouched. Only known URL schemes count as remote, so a filename
    containing `:` stays a local file.
  - Percent-encoded names (`my%20pic.png`), `./`-prefixed and absolute paths all
    resolve. A `?query` is dropped; an SVG `#fragment` is kept on the data URI.
  - Only known image extensions are inlined — `![x](../../id_rsa)` is left
    alone and warned about rather than base64'd into a document meant to be
    shared. An `<img>` inside an HTML comment is skipped for the same reason.
  - A reference with no file on disk keeps its original src and warns on stderr
    (`[WARN] image not found, left as-is: ...`) instead of failing the render.
  - Inlining an image larger than 4 MB warns on stderr; the render still
    succeeds.
  - `alt` / `title` keep marked's own escaping — no `&amp;amp;` double-escape —
    and any image that is *not* inlined renders through marked's stock
    `image()` renderer, byte-identical to before.

### Note

Each reference carries its own copy of the payload, so a document that shows the
same 1 MB diagram three times grows by ~4 MB. That is base64's floor for a
self-contained file; the PDF output is unaffected (Chromium dedupes on decode).

## v2.4.0 — 2026-06-28

### Added

- **KaTeX math rendering.** ` ```math ` fenced blocks, `$$…$$` display math and
  `$…$` inline math now render as typeset math via server-side KaTeX
  (`katex.renderToString` + `marked-katex-extension`). Rendering is fully offline
  and self-contained: the KaTeX stylesheet is inlined with all woff2 fonts
  base64-embedded, so a math-bearing HTML displays and prints (including the
  puppeteer PDF path) with no network. The math stylesheet is injected only when
  a document actually contains math, so math-free output stays byte-identical.
  Unsupported expressions degrade to red error text (`throwOnError: false`)
  instead of crashing the render.

### Changed

- **TOC items are now single-line.** Long headings no longer wrap; they are
  clipped with an ellipsis (full text on hover via `title=`, and always visible
  in the new breadcrumb). The TOC left edge stays anchored while the document
  scrolls — it never auto-scrolls horizontally. Row spacing was tightened.
- **Sticky breadcrumb replaces the static `Contents` header.** The sidebar header
  now shows the ancestor heading chain of the current scroll position (VSCode
  sticky-scroll style), stacked and clickable, updating as you scroll. The
  expand / collapse controls moved to their own row above it.

## v2.2.0 — 2026-06-11

### Fixed

- `~` / `^` operators inside code are no longer mangled into `<sub>` / `<sup>`.
  Subscript (`~x~`) and superscript (`^x^`) were applied by a raw-text pre-pass
  that ran before the markdown was tokenised, so `~NOT` / `^XOR` operators in
  fenced, indented and inline code got rewritten — e.g. a `PAD = ~abort & ~fcs`
  code block rendered as `<sub>abort & </sub>fcs` (96 such mangles in one RTL
  spec). Subscript / superscript are now code-aware `marked` inline extensions:
  they never fire inside code, and the tokenizer requires a single
  whitespace-free token (`~x~` / `^x^`), so spaced operator expressions
  (`~a & ~b`, `a ^ b`) and lone operators (`2^24`, `~rst`) stay literal even in
  prose. Genuine subscripts such as `SMD-S~0..3~` still render.

### Tests

- Added `test/code-operator.test.js` (operators-in-code regression) to the
  `npm test` suite.

## v2.1.1 — 2026-06-11

### Fixed

- Mermaid source is now HTML-escaped inside the `.mermaid` div. Raw injection
  let the HTML parser consume entities and tags before mermaid ran — an
  author's `&lt;IP&gt;` became an `<IP>` element that mermaid sanitized away,
  silently dropping label text. Escaping restores GitHub-equivalent semantics
  (`&lt;IP&gt;` displays as `<IP>`, literal `<br/>` still line-breaks).
- CDN fallback bumped from `mermaid@10` to `mermaid@11`. v10 scrambles
  `flowchart` layout when a subgraph with `direction` has edges crossing its
  boundary; v11 lays the same source out top-down like GitHub.

## v2.1.0 — 2026-06-11

### Added

- `--out` extension now selects the output format when no `--html`/`--pdf` flag
  is given: `md2doc foo.md --out report.pdf` renders a PDF instead of erroring.
  Explicit flags still win, and a flag that contradicts the `--out` extension
  still exits 2. Directory targets (trailing `/` or an existing directory —
  even one named like `foo.pdf`) keep the HTML default.

### Fixed

- Uppercase `.PDF` output paths no longer lose the rendered file. The temp-HTML
  path was derived with a case-sensitive `.pdf` replace, so for `--out X.PDF`
  the temp file aliased the destination and the post-render cleanup deleted the
  freshly written PDF while still reporting success.

### Changed

- Failure modes shifted for two previously rejected invocations: flag-less
  `--out *.pdf` now succeeds (and overwrites an existing file, as explicit
  `--pdf` always did), and in environments without puppeteer it now fails at
  render time with exit 1 instead of failing argument validation with exit 2.
- The mismatch / ambiguous-`--out` error messages now mention the inference
  rule, and the both-formats message now suggests `--out <dir>/` (key
  substrings unchanged in all three).
- An `--out` whose basename is just `.html`/`.pdf` (extension only, no stem) is
  now rejected as ambiguous at argument time instead of failing late in the
  renderer with a contradictory message.

## v2.0.1 — 2026-05-23

### Fixed

- Long snake_case identifiers in headings (h1–h6) and `<dt>`/`<dd>` no longer
  overflow the viewport. The prose-only `overflow-wrap` rule introduced in
  v1.1.0 left headings uncovered; this extends it to headings and definition
  lists while preserving the table-cell `overflow-wrap: normal` override.

## v2.0.0 — 2026-05-22

### Breaking changes

- **Removed** `md2html` and `md2pdf` binaries. Use `md2doc` instead.
  - `md2html foo.md` → `md2doc foo.md`
  - `md2pdf foo.md`  → `md2doc --pdf foo.md`
- **Removed** default output next to the source markdown.
  - Default output now writes to `<os-tmpdir>/md2doc/<stem>-<hash>.<format>`.
  - Pass `--out <path>` to write somewhere specific.
- **Changed** `--open` to default ON when `--out` is absent.
  - Pass `--no-open` to opt out.
  - Passing `--out` automatically disables auto-open (override with `--open`).

### Added

- Unified `md2doc` CLI with `--html` / `--pdf` flag selection.
- Both formats in one invocation: `md2doc --html --pdf foo.md`.
- `--out` directory mode (`--out ./build/`) for batch output with stable filenames.
- `--no-open` flag for explicit opt-out of viewer launch.
- `test/cli.test.js` covering the full CLI surface.

### Internal

- `lib/md2doc.js` rendering pipeline unchanged. The new binary is a thin
  orchestrator: arg parse → output path resolution → spawn `lib/md2doc.js` per
  `(input, format)` → optional viewer launch.

## v1.1.2 and earlier

See git history.
