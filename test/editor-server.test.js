'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { createEditorServer, assertBlockRangesFit } = require('../lib/editor/server.js');

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p,
        headers: data ? { 'content-type': 'application/json' } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// v3.4.0 batch2 Task 6 fix round 1 (review F3): every tab gets its own
// staleness baseline, minted by GET /edit/:id and handed to the page inside
// window.__ED__. A ping that does not carry it has no baseline to interpret
// and is answered with the old bare 204, so every staleness assertion below
// has to speak as a real tab does.
function clientIdOf(pageBody) {
  const m = /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(pageBody);
  assert.ok(m, 'the edit page must embed window.__ED__');
  const ed = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  assert.ok(typeof ed.drawioClientId === 'string' && ed.drawioClientId.length > 0,
    'GET /edit/:id must mint this tab its own drawio staleness client id, got ' +
    JSON.stringify(ed.drawioClientId));
  return ed.drawioClientId;
}

// Opens a real long-lived HTTP connection to GET /api/alive, mirroring what
// a browser's EventSource does on the wire (a GET, headers arrive, the body
// never ends). Resolves once the response headers land; `.close()` aborts
// the underlying socket, which is what a closed/navigated-away tab does —
// the server sees this as the response's own 'close' event, exactly the
// event a real dropped EventSource produces.
function openAlive(port, fileId, clientId) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: 'GET',
        path: '/api/alive?fileId=' + fileId + '&clientId=' + encodeURIComponent(clientId) },
      (res) => {
        res.on('data', () => {}); // drain keepalive comments; never 'end's on its own
        resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() });
      });
    r.on('error', reject);
    const req = r;
    r.end();
  });
}

// Waits for server.js's 'md2doc-auto-close' event (the same signal cli.js
// listens on to print its exit line) or times out with a rejection that
// names what was waited for — never a silent hang.
function waitForAutoClose(server, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for: ' + label)), timeoutMs);
    server.once('md2doc-auto-close', (reason) => { clearTimeout(t); resolve(reason); });
  });
}

// Asserts NO 'md2doc-auto-close' fires within `ms` — the negative-space
// assertion the "must stay alive" scenarios need. Resolves with nothing;
// throws (via the caller's own assert) only if a caller checks a captured
// flag, so every call site here pairs it with an explicit reason to fail on.
function assertNoAutoCloseFor(server, ms) {
  return new Promise((resolve, reject) => {
    const onClose = (reason) => reject(new Error('md2doc-auto-close fired unexpectedly, reason=' + reason));
    server.once('md2doc-auto-close', onClose);
    setTimeout(() => { server.removeListener('md2doc-auto-close', onClose); resolve(); }, ms);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-srv-'));
  const mdPath = path.join(dir, 'doc.md');
  const original = '# H\n\n| A |\n|---|\n| 1 |\n';
  fs.writeFileSync(mdPath, original, 'utf8');

  const srv = await createEditorServer({ files: [mdPath], clientJs: '/*client*/' });
  try {
    // page
    const page = await req(srv.port, 'GET', '/edit/0');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('window.__ED__'));
    assert.ok(page.body.includes('"lines"'));
    assert.ok(page.body.includes('ed-block'));
    assert.ok(page.body.includes('md2docInlineMd'), 'Task 3: inline-md runtime inlined');
    assert.ok(page.body.includes('md2docTableMd'), 'Task 5: table-md runtime inlined');
    assert.ok(page.body.indexOf('md2docInlineMd') < page.body.indexOf('md2docTableMd'),
      'inline-md must be injected before table-md (table-md require()s it in node / reads it off window in the browser)');
    assert.ok(page.body.includes('md2docListMd'), 'Task 4: list-md runtime inlined');
    assert.ok(page.body.indexOf('md2docInlineMd') < page.body.indexOf('md2docListMd'),
      'inline-md must be injected before list-md (list-md reads window.md2docInlineMd in the browser)');
    assert.ok(page.body.includes('md2docHistory'), 'Phase 3 Task 1/2: burst-history runtime inlined');
    assert.ok(page.body.indexOf('md2docTableMd') < page.body.indexOf('md2docHistory'),
      'table-md must be injected before history.js (per the Phase 3 injection order: lineops, inline-md, table-md, list-md, history, client)');
    assert.ok(page.body.indexOf('md2docListMd') < page.body.indexOf('md2docHistory'),
      'list-md must be injected before history.js (same injection-order rule)');
    assert.ok(page.body.indexOf('md2docHistory') < page.body.indexOf('/*client*/'),
      'history.js must be injected before the client runtime (client depends on window.md2docHistory)');
    assert.ok(page.body.indexOf('md2docTableMd') < page.body.indexOf('/*client*/'),
      'table-md must be injected before the client runtime (client depends on window.md2docTableMd)');
    assert.ok(page.body.indexOf('md2docListMd') < page.body.indexOf('/*client*/'),
      'list-md must be injected before the client runtime (client depends on window.md2docListMd)');
    assert.ok(page.body.includes('/*client*/'), 'client runtime inlined');
    assert.strictEqual(page.headers['cache-control'], 'no-store',
      'edit page must never be cached — it embeds a code+mtime snapshot');

    // injection must land at the DOCUMENT's closing </body>, not the first
    // literal "</body>" in the page — a mermaid-bearing doc inlines the
    // mermaid bundle whose DOMPurify source contains "</body>" inside a JS
    // string; replacing the first occurrence splices __ED__ into the middle
    // of that bundle and kills every script on the page.
    {
      const mermaidMd = path.join(dir, 'mermaid-doc.md');
      fs.writeFileSync(mermaidMd,
        '# M\n\n```mermaid\ngraph TD; a-->b;\n```\n\ntail paragraph\n', 'utf8');
      const srv2 = await createEditorServer({ files: [mermaidMd], clientJs: '/*client*/' });
      try {
        const p2 = await req(srv2.port, 'GET', '/edit/0');
        assert.strictEqual(p2.status, 200);
        const edAt = p2.body.indexOf('window.__ED__');
        assert.ok(edAt !== -1, 'payload injected');
        const lastEngine = p2.body.lastIndexOf('data-md2doc-diagram-engine=');
        assert.ok(edAt > lastEngine,
          '__ED__ must be injected after the last inlined diagram bundle, ' +
          'not spliced into it (first-"</body>"-occurrence bug)');
        // and the real closing tag still follows the injection
        assert.ok(p2.body.lastIndexOf('</body>') > edAt, 'real </body> after inject');
      } finally {
        srv2.close();
      }
    }

    // whitelist
    assert.strictEqual((await req(srv.port, 'GET', '/edit/1')).status, 404);
    assert.strictEqual((await req(srv.port, 'GET', '/edit/../etc')).status, 404);

    // render
    const rr = await req(srv.port, 'POST', '/api/render',
      { fileId: 0, content: 'just text\n' });
    assert.strictEqual(rr.status, 200);
    const rj = JSON.parse(rr.body);
    // v3.2.0: bodyHtml is gone from the wire — reconstitute it the same way
    // the client does (parts.join('\n')) to keep this assertion's coverage.
    assert.ok(rj.parts.join('\n').includes('data-block-id="0"'));
    assert.strictEqual(rj.blocks.length, 1);

    // v3.2.0: /api/render 回 { parts, blocks }，不再回 bodyHtml
    {
      const res = await req(srv.port, 'POST', '/api/render', { fileId: 0, content: '# H\n\n- a\n- b\n' });
      assert.strictEqual(res.status, 200, '/api/render 應為 200');
      const body = JSON.parse(res.body);
      assert.strictEqual(Array.isArray(body.parts), true, '/api/render 必須回 parts');
      assert.strictEqual(body.parts.length, body.blocks.length,
        '/api/render 的 parts 與 blocks 必須 1:1');
      assert.strictEqual('bodyHtml' in body, false,
        '/api/render 不再回 bodyHtml——client 端以 parts.join(\'\\n\') 還原');
    }

    // save happy path — byte identity
    const mtime0 = fs.statSync(mdPath).mtimeMs;
    const edited = original.replace('# H', '# H2');
    const sr = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: edited, baseMtimeMs: mtime0 });
    assert.strictEqual(sr.status, 200);
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), edited);
    const mtime1 = JSON.parse(sr.body).mtimeMs;

    // save conflict — external touch
    fs.writeFileSync(mdPath, edited + '\n<!-- vim was here -->\n');
    const cr = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: '# clobber\n', baseMtimeMs: mtime1 });
    assert.strictEqual(cr.status, 409);
    assert.ok(fs.readFileSync(mdPath, 'utf8').includes('vim was here'),
      'conflicting save must not touch the file');

    // no tmp litter
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('md2doc-tmp')));

    // ping (needs a body so the `req` helper sends content-type — see
    // Finding 3: /api/ping now requires application/json like the other
    // state-changing POST routes)
    assert.strictEqual((await req(srv.port, 'POST', '/api/ping', {})).status, 204);

    // Finding 3(a): missing/wrong content-type on a state-changing POST → 415
    for (const p of ['/api/render', '/api/save', '/api/ping']) {
      const bare = await new Promise((resolve, reject) => {
        const r = http.request(
          { host: '127.0.0.1', port: srv.port, method: 'POST', path: p, headers: {} },
          (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
          });
        r.on('error', reject);
        r.end();
      });
      assert.strictEqual(bare.status, 415, p + ' without content-type must 415');
    }
    const wrongCt = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/render',
          headers: { 'content-type': 'text/plain' } },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
        });
      r.on('error', reject);
      r.write(JSON.stringify({ fileId: 0, content: 'x' }));
      r.end();
    });
    assert.strictEqual(wrongCt.status, 415, 'wrong content-type must also 415');

    // Multi-chunk UTF-8 integrity: a large CJK payload arrives split across
    // many TCP chunks; per-chunk `buf += chunk` decoding corrupts any
    // multi-byte character that straddles a chunk boundary into U+FFFD.
    // Regression for the real-world zero-edit save that mangled 9 CJK chars
    // in a 6.5MB design-doc. Payload must be big enough to span chunks.
    {
      const cjkLine = '全 IP 唯一的 CRC-32 datapath，訊號取樣於單一 `clk_tx` 時脈域。終點落在 IP 邊界（統計事件、safety 匯流排）。';
      const bigCjk = ('# 大檔\n\n' + (cjkLine + '\n').repeat(20000));
      const mtimeBig = fs.statSync(mdPath).mtimeMs;
      const okBig = await req(srv.port, 'POST', '/api/save',
        { fileId: 0, content: bigCjk, baseMtimeMs: mtimeBig });
      assert.strictEqual(okBig.status, 200, 'large CJK save must succeed');
      const written = fs.readFileSync(mdPath, 'utf8');
      assert.ok(!written.includes('�'),
        'multi-chunk CJK payload must not contain U+FFFD replacement chars');
      assert.strictEqual(written, bigCjk,
        'large CJK payload must be written byte-identical');
      // restore the small doc for the following cases
      fs.writeFileSync(mdPath, fs.readFileSync(mdPath, 'utf8').slice(0, 0) + edited + '\n<!-- vim was here -->\n', 'utf8');
    }

    // Finding 3(b): /api/save without baseMtimeMs → 400, file left untouched
    const beforeMissing = fs.readFileSync(mdPath, 'utf8');
    const missingBase = await req(srv.port, 'POST', '/api/save',
      { fileId: 0, content: '# should not land\n' });
    assert.strictEqual(missingBase.status, 400, 'save without baseMtimeMs must 400');
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), beforeMissing,
      'save without baseMtimeMs must not touch the file');
  } finally {
    srv.close();
  }

  // EOL preservation: CRLF file
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-'));
    const mdPath = path.join(dir, 'crlf.md');
    fs.writeFileSync(mdPath, '# H\r\n\r\npara\r\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const html = await (await fetch(srv.urlFor(mdPath))).text();
      const m = /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(html);
      assert.ok(m, '__ED__ payload must be present');
      const ed = JSON.parse(m[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(ed.eol, '\r\n', 'a CRLF file must report eol === CRLF');
      assert.ok(ed.lines.every((l) => l.indexOf('\r') === -1),
        'lines must never carry a trailing \\r, got: ' + JSON.stringify(ed.lines));
      assert.deepStrictEqual(ed.lines, ['# H', '', 'para', '']);
    } finally { srv.close(); }
    console.log('server: CRLF file splits without \\r and reports eol — OK');
  }
  // EOL preservation: LF file
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-lf-'));
    const mdPath = path.join(dir, 'lf.md');
    fs.writeFileSync(mdPath, '# H\n\npara\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const html = await (await fetch(srv.urlFor(mdPath))).text();
      const ed = JSON.parse(/window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(html)[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(ed.eol, '\n');
    } finally { srv.close(); }
    console.log('server: LF file reports eol === LF — OK');
  }
  // EOL preservation: MIXED file — the PRIMARY eol wins (final review I3).
  // The detector used to be `indexOf('\r\n') !== -1 ? '\r\n' : '\n'`, i.e.
  // "any CRLF anywhere wins": one stray CRLF line in a 10,000-line LF file
  // rewrote all 10,000 lines to CRLF on the first save, contradicting spec
  // §3.11 item 4 ("lines outside the commit range keep their bytes"). A
  // majority vote confines the damage to the minority lines instead.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-mixed-'));
    const mdPath = path.join(dir, 'mixed.md');
    // 5 LF terminators vs 1 CRLF terminator -> LF must win.
    fs.writeFileSync(mdPath, '# H\n\npara one\r\npara two\npara three\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const ed = JSON.parse(
        /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(
          await (await fetch(srv.urlFor(mdPath))).text())[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(ed.eol, '\n',
        'a mixed file whose MAJORITY terminator is LF must report eol === LF, got: ' +
        JSON.stringify(ed.eol));
      assert.ok(ed.lines.every((l) => l.indexOf('\r') === -1),
        'lines must never carry a trailing \\r even in a mixed file, got: ' + JSON.stringify(ed.lines));
    } finally { srv.close(); }
    console.log('server: mixed-EOL file reports the MAJORITY eol — OK');
  }
  // ...and the mirror case: a CRLF-majority file with one stray LF line.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-mixed-crlf-'));
    const mdPath = path.join(dir, 'mixed-crlf.md');
    fs.writeFileSync(mdPath, '# H\r\n\r\npara one\npara two\r\npara three\r\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const ed = JSON.parse(
        /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(
          await (await fetch(srv.urlFor(mdPath))).text())[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(ed.eol, '\r\n',
        'a mixed file whose MAJORITY terminator is CRLF must report eol === CRLF, got: ' +
        JSON.stringify(ed.eol));
    } finally { srv.close(); }
    console.log('server: mixed-EOL file with a CRLF majority reports CRLF — OK');
  }

  // T7: BARE CR (classic-Mac terminator). marked's preprocess normalises a
  // lone \r to \n, so blockmap.js hands back one block per logical line —
  // while /\r\n|\n/ does not split it and `lines` stays a single element.
  // The two halves of the payload then disagree about what line 2 is, and
  // the first commit against line 1 splices past the end of `lines`,
  // deleting the rest of the file. Measured on '# H\rpara\r': blocks say
  // heading@1 + paragraph@2, lines said ['# H\rpara\r'].
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-cr-'));
    const mdPath = path.join(dir, 'cr.md');
    fs.writeFileSync(mdPath, '# H\rpara\r', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const html = await (await fetch(srv.urlFor(mdPath))).text();
      const m = /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(html);
      assert.ok(m, '__ED__ payload must be present for a bare-CR file');
      const ed = JSON.parse(m[1].replace(/\\u003c/g, '<'));
      assert.deepStrictEqual(ed.lines, ['# H', 'para', ''],
        'a bare \\r must split a line, exactly as marked treats it, got: ' +
        JSON.stringify(ed.lines));
      assert.ok(ed.lines.every((l) => l.indexOf('\r') === -1),
        'lines must never carry a \\r, got: ' + JSON.stringify(ed.lines));
      const maxEnd = ed.blocks.reduce((n, b) => (b.endLine > n ? b.endLine : n), 0);
      assert.ok(maxEnd <= ed.lines.length,
        'no block may address a line beyond `lines` — got endLine ' + maxEnd +
        ' for ' + ed.lines.length + ' lines: ' + JSON.stringify(ed.blocks));
      // And the whole point: the paragraph's own line is addressable.
      const para = ed.blocks.find((b) => b.type === 'paragraph');
      assert.strictEqual(ed.lines[para.startLine - 1], 'para',
        'the paragraph block must address the line that actually holds it');
      // A file whose MAJORITY terminator is a bare CR keeps CR on save —
      // same §3.11(4) reasoning the CRLF/LF majority vote above exists for:
      // now that \r splits, an LF default would rewrite every line of a
      // classic-Mac file on the first save.
      assert.strictEqual(ed.eol, '\r',
        'a CR-majority file must report eol === CR, got: ' + JSON.stringify(ed.eol));
    } finally { srv.close(); }
    console.log('server: bare-CR file splits like marked does and keeps its blocks in range — OK');
  }

  // The invariant itself, addressed directly: the two halves of the payload
  // are built by different machinery (marked's tokeniser vs a regex split),
  // so a future divergence must be loud rather than silent.
  {
    assert.strictEqual(
      assertBlockRangesFit([{ startLine: 1, endLine: 2 }], ['a', 'b']), undefined,
      'an in-range block map must pass silently');
    assert.throws(
      () => assertBlockRangesFit([{ startLine: 1, endLine: 3 }], ['a', 'b']),
      /out of range/,
      'a block addressing a line past the end of `lines` must throw, not ship');
    console.log('server: block-map/lines range invariant is enforced — OK');
  }

  // T7 fix round 1 (LOW-3): a CR/CRLF TIE goes to LF. The majority-vote
  // comment promises "平手時取 LF"; `crlfCount >= bareCr` handed the tie to
  // CRLF and contradicted it. Nothing else moves — a pure-CRLF file has
  // bareCr === 0, so the strict comparison is still true there.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-eol-tie-'));
    const mdPath = path.join(dir, 'tie.md');
    // 2 CRLF, 2 bare CR, 0 bare LF.
    fs.writeFileSync(mdPath, '# H\r\n\rpara\r\n\rx', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const ed = JSON.parse(
        /window\.__ED__ = (\{[\s\S]*?\})<\/script>/.exec(
          await (await fetch(srv.urlFor(mdPath))).text())[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(ed.eol, '\n',
        'a CR/CRLF tie must fall through to LF, as the majority-vote comment says, got: ' +
        JSON.stringify(ed.eol));
    } finally { srv.close(); }
    console.log('server: a CR/CRLF terminator tie falls through to LF — OK');
  }

  // Finding 2: createEditorServer with a listenPort already occupied by
  // another server must REJECT the returned promise (a catchable rejection,
  // the same shape bin's --edit `.catch` handles), not crash the process
  // with an uncaught 'error' event.
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-srv2-'));
    const mdPath2 = path.join(dir2, 'doc2.md');
    fs.writeFileSync(mdPath2, '# pinned\n', 'utf8');

    const srvA = await createEditorServer({ files: [mdPath2], clientJs: '' });
    try {
      let rejected = null;
      try {
        await createEditorServer({ files: [mdPath2], clientJs: '', listenPort: srvA.port });
      } catch (e) {
        rejected = e;
      }
      assert.ok(rejected, 'listenPort collision must reject, not throw uncaught');
      assert.strictEqual(rejected.code, 'EADDRINUSE');
      // server A must still be alive/serving — the collision must not have
      // taken down the process or the first server.
      const stillAlive = await req(srvA.port, 'GET', '/edit/0');
      assert.strictEqual(stillAlive.status, 200);
    } finally {
      srvA.close();
    }
  }

  // v3.4.0 batch2 Task 6 (Ruling B2-2): the /api/ping heartbeat doubles as a
  // staleness check for every `.drawio`/`.xml` file the currently open
  // document references — see server.js's own comment on why this rides the
  // existing heartbeat instead of a new transport.

  // (a) A document with NO drawio references must not pay anything extra:
  // the ping fast path must issue ZERO fs.statSync calls (not just "be fast"
  // — a direct, mechanical proof of the "(a) 沒有 drawio 的文件，心跳不得變
  // 重" requirement), and must still answer plain 204 exactly as before.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-drawio-none-'));
    const mdPath = path.join(dir, 'plain.md');
    fs.writeFileSync(mdPath, '# No drawio here\n\nJust a paragraph.\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const page = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(page.status, 200);
      const cid = clientIdOf(page.body);

      const origStatSync = fs.statSync;
      let statCalls = 0;
      fs.statSync = function (...args) { statCalls++; return origStatSync.apply(fs, args); };
      let t0, t1;
      try {
        t0 = process.hrtime.bigint();
        for (let i = 0; i < 20; i++) {
          const r = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
          assert.strictEqual(r.status, 204, 'a drawio-free doc must still get a bare 204');
          assert.strictEqual(r.body, '', '204 must carry no body');
        }
        t1 = process.hrtime.bigint();
      } finally {
        fs.statSync = origStatSync;
      }
      assert.strictEqual(statCalls, 0,
        '(a): a document with no drawio refs must trigger ZERO fs.statSync calls ' +
        'from the ping handler — got ' + statCalls + ' over 20 pings');
      const avgMs = Number(t1 - t0) / 1e6 / 20;
      console.log('server: (a) no-drawio ping — statSync calls=0, avg ' +
        avgMs.toFixed(3) + 'ms/ping over 20 pings — OK');
    } finally {
      srv.close();
    }
  }

  // (main path) A referenced .drawio file changing on disk is picked up: the
  // heartbeat reports {stale:true} once the mtime moves, and a re-render of
  // the SAME markdown content (the existing /api/render path — no new
  // endpoint) reflects the new file contents.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-drawio-live-'));
    const mdPath = path.join(dir, 'diagram.md');
    const drawioPath = path.join(dir, 'single.drawio');
    const v1 = fs.readFileSync(path.join(__dirname, 'fixtures', 'single.drawio'), 'utf8');
    const v2 = v1.replace('SINGLE_BOX', 'CHANGED_BOX');
    assert.notStrictEqual(v1, v2, 'fixture must actually contain the string being replaced');
    fs.writeFileSync(drawioPath, v1, 'utf8');
    const mdSrc = '# Diagram\n\n![d](single.drawio)\n';
    fs.writeFileSync(mdPath, mdSrc, 'utf8');

    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const page = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(page.status, 200);
      assert.ok(page.body.includes('class="drawio'),
        'initial page must have baked the referenced .drawio file');
      const cid = clientIdOf(page.body);

      // Nothing changed yet — must stay a bare 204.
      const p0 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
      assert.strictEqual(p0.status, 204, 'unchanged drawio file must not report stale');

      const r0 = await req(srv.port, 'POST', '/api/render', { fileId: 0, content: mdSrc });
      assert.strictEqual(r0.status, 200);
      const parts0 = JSON.parse(r0.body).parts.join('\n');
      assert.ok(parts0.includes('class="drawio'), 'baseline render must contain the baked drawio block');

      // External edit — a real editor writing over the file, not through
      // this server. The (mtime, size) stamp is what checkDrawioStale()
      // compares against; writeFileSync always gives a fresh mtime.
      fs.writeFileSync(drawioPath, v2, 'utf8');

      const p1 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
      assert.strictEqual(p1.status, 200, 'a changed drawio file must be reported, not 204');
      const j1 = JSON.parse(p1.body);
      // Fix round 2 (re-review G9): the EXACT response shape is pinned again.
      // Round 1 replaced `deepStrictEqual(body, {stale:true})` with two field
      // assertions, which accept any number of extra fields — stronger on the
      // token's content, weaker on the shape, and the fix report claimed
      // otherwise. Both halves are asserted now.
      assert.deepStrictEqual(Object.keys(j1).sort(), ['stale', 'token'],
        'the stale response must carry exactly {stale, token}, got ' + p1.body);
      assert.strictEqual(j1.stale, true, 'the stale signal must still say stale, got ' + p1.body);
      assert.ok(typeof j1.token === 'string' && j1.token.length > 0,
        'fix round 1 (F2): the stale signal must carry the token the client acks with, got ' + p1.body);

      // The re-bake is available through the EXISTING /api/render path
      // (Ruling B2-2: no new endpoint) — same content in, different bytes
      // out, because renderMarkdown() always re-reads referenced files.
      const r1 = await req(srv.port, 'POST', '/api/render', { fileId: 0, content: mdSrc });
      assert.strictEqual(r1.status, 200);
      const parts1 = JSON.parse(r1.body).parts.join('\n');
      assert.notStrictEqual(parts1, parts0,
        're-rendering after the external edit must produce different baked output');

      // ── Fix round 1, review F2: the retry sequence ──────────────────────
      // This assertion USED TO read "a ping right after that render sees the
      // baseline the render just advanced — 204". That encoded exactly the
      // defect F2 names: /api/render runs BEFORE the client has decided
      // whether it can apply the result, and the client has several bail
      // paths that fire AFTER the response arrives (its DOM moved
      // mid-gesture, the user's focus is inside the block). Advancing on the
      // render meant one external change was silently dropped for the rest
      // of the session. The baseline now advances on the client's ack and on
      // nothing else.
      const p2 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
      assert.strictEqual(p2.status, 200,
        'F2: a render the client never confirmed applying must NOT advance the baseline');
      const j2 = JSON.parse(p2.body);
      assert.deepStrictEqual(Object.keys(j2).sort(), ['stale', 'token'],
        'G9: every stale response carries exactly {stale, token}, got ' + p2.body);
      assert.strictEqual(j2.stale, true, 'F2: the second heartbeat must report the same staleness again');
      assert.strictEqual(j2.token, j1.token,
        'F2: the token identifies a CONTENT VERSION, not a ping — a refresh slower than one ' +
        'beat would otherwise always ack a token the server had already superseded, got ' +
        JSON.stringify({ first: j1.token, second: j2.token }));

      // A wrong/stale ack must not advance anything either.
      const p3 = await req(srv.port, 'POST', '/api/ping',
        { fileId: 0, drawioClientId: cid, drawioAck: 'not-the-token' });
      assert.strictEqual(p3.status, 200, 'F2: an ack that does not match the pending token must not advance the baseline');

      // Second attempt succeeds: the client applied it and says so.
      const p4 = await req(srv.port, 'POST', '/api/ping',
        { fileId: 0, drawioClientId: cid, drawioAck: j1.token });
      assert.strictEqual(p4.status, 204,
        'F2: once the client confirms the DOM carries that version, the signal stops repeating');

      // ── Fix round 1, review F3: per-tab baselines ───────────────────────
      // A second tab on the SAME file opens now, with the file already at
      // v2, so it is NOT stale for that tab...
      const page2 = await req(srv.port, 'GET', '/edit/0');
      const cid2 = clientIdOf(page2.body);
      assert.notStrictEqual(cid2, cid, 'F3: each tab must get its own client id');
      const q0 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid2 });
      assert.strictEqual(q0.status, 204, 'F3: a tab painted from the current bytes is not stale');

      // ...and when the file changes again, BOTH tabs are told, not just
      // whichever one happened to ping first.
      const v3 = v2.replace('CHANGED_BOX', 'THIRD_BOX');
      assert.notStrictEqual(v3, v2, 'fixture must actually contain the string being replaced');
      fs.writeFileSync(drawioPath, v3, 'utf8');
      const a1 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
      assert.strictEqual(a1.status, 200, 'F3: tab A must be told about the change');
      const b1 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid2 });
      assert.strictEqual(b1.status, 200,
        'F3: tab B must be told too — the first tab to ping used to eat the one signal, ' +
        'leaving the second on a stale diagram that looked perfectly healthy');

      // ── Fix round 2, re-review G5: a live tab that was swept re-registers ──
      // The eviction path itself is not directly drivable here (it needs a
      // >10-minute gap), but the state it produces IS: a well-formed clientId
      // with no server-side entry. Round 1 answered that with a bare 204
      // forever — a tab that looked perfectly healthy and silently never
      // re-baked again for the life of the session, recoverable only by
      // reload, with nothing telling the user to reload.
      const ghost = 'ffffffffffffffffffffffff';
      const g1 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: ghost });
      assert.strictEqual(g1.status, 200,
        'G5: a client that is still talking to us is alive by definition — it must get a ' +
        'baseline back (seeded empty, so it re-syncs once) rather than be permanently deaf');
      const gj = JSON.parse(g1.body);
      assert.deepStrictEqual(Object.keys(gj).sort(), ['stale', 'token'],
        'G5/G9: the re-registered client gets the ordinary stale shape, got ' + g1.body);
      const g2 = await req(srv.port, 'POST', '/api/ping',
        { fileId: 0, drawioClientId: ghost, drawioAck: gj.token });
      assert.strictEqual(g2.status, 204,
        'G5: and once it acks, it converges like any other tab — one redundant re-render, ' +
        'not an endless one');

      // ── Fix round 3, re-review2 H4: bounded, and it bounds by EVICTING ──
      // Round 2 capped by REFUSING, which meant that once the map filled a
      // genuinely live tab could never re-register and went silently deaf for
      // the session — G5's own guard rail reproducing G5's symptom. The bound
      // is now least-recently-seen eviction, so the map stays bounded AND no
      // live tab is ever turned away.
      //
      // `ghost` has just acked, so it answers 204 while its entry survives.
      // That makes it a probe: if minting more ids than the cap evicts it,
      // its next ping re-registers with an empty baseline and answers 200
      // again. 204 would mean the map grew instead of evicting.
      for (let n = 0; n < 80; n++) {
        const id = ('c' + n).padEnd(24, '0');
        const r = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: id });
        assert.strictEqual(r.status, 200,
          'H4: a well-formed client must never be turned away — refusing past a cap is ' +
          'what made a swept live tab permanently deaf, got ' + r.status + ' at n=' + n);
      }
      const evicted = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: ghost });
      assert.strictEqual(evicted.status, 200,
        'H4: the least-recently-seen entry must actually be evicted, so the map cannot grow ' +
        'without bound — a 204 here would mean the oldest entry survived 80 new ones');

      // ── Fix round 1, review F8: the ping body is capped ─────────────────
      // readJson() refuses an over-limit body by destroying the socket, so
      // the client sees a connection reset rather than a status. Without the
      // cap this 64 KB body is simply accepted and answered 204 — which is
      // what makes "not 204" the assertion that can actually go red here.
      let bigStatus;
      try {
        bigStatus = (await req(srv.port, 'POST', '/api/ping',
          { fileId: 0, drawioClientId: cid, pad: 'x'.repeat(64 * 1024) })).status;
      } catch (e) {
        bigStatus = 'connection-reset: ' + String((e && e.code) || e);
      }
      assert.notStrictEqual(bigStatus, 204,
        'F8: the route that fires every 10s from every open tab must not also be the ' +
        'most permissive body limit in the server, got ' + bigStatus);

      // ── Fix round 1, review F3: an unknown client degrades to the old
      // bare 204 rather than to a signal it has no baseline to interpret.
      const nocid = await req(srv.port, 'POST', '/api/ping', { fileId: 0 });
      assert.strictEqual(nocid.status, 204,
        'a ping carrying no client id must still get the old bare 204');
    } finally {
      srv.close();
    }
    console.log('server: external .drawio edit is detected via /api/ping and re-baked via /api/render — OK');
  }

  // (b) Safe degrade: the referenced .drawio file disappears out from under
  // an open session (deleted or renamed outside the editor). Must not throw
  // anywhere in the request path, and the disappearance itself still counts
  // as "changed" for staleness purposes.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-drawio-gone-'));
    const mdPath = path.join(dir, 'diagram.md');
    const drawioPath = path.join(dir, 'single.drawio');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'single.drawio'), drawioPath);
    const mdSrc = '# Diagram\n\n![d](single.drawio)\n';
    fs.writeFileSync(mdPath, mdSrc, 'utf8');

    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      const page = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(page.status, 200);
      const cid = clientIdOf(page.body);

      fs.unlinkSync(drawioPath);

      const p1 = await req(srv.port, 'POST', '/api/ping', { fileId: 0, drawioClientId: cid });
      assert.strictEqual(p1.status, 200,
        '(b): a deleted drawio file must be reported as changed, not silently ignored');
      const j1 = JSON.parse(p1.body);
      assert.deepStrictEqual(Object.keys(j1).sort(), ['stale', 'token'],
        '(b) G9: the stale response must carry exactly {stale, token}, got ' + p1.body);
      assert.strictEqual(j1.stale, true, '(b): got ' + p1.body);
      assert.ok(typeof j1.token === 'string' && j1.token.length > 0, '(b): got ' + p1.body);

      // Must not 500 — resolveAssetPath()/drawioPlaceholderFor() already
      // degrade to "not a drawio reference" when the file cannot be found;
      // this just asserts the whole request path survives that unharmed.
      const r1 = await req(srv.port, 'POST', '/api/render', { fileId: 0, content: mdSrc });
      assert.strictEqual(r1.status, 200,
        '(b): re-rendering after the referenced file vanished must not 500');
      const parts1 = JSON.parse(r1.body).parts.join('\n');
      assert.ok(!parts1.includes('class="drawio'),
        '(b): a vanished reference must fall back to the ordinary (broken) image path, not a stale drawio block');

      // Second ping after the degraded re-render must not keep reporting
      // stale for a file that is consistently gone (stamp null -> null).
      // Fix round 1 (F2): the ack, not the render, is what closes it out —
      // the degraded render is exactly a case the client can still fail to
      // apply, and losing the "your diagram is gone" update permanently is
      // no better than losing a re-bake.
      const p2 = await req(srv.port, 'POST', '/api/ping',
        { fileId: 0, drawioClientId: cid, drawioAck: j1.token });
      assert.strictEqual(p2.status, 204,
        '(b): a consistently-missing file must not repeat the stale signal forever');
    } finally {
      srv.close();
    }
    console.log('server: a vanished .drawio reference degrades safely (no throw, no crash) — OK');
  }

  // Backward compatibility: a ping with no fileId at all (old client shape,
  // and the very first assertion earlier in this file) must still work —
  // no tracked state for `undefined` means the fast "no drawio" path.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-drawio-nofileid-'));
    const mdPath = path.join(dir, 'plain.md');
    fs.writeFileSync(mdPath, '# X\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    try {
      await req(srv.port, 'GET', '/edit/0');
      const r = await req(srv.port, 'POST', '/api/ping', {});
      assert.strictEqual(r.status, 204, 'a ping with no fileId must still bare-204');
    } finally {
      srv.close();
    }
  }

  // ==========================================================================
  // /api/asset — the .drawio / .xml insert path (v3.4.1).
  //
  // v3.4.0 taught the renderer to embed `.drawio`/`.xml`, but the INSERT path
  // was never widened: `extFor(mime)` is the only gate, and a browser reports
  // `file.type === ''` for a .drawio, so every upload died at
  // `400 unsupported image type`. Reopening it is not "widen the MIME
  // whitelist" — `image/svg+xml` stays out for the reason asset.js documents.
  // It is a SECOND gate with its own rule: the extension picks the candidate,
  // the CONTENT decides whether anything is written. Renaming a payload to
  // .xml must not be enough to put it on disk.
  // ==========================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-asset-drawio-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# D\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '' });
    const assetsDir = path.join(dir, 'assets');
    const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
    const MXFILE = '<mxfile host="app.diagrams.net">' +
      '<diagram name="Page-1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    const MXMODEL = '<mxGraphModel dx="1" dy="1"><root/></mxGraphModel>';
    const post = (body) => req(srv.port, 'POST', '/api/asset', body);
    try {
      // 1. A real .drawio lands, keeping its extension — that extension is
      //    what `drawioPlaceholderFor()` keys on downstream, so a silent
      //    rewrite to .png would render as a broken image.
      const a = await post({ fileId: 0, mime: '', name: 'flow.drawio', data: b64(MXFILE) });
      assert.strictEqual(a.status, 200, 'a real .drawio must upload: ' + a.body);
      const aPath = JSON.parse(a.body).path;
      assert.ok(/\.drawio$/.test(aPath), 'uploaded .drawio must keep its extension, got ' + aPath);
      assert.strictEqual(fs.readFileSync(path.join(assetsDir, path.basename(aPath)), 'utf8'),
        MXFILE, 'the bytes on disk must be the bytes that were sent');

      // 2. A bare <mxGraphModel> under .xml — the other root drawio writes.
      const b = await post({ fileId: 0, mime: '', name: 'model.xml', data: b64(MXMODEL) });
      assert.strictEqual(b.status, 200, 'an .xml holding <mxGraphModel> must upload: ' + b.body);
      assert.ok(/\.xml$/.test(JSON.parse(b.body).path), '.xml must keep its extension');

      // 3. Content decides. An .xml that is not drawio is refused — otherwise
      //    it lands on disk and only fails later, at render time, as a broken
      //    image beside an orphan file in the user's git tree.
      const c = await post({ fileId: 0, mime: '', name: 'notes.xml',
        data: b64('<notes><item>hello</item></notes>') });
      assert.strictEqual(c.status, 400, 'a non-drawio .xml must be refused');

      // 4. The rename attack: HTML wearing a .xml extension.
      const dres = await post({ fileId: 0, mime: '', name: 'evil.xml',
        data: b64('<html><script>alert(1)</script></html>') });
      assert.strictEqual(dres.status, 400, 'renaming HTML to .xml must not put it on disk');

      // 5. The extension is a whitelist of two literals, not "whatever the
      //    name ends with". A name the content check would pass must still be
      //    refused when its extension is one we do not serve.
      const e = await post({ fileId: 0, mime: '', name: 'x.svg', data: b64(MXFILE) });
      assert.strictEqual(e.status, 400, '.svg must stay refused even carrying drawio content');
      const f = await post({ fileId: 0, mime: '', name: 'x.html', data: b64(MXFILE) });
      assert.strictEqual(f.status, 400, '.html must stay refused even carrying drawio content');

      // 6. image/svg+xml is still refused — this change adds a second gate,
      //    it does not widen the first one.
      const g = await post({ fileId: 0, mime: 'image/svg+xml', name: 'x.svg',
        data: b64('<svg xmlns="http://www.w3.org/2000/svg"/>') });
      assert.strictEqual(g.status, 400, 'image/svg+xml must stay refused');

      // 7. Empty payload, on the new path too.
      const h = await post({ fileId: 0, mime: '', name: 'empty.drawio', data: '' });
      assert.strictEqual(h.status, 400, 'an empty .drawio payload must be refused');

      // 8. The raster path is untouched.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
      const i = await post({ fileId: 0, mime: 'image/png', name: 'dot.png',
        data: png.toString('base64') });
      assert.strictEqual(i.status, 200, 'a png must still upload: ' + i.body);
      assert.ok(/\.png$/.test(JSON.parse(i.body).path), 'png keeps its extension');

      // 9. Nothing refused above may have left anything behind.
      const landed = fs.readdirSync(assetsDir).sort();
      assert.deepStrictEqual(landed, ['dot.png', 'flow.drawio', 'model.xml'],
        'only the three accepted uploads may exist, got ' + JSON.stringify(landed));
    } finally {
      srv.close();
    }
    console.log('server: /api/asset accepts drawio .drawio/.xml by content, refuses the rest — OK');
  }

  // ==========================================================================
  // Liveness via a real connection (GET /api/alive), replacing the idle
  // timer as the signal that a browser tab is still open. A backgrounded
  // (merely unfocused) tab's setInterval ping is throttled by the browser —
  // measured on this branch at roughly once per minute once Chrome's real
  // throttling is allowed to engage (see LIVENESS-REPORT.md) — which is
  // slower than the old 30s idle deadline, so a tab the user only alt-tabbed
  // away from used to look exactly like a closed one. A held-open connection
  // is not a timer and is not subject to that clamp.
  // ==========================================================================

  // (1) A tab that stops pinging entirely but holds its /api/alive connection
  // open must NOT be closed — this is the defect itself, reproduced directly:
  // no /api/ping calls at all, for well past any old idle deadline, and the
  // session must still be alive because the connection never dropped.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-noping-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# Alive\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '', connectionGraceMs: 150 });
    try {
      const page = await req(srv.port, 'GET', '/edit/0');
      const cid = clientIdOf(page.body);
      const conn = await openAlive(srv.port, 0, cid);
      assert.strictEqual(conn.status, 200, '/api/alive must accept the connection');
      assert.strictEqual(conn.headers['content-type'], 'text/event-stream; charset=utf-8',
        '/api/alive must serve an SSE content-type, got ' + conn.headers['content-type']);

      // No /api/ping at all — wait comfortably past connectionGraceMs, the
      // old default idleTimeoutMs (30000, no longer relevant), and a margin.
      await assertNoAutoCloseFor(srv.server, 600);

      // And the server is provably still serving.
      const still = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(still.status, 200,
        '(1): a tab holding its connection open with zero pings must not be closed');
      conn.close();
    } finally {
      srv.close();
    }
    console.log('server: (1) a held-open /api/alive connection with no pings keeps the session alive — OK');
  }

  // (2) Closing the ONLY connection closes the session, after the grace
  // period — the other half of the trade: the server must still clean itself
  // up once the tab genuinely closes, not just refrain from ever closing.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-close-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# Alive\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '', connectionGraceMs: 150 });
    try {
      const page = await req(srv.port, 'GET', '/edit/0');
      const cid = clientIdOf(page.body);
      const conn = await openAlive(srv.port, 0, cid);
      assert.strictEqual(conn.status, 200);

      const closeWait = waitForAutoClose(srv.server, 5000, 'auto-close after last connection drops');
      conn.close();
      const reason = await closeWait;
      assert.strictEqual(reason, 'idle',
        '(2): the last-connection-drops close must use the same reason cli.js already prints a line for');

      // The server must actually be gone, not merely have emitted the event.
      let refused = false;
      try {
        await req(srv.port, 'GET', '/edit/0');
      } catch (e) {
        refused = true;
      }
      assert.ok(refused, '(2): after auto-close the server must actually stop accepting connections');
    } finally {
      srv.close();
    }
    console.log('server: (2) closing the only connection closes the session after the grace period — OK');
  }

  // (3) Closing ONE of TWO connections must NOT close the session — the
  // multi-tab (and by extension multi-file, since the count is global across
  // the whole server process) requirement.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-two-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# Alive\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '', connectionGraceMs: 150 });
    try {
      const pageA = await req(srv.port, 'GET', '/edit/0');
      const cidA = clientIdOf(pageA.body);
      const pageB = await req(srv.port, 'GET', '/edit/0');
      const cidB = clientIdOf(pageB.body);
      assert.notStrictEqual(cidA, cidB, 'two tab loads must mint two distinct client ids');

      const connA = await openAlive(srv.port, 0, cidA);
      const connB = await openAlive(srv.port, 0, cidB);
      assert.strictEqual(connA.status, 200);
      assert.strictEqual(connB.status, 200);

      const guard = assertNoAutoCloseFor(srv.server, 600);
      connA.close();
      await guard;

      const still = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(still.status, 200,
        '(3): closing one of two open tabs must not close the server while the other is still open');
      connB.close();
    } finally {
      srv.close();
    }
    console.log('server: (3) closing one of two connections does not close the session — OK');
  }

  // (3b) The same, but the second connection belongs to a DIFFERENT file —
  // `md2doc --edit a.md b.md` serves both from one server/session, so the
  // closing decision must be global across files, not per-file.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-multifile-'));
    const mdA = path.join(dir, 'a.md');
    const mdB = path.join(dir, 'b.md');
    fs.writeFileSync(mdA, '# A\n', 'utf8');
    fs.writeFileSync(mdB, '# B\n', 'utf8');
    const srv = await createEditorServer({ files: [mdA, mdB], clientJs: '', connectionGraceMs: 150 });
    try {
      const pageA = await req(srv.port, 'GET', '/edit/0');
      const cidA = clientIdOf(pageA.body);
      const pageB = await req(srv.port, 'GET', '/edit/1');
      const cidB = clientIdOf(pageB.body);

      const connA = await openAlive(srv.port, 0, cidA);
      const connB = await openAlive(srv.port, 1, cidB);

      const guard = assertNoAutoCloseFor(srv.server, 600);
      connA.close();
      await guard;

      const still = await req(srv.port, 'GET', '/edit/1');
      assert.strictEqual(still.status, 200,
        '(3b): closing the tab for a.md must not close the server while b.md\'s tab is still open');
      connB.close();
    } finally {
      srv.close();
    }
    console.log('server: (3b) multi-file — closing one file\'s tab does not close the session — OK');
  }

  // (4) A disconnect immediately followed by a reconnect (an F5 reload) must
  // NOT close the session — this is the trap named in the design: without a
  // grace window, every refresh would kill the session, because the old
  // connection's close and the new connection's open are two separate events
  // with a real (if small) gap between them.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-reload-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# Alive\n', 'utf8');
    const srv = await createEditorServer({ files: [mdPath], clientJs: '', connectionGraceMs: 400 });
    try {
      const page1 = await req(srv.port, 'GET', '/edit/0');
      const cid1 = clientIdOf(page1.body);
      const conn1 = await openAlive(srv.port, 0, cid1);
      assert.strictEqual(conn1.status, 200);

      const guard = assertNoAutoCloseFor(srv.server, 700); // > connectionGraceMs
      conn1.close();
      // Reconnect quickly, well inside connectionGraceMs — a fresh page load
      // mints a fresh client id, exactly like a real reload does.
      await new Promise((r) => setTimeout(r, 30));
      const page2 = await req(srv.port, 'GET', '/edit/0');
      const cid2 = clientIdOf(page2.body);
      const conn2 = await openAlive(srv.port, 0, cid2);
      assert.strictEqual(conn2.status, 200);
      await guard;

      const still = await req(srv.port, 'GET', '/edit/0');
      assert.strictEqual(still.status, 200,
        '(4): a reload (disconnect immediately followed by reconnect) must not close the session');
      conn2.close();
    } finally {
      srv.close();
    }
    console.log('server: (4) a disconnect immediately followed by a reconnect (reload) does not close — OK');
  }

  // (5) Sanity: /api/ping alone (no /api/alive connection ever made) must
  // NOT keep a session alive forever by itself once neverOpenedGraceMs has
  // elapsed and no connection ever showed up — pinging is no longer the
  // liveness mechanism. This is the mirror image of (1): (1) proves ping is
  // not NECESSARY for liveness, this proves it is not SUFFICIENT either.
  // Uses the never-opened path (unchanged, see its own comment in server.js)
  // since that is the one remaining timer-based deadline in this file.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-alive-pingonly-'));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '# Alive\n', 'utf8');
    const srv = await createEditorServer({
      files: [mdPath], clientJs: '', neverOpenedGraceMs: 300, connectionGraceMs: 60000,
    });
    try {
      // The page is fetched (marks started=true, disarming neverOpenedTimer
      // in the OLD design) — but under the new design `started` no longer
      // means "safe forever"; only an actual connection does. Pings keep
      // firing, no /api/alive connection is ever opened.
      await req(srv.port, 'GET', '/edit/0');
      const closeWait = waitForAutoClose(srv.server, 5000, 'auto-close with pings but no connection');
      const pingInterval = setInterval(() => {
        req(srv.port, 'POST', '/api/ping', {}).catch(() => {});
      }, 80);
      const reason = await closeWait;
      clearInterval(pingInterval);
      assert.ok(reason === 'idle' || reason === 'never-opened',
        '(5): a session with pings but no /api/alive connection must eventually close, got reason=' + reason);
    } finally {
      srv.close();
    }
    console.log('server: (5) pinging alone (no connection) does not keep a session alive forever — OK');
  }

  console.log('editor-server.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
