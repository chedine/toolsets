// Local backend for the recorder shell: a tiny dependency-free HTTP server
// that serves shell.html and a JSON + SSE API. Both window hosts (shell.js on
// Playwright, shell-native.js on @webviewjs) just point a window at its URL, so
// page <-> Node is plain fetch()/EventSource — no framework IPC, and the whole
// UI is testable in any browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { listRecordings, readRecording, createRunner, DATA } = require('./shell-core');

const HTML = path.join(__dirname, 'shell.html');
const CONFIG = path.join(__dirname, 'config.json');

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (base, patch) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
};

// port: 0 (default) lets the OS pick a free port — used by the window hosts so
// they never clash. `node shell-server.js` pins a stable port (PORT env or
// 4599) so you can bookmark the URL while editing shell.html's CSS.
function startServer({ port = 0 } = {}) {
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
      if (u.pathname.startsWith('/fonts/')) {
        const fp = path.join(__dirname, 'assets', 'fonts', path.basename(u.pathname));
        if (fs.existsSync(fp)) {
          res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400' });
          return res.end(fs.readFileSync(fp));
        }
        res.writeHead(404); return res.end('not found');
      }
      if (u.pathname === '/api/list')   return json(res, 200, listRecordings());
      if (u.pathname === '/api/open')   return json(res, 200, readRecording(u.searchParams.get('name')));
      if (u.pathname === '/api/play')   return json(res, 200, runner.play(await readBody(req)));
      if (u.pathname === '/api/record') return json(res, 200, runner.record());
      if (u.pathname === '/api/stop')   return json(res, 200, runner.stop());
      if (u.pathname === '/api/history') return json(res, 200, runner.history());
      if (u.pathname === '/api/save') {
        const { name, text } = await readBody(req);
        const safe = String(name || '').replace(/[^\w.-]+/g, '-');
        if (!safe) return json(res, 400, { error: 'bad name' });
        fs.writeFileSync(path.join(DATA, safe + '.dsl'), text.endsWith('\n') ? text : text + '\n');
        broadcast('list', listRecordings());
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/delete') {
        const { name } = await readBody(req);
        const safe = String(name || '').replace(/[^\w.-]+/g, '-');
        if (!safe) return json(res, 400, { error: 'bad name' });
        const removed = [];
        for (const ext of ['.dsl', '.json']) { // .json sidecar if present
          const fp = path.join(DATA, safe + ext);
          if (fs.existsSync(fp)) { fs.unlinkSync(fp); removed.push(safe + ext); }
        }
        if (!removed.length) return json(res, 404, { error: 'not found' });
        broadcast('list', listRecordings());
        return json(res, 200, { ok: true, removed });
      }
      if (u.pathname === '/api/rename') {
        const { name, to } = await readBody(req);
        const from = String(name || '').replace(/[^\w.-]+/g, '-');
        const dst = String(to || '').replace(/[^\w.-]+/g, '-');
        if (!from || !dst) return json(res, 400, { error: 'bad name' });
        if (dst === from) return json(res, 200, { ok: true, name: dst });
        if (fs.existsSync(path.join(DATA, dst + '.dsl'))) return json(res, 409, { error: `"${dst}" already exists` });
        if (!fs.existsSync(path.join(DATA, from + '.dsl'))) return json(res, 404, { error: 'not found' });
        for (const ext of ['.dsl', '.json']) {
          const src = path.join(DATA, from + ext);
          if (fs.existsSync(src)) fs.renameSync(src, path.join(DATA, dst + ext));
        }
        broadcast('list', listRecordings());
        return json(res, 200, { ok: true, name: dst });
      }
      if (u.pathname === '/api/duplicate') {
        const { name } = await readBody(req);
        const from = String(name || '').replace(/[^\w.-]+/g, '-');
        if (!from || !fs.existsSync(path.join(DATA, from + '.dsl'))) return json(res, 404, { error: 'not found' });
        // first free "<name>-copy", "<name>-copy-2", ...
        let dst, i = 1;
        do { dst = from + '-copy' + (i > 1 ? '-' + i : ''); i++; } while (fs.existsSync(path.join(DATA, dst + '.dsl')));
        for (const ext of ['.dsl', '.json']) {
          const src = path.join(DATA, from + ext);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, dst + ext));
        }
        broadcast('list', listRecordings());
        return json(res, 200, { ok: true, name: dst });
      }
      if (u.pathname === '/api/config') {
        if (req.method === 'POST') {
          const patch = await readBody(req);
          const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
          const merged = deepMerge(cfg, patch);
          fs.writeFileSync(CONFIG, JSON.stringify(merged, null, 2) + '\n');
          return json(res, 200, merged);
        }
        return json(res, 200, JSON.parse(fs.readFileSync(CONFIG, 'utf8')));
      }
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
    server.listen(port, '127.0.0.1', () => {
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
  startServer({ port: Number(process.env.PORT) || 4599 }).then(s => console.log('recorder shell UI:', s.url));
}
