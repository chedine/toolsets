#!/usr/bin/env node
// Replay a saved recording:
//   node replay.js <name|path.json|path.dsl> [--headless] [--url <url>]
//                  [--param name=value ...]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const yaml = require('js-yaml');
const { CuramDriver } = require('./curam-driver');
const { closeAllTabs, browserOptions } = require('./record');

// Parse a hand-editable .dsl file back into steps. One step per line;
// blank lines and #-comments ignored. `param name = "default"` lines
// declare parameters usable as ${name} anywhere in the steps.
function parseDsl(text) {
  const steps = [];
  const params = {};
  const parseWhere = s => Object.fromEntries(s.split(' and ').map(p => {
    const m = p.trim().match(/^(.+?)\s*=\s*"([^"]*)"$/);
    if (!m) throw new Error(`bad where clause: ${p}`);
    return [m[1], m[2]];
  }));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // shared "at row N [where ...]" strategy builder
    const rowStrategy = (row, where) => where
      ? { type: 'predicate', where: parseWhere(where), ...(row ? { row: +row } : {}) }
      : row ? { type: 'row', row: +row } : undefined;
    let m;
    if ((m = line.match(/^param ([\w.-]+)\s*=\s*"([^"]*)"$/))) {
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
    } else if ((m = line.match(/^select "([^"]*)" for (.+)$/))) {
      steps.push({ verb: 'select option', args: [m[1], m[2]], dsl: line });
    } else if ((m = line.match(/^click shortcutitem (.+?) > (.+)$/))) {
      steps.push({ verb: 'click shortcutitem', args: [m[1], m[2]], dsl: line });
    } else if ((m = line.match(/^(click section|click shortcutgroup|click menuitem|select tab|select pagetab|select nav|select navitem|check|uncheck|close tab) "([^"]+)"$/))) {
      steps.push({ verb: m[1], args: [m[2]], dsl: line });
    } else if (line === 'toggle shortcuts panel') {
      steps.push({ verb: 'toggle shortcuts panel', args: [], dsl: line });
    } else {
      throw new Error(`cannot parse DSL line: ${line}`);
    }
  }
  return { steps, params };
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
  if (nameArg.endsWith('.dsl')) {
    const p = fs.existsSync(nameArg) ? nameArg : path.join(dataDir, nameArg);
    const parsed = parseDsl(fs.readFileSync(p, 'utf8'));
    rec = { name: nameArg, steps: parsed.steps, params: parsed.params };
  } else {
    const p = nameArg.endsWith('.json') ? nameArg : path.join(dataDir, nameArg + '.json');
    rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  const url = get('--url') || rec.url || cfg.url;

  // parameters: .dsl/.json defaults overridden by --param name=value flags
  const params = { ...(rec.params || {}) };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--param' && args[i + 1]) {
      const eqi = args[i + 1].indexOf('=');
      if (eqi < 1) { console.error(`bad --param (want name=value): ${args[i + 1]}`); process.exit(1); }
      params[args[i + 1].slice(0, eqi)] = args[i + 1].slice(eqi + 1);
    }
  }
  applyParams(rec.steps, params);
  if (Object.keys(params).length) console.log('Parameters:', JSON.stringify(params));

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

  const c = new CuramDriver(page);
  let ok = 0, failed = 0;
  for (const step of rec.steps) {
    const [a0, a1] = step.args;
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
        default: console.log('  ?? skipping unknown verb:', step.dsl); continue;
      }
      ok++; console.log('  ok :', step.dsl);
    } catch (e) {
      failed++; console.log('  FAIL:', step.dsl, '—', e.message.split('\n')[0]);
    }
  }
  console.log(`\nReplay finished: ${ok} ok, ${failed} failed.`);
  await page.screenshot({ path: path.join(__dirname, 'replay-final.png') });
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
