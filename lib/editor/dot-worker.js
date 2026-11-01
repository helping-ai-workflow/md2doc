'use strict';
// Worker-thread entry for the stateless /api/preview: lays a dot source out
// with the same renderDotSvg the bake uses, so a large graph does not block
// the editor server's event loop (and with it /api/ping and every save).
const { parentPort } = require('worker_threads');
const { renderDotSvg } = require('../md2doc.js');

parentPort.on('message', async (m) => {
  try {
    parentPort.postMessage({ id: m.id, svg: await renderDotSvg(m.source) });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) });
  }
});
