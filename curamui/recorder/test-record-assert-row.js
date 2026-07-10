// Recording check: right-click a determination table row -> `expect row`
// step with a full-row predicate; right-click a context-panel banner field
// -> `expect` step. Prints the emitted DSL.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { setupRecorder, closeAllTabs, loadConfig } = require('./record');
const { CuramDriver } = require('./curam-driver');

(async () => {
  const cfg = loadConfig();
  cfg.dataDir = path.join(__dirname, 'data');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: cfg.viewport, ignoreHTTPSErrors: true, extraHTTPHeaders: cfg.extraHTTPHeaders });
  const page = await ctx.newPage();
  await setupRecorder(page, cfg);

  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);
  await closeAllTabs(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.click('#__rec_start');

  const c = new CuramDriver(page);
  await c.clickSection('HCR Cases and Outcomes');
  await c.clickShortcutGroup('Searches');
  await c.clickShortcutItem('Person', 'Searches');
  await c.enter('bo', 'First Name');
  await c.clickButton('Search');
  await c.clickContentLink('', 'Search Results', { strategy: { type: 'row', row: 1 } });
  await c.clickContentLink('', 'Current Cases', { strategy: { type: 'predicate', where: { Type: 'Insurance Affordability' } } });
  await c.selectNav('Home');
  await page.waitForTimeout(2000);
  await c.clickContentLink('', 'Cases', { strategy: { type: 'row', row: 1 } });
  await c.selectNav('Determinations');
  await page.waitForTimeout(2000);
  await c.selectNavItem('Current Determination');
  await page.waitForTimeout(3000);

  // right-click the Decision cell of row 1
  const frame = await c.contentFrame();
  await frame.evaluate(() => {
    const row = Array.from(document.querySelectorAll('table tbody tr')).find(r => r.querySelector('td') && !r.classList.contains('list-details-row'));
    row.children[2].setAttribute('data-x-cell', '1'); // Decision column
  });
  await frame.locator('[data-x-cell]').click({ button: 'right' });
  await page.waitForTimeout(800);

  // open the decision, right-click a context-panel field
  await c.clickContentLink('', '', { strategy: { type: 'row', row: 1 } });
  await page.waitForTimeout(2000);
  const panel = await c._activePanel();
  const ctxFrame = await (await panel.locator('iframe[title^="Context Panel"]').last().elementHandle()).contentFrame();
  const marked = await ctxFrame.evaluate(() => {
    const n = s => (s || '').replace(/\s+/g, ' ').trim();
    for (const item of document.querySelectorAll('.cds--cluster__item--read-only-field')) {
      if (item.querySelector('.cds--cluster__item--read-only-field') || !item.offsetParent) continue;
      if (n((item.querySelector('label') || {}).textContent) === 'Decision') { item.setAttribute('data-x-fld', '1'); return true; }
    }
    return false;
  });
  console.log('context field marked:', marked);
  if (marked) await ctxFrame.locator('[data-x-fld]').click({ button: 'right' });
  await page.waitForTimeout(800);

  await page.click('#__rec_stop');
  await page.waitForTimeout(1000);
  // save without touching review choices
  await page.fill('#__rec_name', 'test-assert-row');
  await page.click('#__rec_savebtn');
  await page.waitForTimeout(1000);
  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'test-assert-row.json'), 'utf8'));
  console.log('--- SAVED DSL ---');
  for (const s of saved.steps) console.log(' ', s.dsl);
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
