#!/usr/bin/env node
// Curam action recorder.
//
//   node record.js [--url <url>] [--data <dir>] [--no-clean] [--headless]
//
// Launches a browser at the Curam URL, optionally closes all open tabs
// (right-click tab menu -> Close All) and reloads, then records user actions
// as high-level verbs. Use the overlay panel (bottom right) to start, pause
// and stop; on stop you name the recording and it is saved under the data
// dir as <name>.json + <name>.dsl. If the browser is closed while steps are
// pending, you are prompted for a name in the terminal instead.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const injected = require('./injected');

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  return {
    url: get('--url') || cfg.url,
    dataDir: path.resolve(__dirname, get('--data') || cfg.dataDir || './data'),
    clean: args.includes('--no-clean') ? false : (cfg.cleanTabsOnStart !== false),
    headless: args.includes('--headless'),
    extraHTTPHeaders: cfg.extraHTTPHeaders || {},
    viewport: cfg.viewport || { width: 1800, height: 1000 },
    // headed windows open maximized unless "maximized": false in config;
    // headless always uses the fixed viewport
    maximized: cfg.maximized !== false,
  };
}

// Launch options honoring maximized-vs-viewport (shared with replay.js).
function browserOptions(cfg, headless) {
  const maximized = !headless && cfg.maximized !== false;
  return {
    launch: { headless, args: maximized ? ['--start-maximized'] : [] },
    context: {
      viewport: maximized ? null : (cfg.viewport || { width: 1800, height: 1000 }),
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: cfg.extraHTTPHeaders || {},
    },
  };
}

function toDsl(step) {
  // `try ` marks a step whose failure replay ignores (step-level optionality)
  return (step.optional ? 'try ' : '') + toDslBody(step);
}
function toDslBody(step) {
  const q = s => `"${s}"`;
  const a = step.args;
  // row-selection suffix from a strategy: " at row N" / " where Col = ..."
  const suffix = s => {
    if (!s) return '';
    if (s.type === 'row') return ` at row ${s.row}`;
    if (s.type === 'predicate') {
      const where = Object.entries(s.where).map(([k, v]) => `${k} = ${q(v)}`).join(' and ');
      return (s.row ? ` at row ${s.row}` : '') + ` where ${where}`;
    }
    return '';
  };
  // "timeout N interval N" suffix for until steps (ms stored -> seconds)
  const untilSuffix = st => { const o = st.opts || {}; return (o.timeout ? ` timeout ${Math.round(o.timeout / 1000)}` : '') + (o.interval ? ` interval ${Math.round(o.interval / 1000)}` : ''); };
  switch (step.verb) {
    case 'enter': return `enter ${q(a[0])} as ${a[1]}`;
    case 'select option': return `select ${q(a[0])} for ${a[1]}`;
    case 'click shortcutitem': return `click shortcutitem ${a[0]} > ${a[1]}`;
    case 'click link': {
      const s = step.strategy;
      if (s && (s.type === 'row' || s.type === 'predicate')) return `click link in ${q(a[1])}${suffix(s)}`;
      return `click link ${q(a[0])}` + (a[1] ? ` in ${q(a[1])}` : '');
    }
    case 'expand row':
    case 'collapse row':
    case 'check row':
    case 'uncheck row': return step.verb + (a[1] ? ` in ${q(a[1])}` : '') + suffix(step.strategy);
    case 'click rowmenu': return `click rowmenu ${q(a[0])}` + (a[1] ? ` in ${q(a[1])}` : '') + suffix(step.strategy);
    case 'expect row': return 'expect row' + (a[1] ? ` in ${q(a[1])}` : '') + suffix(step.strategy);
    case 'until': return `until ${q(a[0])} is ${q(a[1])}` + untilSuffix(step);
    case 'until row': return 'until row' + (a[1] ? ` in ${q(a[1])}` : '') + suffix(step.strategy) + untilSuffix(step);
    case 'click pagemenu': return `click pagemenu ${q(a[0])}`;
    case 'expect': return `expect ${q(a[0])} is ${q(a[1])}`;
    case 'click button': return `click button ${q(a[0])}` + (a[1] ? ` in ${q(a[1])}` : '');
    default: return `${step.verb} ${a.map(q).join(' ')}`;
  }
}

// Verbs that target a table row and always need a row-selection strategy
// (there is no literal text to fall back on).
const ROW_VERBS = ['expand row', 'collapse row', 'click rowmenu', 'check row', 'uncheck row'];

// Steps that change the page/form context — a same-labelled field after one
// of these is a different field, so field coalescing must not cross them.
const NAV_VERBS = new Set(['click button', 'click link', 'click section', 'click shortcutgroup',
  'click shortcutitem', 'select tab', 'select pagetab', 'select nav', 'select navitem',
  'click tabmenu', 'click rowmenu', 'click pagemenu', 'click menuitem', 'expand row',
  'collapse row', 'toggle shortcuts panel']);

// Deduplicate noise: a click on a link/button often also fires a change right
// before it; identical consecutive steps within 500ms are collapsed.
function pushStep(steps, step) {
  // Look back 2 steps: an Enter-key submit records "enter" + "click button",
  // then the input's native change event re-fires the same "enter".
  for (const prev of steps.slice(-2)) {
    if (prev.verb === step.verb && JSON.stringify(prev.args) === JSON.stringify(step.args) && step.ts - prev.ts < 1500) return;
  }
  // Coalesce repeated edits to the SAME field: re-typing a field (or coming
  // back to it later on the same form) should keep only the final value, not
  // every intermediate one (e.g. "1" then "01/01/1984" in a date field).
  // Only within the same form — stop at any navigation/context change.
  if (step.verb === 'enter' || step.verb === 'select option') {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (NAV_VERBS.has(steps[i].verb)) break;
      if ((steps[i].verb === 'enter' || steps[i].verb === 'select option') && steps[i].args[1] === step.args[1]) {
        steps[i] = step; // last write wins, keeping the field's original position
        return;
      }
    }
  }
  // Row verbs default to position; the review UI can switch to a predicate.
  if (ROW_VERBS.includes(step.verb) && step.ctx && !step.strategy) step.strategy = { type: 'row', row: step.ctx.row };
  // Row assertions capture the whole row as a predicate (minus junk columns
  // like the actions "▼"); trim the where clause in the .dsl if too strict.
  if (step.verb === 'expect row' && step.ctx && !step.strategy) {
    const where = {};
    for (const [k, v] of Object.entries(step.ctx.rowValues || {})) {
      if (/^(actions|expand\/collapse item)$/i.test(k) || v === '▼') continue;
      where[k] = v;
    }
    if (Object.keys(where).length) step.strategy = { type: 'predicate', where };
    else step.strategy = { type: 'row', row: step.ctx.row };
  }
  steps.push(step);
}

async function closeAllTabs(page) {
  // For each application section that has open tabs: right-click a tab and
  // pick the "Close All" item from the dijit context menu.
  const sectionTabs = page.locator('#app-sections-container-dc_tablist span[role="tab"]');
  const n = await sectionTabs.count();
  for (let i = 0; i < n; i++) {
    const secTab = sectionTabs.nth(i);
    const secId = ((await secTab.getAttribute('id')) || '').split('_tablist_')[1];
    if (!secId) continue;
    const strip = page.locator(`[id="${secId.replace('-sbc', '-stc')}_tablist"]`);
    if (!(await strip.count())) continue;
    const tabs = strip.locator('.dijitTab:not(.tabStripButton) span[role="tab"]');
    const closable = strip.locator('.dijitTab.dijitClosable span[role="tab"]');
    if (!(await tabs.count()) || !(await closable.count())) continue;

    await secTab.click();
    await page.waitForTimeout(1500);
    await closable.first().click({ button: 'right' });
    const menu = page.locator('.dijitMenuPopup:visible .dijitMenuItem', { hasText: /close all/i }).first();
    try {
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      await menu.click();
      await page.waitForTimeout(2000);
      console.log(`  closed all tabs in section "${await secTab.getAttribute('title')}"`);
    } catch {
      await page.keyboard.press('Escape');
      console.log(`  no "Close All" menu item in section "${await secTab.getAttribute('title')}" — skipped`);
    }
  }
}

// Wires the recorder bindings + injected script onto a page. Returns the
// mutable recorder state (also used by the headless test harness).
async function setupRecorder(page, cfg) {
  const state = { recording: false, paused: false, steps: [], savedAs: null, ready: false };

  const save = name => {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const safe = name.replace(/[^\w.-]+/g, '-');
    const rec = { name, url: cfg.url, recordedAt: new Date().toISOString(), steps: state.steps.map(s => ({ ...s, dsl: toDsl(s) })) };
    fs.writeFileSync(path.join(cfg.dataDir, `${safe}.json`), JSON.stringify(rec, null, 2));
    fs.writeFileSync(path.join(cfg.dataDir, `${safe}.dsl`), rec.steps.map(s => s.dsl).join('\n') + '\n');
    console.log(`Saved ${state.steps.length} steps -> ${path.join(cfg.dataDir, safe + '.json')} (+ .dsl)`);
    state.steps = [];
    state.savedAs = safe;
  };
  state.save = save;

  await page.exposeBinding('__curamRecEvent', (_src, step) => {
    if (!state.recording || state.paused) return;
    pushStep(state.steps, step);
    const dsl = toDsl(step);
    console.log('  +', dsl);
    page.evaluate(st => window.__curamRecRender && window.__curamRecRender(st),
      { recording: state.recording, paused: state.paused, steps: state.steps.length, last: dsl }).catch(() => {});
  });

  // Data-dependent link clicks (reference numbers etc.) that the user should
  // review: pick literal text, row position, or a column predicate.
  const flaggedSteps = () => state.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => (s.verb === 'click link' && s.ctx && /\d{4,}/.test(s.args[0]))
      // row verbs only need review when there's actually a row to disambiguate;
      // a single-row table (row 1 of 1) has no choice, so keep the default
      || (ROW_VERBS.includes(s.verb) && s.ctx && s.ctx.rowCount > 1))
    .map(({ s, i }) => ({ i, verb: s.verb, text: s.args[0], container: s.args[1] || '', row: s.ctx.row, rowCount: s.ctx.rowCount, column: s.ctx.column, rowValues: s.ctx.rowValues }));

  const applyStrategies = choices => {
    for (const ch of choices || []) {
      const step = state.steps[ch.i];
      if (!step || !step.ctx) continue;
      if (ch.type === 'row') step.strategy = { type: 'row', row: step.ctx.row };
      else if (ch.type === 'predicate' && ch.col) step.strategy = { type: 'predicate', where: { [ch.col]: step.ctx.rowValues[ch.col] } };
      else if (ROW_VERBS.includes(step.verb)) step.strategy = { type: 'row', row: step.ctx.row };
      else delete step.strategy;
      console.log('  strategy:', toDsl(step));
    }
  };

  await page.exposeBinding('__curamRecCtl', (_src, cmd, arg) => {
    if (cmd === 'start') { state.recording = true; state.paused = false; console.log('recording started'); }
    if (cmd === 'pause') { state.paused = true; console.log('recording paused'); }
    if (cmd === 'stop') { state.recording = false; state.paused = false; console.log('recording stopped —', state.steps.length, 'steps'); }
    if (cmd === 'applyStrategies') applyStrategies(arg);
    if (cmd === 'save') save(arg);
    if (cmd === 'discard') { state.steps = []; console.log('recording discarded'); }
    const res = { recording: state.recording, paused: state.paused, steps: state.steps.length, ready: state.ready };
    if (cmd === 'stop') res.flagged = flaggedSteps();
    return res;
  });

  await page.addInitScript(injected);
  return state;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.url) { console.error('No URL configured. Set "url" in config.json or pass --url.'); process.exit(1); }
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  const opts = browserOptions(cfg, cfg.headless);
  const browser = await chromium.launch(opts.launch);
  const ctx = await browser.newContext(opts.context);
  const page = await ctx.newPage();
  const state = await setupRecorder(page, cfg);

  console.log('Opening', cfg.url);
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);

  if (cfg.clean) {
    console.log('Cleaning up open tabs…');
    await closeAllTabs(page);
    console.log('Reloading for a clean start…');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  }
  // cleanup done — enable the overlay's Start button (it stays disabled until
  // now so a recording can't begin mid-cleanup and capture the reload/tab-close)
  state.ready = true;
  await page.evaluate(st => window.__curamRecRender && window.__curamRecRender(st),
    { recording: false, paused: false, steps: 0, ready: true }).catch(() => {});
  console.log('Ready. Use the overlay panel (bottom right) to start recording.');

  await new Promise(resolve => { browser.on('disconnected', resolve); page.on('close', resolve); });

  if (state.steps.length) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const name = await new Promise(res => rl.question(`Browser closed with ${state.steps.length} unsaved steps. Recording name (empty = discard): `, res));
    rl.close();
    if (name.trim()) save(name.trim());
    else console.log('Discarded.');
  }
  await browser.close().catch(() => {});
}

module.exports = { setupRecorder, closeAllTabs, loadConfig, toDsl, browserOptions, pushStep };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
