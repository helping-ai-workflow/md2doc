# drawio viewer (vendored)

`viewer-static.min.js` 來自 diagrams.net 的官方發佈，Apache License 2.0。

- 來源：https://github.com/jgraph/drawio （`src/main/webapp/js/viewer-static.min.js`）
- 取得日期：2026-09-10
- sha256：`2fabaaa3e28d5f80f943285a2ce19c22cf870857203255f1e0347ef93693a297`
- 版本：檔案內嵌 `mxClient.VERSION="31.3.2"`（drawio/mxGraph 版本字串），可用來對應
  上游 release。**檔案本身沒有嵌入授權標頭**（開頭是 `window.PROXY_URL=...` 等
  直接可執行的 minified code，沒有 license banner 註解）——授權依據是上游
  `jgraph/drawio` repo 根目錄的 `LICENSE`（Apache-2.0），而非檔案內文字。

**它預設把 `STYLE_PATH` / `SHAPES_PATH` / `STENCIL_PATH` / `mxBasePath` /
`DRAW_MATH_URL` / `GRAPH_IMAGE_PATH` 指向 `https://viewer.diagrams.net/...`。**
`lib/drawio.js` 在載入它之前會把這些全部改寫成本機路徑——md2doc 產出的 HTML
必須完全離線可用，而且這支 viewer 根本不會進到輸出的 HTML 裡（只在建置時的
headless Chromium 內跑）。

更新時：換檔、更新上面的日期與 sha256、跑 `node test/drawio.test.js`。
