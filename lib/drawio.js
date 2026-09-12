'use strict';

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

module.exports = { isDrawioXml, pageNamesOf, resolvePageIndex };
