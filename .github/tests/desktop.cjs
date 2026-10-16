'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright-core');
const root=path.resolve(__dirname,'../..');
const executable=process.env.SKYCRM_EXECUTABLE||path.join(root,'desktop/out/win-unpacked/SkyCRM.exe');
let currentProfile;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'skycrm-desktop-check-'));
currentProfile=profile;
const freshProfile=profile+'-fresh';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let stage='Windows 앱 시작';
const watchdog=setTimeout(()=>{console.error('::error::Windows 검증 시간 초과: '+stage);process.exit(1);},180000);watchdog.unref();
(async()=>{
 let app;
 try{
  const launch=async()=>{
   app=await _electron.launch({executablePath:executable,env:{...process.env,SKYCRM_TEST_USER_DATA:currentProfile},timeout:60000});
   const window=await app.firstWindow();await window.waitForURL('skycrm://app/index.html');await window.waitForLoadState('load');window.setDefaultTimeout(20000);await window.waitForFunction(()=>document.documentElement.dataset.desktopReady==='true');
   assert.equal(new URL(window.url()).protocol,'skycrm:');
   assert.ok(await window.locator('footer').innerText().then(t=>t.includes('Windows 버전')));
   assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0],p=w.webContents.getLastWebPreferences();return {nodeIntegration:p.nodeIntegration,contextIsolation:p.contextIsolation,sandbox:p.sandbox};}),{nodeIntegration:false,contextIsolation:true,sandbox:true});
   // No network is available for subsequent app operations or restart.
   await app.evaluate(({session})=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true})));
   return window;
  };
  let page=await launch();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('[data-tab=clients]').click();await page.locator('[data-tab=calls]').click();await page.locator('[data-tab=memos]').click();
  await page.locator('[data-new-kind=note]').click();await page.locator('#memo-name').fill('EXE 저장 테스트');await page.locator('#memo-content').fill('Windows 실행 파일에서 저장한 메모');
  await page.locator('#memo-content').press('Control+End');
  await page.evaluate(png=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'이미지.png',{type:'image/png'}));document.querySelector('#memo-content').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));},png);
  await page.waitForFunction(()=>document.querySelector('.skycrm-local-image')?.dataset.assetLoaded==='true');
  await page.locator('.skycrm-local-image').click();await page.locator('#memo-image-width').fill('120');await page.locator('#memo-image-width').press('Enter');
  await page.locator('#memo-content').focus();await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')).memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width),undefined);
  await page.keyboard.press('Control+y');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')).memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width),120);
  await page.locator('#attachment-input').setInputFiles({name:'첨부.txt',mimeType:'text/plain',buffer:Buffer.from('EXE attachment bytes')});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')).memos[0].pages[0].attachments?.length===1);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')));
  assert.equal(saved.memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width,120);
  assert.equal(await page.locator('#insert-image,#image-input').count(),0);
  stage='Windows 종료 시 파일 저장';await app.close();app=null;
  stage='재실행 후 데이터 복원';page=await launch();await page.locator('[data-tab=memos]').click();await page.locator(`[data-memo-edit="${saved.memos[0].id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('.skycrm-local-image')?.dataset.assetLoaded==='true');
  assert.equal(await page.locator('#memo-name').inputValue(),'EXE 저장 테스트');
  assert.ok((await page.locator('#memo-content').innerText()).includes('Windows 실행 파일에서 저장한 메모'));
  const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')));
  assert.equal(restored.memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width,120);
  const bytes=await page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('skycrm-assets-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const row=await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return row.blob.text();},restored.memos[0].pages[0].attachments[0].id);
  assert.equal(bytes,'EXE attachment bytes');assert.deepEqual(errors,[]);
  // Import the native JSON into a clean profile to prove that bytes are in the file,
  // rather than relying on the first profile's IndexedDB.
  stage='Windows 종료 시 파일 저장';await app.close();app=null;currentProfile=freshProfile;fs.mkdirSync(freshProfile);
  stage='새 프로필에 파일 열기';page=await launch();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(profile,'call_data.json'));
  stage='기존 JSON 파일 열기';await app.evaluate(({Menu},label)=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label===label).click(),'다른 데이터 파일 열기…');await page.waitForFunction(()=>state.memos.some(m=>m.name==='EXE 저장 테스트')&&document.documentElement.dataset.desktopBusy!=='true');
  await page.locator('[data-tab=memos]').click();await page.locator(`[data-memo-edit="${saved.memos[0].id}"]`).click();await page.waitForFunction(()=>document.querySelector('.skycrm-local-image')?.dataset.assetLoaded==='true');
  const importedBytes=await page.evaluate(async()=>{const page=activePage(activeMemo()),record=await getAsset(page.attachments[0].id);return record.blob.text();});assert.equal(importedBytes,'EXE attachment bytes');
  assert.equal(await page.locator('.skycrm-local-image').evaluate(e=>e.style.width),'120px');
  console.log('::notice::PASS Windows packaged EXE: offline app, isolated renderer, all tabs, memo/image/attachment persistence across a full process restart and JSON import into a clean profile');
 }finally{if(app)await app.close();for(const folder of [profile,freshProfile])fs.rmSync(folder,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
})().catch(error=>{console.error(error);console.error('::error::'+String(error.stack||error).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exitCode=1;});
