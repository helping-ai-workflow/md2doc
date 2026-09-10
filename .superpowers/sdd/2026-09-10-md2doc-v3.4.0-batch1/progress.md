# SDD ledger — plan: docs/superpowers/plans/2026-09-10-md2doc-v3.4.0-batch1.md

Spec: docs/superpowers/specs/2026-09-10-md2doc-v3.4.0-design.md（可讀到，binding authority）
Branch: feat/v3.4.0-batch1，起點 d80de09（main，v3.3.0 released）

## Preflight 衝突掃描

### 共用檔案／介面的 task 配對

| 配對 | 一方產出 vs 另一方消費 | 結果 |
|---|---|---|
| T3 → T4 | T3 產 `state.save.disabled`（`deriveState()` 讀 `ctx.dirty`）；T4 把 `dirty` 送進 ctx 並接點擊 | 一致 |
| **T4 ↔ T9** | T4 說「caret 還原沿用既有機制——先看 `undo`/`redo` 怎麼做」；**T9 要修的 backlog 第 6 項正好包含「有未 commit 編輯時 `undo`/`redo`/`image` 也會把 caret 丟在 BODY」** | **衝突：T4 被指示去抄一個 T9 稍後才要修的壞掉機制** |
| T2, T4, T5, T6, T7, T9, T10, T11, T12 | 全部改 `lib/editor/client.js` | 不並行派工，逐一執行；無衝突。但 T2 之後每一個 task 的 BASE 都要重新記 |
| **T10 ↔ T11** | T10 要求先列「所有 fixed overlay 的 z-index 與垂直帶」表再改；T11 第 11 項也動 grips 的顯示條件與可能的 CSS | **順序風險：T10 的表在 T11 改完後可能失效** |
| T1 → T13 | T1 改 slug（breaking）；T13 的 CHANGELOG 要寫 breaking 段 | 一致 |
| T11 → T13 | T11 第 13 項改 `blockmap.js`；T13 不碰 | 無交集 |
| T12 → 無 | 調查 task，產出可能是文件或一顆修正 commit | 無下游依賴 |
| T3 → T13 | T3 動 `package.json` 的 BUTTONS？否——T3 只動 `toolbar-model.js`；T13 動 `package.json` 的 `test` script | 無衝突 |

### 每個 task 自身文字是否自洽

| Task | 檢查 | 結果 |
|---|---|---|
| T1 | 測試斷言 `href="#alpha-beta"` vs 修法（`unescapeHtml` 用在 `flattenTokenText` 葉節點） | 自洽。`&amp;` 最後解的順序有寫明 |
| T2 | 「先重現再修」與 Step 3 的修法一致；姊妹路徑已查證 | 自洽 |
| **T3** | 測試斷言「沒有 block 時 save 仍可按」；修法同時加 `NO_BLOCK_ALLOWED` 與 `state.save.disabled = !dirty`，而後者在主迴圈之後執行 → **`NO_BLOCK_ALLOWED` 那一項是冗餘的** | **需裁定** |
| T4 | 步驟完整，但 caret 還原的做法指向 T9 要修的壞掉機制（見上表） | 見裁定 |
| T5 | 守衛程式碼與 `applyMarkToggle()` 同型，範圍限定在新建連結分支 | 自洽 |
| T6 | 修法對齊 `performRowDrop()` 的既有處理；測試要造「live-table 換手」 | 自洽 |
| T7 | 兩項不同根因放同一個 task；各有自己的測試與 commit | 自洽（同一族、同一檔） |
| **T8** | **刻意「先修再測」，與其他 task 的 TDD 順序相反** | **需裁定：review rubric 會把「沒有先紅的測試」當缺陷** |
| T9 | 四項各自獨立、要求一次修一項一次驗一項 | 自洽 |
| T10 | 要求先產出 fixed overlay 表才准改 | 自洽 |
| T11 | 三項；第 13 項純函式先做（快、可獨立驗） | 自洽 |
| T12 | 產出二選一，明令不得無重現就改 | 自洽 |
| T13 | CHANGELOG 內容要求具體 | 自洽 |

## Preflight 裁定

**Ruling P1（T4 ↔ T9 的抄襲來源）：T4 不得抄 `undo`/`redo` 的 caret 還原，必須自己保存並還原 caret，並在 report 裡寫出它保存了什麼、在哪裡還原。**
理由：plan 的 T4 Step 4 寫「先找 `undo`/`redo` 是怎麼做的，用同一條路」，但 T9 要修的 backlog 第 6 項明說「**有未 commit 編輯時 `undo`/`redo`/`image` 也會**把 caret 留在 BODY」——那條路在最會出事的情境下本身就是壞的。抄它等於在新按鈕上複製同一個缺陷，而 T4 自己的測試（caret 必須回原位）在乾淨情境下會綠、在有未 commit 編輯時才紅，屆時會被誤判成 T9 的問題。
成本若判錯：T4 多寫十幾行本來可以共用的程式碼；若 T9 之後做出一套更好的共用機制，T4 這一段可以被收編。**遠比反過來便宜。**
**T4 的派工單要加一條測試**：在「有未 commit 編輯」的狀態下按儲存，caret 同樣要回原位。

**Ruling P2（T3 的 `NO_BLOCK_ALLOWED` 冗餘）：兩者都保留，但以 `state.save.disabled = !dirty` 為準。**
理由：那一行在主迴圈之後執行，確實會蓋掉 `NO_BLOCK_ALLOWED` 的效果，所以名單那一項今天不影響行為。仍然保留，因為它記錄的是意圖，而且若將來有人把那一行往上搬，名單就變成唯一的防線。
成本若判錯：一個看起來多餘的集合成員。若 reviewer 把它當死碼提出來，我以本裁定回應。

**Ruling P3（T8 的反向 TDD）：接受 plan 的順序——先修，修好之後才釘測試。**
理由：這是 v3.3.0 的原始裁定，理由寫在 backlog 第 3 項裡：「斷言今天這組錯的位元組，會讓將來真正的修法因為錯誤的理由而變紅」。這一條是 spec §6 明文帶進本版的，spec 是 binding authority。
成本若判錯：T8 少了一次「測試先紅」的保護。緩解：plan 已要求 Step 1 先驅動出實際位元組並寫進 report，Step 5 要跑 `inline-md` / `paste-md` / `roundtrip` / `byte-stability` 四支。
**若 task reviewer 以「沒有先紅的測試」提出缺陷，我以本裁定回應，不進 fix loop。**

**Ruling P4（T10 ↔ T11 的順序）：T10 在 T11 之前執行（照 plan 編號），且 T11 的第 11 項派工單要帶上 T10 產出的 fixed overlay 表，要求它說明自己的改動對表裡每一列的影響。**
理由：v3.3.0 最後一個紅正是這一類——拿掉 60px padding 把一個 fixed overlay 推到另一個底下，而那次機械掃描「掃對了檔案、掃錯了軸」。表存在卻沒有被下一個動幾何的 task 讀到，等於白做。
成本若判錯：T11 的派工單長一點。

## Task 1
- BASE d80de09，implementer 回 DONE_WITH_CONCERNS，commit `5c93d77`（`lib/md2doc.js` +26-3、`test/md2doc.test.js` +46）。
- **它發現我的 plan 不足，而且理由成立**：`flattenTokenText()` 改回傳未跳脫文字之後，`stripHtmlTags()` 的 `/<[^>]*>/g` 會把字面上的 `< D >` 當 HTML tag 吃掉 → brief 自己指定的 `#c-d-e` 實際會變成 `#c-e`。它把 regex 收緊成 `/<\/?[a-zA-Z][^<>]*>/g`。
- **這是 plan 的缺陷，不是實作者的**：我在寫 plan 時驗了 marked 的 token 跳脫狀態，沒有驗下游的 `stripHtmlTags()` 對「未跳脫的角括號文字」會怎樣。同一條路上兩個函式的契約耦合，我只看了上游那一個。
- reviewer 已派（獨立驗根因 + 列舉 `stripHtmlTags()` 三個呼叫點在收緊前後的差異，並問有沒有更小的修法）。刻意**沒有**告訴 reviewer「偏離是合理的」——那是 pre-judging。
- **review：spec ✅，品質有問題。** reviewer 沒有只讀報告——它用 `marked.lexer()` 獨立驗了根因（確認 `< D >` 被 marked 併進單一 text token、沒有獨立 html token），然後用一個 brief 沒涵蓋的輸入抓到真迴歸：`## Section <!-- note --> Title` 修前 `#section-title`、修後 `#section-note-title`。**註解裡的字滲進永久連結，不報錯、不會讓任何既有測試變紅。**
- reviewer 還點名了一句我認為值得記住的方法論落差：實作者 report 寫「grep 過測試檔，3 筆命中都跟 `stripHtmlTags` 無關」——**那句話是真的，但只證明「沒有測試覆蓋」，不等於「行為沒問題」**，卻用了「已確認安全」的語氣。
- Task 1: fix round 1/5 派出。**Ruling T1-1：要求實作者先評估結構性修法（剝除移進 `flattenTokenText()` 的 `html` 分支），regex 補洞當後備。** 理由：目前這版是把「文字被誤判成標籤」換成「另一類標籤被誤判成文字」，範圍縮小但沒消除，而 `<!DOCTYPE` / `<?` 還在漏。**但我要求它先量「`stripHtmlTags()` 的三個呼叫點是否一定都經過 token 分支」再決定**——若有呼叫點會拿到不經 token 的真 HTML 字串，結構修法就不可行。成本若判錯：多一輪 fix round；比放一個會污染永久連結的無聲缺陷便宜。
- Task 1: minor (deferred): report 的「已驗證安全」措辭要改成它實際證明的東西（只驗了測試覆蓋，沒驗行為）。
- **Task 1: fix round 1/5，commit `808af13`。實作者量測後推翻了我偏好的結構修法，而且理由具體**：`stripHtmlTags()` 的呼叫者不是全部經過 `flattenTokenText()` —— `appendSectionText()` 在 `collectCellText()` 有 `cell.text` 直傳的非 token 化後備支，`renderer.heading` 的 `headingText` 也有 `token.text` 後備支。把剝除移進 `html` 分支會讓這兩條路完全不跑剝除，是另一種迴歸。
- **這正是我要求「先量再決定」的價值**：我在 Ruling T1-1 裡把結構修法列為首選，量測結果說它不可行。若我直接下令照做，會用一個迴歸換掉另一個迴歸。
- 改成 regex 加 `<!--[\s\S]*?-->` 分支，三個呼叫點統一受益；`<!DOCTYPE` 與 `<?` 自陳為已知未涵蓋的缺口並寫進 code comment。
- Finding 2（report 措辭）也照改了。
- scoped re-review 已派：要求它自己跑三組驗證（註解 slug 回到 `#section-title`、原本兩個驗收 fixture 仍對、真標籤 `<b>` 仍被剝），並**獨立查證那兩條非 token 化後備支是否真的存在**。
- **re-review：兩條 findings 都 ADDRESSED，無新破壞。** re-reviewer 自己用 `node lib/md2doc.js` 跑了四組（註解 slug 回 `#section-title`、`#alpha-beta`、`#c-d-e`、`# A <b>c</b> D` → `#a-c-d` 且正文的 `<b>` 確實被剝），不是只讀報告；並逐行查證了那兩條非 token 化後備支確實存在（`collectCellText()` 的 `cell.text`、`renderer.heading` 的 `token.text`），確認 regex 補洞的選擇正確。
- **Task 1: complete（commits d80de09..808af13，review clean）**

## Task 2
- BASE `808af13`。實作者發現 **brief 裡的 `scenario()` / `LONG_DOC_WITH_TABLE` / `dragRow` 是我杜撰的 API**，改用該檔既有慣例（`setupTableDoc` / `tableBlockSel` / `rowGripCoords` / `dragRowTo`），只補四個確實不存在的小 helper。**這是我寫 plan 的老毛病第二次出現**（v3.3.0 也有十幾次「不存在的選擇器 / 死變數」），下一份 plan 寫測試片段前要先確認 helper 真的存在。
- 它另外提出一個我沒想到的機制風險：`ensureTableBurstOpen()` 自己在 burst 未開時也會對 `cells[0]` 呼叫 `focus()`，而兩個 drop 函式都先 `await` 它 —— 捲動可能來自那一次，不是 `restoreTableFocus()`。**它沒有猜，寫完重現就停。**
- 紅相 run（`runs/t2-red.log`，`808af13` + 未 commit 的測試改動）`EXIT=1`：
  `AssertionError: 拖曳不得把焦點放到表頭儲存格. Got {"scrollY":3761,"active":"TH.cell-narrow ed-wys-cell"}`
- **關鍵觀察：紅的是焦點，捲動那一條反而過了。** 斷言順序是先 `scrollY` 後 `active`，倒在 `active` ⇒ `after.scrollY === before` 成立。**也就是這個 fixture 重現了焦點缺陷，但沒有重現使用者回報的症狀（畫面跳到表頭）。**
- **Ruling T2-1：要求先補「表頭必須已捲出視窗」的前置斷言、看到捲動那一條也紅，才准套修法；且 fixture 補強與修法不得併成一次。** 理由：`focus()` 只有在元素不在視野內時才捲動，這個 fixture 沒有控制表頭是否離開視窗，所以捲動是否重現靠運氣。併成一次就分不出「修法有效」與「fixture 本來就量不到」。成本若判錯：多一輪 20 分鐘的 runtime 跑；比放行一個「測試綠了但使用者症狀還在」便宜太多。
- 順帶把它的 concern 變成可分辨的實驗：套上修法後若焦點轉綠 ⇒ 來源是 `restoreTableFocus()`；若仍紅且 `active` 還是 TH ⇒ 來源是 `ensureTableBurstOpen()`，修法要換地方。
- **紅相 round 2（`runs/t2-red2.log`）：前置斷言過了（`headerBottom < 0`），但倒在 fixture 自己的 `waitForFunction` 逾時**，不是斷言。TimeoutError 什麼都不告訴你 —— 20 分鐘換到零資訊。
- **Ruling T2-2：禁止用無界 `waitForFunction` 當作「等一個可預期的最終值」。** 改成 `drag → settle → 寬限 → 讀實際值 → assert.strictEqual`，猜錯時倒出真實值。理由：這支檔案沒有 per-scenario try/catch，一次逾時吃掉後面 350 多列，而且不留任何線索。成本若判錯：多幾百毫秒的寬限等待。
- **紅相 round 3 之前，實作者找到 fixture 對不上的真根因，而且不只我猜的那一個**：
  - `allRowsOf()` 是 `[headerRow, ...bodyRows]`，表頭在 index 0 —— 我猜對的那一半。
  - **我沒猜到的那一半**：`nearestRowDropTarget()` 用 `all.indexOf(rows[i])` 算 `dropTarget.rowIndex`，而 `rowBoundaryCoords()` 的落點在「body row afterIndex 的底部」＝「下一列中線以上」，所以生產程式碼實際拿到的是 `toIndex = afterIndex + 2`。
  - **它用 round 1 實際觀察到「過」的那個結果離線驗證了新公式**（`fromIndex=2, afterIndex=0` → `1,a,3,c,2,b`），不是再猜一次。這是正確的證偽方式。
- 它另外把兩個新場景搬到檔案最尾端，其餘約 350 支既有場景順序不動 —— 之後它自己再倒也不會擋到別人。
- **紅相 round 3 / 4：失敗點會移動，且愈來愈早。** 同一棵樹、同一條指令，三次跑：
  | run | OK 數 | 失敗 |
  |---|---|---|
  | t2-red2 | 115 | `TimeoutError: 30000ms`（實作者新 fixture，**真的算錯**，已修） |
  | t2-red3 | 115 | `TimeoutError: 3000ms` @ `hoverBodyRowCell` —— **既有 helper、既有場景** |
  | t2-red4 | **3** | `No element found: .ed-block[data-block-id="2"] .ed-handle` @ 既有場景 |
  我自己查過 diff：**純新增 +258 行、0 刪除，沒有動到任何既有行**，所以不是被改壞的。
- **根因是機器負載，不是程式碼**：`load average 27` on `nproc 16`（超額 170%），記憶體充足（17 GB available）。使用者的其他 Claude session 在跑。puppeteer 那些時序敏感的等待（grip 重定位 3000ms、元素出現）在 CPU 飢餓下隨機倒。
- **Ruling T2-3：在負載回到可用範圍之前，不再燒 20 分鐘的 runtime 跑。** 改成先做**不需要 runtime 套件**的 task —— Task 3（`toolbar-model.js`，純函式）、Task 8（`inline-md.js`，純函式）、Task 11 的第 13 項（`blockmap.js`，純函式）。Task 2 的驗證排到負載下降之後一次做掉。
  理由：三次跑三個不同失敗點，已經證明現在的 runtime 訊號不可信；繼續跑只會產生看起來像缺陷的雜訊，而且每次 20 分鐘。**在不可信的訊號上做決定，比沒有訊號更貴。**
  成本若判錯：task 完成順序與 plan 編號不同，ledger 要記清楚哪一個還沒驗。
- **Task 2: 暫停在「紅相未取得」。** 已完成：兩個場景寫好、fixture 前置條件（表頭捲出視窗）成立、`expectedRowDragOrder()` 公式已用 round 1 的實際結果離線驗證、場景搬到檔案尾端、無界 `waitForFunction` 已改成讀實際值再斷言。**`lib/editor/client.js` 一個字未動。** 未完成：看到「捲動那一條紅」，以及套修法後的綠。

## Task 3
- BASE `808af13`，commit `ee19f58`。`node test/toolbar-model.test.js` EXIT=0（346 checks）、`node test/editor-client.test.js` EXIT=0。
- **review：spec ✅、品質 approved。** reviewer 三件查證都自己走過程式碼：
  - 既有測試 22→23 的改動**是遷移不是放寬**（四處都是「釘死舊值 → 釘死新的正確值」，沒有任何斷言被移除或改弱）。
  - source 覆寫改寫後，生產碼是 `if (b.id === 'preview' || b.id === 'outline') { state[b.id].disabled = false; continue; }` —— **明確賦值後才 continue**，行為保留。
  - **實作者那條誠實揭露是對的**：reviewer 走遍主迴圈每一段會動 `disabled` 的程式碼，確認 `preview`/`outline` 全程沒有任何分支會被設成 `true`（它們本來就在 `NO_BLOCK_ALLOWED` 裡，與 `hasBlock` 無關），所以那條新斷言目前確實無法區分「明確賦值」與「巧合保留」。
  - Ruling P2 的前提成立：`!hasBlock` 迴圈在前、`state.save.disabled = !dirty` 在後且無條件覆蓋。註解有寫清楚，不提報。
- **Task 3: minor (deferred): 新增的 `srcWithBlock` 斷言區塊註解 overclaim** —— 它說換一個「有 block」的 ctx 是為了排除巧合，但 `hasBlock` 對這兩顆按鈕的 `disabled` 根本無影響，換 ctx 沒有達成聲稱的區分效果。程式碼正確，只是註解說得比報告裡的誠實揭露更自信。留給最終 review triage。
- **Task 3: complete（commits 808af13..ee19f58，review clean）**

## Task 8
- BASE `ee19f58`，commit `0e4052a`。四支純函式測試（`inline-md` / `paste-md` / `roundtrip` / `byte-stability`）全 EXIT=0。
- **實作者推翻了 backlog 對這個缺陷的描述，而且是對的。** backlog 說「產生 `\*` 跳脫」；實際上**沒有任何路徑會吐出反斜線**——真正的缺陷是兩個相鄰的同 tag 標記把星號黏成一個 CommonMark delimiter run，`marked` 重新解析，**第一個標記整個消失**。它追查出 backlog 那句 `\*` 是**寫筆記的人自己為了在散文裡顯示星號而做的 markdown 轉義**，不是對輸出位元組的主張。
- **這正好證明 Ruling P3（反向 TDD）是對的**：連症狀描述都是錯的，先釘的測試一定釘錯東西。
- **reviewer 獨立驗證並加碼**：100 個上下文暴力掃描 → **同 tag 相鄰 50/50 全壞、跨 tag 相鄰 50/50 全正常**；`<!-- -->` 代價五項全驗（4 輪固定不動點不累積、渲染看不見、不汙染 slug、實際插入 **75/12516 標記 = 0.60%**、過度插入 **1.3%** 而非實作者自陳的「一半」）；`_` 否決理由逐字驗證屬實。既有測試 **deletion 數 0**，零放寬。`byte-stability` 沒紅是因為它的 fixture 一個 em/strong 都沒有，**涵蓋範圍碰不到**，不是形狀被改。
- **Ruling T8-1：三個 Minor 破例進 fix round。** skill 規定 Minor 不進 loop，我裁定這三個現在做：
  - **commit subject 說了一件實作者自己證明不存在的事**（"stops escaping it"）——那是我 plan 裡預寫、實作者照抄的，**只有現在還沒 push 才改得動**，否則永久誤導後人。
  - 「不會累積」是整個修法能被接受的載重論證，只寫在 report 散文裡沒有測試釘住。
  - `\*` 假觸發**比真觸發更常見**（「打一個字面星號再接斜體」比「兩個標記黏在一起」自然），而 reviewer 已給出一行 regex，實作者原本以為要掃整串。
  成本若判錯：多一輪純函式測試（秒級）。
- **明令不做**：reviewer 提的「同 tag 合併」零位元組替代方案。它自己也指出那有結構性盲點——守衛是對**輸出字串**判斷，合併法要在 **DOM 上前瞻**，遇到 `<em>a</em><span></span><em>b</em>` 就得重新實作整套透明節點規則。記進 backlog 當 v3.4.x 快路徑。
- **v3.5.0 backlog 新增（reviewer 發現，out-of-scope）**：`lib/editor/paste-md.js` 的貼上路徑走 turndown，**同根因的活缺陷**，實測 `<p><em><code>code</code></em><em>text</em></p>` → `"_`code`__text_"` → 第一個 `<em>` 同樣消失。`list-md.js` 與 `table-md.js` 已查過沒有漏洞（一個 item / 一個 cell 一次 `serializeInline`，累積字串橫跨全部 sibling，守衛在那裡有效）。
- **Task 8: fix round 1/5（3 addressed, 0 open；commit amend `0e4052a` → `0bed3c8`）。** 實作者**驗過 reviewer 給的 regex 才用**（自己手構 12 組奇偶反斜線邊界），沒有直接信；Minor 2 的測試還加碼到「雙殘留 comment」。
- **re-review：三條全 ADDRESSED，無新破壞。** re-reviewer 自己重寫腳本跑（沒複用實作者留下的），三組 md 逐位元組相同收斂到同一固定點；10 組獨立奇偶邊界與實作者的 12 組交集一致；`git diff --numstat` 確認 `test/inline-md.test.js` 是 `103 insertions, 0 deletions`，零放寬。
- **Task 8: complete（commits ee19f58..0bed3c8，review clean）**
