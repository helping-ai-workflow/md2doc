---
name: never-drive-user-desktop
description: 不准操作使用者的 Windows 桌面（移滑鼠、開 Edge 視窗、powershell 驅動 GUI）；UI 驗證一律在 WSL 內用 Playwright headless 自己截圖／量測
metadata:
  type: feedback
---

驗證瀏覽器 UI（游標、配色、可見性）時，**不准**透過 powershell.exe 在使用者的 Windows 上開瀏覽器、SetCursorPos 移動滑鼠、截桌面。一律在 WSL 內用 Playwright（Chromium＋WebKit，headless）自己截圖、自己量。

**Why:** 2026-10-01 查 v3.8.0 游標看不見時，我寫了 powershell 腳本開 Edge `--app` 視窗並移動使用者滑鼠抓真實游標；使用者打斷：「請你不要操作我的電腦，你自己用 playwright 截圖啊? tripwork 設計教過你了」。之前也已明說「你自己測」——要的是 repo 內可重跑的自動化驗證，不是在使用者機器上做一次性實驗。

**How to apply:** 需要「畫面上看起來如何」的證據 → Playwright 截圖（必要時把目標狀態畫進頁面裡，例如把 cursor 圖示疊到截圖上），並把判準寫成 test/reader-click.test.js 的斷言。讀使用者環境設定（registry 等）可以，但任何會改變畫面或輸入狀態的動作都不行。

相關：[[reader-click-tests-like-tripwork]]
