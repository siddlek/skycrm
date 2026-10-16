'use strict';
// Large files live in IndexedDB; memo JSON contains only stable asset IDs.
let assetDatabase = null, assetWork = Promise.resolve();
const assetURLs = new Map(), assetURLRequests = new Map();
const validAssetId = id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(id);
function openAssetDatabase() {
  if (!assetDatabase) assetDatabase = new Promise((resolve,reject) => {
    const request = indexedDB.open('skycrm-assets-v1',1);
    request.onupgradeneeded = () => request.result.createObjectStore('files',{keyPath:'id'});
    request.onsuccess = () => { const db=request.result;db.onversionchange=()=>db.close();resolve(db); };
    request.onerror = () => { assetDatabase=null;reject(new Error('브라우저 파일 저장소를 열 수 없습니다.')); };
    request.onblocked = () => { assetDatabase=null;reject(new Error('다른 Sky CRM 탭을 닫고 다시 시도해 주세요.')); };
  });
  return assetDatabase;
}
async function getAsset(id) {
  if (!validAssetId(id)) return null;
  const db=await openAssetDatabase();
  return new Promise((resolve,reject)=>{const request=db.transaction('files','readonly').objectStore('files').get(id);request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(new Error('저장된 파일을 읽지 못했습니다.'));});
}
async function writeAssets(records) {
  const db=await openAssetDatabase();
  return new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');for(const record of records)tx.objectStore('files').put(record);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(new Error('파일 저장에 실패했습니다. 브라우저 저장 공간을 확인해 주세요.'));});
}
function deltaAssetIds(delta) { return (delta?.ops||[]).map(op=>op.insert?.localImage?.id).filter(validAssetId); }
function pageAssetIds(page) { return [...new Set([...(page?.assetIds||[]),...(page?.attachments||[]).map(a=>a.id),...deltaAssetIds(page?.delta)])].filter(validAssetId); }
function stateAssetIds(data) { return (data?.memos||[]).flatMap(m=>(m.pages||[]).flatMap(pageAssetIds)); }
async function removeUnusedAssets(candidates) {
  if (!candidates.length) return;
  const referenced=new Set([...stateAssetIds(state),...history.flatMap(s=>deltaAssetIds(s.delta))]);
  // If saving failed, the last persisted memo may still reference the file.
  try { for(const id of stateAssetIds(JSON.parse(localStorage.getItem(KEY))))referenced.add(id); } catch { return; }
  const ids=[...new Set(candidates)].filter(id=>validAssetId(id)&&!referenced.has(id));if(!ids.length)return;
  const db=await openAssetDatabase();
  await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');for(const id of ids)tx.objectStore('files').delete(id);tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(new Error('파일 정리에 실패했습니다.'));});
  for(const id of ids){if(assetURLs.has(id))URL.revokeObjectURL(assetURLs.get(id));assetURLs.delete(id);assetURLRequests.delete(id);}
}
async function assetImageURL(id) {
  if(assetURLs.has(id))return assetURLs.get(id);
  if(!assetURLRequests.has(id))assetURLRequests.set(id,(async()=>{const record=await getAsset(id);if(!record||record.kind!=='image'||!record.blob)throw new Error('저장된 이미지를 찾지 못했습니다.');const url=URL.createObjectURL(record.blob);assetURLs.set(id,url);return url;})().catch(error=>{assetURLRequests.delete(id);throw error;}));
  return assetURLRequests.get(id);
}
addEventListener('pagehide',event=>{if(event.persisted)return;for(const url of assetURLs.values())URL.revokeObjectURL(url);assetURLs.clear();assetURLRequests.clear();});
function attachmentControls() {
  return '<div class="asset-tools"><button type="button" id="add-attachment">파일 첨부</button><span>이미지는 붙여넣거나 본문에 끌어 넣으세요.</span><input type="file" id="attachment-input" multiple hidden></div>';
}
function captureAssetTarget() {
  const item=activeMemo(),page=activePage(item);if(!item||!page||!richEditor)return null;
  const range=richEditor.getSelection()||richSelection||{index:richEditor.getLength()-1,length:0};
  return {memoId:item.id,pageId:page.id,editor:richEditor,index:range.index+range.length};
}
function locateAssetTarget(target) {const item=memoById(target.memoId),page=item?.pages.find(p=>p.id===target.pageId);return item&&page?{item,page}:null;}
function assetTask(action) {
  const run=assetWork.then(action);assetWork=run.catch(()=>{});
  return run.catch(error=>{$('#status').textContent=error.message||'파일을 추가하지 못했습니다.';});
}
function initPageAssets() {
  const choose=(buttonId,inputId,images)=>{
    const button=$('#'+buttonId),input=$('#'+inputId);let target=null;
    button.onmousedown=e=>e.preventDefault();button.onclick=()=>{target=captureAssetTarget();if(target)input.click();};
    input.onchange=()=>{const files=[...input.files];input.value='';const destination=target||captureAssetTarget();if(files.length&&destination)assetTask(()=>addPageFiles(files,destination,images));};
  };
  choose('add-attachment','attachment-input',false);renderAttachments();
  richEditor.root.addEventListener('paste',e=>{
    const files=[...(e.clipboardData?.files||[])];if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
    const target=captureAssetTarget();assetTask(()=>addPageFiles(files,target,files.every(file=>file.type.startsWith('image/'))));
  },true);
  richEditor.root.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
  richEditor.root.addEventListener('drop',e=>{
    const files=[...(e.dataTransfer?.files||[])];if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
    // Place a dropped image at the text point under the pointer when available.
    const domRange=document.caretRangeFromPoint?.(e.clientX,e.clientY);
    if(domRange&&richEditor.root.contains(domRange.startContainer)){
      const blot=Quill.find(domRange.startContainer,true);
      if(blot&&typeof blot.length==='function')richEditor.setSelection(Math.min(richEditor.getLength()-1,richEditor.getIndex(blot)+Math.min(domRange.startOffset,blot.length())),0,'silent');
    }
    const target=captureAssetTarget();assetTask(()=>addPageFiles(files,target,files.every(file=>file.type.startsWith('image/'))));
  },true);
}
function fileSize(size) {return size<1024?size+' B':size<1024*1024?(size/1024).toFixed(1)+' KB':(size/1024/1024).toFixed(1)+' MB';}
function renderAttachments() {
  const container=$('#page-attachments'),page=activePage(activeMemo());if(!container||!page)return;
  const files=page.attachments||[];
  container.innerHTML=files.length?`<h3>첨부파일 (${files.length})</h3><ul>${files.map(a=>`<li><button class="attachment-name" data-download-asset="${esc(a.id)}" title="${esc(a.name)} 다운로드">${esc(a.name)}</button><span>${fileSize(a.size)}</span><button data-remove-asset="${esc(a.id)}" aria-label="${esc(a.name)} 첨부 삭제">×</button></li>`).join('')}</ul>`:'';
  container.onclick=e=>{const download=e.target.closest('[data-download-asset]'),remove=e.target.closest('[data-remove-asset]');if(download)downloadAttachment(download.dataset.downloadAsset);if(remove)removeAttachment(remove.dataset.removeAsset);};
}
async function downloadAttachment(id) {
  try {const record=await getAsset(id);if(!record?.blob)throw new Error('이 브라우저에서 첨부파일을 찾지 못했습니다.');const url=URL.createObjectURL(record.blob),link=document.createElement('a');link.href=url;link.download=record.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  catch(error){$('#status').textContent=error.message;}
}
function removeAttachment(id) {
  const page=activePage(activeMemo());if(!page||!confirm('이 첨부파일을 삭제할까요?'))return;
  const previous=page.attachments;page.attachments=(page.attachments||[]).filter(a=>a.id!==id);
  if(!persist())page.attachments=previous;
  else removeUnusedAssets([id]).catch(()=>{});
  renderAttachments();
}
async function validatePageFile(file,image) {
  if(file.size>(image?20:50)*1024*1024)throw new Error(image?'본문 이미지는 한 장당 20MB까지 넣을 수 있습니다.':'첨부파일은 한 개당 50MB까지 넣을 수 있습니다.');
  if(image){
    if(!['image/png','image/jpeg','image/gif','image/webp','image/bmp','image/avif'].includes(file.type))throw new Error('본문에는 PNG·JPG·GIF·WebP·BMP·AVIF 이미지를 넣을 수 있습니다. 다른 형식은 파일 첨부를 이용하세요.');
    const url=URL.createObjectURL(file);try{const img=new Image();img.src=url;await img.decode();if(!img.naturalWidth||img.naturalWidth>16000||img.naturalHeight>16000)throw new Error();}catch{throw new Error('이미지를 읽지 못했습니다. 지원되는 이미지 파일인지 확인해 주세요.');}finally{URL.revokeObjectURL(url);}
  }
}
async function addPageFiles(files,target,images) {
  if(!target||!locateAssetTarget(target))throw new Error('파일을 넣을 페이지를 먼저 선택해 주세요.');
  for(const file of files)await validatePageFile(file,images);
  const records=files.map(file=>({id:uid(),name:file.name,type:file.type,size:file.size,createdAt:memoNow(),kind:images?'image':'file',blob:file}));
  await writeAssets(records);
  try {
    const destination=locateAssetTarget(target);if(!destination)throw new Error('페이지가 삭제되어 파일 추가를 취소했습니다.');
    const {item,page}=destination,previous={delta:page.delta,content:page.content,assetIds:page.assetIds,attachments:page.attachments,updatedAt:item.updatedAt};
    const live=tab==='memos'&&memoId===item.id&&item.activePageId===page.id&&richEditor===target.editor;
    const previousDocument=live?readRichDelta():richDocument(page),oldHistory=history.slice(),oldHistoryIndex=historyIndex;
    let saved=false;
    if(images){
      const index=Math.max(0,Math.min(target.index,new RichDelta(previousDocument).length()-1)),change=new RichDelta().retain(index);
      for(const record of records)change.insert({localImage:{id:record.id,name:record.name}});
      const document=new RichDelta(previousDocument).compose(change);
      page.assetIds=[...new Set([...(page.assetIds||[]),...records.map(r=>r.id)])];
      if(live){richEditor.updateContents(change,'silent');richEditor.setSelection(index+records.length,0,'silent');richSelection={index:index+records.length,length:0};saved=updateMemo();}
      else {page.delta=document;page.content=deltaPlainText(document);item.updatedAt=memoNow();saved=persist();}
    }else{page.attachments=[...(page.attachments||[]),...records.map(({blob,kind,...metadata})=>metadata)];item.updatedAt=memoNow();saved=persist();}
    if(!saved){
      Object.assign(page,{delta:previous.delta,content:previous.content,assetIds:previous.assetIds,attachments:previous.attachments});item.updatedAt=previous.updatedAt;
      if(live&&images){loadRichDocument(previousDocument);history=oldHistory;historyIndex=oldHistoryIndex;updateCount();updateHistoryButtons();}
      throw new Error('메모를 저장하지 못해 파일 추가를 취소했습니다. 브라우저 저장 공간을 확인해 주세요.');
    }
    if(tab==='memos'&&$('#memo-lists'))renderMemoLists();if(live){renderAttachments();if(images)richEditor.scrollSelectionIntoView();}
    $('#status').textContent=images?`${records.length}개 이미지를 본문에 저장했습니다.`:`${records.length}개 파일을 첨부했습니다.`;
  }catch(error){await removeUnusedAssets(records.map(r=>r.id)).catch(()=>{});throw error;}
}
