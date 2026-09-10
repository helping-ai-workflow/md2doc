'use strict';
const fs = require('fs');
const path = require('path');
const { createEditorServer } = require('./server.js');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

// F13: each exit path prints its own line. The tab-closed (idle) and
// never-opened lines come from a listener on server.js's
// 'md2doc-auto-close' event, since that side is what decides why the
// server is closing. The SIGINT line is printed here instead, because the
// signal lands on the process itself — server.js has no way to observe it.
const AUTO_CLOSE_MESSAGES = {
  idle: 'md2doc: no browser activity for a while — closing this editor session.\n',
  'never-opened': 'md2doc: the editor link was never opened — closing this editor session.\n',
};

async function startEditSession({
  files, port = null, open = true, quiet = false, idleTimeoutMs, neverOpenedGraceMs,
}) {
  const srv = await createEditorServer({
    files,
    clientJs: CLIENT_SRC,
    listenPort: port === null ? 0 : port,
    // Included when the caller supplies a value; otherwise omitted so
    // createEditorServer's own default applies, rather than a duplicated
    // default here that could drift out of sync with it.
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(neverOpenedGraceMs === undefined ? {} : { neverOpenedGraceMs }),
  });
  const urls = files.map((f) => srv.urlFor(f));
  for (const u of urls) process.stdout.write(u + '\n');
  if (open) {
    const { openViewer } = require('./open.js');
    for (const u of urls) openViewer(u);
  }
  srv.server.on('md2doc-auto-close', (reason) => {
    const msg = AUTO_CLOSE_MESSAGES[reason];
    if (msg) process.stdout.write(msg);
  });
  // SIGINT previously had no handler: Node's default action kills the
  // process before srv.server's 'close' listener below ever runs. Driven
  // directly by spawning a child and sending it SIGINT before this fix:
  // it exited with signal=SIGINT, code=null, and stdout held only the
  // earlier URL line — no closing message. Printing here and driving the
  // close through srv.close() (rather than letting the signal's default
  // action finish the job) routes this exit through the same 'close'
  // listener that already handles the idle and never-opened exits.
  //
  // T21 item 3: this handler REPLACES Node's default action, and the default
  // action was the escape route — with a handler installed, a Ctrl+C that
  // does not lead to an exit leaves the user with no way out but another
  // terminal. Two things answer that here. srv.close() now lands the open
  // sockets rather than waiting on them (see shutdownServer() in server.js
  // for the preconnect measurement that made the default invocation hang
  // where --no-open did not), and a SECOND SIGINT exits on the spot. The
  // second one does not reprint the line: driven before this guard existed,
  // two Ctrl+C's printed 'interrupted' twice and the process was still alive
  // 12 s after the first. 130 is the conventional code for a process ending
  // on SIGINT; the ordinary path still exits 0 through the 'close' listener
  // below.
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write('md2doc: interrupted — closing this editor session.\n');
    srv.close();
  });
  srv.server.on('close', () => process.exit(0));
  return srv;
}
module.exports = { startEditSession };
