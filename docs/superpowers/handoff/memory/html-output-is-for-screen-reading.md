---
name: html-output-is-for-screen-reading
description: md2doc 的 HTML 輸出是給人在螢幕上閱讀的；版面／配色決策不能拿「適合列印」當理由
metadata:
  node_type: memory
  type: project
  originSessionId: cc552bfe-c005-4ece-b528-ad08d7b94e52
  modified: 2026-09-30T17:37:30.372Z
---

md2doc 的 HTML 輸出定位是**螢幕閱讀**。設計取捨要以螢幕上的可讀性為準，參考對象也要選螢幕閱讀導向的文件網站（GitHub、Docusaurus、Material for MkDocs、mermaid 官網、WHATWG、RFC HTML 版），不要選以列印為考量的範例。PDF 輸出另外處理（`@media print`）。

**Why:** 2026-10-01 版面審查第 5 項，我以 mermaid 官方文件說 neutral「great for black-and-white documents that will be printed」為理由推薦 neutral；使用者回覆：「你再找找其他參考，html 肯定是為了閱讀用，而不是列印考量」。

**How to apply:** 提出 md2doc HTML 的設計選項時，理由要落在螢幕閱讀（對比、追蹤線條、掃讀、互動）；列印只在明確討論 PDF／`@media print` 時才當作理由。

相關：[[design-options-need-rendered-examples]]
