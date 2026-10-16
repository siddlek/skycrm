'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const format=require('../../desktop/data-format.cjs'),{Storage}=require('../../desktop/storage.cjs');
const legacy={clients:{'기존 거래처':['010-0123-4567','02-001-002','031-003','기존 메모\n두 번째 줄','추가 필드']},calls:[{id:'call-old',name:'기존 거래처',date:'2020-01-02 03:04:05',phone:'010-0123-4567',type:'송신',content:'예전 통화 내용'}],memo_tasks_v1:[{id:'task-parent',kind:'task',name:'상위 할 일',text:'원문',parent:'',done:true,expanded:false},{id:'task-child',kind:'task',text:'하위 할 일',parent:'task-parent',source_call_id:'call-old'}],unrelated:{calendar:['보존해야 할 정보']}};
const payload=()=>format.decode(JSON.stringify(legacy));
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'skycrm-storage-'));let server;
 try{
  const decoded=payload();assert.equal(decoded.state.clients[0].phone,'010-0123-4567');assert.equal(decoded.state.calls[0].date,'2020-01-02T03:04:05');assert.equal(decoded.state.memos[1].parent,'task-parent');assert.equal(decoded.state.memos[1].sourceCallId,'call-old');assert.equal(decoded.state.memos[0].collapsed,true);
  const encoded=format.encode(decoded,decoded.raw);assert.deepEqual(JSON.parse(JSON.stringify(encoded.clients)),legacy.clients);assert.deepEqual(encoded.unrelated,legacy.unrelated);assert.equal(encoded.calls[0].date,legacy.calls[0].date);assert.throws(()=>format.decode('{"clients":{}}'));assert.throws(()=>format.decode('{"clients":{"오류":5},"calls":[]}'));
  const image={id:'file-image',name:'원본.png',kind:'image',type:'image/png',size:3,data:Buffer.from([0,128,255]).toString('base64')};
  const bundle=payload();bundle.assets=[image];bundle.state.memos[0].pages=[{id:'page',name:'서식 탭',content:'굵은 글자',delta:{ops:[{insert:'굵은 글자',attributes:{bold:true}},{insert:{localImage:{id:image.id,name:image.name,width:260}}},{insert:'\n'}]},assetIds:[image.id],attachments:[]}];
  const large=Buffer.alloc(6*1024*1024,0x42),largeAsset={...image,id:'large-file',kind:'file',name:'큰 첨부.bin',type:'application/octet-stream',size:large.length,data:large.toString('base64')};
  const big=payload();big.assets=[largeAsset];big.state.memos[0].pages=[{id:'big-page',name:'새 탭',content:'',attachments:[{id:largeAsset.id,name:largeAsset.name,size:largeAsset.size}]}];assert.equal(Buffer.from(format.decode(format.encode(big,legacy)).assets[0].data,'base64').compare(large),0);
  assert.deepEqual(format.decode(format.encode(bundle,legacy)).assets,[image]);assert.throws(()=>format.encode({...bundle,assets:[]},legacy),/원본/);
  const local=path.join(root,'local'),store=new Storage(local);await store.init();assert.equal((await store.startup()).bundle,null);
  for(let i=0;i<5;i++){bundle.state.calls[0].content='저장 '+i;await store.save(bundle,{manual:true});}
  assert.equal(JSON.parse(await fs.readFile(store.file())).calls[0].content,'저장 4');
  for(let i=1;i<=3;i++)assert.equal(JSON.parse(await fs.readFile(store.file()+'.bak'+i)).calls[0].content,'저장 '+(4-i));
  const restored=await store.restore(2);await store.activate(restored.token);await store.save(restored,{manual:false});assert.equal(JSON.parse(await fs.readFile(store.file())).calls[0].content,'저장 4');await store.save(restored,{manual:true});assert.equal(JSON.parse(await fs.readFile(store.file())).calls[0].content,'저장 2');
  await fs.writeFile(store.file(),'corrupt');await assert.rejects(()=>store.save(bundle,{manual:true}),/앱 밖에서 변경/);
  const reopened=new Storage(local);await reopened.init();const recovery=await reopened.startup();assert.equal(recovery.bundle.recovered,true);await reopened.activate(recovery.bundle.token);await reopened.save(recovery.bundle,{manual:true});assert.ok((await fs.readdir(local)).some(f=>f.includes('.corrupt-')));
  const oldFile=path.join(root,'legacy.json');await fs.writeFile(oldFile,'\uFEFF'+JSON.stringify(legacy));const opened=await reopened.openLocal(oldFile);assert.equal(await fs.readFile(oldFile,'utf8'),'\uFEFF'+JSON.stringify(legacy));await reopened.activate(opened.token);await reopened.save(opened,{manual:true});assert.deepEqual(JSON.parse(await fs.readFile(oldFile)).unrelated,legacy.unrelated);assert.ok(await fs.stat(oldFile+'.bak1'));
  console.log('PASS data compatibility: original JSON/BOM/phones/dates/hierarchy/unknown fields, rich image bytes, exact 3 rotating backups, preview/manual restore, corrupt-file recovery, external modification protection');
  const remote=path.join(root,'ftp');await fs.mkdir(remote);await fs.writeFile(path.join(remote,'existing.json'),JSON.stringify(legacy));
  server=spawn(process.env.PYTHON||'python',[path.join(__dirname,'ftp-server.py'),remote],{env:process.env,stdio:['ignore','pipe','pipe']});
  server.stderr.on('data',()=>{});
  const port=await new Promise((resolve,reject)=>{let data='';const timeout=setTimeout(()=>reject(new Error('FTP test server did not start')),15000);server.stdout.on('data',b=>{data+=b;const line=data.split('\n')[0];try{const p=JSON.parse(line);clearTimeout(timeout);resolve(p.port);}catch{}});server.once('error',reject);server.once('exit',code=>reject(new Error('FTP fixture exited '+code)));});
  const ftp=new Storage(path.join(root,'ftp-profile'));await ftp.init();await ftp.configure({...ftp.settings,type:'local_sync',data_file:'existing.json',ftp:{host:'127.0.0.1',port,user:'skycrm-test',password:'test-only',remote_path:'/'}});
  assert.ok((await ftp.ftpList()).some(f=>f.name==='existing.json'));await ftp.ftpTest(ftp.settings);
  await assert.rejects(()=>ftp.save(bundle,{sync:true,manual:true}),/먼저 FTP 파일 목록/);assert.equal(JSON.parse(await fs.readFile(path.join(remote,'existing.json'))).calls[0].content,legacy.calls[0].content);
  const fromFtp=await ftp.ftpOpen('existing.json');await ftp.activate(fromFtp.token);
  for(let i=0;i<5;i++){fromFtp.state.calls[0].content='FTP '+i;await ftp.save(fromFtp,{sync:true,manual:true});}
  for(let i=1;i<=3;i++)assert.equal(JSON.parse(await fs.readFile(path.join(remote,'existing.json.bak'+i))).calls[0].content,'FTP '+(4-i));
  const afterRestart=new Storage(ftp.folder);await afterRestart.init();const start=await afterRestart.startup();await afterRestart.activate(start.bundle.token);start.bundle.state.calls[0].content='재실행 동기화';await afterRestart.save(start.bundle,{sync:true,manual:true});assert.equal(JSON.parse(await fs.readFile(path.join(remote,'existing.json'))).calls[0].content,'재실행 동기화');
  await fs.writeFile(path.join(remote,'existing.json'),JSON.stringify(legacy));start.bundle.state.calls[0].content='덮어쓰면 안 됨';await assert.rejects(()=>afterRestart.save(start.bundle,{sync:true,manual:true}),/다른 PC에서 변경/);assert.equal(JSON.parse(await fs.readFile(path.join(remote,'existing.json'))).calls[0].content,legacy.calls[0].content);
  const backup=await ftp.ftpOpen('existing.json.bak1');assert.equal(backup.preview,true);assert.equal(backup.state.calls[0].content,'FTP 4');
  const ftpOnly=new Storage(path.join(root,'ftp-only'));await ftpOnly.init();await ftpOnly.configure({...ftp.settings,type:'ftp'});const ftpStart=await ftpOnly.startup();assert.equal(ftpStart.bundle.state.calls[0].content,legacy.calls[0].content);await ftpOnly.activate(ftpStart.bundle.token);await ftpOnly.save(ftpStart.bundle,{manual:true});
  server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
  const fallback=await ftpOnly.startup();assert.ok(fallback.bundle.warning.includes('PC 복구용 저장본'));assert.equal(fallback.bundle.state.calls[0].content,legacy.calls[0].content);await ftpOnly.activate(fallback.bundle.token);fallback.bundle.state.calls[0].content='FTP 오류에도 PC 보존';await assert.rejects(()=>ftpOnly.save(fallback.bundle,{sync:true,manual:true}));assert.equal(JSON.parse(await fs.readFile(ftpOnly.file())).calls[0].content,'FTP 오류에도 PC 보존');assert.equal(JSON.parse(await fs.readFile(path.join(remote,'existing.json'))).calls[0].content,legacy.calls[0].content);
  console.log('::notice::PASS FTP loopback: connection/list/import, protected first upload, upload/download, 3 remote backups, restart sync, backup selection, cross-PC conflict refusal, FTP-only startup, offline cache fallback and preservation after a failed upload');
 }finally{if(server){server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else{server.once('exit',resolve);setTimeout(resolve,5000);}});}await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
})().catch(error=>{console.error(error);console.error('::error::'+String(error.stack||error).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exitCode=1;});
