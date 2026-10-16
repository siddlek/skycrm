'use strict';
const {app, BrowserWindow, Menu, protocol, net, dialog, shell, ipcMain, safeStorage}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

// Stable storage lives outside the portable launcher's temporary extraction directory.
if(process.env.SKYCRM_TEST_USER_DATA)app.setPath('userData',path.resolve(process.env.SKYCRM_TEST_USER_DATA));
else app.setPath('userData',path.join(app.getPath('appData'),'SkyCRM'));
protocol.registerSchemesAsPrivileged([{scheme:'skycrm',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const {Storage,config}=require('./storage.cjs');
const ownsLock=app.requestSingleInstanceLock();
if(!ownsLock)app.quit();
else {
 let window,storage,allowClose=false;
 const dispatch=action=>window?.webContents.send('desktop-action',action);
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.whenReady().then(async()=>{
  storage=new Storage(app.getPath('userData'),{secrets:{
   encrypt:value=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 비밀번호 암호화를 사용할 수 없습니다.');return safeStorage.encryptString(value).toString('base64');},
   decrypt:value=>safeStorage.decryptString(Buffer.from(value,'base64'))
  }});
  await storage.init();
  ipcMain.handle('desktop-storage',async(event,command,value)=>{
   if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('허용되지 않은 요청입니다.');
   return storage.serial(async()=>{
    switch(command){
     case 'startup':return storage.startup();
     case 'status':return storage.status();
     case 'getSettings':return storage.settings;
     case 'save':return storage.save(value.bundle,{sync:!!value.sync,manual:!!value.manual});
     case 'activate':return storage.activate(value);
     case 'openLocal':{
      const picked=await dialog.showOpenDialog(window,{title:'데이터 파일 열기 (기존 JSON / 백업)',defaultPath:storage.settings.local_path,properties:['openFile'],filters:[{name:'데이터 및 백업',extensions:['json','bak1','bak2','bak3']},{name:'모든 파일',extensions:['*']}]});
      return picked.canceled?null:storage.openLocal(picked.filePaths[0]);
     }
     case 'saveAs':{
      const picked=await dialog.showSaveDialog(window,{title:'다른 이름으로 저장',defaultPath:path.join(storage.settings.local_path,storage.settings.data_file),filters:[{name:'JSON 데이터',extensions:['json']}]});
      return picked.canceled?null:storage.saveAs(picked.filePath,value);
     }
     case 'backups':return storage.backups();
     case 'restore':return storage.restore(value);
     case 'ftpList':return storage.ftpList();
     case 'ftpOpen':return storage.ftpOpen(value);
     case 'ftpTest':return storage.ftpTest(value);
     case 'chooseFolder':{
      const picked=await dialog.showOpenDialog(window,{title:'데이터 저장 폴더',defaultPath:storage.settings.local_path,properties:['openDirectory','createDirectory']});return picked.canceled?null:picked.filePaths[0];
     }
     case 'importSettings':{
      const picked=await dialog.showOpenDialog(window,{title:'기존 call_settings_lite.json 가져오기',properties:['openFile'],filters:[{name:'JSON 설정',extensions:['json']}]});
      if(picked.canceled)return null;
      const legacy=JSON.parse((await require('node:fs/promises').readFile(picked.filePaths[0],'utf8')).replace(/^\uFEFF/,''));
      const source=legacy.storage||legacy;
      return config({...source,data_file:path.basename(String(source.data_file||'call_data.json').replaceAll('\\','/')),autosave_minutes:legacy.autosave_minutes},app.getPath('userData'));
     }
     case 'configure':{
      const next=config(value,app.getPath('userData')),target=storage.file(next);
      if(target!==storage.file())try{await require('node:fs/promises').access(target);return {bundle:await storage.candidate(target,next)};}catch(e){if(e.code!=='ENOENT')throw e;}
      return {status:await storage.configure(next)};
     }
     default:throw new Error('지원하지 않는 작업입니다.');
    }
   });
  });
  const root=path.join(__dirname,'assets');
  protocol.handle('skycrm',request=>{
   const url=new URL(request.url);
   if(url.hostname!=='app'||!['GET','HEAD'].includes(request.method))return new Response('Forbidden',{status:403});
   let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{return new Response('Invalid path',{status:400});}
   const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
   if(!file.startsWith(root+path.sep))return new Response('Forbidden',{status:403});
   return net.fetch(pathToFileURL(file).href);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
   {label:'파일',submenu:[
    {label:'다른 데이터 파일 열기…',accelerator:'CommandOrControl+O',click:()=>dispatch('open')},
    {label:'저장 / FTP 동기화',accelerator:'CommandOrControl+S',click:()=>dispatch('save')},
    {label:'다른 이름으로 저장…',accelerator:'CommandOrControl+Shift+S',click:()=>dispatch('save-as')},
    {label:'백업본에서 복구…',click:()=>dispatch('backups')},
    {type:'separator'},
    {label:'환경설정 (저장 방식 / FTP)…',click:()=>dispatch('settings')},
    {label:'FTP 파일 불러오기…',click:()=>dispatch('ftp-open')},
    {label:'FTP 지금 동기화',click:()=>dispatch('sync')},
    {type:'separator'},
    {label:'데이터 저장 폴더 열기',click:()=>shell.openPath(storage.settings.type==='ftp'?app.getPath('userData'):storage.settings.local_path)},{type:'separator'},{role:'quit',label:'종료'}]},
   {label:'편집',submenu:[{label:'실행 취소',click:()=>window.webContents.executeJavaScript("if(document.activeElement?.closest('#memo-content')) tool('undo'); else document.execCommand('undo');")},{label:'다시 실행',click:()=>window.webContents.executeJavaScript("if(document.activeElement?.closest('#memo-content')) tool('redo'); else document.execCommand('redo');")},{type:'separator'},{role:'cut',label:'잘라내기'},{role:'copy',label:'복사'},{role:'paste',label:'붙여넣기'},{role:'selectAll',label:'모두 선택'}]},
   {label:'보기',submenu:[{role:'resetZoom',label:'원래 크기'},{role:'zoomIn',label:'확대'},{role:'zoomOut',label:'축소'},{role:'togglefullscreen',label:'전체 화면'}]}
  ]));
  window=new BrowserWindow({width:1440,height:1000,minWidth:850,minHeight:650,show:false,title:'Sky CRM',backgroundColor:'#f8f7f4',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{const target=new URL(url);if(target.protocol!=='skycrm:'||target.hostname!=='app')event.preventDefault();});
  window.webContents.session.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'첨부파일 저장',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  window.on('close',event=>{
   if(allowClose)return;event.preventDefault();
   (async()=>{
    if(storage.preview){const picked=await dialog.showMessageBox(window,{type:'question',message:'복구 미리보기 내용을 현재 데이터 파일에 저장하시겠습니까?',buttons:['현재 파일에 저장','저장하지 않고 종료','취소'],defaultId:0,cancelId:2});if(picked.response===2)return;if(picked.response===1){allowClose=true;window.close();return;}}
    try{await window.webContents.executeJavaScript('window.desktopFlush ? window.desktopFlush(true, true) : Promise.resolve()');allowClose=true;window.close();}
    catch(error){const picked=await dialog.showMessageBox(window,{type:'warning',message:'저장 또는 FTP 동기화를 완료하지 못했습니다.',detail:error.message,buttons:['다시 시도','PC에 저장한 내용으로 종료','취소'],defaultId:0,cancelId:2});if(picked.response===0)window.close();else if(picked.response===1){allowClose=true;window.close();}}
   })();
  });
  window.once('ready-to-show',()=>window.show());
  await window.loadURL('skycrm://app/index.html');
 }).catch(error=>{dialog.showErrorBox('Sky CRM 실행 오류',error.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());
}
