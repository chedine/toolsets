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

// One child session at a time; streams its output to the page line by line.
function createRunner(push) {
  let child = null;
  function stream(proc) {
    let buf = '';
    const onData = d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        push('__log', { line });
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
      push('__list', listRecordings()); // a new recording may have been saved
    });
    return { ok: true };
  }
  const api = {
    play: arg => run('play',
      ['replay.js', arg.name, ...(arg.generate ? ['--generate'] : []), ...(arg.headless ? ['--headless'] : [])],
      `replay ${arg.name}${arg.generate ? ' --generate' : ''}`),
    record: () => run('record', ['record.js', '--no-prompt'], 'recording a new session'),
    stop: () => { if (child) child.kill('SIGTERM'); return { ok: true }; },
    kill: () => { try { child && child.kill('SIGTERM'); } catch {} },
  };
  return api;
}

module.exports = { DIR, DATA, listRecordings, readRecording, createRunner };
