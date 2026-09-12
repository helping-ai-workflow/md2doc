'use strict';

const path = require('path');

// drawio (.drawio / .xml) 來源的判別與頁面解析。
//
// 這一支刻意不碰 marked、不碰瀏覽器 —— 判別與頁名是純字串處理，可以用純函式
// 測；真的需要 headless Chromium 的只有 bakeDrawioSvg()（見同檔下方）。
//
// 為什麼不用 XML parser：md2doc 不引進新的 runtime 依賴，而這裡要回答的問題
// （根元素是什麼、有哪些 <diagram name>）用受控的 regex 就夠。輸入是本機檔案
// 而不是網路內容，且判別失敗的後果是「當成普通圖片、原樣留著」——不是安全邊界。

// 開頭的 XML 宣告、DOCTYPE、註解、空白都要跳過，才看得到真正的根元素。
const LEADING_NOISE = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/;

// 根元素判別：兩處（isDrawioXml / pageNamesOf）共用同一顆函式，避免各自維護
// 一份「跳過前導雜訊」的 regex 而在 DOCTYPE / 自我封閉標籤上悄悄長歪。
//
// 標籤後面接的字元用 `[\s\/>]` 而不是 `[\s>]`：自我封閉的 `<mxfile/>` 或
// `<mxGraphModel/>`（沒有任何屬性、也沒有子節點）在真實檔案裡少見，但一旦
// 出現，`[\s>]` 會因為下一個字元是 `/` 而漏判成「不是 drawio」——用
// `foo(root, 'not a diagram')` 這種輸入實測會踩到。同時要擋掉
// `<mxfilex>` / `<mxGraphModelFoo>` 這種前綴相同、但其實是別的標籤的輸入，
// 所以字元類仍然是白名單而不是「以 mxfile 開頭就算」。
function rootKindOf(text) {
  const rest = String(text || '').replace(LEADING_NOISE, '');
  if (/^<mxfile[\s\/>]/.test(rest)) return 'mxfile';
  if (/^<mxGraphModel[\s\/>]/.test(rest)) return 'mxGraphModel';
  return null;
}

function isDrawioXml(text) {
  return rootKindOf(text) !== null;
}

function pageNamesOf(text) {
  const s = String(text || '');
  if (rootKindOf(s) !== 'mxfile') {
    // <mxGraphModel> 直接當一頁，沒有名字。
    return [''];
  }
  const names = [];
  const re = /<diagram\b([^>]*)>/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const nameAttr = /\bname\s*=\s*"([^"]*)"/.exec(m[1]);
    names.push(nameAttr ? nameAttr[1] : '');
  }
  return names.length ? names : [''];
}

function resolvePageIndex(names, fragment) {
  const frag = String(fragment == null ? '' : fragment);
  if (!frag) return 0;
  const byName = names.indexOf(frag);
  if (byName >= 0) return byName;
  if (/^\d+$/.test(frag)) {
    const n = Number(frag);
    if (n >= 1 && n <= names.length) return n - 1;
  }
  return 0;
}

const VIEWER_PATH = path.join(__dirname, '..', 'vendor', 'drawio', 'viewer-static.min.js');

// 每一頁烤成一份 SVG。
//
// 為什麼是 headless Chromium 而不是 Node 裡的某個函式庫：drawio 的版面
// 計算（自動換行、文字度量、stencil 形狀）依賴真正的瀏覽器排版引擎，
// 沒有等價的 Node 實作。md2doc 已經有 puppeteer（PDF 匯出在用），所以這
// 不是新依賴。
//
// 六個遠端路徑預設值必須在 viewer 載入之前就改寫掉。viewer 自己的第一行
// 是 `window.PROXY_URL = window.PROXY_URL || "https://viewer.diagrams.net/proxy"`
// 這種形式 —— `||` 代表先設好的值會勝出，所以 addScriptTag 之前先 evaluate。
async function bakeDrawioSvg(xmlText, opts) {
  const o = opts || {};
  const names = pageNamesOf(xmlText);
  let browser = o.browser;
  let ownBrowser = false;
  if (!browser) {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--disable-crash-reporter', '--disable-dev-shm-usage'],
    });
    ownBrowser = true;
  }
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(() => {
      // 全部指向 about:blank 之下的相對路徑：viewer 取不到就用內建的
      // 基本形狀，而不是去打網路。md2doc 的輸出必須離線可用。
      window.PROXY_URL = '';
      window.STYLE_PATH = '';
      window.SHAPES_PATH = '';
      window.STENCIL_PATH = '';
      window.DRAW_MATH_URL = '';
      window.GRAPH_IMAGE_PATH = '';
      window.mxImageBasePath = '';
      window.mxBasePath = '';
      window.mxLoadStylesheets = false;
      window.mxLoadResources = false;
    });
    await page.addScriptTag({ path: VIEWER_PATH });

    const out = [];
    for (let i = 0; i < names.length; i++) {
      const svg = await page.evaluate((xml, pageIndex) => {
        const el = document.createElement('div');
        el.className = 'mxgraph';
        // width 不設會讓 GraphViewer 把圖縮到容器寬度。
        el.setAttribute('data-mxgraph', JSON.stringify({
          xml: xml, page: pageIndex, highlight: '#0000ff',
          toolbar: null, resize: true, nav: false,
        }));
        document.body.appendChild(el);
        window.GraphViewer.createViewerForElement(el);
        const svgEl = el.querySelector('svg');
        const html = svgEl ? svgEl.outerHTML : null;
        el.remove();
        return html;
      }, xmlText, i);

      if (!svg) {
        throw new Error('drawio viewer produced no SVG for page ' + (i + 1) +
          ' (' + (names[i] || 'unnamed') + ')');
      }
      out.push(svg);
    }
    return out;
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

module.exports = { isDrawioXml, pageNamesOf, resolvePageIndex, bakeDrawioSvg };
