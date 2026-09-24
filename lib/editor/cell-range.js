'use strict';
/* Table cell-range selection — the pure model.
   Spec: docs/superpowers/specs/2026-09-24-editor-cell-range-design.md.
   UMD, same shape as selection.js: require-able in node for the unit tests,
   injected into the editor page as window.md2docCellRange. Points are
   {r, c}: r indexes the table's rows with the header row as 0, c the cell
   index within that row. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.md2docCellRange = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function normalize(a, f) {
    return { top: Math.min(a.r, f.r), left: Math.min(a.c, f.c),
      bottom: Math.max(a.r, f.r), right: Math.max(a.c, f.c) };
  }

  function cellsIn(rect) {
    const out = [];
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) out.push({ r: r, c: c });
    }
    return out;
  }

  function isSingle(a, f) { return a.r === f.r && a.c === f.c; }

  const DELTA = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  function step(p, dir, rowCount, colCount) {
    const d = DELTA[dir];
    return { r: clamp(p.r + d[0], 0, rowCount - 1), c: clamp(p.c + d[1], 0, colCount - 1) };
  }

  // Excel's TSV: TAB between fields, newline between records, a field that
  // STARTS with a quote is quoted ("" inside is one quote, and it may hold
  // TABs and newlines). A trailing newline does not make an empty record.
  function parseTsv(text) {
    const s = String(text).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let field = '';
    let atStart = true;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (atStart && ch === '"') {
        i++;
        while (i < s.length) {
          if (s[i] === '"') {
            if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
            i++;
            break;
          }
          field += s[i];
          i++;
        }
        atStart = false;
        continue;
      }
      if (ch === '\t') { row.push(field); field = ''; atStart = true; i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; atStart = true; i++; continue; }
      field += ch;
      atStart = false;
      i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function quoteField(f) {
    return /[\t\n"]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f;
  }
  function toTsv(grid) {
    return grid.map((row) => row.map(quoteField).join('\t')).join('\n');
  }

  function growthNeeded(origin, grid, rowCount, colCount) {
    const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
    return { addRows: Math.max(0, origin.r + grid.length - rowCount),
      addCols: Math.max(0, origin.c + width - colCount) };
  }

  return { normalize, cellsIn, isSingle, step, parseTsv, toTsv, growthNeeded };
});