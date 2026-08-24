'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'md2doc.js');

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md2doc-cli-edit-'));
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  fs.writeFileSync(a, '# A\n');
  fs.writeFileSync(b, '# B\n');

  // flag conflicts
  for (const bad of [['--edit', a, '--pdf'], ['--edit', a, '--out', 'x.html'],
                     ['--edit', a, '--bake-svg'], ['--edit', dir]]) {
    const r = spawnSync(process.execPath, [BIN, ...bad], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `expected exit 2 for: ${bad.join(' ')}`);
  }

  // happy path: spawn, scrape URLs from stdout, hit both pages, SIGINT
  const child = spawn(process.execPath, [BIN, '--edit', a, b, '--no-open'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const urls = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('no URLs within 15s: ' + out)), 15000);
    child.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/edit\/\d+/g);
      if (m && m.length >= 2) { clearTimeout(t); resolve(m.slice(0, 2)); }
    });
  });
  try {
    const p0 = await get(urls[0]);
    assert.strictEqual(p0.status, 200);
    assert.ok(p0.body.includes('window.__ED__'));
    const p1 = await get(urls[1]);
    assert.ok(p1.body.includes('window.__ED__'));
  } finally {
    child.kill('SIGINT');
  }
  console.log('cli-edit.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
