'use strict';
const fs = require('fs');
const path = require('path');
const { createEditorServer } = require('./server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

async function startEditSession({ files, port = null, open = true, quiet = false }) {
  const srv = await createEditorServer({
    files,
    clientJs: CLIENT_SRC,
    listenPort: port === null ? 0 : port,
  });
  const urls = files.map((f) => srv.urlFor(f));
  for (const u of urls) process.stdout.write(u + '\n');
  if (open) {
    const { openViewer } = require('./open.js');
    for (const u of urls) openViewer(u);
  }
  srv.server.on('close', () => process.exit(0));
  return srv;
}
module.exports = { startEditSession };
