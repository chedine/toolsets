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
  // --generate: mint fresh identity values so a recording made with concrete
  // data creates distinct people each replay. config.json "generate" maps a
  // field-label REGEX (case-insensitive) to a generator spec.
  //
  // A recording may register several applicants. We split it into per-applicant
  // blocks — a rule-matching field label that REPEATS marks the start of the
  // next applicant — and generate each applicant's identity INDEPENDENTLY. No
  // correlation is drawn between applicants: if two happen to share a recorded
  // value (e.g. a coincidentally identical last name), each still gets its own
  // freshly generated value, resolved positionally within its own block. Within
  // one applicant's block the recorded value is substituted across every step,
  // so the SSN re-enter (same value, different label) updates too. Cross-block
  // references (a relationship/search label naming another applicant) are
  // resolved by a global pass over values that are unique across the recording.
  const genOn = args.includes('--generate') || args.includes('--gen');
  if (genOn) {
    const { generate } = require('./generators');
    const { toDsl } = require('./record');
    const genCfg = cfg.generate || {};
    if (!Object.keys(genCfg).length) { console.error('--generate given but config.json has no "generate" section'); process.exit(1); }
    const rules = Object.entries(genCfg).map(([pat, spec]) => ({ re: new RegExp(pat, 'i'), spec }));

    const persons = [];               // { start, end, labels:Set, map:Map(recorded->gen), byType:{} }
    let cur = null;
    rec.steps.forEach((step, i) => {
      if (step.verb !== 'enter' && step.verb !== 'select option') return;
      const rule = rules.find(r => r.re.test(step.args[1]));
      if (!rule) return;
      const recorded = step.args[0];
      if (!recorded || recorded.length < 2) return;
      if (!cur || cur.labels.has(step.args[1])) { cur = { start: i, labels: new Set(), map: new Map(), byType: {} }; persons.push(cur); }
      cur.labels.add(step.args[1]);
      if (!cur.map.has(recorded)) {
        const val = generate(rule.spec);
        cur.map.set(recorded, val);
        const t = (rule.spec.type || '').toLowerCase();
        if (!(t in cur.byType)) cur.byType[t] = val;
      }
    });
    persons.forEach((p, k) => { p.end = k + 1 < persons.length ? persons[k + 1].start : rec.steps.length; });

    // global map for cross-block references: only recorded values that are
    // unique across the whole recording (an ambiguous value is left to the
    // per-block pass, which knows which applicant it belongs to)
    const count = new Map();
    for (const p of persons) for (const from of p.map.keys()) count.set(from, (count.get(from) || 0) + 1);
    const globalPairs = [];
    for (const p of persons) for (const [from, to] of p.map) if (count.get(from) === 1 && from !== to) globalPairs.push([from, to]);
    globalPairs.sort((a, b) => b[0].length - a[0].length);

    const personAt = i => persons.find(p => i >= p.start && i < p.end);
    const apply = (s, pairs) => { for (const [from, to] of pairs) if (from !== to) s = s.split(from).join(to); return s; };
    for (let i = 0; i < rec.steps.length; i++) {
      const step = rec.steps[i];
      const pm = personAt(i);
      const pmPairs = pm ? [...pm.map].sort((a, b) => b[0].length - a[0].length) : [];
      const before = JSON.stringify(step.args);
      step.args = step.args.map(a => typeof a === 'string' ? apply(apply(a, pmPairs), globalPairs) : a);
      if (JSON.stringify(step.args) !== before) step.dsl = toDsl(step) + '  (generated)';
    }

    // expose the PRIMARY applicant's identity under the usual param names, for
    // recordings/scenarios that reference it via ${firstName}/${person}
    const primary = persons[0];
    if (primary) {
      if (primary.byType.firstname) params.firstName = primary.byType.firstname;
      if (primary.byType.lastname) params.lastName = primary.byType.lastname;
      if (params.firstName && params.lastName) params.person = `${params.firstName} ${params.lastName}`;
    }
    console.log('Generated:', JSON.stringify(persons.map(p => Object.fromEntries(p.map))));
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

  const c = new CuramDriver(page);
  const keepGoing = args.includes('--keep-going');
  let ok = 0, failed = 0;
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
      const secs = (Date.now() - t0) / 1000;
      ok++; console.log('  ok :', step.dsl, secs > 1 ? `(${secs.toFixed(1)}s)` : '');
    } catch (e) {
      failed++; console.log('  FAIL:', step.dsl, '—', e.message.split('\n')[0]);
      // a wizard flow is sequential — every later step depends on this one, so
      // barrelling on just produces a cascade of noise. Stop at the first
      // failure (screenshot captures the offending page) unless --keep-going.
      if (!keepGoing) { console.log('  (stopping — pass --keep-going to continue past failures)'); break; }
    }
  }
  console.log(`\nReplay finished: ${ok} ok, ${failed} failed.`);
  await page.screenshot({ path: path.join(__dirname, 'replay-final.png') });
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
