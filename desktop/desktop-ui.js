'use strict';
(async()=>{
 const bridge=window.skycrmDesktop;if(!bridge)return;
 const bar=document.createElement('section');bar.id='desktop-files';bar.setAttribute('aria-label','데이터 파일 및 백업');
 bar.innerHTML='<div class="desktop-file-actions"><button data-file-action="open">파일 열기</button><button data-file-action="save">저장</button><button data-file-action="save-as">다른 이름으로 저장</button><button data-file-action="backups">백업 복구 (3개)</button><button data-file-action="ftp-open">FTP에서 불러오기</button><button data-file-action="sync">FTP 동기화</button><button data-file-action="settings">환경설정</button></div><p id="desktop-file-status" role="status">데이터 파일 확인 중…</p>';
 document.querySelector('nav').after(bar);
 const modal=document.createElement('dialog');modal.id='desktop-dialog';document.body.append(modal);
 let saving=Promise.resolve();
 let ready=false,busy=false,dirty=false,revision=0,timer=null,syncTimer=null,status=null;
 const call=(command,payload)=>bridge.call(command,payload);
 function showStatus(value){if(value)status=value;const node=$('#desktop-file-status');if(!status)return;node.textContent=(status.preview?'복구 미리보기 · Ctrl+S로 현재 파일에 저장 · ':'')+status.path+(status.settings.type==='local'?' · PC 자동 저장':status.unsynced?' · PC 저장됨 / FTP 동기화 대기':' · FTP 사용');}
 function fail(error){$('#desktop-file-status').textContent='오류: '+error.message;alert(error.message);}
 function schedule(){clearTimeout(timer);if(ready&&dirty&&!busy&&!status?.preview)timer=setTimeout(()=>flush(false,false).catch(error=>{$('#desktop-file-status').textContent='저장 실패: '+error.message;}),2000);}
 function configureTimer(){clearInterval(syncTimer);if(status?.settings.type!=='local')syncTimer=setInterval(()=>{if(!busy&&!modal.open&&ready&&!status?.preview)flush(true,false).catch(error=>{$('#desktop-file-status').textContent='FTP 동기화 실패 · PC 저장본 유지: '+error.message;});},(status?.settings.autosave_minutes||5)*60000);}
 function toBase64(bytes){let value='';for(let n=0;n<bytes.length;n+=16384)value+=String.fromCharCode(...bytes.subarray(n,n+16384));return btoa(value);}
 async function snapshot(){
  await assetWork;const data=JSON.parse(JSON.stringify(state)),assets=[];
  for(const id of new Set(stateAssetIds(data))){const record=await getAsset(id);if(!record?.blob)throw new Error('첨부파일 원본을 찾지 못했습니다. 기존 데이터 파일을 보존하며 저장을 중단했습니다.');const {blob,...metadata}=record;assets.push({...metadata,data:toBase64(new Uint8Array(await blob.arrayBuffer()))});}
  return {state:data,assets};
 }
 function flush(sync=false,manual=false){const next=saving.then(()=>writeSnapshot(sync,manual));saving=next.catch(()=>{});return next;}
 async function writeSnapshot(sync=false,manual=false){
  clearTimeout(timer);if(!ready)throw new Error('데이터 파일을 아직 열지 못했습니다. 파일 열기 또는 다른 이름으로 저장을 사용하세요.');
  const current=revision,bundle=await snapshot();showStatus(await call('save',{bundle,sync,manual}));if(current===revision&&!status.preview)dirty=false;if(dirty&&!status.preview)schedule();return status;
 }
 window.desktopFlush=async(...args)=>{while(busy)await new Promise(resolve=>setTimeout(resolve,50));await saving;return flush(...args);};
 async function install(bundle){
  if(!bundle)return;await saving;await assetWork;clearTimeout(timer);
  const previous=state,previousText=localStorage.getItem(KEY),previousAssets=new Map();
  try{
   for(const a of bundle.assets)previousAssets.set(a.id,await getAsset(a.id));
   await writeAssets(bundle.assets.map(({data,...a})=>({...a,blob:new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:a.type||'application/octet-stream'})})));
   closeMemoOverlays();state=bundle.state;normalizeMemos();localStorage.setItem(KEY,JSON.stringify(state));
   const next=await call('activate',bundle.token);
   for(const url of assetURLs.values())URL.revokeObjectURL(url);assetURLs.clear();assetURLRequests.clear();
   memoId='';selected='';selectedFolder='';history=[];historyIndex=-1;query='';sortKey='';tab='calls';start='';end='';
   document.querySelectorAll('nav [data-tab]').forEach(node=>node.classList.toggle('active',node.dataset.tab==='calls'));render();
   ready=true;dirty=false;revision++;showStatus(next);configureTimer();
   $('#status').textContent=(bundle.warning?bundle.warning+' · ':'')+(bundle.recovered?'손상된 데이터에서 백업으로 복구했습니다. ':'')+(bundle.preview?'복구본을 확인한 뒤 Ctrl+S로 저장하세요.':'불러옴: '+bundle.source);
  }catch(error){
   state=previous;if(previousText===null)localStorage.removeItem(KEY);else localStorage.setItem(KEY,previousText);
   const restore=[...previousAssets.values()].filter(Boolean);if(restore.length)await writeAssets(restore);
   const added=[...previousAssets].filter(([,value])=>!value).map(([id])=>id);if(added.length){const db=await openAssetDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');added.forEach(id=>tx.objectStore('files').delete(id));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}
   render();throw error;
  }
 }
 async function beforeSwitch(){await saving;if(ready&&dirty&&!status?.preview)await flush(false,false);else if(dirty&&!confirm('현재 복구 미리보기의 변경을 저장하지 않고 다른 파일을 여시겠습니까?'))throw new Error('파일 열기를 취소했습니다.');}
 function openModal(title,body){modal.innerHTML=`<form method="dialog"><div class="bar"><h2>${esc(title)}</h2><button value="cancel" aria-label="닫기">×</button></div></form>${body}`;modal.showModal();}
 async function chooseBackup(){
  await beforeSwitch();const files=await call('backups');openModal('백업본에서 복구','<p>이전 저장본을 선택해 내용을 확인한 뒤 Ctrl+S로 저장하세요.</p><div class="desktop-backup-list">'+(files.length?files.map(f=>`<button data-backup-slot="${f.slot}"><strong>${esc(f.name)}</strong><small>${esc(new Date(f.modified).toLocaleString('ko-KR'))} · ${fileSize(f.size)}</small></button>`).join(''):'<p>아직 저장된 백업이 없습니다.</p>')+'</div>');
  modal.querySelectorAll('[data-backup-slot]').forEach(button=>button.onclick=()=>run(async()=>{const bundle=await call('restore',Number(button.dataset.backupSlot));modal.close();await install(bundle);}));
 }
 async function ftpFiles(){
  const files=await call('ftpList');openModal('FTP 데이터 파일 불러오기','<p>불러오기만으로 서버 파일을 덮어쓰지 않습니다. 백업 파일도 선택할 수 있습니다.</p><div class="desktop-backup-list">'+(files.length?files.map(f=>`<button data-ftp-name="${esc(f.name)}"><strong>${esc(f.name)}</strong><small>${esc(f.modified?new Date(f.modified).toLocaleString('ko-KR'):'')} · ${fileSize(f.size)}</small></button>`).join(''):'<p>폴더에 JSON 데이터 파일이 없습니다. 환경설정에서 FTP 경로를 확인하세요.</p>')+'</div>');
  modal.querySelectorAll('[data-ftp-name]').forEach(button=>button.onclick=()=>run(async()=>{await beforeSwitch();const bundle=await call('ftpOpen',button.dataset.ftpName);modal.close();await install(bundle);}));
 }
 async function preferences(initial){
  const settings=initial||await call('getSettings');
  openModal('환경설정 (저장 방식 / FTP)',`<form id="desktop-settings"><label>저장 방식<select name="type"><option value="local">하드디스크에만 저장</option><option value="local_sync">하드디스크에 저장 + FTP로 동기화</option><option value="ftp">FTP 서버 사용 (PC에도 복구용 캐시 보관)</option></select></label><label>하드디스크 저장 폴더<div class="desktop-path"><input name="local_path" required><button type="button" id="desktop-choose-folder">찾아보기</button></div></label><label>데이터 파일명<input name="data_file" required></label><fieldset><legend>FTP 서버 정보</legend><div class="desktop-settings-grid"><label>주소<input name="host" autocomplete="off"></label><label>포트<input name="port" type="number" min="1" max="65535"></label><label>아이디<input name="user" autocomplete="off"></label><label>비밀번호<input name="password" type="password" autocomplete="off"></label></div><label>서버 폴더 경로<input name="remote_path"></label><label class="desktop-checkbox"><input name="secure" type="checkbox">FTPS (TLS) 사용</label><button type="button" id="desktop-test-ftp">연결 테스트</button></fieldset><label>FTP 자동 동기화 간격 (분)<input name="autosave_minutes" type="number" min="1" max="240"></label><p>PC 파일은 자동 저장하며 이전 저장본 3개를 보관합니다. FTP는 설정한 간격·저장·종료 시 동기화합니다. 기존 서버 파일은 먼저 불러와 주세요.</p><p id="desktop-settings-result" role="status"></p><div class="actions"><button type="button" id="desktop-import-settings">기존 환경설정 가져오기</button><button class="primary" type="submit">설정 저장</button></div></form>`);
  const form=$('#desktop-settings');for(const [key,value]of Object.entries({...settings,...settings.ftp}))if(form.elements[key]){if(key==='secure')form.elements[key].checked=value;else form.elements[key].value=value;}
  const values=()=>{const data=Object.fromEntries(new FormData(form));return {type:data.type,local_path:data.local_path,data_file:data.data_file,autosave_minutes:Number(data.autosave_minutes),ftp:{host:data.host,port:Number(data.port),user:data.user,password:data.password,remote_path:data.remote_path,secure:form.elements.secure.checked}};};
  $('#desktop-choose-folder').onclick=()=>run(async()=>{const folder=await call('chooseFolder');if(folder)form.elements.local_path.value=folder;});
  $('#desktop-test-ftp').onclick=()=>run(async()=>{await call('ftpTest',values());$('#desktop-settings-result').textContent='FTP 연결과 폴더 확인이 완료되었습니다.';});
  $('#desktop-import-settings').onclick=()=>run(async()=>{const imported=await call('importSettings');if(imported){modal.close();await preferences(imported);}});
  form.onsubmit=e=>{e.preventDefault();run(async()=>{await beforeSwitch();const result=await call('configure',values());modal.close();if(result.bundle)await install(result.bundle);else{showStatus(result.status);ready=true;dirty=true;configureTimer();schedule();}});};
 }
 async function run(action){if(busy)return;busy=true;bar.setAttribute('aria-busy','true');bar.querySelectorAll('button').forEach(b=>b.disabled=true);try{await action();}catch(error){fail(error);}finally{busy=false;bar.removeAttribute('aria-busy');bar.querySelectorAll('button').forEach(b=>b.disabled=false);schedule();}}
 const actions={
  open:async()=>{await beforeSwitch();const bundle=await call('openLocal');if(bundle)await install(bundle);},
  save:()=>flush(true,true),
  'save-as':async()=>{await saving;const current=revision;const next=await call('saveAs',await snapshot());if(next){ready=true;dirty=current!==revision;showStatus(next);configureTimer();}},
  backups:chooseBackup,settings:()=>preferences(),'ftp-open':ftpFiles,
  sync:async()=>{if(status?.settings.type==='local')throw new Error('환경설정에서 FTP 저장 방식을 선택하세요.');await flush(true,true);}
 };
 bar.onclick=e=>{const action=e.target.closest('[data-file-action]')?.dataset.fileAction;if(actions[action])run(actions[action]);};
 bridge.onAction(action=>{if(actions[action])run(actions[action]);});
 document.addEventListener('skycrm-persist',()=>{dirty=true;revision++;schedule();});
 document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopImmediatePropagation();run(actions[e.shiftKey?'save-as':'save']);}},true);
 try{const result=await call('startup');status={settings:result.settings,path:'',preview:false,unsynced:false};if(result.bundle)await install(result.bundle);else{ready=true;showStatus(await call('status'));dirty=true;configureTimer();schedule();}}catch(error){showStatus(await call('status'));fail(error);}
 document.documentElement.dataset.desktopReady='true';
})();
