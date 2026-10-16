'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {_electron}=require('playwright-core');
let stage='자동 저장 검증 시작';const watchdog=setTimeout(()=>{console.error('::error::Windows 자동 저장 검증 시간 초과: '+stage);process.exit(1);},180000);watchdog.unref();
const waitFor=async(check,message)=>{const end=Date.now()+15000;do{try{if(await check())return;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw new Error(message);};
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'skycrm-auto-')),profile=path.join(root,'profile'),remote=path.join(root,'server');let app,server,failed=false;
 try{
  await fs.mkdir(profile);await fs.mkdir(remote);
  const source={clients:{'기존 거래처':['010-0000-0000','','','']},calls:[],memo_tasks_v1:[{id:'memo-auto',kind:'note',name:'저장 검증',text:'처음 메모'}]};
  await fs.writeFile(path.join(remote,'call_data.json'),JSON.stringify(source));await fs.writeFile(path.join(profile,'call_data.json'),JSON.stringify(source));
  server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'ftp-server.py'),remote],{env:process.env,stdio:['ignore','pipe','pipe']});server.stderr.on('data',()=>{});
  const port=await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('FTP fixture timeout')),15000);server.stdout.on('data',chunk=>{data+=chunk;try{const value=JSON.parse(data.split('\n')[0]);clearTimeout(timer);resolve(value.port);}catch{}});server.on('error',reject);});
  await fs.writeFile(path.join(profile,'desktop-storage.json'),JSON.stringify({type:'local_sync',local_path:profile,data_file:'call_data.json',autosave_minutes:10,ftp:{host:'127.0.0.1',port,user:'skycrm-test',password:'test-only',remote_path:'/'}}));
  app=await _electron.launch({executablePath:process.env.SKYCRM_EXECUTABLE||path.resolve(__dirname,'../../desktop/out/win-unpacked/SkyCRM.exe'),env:{...process.env,SKYCRM_TEST_USER_DATA:profile},timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.waitForFunction(()=>document.documentElement.dataset.desktopReady==='true');
  const menu=label=>app.evaluate(({Menu},label)=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label===label).click(),label);
  assert.equal(await page.locator('#desktop-files,.desktop-file-actions,[data-file-action]').count(),0);
  await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));
  stage='파일 메뉴로 FTP 원본 불러오기';await menu('FTP 파일 불러오기…');await page.locator('[data-ftp-name="call_data.json"]').click();await page.waitForFunction(()=>document.documentElement.dataset.desktopBusy!=='true'&&state.memos.some(m=>m.id==='memo-auto'));
  const base=await page.evaluate(()=>Date.now());
  await page.locator('[data-tab=memos]').click();await page.locator('[data-memo-edit=memo-auto]').click();await page.locator('#memo-content').fill('자동 저장된 내용');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('skycrm-web-preview-v1')).memos[0].pages[0].content),'자동 저장된 내용');
  stage='입력 후 2초 JSON 자동 저장';await page.clock.runFor(2100);await waitFor(async()=>JSON.parse(await fs.readFile(path.join(profile,'call_data.json'))).memo_tasks_v1[0].text==='자동 저장된 내용','JSON was not automatically saved');
  assert.equal(JSON.parse(await fs.readFile(path.join(remote,'call_data.json'))).memo_tasks_v1[0].text,'처음 메모');
  stage='설정한 10분 FTP 자동 동기화';const elapsed=await page.evaluate(base=>Date.now()-base,base);await page.clock.runFor(600000-elapsed-1);assert.equal(JSON.parse(await fs.readFile(path.join(remote,'call_data.json'))).memo_tasks_v1[0].text,'처음 메모');await page.clock.runFor(1);
  await waitFor(async()=>JSON.parse(await fs.readFile(path.join(remote,'call_data.json'))).memo_tasks_v1[0].text==='자동 저장된 내용','Scheduled FTP sync did not upload');assert.equal(JSON.parse(await fs.readFile(path.join(remote,'call_data.json.bak1'))).memo_tasks_v1[0].text,'처음 메모');
  await page.locator('#memo-content').fill('종료 직전 저장과 FTP 동기화');
  stage='2초/10분을 기다리지 않고 종료 시 저장·FTP';await app.close();app=null;
  for(const folder of [profile,remote])assert.equal(JSON.parse(await fs.readFile(path.join(folder,'call_data.json'))).memo_tasks_v1[0].text,'종료 직전 저장과 FTP 동기화');
  console.log('::notice::PASS Windows autosave: immediate app persistence, 2-second JSON autosave, exact configured 10-minute FTP sync with backups, final edit saved locally and uploaded on exit without waiting for timers; menu-only commands');
 }catch(error){failed=true;throw error;}finally{
  if(app){if(failed){const child=app.process();child.kill();await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',resolve);});}else await app.close();}
  if(server){server.kill();await new Promise(resolve=>{if(server.exitCode!==null||server.signalCode!==null)resolve();else server.once('exit',resolve);});}
  await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300});
 }
})().catch(error=>{console.error(error);console.error('::error::'+String(error.stack||error).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exitCode=1;});
