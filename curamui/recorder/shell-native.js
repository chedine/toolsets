// Recorder shell — native host: a real system-WebKit / WebView2 window via
// @webviewjs/webview, pointed at the local shell server. Page <-> Node is plain
// HTTP (shell-server.js), so this avoids the framework's loadHtml/expose IPC
// entirely — the window just loads a URL.
const { Application } = require('@webviewjs/webview');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./shell-server');

// WebView2 (Windows) needs a writable user-data folder; by default it tries to
// create one next to the running exe (node.exe), which fails with "Access is
// denied" under Program Files. Point it at a per-user writable location.
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CuramRecorder', 'webview');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

(async () => {
  const srv = await startServer();
  const app = new Application();
  await app.whenReady();

  const win = app.createBrowserWindow({
    title: 'Curam Recorder',
    width: 960,
    height: 680,
    resizable: true,
    decorations: true,
  });
  const webContext = app.createWebContext({ dataDirectory: DATA_DIR });
  let webview;
  try {
    webview = win.createWebview({ url: srv.url, webContext });
  } catch (e) {
    console.error('Failed to create the native webview:', e.message);
    console.error('Fallback: run the zero-dependency window with  npm run ui');
    srv.close();
    process.exit(1);
  }
  if (webview && typeof webview.loadUrl === 'function' && !webview.url()) webview.loadUrl(srv.url);

  // close / window-close-requested / application-close-requested can all fire
  // for one quit — run cleanup once. (On Windows a benign WebView2 teardown log
  // "Failed to unregister class Chrome_WidgetWin_0. Error = 1412" may still
  // print as the process exits; it's harmless and comes from WebView2 itself.)
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    srv.close();
    try { webview && webview.dispose && webview.dispose(); } catch {}
    setTimeout(() => process.exit(0), 30);
  };
  win.on('close', quit);
  app.on('window-close-requested', quit);
  app.on('application-close-requested', quit);
})().catch(e => { console.error(e); process.exit(1); });
