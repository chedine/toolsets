// Minimal desktop shell for the Curam recorder — a chromeless Chromium window
// (Playwright, reusing the browser the project already ships) that lists
// recordings and launches replay/record as child processes. Page <-> Node IPC
// is Playwright's exposeBinding, the same mechanism record.js uses for its
// overlay. No extra dependency.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DATA = path.join(DIR, 'data');
const HTML = path.join(DIR, 'shell.html');

// --- recordings ---------------------------------------------------------
function listRecordings() {
  let files = [];
  try { files = fs.readdirSync(DATA).filter(f => f.endsWith('.dsl')); } catch {}
  return files.map(f => {
    const p = path.join(DATA, f);
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split(/\r?\n/).map(l => l.trim());
    const steps = lines.filter(l => l && !l.startsWith('#') && !/^param /.test(l)).length;
    const params = lines.filter(l => /^param /.test(l)).map(l => (l.match(/^param ([\w.-]+)/) || [])[1]).filter(Boolean);
    return { name: f.replace(/\.dsl$/, ''), steps, params, mtime: fs.statSync(p).mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}

function readRecording(name) {
  const p = path.join(DATA, name + '.dsl');
  try { return { name, text: fs.readFileSync(p, 'utf8') }; }
  catch { return { name, text: '' }; }
}

// --- child process (one at a time) --------------------------------------
let child = null;
let uiPage = null;

function push(fn, arg) {
  if (uiPage) uiPage.evaluate(([f, a]) => window[f] && window[f](a), [fn, arg]).catch(() => {});
}

function stream(proc, kind) {
  let buf = '';
  const onData = d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      push('__log', { line, kind });
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
}

function run(kind, args, label) {
  if (child) return { error: 'a session is already running' };
  push('__running', { kind, label });
  const proc = spawn('node', args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  stream(proc);
  proc.on('exit', code => {
    child = null;
    push('__done', { kind, code });
    push('__list', listRecordings()); // a recording may have been saved
  });
  return { ok: true };
}

function play(arg) {
  const args = ['replay.js', arg.name];
  if (arg.generate) args.push('--generate');
  if (arg.headless) args.push('--headless');
  return run('play', args, `replay ${arg.name}${arg.generate ? ' --generate' : ''}`);
}

function record() {
  return run('record', ['record.js', '--no-prompt'], 'recording a new session');
}

function stop() {
  if (!child) return { ok: true };
  child.kill('SIGTERM');
  return { ok: true };
}

// --- window -------------------------------------------------------------
(async () => {
  const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    viewport: null,
    args: ['--app=about:blank', '--window-size=940,660'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  uiPage = page;

  await ctx.exposeBinding('shellCall', async (_src, method, arg) => {
    switch (method) {
      case 'list':   return listRecordings();
      case 'open':   return readRecording(arg);
      case 'play':   return play(arg);
      case 'record': return record();
      case 'stop':   return stop();
      default:       return { error: 'unknown method: ' + method };
    }
  });

  await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });

  const quit = () => { try { child && child.kill('SIGTERM'); } catch {} process.exit(0); };
  page.on('close', quit);
  ctx.on('close', quit);
})().catch(e => { console.error(e); process.exit(1); });
