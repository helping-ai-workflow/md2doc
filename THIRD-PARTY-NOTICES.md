# Third-party notices

md2doc's own source code is licensed under the MIT License — see
[`LICENSE`](LICENSE). `"license": "MIT"` in `package.json` refers to that
code and only to that code.

**The published npm package also contains code that is not md2doc's and
is not MIT.** If you are running a licence scan, this is the file you
want; the per-component detail is one level down, next to the artifact it
describes.

## Vendored at rest (inside the published tarball)

| Path | What | Licence | Detail |
|---|---|---|---|
| `vendor/drawio/viewer-static.min.js` | draw.io / diagrams.net viewer, v31.3.2, 4,151,717 bytes | **Apache License 2.0** | [`vendor/drawio/LICENSE`](vendor/drawio/LICENSE), [`vendor/drawio/NOTICE`](vendor/drawio/NOTICE) |

That single 4 MB file is a verbatim copy of
`src/main/webapp/js/viewer-static.min.js` from
[jgraph/drawio](https://github.com/jgraph/drawio) at tag `v31.3.2`
(sha256 `2fabaaa3e28d5f80f943285a2ce19c22cf870857203255f1e0347ef93693a297`).
md2doc executes it only inside a build-time headless Chromium, to turn
`.drawio` references into inline SVG; it is never emitted into output
HTML and never fetched over the network.

The Apache-2.0 text ships **inside `vendor/drawio/`**, next to the file it
covers, rather than only at the repository root — so it survives being
copied, vendored or extracted along with the artifact.

That bundle is itself not licence-homogeneous. It contains DOMPurify
3.4.13 (Apache-2.0 OR MPL-2.0), pako 2.2.0 (MIT AND Zlib), spin.js 2.0.0
(MIT) and Rough.js 4.6.6 (MIT).
[`vendor/drawio/NOTICE`](vendor/drawio/NOTICE) records each one's version,
licence, where inside the bundle it sits, **how that was established**,
and which of those findings rest on provenance rather than on a
declaration in the artifact itself.

## Runtime dependencies (installed by npm, not vendored)

md2doc's `dependencies` (marked, mermaid, wavedrom, katex, puppeteer,
turndown, `@hpcc-js/wasm-graphviz`) are ordinary npm packages: they are
resolved into your `node_modules` by your own installer, carry their own
licence files there, and are not redistributed inside md2doc's tarball.
They are out of scope for this file.
