'use strict';
const {app, BrowserWindow, Menu, protocol, net, dialog, shell}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

// Stable storage lives outside the portable launcher's temporary extraction directory.
if(process.env.SKYCRM_TEST_USER_DATA)app.setPath('userData',path.resolve(process.env.SKYCRM_TEST_USER_DATA));
else app.setPath('userData',path.join(app.getPath('appData'),'SkyCRM'));
protocol.registerSchemesAsPrivileged([{scheme:'skycrm',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const ownsLock=app.requestSingleInstanceLock();
if(!ownsLock)app.quit();
else {
 let window;
 app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
 app.whenReady().then(async()=>{
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
   {label:'파일',submenu:[{label:'데이터 저장 폴더 열기',click:()=>shell.openPath(app.getPath('userData'))},{type:'separator'},{role:'quit',label:'종료'}]},
   {label:'편집',submenu:[{label:'실행 취소',click:()=>window.webContents.executeJavaScript("if(document.activeElement?.closest('#memo-content')) tool('undo'); else document.execCommand('undo');")},{label:'다시 실행',click:()=>window.webContents.executeJavaScript("if(document.activeElement?.closest('#memo-content')) tool('redo'); else document.execCommand('redo');")},{type:'separator'},{role:'cut',label:'잘라내기'},{role:'copy',label:'복사'},{role:'paste',label:'붙여넣기'},{role:'selectAll',label:'모두 선택'}]},
   {label:'보기',submenu:[{role:'resetZoom',label:'원래 크기'},{role:'zoomIn',label:'확대'},{role:'zoomOut',label:'축소'},{role:'togglefullscreen',label:'전체 화면'}]}
  ]));
  window=new BrowserWindow({width:1440,height:1000,minWidth:850,minHeight:650,show:false,title:'Sky CRM',backgroundColor:'#f8f7f4',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{const target=new URL(url);if(target.protocol!=='skycrm:'||target.hostname!=='app')event.preventDefault();});
  window.webContents.session.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'첨부파일 저장',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  window.once('ready-to-show',()=>window.show());
  await window.loadURL('skycrm://app/index.html');
 }).catch(error=>{dialog.showErrorBox('Sky CRM 실행 오류',error.message);app.quit();});
 app.on('window-all-closed',()=>app.quit());
}
