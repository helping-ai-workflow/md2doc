# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v3.3.0 — 2026-09-10

v3.2.1 出貨時，Known issues 裡誠實列了十三個「用產品」審查席位在一次就座裡找出來、
本版一個都沒修的問題，其中三個嚴重到必須逐條點名——表格加不了列或欄、第一次點進表格
落錯格會覆蓋掉欄位標題、raw 編輯器的 caret 一律落在收尾 fence 之後。v3.3.0 是把那張
清單認真清掉的一版：不是重新讀 diff，而是把 ⠿／＋ 選單、工具列、表格編輯這整族手勢
換成真的滑鼠按壓（`mousedown` → 停留 → `mouseup`，不是合成 `.click()`）重新驅動一遍，
過程中又翻出更多先前八輪 review 與整套 journey 網都沒測到的缺陷——undo 會連剛打的
整句一起吃掉、巢狀清單的尾隨空白會覆蓋掉上一項、一次編輯讓 fence 吞掉半份文件卻沒有
任何信號。這版也第一次給了工具列鍵盤入口。過程中另外量測到十五個真實存在、但裁定
延後的項目，全部誠實列在下面——不是每一個 Known issues 裡的問題這次都修完了。

### Added

- **工具列可以純鍵盤操作，而且 DOM 焦點完全不移動。** 先前的路完全不通：從 BODY
  連按十二次 Tab，`activeElement` 仍在 BODY；就算硬把焦點放到某顆按鈕上，只要當下有
  未 commit 的 burst，`focusout` 就會提交＋重繪，那顆按鈕自己剛拿到的焦點也跟著沒了。
  現在的游標是虛擬的：`Alt+F10` 把它升起在某顆按鈕上（以 `data-ed-tb-cursor` 標記，不
  搶 DOM 焦點），方向鍵在按鈕之間走，Enter／Space 走按鈕自己的點擊處理，Escape 交還。
  游標所在的按鈕被工具列自己關掉時，會自動跳到下一顆還開著的，整條列上永遠不會停在
  一顆什麼都按不動的按鈕上。已知邊界（哪些操作鍵盤走不到、逃生路回程不還原 caret 等）
  見下方 Known issues。

### Changed

- **Tab 在表格裡改成選取整格，打字是取代，不是附加。** 走到下一格時，先前的落點是
  「該格既有文字的末端」，所以 Tab 完馬上打字會接在後面；現在會選取那一格的全部內容，
  跟試算表的語意一致——這也是本版刻意的行為改變，不是缺陷，舊測試裡釘死「Tab 之後打字
  會附加」那個形狀已經照新語意遷移。
- **側欄開關在編輯模式下隱藏。** 它先前躲在工具列底下按不到（`z-index` 100 對 101，
  `elementFromPoint` 一律回工具列），修法不是把它拉高一層，而是承認工具列自己的 ☰
  已經是可用的路——同一顆按鈕開同一個抽屜，而且鍵盤游標也走得到——所以編輯模式下乾脆
  把那顆擋在下面、按不到的開關藏起來；原始碼模式下 ☰ 這次也跟著解除禁用，抽屜在那裡
  不再是只有一顆看得到、按不下去的鬼影按鈕。
- **CLI 現在在每一種結束方式上都印一行話。** 分頁閒置關閉、`Ctrl+C`、以及連結從沒被
  打開過就逾時——三條路先前全部靜悄悄地結束，`Ctrl+C` 甚至完全沒有訊號處理常式，行程
  在 `cli.js` 自己的 close listener 有機會跑之前就先死了；沒被打開過的那一條原本連結束
  計時器都沒有，是一個打不死的行程。現在三條路各自印出自己的那一行，再照原本的 `close`
  事件正常結束。

### Fixed

- **undo 會連剛打的整句一起吃掉。** 打一句話、把其中一個字加粗、按 `Ctrl+Z`——整句話
  跟著粗體一起沒了。`noteTyping()` 沒有計時器，一段打字的過程本身從不自己存檔；而每個
  程式化的變動都是「先改 DOM，才呼叫 `snapBurstIfActive()`」，於是那一筆存檔同時扛著
  剛打的字和那次加粗。十二個呼叫點（mark×6、br×3、paste×3）現在兩側都存檔——多存一次
  是免費的，`snap()` 只有在跟堆疊頂端不同時才真的推。表格另外還有七個直接呼叫
  `history.snap()`、繞過上面十二個呼叫點清單的結構性操作（插入／刪除列或欄、對齊、
  拖拉列／欄），同一個缺陷、同一套修法，一併補齊——修前的實測是：打字進儲存格、插入
  一列、按一次 `Ctrl+Z`，剛打的字跟著沒了。原生 `Ctrl+B/I/U` 是另一條機制（瀏覽器自己
  的 `execCommand`，不經過上面任何一個呼叫點），改用 capture-phase 的 `beforeinput` 在
  變動前存一次、`input` 在變動後再存一次。
- **巢狀清單裡尾隨一個空白，會覆蓋掉上一個項目。** `marked` 會把巢狀清單 token 的
  `raw` 尾端空白去掉，卻留在外層 `item.text` 裡，於是逐位元組比對的 `indexOf()` 找不到、
  猜成行號 0，整個父層範圍反著算、底下每個子項都被推早了一行——一次提交因而回放到
  「上一個」項目，`- alpha\n  - beta\n  - \n` 存檔後變成 `- alpha\n  - alpha\n-\n`，
  `beta` 憑空消失。兩側先各自正規化尾隨空白再比對；真的定位不到時，整個子樹拿到一個
  空範圍加 `unlocatable` 旗標，而不是用猜的行號。
- **選取起點落在既有標記內部時，序列化會留下跳脫星號，含 🔗 連結路徑。**
  `extractContents()` 只複製 Range 真正包含的那部分，原本的元素還留在原地；如果選取起點
  正好落在該元素第一個子節點的 offset 0，就會留下一個空的 `<em>`，而空 `<em>` 兩側照樣會
  序列化出定界符——實測「對斜體第一個字起套粗體」寫出 `Alpha *****ital* bold**
  text here.`，走 🔗 連結同一個形狀。修法讓兩條寫入路徑（`applyMarkToggle()` 的 wrap
  分支、`applyLinkToggleBody()` 的新連結分支）共用同一個抽出函式，在抽出前先記下邊界
  容器的祖先元素，抽出後把裡面已經空了的那些移除。追查後另外量到三個會產生同一種殘留
  的手勢：`Shift+Enter`、貼上、以及在清單項目裡按 Enter，三者現正一併修掉，同樣不留下
  跳脫星號。
- **吞噬到文件後半段時，介面完全沒有信號。** 一次編輯讓文件變成以未關閉的 fence 收尾，
  後面原本的內容被整段吃進 fence 裡，先前這個情況存檔完全無聲。判斷式現在同時看
  「document 是否以未關閉 fence 收尾」與「區塊數是否真的變少」，在 24 個手勢（整份
  source mode 與逐格 raw editor 都掃過）上量測：零誤報，三種真實吞噬形狀都會觸發，
  已知的唯一漏網是恰好吞掉一個區塊（新 fence 的 +1 跟被吃掉的 −1 互相抵銷)。後續又用
  逐行的判定取代加總判定，修掉「同一份 fence 裡有重複行（例如 `}`）時吞噬會被加總互相
  抵銷而消音」與「trim 到 fence 收尾再把被剪掉那行複製回 fence 內，會被誤判成吞噬」兩個
  更深的形狀。最終在 374 個手勢上量測：198 個真吞噬、0 個誤報、19 個漏網（14 個是已知
  的「新 opener 與既有 closer 配對」家族，另外 5 個是「刪掉 closer 同時刪掉被吸收內容的
  另一份副本」）。
- **點開程式碼區塊會把游標放在收尾 fence 之後，接著打字會破壞 fence。** `openRawEditor()`
  對所有區塊種類都把 caret 放在 `value.length`；對一個 fenced code block 來說那個位置在
  收尾 fence 之後，第一個打進去的字就落在收尾行上，讓它不再是合法的收尾。現在依 fence
  的形狀而非區塊種類判斷：值的第一行是開 fence 且還有其他行，就把 caret 放在下一行開頭；
  其餘情況維持原本 end-of-value。
- **在別處打完字之後第一次點進表格，游標落在表頭第一格，接著打字覆蓋掉欄位標題並寫進
  磁碟。** 有未 commit 的編輯先被 commit（第一次提交沒有 `lastParts`，走的是整份重繪的
  `applyFullRender()`，`innerHTML =` 把剛按下的那格 detach 掉），復原邏輯退回
  `tableCellsOf(...)[0]`。現在會先記住按下那一格的 (row, col)、所屬區塊的 startLine 與
  表格身分，commit 完再用這些重新定位——四種 commit 形狀都驗過：(row, col) 撐得過重建，
  `data-block-id` 與 startLine 各自撐得過對方撐不過的形狀，兩者互為備援。
- **在表格最後一格按 Tab、第一格按 Shift+Tab 是死鍵，而且照樣吃掉瀏覽器原本的
  Tab。** 目標索引被夾回按下當下所在的那一格，`preventDefault()` 卻還是照樣呼叫，於是
  連瀏覽器自己的 Tab 巡覽也一起被吃掉。落點本身也是錯的：Tab 到下一格時 caret 停在既有
  文字末端，Tab 完馬上打字會變成附加而不是取代——見上方 Changed。現在 Tab 會走完整張
  表格再離開，離開時交給最近一個有可聚焦面的區塊、跳過已降級的區塊；表格內或表格外都
  沒有下一步時，按鍵原地吞掉，因為交還會落進 gutter 的鍊條式操作區，那些本來就故意排除
  在 tab 順序之外。
- **⠿ 與 ＋ 選單裡的項目，在真人按壓下（按下、停留約 80ms、放開）完全失效。** 委派的
  `preventDefault` 清單只列了 `.ed-handle`／`.ed-insert`——打開選單的那兩顆按鈕，沒有列
  選單裡的項目本身。實測的時序：按下 7ms 後 `focusout` 提交，8ms 後送出
  `/api/render`，28ms 時整個區塊元素被替換掉（連帶掛在它身上的選單一起消失），
  93ms 放開時落在替換後的節點上——完全沒有 `click` 事件。先前整套測試都測不到，因為
  沒有任何一個地方用真的 `mousedown`／`mouseup` 按過選單項目；合成的 `.click()` 從不
  觸發 `mousedown`。
- **表格 ＋ 泡泡，手一靠近就消失。** 這兩顆泡泡是釘在 `document.body` 上、蓋在自己該
  出現的那條窄邊上的 `position: fixed` 浮層，指標一到達泡泡本身，`mousemove` 的
  target 就變成泡泡自己，判斷邏輯讀不到底下的表格於是把它藏起來——整段接近路徑都在
  閃爍，按下去按不按得到全看事件落在哪個 parity。列 grip 從它蓋住的那條窄邊也是同一個
  問題，泡泡沒有。現在指標落在這兩個浮層上時，會回退用這次 hover 已經解析出來的那張
  表格，其餘的可見性判斷不變。
- **捲動之後，浮動格式列還停在原本的視窗座標，而且照樣按得下去。** v3.2.1 修過「捲出
  視窗會收起」，但捲回來不會讓它回來：收起時清掉的旗標，反而擋住了它自己的重新升起
  條件。現在收起與升起各自維護這個旗標，捲回來時能正確重新判斷。同時把 Task 15 的
  Tab 抑制也接到捲動路徑上，否則 Tab 造出的整格選取在捲動時會被錯誤地重新升起。
- **工具列在窄視窗下被裁掉，而且部分按鈕永遠拿不到，不論怎麼捲。** flex 列用置中排版，
  溢出的部分往兩端平分，而捲動容器的前緣本來就捲不到；在 820／640／420px 寬下實測，
  `undo`、`undo/redo/headings`、`undo/redo/headings/quote/code/list` 這幾組按鈕，把
  `scrollLeft` 掃過整個範圍都沒有一個位置能讓它們進到可視範圍內。現在改成從前緣開始
  排版，並在尾端保留模式欄位的空間，工具列本身也加上依 `scrollLeft` 點亮的左右漸層，
  提示這裡是可以捲的。
- **⠿ 的「轉換成」子選單、`H▾` 下拉、表格列邊選單，都可能開到視窗外。** 三者都用固定
  的 `top` 定位、完全不看視窗高度；「轉換成」在 200/150/100px 高的視窗下量到十二個
  項目有幾個構不到，`H▾` 與列邊選單各自在自己的高度下量到同樣的缺口，列邊選單甚至在
  700px（一般桌面視窗高度）就會咬人。三者現在都在自己實際渲染完之後量出溢出視窗底部
  的量，把 `top` 往上移那麼多；`H▾` 另外加上 `max-height` + `overflow-y` 作為視窗比
  面板還矮時的後備。
- **粗體／斜體／刪除線／行內程式碼按鈕，不會顯示現在是開還是關。** 選取整段落在
  `<strong>` 內部、跨在它邊界上、或在純文字裡，這三種情況下 `aria-pressed` 都回傳
  `null`——這幾顆按鈕原本是 `toggle: false`，`deriveState()` 收到的 ctx 裡也只有
  「有沒有選取」這個布林值，完全不知道選取內容的身分。現在會依每個標記 tag 量出
  `applyMarkToggle()` 會走哪一個分支，回傳整／半／無／INERT 四種狀態，固定列與浮動列
  共用同一份測量結果。
- **側欄開關在編輯模式下按不到。** 見上方 Changed。
- **lightbox 的捲動鎖是空的，開著圖片放大檢視時底下的頁面照樣捲得動。** 全域的
  `html, body { overflow-x: clip; }` 讓 `documentElement` 自己的 `overflow-x` 永遠停在
  `clip`，`body[data-lightbox-open] { overflow: hidden; }` 因此傳不到視窗層——真實手勢
  （在 `.lightbox-bar` 上滾輪、`PageDown`、`End`）在 1400×800 下分別漏了 500／700／
  1048px。現在把 `data-lightbox-open` 同時鏡射到 `<html>` 上鎖，用 overflow 而非
  `position: fixed`（後者會連帶凍結其他測試依賴的程式化捲動）。
- **打過字之後關分頁不會被攔下。** `stack.dirtyDepth` 只在一個操作真的進了 undo 堆疊
  才會動，而一段打字在 burst 解決之前只停留在 DOM 上，於是打字後直接關分頁量到的是
  標題仍是「doc」、`beforeunload` 對話框完全不出現——整條關分頁的路對這種編輯沒有任何
  網。現在兩個判斷點都改讀「`dirtyDepth !== 0` 或 burst 裡有未 commit 的編輯」，後者
  掛一個隨 burst 重新指向的 `MutationObserver`，因為打字會發 `input` 事件，但格式列的
  標記按鈕不會。
- **CLI 三個結束路徑都沒有任何訊息，其中一個還是打不死的行程。** 見上方 Changed。
- **對齊（cycleColumnAlign）只改 `style="text-align:…"`，不會讓分頁被標記為未存檔。**
  這是修 🔗 連結那個「監看 attributes 沒有必要」的推論被過度推廣後留下的漏洞：刪掉
  `attributes: true` 對 🔗 是對的（它經過 modal，commit 早在 `setAttribute` 之前就
  發生），但對齊完全是另一種形狀——整個操作只寫屬性、不commit burst，於是拿掉屬性監看
  後標題停在「doc」，關分頁的守衛卻認為有未存檔的變動，兩者互相矛盾。現在把
  `attributes: true` 加回來，並把檔案裡所有會寫屬性的站點重新逐一分類。

### Known issues

這一版的驗證基礎是兩套長跑測試——`test/editor-client-runtime.test.js` 與
`test/editor-journey.test.js`——加上其餘三十七個快速檔案，一共三十九個測試檔。
`editor-journey.test.js` 在這版裡從 2,252 行長到 7,563 行（38 個 commit 動過它），
每一條上面列出的缺陷與其 ablation，幾乎都是靠它釘住的。

過程中用真實滑鼠事件重新驅動整族手勢時，另外量測到十五項真實存在、但裁定延後到
v3.4.0 的項目——每一項都被驅動量測過，不是推測，這裡不因為它們讀起來不好看就不列：

會把資料弄髒的（優先）：

- **對一個已被吞噬的 code block 重開 raw 編輯器去補 fence，會把尾巴在磁碟上複製一
  份。** 逐位元組重現的既存缺陷，跟 F10（吞噬本身）不同根因——這是從吞噬狀態復原時
  自己的路。
- **`onRowInsertBubbleClick()` 的 `afterRowIndex` 在表格換手之後會過期**，
  `bodyRowsOf(...)[idx]` 拿到 `undefined`，於是新列插到最上面，而不是把這次手勢
  丟掉。
- **選取起點落在像 `` *`code`* `` 這種定界符相鄰處時，`inline-md.js` 挑定界符長度的
  邏輯仍會產生 `\*` 跳脫。** 跟本版修掉的「空殘留標記」不同根因、不同檔案、不同修法；
  刻意不釘測試，因為釘住今天這組錯誤的位元組，會讓將來真正的修法因為錯誤的理由被
  測試擋下。

可達性／鍵盤：

- **`quote`／`code`／`line` 三顆工具列按鈕活化後，把 caret 留在 BODY；surface 上有
  未 commit 的編輯時，`undo`／`redo`／`image` 也一樣。** 滑鼠按下同樣三顆行為完全
  相同，但只有鍵盤使用者真的出不來——逃生路是 `Alt+F10` → `preview` → Enter 進
  source textarea，而且回程不會把 caret 還原。
- **`H▾` 下拉的六個項目仍然只能用滑鼠操作。**
- **任何 `.ed-conflict` banner 升起時，工具列整條都按不到**——`elementFromPoint`
  在按鈕的落點上一律回傳 banner，對所有 banner 皆然。
- **側欄抽屜的內容（TOC 連結、search）沒有任何鍵盤入口。** 這版給了「打開」抽屜的
  路，沒有給「操作」抽屜內容的路。

幾何／遮擋：

- **`updateTableEdgeGrips()` 的守衛沒有列入 `.ed-tb-insert`**，站在 ＋ 泡泡上會讓
  ⠿ grip 消失——同一個根因，但要關掉它得放寬一個同時呼叫 `setGutterKeep()` 的
  early return，那個行為在這裡尚未量測過。
- **窄視窗開側欄會出現 `.sidebar-scrim`，但沒有任何捲動鎖，背後的頁面仍然可以
  捲。** 是「缺一個鎖」，不是「鎖被打敗」。
- **深縮排項目裡的 table 或 `---` 會讓 li 的 `startLine` 落在非 marker 行上**，
  這版改動前後行為相同。

已知且刻意接受的邊界（不是缺陷，但要讓使用者知道）：

- F10 的吞噬偵測有兩個已量測的沉默缺口：新開的 opener 跟既有的 closer 配對、讓文件
  變得 well-formed 的三個落點（跟使用者刻意「⠿ 轉換成 › 程式碼」在結果上同形）；以及
  「刪掉 closer 同時刪掉被吸收行內容的另一份副本」（佔真吞噬的 2.0–9.2%）。誤報方向
  量測乾淨：24,411 個非吞噬手勢，0 個內容可辨的誤報。
- F10 有一個內在的誤判：trim 到 EOF、並把被剪掉的那行複製進 fence 裡——那兩種手勢會
  產生逐位元組相同的文件，任何只看文件內容的判斷式都不可能分開它們。是設計上的極限，
  不是沒修的缺陷。
- `unlocatable` 這條降級路徑，在真實語料上量不到——35,000 個合成形狀、131 個真實
  序列化字串、1,231 個突變，`at < 0` 一次都沒觸發過；機制本身是靠擾動 `marked.lexer`
  驗證的。
- **按下的起點若落在既有選取範圍內，Chromium 走的是拖曳文字手勢**——只有
  `dragstart`／`dragend`，完全沒有 `selectionchange`，Tab 選格造成的浮動格式列
  抑制因此沒有任何東西可以解除它。用 ablation 證實拿掉這版的抑制邏輯一樣會發生，
  所以是瀏覽器本身的行為，不是這版留下的殘留；先收合選取（點一下、按方向鍵）再拖曳，
  就會變回一般的拖曳手勢。
- `Alt+F10` 會不會被真實瀏覽器或 OS 攔截（Firefox 的 `F10` 選單列、GNOME/KDE 的
  `Alt+F10` 最大化），在目前的自動化環境裡原理上驗不出來，需要使用者在真機上確認。

以下是先前就記錄過、到今天仍然成立的，這版沒有動：

- **§3 雙向同步仍未做。** 外部程式改了 markdown 檔案，開著的編輯器分頁不會反映那次
  改動，仍然要重新整理頁面。
- **`export▾` 仍然缺。** 工具列還是 22 顆按鈕，不是 23 顆。
- **每一個結構性的清單手勢都會整份重繪**（清單裡按 Enter、Backspace 併回或刪除
  項目、＋ 新增項目、⠿ 建立副本或上下搬移），這仍是刻意保留的 fallback，不是退化。
- **light／dark 主題切換沒有做**，這版也沒有開始做。

## v3.2.1 — 2026-09-06

v3.2.0 是走完八輪 code review 之後才出貨的。使用者拿到手，五分鐘的日常使用就找出六個
缺陷，並且說了這句話：

> 「我認為很多問題你應該要自己察覺，而不是我幫你驗證，代表你目前的驗證機制根本失職。」

v3.2.1 修的就是那六個，加上追查它們時翻出來的東西——其中三個是**沒有人回報過**的：三個都在
同一條路上，都把使用者的文字寫進了磁碟裡它不該在的地方（兩個是把你明明要丟掉的東西存下來，
一個是把同一次編輯存了兩遍）。這一版沒有新功能。它也不是那句話的終點：一個
「用產品」的審查席位在同一輪裡又找出十三個問題，本版一個都沒修，全部列在下方 Known
issues，其中三個嚴重到必須逐條點名。

### Changed

- **預覽模式移除，模式按鈕改成真正的兩態切換。** 使用者回報「按第二下卡住、所有區塊都
  沒有 ⠿」。診斷後沒有任何狀態洩漏：那顆按鈕原本是「編輯 → 原始碼 → 預覽」的三態循環，
  按兩下停在原始碼模式，而原始碼模式依設計就沒有 ⠿。真正壞掉的是介面在說謊——按鈕永遠
  標著「預覽」，兩個非編輯狀態都回報 `aria-pressed="true"`。順著查下去又量到一件沒人
  回報過的事：**預覽模式根本不是唯讀。** 22 顆工具列按鈕裡有 13 顆在預覽下改得動文件
  並且真的落到磁碟；而且切換之前就已經開著的 ⠿ 選單在切換之後仍然是可見、可點的，它的
  16 個項目每一個都寫得進磁碟。把它補成唯讀要列舉的可及面沒有邊界，而預覽相對編輯只多
  做兩件事（一次 contenteditable 翻轉，加兩行隱藏 ⠿／＋ 的 CSS），卻擋在「從原始碼模式
  回到編輯」的路上——所以移除，而不是替它加閘門。按鈕現在只在 編輯 ↔ 原始碼 之間切換，
  標示的是**它會把你切到哪裡**，不是你現在在哪裡。
- **v3.2.0 佔位的那個工具列狀態槽位，現在顯示的是目前模式**（「編輯」或「原始碼」），
  在工具列第一次繪製時就是真的。這是上一條的配套：模式必須說得出口。它**不是**存檔狀態
  ——那件事仍然沒做，見下方 Known issues。

### Fixed

- **在原始碼編輯框按 Escape 會提交，不是丟棄。** 你按 Escape 要放棄的那段文字，實測會被
  寫進磁碟。原因是還原區塊內容的那一行 `innerHTML` 寫入排在清掉 session 之前：寫入把
  聚焦中的 textarea 從文件上拔掉，Chromium 同步派發 `focusout`，而 `focusout` 只要看到
  session 還在就一路提交下去。把清除移到寫入之前即可，同一個函式的另一條分支本來就是
  這個順序。
- **表格編輯中按 ⠿ →「MD 原始碼」會提交那次編輯，不是切換過去。** 同一個形狀的第二個
  出口，而且沒有人回報過：表格 burst 的聚焦節點是 `<table>` 底下的儲存格，所以還原
  `<table>` 的 innerHTML 一樣會 detach 掉它、一樣同步觸發提交。這顆按鈕的職責是丟棄，
  實測卻把剛打的字寫進了檔案。
- **一次原始碼編輯會提交兩次。** 全量重繪把 `.content` 整個換掉時，同樣的 `focusout`
  重入路徑讓同一次編輯提交了兩遍。這件事之所以躲過八輪 review，是因為它平常看不出來：
  提交後仍停在同一個區塊時，第二次提交算出來的差異是空的、退化成無害的取消；只有當那次
  編輯讓文件多長出一個區塊時，磁碟上才會出現重複的文字。
- **按工具列的功能鍵會把你踢出正在編輯的區塊。** 這是使用者的頭號抱怨，而且它比按鈕本身
  更廣：每一顆會觸發重繪的按鈕（引用、程式碼、清單、編號、待辦、H▾、分隔線，以及
  undo／redo）按完之後 `document.activeElement` 都掉到 `<body>`，工具列同時從 22 顆裡
  可用的 15 顆塌成 4 顆——也就是說你連第二個動作都接不下去，得先回去點一次區塊。⠿ 選單
  的「轉換成」走同一個匯流點，症狀一模一樣，所以這從來不是工具列的 bug，只是工具列讓它
  變得無所遁形。現在
  轉換完成後游標會回到那個區塊的末端（除非你原本就有一段跨區塊的選取，那時不動它）。
  三種本來就沒有可聚焦編輯面的目標（引用、程式碼區塊、分隔線）游標回不去，那裡拿回來的
  是工具列本身——按完之後仍然是 15 顆可用，而不是 4 顆。
- **同一族還有三個入口從來沒被修過：`🔗 連結`、⠿「建立副本」、⠿「刪除」。** 這三個是這一
  版新加的一張家族層級的網（22 顆工具列按鈕加上 ⠿ 選單的 15 個葉節點，每一項在它真的可按
  的狀態下被真實點擊）自己抓出來的——在第一輪修完之後，它們**仍然**是 `<body>` + 4 顆。
  現在：連結套用完之後回到同一個區塊；「建立副本」把游標放在**原件**上（跨區塊選取時的收合
  行為本來就落在原件，複本又沿用原件的區塊 id、定位不到）；「刪除」把游標放到被刪區塊
  **上方**那一個的末端，若不存在則放到遞補上來的那一個——也就是 Notion 與 Backspace
  合併的答案。表格儲存格裡按 🔗 是唯一的例外，那裡只拿得回工具列：能取得的座標只有整張
  表格的行號，而那指向不可聚焦的 `<table>`。
  （同一條修法的邊界）**取消連結對話框不會吃掉你的選取。** 上一段的修法只在「著力點
  真的沒了」時才動作。開了連結對話框又改變主意是最常見的手勢，而按 Esc 時什麼都沒有
  提交、焦點本來就自己回來了，這時再多做一次歸位反而會把你的選取收合成一個游標。
- **插入圖片不會跑到檔案最後面。** 只要你在當前區塊裡打過字，圖片就一定落到文件結尾。
  兩個各自獨立的原因，兩個都修了：開檔案選擇器用的那一發合成 click 會被文件層的委派
  讀成「點到所有區塊之外」，於是提交＋重繪，剛抓好的落點節點被換掉；而就算擋住它，落點
  仍然是一個裸的 DOM 節點，要橫跨整個作業系統的檔案對話框存活——使用者想開多久就多久。
  現在落點以身分（而非節點參照）保存，檔案回來時重新解析。
- **捲動之後，浮動的格式列還留在畫面上，而且還按得下去。** 選取文字會浮出來的那一列
  （粗體／斜體／…）原本在捲動後停在原本的視窗座標，看起來正常、也真的可以點——而點下去
  會把格式套用在你已經看不見的文字上，`Ctrl+S` 就這樣把它寫進檔案，全程沒有任何提示。
  現在它會跟著重新定位，選取捲出視窗時就隱藏。表格的列／欄 grip、＋ 泡泡與 grip 選單是
  同一個形狀——那個選單能刪掉一整列，而你看不到自己刪的是哪一列——現在一併在捲動時收起。
- **對結尾帶空白的選取按粗體，會產生壞掉的 markdown。** 選到 `bold ` （含尾端那個空格）
  再按 B，輸出的是 `**bold **`，而它不是合法的 CommonMark 強調語法，於是渲染出來就是
  字面上的星號，下一次存檔再被轉義成 `\*\*` 留在檔案裡。使用者回報的「標題套粗體怪怪的」
  與「檔案裡出現跳脫的星號」是同一個原因的兩個症狀。現在套用之前會先把選取兩端的空白
  修掉，空白留在標記外面。
- **點一顆已經變灰的工具列按鈕會弄壞游標。** 停用的 `<button>` 在 Chromium 上根本不派發
  `mousedown` 與 `click`，所以按鈕自己的防護跑不到，游標照樣被瀏覽器搬走；若那個區塊剛好
  是髒的，接著的 `focusout` 還會順手提交＋重繪，工具列跟著塌成 4 顆。`pointerdown` 有派發
  而且可以取消，取消它就連帶擋掉那次焦點移動——所以一顆變灰的按鈕現在真的什麼都不會發生，
  而且解釋它為什麼是灰的那個 tooltip 也還在。
- **undo／redo 改寫到游標所在的區塊時，之後打的字會被靜默丟棄。** 實測 undo／redo 並不是
  普遍掉焦點——游標在被改寫範圍**之外**時一切完好；只有落在被改寫的區塊**裡面**才會掉到
  `<body>`，而且接下來打的字連磁碟都到不了。現在會把游標放回改寫後對應的那個區塊末端。
  這道修復掛在 v3.2.0 的增量 patch 路徑上；退回全量重繪的那些情況（見下方 Known issues）
  不在其中。

### Known issues

這一版第一次設了一個「用產品」的審查席位：一個席次不准讀任何 diff，只准像寫文件的人那樣
真的去用這個編輯器，用真實的滑鼠與鍵盤事件驅動，並且必須交出可被推翻的手勢紀錄。它在一次
就座裡找出**十三個**本版沒有修的問題——而那整類問題是 v3.2.0 的八輪 diff review 一次都
沒有碰到的。三個嚴重到必須點名：

- **表格沒辦法新增列或欄。** 三條路全部是死的：滑到表格左緣／上緣時會浮出來的 ＋ 泡泡
  只出現在很窄的一條邊上，而且你的指標一往它移動它就 `display: none`，那一下點擊直接
  穿透到底下的儲存格；在最後一格按 `Tab` 沒有任何反應；grip 選單只提供刪除列／刪除欄。
  對一份有表格的文件來說，這是目前最致命的一項。
- **在別處打完字之後第一次點進表格，游標會落在表頭的第一格。** 沒有任何提示，於是接下來
  的按鍵直接覆蓋掉欄位標題，而且照常存檔。三次全中；先前打字發生在清單項時也會觸發；
  冷開機、只做選取或只按 `Ctrl+B` 而沒打字、以及第二次之後進表格都不會。
- **點程式碼區塊、引用或圖片會開出原始碼編輯框，而游標一律落在結束 fence 之後。** 你點的
  是哪一行完全被丟掉。在那裡打字會破壞 fence，接著再按任何一顆插入鈕（―／⬇／⊞／🖼），
  畫面上的文件會少掉一整段——而磁碟上的檔案仍然完整，也就是螢幕與檔案對「文件到哪裡結束」
  的認知不一致。按兩次 `Ctrl+Z` 可以救回來。

其餘八項也一併記在這裡，沒有一項在本版修掉：套完粗體後按一次 `Ctrl+Z`，會連同你剛打的
整句話一起還原；粗體／斜體／行內程式碼按鈕不會顯示目前是開還是關（同一列的區塊層級按鈕
都會）；正在打字的當下開 ⠿ →「轉換成」，整個選單會直接關掉、不給子選單也不給訊息，而那
正是最想轉換區塊的時刻；轉換子選單在視窗下半部會開到畫面外；`Tab` 跳到下一格時游標停在
既有文字的末端而不是選取該格內容；**沒有自動存檔，畫面上也看不出來存了沒有**（工具列那個
槽位顯示的是模式，不是存檔狀態；唯一的未存檔提示仍然只有分頁標題前面那顆 `●`，關閉分頁時
的 `beforeunload` 確認則正常運作）；視窗寬度低於約 820px 時工具列按鈕會被裁掉且沒有溢出
選單；關掉最後一個分頁時 CLI 靜靜結束、不印任何訊息。

另外這些是先前就記錄過、到今天仍然成立的：

- **§3 雙向同步仍未做。** 外部程式改了 markdown 檔案，開著的編輯器分頁不會反映那次改動，
  仍然要重新整理頁面。
- **`export▾` 仍然缺。** 工具列還是 22 顆按鈕，不是 23 顆；缺的不是按鈕本身，是瀏覽器裡
  一條可達的匯出路由可以接。
- **每一個結構性的清單手勢都會整份重繪**（清單裡按 Enter、Backspace 併回或刪除項目、＋
  新增項目、⠿ 建立副本或上下搬移），**第一次提交也仍然整份重繪**。兩者都是 v3.2.0 刻意
  保留的 fallback，不是退化；理由見上一版的 Known issues。
- **light／dark 主題切換沒有做**，本版也沒有開始做。
- **行內標記的序列化還有一條會產生跳脫星號的路徑。** 上面修掉的是使用者回報的那個形狀
  （尾端空白）；另一個更窄的手勢——對一段**起點落在既有斜體內部**的範圍套粗體——仍然會
  在檔案裡留下 `\*\*`。修法要動的是整條行內標記路徑上最承重的那個函式，那是它自己的一輪
  工作，不是本版能順手夾帶的。
- **視窗寬度 ≤1080px 時，編輯模式下左上角的側欄開關點不到**：工具列的堆疊層級蓋在它上面，
  點擊會落在工具列的按鈕上。工具列自己的 ☰ 仍然開得起來，所以不是完全沒有出路。
- **lightbox 的捲動鎖是空的。** 開著圖片放大檢視時，底下的頁面照樣捲得動（實測 1048px），
  純閱讀模式也一樣。原因是全域的 `html, body { overflow-x: clip }` 讓 `body` 上那條
  `overflow: hidden` 永遠傳不到視窗層。

## v3.2.0 — 2026-09-04

v3.1.0 上線後回報最多的一件事是「打字會頓」——每一次提交都把 `.content` 整個換掉，
文件愈長，每個字、每次 Enter 的延遲就愈明顯，上一版的 Known issues 也老實承認了這件事。
這一版把提交的重繪範圍從「整份文件」縮小到「真正變動的那幾個區塊」。

### Added

- **增量 render。** 伺服器現在為 `blocks` 裡的每一個區塊各回一段已經渲染好的
  `part` 字串（`POST /api/render` 回 `{ parts, blocks }`），一支純函式
  （`window.md2docPatchmap`）拿新舊兩份 `parts` 逐一比對出「前綴不變／中段換掉／
  後綴不變」的最小 patch 計畫，只有真正變動的區塊會被移除重建，前後綴節點原地不動。
  這帶來的不只是速度：一次提交若沒有動到某個段落，那個段落的游標、選取範圍、已經畫好
  的 mermaid／graphviz 圖、以及使用者剛捲到的位置都會**原封不動**地留著——先前每次
  提交都會把它們一起換掉。第一次提交（`editRange` 缺席、`domMatchesLastRender()` 沒過、
  或 patchmap 判斷結構已經對不上）仍然整份重繪，這是既有 fallback 路徑，並非退化；
  見下方 Known issues 的第一次提交那條。
- **工具列的存檔狀態槽位。** 工具列右側先前刻意留空的那個位置，現在有了一個佔位
  的存檔狀態指示器——本身還不接雙向同步（見下方 Known issues），純粹是把**位置**
  先佔住（它是 `position: fixed`，不佔任何版面空間，所以也不會擠到按鈕列）。真正
  接上同步邏輯時要做的不只是填內容：那個槽位目前靠 `pointer-events: none` 才不會
  在窄視窗擋住底下的按鈕，程式碼裡的註解寫明了接手的人必須連同重疊問題一起解掉。

### Fixed

- **反應慢。** v3.1.0 的 Known issues 記過這件事：「編輯器仍然慢，這一版沒有改」。
  上面的增量 render 就是那個修法——一次提交裡**最貴的那一項**（銷毀並重建 `.content`
  的整棵 DOM、重新武裝每一個區塊、重畫每一張圖）現在只跟「變動了多少」成正比。
  這不是說整條路徑都變成 O(變動量)：patchmap 仍然要對新舊兩份 `parts` 各跑一次
  regex、`domMatchesLastRender()` 仍然要走過每一個子節點、`applySelectionClasses()`
  仍然是對每一個區塊的全掃，伺服器端也仍然是每次提交重新 render 整份文件。省下的是
  主導成本，不是全部成本。
- **原始碼編輯框在增量 patch 之後會變成沒人追蹤的殭屍。** `openRawEditor()` 開出來的
  `.ed-raw` textarea 是塞進區塊自己，所以 `.content` 的子節點數與每個 `data-block-id`
  都沒變、patch 照跑；只要那個區塊落在被保留的前後綴裡，textarea 就會活過 patch，而
  patch 的 teardown 仍然無條件把這個 session 歸零。結果是螢幕上還看得到、還能打字的
  編輯框，點到別處不會自動提交，下一次重繪直接把未提交的內容蓋掉——看得到，檔案裡沒有。
  現在改成：實測那個區塊節點是否真的還連在文件上，還在就把 session 留著，並且把
  `blockId`／行號範圍從新的 `blocks` 重新推導（推導不出來就照舊歸零，所以「指著已經
  detach 的節點」這個更早的缺陷仍然結構上不可能）。
- **原始碼編輯框提交成功後不會消失。** 如果一次提交的效果是在該區塊**後面**多長出一個
  區塊（在 fence 後補一行、在段落下補一段），那個區塊自己的 `part` 一個字都沒變，patch
  就把它留在原地，於是 textarea 蓋在已經重繪好的內容上一直不走，而且點不掉。現在提交
  成功後會把區塊的內容還原回去。
- **沒有選取內容時，行內格式鈕維持可點但沒有作用對象。** 工具列 inline 組的五顆按鈕
  （粗體／斜體／刪除線／行內程式碼／連結）現在會在游標沒有任何選取範圍、或選取範圍
  跨出了目前這個編輯面之外時變灰，按下去才不會是一個看起來能點、實際上什麼都不會
  發生的按鈕——那兩個條件正是這幾顆按鈕背後的動作自己會拒絕的條件。

### Known issues

- **§3 雙向同步仍未做。** 外部程式改了 markdown 檔案，開著的編輯器分頁不會反映那次
  改動——這是規格 §3 的題目，本版還沒動它。上面新增的存檔狀態槽位只是先把介面位置
  留好。
- **`export▾` 仍然缺。** 工具列還是 22 顆按鈕，不是 23 顆；缺的不是按鈕本身，是瀏覽器
  裡一條可達的匯出路由可以接（同 v3.1.0 那條 Known issue，本版沒有新增可達的匯出目標，
  所以按鈕仍未加回）。
- **每一個結構性的清單手勢都會整份重繪。** 這是目前最大的一類 fallback，而且不罕見：
  在清單項目裡按 Enter（`splitListItemAtCaret`）、用 Backspace 把項目併回上一項或整批
  刪除項目（`removeListItem`）、用 ＋ 新增一個項目（`insertListItemAfter`）、用 ⠿ 對
  一個 `li` 做「建立副本」（`duplicateListItem`）或上下搬移（`moveListItem`）——全部走
  fallback 全量重繪。原因是這些手勢在送出 render **之前**就先動了 `.content` 的子節點
  列表（插入一個還沒有 `data-block-id` 的暫時 li、插入帶著重複 id 的 clone、或就地改變
  順序／刪掉節點），所以 render 回來時 `domMatchesLastRender()` 對不上，patch 依約定
  退回全量重繪。在清單裡按 Enter 大概是這個編輯器最常見的結構性手勢，而它一次都沒有
  走過增量路徑。這是刻意的：那道守衛擋掉的正是 patch 會算錯位置的情況，所以退回的
  是 v3.2.0 之前本來就有的行為，不是退化。
- **第一次提交仍然整份重繪。** bootstrap payload（頁面第一次載入時內嵌的初始狀態）不帶
  `parts`，所以任何分頁在重新整理／開新分頁之後的第一次提交，一定走 fallback 全量重繪，
  第二次之後的提交才會走增量 patch。這是刻意的取捨：把 `parts` 也塞進 bootstrap payload
  能省下的只有那一次重繪，換到的代價卻是**每一次頁面載入**的 HTML 重量翻倍——不划算。

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

### Changed

- **編輯器伺服器只回應 loopback 的 `Host`。** 只接受 `127.0.0.1`、`localhost` 或
  `[::1]`，而且必須是它當下實際監聽的那個埠；其餘一律 403，包含沒有帶 `Host` 的請求。
  這擋的是指向新的資產寫入端點的 DNS rebinding。**若你是透過 hosts 檔的別名或容器
  主機名連進編輯器，現在會拿到 403 而不是頁面。**

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
