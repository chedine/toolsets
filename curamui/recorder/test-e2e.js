// Headless end-to-end test: wires the real recorder onto a page, then plays
// "user" — overlay Start, a real Curam flow, overlay Stop, name + Save —
// and finally checks the saved recording. Run: node test-e2e.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { setupRecorder, closeAllTabs, loadConfig } = require('./record');

(async () => {
  const cfg = loadConfig();
  cfg.dataDir = path.join(__dirname, 'data');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: cfg.viewport, ignoreHTTPSErrors: true, extraHTTPHeaders: cfg.extraHTTPHeaders });
  const page = await ctx.newPage();
  const state = await setupRecorder(page, cfg);

  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);

  console.log('--- clean tabs ---');
  await closeAllTabs(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);

  console.log('--- overlay present? ---');
  await page.waitForSelector('#__curam_rec_overlay', { timeout: 15000 });
  console.log('overlay OK');
  await page.click('#__rec_start');
  await page.waitForTimeout(500);

  console.log('--- user flow ---');
  await page.click('#app-sections-container-dc_tablist span[role="tab"][title="HCR Cases and Outcomes"]');
  await page.waitForTimeout(3000);

  const secPanel = page.locator('[id="HCRCASEAPPWorkspaceSection-sbc"]');
  const shortcuts = secPanel.locator('[role="region"][aria-label="Shortcuts"]');
  if ((await shortcuts.getAttribute('class')).includes('dojoxExpandoClosed')) {
    await shortcuts.locator('.dojoxExpandoIcon').click({ force: true });
    await page.waitForTimeout(1500);
  }
  const personLink = shortcuts.locator('[aria-label="Searches"] a.curam-content-pane-single-link[title="Person…"]');
  if (!(await personLink.isVisible())) {
    await shortcuts.locator('.dijitAccordionText[title="Searches"]').click();
    await personLink.waitFor({ state: 'visible', timeout: 10000 });
  }
  await personLink.click();
  await page.waitForTimeout(4000);

  const frameEl = secPanel.locator('.dijitTabContainerTopChildWrapper.dijitVisible iframe[title^="Content Panel"]');
  const frame = await (await frameEl.first().elementHandle()).contentFrame();
  await frame.fill('[data-testid="textinput_Cluster.Field.Label.LastName"]', 'Mertz');
  await frame.click('.action-set a.first-action-control:has-text("Search")');
  await page.waitForTimeout(6000);

  const frame2 = await (await frameEl.first().elementHandle()).contentFrame();
  await frame2.locator('table a:has-text("Francis Mertz")').first().click();
  await page.waitForTimeout(7000);

  console.log('--- stop + save via overlay ---');
  await page.click('#__rec_stop');
  await page.fill('#__rec_name', 'test-person-search');
  await page.click('#__rec_savebtn');
  await page.waitForTimeout(1000);

  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'test-person-search.json'), 'utf8'));
  console.log('--- SAVED DSL ---');
  for (const s of saved.steps) console.log(' ', s.dsl);
  console.log(`steps: ${saved.steps.length}, savedAs: ${state.savedAs}`);
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
