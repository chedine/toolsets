// Shared logic for the recorder shell, host-agnostic. Both the Playwright
// window (shell.js) and the native webview (shell-native.js) use this; they
// differ only in how they create the window and marshal IPC. `push(fn, arg)`
// is supplied by the host to send an event to the page (window[fn](arg)).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DATA = path.join(DIR, 'data');

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

function stepCount(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !/^param /.test(l)).length;
}

// Run history — the last MAX_RUNS sessions with their output, kept on disk so
// a failure is still reviewable after the app is restarted.
const RUNS_FILE = path.join(DIR, '.runs.json');
const MAX_RUNS = 10;
const MAX_LINES = 2000; // per run, so a chatty replay can't grow unbounded

function loadRuns() {
  try { const r = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); return Array.isArray(r) ? r : []; }
  catch { return []; }
}

// One child session at a time; streams its output to the page line by line and,
// for a replay, emits progress as each step reports ok/FAIL/skip.
function createRunner(push) {
  let child = null;
  let runs = loadRuns();
  const saveRuns = () => { try { fs.writeFileSync(RUNS_FILE, JSON.stringify(runs)); } catch {} };
  function stream(proc, onLine) {
    let buf = '';
    const onData = d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  }
  function run(kind, args, label, total, meta = {}) {
    if (child) return { error: 'a session is already running' };
    push('__running', { kind, label, total });
    let done = 0;
    const entry = {
      id: Date.now(), kind, label, total: total || 0,
      name: meta.name || null, generate: !!meta.generate,
      startedAt: Date.now(), finishedAt: null, code: null, lines: [],
    };
    runs.unshift(entry);
    if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
    push('__history', runs);
    const proc = spawn('node', args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    stream(proc, line => {
      push('__log', { line });
      if (entry.lines.length < MAX_LINES) entry.lines.push(line);
      if (kind === 'play' && total && /^\s*(ok :|FAIL:|skip:)/.test(line)) { done++; push('__progress', { done, total }); }
    });
    proc.on('exit', code => {
      child = null;
      entry.code = code;
      entry.finishedAt = Date.now();
      saveRuns();
      // list first (a new recording may have been saved) so the page has the
      // refreshed set before it restores the detail on 'done'
      push('__list', listRecordings());
      push('__history', runs);
      push('__done', { kind, code });
    });
    return { ok: true };
  }
  const api = {
    play: arg => run('play',
      ['replay.js', arg.name, ...(arg.generate ? ['--generate'] : []), ...(arg.headless ? ['--headless'] : [])],
      `replay ${arg.name}${arg.generate ? ' --generate' : ''}`,
      stepCount(readRecording(arg.name).text),
      { name: arg.name, generate: arg.generate }),
    record: () => run('record', ['record.js', '--no-prompt'], 'recording a new session'),
    stop: () => { if (child) child.kill('SIGTERM'); return { ok: true }; },
    kill: () => { try { child && child.kill('SIGTERM'); } catch {} },
    history: () => runs,
  };
  return api;
}

module.exports = { DIR, DATA, listRecordings, readRecording, createRunner };
