// The user's target scenario, expressed verb-by-verb via the driver.
const { chromium } = require('playwright');
const { CuramDriver } = require('./curam-driver');

const BASE = 'https://pending-overpass-bridged.ngrok-free.dev/Curam/AppController.do';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 }, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'ngrok-skip-browser-warning': '1' } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const c = new CuramDriver(page);
  const step = async (desc, fn) => { await fn(); console.log('OK:', desc); };

  await step('click section "HCR Cases and Outcomes"', () => c.clickSection('HCR Cases and Outcomes'));
  await step('click shortcut group "Searches"',        () => c.clickShortcutGroup('Searches'));
  await step('click shortcut item "Person"',           () => c.clickShortcutItem('Person'));
  await step('select tab "Person Search"',             () => c.selectTab('Person Search'));
  await step('enter "Mertz" as Last Name',             () => c.enter('Mertz', 'Last Name'));
  await step('click button "Search"',                  () => c.clickButton('Search'));
  await step('click result link "Francis Mertz"',      () => c.clickContentLink('Francis Mertz'));

  // that opens a Person tab; go to their case list, or select an existing case tab by wildcard
  await page.screenshot({ path: 'scenario-mid.png' });
  const tabs = await c._tabStrip().locator('span[role="tab"]').evaluateAll(e => e.map(x => x.title));
  console.log('open tabs now:', JSON.stringify(tabs));

  await step('select tab "Francis Mertz*"',            () => c.selectTab('Francis Mertz*'));
  await page.screenshot({ path: 'scenario-person.png' });

  // person tab nav bar
  const navTitles = await c._activePanel().locator('.navigation-bar-tabs span[role="tab"]').evaluateAll(e => e.map(x => x.title));
  console.log('person tab navs:', JSON.stringify(navTitles));

  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
