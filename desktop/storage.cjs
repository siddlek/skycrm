'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const {Client}=require('basic-ftp');
const format=require('./data-format.cjs');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const exists=async p=>{try{await fs.access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const read=async p=>{try{return await fs.readFile(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function atomicWrite(file,bytes){
 await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp-'+crypto.randomUUID();
 try{const handle=await fs.open(tmp,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
function config(input,defaultFolder){
 const type=['local','ftp','local_sync'].includes(input?.type)?input.type:'local';
 const data_file=String(input?.data_file||'call_data.json');
 if(/[\r\n\\/]/.test(data_file)||data_file==='.'||data_file==='..')throw new Error('데이터 파일명에는 폴더 경로나 줄바꿈을 넣을 수 없습니다.');
 const f=input?.ftp||{},port=Number(f.port||21),host=String(f.host||'').trim(),remote_path=String(f.remote_path||'/').replaceAll('\\','/');
 if(!Number.isInteger(port)||port<1||port>65535||/[\r\n]/.test(host+remote_path+String(f.user||'')))throw new Error('FTP 주소·포트·경로를 확인하세요.');
 if(type!=='local'&&!host)throw new Error('FTP 주소를 입력하세요.');
 return {type,local_path:path.resolve(input?.local_path||defaultFolder),data_file,autosave_minutes:Math.max(1,Math.min(240,Number(input?.autosave_minutes)||5)),ftp:{host,port,user:String(f.user||''),password:String(f.password||''),remote_path,secure:f.secure===true}};
}
class Storage {
 constructor(folder,options={}){this.folder=folder;this.settingsFile=path.join(folder,'desktop-storage.json');this.secrets=options.secrets;this.expected=new Map();this.raw={};this.sequence=Promise.resolve();this.pending=new Map();this.remoteExpected=new Map();this.preview=false;this.unsynced=false;}
 serial(fn){const next=this.sequence.then(fn);this.sequence=next.catch(()=>{});return next;}
 async init(){
  const saved=await read(this.settingsFile);let settings={};
  if(saved){settings=JSON.parse(saved);if(settings.ftp?.encryptedPassword){if(!this.secrets)throw new Error('FTP 비밀번호를 이 PC에서 복호화할 수 없습니다.');settings.ftp.password=this.secrets.decrypt(settings.ftp.encryptedPassword);delete settings.ftp.encryptedPassword;}}
  this.settings=config(settings,this.folder);const versions=await read(path.join(this.folder,'ftp-versions.json'));if(versions)this.remoteExpected=new Map(Object.entries(JSON.parse(versions)));return this.settings;
 }
 async writeSettings(value){
  const disk=JSON.parse(JSON.stringify(value));
  if(disk.ftp.password&&this.secrets){disk.ftp.encryptedPassword=this.secrets.encrypt(disk.ftp.password);delete disk.ftp.password;}
  await atomicWrite(this.settingsFile,JSON.stringify(disk,null,2));this.settings=value;
 }
 file(settings=this.settings){return path.join(settings.type==='ftp'?this.folder:settings.local_path,settings.type==='ftp'?'ftp-cache-'+crypto.createHash('sha256').update(this.remoteKey(settings)).digest('hex').slice(0,16)+'.json':settings.data_file);}
 remoteKey(settings=this.settings){const f=settings.ftp;return [f.host,f.port,f.user,f.remote_path,settings.data_file].join('|');}
 async candidate(file,settings=this.settings,source=file){
  const bytes=await read(file);if(!bytes)throw new Error('데이터 파일이 없습니다.');const bundle=format.decode(bytes.toString('utf8'));
  const target=this.file(settings),current=await read(target),token=crypto.randomUUID();
  this.pending.clear();this.pending.set(token,{settings,raw:bundle.raw,target,expected:current?digest(current):null,preview:source!==target});
  return {token,state:bundle.state,assets:bundle.assets,source,preview:source!==target};
 }
 async startup(){
  let ftpError;
  if(this.settings.type==='ftp')try{return {bundle:await this.ftpOpen(this.settings.data_file),settings:this.settings};}catch(error){ftpError=error;}
  const target=this.file();const bytes=await read(target);this.expected.set(target,bytes?digest(bytes):null);
  if(!bytes){
   for(let i=1;i<=3;i++)try{const bundle=await this.candidate(target+'.bak'+i,this.settings,target+'.bak'+i);bundle.recovered=true;return {bundle,settings:this.settings};}catch{}
   if(ftpError)throw new Error('FTP 데이터를 불러오지 못했으며 PC 복구용 저장본도 없습니다. 기존 서버 파일은 변경하지 않았습니다. '+ftpError.message);
   return {bundle:null,settings:this.settings};
  }
  let bundle;
  try{bundle=await this.candidate(target);}catch(original){
   for(let i=1;i<=3;i++)try{bundle=await this.candidate(target+'.bak'+i,this.settings,target+'.bak'+i);bundle.recovered=true;break;}catch{}
   if(!bundle)throw new Error('현재 데이터 파일과 백업을 읽지 못했습니다. 파일을 덮어쓰지 않습니다. 파일 메뉴에서 다른 데이터 파일을 열어 주세요. '+original.message);
  }
  if(ftpError)bundle.warning='FTP 불러오기 실패 · PC 복구용 저장본을 열었습니다: '+ftpError.message;
  return {bundle,settings:this.settings};
 }
 async activate(token){
  const value=this.pending.get(token);if(!value)throw new Error('불러오기 요청이 만료되었습니다. 다시 파일을 선택하세요.');
  if(value.remote){this.remoteExpected.set(value.remote.key,value.remote.hash);await this.saveRemoteVersions();}
  await this.writeSettings(value.settings);
  this.raw=value.raw;this.expected.set(value.target,value.expected);this.preview=value.preview;this.pending.delete(token);return this.status();
 }
 status(){return {settings:this.settings,path:this.file(),preview:this.preview,unsynced:this.unsynced};}
 async openLocal(file){const backup=/\.bak[123]$/i.test(file),target=backup?file.replace(/\.bak[123]$/i,''):file;const settings=config({...this.settings,type:'local',local_path:path.dirname(target),data_file:path.basename(target)},this.folder);return this.candidate(file,settings,file);}
 async save(bundle,{sync=false,manual=false}={}){
  if(this.preview&&!manual)return {...this.status(),preview:true};
  const data=format.encode(bundle,this.raw),bytes=Buffer.from(JSON.stringify(data,null,2),'utf8'),target=this.file(),old=await read(target);
  if(this.expected.has(target)&&this.expected.get(target)!==(old?digest(old):null))throw new Error('현재 데이터 파일이 앱 밖에서 변경되었습니다. 덮어쓰지 않았습니다. 다른 이름으로 저장하거나 다시 열어 주세요.');
  if(!old||digest(old)!==digest(bytes)){
   if(old){let valid=true;try{format.decode(old.toString('utf8'));}catch{valid=false;}
    if(valid){for(let i=3;i>=2;i--){const prior=await read(target+'.bak'+(i-1));if(prior)await atomicWrite(target+'.bak'+i,prior);}await atomicWrite(target+'.bak1',old);}
    else await atomicWrite(target+'.corrupt-'+Date.now(),old);
   }
   await atomicWrite(target,bytes);this.expected.set(target,digest(bytes));if(this.settings.type!=='local')this.unsynced=true;
  }
  this.raw=data;this.preview=false;
  if(sync&&this.settings.type!=='local')await this.upload(bytes);
  return this.status();
 }
 async saveAs(file,bundle){
  const settings=config({...this.settings,type:'local',local_path:path.dirname(file),data_file:path.basename(file)},this.folder);
  const data=format.encode(bundle,this.raw),bytes=Buffer.from(JSON.stringify(data,null,2)),old=await read(file);
  if(old){for(let i=3;i>=2;i--){const prior=await read(file+'.bak'+(i-1));if(prior)await atomicWrite(file+'.bak'+i,prior);}await atomicWrite(file+'.bak1',old);}
  await atomicWrite(file,bytes);await this.writeSettings(settings);this.raw=data;this.expected.set(file,digest(bytes));this.preview=false;this.unsynced=false;return this.status();
 }
 async backups(){const file=this.file(),items=[];for(let i=0;i<=3;i++){const p=file+(i?'.bak'+i:'');try{const stat=await fs.stat(p);items.push({slot:i,name:path.basename(p),modified:stat.mtime.toISOString(),size:stat.size});}catch(e){if(e.code!=='ENOENT')throw e;}}return items;}
 async restore(slot){if(!Number.isInteger(slot)||slot<0||slot>3)throw new Error('올바른 백업을 선택하세요.');return this.candidate(this.file()+(slot?'.bak'+slot:''),this.settings,this.file()+(slot?'.bak'+slot:''));}
 async configure(value){const next=config(value,this.folder),target=this.file(next),bytes=await read(target);await this.writeSettings(next);this.expected.set(target,bytes?digest(bytes):null);return this.status();}
 async ftp(fn,settings=this.settings){const client=new Client(15000);try{await client.access({...settings.ftp,secure:settings.ftp.secure});await client.cd(settings.ftp.remote_path||'/');return await fn(client);}finally{client.close();}}
 async download(client,name){
  const chunks=[];let size=0;const stream=new Writable({write(chunk,_enc,done){size+=chunk.length;if(size>512*1024*1024)return done(new Error('FTP 데이터 파일이 512MB를 넘습니다.'));chunks.push(chunk);done();}});
  try{await client.downloadTo(stream,name);return Buffer.concat(chunks);}catch(e){if(e.code===550)return null;throw e;}
 }
 async ftpList(){return this.ftp(async c=>(await c.list()).filter(f=>f.isFile&&/\.json(?:\.bak[123])?$/i.test(f.name)).map(f=>({name:f.name,size:f.size,modified:f.modifiedAt?.toISOString()||''})));}
 async ftpTest(value){const next=config({...value,type:'ftp'},this.folder);await this.ftp(async c=>{await c.list();},next);return true;}
 async ftpOpen(name){
  if(typeof name!=='string'||/[\r\n\\/]/.test(name))throw new Error('올바른 FTP 파일을 선택하세요.');
  const settings=config({...this.settings,data_file:name.replace(/\.bak[123]$/i,'')},this.folder);
  const result=await this.ftp(async c=>{const bytes=await this.download(c,name);if(!bytes)throw new Error('FTP 파일이 없습니다.');return {bytes,current:name===settings.data_file?bytes:await this.download(c,settings.data_file)};},settings);
  const bundle=format.decode(result.bytes.toString('utf8')),target=this.file(settings),local=await read(target),token=crypto.randomUUID();
  this.pending.clear();this.pending.set(token,{settings,raw:bundle.raw,target,expected:local?digest(local):null,preview:name!==settings.data_file,remote:{key:this.remoteKey(settings),hash:result.current?digest(result.current):null}});
  return {token,state:bundle.state,assets:bundle.assets,source:'FTP: '+name,preview:name!==settings.data_file};
 }
 async saveRemoteVersions(){await atomicWrite(path.join(this.folder,'ftp-versions.json'),JSON.stringify(Object.fromEntries(this.remoteExpected)));}
 async upload(bytes){
  const name=this.settings.data_file,key=this.remoteKey();
  await this.ftp(async c=>{
   const old=await this.download(c,name),fingerprint=old?digest(old):null;
   if(old&&fingerprint===digest(bytes)){this.remoteExpected.set(key,fingerprint);this.unsynced=false;await this.saveRemoteVersions();return;}
   if(this.remoteExpected.has(key)&&this.remoteExpected.get(key)!==fingerprint)throw new Error('FTP 파일이 다른 PC에서 변경되었습니다. 업로드하지 않았습니다. 먼저 FTP에서 다시 불러오거나 다른 파일명을 지정하세요.');
   // A server file must first be opened, or explicitly approved, before overwriting it.
   if(old&&!this.remoteExpected.has(key))throw new Error('FTP에 같은 이름의 파일이 있습니다. 먼저 FTP 파일 목록에서 불러오거나 다른 데이터 파일명을 지정하세요.');
   const temp=name+'.upload-'+crypto.randomUUID(),safety=name+'.previous-'+crypto.randomUUID();let moved=false;
   try{
    await c.uploadFrom(Readable.from(bytes),temp);
    if(old){
     format.decode(old.toString('utf8'));
     for(let i=3;i>=2;i--){const prior=await this.download(c,name+'.bak'+(i-1));if(prior)await c.uploadFrom(Readable.from(prior),name+'.bak'+i);}
     await c.uploadFrom(Readable.from(old),name+'.bak1');await c.rename(name,safety);moved=true;
    }
    try{await c.rename(temp,name);}catch(e){if(moved)await c.rename(safety,name);throw e;}
    if(moved)await c.remove(safety).catch(()=>{});this.remoteExpected.set(key,digest(bytes));this.unsynced=false;await this.saveRemoteVersions();
   }finally{await c.remove(temp).catch(()=>{});}
  });
 }
}
module.exports={Storage,config,atomicWrite};
