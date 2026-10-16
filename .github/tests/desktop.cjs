'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright-core');
const root=path.resolve(__dirname,'../..');
const executable=process.env.SKYCRM_EXECUTABLE||path.join(root,'desktop/out/win-unpacked/SkyCRM.exe');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'skycrm-desktop-check-'));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
(async()=>{
 let app;
 try{
  const launch=async()=>{
   app=await _electron.launch({executablePath:executable,env:{...process.env,SKYCRM_TEST_USER_DATA:profile},timeout:60000});
   const window=await app.firstWindow();await window.waitForLoadState('load');
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
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')).memos[0].pages[0].attachments.length===1);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')));
  assert.equal(saved.memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width,120);
  assert.equal(await page.locator('#insert-image,#image-input').count(),0);
  await app.close();app=null;
  page=await launch();await page.locator('[data-tab=memos]').click();await page.locator(`[data-memo-edit="${saved.memos[0].id}"]`).click();
  await page.waitForFunction(()=>document.querySelector('.skycrm-local-image')?.dataset.assetLoaded==='true');
  assert.equal(await page.locator('#memo-name').inputValue(),'EXE 저장 테스트');
  assert.ok((await page.locator('#memo-content').innerText()).includes('Windows 실행 파일에서 저장한 메모'));
  const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')));
  assert.equal(restored.memos[0].pages[0].delta.ops.find(op=>op.insert?.localImage).insert.localImage.width,120);
  const bytes=await page.evaluate(async id=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('skycrm-assets-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const row=await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return row.blob.text();},restored.memos[0].pages[0].attachments[0].id);
  assert.equal(bytes,'EXE attachment bytes');assert.deepEqual(errors,[]);
  console.log('PASS Windows packaged EXE: offline app, isolated renderer, all tabs, memo/image/attachment persistence across a full process restart');
 }finally{if(app)await app.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
})().catch(error=>{console.error(error);process.exitCode=1;});
