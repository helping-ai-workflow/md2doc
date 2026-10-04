---
name: ok-update-repo-means-full-release
description: 「OK 更新 repo」在 md2doc 是完整發版授權（merge + tag + npm publish），不是只 push 分支
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5c32b8c5-0dff-4836-8cfe-e15c23f086f5
  modified: 2026-09-13T11:08:11.432Z
---

使用者說「OK 更新 repo」時，要執行到底：push 分支 → 更新/開 PR → merge 到 `main` →
`npm version <bump>` → push `main` 與 tag → tag 觸發 `.github/workflows/publish.yml`
自動發到公開 npm。不要停在 push 分支然後問「要不要發版？」。

**Why:** 2026-09-13 的 v3.4.0，我把「OK 更新 repo」讀成只 push + 開 PR，停下來等授權；
使用者回「OK 更新 repo 應該自動 release + npm 發布」。先前 session 也發生過一次——
那次是使用者另外補一句「你直接發版」才動，我把那兩句當成兩道獨立授權，其實只是同一件事。

**How to apply:** 接到這句就跑完整流程。發版前仍要確認的事（這些是流程的一部分，不是
再問一次授權）：CI 綠、worktree 乾淨、CHANGELOG 該版段落的標題從「未發布」改成發版日期
（`## vX.Y.Z — YYYY-MM-DD`，跟前幾版同格式）。merge 用 `--merge` 保留逐顆 commit
（repo 既有 5 個 PR 都是 merge commit，不是 squash）。`npm version` 的 commit message
維持 `chore: release v%s` 裸格式、不加 Co-Authored-By，與 v3.3.0 一致。
永遠不要手跑 `npm publish`——會跟 GitHub Action 搶。
