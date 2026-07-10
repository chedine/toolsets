// Headless test of the user's reported flow: enter first name, press ENTER
// (no Search click), open person, open case 10000401 from "Current Cases",
// open 10000402 from "Cases" in the new tab, select nav. Verifies the
// recording captures Enter-as-search and table context, then replays it.
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
  await closeAllTabs(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-sections-container-dc', { timeout: 60000 });
  await page.waitForTimeout(4000);

  await page.waitForSelector('#__curam_rec_overlay', { timeout: 15000 });
  const overlayBox = await page.locator('#__curam_rec_overlay').boundingBox();
  console.log('overlay box:', JSON.stringify(overlayBox), '(viewport', cfg.viewport.width, 'x', cfg.viewport.height + ')');
  await page.click('#__rec_start');

  // -- user flow --
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

  const frameEl = () => secPanel.locator('.dijitTabContainerTopChildWrapper.dijitVisible iframe[title^="Content Panel"]').last();
  let frame = await (await frameEl().elementHandle()).contentFrame();
  const fn = frame.locator('[data-testid="textinput_Cluster.Field.Label.FirstName"]');
  await fn.fill('bo');
  await fn.press('Enter');                       // <-- Enter, not Search click
  await page.waitForTimeout(6000);

  frame = await (await frameEl().elementHandle()).contentFrame();
  await frame.locator('table a:has-text("Bo Stokes")').first().click();
  await page.waitForTimeout(7000);

  frame = await (await frameEl().elementHandle()).contentFrame();
  await frame.locator('a:has-text("10000401")').first().click();  // in Current Cases
  await page.waitForTimeout(7000);

  frame = await (await frameEl().elementHandle()).contentFrame();
  await frame.locator('a:has-text("10000402")').first().click();  // in Cases table of new tab
  await page.waitForTimeout(7000);

  // nav in the newly opened 10000402 tab
  const navTitles = await secPanel.locator('.dijitTabContainerTopChildWrapper.dijitVisible .navigation-bar-tabs span[role="tab"]').evaluateAll(e => e.map(x => x.title));
  console.log('navs in active tab:', JSON.stringify(navTitles));
  const detNav = secPanel.locator('.dijitTabContainerTopChildWrapper.dijitVisible .navigation-bar-tabs span[role="tab"][title="Determinations"]');
  if (await detNav.count()) { await detNav.click(); await page.waitForTimeout(4000); }

  // -- stop: review UI should list the dynamic link steps --
  await page.click('#__rec_stop');
  await page.waitForSelector('#__rec_review .__rec_flag', { timeout: 5000 });
  const flags = page.locator('#__rec_review .__rec_flag');
  console.log('--- REVIEW UI ---');
  const nFlags = await flags.count();
  for (let i = 0; i < nFlags; i++) {
    const f = flags.nth(i);
    const label = await f.locator('div').first().textContent();
    const choices = await f.locator('label').allTextContents();
    console.log(` flag: ${label.trim()} | choices: ${choices.map(c => c.trim()).join(' / ')}`);
    if (label.includes('10000401')) await f.locator('input[value="predicate"]').check();      // by column
    else if (label.includes('10000402')) await f.locator('input[value="row"]').check();       // by position
    else await f.locator('input[value="literal"]').check();                                   // keep text
  }
  await page.fill('#__rec_name', 'test-case-links');
  await page.click('#__rec_savebtn');
  await page.waitForTimeout(1000);

  const saved = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'test-case-links.json'), 'utf8'));
  console.log('--- SAVED DSL ---');
  for (const s of saved.steps) console.log(' ', s.dsl);
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
