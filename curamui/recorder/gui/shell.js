// Recorder shell — zero-dep host: a chromeless Chromium window (Playwright,
// reusing the browser the project already ships) pointed at the local shell
// server. All page <-> Node traffic is plain HTTP (see shell-server.js), so no
// browser IPC is involved here.
const { chromium } = require('playwright');
const { startServer } = require('./shell-server');

(async () => {
  const srv = await startServer();
  const W = 960, H = 680;
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: null,
    // shed the "controlled by automated software" infobar and other browsery
    // affordances so the window reads as an app, not a test browser
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--app=${srv.url}`,
      `--window-size=${W},${H}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--hide-crash-restore-bubble',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
    ],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  if (!page.url().startsWith(srv.url)) await page.goto(srv.url, { waitUntil: 'domcontentloaded' });

  // center the window on the primary display (Chromium has no center flag)
  try {
    const scr = await page.evaluate(() => ({ w: screen.availWidth, h: screen.availHeight, l: screen.availLeft || 0, t: screen.availTop || 0 }));
    const left = Math.round(scr.l + (scr.w - W) / 2);
    const top = Math.round(scr.t + (scr.h - H) / 3);
    const s = await ctx.newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget');
    await s.send('Browser.setWindowBounds', { windowId, bounds: { left, top, width: W, height: H } });
  } catch {}

  const quit = () => { srv.close(); process.exit(0); };
  page.on('close', quit);
  ctx.on('close', quit);
})().catch(e => { console.error(e); process.exit(1); });
