// Headless regression for combobox-selection recording. Reproduces the bug
// where selections were misattributed to the last focused field ("Date of
// Death"): touch a date field, then open Gender/State via the CHEVRON (which
// doesn't focus the input) and pick options. Each must record under its own
// field label, not the date field.
const fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {setupRecorder,closeAllTabs,loadConfig}=require('./record');
const {CuramDriver}=require('./curam-driver');
(async()=>{
  const cfg=loadConfig();cfg.dataDir=path.join(__dirname,'data');
  const browser=await chromium.launch({headless:true});
  const ctx=await browser.newContext({viewport:cfg.viewport,ignoreHTTPSErrors:true,extraHTTPHeaders:cfg.extraHTTPHeaders});
  const page=await ctx.newPage();const state=await setupRecorder(page,cfg);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForSelector('#app-sections-container-dc',{timeout:60000});await page.waitForTimeout(4000);
  await closeAllTabs(page);await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('#app-sections-container-dc',{timeout:60000});await page.waitForTimeout(4000);
  await page.waitForSelector('#__curam_rec_overlay',{timeout:15000});await page.click('#__rec_start');

  const c=new CuramDriver(page);
  await c.clickSection('HCR Cases and Outcomes');
  await c.clickShortcutGroup('Registration');
  await c.clickShortcutItem('Person','Registration');
  await page.waitForTimeout(3500);
  await c.enter('Combo','First Name');
  await c.clickButton('Search');await c.clickButton('Next');await page.waitForTimeout(1500);

  const f=page.frames().find(fr=>/RegisterPerson_registerForPDCWizardPage/.test(fr.url()));
  // touch Date of Birth first (this is what polluted activeCombo before)
  await f.locator('[data-testid="date_Field.Label.DateofBirth"]').click();
  await f.locator('[data-testid="date_Field.Label.DateofBirth"]').fill('01/01/1984');
  await f.locator('[data-testid="date_Field.Label.DateofBirth"]').press('Tab');
  await page.waitForTimeout(500);
  // Gender: open via the chevron button (does NOT focus the input), pick option
  const genderBox=f.locator('.cds--list-box').filter({has:f.locator('[data-testid="dropdown_Field.Label.Gender"]')});
  await genderBox.locator('.cds--list-box__menu-icon, button').first().click();
  await page.waitForTimeout(700);
  await f.getByRole('option',{name:'Female',exact:true}).click();await page.waitForTimeout(600);
  // State: chevron open, pick
  const stateBox=f.locator('.cds--list-box').filter({has:f.locator('[data-testid="dropdown-5_Field.Label.PrimaryAddressData"]')});
  await stateBox.locator('.cds--list-box__menu-icon, button').first().click();await page.waitForTimeout(700);
  await f.getByRole('option',{name:'Minnesota',exact:true}).click();await page.waitForTimeout(700);

  console.log('--- recorded select-option steps ---');
  const sel=state.steps.filter(s=>s.verb==='select option');
  for(const s of sel) console.log('  ',JSON.stringify(s.args));
  const gOk=sel.some(s=>s.args[1]==='Gender'&&s.args[0]==='Female');
  const sOk=sel.some(s=>s.args[1]==='State'&&s.args[0]==='Minnesota');
  const noDeath=!sel.some(s=>/Death/i.test(s.args[1]));
  console.log('\nGender->Gender:',gOk,'| State->State:',sOk,'| none misattributed to Date of Death:',noDeath);
  console.log(gOk&&sOk&&noDeath?'PASS':'FAIL');
  await browser.close();
})().catch(e=>{console.error('TEST FAILED:',e.message);process.exit(1)});
