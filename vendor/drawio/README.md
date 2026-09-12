# drawio viewer (vendored)

`viewer-static.min.js` 來自 diagrams.net 的官方發佈，Apache License 2.0。

- 來源：https://github.com/jgraph/drawio （`src/main/webapp/js/viewer-static.min.js`）
- 取得日期：2026-09-10
- sha256：`2fabaaa3e28d5f80f943285a2ce19c22cf870857203255f1e0347ef93693a297`
- 版本：上游 tag `v31.3.2`（檔案內也嵌著 `mxClient.VERSION="31.3.2"`）。
  **檔案本身沒有嵌入授權標頭**（開頭是 `window.PROXY_URL=...` 等直接可執行的
  minified code，沒有 license banner 註解）——授權依據是 provenance，不是檔案
  內文字。
- 授權：`vendor/drawio/LICENSE`（Apache-2.0 全文，與上游 `jgraph/drawio` 根目錄
  的 `LICENSE` 逐位元組相同）與 `vendor/drawio/NOTICE`。**兩個檔案都必須跟著
  `viewer-static.min.js` 一起進 npm tarball**（`package.json` 的 `files` 收
  `vendor/`，整個目錄一起進去）——tarball 一旦發佈就不可變更，所以授權文字漏掉
  的話只能靠再發一版來補。`NOTICE` 裡逐項記著 bundle 內部其他第三方元件
  （DOMPurify / pako / spin.js / Rough.js）的版本、授權與「這是怎麼確認的」。

**它預設把 `STYLE_PATH` / `SHAPES_PATH` / `STENCIL_PATH` / `mxBasePath` /
`DRAW_MATH_URL` / `GRAPH_IMAGE_PATH` 指向 `https://viewer.diagrams.net/...`。**
`lib/drawio.js` 在載入它之前會把這些全部改寫成本機路徑——md2doc 產出的 HTML
必須完全離線可用，而且這支 viewer 根本不會進到輸出的 HTML 裡（只在建置時的
headless Chromium 內跑）。

更新時：換檔、更新上面的日期與 sha256、跑 `node test/drawio.test.js`。
