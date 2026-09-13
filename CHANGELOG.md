# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v3.4.0 — 未發布（批次 1＋2＋3／3）

**這一版還沒發，而下面列的是它的全部三批。** v3.4.0 的設計刻意把工作切成三批，
任何一批做完停下來都是一個完整可發的狀態：批次 1 是「使用者回報的新缺陷 ＋ 儲存按鈕
＋ v3.3.0 留下的 13 項 backlog」，批次 2 是 drawio 內嵌檢視，批次 3 是 wavedrom 的
GUI 波形編輯。**三批都寫完了。**

批次 1 是 13 個 task、40 顆 commit（口徑排除 `a499e30`，那是中途機器送修時為了讓進行中
的 SDD 狀態跨機器存活而補的一顆 bookkeeping commit，記的是 spec／plan／進度檔，不是任何
一個 task 的產出，見它自己的 commit message）。**批次 1 的段落寫完之後又多了三顆**：
`b6d0f81`——最終複查抓到的一個真缺陷，下面那條「窄視窗開側欄時，背後的頁面不能再捲了」
只修好了 `.sidebar-toggle` 那條路，而 `.sidebar-toggle` 在編輯模式是 `display:none`；
編輯模式唯一走得到的入口是工具列的 ☰，它走另一支函式，當時只設 `document.body` 而沒有
鏡射到 `documentElement`，於是原本那個症狀在編輯模式一直沒被修到（今天兩處都鏡射了）；
`9a6fe03`——三句被程式碼否證的敘述，其中一句的結果就是下面 Known issues 裡 `.ed-seltb`
那一條；`3fbb269`——把送修期間暫時納入版控的 SDD 工作狀態重新移出版控，跟 `a499e30`
一樣是 bookkeeping，同樣不計。

批次 2 是 6 個 task、10 顆 commit（`c63f7f6`..`6360f19`，不含這一顆 CHANGELOG 本身），
沒有任何一顆被排除。其中 5 顆屬於同一個 task——被引用的 `.drawio` 在磁碟上被改動後重烤
——第一顆是機制本身，後四顆是四輪複查的修正；最後那一顆（`6360f19`）**一個運算式都沒改**，
因為那一輪抓到的三件事全部是「註解或報告寫的話與程式碼不符」。

批次 3 是 8 個 task、34 顆 commit（`8cd2ab6`..`20e078b`，不含這一顆 CHANGELOG 本身），
沒有任何一顆被排除。**形狀值得說出來：8 顆 `feat`、22 顆 `fix`、2 顆 `test`、2 顆
`docs`**——每一顆功能後面平均跟著 2.75 輪複查修正，而其中兩顆 `docs` 一個運算式都
沒改，跟批次 2 最後那一顆同樣是「敘述與程式碼不符」的更正。

批次 1 的方法跟 v3.3.0 一樣不是重讀 diff，而是把每一條 backlog 重新驅動出來再修。過程中有
**兩條 backlog 條目的形狀描述被證明是錯的**——一條連症狀本體都寫錯（記的是「會產生
`\*` 跳脫」，實際上沒有任何路徑會吐出反斜線），一條被誤分類成「這一版讓它更容易踩
到的缺陷」而其實今天用真實手勢到不了。另外有**四個從來沒有人知道的既存缺陷是修別的
東西時被量出來的**：拖曳列之後接下來每一個按鍵會寫進錯的儲存格、`stripHtmlTags()`
會把 HTML 註解裡的字滲進永久連結、段落的合成 `raw` 讓它之後每一個 block 的行號位移
一行、以及一條「編輯模式下側欄僅剩的入口」的斷言其實一直靠 5px 的餘裕在過。每一條的
實測數字都寫在它自己那一段裡。

### Breaking

- **heading 的錨點（slug）變了，外部指向舊錨點的連結會斷。** `## Alpha & Beta` 的
  錨點從 `#alpha-amp-beta` 變成 `#alpha-beta`，`## C < D > E` 從 `#c-lt-d-gt-e`
  變成 `#c-d-e`。根因是 `marked` 的 lexer 對同一個 heading 給出兩種跳脫狀態——
  `heading.text` 是原始字串，走 inline token 的那條路拿到的是已跳脫的
  （`"Alpha &amp; Beta "`）——而 `renderer.heading` 寫的是
  `stripHtmlTags(flattenTokenText(token.tokens) || token.text || '')`，**同一個 `||`
  的兩邊跳脫狀態不一致**。三個下游同時吃到已跳脫的字串：`slugifyHeading()` 把實體
  名稱 `amp` / `lt` / `gt` 當成單字併進錨點，`renderTocNodes()` 的 `escapeHtml()`
  跳第二次（目錄上看到的是字面的 `&amp;`），section index 也跟著錯。
  **舊錨點是缺陷的產物，不是設計。** 留著它等於把 bug 當契約——每一份新產出的文件都
  會繼續帶著 `amp` / `lt` / `gt` 這種沒有人會手打的錨點，而且目錄上的雙重跳脫是使用者
  直接看得到的錯字。所以這一版改掉，並在這裡明講會斷什麼。
  修法連帶暴露了一個**既存、無聲、沒有任何測試會抓到的缺陷**：`flattenTokenText()`
  改回傳未跳脫文字之後，`stripHtmlTags()` 原本的 `/<[^>]*>/g` 會把字面上的 `< D >`
  當成標籤整段吃掉（`#c-d-e` 實際會變成 `#c-e`）。收緊成
  `/<\/?[a-zA-Z][^<>]*>/g` 之後又冒出第二個：`## Section <!-- note --> Title` 的
  錨點從 `#section-title` 變成 `#section-note-title`——**HTML 註解裡的字滲進永久連結，
  不報錯，也不會讓任何既有測試變紅**。最後補了 `<!--[\s\S]*?-->` 分支，
  `stripHtmlTags()` 的三個呼叫點一起受益。原本想把剝除搬進 `flattenTokenText()` 的
  `html` 分支（結構上更乾淨），量過之後放棄：`collectCellText()` 的 `cell.text` 與
  `renderer.heading` 的 `token.text` 是兩條**不經 token 化**的後備支，搬進去等於讓
  那兩條路完全不跑剝除。`<!DOCTYPE` 與 `<?` 仍未涵蓋，已寫進程式碼註解。

### Added

- **工具列有儲存按鈕了（`💾`，最左邊的新 `file` 群組）。** 先前存檔只有 `Ctrl+S`
  一條路，髒狀態只表現在分頁標題的 ●。**按鈕本身就是儲存狀態指示器**：乾淨時
  disabled 並視覺淡化，髒的時候亮起——而它讀的是 `client.js` 既有的那一個
  `dirtyDepth !== 0 || burstHasUncommittedEdit()`，與標題 ● 同源，沒有另造一套真相
  （這次順手把它抽成 `documentIsDirty()`，讓 `setDirty()` 與工具列共用）。點擊走的
  是同一支 `save()`，一行邏輯都沒複製。**不自動存檔這一點沒有改。**
  它也是 `Alt+F10` 鍵盤游標走得到的按鈕，而且**按完之後 caret 會回到按之前的位置**
  ——這一條是刻意不沿用 `undo` / `redo` 的既有做法，因為那條路自己就有同一個缺陷
  （見下方「quote／code／line」那一條）。第一版的救援只涵蓋 collapsed 的 caret
  （`if (!sel.isCollapsed) return null`），實測「打字（未 commit）→ `Shift+←`×3 →
  點儲存」之後 `activeElement` 是 BODY、**接下來打的字完全沒有進去**；改成讀
  `sel.focusNode` / `focusOffset` 之後 collapsed 路徑自動涵蓋，整個 guard 拿掉而不是
  加分支。
  加這一顆按鈕的**真實後果比預期寬**，兩件都只有端到端的網看得到：工具列名冊常數
  22→23 散在四個測試檔裡（其中一處不是字面的 22，而是 `editor-journey.test.js` 的
  `TB_ROWS` 完整性斷言）；以及它成為 `BUTTON_DEFS` 裡**第一顆「有條件啟用」的按鈕**，
  於是每一個髒文件的 `Alt+F10` 跳躍次數與 enabled 計數都位移一格（五處）。後者的處理
  不是把計數 15 改成 16，而是**把 `save` 從那些哨兵的計數裡排除**，讓 `enabled` 回到
  「與 save 存不存在、與髒不髒都無關」的原始語意——`save` 自己會不會隨髒度正確點亮，
  另外有專屬場景把關。

### Fixed

- **拖曳表格的列或欄，畫面會跳到表頭——而且那只是四個缺陷裡最看得見的一個。**
  使用者回報的是「拖完跳到表頭」，查下去底下疊了四件事。
  第一，**同一顆儲存格被 `focus()` 了兩次**：`ensureTableBurstOpen()` 自己會對
  `cells[0]`（也就是表頭那一格）對焦一次，`restoreTableFocus()` 接著又對焦一次、
  而且不帶 `preventScroll`。外部探針量到的順序是
  `focus({preventScroll:true})` → `focus()` → `scroll-event`，`scrollY` 從 2754
  掉到 1517。兩次都要處理：拖曳路徑改挑**第一個 body 儲存格**而不是表頭那一格，
  第二次補上 `preventScroll`。`ensureTableBurstOpen()` 的政策**不能改**——它的 7 個
  呼叫端裡有 5 個非拖曳的依賴那次對焦（`insertColumn()` / `insertRow()` 自己完全不
  設焦點，而且 `currentBurst` 唯一的產生路徑就是那次 focus → `focusin` →
  `startTableBurst()`，拿掉等於整個操作不會發生），所以加的是拖曳專屬的參數。
  第二，**擋在中間的那道 `if (activeIndex >= 0)` 是恆真的死碼**。`activeCellEl` 在
  建立 `currentBurst` 的同一個賦值式裡就一定被設好，而 `ensureTableBurstOpen()` 只在
  burst 確實屬於這個表格時才回非 null——`activeIndex` 在那兩個呼叫點結構上永遠 `>= 0`。
  留著一段看起來在防什麼、實際永遠成立的判斷比沒有更糟，已換成記錄「為何恆真、這條路
  行不通別再試、真正的來源是哪次 focus」的註解。
  第三，**一個既存的資料正確性缺陷**：`performRowDrop()` / `performColDrop()` 的
  `activeIndex` 在 `rebuildTableSections()` **之前**用序位算出來，卻在重排**之後**才
  拿去找格子。編輯某一格、拖一列、放開，焦點就落到另一格，**接下來每一個按鍵都寫進錯
  的儲存格，而畫面看起來一切正常**。它一直沒被抓到，是因為那個場景從來沒跑到過——
  這支測試檔沒有 per-scenario try/catch，前面的場景每次先倒就結束了。修法先量了
  `rebuildTableSections()` 到底是搬還是重建：`<tr>` 只是 `appendChild()` 搬動、從不
  重建；`<td>`/`<th>` 同 tag 時 `retagCell()` 直接回傳原物件，**但跨表頭／本文邊界時
  會重建**——所以列那條要用「列＋欄」座標重新定位，欄那條只要把序位計算搬到重排之後。
  （量的時候用的是 JS expando 屬性而不是 HTML attribute，因為 `retagCell()` 會複製
  attribute，用 attribute 根本測不出「是不是同一顆物件」。）
  第四，`restoreTableFocus()` 的 `cellIndex < 0` fallback 現在真的打得到了，而它落在
  `cells[0]`＝表頭，在拖曳路徑上是錯的落點；改成優先挑 body 第一格。
- **一個表格手勢會落到隔壁那張表上。** v3.3.0 對這條路試過兩次證偽、兩次都失敗，
  所以它一直掛在「未裁定的調查」。這一版驅動出來了，而且證明了為什麼前兩次會失敗：
  先前走的是**泡泡點擊**，提交在 `mousedown` 就被 focusout 觸發，click 跑到時 render
  已經落地、泡泡已經清掉，復原分支根本沒機會被走到。打得開那扇門的是 **grip 拖曳**
  ——grip 的 `pointerdown` 有 `preventDefault()`，髒的 textarea 不失焦、不提早提交，
  而 `tePointer.hit.tableEl` 是 pointerdown 抓的硬參照、`hideTableGrips()` 不清它。
  三個形狀實測 `detached: true`。
  復原時用來認表的錨點只有 `startLine` 一個數字，行號一變就認到別張表。23 萬份亂數
  掃描量到的「改到別張表」件數是這一條最重要的數據，因為它同時否決了一個看起來很自然
  的半套修法——`startLine` 單獨（修前）**302 件**；只改成複合錨點而 identity 不動
  **1,275 件，四倍糟**；複合錨點 ＋ 強 identity 12 件；出貨版（三段齊全）**0 件**。
  三段是複合錨點、`tableIdentityOf()` 改成雜湊每一列每一格、以及「identity 相同的表
  不只一張時一律拒絕猜」。ablation 跑出來的歸因跟直覺不同：**安全性由最後那道唯一性
  閘門一段獨力承擔**（拿掉它 12 件，拿掉另外兩段各自都還是 0 件），另兩段貢獻的是完成
  率（+64,655 / +31,126 次能正常完成的手勢）。第三段關掉的那條路 v3.3.0 本來是綠的，
  **是第一版修法自己帶進來的危害**，一併關掉。
- **兩個相鄰的同 tag 行內標記會互相吞掉，第一個標記整個從你的檔案裡消失。**
  backlog 記的是「會產生 `\*` 跳脫」——查下去**沒有任何路徑會吐出反斜線**，那句
  `\*` 是寫筆記的人為了在散文裡顯示星號而做的 markdown 轉義，不是對輸出位元組的主張。
  真正的缺陷是 `<em>a</em><em>b</em>` 序列化成 `*a**b*`，兩個 `*` 黏成一個 CommonMark
  delimiter run，`marked` 重新解析時**第一個標記整個不見**。100 個上下文的暴力掃描：
  **同 tag 相鄰 50/50 全壞、跨 tag 相鄰 50/50 全正常**。修法是在邊界插一個看不見的
  `<!-- -->`，實際插入率 75/12516 個標記＝**0.60%**，4 輪往返固定不動點、不累積、
  不汙染 slug。
  第一版守衛**只看輸出字串的星號，於是把跨 tag 的情況也一起插了**——過度插入率估 1.3%，
  而那 1.3% 不是理論值，它就在 journey 的既有場景裡（`*it****al* bold**` 被改成
  `*it*<!-- -->***al* bold**`）。那條期望值是正確且驗證過的形狀，所以修的是守衛不是
  測試：改成追蹤 `lastMarkTag`（每一層記住最近收尾的是 EM 還是 STRONG），**只在即將
  開的 tag 等於剛收尾的 tag 時才插**。副作用是好的——文字節點非空時一律重設，於是原本
  為了防「字面星號接斜體」假觸發而加的 regex 整支可以移除（`escapeText()` 本來就不會
  留下活的尾端星號，那條 regex 一直是多餘的）。
- **一個段落只要帶著過縮排的 lazy continuation、後面又緊接 `---`，它之後每一個 block
  的行號就全部位移一行。** `startLine` 是每一次 gutter 動作與每一次 commit 的位址，
  位移一行是**會寫錯行**的等級，不是純視覺。根因在 `buildBlockMap()` 頂層迴圈的
  `cursor += rawNewlines`：marked 14.1.4 把 `"a\n    b\n"` 這種段落的 `raw` 合成成
  `"a\n\n    b\n"`（3 個換行、2 行原始碼），頂層無條件信任它。**這個檔案自己的註解
  早就寫過這個危害，但只防了 item 內的 `text` token，頂層那一圈沒有對應的防線。**
  修法只對頂層的 `'paragraph'` token 改用 `t.text` 的換行數；試過把 `'heading'` 也
  納入，量到 ATX heading 合法摺入尾隨空行、`.text` 還原不回來，所以排除。
  這一條先前被判成「已不復現」，翻案靠的是方法而不是運氣：定向的手工良構 fixture
  各跑 5 萬份是 0 違反（所以「我的 fixture 集合裡沒有」不等於「不存在」），改成
  **6 萬份亂數行湯 ＋ 三條明寫的 oracle**（startLine／endLine 不落空行、blocks 不重疊
  遞增、li 落在 marker 行）之後：**修前 125 份違反、修後 0 份**，132 份新舊輸出有差異。
- **在 raw 編輯器裡打的字，按 Escape 就沒了，`Ctrl+Z` 也救不回來。** Escape 的語意
  仍然是丟棄，改掉的是「丟掉的東西要停放得回來」。修法不能沿用 burst 那一套：
  `openRawEditor()` 開起來時會把自己的 DOM 拆掉，**以節點為鍵的停放撐不過去**，所以
  新的 `discardedRawEdit` 是 `discardedBurst` 的**以值為鍵**的雙生體，停放
  `{blockId, range, startLine, endLine, source, value, caret}`，`undo()` 先試
  `restoreDiscardedRawEdit()` 再落回一般 undo。失效規則沿用 `discardedBurst` 的同一組
  呼叫點，另加一條新的：**兩個停放互斥**——若不互斥，舊 burst 的 staleness guard 在
  期間沒有 render 時會通過，`undo()` 會真的答錯更舊的那一份。
  **這一條對 rangeMode（單一 li、多區塊）結構性失效，見下方 Known issues。**
- **對一個已被吞噬的 code block 重開 raw 編輯器去補 fence，會把尾巴在磁碟上複製一份。**
  跟 F10（吞噬本身）不同根因——這是從吞噬狀態復原時自己的路。根因是這一批第二次撞到
  的同一族：**同步 `focusout` 在 DOM detach 時重入**。`applyFullRender()` 在 DOM swap
  **之前**就無條件清掉 `activeEditor`（旁邊就有一段 v3.2.1 的註解在描述這個危害），
  但 `applyPatch()` 只在 `removeChild()` **之後**才清；raw-edit commit 生出新 block
  時，編輯器自己的 block 落在 `replaceSpan` 內 ⇒ `removeChild()` 同步觸發 focusout ⇒
  重入 `commit()` ⇒ 用還沒縮過的 textarea 內容蓋掉該 block 的新範圍。實測：修前一次
  `Ctrl+Enter` 打出 3 次 `/api/render`，修後 2 次，多的那一次只能來自同步重入。
  修法**刻意保留**「編輯器在 `replaceSpan` 之外時存活」的既有行為，那是設計不是漏網。
  **要重現它必須同一個 session 裡先有一次成功提交**（才會走 patch 路徑而不是全量重繪），
  在全新開啟的文件上不會發生——這個前提已經寫進程式碼註解與測試註解，因為不寫的話
  下一個照 backlog 敘述試的人會失敗，然後誤判成「已經好了」。
- **對純空白的選取按 🔗，會把那段空白包進 `<a>` 裡。** 粗體／斜體那條路在包起來之前
  有一個「整段都是空白就不要動」的守衛，新建連結那條路沒有。修前實測：在
  `Alpha bold text here.` 裡選 `Alpha` 後面那一個空白、按 🔗、網址填 `https://probe/`，
  段落變成 `Alpha<a href="https://probe/"> </a>bold text here.`。守衛加在
  `prompt()` **之前**（不會先問一個註定要丟掉的網址），回 `false` 符合呼叫端文件化的
  「returns TRUE iff this call actually reached a `window.prompt()`」契約——回 `true`
  會讓呼叫端誤以為開了 modal、去等一個永遠不會來的 `blurred` promise。混合選取
  （`" bold "`）是驗過不是假設的：`trimRangeToText()` 原地修剪傳進去的 range，守衛
  之後緊接的 `extractRangeInto()` 用的正是同一個已修剪的 range，所以只有 `bold` 會被
  包進去、空白留在外面。
- **列／欄插入泡泡的座標過期時，現在是把手勢丟掉並升起 banner，不是猜一個位置。**
  原本的 fallback 是 `tbody.insertBefore(newRow, tbody.firstChild)`——定位失敗就
  **靜默把列插到最上面**；欄那條更糟，`row.cells[colIndex]` 回 `undefined` 之後
  `insertBefore(cell, ref ? ref.nextSibling : null)` 會**靜默把新欄插到最後一欄**，
  而且連守衛都沒有。**這條路今天用真實手勢到不了**（理由與那個分類的更正見下方
  Known issues），修法保留的理由與可達性無關：那個失敗模式本身就是錯的。列與欄兩條
  一起修——不對稱本身就是危害，未來讀的人看到「列有守衛、欄沒有」會合理推論欄是刻意
  豁免，而那個推論是錯的、也沒有東西會糾正他。
- **`quote` / `code` / `line` 按完把 caret 留在 BODY，鍵盤使用者出不來；surface 上有
  未 commit 的編輯時 `undo` / `redo` / `image` 也一樣。** 這一條的答案是分裂的，而且
  是量出來的：`undo` / `redo` / `image` 真的可以共用儲存按鈕那一對 caret
  capture/restore（同樣的失敗形狀、同樣類型的目標 block）；`quote` / `code` / `line`
  **不行**——`armEditables()` 從來不 arm quote／code／hr，那些 block 根本沒有
  contenteditable 表面，caret walker 走進去什麼都找不到。它們真正的修法是開該 block
  自己的 `openRawEditor()`，也就是「剛插入的 code block」已經在用的同一套。
  `line`（hr）那個缺口還不在原本假設的那條路上：不是 `focusInsertedBlock()` 的分支，
  而是 `insertBlockBelow()` 自己的 `kind === 'line'` 分支——那裡有一段前一個 task
  誠實寫下的「不在範圍內」註解，是一條死碼路徑。
  修法的作用域收窄過一次：原本放在四個手勢家族共用的 `restoreAfterStructuralOp()`，
  實測 duplicate／delete 也跟著從 BODY 變成 raw 編輯器——**在破壞性手勢之後自動彈出
  raw editor 會踩到「Escape 丟掉未 commit 編輯」那個當時還沒修的缺口**，所以改成只開給
  `convertBlockViaMenu()`。
- **`H▾` 下拉的六個項目現在鍵盤操作得到。** 順帶修掉一個很諷刺的東西：做出來的鍵盤
  游標標記 `data-ed-tb-menu-cursor` **沒有任何 CSS**，也就是那個游標看不見——正是下面
  那一條「沒有可見信號」的缺陷本身。現在它命中
  `outline: 2px solid rgb(110,168,254)`，對照手足按鈕是 `3px none`。
- **側欄抽屜有鍵盤入口了。** 先前這版只給了「打開」抽屜的路，沒有給「進到抽屜裡面」
  的路。**這一條與下一條互相踩過一次**：把焦點送進搜尋框卻沒關掉工具列的 keynav，
  工具列會繼續吃方向鍵——而 `Home` / `End` 正是下一條這次新吃的鍵。修前那個狀態幾乎
  不可能出現（點工具列外任何東西都會 `exitToolbarKeynav()`），這一條讓它變成常態：
  使用者得打一個字才能脫身，而那個字又會升起下一條新加的 banner。改成按參考排除
  `sourceTextarea` 而不是排除所有 focused `TEXTAREA`——後者會打壞「source textarea
  持有焦點時用方向鍵走 outline↔preview」這條合法路徑。
- **工具列的鍵盤游標不再被一般按鍵靜靜地丟掉。** 修前實測 `ArrowUp` / `ArrowDown` /
  `Tab` / `Home` / `End` / `a` / `Backspace` 七顆，按下去游標外框與 keynav 標記同時
  消失、沒有任何訊息。`Alt+F10` 在畫面上造成的唯一差別就是那個外框，所以它一消失，
  工具列看起來就跟按 `Alt+F10` 之前一模一樣。修法刻意做成兩半：`Home` / `End` 改成
  真的在工具列上導航（有用，不只是無害），**其餘迷走按鍵仍然交還控制權但升起可見的
  banner**。理由是「列舉每一顆無處可去的按鍵」無法被審計完整性——只做前者，永遠不知道
  有沒有漏掉第八顆；加信號則對所有沒列舉到的按鍵都成立。`Tab` 與 `Escape` 例外：
  `Tab` 是 ARIA toolbar pattern 規定的離開手勢，**為一個合法動作升紅色橫幅是錯的方向**，
  兩者都改成安靜退出，banner 自己也接 Escape 關閉。
- **任何 banner 升起時，整條工具列都按不到。** 修前實測兩條獨立的觸發路徑，都是
  **23/23 顆按鈕的 `elementFromPoint` 全部回 banner**；而且缺陷範圍比 backlog 寫的寬
  ——`showBanner()` 是唯一的產生點，所以 conflict / render-failed / save-failed /
  dropped-gesture / structural-refusal / swallow / keynav-exit **全部家族同時成立**。
  修法**沒有動 z-index**，而是把 banner 從 `top: 0` 移到 `top: var(--ed-toolbar-h)`
  ——沿用 `.ed-te-menu` / `.ed-seltb` 已經在用的同一個地板值。移下來之後會蓋住共用同一個
  地板的四個動態浮層，所以 `showBanner()` 開頭把那四個收起來；**那四行是用 ablation
  證明載重的**（暫時拿掉之後 H▾ 選單真的被蓋住）。
  這個缺陷從頭到尾是滑鼠問題：工具列按鈕是 `tabindex="-1"`、本來就不走 Tab（只走
  `Alt+F10`）。**但 banner 自己的 ✕ 鍵盤也走不到**，那是另一條既有規則造成的，見下方
  Known issues。
- **站在 ＋ 泡泡上不再讓 ⠿ grip 消失。** `updateTableEdgeGrips()` 的守衛沒有列入
  `.ed-tb-insert`。代價是純視覺的——而且比原本估計的更弱：`.ed-handle` 的宣告自陳
  「Only ever a visibility toggle (opacity), never display or pointer-events」，
  也就是連可點擊性都沒有少。
- **窄視窗開側欄時，背後的頁面不能再捲了。** 先前是「缺一個鎖」而不是「鎖被打敗」。
  第一版把兩條鎖規則放在 base scope，但抽屜只存在於 `@media (max-width:1080px)`，
  而且沒有任何 resize handler 會清掉 `data-sidebar-open`——窄視窗開抽屜、拉寬，
  桌面版就會同時得到既有的全視窗灰 scrim 與**這次新加的整頁不能捲**。
  （同一份檔案裡已經有一段量測過的警語在講這件事，講的正是同一個屬性。）改成把規則
  搬進 `@media (max-width:1080px)`，而不是加 resize handler——精準對症、不碰 JS，
  而且**不會順手把那個既有、範圍外的灰 scrim 缺陷一起修掉**（它該獨立立項）。
- **工具列加到 23 顆之後 ☰ 在 800px 寬的視窗裡按不到了——而 22 顆時它只剩 5px 的餘裕。**
  儲存按鈕加在最左邊，把最右邊的 `outline`（☰）擠出可視範圍。量到的是：800×900 下
  `scrollWidth` 1026、溢出 226px、☰ 中心 (846, 22)、`elementFromPoint()` 回
  **`null`** ⇒ 是溢出問題不是遮蔽問題（那兩種的修法完全不同）。
  **這一條真正的發現在對照組**：把儲存按鈕拿掉跑 22 顆，溢出 175px、☰ 中心 (795, 22)
  ——**只卡在視窗內側 5px**。也就是說「編輯模式下 ☰ 是側欄僅剩的入口、必須不捲動就點
  得到」這條斷言，一直是靠 5px 的安全邊際在過，沒有人知道。**儲存按鈕沒有製造脆弱，
  它只是把一個本來就在的脆弱推倒。** 修法是 `.ed-toolbar` 的 flex `gap` 6px → 3px，
  ☰ 中心回到 (765, 22)、命中自己，安全邊際 **35px**。更根治的做法（把 `view` 群組
  釘在右側不隨捲動離開）記進了 backlog。

### Known issues

這一批的驗證基礎是 40 個測試檔（新增 `test/table-anchor-recovery.test.js`），其中兩套
是長跑的 puppeteer 套件。最後一次全綠：`editor-client-runtime.test.js` **366 OK**、
`editor-journey.test.js` **126 OK**，AssertionError 0。這一批往 runtime 那支加了 1,038
行、journey 那支 1,031 行，上面每一條缺陷幾乎都是靠這兩支釘住的。

下面同樣分成**兩類，而且差別是有意義的**——延後的缺陷有人會去修、修完就不見了；
刻意接受的邊界不是缺陷，將來也還會在那裡。

**裁定延後到 v3.4.x 的缺陷。** 會把資料弄髒的（優先）：

- **`lib/editor/paste-md.js` 的貼上路徑走 turndown，帶著與「相鄰同 tag 標記互吞」
  完全相同的根因，而且是活的。** 實測 `<p><em><code>code</code></em><em>text</em></p>`
  貼進來序列化成 `` "_`code`__text_" ``，第一個 `<em>` 同樣消失。（`list-md.js` 與
  `table-md.js` 查過沒有這個洞——一個 item／一個 cell 一次 `serializeInline`，累積字串
  橫跨全部 sibling，守衛在那裡是有效的。）
- **`inline-md.js` 的守衛對透明 SPAN 穿透漏檢**（`<em>a</em><span><em>b</em></span>`）。
  既有缺口，不是這一批造成的——用修改前的版本跑同一個形狀，兩版輸出逐位元組相同。
- **`discardedRawEdit` 對 rangeMode（單一 li、多區塊）結構性失效。**
  `cancelAndMaybeDiscard()` 先建 stash、接著 `await restore()`，而 rangeMode 分支走
  `safeRerenderAll()` → `rerenderAll()` → **`dropDiscardedRawEdit()`** ⇒ stash 建立後
  兩行就被自己的 Escape 路徑清掉；多區塊另有獨立的阻擋（guard 拿第一個 block 的 id 去
  比整段 span，必然不等）。也就是說那個 stash 分支對每一個 rangeMode session 都是死碼。
  **非 regression**（修之前那些面一樣全丟），但危害在誤導：下一個人很可能在 li 上試一次、
  發現沒回來、誤判整個機制壞掉。
- **`Ctrl+S` 自己有一模一樣的 caret 缺口**（`switchAwayFrom().then(save)` 的 commit
  重繪造成），而它才是鍵盤使用者的主要存檔路徑。修法已知——把儲存按鈕那一對
  capture/restore 套上去就是了；這一批沒做，是因為 `test/editor-client.test.js` 有一條
  regex 逐字釘住那段原始碼，改它超出當時 task 的範圍。

可達性／鍵盤：

- **鍵盤沒有任何非滑鼠的手段關掉 conflict / save-failed banner。** 實測從普通段落打字
  → Enter → 升起 banner → **連按 60 次 Tab，焦點一次都沒離開那個段落**。根因是一條
  既有的通用 Tab 攔截規則（v2.11.1 acceptance, escape class A）：
  `if ((inBlock && !control) || nothingFocused) { e.preventDefault(); return; }`。
  沒有一起修是因為修它牽涉 a11y 設計決策（banner 出現時要不要搶焦點？要不要專屬快捷
  鍵？），不該在一個 task 的尾巴倉促決定。這一批已經修掉比較嚴重的那一半——banner
  不再遮住工具列，鍵盤使用者可以繼續工作，banner 只是留在畫面上。
- **逃生路的回程仍然不還原 caret。** `Alt+F10 → preview → Enter` 進 source textarea
  之後回來，caret 不回原位。source textarea 的 caret 是**原始字元偏移**，而儲存按鈕
  那套用的是 block-id + text-offset ——**不是同一個座標系**，需要自己的對映與測試。
  理由已寫進 `activateToolbarCursor()` 的註解。
- **側欄抽屜只補了入口沒補出口**：抽屜裡按 `Escape` 沒有作用，caret 也不回文件。
- **工具列的鍵盤游標在 `H▾` 選完一個項目之後會無聲漂移。**
- `redo` 與 quote／code／line 在有髒 burst 時的行為今天是對的，**但沒有 journey 列
  釘住它**。

程式碼形狀（不影響使用者，但會影響下一個修這裡的人）：

- **工具列的 `view` 群組沒有釘在右側不隨捲動離開。** 這比上面那個 gap 6px→3px 更根治
  ——gap 那一版是在不能跑長套件的情況下選的、風險小且已實測的做法。
- **`restoreTableFocus()` 的 API 仍然收序位而不是 cell 物件。** 收物件更貼合這一批修正
  的意圖，但那是 API 改形，範圍比當時那個 task 大。
- **「同 tag 合併」（`<em>a</em><em>b</em>` → `*ab*`）這個零位元組的替代方案沒有採用。**
  現在的守衛插一個看不見的 `<!-- -->`，實測插入率 0.60%；合併法完全不留位元組，但它
  要在 **DOM 上前瞻**，遇到 `<em>a</em><span></span><em>b</em>` 就得重新實作整套透明
  節點規則——守衛現在是對**輸出字串**判斷的。

**已知且刻意接受的邊界**（不是缺陷，將來也還會在，但要讓使用者知道）：

- **列／欄插入泡泡的座標過期之後，今天用真實手勢到不了。** v3.3.0 把這一條列成「這版
  修好泡泡的可達性、把那個資料缺陷的曝光面放大了」——**那個分類是錯的**。泡泡的
  可見性由兩層獨立機制守住：proximity-hide（每次 `mousemove` 重算，沒有例外分支）與
  `applyFullRender()` 裡無條件執行的 `hideTableInsertBubbles()`（前面沒有任何 `if`）。
  唯一能讓過期的值撐到點擊落下的方式，是「造成過期的事件」與「點擊本身」是同一個事件。
  四條真實手勢全部失敗且各有機制解釋（其中「外部推送」那條是用讀碼排除的：這個編輯器
  沒有任何 push／live-reload，唯一相關的衝突處理是 `location.reload()`，整頁重載、
  JS 狀態歸零，邏輯上不可能製造那個前提）。而那兩層守護分別是 `863a894`（2026-08-29）
  與 `b38bc51`（2026-08-26），**都早於 v3.3.0**——當時的量測沒有涵蓋「泡泡可見性」
  這個維度。守衛還是加了（理由見上方 Fixed），但它釘住的是**防禦分支**，測試要靠注入
  dataset 才走得到。**哪天有人能用真實手勢走到那條路，代表那兩層守護破了。**
- **`handleTableCellFocusIn()` 是「表格手勢落到隔壁那張表」的姊妹路徑，帶著同一個洞而且
  沒有唯一性閘門**——雙胞胎那一格會把 caret 放進別張表的同座標格。**沒有驅動出重現**，
  按這個 repo 的標準不算已證實的缺陷，所以列在這裡而不是上面。
- **`.ed-seltb`（選取浮動工具列）在特定捲動位置會被 conflict/save-failed banner 蓋住
  它的全部 6 顆按鈕。** backlog #8 把 `.ed-conflict` 移到 `top: var(--ed-toolbar-h)`
  之後，實測掃 66 個捲動落點，**17 個落點上 `.ed-seltb` 的 top 落在那條帶子內（最低
  14.75px）**——修前 `top: 0` 在同樣落點是 0 顆被蓋住，所以這是修法帶來的幾何殘留，
  不是既有缺陷。根因是 `.ed-seltb` 的真正下限是 `positionSelToolbar()` 裡的
  `margin = 4` 這個本地常數，跟 `--ed-toolbar-h` 無關（見 `lib/md2doc.js`
  `.ed-conflict` 規則旁的 Final-review I1 修正註解），而 `showBanner()` 關掉的四個
  動態浮層（`.ed-te-grip` / `.ed-tb-insert` / `.ed-te-menu` / `.ed-toolbar-menu`）
  不含 `.ed-seltb`。**兩次嘗試都沒能驅動出「真 banner 與活著的 .ed-seltb 同框」**：
  burst 內的粗體切換不打 `/api/render`（不會觸發 conflict/save-failed banner），
  `Ctrl+S` 的 `switchAwayFrom()` 會先拆掉 seltb 才進 save。按這個 repo 的標準，未證實
  的活缺陷不改行為，所以列在這裡而不是上面。
- **工具列的 flex gap 現在是 3px。** 桌面滑鼠場景沒問題（整個 v3.3.0 的手勢本來就建立
  在 hover 上），觸控裝置上會偏擠。用 35px vs 5px 的安全邊際換的。
- **v3.3.0 那六項原封不動**：F10 吞噬偵測的兩個沉默缺口、trim-to-EOF 那個逐位元組無法
  分辨的內在誤判、`unlocatable` 降級路徑在真實語料上量不到、按下的起點落在既有選取
  範圍內時 Chromium 走的是拖曳文字手勢、點進程式碼區塊 caret 一律落在第 2 行、以及
  `Alt+F10` 會不會被真實瀏覽器或 OS 攔截在自動化環境裡原理上驗不出來。設計上它們
  就沒有「修好」這個終點。

### Added（批次 2：drawio 內嵌檢視）

- **`![](x.drawio)` 與 `![](x.xml)` 現在會變成圖，不再是一個破掉的 `<img>`。** 每一頁在
  **建置時**就烤成一份靜態 SVG 寫進輸出的 HTML：頁面上沒有 drawio 引擎、沒有 `<script src>`、
  也沒有任何一個為了畫這張圖而發出去的請求。實測一份同時引用兩頁檔與單頁檔的文件，輸出裡
  `viewer.diagrams.net` 命中 0 次、`viewer-static` 命中 0 次，整份 HTML 裡唯一的 `http`
  字串是 SVG 的 namespace `http://www.w3.org/2000/svg`——那是識別字，不是連線。
- **`![描述](x.drawio)` 的 alt 文字會變成那顆圖的無障礙名稱**（`aria-label`）。作者本來
  就寫了名字，沒有理由丟掉它。單頁的圖用 `role="img"`；多頁的圖用 `role="group"`，因為
  頁籤列的按鈕就長在同一顆盒子裡面，`role="img"` 會把它們整組從無障礙樹上藏掉。沒寫 alt
  就兩個屬性都不生——一個空的名字比沒有名字更糟。
- **`#SheetName` 與 `#N` 選頁。** `![](x.drawio#Flow)` 與 `![](x.drawio#2)` 指到同一頁；
  名字不存在、或數字超出範圍時退回第一頁，不報錯。
- **多頁檔滑鼠移上去會浮出頁籤列**，切頁只是把 `hidden` 屬性搬一格——每一頁的 SVG 在建置時
  就全部烤進 DOM 了，所以**網路線拔掉照樣切得動**。單頁檔完全不付這個代價：頁籤列的 CSS 與
  script 都掛在「真的解出 ≥2 頁」這個旗標上，單頁文件的輸出裡連 `drawio-sheetbar` 這串字
  都不會出現——嚴格到註解也不行（Task 5 的第一版就是因為註解裡寫了這個 class 名，讓守衛
  測試變紅）。
- **圖接進既有的 lightbox**，點一下放大，跟 mermaid／graphviz／WaveDrom 同一條路。多頁檔
  點開的是**你當下在看的那一頁**：`lightboxSourceOf()` 為 `.drawio` 走一條專屬分支去找
  `.drawio-page:not([hidden])`，沿用原本的 `querySelector('svg')` 會永遠拿到 DOM 順序最前
  面的第 1 頁。
- **`--edit` 模式下，被引用的 `.drawio`／`.xml` 在磁碟上被改掉之後會自己重烤**，不必重新
  整理分頁。走的是編輯器**既有的 10 秒 ping 心跳**，不是新的推送通道——這個 stack 裡沒有
  WebSocket、沒有 SSE、也沒有 `fs.watch`，為了這一件事發明一條推送通道不划算。**延遲直接
  說出來：最多十秒。** 比對用的是 `(mtimeMs, size)` 而不是只有 mtime（WSL 的 DrvFs 與 SMB
  分享上，落在同一個時間刻度裡的改寫用 mtime 比不出來）；基準線是 **per-tab** 的，而且只有
  在那個分頁回報「我的 DOM 真的換上了那批位元組」之後才前進——所以任何一次因為你正在那個
  區塊裡打字、正在拖曳而放棄的更新都是**延後，不是丟掉**，下一拍會再報一次。連續被放棄時
  重試會退避（`min(10000 × 2ⁿ, 160000)`），**最多退到 160 秒**才再試一次；換到的是「一次
  卡住的重烤不會每 10 秒就再開一次 headless Chromium」。重烤之後**你當下看的那一頁會被
  保留**（頁名唯一時用頁名認，否則用位置認）；那一頁真的不見了才會退回第一頁，而且會
  告訴你。
- **沒有 drawio 的文件一毛錢都不用付。** 建置端：`bakeDrawio()` 在字串裡看不到
  `data-drawio-src=` 就直接短路返回，headless Chromium 是 lazy 的，從來不會被啟動（一份
  純文字 ＋ 表格的文件實測 0.09 秒渲染完）。編輯端：`/api/ping` 對沒有 drawio 參照的文件
  是純 Map 查找、**零 `fs.statSync`**，多出來的只有一次 body parse，而那個 body 的上限是
  8 KB 而不是 `readJson()` 預設的 50 MB——它是唯一一條每 10 秒、每個開著的分頁都會打的
  路由，沒有理由順便是全伺服器最寬鬆的那一條。
- **反過來說，有 drawio 的文件在 `--edit` 裡每次 commit 都付得到。** `POST /api/render`
  每一次都重跑一次完整的烤製：每次呼叫都自己開一顆 headless Chromium，把被引用到的每一個
  檔案的每一頁重烤一次，沒有任何以 `(路徑, stamp)` 為鍵的快取。**實測**（同一台機器，
  `renderMarkdown(..., {editMode:true})` 本身，各跑三次）：一張兩頁的 `.drawio` ＝
  1332／945／1060 毫秒，三張同樣的圖 ＝ 2275／2289／2797 毫秒，完全沒有 drawio 的同一份
  文件 ＝ 15／1／1 毫秒。也就是**每一張兩頁的圖替每一次 commit 加上大約一秒**。症狀會長得
  像「編輯器變慢了」，跟 drawio 連不起來——所以寫在這裡。快取化是 v3.5 的事（要用的 stamp
  就在隔壁一個函式，`drawio.drawioStampOf`）。
- **`.xml` 看的是根元素，不是副檔名。** 根元素是 `<mxfile>` 或 `<mxGraphModel>` 才當成圖；
  其他 `.xml`（`<catalog>`、設定檔、任何東西）**行為與這一批之前完全相同**，照舊落回原本的
  圖片路徑、照舊印 `[WARN] not a known image extension, left as-is`。判別會跳過前面的 XML
  宣告、DOCTYPE 與註解，而且 `<mxfilex>` 這種前綴撞名的標籤不會誤判。副檔名是 `.drawio`
  但內容不是 drawio 時會多印一句警告——那個副檔名是一個承諾，`.xml` 沒有。

**為什麼是建置時烤 SVG，而不是把 viewer 內嵌進輸出。** vendor 進來的 viewer 是
4,151,717 bytes（約 4.0 MB），內嵌等於每一份輸出 HTML 都背一份；而且它開頭有 **14 個
`window.X = window.X || "https://…"` 形式的遠端路徑預設值**——11 個指向 diagrams.net 的
基礎設施（`mxBasePath`、`mxImageBasePath`、`STENCIL_PATH`、`SHAPES_PATH`、`STYLE_PATH`、
`GRAPH_IMAGE_PATH`、`DRAW_MATH_URL`、`PROXY_URL`、`DRAWIO_LIGHTBOX_URL`、`EXPORT_URL`、
`VSS_CONVERT_URL`），3 個指向 github／gitlab（`DRAWIO_GITHUB_URL`、`DRAWIO_GITHUB_API_URL`、
`DRAWIO_GITLAB_URL`）。內嵌 viewer 等於讀者一離線圖就破，而「一份單檔 HTML，寄給誰、在
哪台機器上、有沒有網路都打得開」正是 md2doc 存在的理由。**這是 md2doc 與 VSCode 擴充套件
的根本差異**：擴充套件活在一個永遠有 editor host 的環境裡，md2doc 的輸出沒有 host，
只有一個檔案。

**代價說清楚：這顆 viewer 進的是每一次安裝。** `package.json` 的 `files` 收了 `vendor/`，
所以 `npm install @helping-ai-workflow/md2doc` 每個人都會拿到它，**包括從來不碰 `.drawio`
的人**。數字分兩種、不要混：**下載**是壓縮後的量，viewer 自己 gzip 後 854 KB（整包
`npm pack` 1.4 MB）；**磁碟**上解開才是 4,151,717 bytes。替代方案是 postinstall 去下載，但那會打破「離線裝得起來」這件事，所以不換。
那份 viewer 是 Apache-2.0 的第三方程式碼，不是 md2doc 自己的 MIT 原始碼：授權全文與逐項
的第三方清單跟著它一起進 tarball（`vendor/drawio/LICENSE`、`vendor/drawio/NOTICE`），
根目錄另有一份 `THIRD-PARTY-NOTICES.md` 當作授權掃描的入口。

### Known issues（批次 2）

`node test/drawio.test.js` 綠（EXIT=0）。下面每一條都是**刻意接受的邊界**，不是待修清單
——它們要嘛是「建置時烤成 SVG」這個選擇的代價，要嘛是「重烤是一個背景計時器、不是使用者
手勢」這個事實的代價。

- **靜態 SVG 沒有圖層切換。** drawio 檔裡的圖層在輸出裡是攤平的一張圖，沒有任何東西可以按。
  圖層切換需要一個活著的 viewer，而那就是上面那 4 MB ＋ 14 個遠端預設值。**這是選擇建置時
  渲染的代價，不是待修的缺陷**，將來也還會在。
- **只有檢視，沒有編輯。** md2doc 不會讓你改圖；圖的來源永遠是磁碟上那個 `.drawio`／`.xml`
  檔案，你用 draw.io 改它，md2doc 負責讓畫面跟上。
- **點圖不會收掉你開在別處的原始碼編輯器。** 你在某一段打開了原始碼編輯，然後去點另一段的
  圖——那個編輯器會留著沒收，內容還在。一般圖片、mermaid、graphviz、WaveDrom 本來就是
  這樣，`.drawio` 這次只是跟它們一致。
- **同一張圖同時發生兩件事時，你只會被告知其中一件。** 例如你畫過註記的那張圖被改掉、而且
  你當時看的那一頁也被刪掉——畫面上只會出現講註記的那一句，另一句在 60 秒後無聲丟掉。
  不是「後者蓋掉前者」：banner 沒有自動消失，所以**先來的贏**，而先來的是註記那一句。
  跳回第一頁這件事本身在畫面上看得出來。
- **你正在拖表格的列或欄時，圖會比平常晚一點才更新。** 分兩種情況，代價差很多：心跳響的
  時候你**已經在拖**，那一拍在送出請求之前就放棄，**完全不付錢、也不累積退避**，下一個
  10 秒心跳照常再試；只有「請求已經送出去、你才開始拖」會走到送出之後的那道放棄，那次才
  算一次付過錢的失敗、才會累積退避（第一次是 20 秒），整體大約半分鐘。而且那張表**不必是
  圖所在的那一張**——「有沒有人正在拖」這個狀態是全域的。兩種情況都會自己更新，不需要做
  任何事。
- **一行裡放兩張圖、其中一個檔案被刪掉時，留下來的那張圖會安靜地跳回 markdown 裡指定的
  那一頁**（沒寫 `#` 就是第一頁）。如果那張圖是多頁的、而你當時看的不是那一頁，頁面會自己
  換掉，而且不會有任何說明——一個區塊裡圖的數量變了之後，「位置」就不再能識別任何東西，
  寧可不說，也不要給一句猜錯的說明。
- **畫在圖片上的註記，會因為同一段落裡的 drawio 被改而一起消失，訊息還會怪到 drawio 頭上。**
  同一個段落裡同時有一張圖片和一張 drawio，你在圖片上畫了記號，然後那張 drawio 在磁碟上被
  改掉——你畫在圖片上的記號也會不見，而跳出來的說明寫的是「這張 drawio 圖在磁碟上被改過…
  已移除」。記號本來就只存在這次閱讀期間（重新整理就沒了），錯的只有歸咎的對象。
- **引用一個「還不存在」的 `.drawio`，它之後被畫出來時畫面不會自己跟上。**
  `drawioPlaceholderFor()` 在檔案解不到的時候就回頭了，回頭的位置在「把這個路徑記進待
  監看清單」之前——所以那個參照從來沒有進過 `state.refs`，`/api/ping` 也就從來不會去
  stat 它。這正好踩在最自然的寫作順序上：先在 markdown 裡寫 `![](arch.drawio)`，再去
  draw.io 把圖畫出來。畫好之後開著的那個分頁**整個 session 都不會發現**。任何一次不相干
  的編輯都會把它救回來（下一次 `/api/render` 會重新解析那個參照），所以症狀是間歇的、
  看起來莫名其妙。
- **同一份文件開兩個分頁，其中一個把圖刪掉並 commit 之後，另一個分頁就不再收到那張圖的
  更新了。** 「哪些路徑要 stat」這份清單是 **per-file** 的（`drawioWatch` 以 `fileId`
  為鍵），而基準線是 per-tab 的；`trackDrawioRefs()` 在每一次 `/api/render` 都會整份
  覆寫它。於是分頁 A 刪掉 `![](arch.drawio)` 並 commit 之後，這份文件的待監看清單變成
  空的，`checkDrawioStale()` 對**還在顯示那張圖的分頁 B** 也一律回答「沒有變化」。
  重新整理分頁 B 就會恢復。
- **開分頁時是單頁、session 中途才變成多頁的檔案，不會長出頁籤列，要重新整理那個分頁才有。**
  頁籤列的 script 只會被注入到「開啟當下就 ≥2 頁」的文件裡——這正是「單頁不付多頁代價」
  那條規則的另一面。

### Added（批次 3：wavedrom GUI 波形編輯）

- **滑到一張已渲染的 wavedrom 圖上，圖的右上角會浮出「編輯波形」，按下去開一個圖形
  介面的時序圖編輯器。** 畫面分兩半：左邊是 md2doc 自己畫的手繪波形，右邊是
  **wavedrom 引擎本人**渲染同一份文件的預覽。能做的事：11 顆電位筆刷
  （`0 1 x z p n h l u d =`）、插入／刪除 cycle、複製與兩種貼上（插入、覆蓋）、
  lane 改名／上下搬移／刪除／在指定位置新增、群組改名、head／foot 文字，外加編輯器
  自己的復原／重做。
- **為什麼手繪那一半不是去操作引擎畫出來的 DOM。** md2doc 把 wavedrom pin 在
  **3.5.0**（`package.json` 的 `dependencies`），而引擎的輸出沒有給外人用的契約——
  唯一抓得住的把手是 `RenderWaveForm()` 自己編號生成的 id
  （`wavelane_draw_<lane>_<index>`，`node_modules/wavedrom/lib/render-wave-lane.js`）。
  建立在那上面的互動會在升版時無聲壞掉，而且壞法是「圖還在、手勢打不中」。所以編輯層
  畫自己的 SVG，而 `brickOf` 把每一個電位對應到**引擎自己的 brick 符號**——兩邊會不會
  分歧，正是右邊那個預覽存在的理由。預覽刻意渲染在 index `9000` 而不是 0：
  `RenderWaveForm(index, …)` 拿 index 去命名 `svgcontent_<i>`／`waves_<i>`／
  `lanes_<i>`／`gmarks_<i>`，而文件自己那張圖已經佔了 0；程式碼裡記著當時的量測
  ——`(0, …, notFirstSignal=false)` 240 個重複 id、`(0, …, true)` 20 個、
  `(9000, …, true)` 0 個。
- **寫回檔案的是最小 patch，不是重新序列化。** WaveJSON 不是 JSON——真實的 wavedrom
  區塊會用不加引號的 key、單引號字串、尾逗號、`//` 與 `/* */` 註解，`JSON.parse`
  這四種全部拒收——所以 `lib/editor/wave-codec.js` 是一支自己寫的遞迴下降 parser，
  而且它替每一個值記下那個值在原始碼裡的半開區間 `[start, end)`。改一條 lane 的波形
  就只有那一段位元組被換掉，**作者的縮排、引號字元與註解原封不動**。進來的東西一律
  不正規化：`0..0` 與 `0...` 在 wavedrom 畫出來不一樣，會「順手整理」的 parser 是在
  毀資料。
- **局部改不掉的時候會說出來，不會改寫整個區塊。** 這是這一層唯一允許的失敗方式：
  `wave-store` 要嘛給出一個只動改過那幾個位元組的 patch，要嘛拒絕；沒有第三條路。
  拒絕時狀態列先說，接著升起一個 banner 指名它寫不回去的那幾行，等使用者確認——
  而且那次手勢**不會**被偷偷回捲，畫面上的圖與檔案裡的位元組不一致這件事是明講的。
- **每一個手勢寫回一次，不是攢一整個 session 再寫。** 拒絕率隨「寫回前累積的結構性
  op 數」上升，實作端量到 1-3 個 op **8.0%**、1-6 個 op **17.0%**，複查端用自己的
  產生器獨立量到 **6.6%（266/4000）** 與 **18.8%（2257/12000）**——同一個形狀。
  那些拒絕是對的（它們取代的是靜默損壞），所以讓它們稀少的辦法是不讓編輯堆起來；
  堆到第十次編輯才收到的拒絕，使用者得自己二分找出是哪一下。
- **Escape 丟掉整個 session，而且一次 `Ctrl+Z` 拿得回來。** 丟棄的語意跟 v3.3.0 的
  其他地方一樣沒有改，改的是「丟掉的東西要停放得回來」——`discardedWaveEdit` 是
  `discardedBurst`／`discardedRawEdit` 的第三個兄弟，三個互斥（一次只有一個編輯
  session），`undo()` 依序問過三個再落回一般 undo。session 中間如果落了一次
  `Ctrl+S`，它的 commit 就不能直接從堆疊上 pop 掉（那會毀掉磁碟被寫成的那個狀態），
  改成送一顆**還原 commit**：文件回到 session 開始的位置，堆疊只增不減，所以
  `dirtyDepth` 永遠是正的、不可能從下面穿過零。代價是一顆 `●` 要用一次 `Ctrl+S`
  清掉——而那是**真的**，磁碟上確實還躺著剛剛被丟棄的那張圖。
- **整個編輯器只用鍵盤就能操作——但今天要打開它仍然需要一次指標動作**（見下方
  Known issues，這一條不要讀成「鍵盤支援做完了」）。手繪區有自己的儲存格游標，
  方向鍵移動、`Shift+方向鍵` 選一段 cycle、按一個筆刷鍵就整段塗完；游標會被畫布
  重繪與 lane 搬移帶著走（靠的是 store 自己對「哪一條 lane 是哪一條」的回答
  `laneTrace()`，不是行號——兩份「哪條是哪條」的實作會讓游標畫在一條 lane 上、
  patch 卻寫進另一條）。從 block selection 按 Enter 開啟的 session，關掉時鍵盤會
  回到那個 block 上。
- **這個編輯器是 modal，而「誰擁有畫面」是一個關於狀態的問題，不是關於事件的問題。**
  舊的問法是「這個事件落在 overlay 裡面嗎」，那答不出來——實測 overlay 剛開起來時
  `document.activeElement` 是 `document.body`，於是每一個按鍵都打在 body 上，後面
  那份文件還握著它們。改成 `waveEditorIsModal()` 之後，背後文件的整套編輯手勢
  （工具列鍵盤模式、block selection 的 Tab／Delete／Backspace、undo／redo、Escape）
  在 overlay 開著時一律被擋掉，頁面捲動被鎖住，**唯一放行的全域手勢是 `Ctrl+S`**
  ——它是保護工作的反射動作。`Ctrl+P`／`Ctrl+F`／`Ctrl+A`／`F5` 這個檔案裡本來就
  沒有 handler，那道閘門是一句裸 `return`、沒有 `preventDefault()`，瀏覽器自己的
  行為不受影響。
- **讀不回來的區塊不會假裝可以編。** parse 失敗時開的是一個「這個區塊讀不回來」的
  面板，印出錯誤訊息、offset、換算成行／列，以及那一行的原文——一個孤零零的 offset
  不是人能拿來做事的東西。

### Fixed（批次 3；兩條都是 v3.3.0 今天就在出貨的既存缺陷）

這兩條都與波形無關，是做批次 3 時驅動產品、問「螢幕上這份與磁碟上那份到底同不同」
問出來的。兩條都在 `v3.3.0` 的 tag 上逐字可查：那一版的 `lib/editor/lineops.js` 裡
`markSaved()` 不收任何參數（`this._savedDepth = this._done.length`），而 `dirtyDepth`
就是一句減法（`this._done.length - this._savedDepth`）——下面兩條講的正是這兩行。

- **越過存檔點的一次復原，會讓文件回報自己已經存檔了。** 存檔點原本是用 undo 堆疊的
  **深度**記的：存檔時記下 `_done.length`，之後比較現在的深度等不等於它。深度是可以
  **從下面穿回來**的——復原到存檔點以下，再做一次編輯，`_done.length` 就又回到那個
  數字，而那是一條完全不同的歷史分支。四張網同時破：分頁標題的 ● 熄掉、儲存按鈕
  變灰、`beforeunload` 不再攔你，而「檔案在磁碟上被改過」那張 banner 的 Reload
  是一句直接的 `location.reload()`——它不會再問一次，就把那份工作丟掉了。
  修法有兩半。第一，**存檔標記在歷史分岔越過它的那一刻就被作廢**（設成 `null`）
  ——那一刻精確地就是「深度比標記還淺時發生了一次 `push()`」，也就是 `UndoStack.push()`
  裡那段新增的判斷。單純的 undo **不**作廢：undo 之後 redo 會把同一批 op 放回去，標記
  指的還是同一個狀態，所以分岔的不是回捲本身，是取代了被回捲那條分支的那次 push。
  第二，**問題本身改成是非題**：`isDirty()` 回答「記憶體與磁碟是否不同」這一個布林，
  而不是一個距離；`dirtyDepth` 留著給診斷與測試，標記作廢時它回一個刻意永遠不等於 0
  的值。**「不髒」從此只有一個意思：記憶體等於磁碟上那份。** 一個會從下面穿過零的
  計數器表達不了這句話。
- **存檔會把「回覆抵達那一刻剛好是什麼狀態」標成已存檔。** 在存檔往返中間按一次
  `Ctrl+Z`，編輯器就會相信磁碟上那份等於螢幕上這份：● 熄掉、`beforeunload` 不再攔，
  **而且因為那次存檔剛把檔案的時間戳推新了，「磁碟被別人改過」那道檢查也抓不到**
  ——關掉分頁，磁碟上留下一筆使用者明確復原掉的編輯。三張網一起失效。
  修法是**收據**：`saveToken()` 在請求出發**之前**取，記的是「我正要寫進磁碟的是這些
  位元組」——深度，加上那個深度邊界上那顆 op 的**物件 identity**。單靠深度不夠：
  使用者可以在往返期間 undo 再重打，堆疊回到同一個深度卻握著不同的 op，實測那個組合
  會把磁碟從來沒有裝過的位元組標成已存檔。op 物件由每一次 commit 現造，所以 identity
  是精確的指紋，代價是一個 reference。回覆抵達時 `markSaved(token)` 拿收據去對；對不上
  就作廢標記而不是硬標，**它唯一會犯的錯是多警告**。
  這一條修完之後又拆掉了一道自己一度加上去的防護：「比較新的請求送出後就丟掉舊的
  回覆」。那個前提是錯的——伺服器在 `baseMtimeMs` 對不上時一律回 **409 且什麼都不寫**
  （`lib/editor/server.js` 的 `/api/save`），而 `mtimeMs` 只有 200 那一支會寫；所以
  第一個回覆還在路上時送出的第二個請求**必然**帶著過期的基準、**必然** 409、**必然**
  沒寫到任何東西。**描述磁碟現況的是第一個回覆，丟掉它才是缺陷。** 實測帶著那道防護：
  打字、`Ctrl+S`、`Ctrl+Z`、`Ctrl+S` → 第一個 200 被丟棄、`markSaved()` 從未執行、
  文件讀起來是乾淨的而編輯還在磁碟上；連 undo 都不用，連按兩次 `Ctrl+S` 就會讓
  `mtimeMs` 永遠停在過期值，之後每一次存檔都 409，唯一的出路是 banner 的重新載入。

### Known issues（批次 3）

這一批把測試檔從 41 個加到 **44 個**（新增 `test/wave-codec.test.js`、
`test/wave-geometry.test.js`、`test/wave-store.test.js`，三個都在 `package.json` 的
`test` script 裡）；`lib/`、`test/` 與 `package.json` 合計 **+16,008／−145 行**。
`dependencies` 逐位元組未動——`package.json` 這一批唯一的改動就是把那三個新檔加進
`test` script。
寫這一段時實跑並觀察到綠的是 `node test/drawio.test.js`、`node test/wave-codec.test.js`、
`node test/wave-geometry.test.js`、`node test/wave-store.test.js`，四支 **EXIT=0**；
`npm test` 與兩支長跑 puppeteer 套件（`editor-client-runtime.test.js`、
`editor-journey.test.js`）**這一段沒有跑**，所以這裡不宣稱它們的結果。

**可達性——這一條不要讀成「鍵盤支援做完了」。**

- **編輯器開起來之後可以完全用鍵盤操作，但把它打開這件事今天需要一次指標動作。**
  追蹤名稱 `v3.4.0-followup-keyboard-entry-to-content`。
  **缺的是什麼**：`.content` 裡面沒有任何東西是鍵盤到得了的。沒有一條鍵盤路徑能把
  DOM 焦點放到一個 `.ed-block` 上，而那是每一個 block 級手勢的起點狀態。實測（實作端
  量過、複查端再量過一次）：冷開的頁面上按 Tab，焦點哪裡都不去（被 `client.js` 自己
  那條「沒有任何東西被 focus」的分支 `preventDefault()` 掉）；在已經 armed 的段落裡
  按 Tab 被清單縮排接走；冷頁上按 `Shift+ArrowDown`，`stepSelectionFocus()` 因為沒有
  種子而回 false；從 burst 裡按 Escape 出來，焦點落在 BODY。**block selection 今天
  只能用 Shift+Click 或指標拖曳生出來。**
  **它擋住什麼**：(1) 這一批做的 Enter 入口——從 block selection 進得去、從這一批新增
  的「關掉之後 Enter 再開」也進得去，但**第一次**進去仍然要付一次指標動作；(2) gutter
  的 `.ed-insert`／`.ed-handle` 都是 `tabindex="-1"`，今天拿不到鍵盤，所以它們的
  Enter／Space 分歧目前是潛伏的——任何讓 gutter 變成 Tab 可達的修法都會讓那一整類
  同時轉活，兩者必須一起設計；(3) 其餘每一個 block 級手勢：⠿ 選單、＋ 插入、對選取
  按 Delete／Backspace，以及原始碼編輯器。
  **修法必須涵蓋什麼**：冷頁上焦點的種子（大概是第一個 block，或使用者最後碰過的那個）；
  Tab 在 block 層到底是什麼意思的裁定（今天在兩條分支被刻意吞掉、在第三條被清單縮排
  接走）；roving `tabindex` 與 `applySelectionClasses()` 的互動（後者會把每一個 block
  的 `tabindex` 剝掉，因而讓被 focus 的那個失焦）；以及**「被 focus 但沒有被選取」的
  block 今天完全沒有可見標記**——`.ed-block.ed-selected:focus` 是 `outline: none`，
  因為底色才是這個編輯器的「鍵盤在這裡」語彙。它還必須保住這一批靠著的兩條既有契約：
  armed 表面裡的 `Shift+↑↓` 仍然是瀏覽器的文字選取手勢，表格儲存格裡的 Tab 仍然是
  表格的。
- **用滑鼠打開的 session，關掉時焦點落在 `document.body`。** 「把鍵盤交回去」
  （`giveKeyboardBackToWaveBlock()`）只對 `seam.reselect === true` 的 session 生效
  ——也就是那些帶著一個站在看得見位置的鍵盤進來的。hover 點開的 session 不會被硬塞
  一個它沒有要求過的選取，所以它結束在它開始的地方。

**這個編輯器本來就不模型化的事（不是待修清單）。**

- **`period`、`phase` 與 `config.hscale` 不在手繪那張圖的模型裡，而它會說出來。**
  三者都會改變引擎畫出來的東西，手繪那一半全部不理會——量測記在
  `lib/editor/wave-ui.js` 的 toolbar 註解裡：`{wave:'0101'}` 引擎 8 個半 brick、
  手繪 4 個 cycle；加上 `period:2` 引擎 16、手繪 4 不變；加上 `phase:0.5` 引擎 7、
  手繪 4 不位移；`config.hscale:2` 引擎 16、手繪 4 不變。做一顆控制項去改一個畫布
  根本不理會的屬性是三個選項裡最糟的一個：它邀請使用者把兩張圖弄到不一致，然後給他
  看那張有自信的錯圖。所以**控制項拿掉了**，改成帶著這三者之一的文件會被明講
  「左邊的手繪波形不表現它們，以右邊的 WaveDrom 預覽為準」。
- **只認 `signal:`。** wavedrom 的 `reg:`（bit field）與 `assign:`（邏輯式）文件
  parse 得回來，但對這個編輯器來說是 0 條 lane——實測 `{reg:[…]}` 與 `{assign:[…]}`
  的 `lanePaths()` 都是 `[]`，而 `addLane()` 對它們回傳原封不動的文件。也就是說那兩種
  區塊開起來是一張空的畫布，什麼都做不了。
- **`data`（bus 標籤文字）、`edge`／`node`（箭頭標註）與 `config` 的其餘欄位不能從
  GUI 改。** `data` 標籤是**讀出來畫上去**的，改不了；`edge` 完全沒有進到這一層。
  這些欄位在最小 patch 的寫回路徑上沒有損壞風險——沒有人去碰它們——但要改就得回去
  改原始碼。
- **手繪與預覽「逐 cycle 一致」那道檢查看不見高度錯了，也看不見顏色錯了。** 兩件都
  量過：把每一個 `x` 方塊畫成 band 高度的**一半**（cycle 與 class 都不變），
  `shapeCount` 16 不變、`painted === expected`，**綠**。顏色則是由程式碼直接裁定的
  ——分類器只讀 `el.tagName` 與 `cls.indexOf('ed-wave-clock')`，兩邊都不曾取樣
  `fill`／`stroke`／computed style，所以 `ed-wave-bus-3` 畫成 `ed-wave-bus-9` 比起來
  是 `bus === bus`。一個把每一條 band 砍半的版面退化，會頂著「手繪波形與 WaveDrom
  預覽逐 cycle 一致」這個名字出貨。（「多畫一個形狀」那一半已經關掉了：現在有一條
  `paintedCounts` 的斷言。）

**存檔路徑上刻意留下的窗口與痕跡（都不會讓未存檔的工作被回報成已存檔）。**

- **重繪失敗時的回捲，是把那次來不及顯示的編輯放到 redo 堆疊上**——所以接下來按
  「重做」會把一次從來沒有出現在畫面上的編輯再套一次。`rollbackFailedRender()` 走的是
  `stack.undo()`，而 `UndoStack.undo()` 無條件把 pop 出來的 op 推進 `_undone`。
  旁邊就有一支 `discardTop()` 做的正是「pop 掉而且**不**放進 `_undone`」，它是這條路
  將來該用的東西。
- **伺服器把位元組寫進磁碟的那一刻，到編輯器被告知的那一刻之間，編輯器還不知道檔案
  已經變了。** `mtimeMs` 與 `markSaved()` 都只在 200 那一支執行。沒有東西會遺失
  ——回覆會把它結清——但未存檔指示器可以落後一整趟往返的時間。
- **連按兩次 `Ctrl+S` 之後，可能會留下一張「檔案在磁碟上被改過」的通知，而它來自那個
  什麼都沒寫的第二個請求。** 第二個請求必然帶著過期的 `baseMtimeMs`、必然 409、
  必然沒寫到東西，而 409 那一支會升起 conflict banner；第一個回覆後到的 200 現在會
  正常結清（見上方 Fixed），所以文件不會卡住，剩下的只是那張過期的通知。關掉它是
  安全的。

**md2doc 的 HTML 輸出會把 wavedrom 區塊的內容當成 JavaScript 執行——這件事早於
v3.4.0，而且這一批沒有改變它。**

`lib/md2doc.js` 把 code block 的內容**原樣**吐進 `<script type="WaveDrom">`（沒有
跳脫，第 924 行，最後一次改動是 2026-08-25）；wavedrom 自己的
`lib/process-all.js` 掃出每一個 `type` 是 `wavedrom` 的元素，交給 `lib/eva.js`，
而那支做的是 `eval('(' + TheTextBox.innerHTML + ')')`。**實測**：把
`{signal:[{name:(function(){window.__md2docProbe=1;return "clk";})(),wave:"p..."}]}`
放進一個 wavedrom 區塊、產出 HTML、用 headless Chromium 打開——`window.__md2docProbe`
是 `1`，而那個 IIFE 的回傳值變成了 lane 的名字。**所以一份 markdown 的 wavedrom 區塊
等同於一段會在每一個開啟輸出 HTML 的人的瀏覽器裡執行的腳本。**

既有的緩解手段是 **`--bake-svg`**，而它的作用要講精確：它拿掉的是**會執行的那個東西**，
不是**被執行的那個東西**。同一份文件實測，`--bake-svg` 之後輸出裡
`data-md2doc-diagram-engine` 的引擎 script 從 **3 個變成 0 個**，而
`<script type="WaveDrom">` 仍然是 **1 個**（原始碼還在，只是沒有人再去 eval 它）；
同一個探針在烤過的輸出裡**沒有**執行。但它是在建置時被執行過的——烤出來的 SVG 上寫著
`clk`，那正是那段 IIFE 的回傳值。**也就是說 `--bake-svg` 把 eval 從每一個讀者的機器
搬到作者自己的機器，不是消滅它。**

**這一批新寫的 parser 不是渲染的那一個，所以它不改變上面任何一句話。**
`lib/editor/wave-codec.js` 完全不建立執行期程式碼、不 import 任何東西
（`test/wave-codec.test.js` 會 grep 它有沒有出現那些拼法），但畫出讀者看到的那張圖
的是 wavedrom 引擎，不是它。

### 這一版還沒做的

- **批次 3 原本的範圍裡，`edge` 標註沒有做。** 「滑到已渲染的圖上出現 Edit、塗電位、
  增刪 cycle、lane 改名與重排、最小 patch 寫回」都做了（見上方 Added），**畫 edge
  標註沒有**——`edge` 完全沒有進到編輯層。

先前就記錄過、到今天仍然成立的：

- **§3 雙向同步仍未做。** 外部程式改了 markdown 檔案，開著的編輯器分頁不會反映那次
  改動，仍然要重新整理頁面。批次 2 的 drawio 重烤是這條規則唯一的例外，而且它只涵蓋
  **被引用的 `.drawio`／`.xml` 檔**——重烤送回伺服器的 markdown 是分頁自己記憶體裡的
  那一份，不是磁碟上的那一份。
- **`export▾` 仍然缺。** 工具列這一版變成 23 顆按鈕，但多的那一顆是 `save`。
- **每一個結構性的清單手勢都會整份重繪**（清單裡按 Enter、Backspace 併回或刪除項目、
  ＋ 新增項目、⠿ 建立副本或上下搬移），這仍是刻意保留的 fallback，不是退化。
- **light／dark 主題切換沒有做**，這一批也沒有開始做。

## v3.3.0 — 2026-09-10

v3.2.1 出貨時，Known issues 裡誠實列了十三個「用產品」審查席位在一次就座裡找出來、
本版一個都沒修的問題，其中三個嚴重到必須逐條點名——表格加不了列或欄、第一次點進表格
落錯格會覆蓋掉欄位標題、raw 編輯器的 caret 一律落在收尾 fence 之後。v3.3.0 是把那張
清單認真清掉的一版：不是重新讀 diff，而是把 ⠿／＋ 選單、工具列、表格編輯這整族手勢
換成真的滑鼠按壓（`mousedown` → 停留 → `mouseup`，不是合成 `.click()`）重新驅動一遍，
過程中又翻出更多先前八輪 review 與整套 journey 網都沒測到的缺陷——undo 會連剛打的
整句一起吃掉、巢狀清單的尾隨空白會覆蓋掉上一項、一次編輯讓 fence 吞掉半份文件卻沒有
任何信號。這版也第一次給了工具列鍵盤入口。過程中另外量測到一批真實存在、但這一版沒有收掉的
項目，全部誠實列在下面，分成「裁定延後的缺陷」與「刻意接受的邊界」兩類——不是每一個
Known issues 裡的問題這次都修完了。

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
- **打了字之後按 Escape，那段字就沒了，而且救不回來。** Escape 的語意仍然是**丟棄**
  ——這一點沒有改，它照樣把 surface 還原成進來之前的樣子、照樣讓你離開那一格。改掉的
  是「丟棄」等於「永遠拿不回來」：先前 `revertBurstAndEnd()`／`revertTableBurstAndEnd()`
  直接把 burst 的歷史丟掉再寫回 DOM，於是接下來不管按幾次 `Ctrl+Z` 或 `Ctrl+Y` 都拿
  不回來——段落、表格儲存格、清單項目三種面上都一樣。現在這個還原走的是這一版對每一次
  程式化變動都要求的成對存檔（寫回之前先 `flushTyping()`，寫回之後再 `snap()`），而且
  那份歷史不是丟掉、是**停放**起來；下一個 `Ctrl+Z` 會把 burst 重新開在同一個面上、把
  文字放回去，而且是放成一次**活的編輯**——所以下一次失焦會把它存進磁碟，再按一次
  `Ctrl+Z` 也還走得到它底下的那些步驟。停放只在「Escape 之後直接 `Ctrl+Z`」這個窗口內
  有效：任何一次重新開 burst 或整份重繪都會把它丟掉。Escape 之後標題會回到未修改狀態
  （沒有那個圓點），因為此時文件內容確實跟磁碟上的位元組一樣。
- **從表格走出來之後多按一次 Tab，會去改你剛落腳的那個區塊。** 用 Tab 走出表格，落點是
  下一個可編輯的區塊；但那個區塊自己的 Tab 有別的意思——在標題上是加深階層、在清單項目
  上是縮排——所以「同一顆鍵再按一次」就把它改掉了，而且直接寫進磁碟。實測：表格最後一格
  連按四次 Tab，`### Build snippet` 變成 `###### Build snippet`；表頭第一格連按四次
  Shift+Tab，`  - epsilon` 被反縮排成 `- epsilon`。現在用 Tab 走進來的 burst 會帶一個
  記號，記號還在的時候 Tab 就繼續往下一個／上一個區塊走，而不是改動這一個；任何別的
  按鍵（Shift 除外，它是 Shift+Tab 自己的第一個 keydown）或任何滑鼠按下都會把記號用掉，
  所以你真的想縮排時 Tab 仍然是縮排。
- **`Ctrl+C` 按不掉 `md2doc --edit`。** 訊號處理常式印了那一行話、也呼叫了
  `server.close()`，行程卻活著不走；實測預設開啟瀏覽器的情況下 12 秒還在，而且再按一次
  `Ctrl+C` 只是把同一行再印一次。真正的原因不是 WSL interop，也不是「有分頁連著」——
  Node 22 的 `close()` 已經會收掉閒置的 keep-alive 連線，所以真的開著一個分頁反而不會
  卡住；卡住它的是一條**從來沒有送過任何請求**的連線，也就是瀏覽器的預先連線。現在三條
  結束路徑（`Ctrl+C`、閒置逾時、連結從沒被打開過的逾時）都走同一個收尾函式，`close()`
  之後補上 `closeAllConnections()`（Node 18.2 起有，依 `engines` 的下限做了保護）；後面
  那兩條特別要緊，因為它們沒有第二次按鍵可以救。第二次 `Ctrl+C` 現在會就地強制結束
  （離開碼 130），而且不會再印一次那行話。修好之後：預先連線的情況 8–12 毫秒結束，真的
  開瀏覽器的情況 14 毫秒。
- **編輯模式每一頁的最上面，都有 60px 的空白。** 上面那條「側欄開關在編輯模式下隱藏」
  把那顆按鈕藏了起來，但版面還在替它保留位置：編輯模式的 `@media (max-width: 1080px)`
  規則仍然是 `padding-top: calc(60px + 工具列高度)`。實測 1080／1000／800px 三個寬度下
  `padding-top` 都是 104px，而工具列只有 44px 高，工具列底緣到第一個區塊之間隔了 105px
  ——同一份文件在 1200px 下只隔 45px。現在那條規則只保留工具列自己的高度。規則本身不能
  刪掉：閱讀模式的 1080px 規則會替它自己那顆（仍然顯示的）抽屜開關保留 60px，刪掉覆寫
  等於把那 60px 原封不動還回來。修好之後四個寬度都是 44 對 44。
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
- **會讓焦點掉出去的 DOM 手術，有兩處不在那張清冊上。** `test/detach-census.test.js`
  是一張逐條列出「哪幾行程式碼會把使用者正在編輯的節點從文件上拆下來」的清冊，它的作用
  是讓新增的拆卸點必須被有意識地加進來、順便被稽核有沒有做對應的焦點處理。這一版翻出
  選取工具列那條路上的兩個行內手術（`el.appendChild(range.extractContents());` 與
  `x.el.parentNode.removeChild(x.el);`）從來沒有被列進去——清冊自己的兩個機械式問題都
  問不到它們。清冊從 25 條補到 29 條（另外兩條是這一版新增的 DOM 寫入，依清冊自己的規矩
  一併列入），並且多加了一個會抓到這一族的判準。
- **對齊（cycleColumnAlign）只改 `style="text-align:…"`，不會讓分頁被標記為未存檔。**
  這是修 🔗 連結那個「監看 attributes 沒有必要」的推論被過度推廣後留下的漏洞：刪掉
  `attributes: true` 對 🔗 是對的（它經過 modal，commit 早在 `setAttribute` 之前就
  發生），但對齊完全是另一種形狀——整個操作只寫屬性、不commit burst，於是拿掉屬性監看
  後標題停在「doc」，關分頁的守衛卻認為有未存檔的變動，兩者互相矛盾。現在把
  `attributes: true` 加回來，並把**會寫進一個仍然開著的 burst surface** 的那幾個屬性
  寫入者逐一重新分類：對齊（只寫屬性、不 commit burst，是這條規則的成立依據）、🔗
  改寫既有連結的 `href`（不成立——modal 先把焦點帶走，commit 早在 `setAttribute`
  之前就發生）、表格選取 chrome、以及單純點一下儲存格（後兩者都量測過，都不會點亮
  未存檔的圓點）。**不是**檔案裡 67 個 `setAttribute` 每一個都量過——程式碼自己的註解
  就是這樣寫的（「Not every attribute write in this file was measured.」），這裡跟著
  它，而不是跟著 commit message 比較強的講法。

### Known issues

這一版的驗證基礎是兩套長跑測試——`test/editor-client-runtime.test.js` 與
`test/editor-journey.test.js`——加上其餘三十七個快速檔案，一共三十九個測試檔。
`editor-journey.test.js` 在這版裡從 2,252 行長到 7,563 行（38 個 commit 動過它），
每一條上面列出的缺陷與其 ablation，幾乎都是靠它釘住的。

過程中用真實滑鼠事件重新驅動整族手勢時，另外找出一批這一版沒有收掉的東西，這裡
不因為它們讀起來不好看就不列。它們分成**兩種，而且差別是有意義的**：

- **裁定延後到 v3.4.0 的缺陷**——是缺陷，有人會去修，修完就不見了。
- **已知且刻意接受的邊界**——不是缺陷，將來也還會在那裡，沒有「修好」這個終點。

出處，講清楚比含糊好：下面有四項是為了寫這份清單而**當場重新驅動**出來的——🔗 包住
純空白、鍵盤游標被一般按鍵丟掉、`⠿ → MD 原始碼` 與 raw 編輯器的 Escape、以及程式碼
區塊的 caret 落點——它們的實測結果就寫在各自那一條裡。其餘各項的依據，是它們自己當初
的裁定紀錄與本版收尾時的全分支複查：都是驅動量測留下來的，不是從程式碼推測的，但也
不是為了這份清單再跑一遍。唯一連原理上都驗不出來的是最後一項（`Alt+F10` 會不會被
瀏覽器或 OS 攔截），那一條自己會說。

**裁定延後到 v3.4.0 的缺陷。** 會把資料弄髒的（優先）：

- **對一個已被吞噬的 code block 重開 raw 編輯器去補 fence，會把尾巴在磁碟上複製一
  份。** 逐位元組重現的既存缺陷，跟 F10（吞噬本身）不同根因——這是從吞噬狀態復原時
  自己的路。
- **`onRowInsertBubbleClick()` 的 `afterRowIndex` 在表格換手之後會過期**，
  `bodyRowsOf(...)[idx]` 拿到 `undefined`，於是新列插到最上面，而不是把這次手勢
  丟掉。**這一版讓它變得更容易踩到**：在修掉「＋ 泡泡手一靠近就消失」之前，這顆按鈕
  按不按得到取決於最後一個滑鼠移動落在哪，等於有一層意外的保護；那個可達性缺陷這版
  修好了，這個資料缺陷要等 v3.4.0——所以是一次「修好 A 把 B 的曝光面放大」，我們認為
  應該講出來而不是分開列。
- **選取起點落在像 `` *`code`* `` 這種定界符相鄰處時，`inline-md.js` 挑定界符長度的
  邏輯仍會產生 `\*` 跳脫。** 跟本版修掉的「空殘留標記」不同根因、不同檔案、不同修法；
  刻意不釘測試，因為釘住今天這組錯誤的位元組，會讓將來真正的修法因為錯誤的理由被
  測試擋下。
- **對純空白的選取按 🔗，會把那段空白包進 `<a>` 裡。** 粗體／斜體那條路在包起來之前
  有一個「整段都是空白就不要動」的守衛，新建連結那條路沒有。實測：在
  `Alpha bold text here.` 裡選取 `Alpha` 後面那一個空白、按 🔗、網址填
  `https://probe/`，段落變成 `Alpha<a href="https://probe/"> </a>bold text here.`。
- **`⠿ → MD 原始碼` 與 raw 編輯器自己的 Escape，會把還沒存下來的編輯丟掉，而且
  `Ctrl+Z` 救不回來。** 實測：段落打進一段字之後走 `⠿ → MD 原始碼` 再按 Escape，
  那段字沒了、`Ctrl+Z` 也不會把它帶回來；在程式碼區塊的 raw 編輯框裡打字再按
  Escape，同樣沒了，磁碟上也沒有。兩者都是既存缺陷，而且都走一個明說會丟棄的入口
  （選單項目、✕ 按鈕）。修法不能沿用 burst 那一套：raw 編輯器根本沒有 burst 歷史
  可以停放，而 `⠿ → MD 原始碼` 還會把自己的 surface 拆掉。

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
- **工具列的鍵盤游標，會被一般按鍵靜靜地丟掉，而且沒有任何提示。** 實測
  `ArrowUp`／`ArrowDown`／`Tab`／`Home`／`End`／`a`／`Backspace` 七顆，按下去之後
  游標的外框與工具列上那個 keynav 標記同時消失，也沒有任何訊息升起（左右方向鍵則正常
  走到下一顆按鈕）。`Alt+F10` 在畫面上造成的唯一差別就是那個外框，所以它一消失，
  工具列看起來就跟按 `Alt+F10` 之前一模一樣，而 `ArrowDown` 通常是一個人在工具列裡
  第一個會按的鍵。

幾何／遮擋：

- **`updateTableEdgeGrips()` 的守衛沒有列入 `.ed-tb-insert`**，站在 ＋ 泡泡上會讓
  ⠿ grip 消失——同一個根因，但要關掉它得放寬一個同時呼叫 `setGutterKeep()` 的
  early return，那個行為在這裡尚未量測過。
- **窄視窗開側欄會出現 `.sidebar-scrim`，但沒有任何捲動鎖，背後的頁面仍然可以
  捲。** 是「缺一個鎖」，不是「鎖被打敗」。
- **深縮排項目裡的 table 或 `---` 會讓 li 的 `startLine` 落在非 marker 行上**，
  這版改動前後行為相同。

**已知且刻意接受的邊界**（不是缺陷，將來也還會在，但要讓使用者知道）：

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
- **點進程式碼區塊，caret 一律落在第 2 行，不管你點的是哪一行。** 這一版把落點從
  「收尾 fence 之後」（下一個按鍵就把 fence 弄壞）改成「第一個內容行的開頭」，那是
  嚴格的改善；把 caret 放到你實際點的位置需要座標對映，這一版**刻意**沒有納入範圍，
  所以這是一條畫出來的線、不是待修的缺陷。實測同一個五行區塊的頂端、中央、最後一行
  三個落點，`selectionStart` 三次都停在第 2 行的開頭。
- `Alt+F10` 會不會被真實瀏覽器或 OS 攔截（Firefox 的 `F10` 選單列、GNOME/KDE 的
  `Alt+F10` 最大化），在目前的自動化環境裡**原理上驗不出來**——這是上面那句「都被
  驅動量測過」唯一的例外，需要使用者在真機上確認。

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
