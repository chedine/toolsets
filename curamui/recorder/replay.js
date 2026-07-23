#!/usr/bin/env node
// Replay a saved recording:
//   node replay.js <name|path.json|path.dsl> [--headless] [--url <url>]
//                  [--param name=value ...] [--dry]
// `param gen` lines in the .dsl mint fresh identity values each run; a
// --param override pins one for the run.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const yaml = require('js-yaml');
const { CuramDriver } = require('./curam-driver');
const { closeAllTabs, browserOptions } = require('./record');

// `param gen <name> as <type> [<modifier> [<value>]]...` declares a parameter
// whose value is minted fresh each replay by generators.js. Modifiers are
// generator-spec options: boolean flags (unique) or key/value pairs
// (area 091, length 9). Numeric-looking values are coerced except where a
// leading zero matters (e.g. ssn area), which stays a string.
const GEN_BOOL = new Set(['unique']);
const GEN_NUM = new Set(['length', 'suffixLen']);
function parseGenSpec(type, rest) {
  const spec = { type };
  const toks = (rest || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const key = toks[i];
    if (GEN_BOOL.has(key)) { spec[key] = true; continue; }
    const val = toks[++i];
    if (val === undefined) throw new Error(`gen modifier "${key}" needs a value`);
    spec[key] = GEN_NUM.has(key) ? Number(val) : val;
  }
  return spec;
}

// Parse a hand-editable .dsl file back into steps. One step per line;
// blank lines and #-comments ignored. `param name = "default"` lines declare
// fixed parameters; `param gen <name> as <type>` declares generated ones. Both
// are usable as ${name} anywhere in the steps.
function parseDsl(text) {
  const steps = [];
  const params = {};
  const genParams = {};
  const parseWhere = s => Object.fromEntries(s.split(' and ').map(p => {
    const m = p.trim().match(/^(.+?)\s*=\s*"([^"]*)"$/);
    if (!m) throw new Error(`bad where clause: ${p}`);
    return [m[1], m[2]];
  }));
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `try <step>`: replay ignores a failure in this step (step-level optional)
    let optional = false;
    const tm = line.match(/^try\s+(.+)$/);
    if (tm) { optional = true; line = tm[1]; }
    // shared "at row N [where ...]" strategy builder
    const rowStrategy = (row, where) => where
      ? { type: 'predicate', where: parseWhere(where), ...(row ? { row: +row } : {}) }
      : row ? { type: 'row', row: +row } : undefined;
    const n = steps.length;
    let m;
    if ((m = line.match(/^param gen\s+([\w.-]+)\s+as\s+(\w+)(?:\s+(.*))?$/))) {
      genParams[m[1]] = parseGenSpec(m[2], m[3]);
    } else if ((m = line.match(/^param ([\w.-]+)\s*=\s*"([^"]*)"$/))) {
      params[m[1]] = m[2];
    } else if ((m = line.match(/^click link(?: in "([^"]*)")? at row (\d+)(?: where (.+))?$/))) {
      steps.push({ verb: 'click link', args: ['', m[1] || ''], dsl: line, strategy: rowStrategy(m[2], m[3]) });
    } else if ((m = line.match(/^click link(?: in "([^"]*)")? where (.+)$/))) {
      steps.push({ verb: 'click link', args: ['', m[1] || ''], dsl: line, strategy: rowStrategy(null, m[2]) });
    } else if ((m = line.match(/^expect row(?: in "([^"]*)")?(?: at row (\d+))?(?: where (.+))?$/))) {
      steps.push({ verb: 'expect row', args: ['', m[1] || ''], dsl: line, strategy: rowStrategy(m[2], m[3]) });
    } else if ((m = line.match(/^(expand|collapse|check|uncheck) row(?: in "([^"]+)")?(?: at row (\d+))?(?: where (.+))?$/))) {
      steps.push({ verb: `${m[1]} row`, args: ['', m[2] || ''], dsl: line, strategy: rowStrategy(m[3], m[4]) });
    } else if ((m = line.match(/^click rowmenu "([^"]+)"(?: in "([^"]+)")?(?: at row (\d+))?(?: where (.+))?$/))) {
      steps.push({ verb: 'click rowmenu', args: [m[1], m[2] || ''], dsl: line, strategy: rowStrategy(m[3], m[4]) });
    } else if ((m = line.match(/^click (pagemenu|tabmenu) "([^"]+)"$/))) {
      steps.push({ verb: `click ${m[1]}`, args: [m[2]], dsl: line });
    } else if ((m = line.match(/^expect "([^"]*)" is "([^"]*)"$/))) {
      steps.push({ verb: 'expect', args: [m[1], m[2]], dsl: line });
    } else if (line === 'check all') {
      steps.push({ verb: 'check all', args: [], dsl: line });
    } else if ((m = line.match(/^advance to "([^"]+)"$/))) {
      steps.push({ verb: 'advance to', args: [m[1]], dsl: line });
    } else if ((m = line.match(/^fill application from ([\w./-]+)$/))) {
      steps.push({ verb: 'fill application', args: [m[1]], dsl: line });
    } else if ((m = line.match(/^click (link|button) "([^"]+)"(?: in "([^"]+)")?$/))) {
      steps.push({ verb: `click ${m[1]}`, args: [m[2], m[3] || ''], dsl: line });
    } else if ((m = line.match(/^enter "([^"]*)" as (.+)$/))) {
      steps.push({ verb: 'enter', args: [m[1], m[2]], dsl: line });
    } else if ((m = line.match(/^press enter in "([^"]*)"$/))) {
      steps.push({ verb: 'press enter', args: [m[1]], dsl: line });
    } else if ((m = line.match(/^select "([^"]*)" for (.+)$/))) {
      steps.push({ verb: 'select option', args: [m[1], m[2]], dsl: line });
    } else if ((m = line.match(/^select radio "(.+)"$/))) {
      steps.push({ verb: 'select radio', args: [m[1]], dsl: line });
    } else if (/^until\s+/.test(line)) {
      // poll a field/row until it matches, refreshing between polls. Optional
      // trailing "timeout <sec>" / "interval <sec>" override the defaults.
      let body = line.replace(/^until\s+/, '');
      const opts = {};
      for (let stripped = true; stripped;) {
        stripped = false;
        body = body.replace(/\s+timeout\s+(\d+)\s*$/i, (_, n) => { opts.timeout = +n * 1000; stripped = true; return ''; });
        body = body.replace(/\s+interval\s+(\d+)\s*$/i, (_, n) => { opts.interval = +n * 1000; stripped = true; return ''; });
      }
      body = body.trim();
      const optField = Object.keys(opts).length ? { opts } : {};
      let mm;
      if ((mm = body.match(/^"([^"]*)" is "(.*)"$/))) {
        steps.push({ verb: 'until', args: [mm[1], mm[2]], dsl: line, ...optField });
      } else if ((mm = body.match(/^row(?: in "([^"]*)")?(?: at row (\d+))?(?: where (.+))?$/))) {
        if (!mm[2] && !mm[3]) throw new Error(`until row needs "at row N" and/or "where ...": ${line}`);
        steps.push({ verb: 'until row', args: ['', mm[1] || ''], dsl: line, strategy: rowStrategy(mm[2], mm[3]), ...optField });
      } else {
        throw new Error(`cannot parse until: ${line}`);
      }
    } else if ((m = line.match(/^click shortcutitem (.+?) > (.+)$/))) {
      steps.push({ verb: 'click shortcutitem', args: [m[1], m[2]], dsl: line });
      // greedy "(.+)" so a label containing embedded quotes (e.g. a consent
      // checkbox that quotes a link name) still parses — the arg is line-final
    } else if ((m = line.match(/^(click section|click shortcutgroup|click menuitem|select tab|select pagetab|select nav|select navitem|check|uncheck|close tab) "(.+)"$/))) {
      steps.push({ verb: m[1], args: [m[2]], dsl: line });
    } else if (line === 'toggle shortcuts panel') {
      steps.push({ verb: 'toggle shortcuts panel', args: [], dsl: line });
    } else {
      throw new Error(`cannot parse DSL line: ${line}`);
    }
    if (optional && steps.length > n) {
      const s = steps[steps.length - 1];
      s.optional = true;
      s.dsl = 'try ' + s.dsl;
    }
  }
  return { steps, params, genParams };
}

// Substitute ${name} placeholders in step args, predicates and display DSL.
function applyParams(steps, params) {
  const subst = s => typeof s === 'string' ? s.replace(/\$\{([^}]+)\}/g, (_, k) => {
    if (!(k in params)) throw new Error(`undefined parameter \${${k}} — declare 'param ${k} = "default"' in the .dsl or pass --param ${k}=value`);
    return params[k];
  }) : s;
  for (const st of steps) {
    st.args = st.args.map(subst);
    if (st.strategy && st.strategy.where) {
      st.strategy.where = Object.fromEntries(Object.entries(st.strategy.where).map(([k, v]) => [subst(k), subst(v)]));
    }
    st.dsl = subst(st.dsl);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const nameArg = args.find(a => !a.startsWith('--'));
  if (!nameArg) { console.error('usage: node replay.js <recording name | path.json> [--headless]'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const get = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  const dataDir = path.join(__dirname, cfg.dataDir || './data');
  let rec;
  if (nameArg.endsWith('.json')) {
    // explicit .json: the full-fidelity capture (only needed for exact ctx)
    const p = fs.existsSync(nameArg) ? nameArg : path.join(dataDir, nameArg);
    rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    // default to the hand-editable .dsl (params, ${}, `try`); a bare name
    // resolves to <name>.dsl under the data dir
    const name = nameArg.endsWith('.dsl') ? nameArg : nameArg + '.dsl';
    const p = fs.existsSync(name) ? name : path.join(dataDir, name);
    const parsed = parseDsl(fs.readFileSync(p, 'utf8'));
    rec = { name, steps: parsed.steps, params: parsed.params, genParams: parsed.genParams };
  }
  // config is the current environment (e.g. a tunnel URL); the recording's
  // stored url is only a fallback — a recording is portable across environments
  const url = get('--url') || cfg.url || rec.url;

  // parameters: .dsl defaults, then --param name=value overrides
  const params = { ...(rec.params || {}) };
  const cliParams = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--param' && args[i + 1]) {
      const eqi = args[i + 1].indexOf('=');
      if (eqi < 1) { console.error(`bad --param (want name=value): ${args[i + 1]}`); process.exit(1); }
      cliParams[args[i + 1].slice(0, eqi)] = args[i + 1].slice(eqi + 1);
    }
  }
  Object.assign(params, cliParams);

  // `param gen` values are minted fresh every replay (so each run registers a
  // distinct person and avoids duplicate-key collisions), unless the CLI pinned
  // one with --param name=value. Referenced via ${name} like any parameter, so
  // one gen param used in several steps binds them all to the same value.
  const genNames = Object.keys(rec.genParams || {});
  if (genNames.length) {
    const { generate } = require('./generators');
    const minted = {};
    for (const name of genNames) {
      if (!(name in cliParams)) params[name] = generate(rec.genParams[name]);
      minted[name] = params[name];
    }
    console.log('Generated:', JSON.stringify(minted));
  }

  applyParams(rec.steps, params);
  if (Object.keys(params).length) console.log('Parameters:', JSON.stringify(params));

  if (args.includes('--dry')) {
    const { toDsl } = require('./record');
    console.log('\n--- transformed steps (dry run, no browser) ---');
    for (const step of rec.steps) console.log(step.dsl || toDsl(step));
    process.exit(0);
  }

  const opts = browserOptions(cfg, args.includes('--headless'));
  const browser = await chromium.launch(opts.launch);
  const ctx = await browser.newContext(opts.context);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);

  if (!args.includes('--no-clean')) {
    console.log('Cleaning up open tabs…');
    await closeAllTabs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
    await page.waitForTimeout(4000);
  }

  const c = new CuramDriver(page, {
    untilTimeout: cfg.until && cfg.until.timeout ? cfg.until.timeout * 1000 : undefined,
    untilInterval: cfg.until && cfg.until.interval ? cfg.until.interval * 1000 : undefined,
  });
  let ok = 0, failed = 0, skipped = 0;
  for (const step of rec.steps) {
    const [a0, a1] = step.args;
    const t0 = Date.now();
    try {
      switch (step.verb) {
        case 'click section':       await c.clickSection(a0); break;
        case 'click shortcutgroup': await c.clickShortcutGroup(a0); break;
        case 'click shortcutitem':  await c.clickShortcutGroup(a0); await c.clickShortcutItem(a1, a0); break;
        case 'select tab':          await c.selectTab(a0); break;
        case 'select pagetab':      await c.selectPageTab(a0); break;
        case 'select nav':          await c.selectNav(a0); break;
        case 'select navitem':      await c.selectNavItem(a0); break;
        case 'enter':               await c.enter(a0, a1); break;
        case 'press enter':         await c.pressEnter(a0); break;
        case 'click button':        await c.clickButton(a0); break;
        case 'click link':          await c.clickContentLink(a0, a1, step); break;
        case 'expand row':          await c.expandRow(a1, step, true); break;
        case 'collapse row':        await c.expandRow(a1, step, false); break;
        case 'check row':           await c.checkRow(a1, step, true); break;
        case 'uncheck row':         await c.checkRow(a1, step, false); break;
        case 'click rowmenu':       await c.clickRowMenu(a0, a1, step); break;
        case 'click pagemenu':      await c.clickPageMenu(a0); break;
        case 'click tabmenu':       await c.clickTabMenu(a0); break;
        case 'expect':              await c.expectField(a0, a1); break;
        case 'expect row':          await c.expectRow(a1, step); break;
        case 'click menuitem':      { const f = await c.contentFrame(); await f.click(`.dijitMenuItem:has-text("${a0}")`); await c._settle(3000); break; }
        case 'check all':           await c.checkAll(); break;
        case 'advance to':          await c.advanceTo(a0); break;
        case 'fill application':    {
          const pf = a0.endsWith('.yaml') || a0.endsWith('.yml') || a0.includes('/') ? a0 : path.join(dataDir, 'profiles', a0 + '.yaml');
          const profile = yaml.load(fs.readFileSync(fs.existsSync(pf) ? pf : a0, 'utf8'));
          // substitute ${param} placeholders throughout the profile
          const sub = v => typeof v === 'string' ? v.replace(/\$\{([^}]+)\}/g, (_, k) => k in params ? params[k] : (() => { throw new Error(`profile uses undefined parameter \${${k}}`); })())
            : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v;
          await c.fillApplication(sub(profile));
          break;
        }
        case 'check':
        case 'uncheck':             await c.setCheckbox(a0, step.verb === 'check'); break;
        case 'close tab':           { const strip = c._tabStrip(); const tab = strip.locator(`.dijitTab:has(span[role="tab"])`).filter({ hasText: a0.replace(/\*/g, '') }).first(); await tab.hover(); await tab.locator('button.dijitTabCloseButton').click(); await c._settle(2000); break; }
        case 'toggle shortcuts panel': break; // handled implicitly by driver
        case 'select option':       await c.selectOption(a0, a1); break;
        case 'select radio':        await c.selectRadio(a0); break;
        case 'until':               await c.until(a0, a1, step.opts); break;
        case 'until row':           await c.untilRow(a1, step, step.opts); break;
        default: console.log('  ?? skipping unknown verb:', step.dsl); continue;
      }
      const secs = (Date.now() - t0) / 1000;
      ok++; console.log('  ok :', step.dsl, secs > 1 ? `(${secs.toFixed(1)}s)` : '');
    } catch (e) {
      const msg = e.message.split('\n')[0];
      // a `try` step is optional — its failure is expected/tolerated, so log
      // and move on without failing the run
      if (step.optional) { skipped++; console.log('  skip:', step.dsl, '—', msg); continue; }
      // otherwise a wizard flow is sequential: every later step depends on this
      // one, so stop here (the screenshot captures the offending page).
      failed++; console.log('  FAIL:', step.dsl, '—', msg);
      break;
    }
  }
  console.log(`\nReplay finished: ${ok} ok, ${failed} failed${skipped ? `, ${skipped} optional skipped` : ''}.`);
  await page.screenshot({ path: path.join(__dirname, 'replay-final.png') });
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
