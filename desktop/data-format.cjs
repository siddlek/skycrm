'use strict';
const {randomUUID}=require('node:crypto');
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>JSON.parse(JSON.stringify(x));
const error=message=>{throw new Error(message);};
function validateState(state){
 if(!object(state)||!['clients','calls','memos'].every(key=>Array.isArray(state[key])))error('Sky CRM 데이터 형식이 올바르지 않습니다.');
 for(const key of ['clients','calls','memos'])if(state[key].some(row=>!object(row)))error('손상된 데이터 항목이 있습니다.');
 if(state.clients.some(c=>typeof c.name!=='string'))error('거래처 이름이 올바르지 않습니다.');
 if(new Set(state.clients.map(c=>c.name)).size!==state.clients.length)error('중복된 거래처 이름이 있습니다. 원본 파일을 확인하세요.');
 return state;
}
function assetReferences(state){return new Set(state.memos.flatMap(m=>(m.pages||[]).flatMap(p=>[...(p.assetIds||[]),...(p.attachments||[]).map(a=>a.id),...(p.delta?.ops||[]).map(op=>op.insert?.localImage?.id).filter(Boolean)])));}
function validateAssets(state,assets){
 if(!Array.isArray(assets))error('첨부파일 백업 형식이 올바르지 않습니다.');
 const ids=new Set();
 for(const a of assets){
  if(!object(a)||!(/^[\w.-]{1,120}$/).test(a.id)||ids.has(a.id)||typeof a.data!=='string'||a.data.length>72*1024*1024||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(a.data))error('첨부파일 백업이 손상되었습니다.');
  if(Buffer.from(a.data,'base64').length!==a.size)error('첨부파일 크기가 백업 정보와 다릅니다.');ids.add(a.id);
 }
 for(const id of assetReferences(state))if(!ids.has(id))error('본문 이미지 또는 첨부파일 원본이 백업에 없습니다. 원본 파일을 확인하세요.');
}
function decode(data){
 if(typeof data==='string')data=JSON.parse(data.replace(/^\uFEFF/,''));
 if(!object(data)||!Array.isArray(data.calls)||(!Array.isArray(data.clients)&&!object(data.clients)))error('통화 기록과 거래처 DB가 있는 JSON 데이터 파일을 선택하세요.');
 if(data.memo_tasks_v1!==undefined&&!Array.isArray(data.memo_tasks_v1))error('기존 메모/할 일 데이터 형식이 올바르지 않습니다.');
 const modern=data._skycrm;
 if(modern&&modern.version!==1)error('지원하지 않는 백업 버전입니다. 최신 앱으로 열어 주세요.');
 const base=modern?validateState(clone(modern.state)):{calls:[],clients:[],memos:[],folders:[],ui:{}};
 const oldClients=base.clients;
 base.clients=Array.isArray(data.clients)?clone(data.clients):Object.entries(data.clients).map(([name,v])=>{
  if(!Array.isArray(v))error('거래처 전화번호/메모 형식이 올바르지 않습니다.');
  return {id:oldClients.find(c=>c.name===name)?.id||randomUUID(),name,phone:String(v[0]??''),phone2:String(v[1]??''),phone3:String(v[2]??''),content:String(v[3]??'')};
 });
 base.calls=clone(data.calls).map(c=>{if(!object(c))error('통화 기록 형식이 올바르지 않습니다.');return {...c,id:c.id||randomUUID(),date:String(c.date||'').replace(' ','T')};});
 if(!modern)base.memos=clone(Array.isArray(data.memo_tasks_v1)?data.memo_tasks_v1:Array.isArray(data.memos)?data.memos:[]).map(m=>({...m,id:m.id||randomUUID(),kind:m.kind==='note'?'note':'task',name:String(m.name||''),content:String(m.text??m.content??''),collapsed:m.expanded===false,sourceCallId:m.source_call_id||m.sourceCallId||'',createdAt:m.date||m.createdAt,updatedAt:m.updatedAt||m.date}));
 const assets=modern?.assets||[];validateState(base);validateAssets(base,assets);
 return {state:base,assets:clone(assets),raw:clone(data)};
}
function encode(bundle,previous={}){
 const state=clone(validateState(bundle.state));validateAssets(state,bundle.assets);
 const clients=Object.create(null);
 for(const c of state.clients){const tail=Array.isArray(previous.clients?.[c.name])?previous.clients[c.name].slice(4):[];clients[c.name]=[c.phone||'',c.phone2||'',c.phone3||'',c.content||'',...tail];}
 return {...previous,clients,calls:state.calls.map(c=>({...c,date:String(c.date||'').replace('T',' ')})),memo_tasks_v1:state.memos.map(m=>({...m,text:m.pages?.[0]?.content??m.content??'',expanded:!m.collapsed,source_call_id:m.sourceCallId||''})),_skycrm:{version:1,state,assets:clone(bundle.assets)}};
}
module.exports={decode,encode,validateState,assetReferences};
