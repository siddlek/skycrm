'use strict';
// Image controls live outside Quill's document so they are never saved as content.
let selectedMemoImage=null, imageFrame=null, imageTools=null, imageFrameRequest=0, imageGesture=null, imageInteractionsCleanup=null;
function clearImageSelection() {
  const gesture=imageGesture;imageGesture=null;gesture?.cancel();
  selectedMemoImage?.classList.remove('memo-image-selected','memo-image-dragging','memo-image-resizing');
  selectedMemoImage?.style.removeProperty('--image-preview-width');
  selectedMemoImage=null;imageFrame?.remove();imageTools?.remove();imageFrame=null;imageTools=null;
  cancelAnimationFrame(imageFrameRequest);imageFrameRequest=0;clearImageDragFeedback();
}
function destroyImageInteractions() {clearImageSelection();imageInteractionsCleanup?.();imageInteractionsCleanup=null;}
function imageIndex(node,editor=richEditor) {
  const blot=node&&Quill.find(node);return blot&&editor?.root.contains(node)?editor.getIndex(blot):null;
}
function selectMemoImage(node,editor=richEditor) {
  if(!node||!editor||editor!==richEditor||!editor.root.contains(node))return;
  selectedMemoImage?.classList.remove('memo-image-selected');selectedMemoImage=node;node.classList.add('memo-image-selected');
  const index=imageIndex(node,editor);richSelection={index,length:1};
  if(!imageFrame){
    imageFrame=document.createElement('div');imageFrame.id='memo-image-frame';imageFrame.setAttribute('aria-label','이미지 크기 조절');
    for(const corner of ['nw','ne','sw','se']){const handle=document.createElement('button');handle.type='button';handle.dataset.imageHandle=corner;handle.className='image-resize-handle '+corner;handle.setAttribute('aria-label','이미지 '+({nw:'왼쪽 위',ne:'오른쪽 위',sw:'왼쪽 아래',se:'오른쪽 아래'}[corner])+' 크기 조절');handle.onpointerdown=e=>beginImageResize(e,corner);imageFrame.append(handle);}
    document.body.append(imageFrame);
    imageTools=document.createElement('div');imageTools.id='memo-image-tools';imageTools.innerHTML='<label>너비 <input id="memo-image-width" type="number" min="24" max="2400" aria-label="이미지 너비"> px</label><button type="button" data-image-action="original">원본 크기</button><button type="button" data-image-action="delete">삭제</button><button type="button" data-image-action="close" aria-label="이미지 선택 해제">×</button><small>이미지를 끌어 이동 · 모서리를 끌어 크기 조절</small>';
    document.body.append(imageTools);
    imageTools.querySelectorAll('button').forEach(button=>{button.onpointerdown=e=>e.preventDefault();button.onclick=()=>{if(button.dataset.imageAction==='original')commitImageWidth(null);if(button.dataset.imageAction==='delete')deleteSelectedImage();if(button.dataset.imageAction==='close')clearImageSelection();};});
    $('#memo-image-width').onchange=e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=24&&value<=2400)commitImageWidth(value);};
    $('#memo-image-width').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.target.blur();}else if(e.key==='Escape')clearImageSelection();};
  }
  refreshImageSelection();
  if(!imageFrameRequest)imageFrameRequest=requestAnimationFrame(trackImageSelection);
}
function trackImageSelection(){imageFrameRequest=0;if(!selectedMemoImage)return;refreshImageSelection();if(selectedMemoImage)imageFrameRequest=requestAnimationFrame(trackImageSelection);}
function refreshImageSelection() {
  const node=selectedMemoImage;if(!node?.isConnected||!richEditor?.root.contains(node)){clearImageSelection();return;}
  const rect=node.getBoundingClientRect(),root=richEditor.root.getBoundingClientRect();
  const top=Math.max(0,root.top-rect.top,-rect.top),left=Math.max(0,root.left-rect.left,-rect.left),right=Math.max(0,rect.right-root.right,rect.right-innerWidth),bottom=Math.max(0,rect.bottom-root.bottom,rect.bottom-innerHeight);
  const visible=rect.width>0&&rect.height>0&&top+bottom<rect.height&&left+right<rect.width;
  imageFrame.hidden=!visible;imageTools.hidden=!visible;if(!visible)return;
  Object.assign(imageFrame.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',clipPath:`inset(${top}px ${right}px ${bottom}px ${left}px)`});
  // Keep controls in the viewport even when the editor is narrow or scrolled.
  const toolWidth=Math.min(380,innerWidth-16);imageTools.style.width=toolWidth+'px';
  const toolHeight=imageTools.getBoundingClientRect().height;
  imageTools.style.left=Math.max(8,Math.min(innerWidth-toolWidth-8,rect.left))+'px';
  imageTools.style.top=Math.max(8,Math.min(innerHeight-toolHeight-8,rect.top>=toolHeight+8?rect.top-toolHeight-7:rect.bottom+7))+'px';
  const input=$('#memo-image-width');if(input&&document.activeElement!==input)input.value=Math.round(rect.width);
}
function imageNodeAtIndex(editor,index) {return [...editor.root.querySelectorAll('.skycrm-local-image')].find(node=>imageIndex(node,editor)===index);}
function commitImageWidth(width) {
  const editor=richEditor,node=selectedMemoImage,index=imageIndex(node,editor);if(index===null)return;
  const op=editor.getContents(index,1).ops[0];if(!op?.insert?.localImage)return;
  const value={...op.insert.localImage};if(width===null)delete value.width;else value.width=Math.round(Math.max(24,Math.min(2400,width)));
  editor.updateContents(new RichDelta().retain(index).delete(1).insert({localImage:value},op.attributes),'user');
  const replacement=imageNodeAtIndex(editor,index);if(replacement)selectMemoImage(replacement,editor);
}
function deleteSelectedImage() {
  const editor=richEditor,index=imageIndex(selectedMemoImage,editor);if(index===null)return;
  clearImageSelection();editor.deleteText(index,1,'user');editor.setSelection(index,0,'silent');richSelection={index,length:0};
}
function beginImageResize(event,corner) {
  if(event.button!==0||!selectedMemoImage?.naturalWidth)return;event.preventDefault();event.stopPropagation();
  const node=selectedMemoImage,editor=richEditor,start=node.getBoundingClientRect(),ratio=node.naturalWidth/node.naturalHeight,startX=event.clientX,startY=event.clientY,handle=event.currentTarget;
  let width=start.width;handle.setPointerCapture(event.pointerId);node.classList.add('memo-image-resizing');document.body.classList.add('resizing-memo-image');
  const restore=()=>{node.classList.remove('memo-image-resizing');node.style.removeProperty('--image-preview-width');handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;document.body.classList.remove('resizing-memo-image');try{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);}catch{}};
  imageGesture={cancel:restore};
  handle.onpointermove=e=>{const dx=(e.clientX-startX)*(corner.includes('e')?1:-1),dy=(e.clientY-startY)*(corner.includes('s')?1:-1)*ratio,delta=Math.abs(dx)>=Math.abs(dy)?dx:dy;const max=Math.max(24,editor.root.clientWidth-24);width=Math.max(24,Math.min(max,start.width+delta));node.style.setProperty('--image-preview-width',width+'px');refreshImageSelection();};
  handle.onpointerup=()=>{imageGesture=null;restore();if(editor===richEditor&&node.isConnected&&Math.abs(width-start.width)>=1)commitImageWidth(width);};
  handle.onpointercancel=()=>{imageGesture=null;restore();refreshImageSelection();};
}
function imageDropIndex(editor,x,y) {
  const bounds=editor.root.getBoundingClientRect();if(x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom)return null;
  let node,offset;
  if(document.caretPositionFromPoint){const p=document.caretPositionFromPoint(x,y);node=p?.offsetNode;offset=p?.offset;}
  else{const range=document.caretRangeFromPoint?.(x,y);node=range?.startContainer;offset=range?.startOffset;}
  if(!node||!editor.root.contains(node))return null;
  const blot=Quill.find(node,true);if(!blot)return null;
  let index;
  if(node.nodeType===Node.TEXT_NODE)index=editor.getIndex(blot)+Math.min(offset,blot.length());
  else if(node.matches?.('.skycrm-local-image')){const r=node.getBoundingClientRect();index=editor.getIndex(blot)+(x>r.left+r.width/2?1:0);}
  else if(node.childNodes[offset]){const child=Quill.find(node.childNodes[offset],true);index=child?editor.getIndex(child):editor.getIndex(blot);}
  else index=editor.getIndex(blot)+Math.max(0,blot.length()-(blot.statics?.blotName==='block'?1:0));
  return Math.max(0,Math.min(editor.getLength()-1,index));
}
function moveMemoImage(node,target,editor=richEditor) {
  const from=imageIndex(node,editor);if(from===null||target===null||editor!==richEditor)return;
  target=Math.max(0,Math.min(editor.getLength()-1,target));if(target===from||target===from+1)return;
  const op=editor.getContents(from,1).ops[0];if(!op?.insert?.localImage)return;
  const change=new RichDelta();let next;
  if(target>from){change.retain(from).delete(1).retain(target-from-1).insert(op.insert,op.attributes);next=target-1;}
  else{change.retain(target).insert(op.insert,op.attributes).retain(from-target).delete(1);next=target;}
  editor.updateContents(change,'user');editor.setSelection(next,1,'silent');richSelection={index:next,length:1};
  const replacement=imageNodeAtIndex(editor,next);if(replacement)selectMemoImage(replacement,editor);
}
function clearImageDragFeedback(){document.querySelector('#memo-image-drop-caret')?.remove();document.querySelector('#memo-image-ghost')?.remove();document.body.classList.remove('moving-memo-image');}
function showImageDropCaret(editor,index) {
  let caret=$('#memo-image-drop-caret');if(index===null){if(caret)caret.hidden=true;return;}
  if(!caret){caret=document.createElement('div');caret.id='memo-image-drop-caret';document.body.append(caret);}
  const bounds=editor.getBounds(index,0),container=editor.container.getBoundingClientRect();caret.hidden=false;
  Object.assign(caret.style,{left:container.left+bounds.left+'px',top:container.top+bounds.top+'px',height:Math.max(18,bounds.height)+'px'});
}
function beginImageMove(event,node,editor) {
  if(event.button!==0)return;event.preventDefault();event.stopPropagation();selectMemoImage(node,editor);
  const root=editor.root,startX=event.clientX,startY=event.clientY,index=imageIndex(node,editor);editor.setSelection(index,1,'silent');richSelection={index,length:1};
  root.setPointerCapture(event.pointerId);let moved=false,target=null;
  const restore=()=>{root.removeEventListener('pointermove',onMove);root.removeEventListener('pointerup',onUp);root.removeEventListener('pointercancel',onCancel);node.classList.remove('memo-image-dragging');clearImageDragFeedback();if(imageTools)imageTools.style.visibility='';if(imageFrame)imageFrame.style.visibility='';try{if(root.hasPointerCapture(event.pointerId))root.releasePointerCapture(event.pointerId);}catch{}};
  const onMove=e=>{
    if(!moved&&Math.hypot(e.clientX-startX,e.clientY-startY)<5)return;moved=true;if(imageTools)imageTools.style.visibility='hidden';if(imageFrame)imageFrame.style.visibility='hidden';node.classList.add('memo-image-dragging');document.body.classList.add('moving-memo-image');
    let ghost=$('#memo-image-ghost');if(!ghost){ghost=node.cloneNode();ghost.id='memo-image-ghost';ghost.className='memo-image-ghost';ghost.removeAttribute('style');document.body.append(ghost);}ghost.style.left=e.clientX+12+'px';ghost.style.top=e.clientY+12+'px';
    const bounds=root.getBoundingClientRect();if(e.clientY<bounds.top+22)root.scrollTop-=15;else if(e.clientY>bounds.bottom-22)root.scrollTop+=15;
    target=imageDropIndex(editor,e.clientX,e.clientY);showImageDropCaret(editor,target);
  };
  const onUp=()=>{imageGesture=null;restore();if(moved&&node.isConnected&&editor===richEditor)moveMemoImage(node,target,editor);};
  const onCancel=()=>{imageGesture=null;restore();};
  root.addEventListener('pointermove',onMove);root.addEventListener('pointerup',onUp);root.addEventListener('pointercancel',onCancel);imageGesture={cancel:restore};
}
function initImageInteractions(editor) {
  destroyImageInteractions();
  const onPointer=e=>{const node=e.target.closest('.skycrm-local-image');if(node&&editor.root.contains(node))beginImageMove(e,node,editor);};
  const onOutside=e=>{if(e.target.closest('#memo-image-frame,#memo-image-tools,.skycrm-local-image'))return;clearImageSelection();};
  const onKey=e=>{
    if(!selectedMemoImage||e.target.closest('input,textarea,select')||$('#rename-dialog')?.open)return;
    if(e.key==='Escape'){clearImageSelection();return;}
    if(!e.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)){
      const index=imageIndex(selectedMemoImage,editor);clearImageSelection();
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const next=index+(e.key==='ArrowRight'?1:0);editor.setSelection(next,0,'silent');richSelection={index:next,length:0};}
      return;
    }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){clearImageSelection();return;}
    if((e.ctrlKey||e.metaKey)&&['c','x'].includes(e.key.toLowerCase()))editor.setSelection(imageIndex(selectedMemoImage,editor),1,'silent');
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopImmediatePropagation();deleteSelectedImage();}
    if(e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();const index=imageIndex(selectedMemoImage,editor);moveMemoImage(selectedMemoImage,index+(e.key==='ArrowLeft'?-1:2),editor);}
  };
  const onTextChange=()=>{if(selectedMemoImage&&!selectedMemoImage.isConnected)clearImageSelection();};
  editor.root.addEventListener('pointerdown',onPointer);document.addEventListener('pointerdown',onOutside);document.addEventListener('keydown',onKey,true);editor.on('text-change',onTextChange);
  imageInteractionsCleanup=()=>{editor.root.removeEventListener('pointerdown',onPointer);document.removeEventListener('pointerdown',onOutside);document.removeEventListener('keydown',onKey,true);editor.off('text-change',onTextChange);};
}
