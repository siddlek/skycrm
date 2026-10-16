'use strict';
const {chromium}=require('playwright-core'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Storage}=require('../../desktop/storage.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'skycrm-ui-')),storage=new Storage(path.join(root,'profile'));await storage.init();
 const old={clients:{'이전 거래처':['010-0123-0000','02-0000','031-0000','거래처 기존 메모']},calls:[{id:'old-call',name:'이전 거래처',date:'2018-01-02 03:04:05',phone:'010-0123-0000',type:'송신',content:'옛 통화 기록'}],memo_tasks_v1:[{id:'old-memo',kind:'note',name:'기존 메모',text:'예전 메모 본문'}],extra:{keep:true}};
 const input=path.join(root,'old.json'),copy=path.join(root,'copy.json');await fs.writeFile(input,JSON.stringify(old));
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.type()==='alert'?d.dismiss():d.accept());
  await page.exposeFunction('storageCommand',(command,value)=>storage.serial(async()=>{switch(command){case 'startup':return storage.startup();case 'save':return storage.save(value.bundle,{sync:value.sync,manual:value.manual});case 'activate':return storage.activate(value);case 'status':return storage.status();case 'openLocal':return storage.openLocal(input);case 'saveAs':return storage.saveAs(copy,value);case 'backups':return storage.backups();case 'restore':return storage.restore(value);case 'getSettings':return storage.settings;case 'configure':return {status:await storage.configure(value)};default:throw Error(command);}}));
  await page.addInitScript(()=>window.skycrmDesktop={call:(...args)=>window.storageCommand(...args),onAction:fn=>window.nativeAction=fn});
  await page.goto(process.env.PREVIEW_URL||'http://127.0.0.1:8771');await page.waitForFunction(()=>document.documentElement.dataset.desktopReady==='true');
  const width=await page.locator('#call-name').evaluate(e=>e.getBoundingClientRect().width),phoneWidth=await page.locator('#call-phone').evaluate(e=>e.getBoundingClientRect().width);assert.ok(width>=350);assert.ok(phoneWidth>=300);
  await page.locator('[data-file-action=open]').click();await page.waitForFunction(()=>state.calls[0]?.id==='old-call'&&document.querySelector('#list').textContent.includes('옛 통화 기록'));assert.ok((await page.locator('#list').innerText()).includes('옛 통화 기록'));assert.equal(await fs.readFile(input,'utf8'),JSON.stringify(old));
  await page.locator('[data-tab=clients]').click();assert.ok((await page.locator('#list').innerText()).includes('010-0123-0000'));assert.ok((await page.locator('#list').boundingBox()).height>=550);
  await page.locator('[data-tab=memos]').click();await page.locator('[data-memo-edit=old-memo]').click();assert.equal(await page.locator('#memo-content').innerText(),'예전 메모 본문');
  await page.locator('#memo-content').fill('수정한 메모 본문');await page.locator('[data-file-action=save]').click();await page.waitForFunction(()=>!document.querySelector('#desktop-files').hasAttribute('aria-busy'));
  let data=JSON.parse(await fs.readFile(input));assert.equal(data.memo_tasks_v1[0].text,'수정한 메모 본문');assert.deepEqual(data.extra,{keep:true});assert.equal(data.clients['이전 거래처'][0],'010-0123-0000');assert.ok(await fs.stat(input+'.bak1'));
  await page.locator('[data-file-action=backups]').click();await page.locator('[data-backup-slot="1"]').click();await page.waitForFunction(()=>document.querySelector('#desktop-file-status').textContent.includes('복구 미리보기'));
  await page.locator('[data-tab=memos]').click();await page.locator('[data-memo-edit=old-memo]').click();assert.equal(await page.locator('#memo-content').innerText(),'예전 메모 본문');assert.equal(JSON.parse(await fs.readFile(input)).memo_tasks_v1[0].text,'수정한 메모 본문');
  await page.locator('[data-file-action=save-as]').click();await page.waitForFunction(()=>document.querySelector('#desktop-file-status').textContent.includes('copy.json'));assert.equal(JSON.parse(await fs.readFile(copy)).memo_tasks_v1[0].text,'예전 메모 본문');
  await page.locator('[data-file-action=settings]').click();await page.locator('#desktop-settings').waitFor();assert.equal(await page.locator('[name=data_file]').inputValue(),'copy.json');await page.locator('#desktop-dialog [aria-label=닫기]').click();
  await page.locator('[data-tab=calls]').click();await page.setViewportSize({width:900,height:750});assert.ok(await page.locator('#call-phone').isVisible());await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('#call-phone').isVisible());
  assert.deepEqual(errors,[]);console.log('PASS desktop UI: legacy file open with historical calls, original file untouched until save, phone columns, tall client list, old memo migration, native save, backup preview, save-as, settings, responsive entry widths');
 }finally{await browser.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
})().catch(error=>{console.error(error);process.exitCode=1;});
