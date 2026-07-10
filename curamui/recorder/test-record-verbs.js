// Headless round trip for the new verbs: drive the verifications flow with
// the recorder armed (driver clicks are real DOM events, so the injected
// classifier sees exactly what a user produces), inspect the emitted steps +
// review UI, save, then replay the saved recording.
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

  await page.waitForSelector('#__curam_rec_overlay', { timeout: 15000 });
  await page.click('#__rec_start');

  const c = new CuramDriver(page);
  await c.clickSection('HCR Cases and Outcomes');
  await c.clickShortcutGroup('Searches');
  await c.clickShortcutItem('Person', 'Searches');
  await c.enter('bo', 'First Name');
  await c.clickButton('Search');
  await c.clickContentLink('Bo Stokes - 091551122', 'Search Results');
  await c.clickContentLink('', 'Current Cases', { strategy: { type: 'predicate', where: { Type: 'Insurance Affordability' } } });
  await c.selectNav('Evidence');
  await page.waitForTimeout(2000);
  await c.selectNavItem('Verifications');
  await page.waitForTimeout(3000);
  await c.selectPageTab('Verified');
  await c.selectPageTab('Outstanding');
  await c.expandRow('', { strategy: { type: 'predicate', where: { 'Items for Verification': 'Income Type' } } }, true);

  // right-click a read-only display field in the expanded row, if one loaded
  await page.waitForTimeout(3000);
  let asserted = false;
  for (const f of page.frames()) {
    const marked = await f.evaluate(() => {
      const txt = e => (e && e.textContent || '').replace(/\s+/g, ' ').trim();
      for (const item of document.querySelectorAll('.cds--cluster__item--read-only-field')) {
        if (!item.offsetParent) continue;
        if (txt(item.querySelector('label')) && txt(item.querySelector('.cds--field'))) {
          item.setAttribute('data-x-assert', '1');
          return { label: txt(item.querySelector('label')), value: txt(item.querySelector('.cds--field')) };
        }
      }
      return null;
    }).catch(() => null);
    if (marked) {
      await f.locator('[data-x-assert]').click({ button: 'right' });
      asserted = true;
      console.log(`right-clicked display field "${marked.label}" = "${marked.value}" in`, f.url().split('/').pop().split('?')[0]);
      break;
    }
  }
  if (!asserted) console.log('(no labeled read-only field found to right-click)');

  await c.expandRow('', { strategy: { type: 'predicate', where: { 'Items for Verification': 'Income Type' } } }, false);
  await c.clickRowMenu('Add Proof', '', { strategy: { type: 'predicate', where: { 'Items for Verification': 'Income Type' } } });
  await c.clickButton('Cancel');

  // -- stop: review UI --
  await page.click('#__rec_stop');
  await page.waitForTimeout(1500);
  const flags = page.locator('#__rec_review .__rec_flag');
  console.log('--- REVIEW UI ---');
  const nFlags = await flags.count();
  for (let i = 0; i < nFlags; i++) {
    const f = flags.nth(i);
    const label = await f.locator('div').first().textContent();
    const choices = await f.locator('label').allTextContents();
    console.log(` flag: ${label.trim()} | ${choices.map(x => x.trim()).join(' / ')}`);
    // pick predicate where offered, else row
    const pred = f.locator('input[value="predicate"]');
    if (await pred.count()) await pred.check(); else await f.locator('input[value="row"]').check();
  }
  await page.fill('#__rec_name', 'test-verif-verbs');
  await page.click('#__rec_savebtn');
  await page.waitForTimeout(1000);

  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'test-verif-verbs.json'), 'utf8'));
  console.log('--- SAVED DSL ---');
  for (const s of saved.steps) console.log(' ', s.dsl);
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
