// Recorder shell — native host: a real system-WebKit window via
// @webviewjs/webview (tao/wry). No Chromium; the window is this process, so
// with a .app wrapper it carries its own Dock icon and name. Reuses shell.html
// and shell-core.js unchanged — only the window + IPC glue differ from shell.js.
const { Application } = require('@webviewjs/webview');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner, makeDispatch } = require('./shell-core');

const HTML = path.join(__dirname, 'shell.html');

// WebView2 (Windows) needs a writable user-data folder; by default it tries to
// create one next to the running exe (node.exe), which fails with "Access is
// denied" under Program Files. Point it at a per-user writable location.
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CuramRecorder', 'webview');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

let webview = null;
const push = (fn, arg) => {
  if (webview) { try { webview.evaluateScript(`window[${JSON.stringify(fn)}] && window[${JSON.stringify(fn)}](${JSON.stringify(arg)})`); } catch {} }
};
const runner = createRunner(push);
const dispatch = makeDispatch(runner);

// shell.html talks to `window.shellCall(method, arg)`. The native host exposes
// each handler under `window.shell.*`; this shim re-creates shellCall and waits
// for the exposed namespace to be injected before the first call resolves.
const SHIM = `<script>window.shellCall=(m,a)=>new Promise((res,rej)=>{(function t(){`
  + `if(window.shell&&window.shell[m])window.shell[m](a).then(res,rej);else setTimeout(t,30);})();});</script>`;

const app = new Application();
app.whenReady().then(() => {
  const win = app.createBrowserWindow({
    title: 'Curam Recorder',
    width: 960,
    height: 680,
    resizable: true,
    decorations: true,
  });
  // a WebContext with an explicit dataDirectory keeps WebView2's profile in a
  // writable location (see DATA_DIR above)
  const webContext = app.createWebContext({ dataDirectory: DATA_DIR });
  try {
    webview = win.createWebview({ webContext });
  } catch (e) {
    console.error('Failed to create the native webview:', e.message);
    console.error('Data dir:', DATA_DIR);
    console.error('Fallback: run the zero-dependency window with  npm run ui');
    process.exit(1);
  }

  webview.expose('shell', {
    list:   async () => dispatch('list'),
    open:   async (name) => dispatch('open', name),
    play:   async (arg) => dispatch('play', arg),
    record: async () => dispatch('record'),
    stop:   async () => dispatch('stop'),
  });

  const html = fs.readFileSync(HTML, 'utf8').replace('</head>', SHIM + '</head>');
  webview.loadHtml(html);

  const quit = () => { runner.kill(); process.exit(0); };
  win.on('close', quit);
  app.on('window-close-requested', quit);
  app.on('application-close-requested', quit);
});
