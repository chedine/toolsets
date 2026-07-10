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

  await step('click section "HCR Cases and Outcomes"',                    () => c.clickSection('HCR Cases and Outcomes'));
  await step('select tab "Insurance Affordability * - Francis Mertz"',    () => c.selectTab('Insurance Affordability * - Francis Mertz'));
  await step('select nav "Evidence"',                                     () => c.selectNav('Evidence'));
  await step('select navitem "Dashboard"',                                () => c.selectNavItem('Dashboard'));

  // verify: content frame should be the evidence dashboard
  const frame = await c.contentFrame();
  const h = await frame.locator('body').evaluate(b => document.title || b.querySelector('h1,h2')?.textContent || '');
  console.log('content frame doc title:', h);
  console.log('content frame url:', frame.url().split('/').pop().split('?')[0]);
  await page.screenshot({ path: 'scenario2.png' });
  await browser.close();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
