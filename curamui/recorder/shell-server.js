// Local backend for the recorder shell: a tiny dependency-free HTTP server
// that serves shell.html and a JSON + SSE API. Both window hosts (shell.js on
// Playwright, shell-native.js on @webviewjs) just point a window at its URL, so
// page <-> Node is plain fetch()/EventSource — no framework IPC, and the whole
// UI is testable in any browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { listRecordings, readRecording, createRunner } = require('./shell-core');

const HTML = path.join(__dirname, 'shell.html');

function startServer() {
  const clients = new Set(); // open SSE responses
  const broadcast = (type, data) => {
    const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch {} }
  };
  // runner events (__log/__running/__done/__list) fan out to SSE clients
  const runner = createRunner((fn, arg) => broadcast(fn.replace(/^__/, ''), arg));

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    try {
      if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(HTML));
      }
      if (u.pathname === '/api/list')   return json(res, 200, listRecordings());
      if (u.pathname === '/api/open')   return json(res, 200, readRecording(u.searchParams.get('name')));
      if (u.pathname === '/api/play')   return json(res, 200, runner.play(await readBody(req)));
      if (u.pathname === '/api/record') return json(res, 200, runner.record());
      if (u.pathname === '/api/stop')   return json(res, 200, runner.stop());
      if (u.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, port, runner,
        url: `http://127.0.0.1:${port}/`,
        close: () => { runner.kill(); try { server.close(); } catch {} },
      });
    });
  });
}

module.exports = { startServer };

// `node shell-server.js` runs just the backend (open the URL in any browser to
// test the UI without a native/Chromium window host)
if (require.main === module) {
  startServer().then(s => console.log('recorder shell UI:', s.url));
}
