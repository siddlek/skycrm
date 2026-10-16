'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright-core');
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'skycrm-native-files-'));let app;
 try{
  const source=path.join(profile,'original.json'),saved=path.join(profile,'chosen.json'),settings=path.join(profile,'call_settings_lite.json');
  const old={clients:{'기존 거래처':['010-0123-4567','02-0000-0000','031-0000','거래처 메모']},calls:[{id:'old-call',name:'기존 거래처',date:'2019-01-02 03:04:05',phone:'010-0123-4567',type:'수신',content:'오래된 통화 기록'}],memo_tasks_v1:[{id:'memo-old',kind:'note',name:'이전 메모',text:'이전 PC 메모'}],extra:{original:true}};
  await fs.writeFile(source,JSON.stringify(old));await fs.writeFile(settings,JSON.stringify({storage:{type:'local_sync',local_path:profile,data_file:'chosen.json',ftp:{host:'127.0.0.1',port:21,user:'test',password:'native-test-only',remote_path:'/'}},autosave_minutes:5}));
  app=await _electron.launch({executablePath:process.env.SKYCRM_EXECUTABLE||path.resolve(__dirname,'../../desktop/out/win-unpacked/SkyCRM.exe'),env:{...process.env,SKYCRM_TEST_USER_DATA:profile},timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('dialog',d=>d.type()==='alert'?d.dismiss():d.accept());await page.waitForFunction(()=>document.documentElement.dataset.desktopReady==='true');
  await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
  await page.locator('[data-file-action=open]').click();await page.waitForFunction(()=>document.querySelector('#list').textContent.includes('오래된 통화 기록'));
  assert.equal(await fs.readFile(source,'utf8'),JSON.stringify(old));await page.locator('[data-tab=clients]').click();assert.ok((await page.locator('#list').innerText()).includes('010-0123-4567'));assert.ok((await page.locator('#list').boundingBox()).height>=420);
  await page.locator('[data-tab=memos]').click();await page.locator('[data-memo-edit=memo-old]').click();assert.equal(await page.locator('#memo-content').innerText(),'이전 PC 메모');await page.locator('#memo-content').fill('새 EXE에서 수정');
  await page.locator('[data-file-action=save]').click();await page.waitForFunction(()=>!document.querySelector('#desktop-files').hasAttribute('aria-busy'));assert.equal(JSON.parse(await fs.readFile(source)).memo_tasks_v1[0].text,'새 EXE에서 수정');
  await page.locator('[data-file-action=backups]').click();await page.locator('[data-backup-slot="1"]').click();await page.waitForFunction(()=>document.querySelector('#desktop-file-status').textContent.includes('복구 미리보기'));await page.locator('[data-tab=memos]').click();await page.locator('[data-memo-edit=memo-old]').click();assert.equal(await page.locator('#memo-content').innerText(),'이전 PC 메모');assert.equal(JSON.parse(await fs.readFile(source)).memo_tasks_v1[0].text,'새 EXE에서 수정');
  await app.evaluate(({dialog},saved)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:saved});},saved);
  await page.locator('[data-file-action=save-as]').click();await page.waitForFunction(()=>document.querySelector('#desktop-file-status').textContent.includes('chosen.json'));const data=JSON.parse(await fs.readFile(saved));assert.deepEqual(data.clients,old.clients);assert.deepEqual(data.extra,old.extra);assert.equal(data.memo_tasks_v1[0].text,'이전 PC 메모');
  await page.locator('[data-file-action=settings]').click();await app.evaluate(({dialog},settings)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[settings]});},settings);await page.locator('#desktop-import-settings').click();await page.waitForFunction(()=>document.querySelector('[name=host]')?.value==='127.0.0.1');assert.equal(await page.locator('[name=password]').inputValue(),'native-test-only');await page.locator('[name=type]').selectOption('local');await page.locator('#desktop-settings [type=submit]').click();await page.waitForFunction(()=>!document.querySelector('#desktop-dialog').open);
  const config=await fs.readFile(path.join(profile,'desktop-storage.json'),'utf8');assert.ok(config.includes('encryptedPassword'));assert.ok(!config.includes('native-test-only'));
  await app.close();app=null;
  console.log('::notice::PASS Windows native storage UI: JSON/old dates/phone fields, original file preservation, manual save, backup preview, save-as, legacy FTP settings import, Windows-encrypted FTP password');
 }finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
})().catch(error=>{console.error(error);console.error('::error::'+String(error.stack||error).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exitCode=1;});
