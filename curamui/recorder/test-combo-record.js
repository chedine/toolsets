// Headless: recorder armed + CuramDriver navigates the registration wizard.
// Gender is picked via a real option click; State via type-narrow + Enter.
// Verify both emit `select option` steps.
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
  await c.clickButton('Search');
  await c.clickButton('Next');
  await page.waitForTimeout(1500);

  const f=page.frames().find(fr=>/RegisterPerson_registerForPDCWizardPage/.test(fr.url()));
  console.log("register frame:",!!f);
  // --- Gender: user path = click field, click the "Male" option
  const gender=f.locator('[data-testid="dropdown_Field.Label.Gender"]');
  await gender.click();await page.waitForTimeout(800);
  await f.getByRole('option',{name:'Male',exact:true}).click();
  await page.waitForTimeout(700);
  console.log('gender value:',await gender.inputValue());
  // --- State: type "min" then Enter
  const st=f.locator('[data-testid="dropdown-5_Field.Label.PrimaryAddressData"]');
  await st.click();await st.type('min',{delay:60});await page.waitForTimeout(900);await st.press('Enter');
  await page.waitForTimeout(900);
  console.log('state value:',await st.inputValue());
  await page.waitForTimeout(600);

  console.log('--- recorded steps ---');
  for(const s of state.steps) console.log('  ',s.verb,JSON.stringify(s.args));
  const sel=state.steps.filter(s=>s.verb==='select option');
  const gOk=sel.some(s=>/Gender/i.test(s.args[1])&&s.args[0]==='Male');
  const sOk=sel.some(s=>/State/i.test(s.args[1])&&/Minnesota/i.test(s.args[0]));
  console.log('\nGender=Male recorded:',gOk,'| State=Minnesota recorded:',sOk);
  console.log(gOk&&sOk?'PASS':'FAIL');
  await browser.close();
})().catch(e=>{console.error('TEST FAILED:',e.message);process.exit(1)});
