# Task 1 report

## What I did
- Baseline: run 1 red on editor-journey V3 (.ed-tb-insert not raised), unrelated flake; rerun green (exit 0).
- tokens.js: 14 direct ed-* roles; LITERAL_TO_TOKEN skips direct. md2doc.js: edit mode now runs applyReaderTheme. runtime.js place(): only moves toggle into #mobile-bar if bar is displayed.
- Tests per brief step 2 (theme.test.js x4, reader-design.test.js x1); new test/editor-click.test.js; package.json test:browser; browser.yml paths.
- Extra (not in brief): test/cli.test.js OUT_OF_BAND registry gained 'test/editor-click.test.js': 'test:browser', else npm test's guard (a test file nothing runs) fails.

## TDD RED (before implementation: node test/theme.test.js; node test/reader-design.test.js)
```
FAIL direct roles never claim a reader literal
     guard: at least one direct role exists
--
FAIL dark palette meets the spec contrast table (text >= 4.5, focus ring >= 3)
     Cannot read properties of undefined (reading 'dark')
--
FAIL theme: edit mode output carries the theme (v3.10.0)
     edit HTML lacks md2doc-theme-toggle
```
Click test RED against pre-change lib (MD2DOC_ENGINES=chromium node test/editor-click.test.js theme:):
```
FAIL [chromium] theme: on a phone the toggle stays visible in edit mode
     locator.boundingBox: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('#md2doc-theme-toggle')[22m

2 of 2 editor click check(s) failed
```

## GREEN
```
node test/theme.test.js -> theme: 10 checks passed
node test/reader-design.test.js -> edit-mode theme check ok
node test/editor-click.test.js theme: -> editor-click: 4 checks passed (2 checks x chromium,webkit)
backtick count -> 352 4 (unchanged); node bin/md2doc.js render exit 0
rtk proxy npm test -> exit 0 (second run; first run red on unrelated editor-journey list-item Ctrl+Z 'got betaLIWOR', flake, not reproduced)
```

## Files changed
 .github/workflows/browser.yml |   2 +
 lib/md2doc.js                 |   4 +-
 lib/theme/runtime.js          |   5 +-
 lib/theme/tokens.js           |  19 ++++++-
 package.json                  |   2 +-
 test/cli.test.js              |   2 +-
 test/editor-click.test.js     | 112 ++++++++++++++++++++++++++++++++++++++++++
 test/reader-design.test.js    |   6 ++-
 test/theme.test.js            |  20 ++++++--
 9 files changed, 160 insertions(+), 12 deletions(-)

## Concerns
- Two different editor-journey flakes seen in baseline run 1 (V3) and post-change run 1 (list item Ctrl+Z); both green on rerun. Beyond the known F6 flake.
- Edit-mode CSS does not use the ed-* variables yet and .ed- rules are still skipped by SKIP_SELECTOR; that is Task 3 per the brief. Task 1 check only asserts body bg dark and toggle visible.
