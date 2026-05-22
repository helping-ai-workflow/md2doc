# Changelog

All notable changes to this project will be documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
