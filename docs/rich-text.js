'use strict';
// Quill stores formatting as Delta data, not arbitrary saved HTML.
const RichDelta = Quill.import('delta');
const RichSize = Quill.import('attributors/style/size');
RichSize.whitelist = Array.from({length:89}, (_,i) => (i+8)+'px');
Quill.register(RichSize, true);
const Parchment = Quill.import('parchment');
Quill.register(new Parchment.StyleAttributor('weight', 'font-weight', {scope:Parchment.Scope.INLINE, whitelist:['300','400','500','600','700','800','900']}), true);
let richEditor = null, richSelection = null;
const richAllowedFormats = ['bold','weight','size','color','background'];
function richAttributes(attributes = {}) {
  const safe = {};
  if (attributes.bold === true) safe.bold = true;
  if (['300','400','500','600','700','800','900'].includes(String(attributes.weight))) safe.weight = String(attributes.weight);
  if (RichSize.whitelist.includes(attributes.size)) safe.size = attributes.size;
  for (const name of ['color','background']) if (typeof attributes[name] === 'string' && CSS.supports('color', attributes[name])) safe[name] = attributes[name];
  return safe;
}
function richDocument(page) {
  if (Array.isArray(page?.delta?.ops)) {
    const ops = page.delta.ops.filter(op => typeof op.insert === 'string').map(op => ({insert:op.insert, attributes:richAttributes(op.attributes)}));
    let text = ops.map(op => op.insert).join('');
    if (!text.endsWith('\n')) { ops.push({insert:'\n'}); text += '\n'; }
    // A newer plain-text edit in an old browser tab takes precedence over stale formatting.
    if (text.slice(0,-1) === String(page.content || '')) return {ops};
  }
  return {ops:[{insert:String(page?.content || '')+'\n'}]};
}
function readRichText() { return richEditor ? richEditor.getText(0, Math.max(0, richEditor.getLength()-1)) : ''; }
function readRichDelta() { return richEditor ? JSON.parse(JSON.stringify(richEditor.getContents())) : {ops:[{insert:'\n'}]}; }
function loadRichDocument(document) {
  if (!richEditor) return;
  richEditor.setContents(document, 'silent'); richSelection = null; updateRichToolbar();
}
function loadRichPage(page) { loadRichDocument(richDocument(page)); }
function focusRichEditor() { richEditor?.focus(); }
function richToolbar() {
  return `<div class="toolbar rich-toolbar" aria-label="선택한 글자 서식"><button type="button" data-tool="undo" title="실행 취소">↶ 취소</button><button type="button" data-tool="redo" title="다시 실행">↷ 다시</button><button type="button" id="text-bold" aria-label="선택 글자 굵게" aria-pressed="false"><b>B</b></button><label>굵기<select id="text-weight" aria-label="글자 굵기"><option value="">혼합</option><option value="300">가늘게</option><option value="400">보통</option><option value="500">중간</option><option value="600">약간 굵게</option><option value="700">굵게</option><option value="800">더 굵게</option><option value="900">매우 굵게</option></select></label><label>크기<select id="text-size" aria-label="글자 크기"><option value="">혼합</option>${[10,12,14,16,18,20,24,28,32,40,48,64].map(n=>`<option value="${n}px">${n}px</option>`).join('')}</select></label><label>글자색<input id="text-color" type="color" value="#2f3437" aria-label="글꼴 색"></label><label>배경색<input id="text-background" type="color" value="#fff176" aria-label="글자 배경색"></label><label class="opacity-control">배경 불투명도<input id="background-opacity" type="range" min="0" max="100" value="100" aria-label="글자 배경 불투명도"><output id="opacity-value">100%</output></label><button type="button" id="clear-text-background">배경 지우기</button><span class="selection-help" id="text-selection-hint">글자를 드래그해 선택한 뒤 서식을 바꾸세요.</span></div>`;
}
function initRichEditor(page) {
  richEditor = new Quill('#memo-rich', {theme:null, formats:richAllowedFormats, placeholder:'내용을 입력하세요.', modules:{toolbar:false, history:false}});
  richEditor.root.id = 'memo-content';
  richEditor.root.setAttribute('role','textbox'); richEditor.root.setAttribute('aria-label','메모 내용'); richEditor.root.setAttribute('aria-multiline','true');
  loadRichPage(page);
  richEditor.on('selection-change', range => { if (range) { richSelection = {index:range.index,length:range.length}; updateRichToolbar(); } });
  richEditor.on('text-change', (_delta,_previous,source) => { if (source === 'user') updateMemo(); });
  richEditor.root.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['z','y','s','b'].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopImmediatePropagation(); const key = e.key.toLowerCase();
      if (key === 'b') applyRichBold(); else tool(key === 'z' ? (e.shiftKey ? 'redo' : 'undo') : ({y:'redo',s:'save'}[key]));
    }
  }, true);
  // Toolbar controls must not replace the saved text range when they take focus.
  $('#text-bold').onmousedown = e => e.preventDefault();
  $('#text-bold').onclick = applyRichBold;
  $('#text-weight').onchange = e => { if (e.target.value) applyRichFormat({bold:false,weight:e.target.value}); };
  $('#text-size').onchange = e => { if (e.target.value) applyRichFormat({size:e.target.value}); };
  $('#text-color').oninput = e => applyRichFormat({color:e.target.value});
  $('#text-background').oninput = applyRichBackground;
  $('#background-opacity').oninput = () => { $('#opacity-value').textContent = $('#background-opacity').value+'%'; applyRichBackground(); };
  $('#clear-text-background').onmousedown = e => e.preventDefault();
  $('#clear-text-background').onclick = () => applyRichFormat({background:false});
}
function applyRichFormat(attributes) {
  const range = richSelection;
  if (!richEditor || !range || range.length <= 0 || range.index+range.length > richEditor.getLength()-1) { $('#status').textContent = '서식을 바꿀 글자를 먼저 드래그해 선택해 주세요.'; return; }
  richEditor.formatText(range.index, range.length, attributes, 'user');
  $('#text-selection-hint').textContent = `${range.length}자 선택 · 선택 부분에만 적용`;
}
function applyRichBold() {
  if (!richEditor) return;
  const format = richSelection ? richEditor.getFormat(richSelection.index,richSelection.length) : {};
  const weight = format.weight || (format.bold ? '700' : '400');
  applyRichFormat({bold:false,weight:Number(weight)>=600?'400':'700'});
  if (richSelection) updateRichToolbar();
}
function applyRichBackground() {
  const color = $('#text-background').value, opacity = Number($('#background-opacity').value)/100;
  const rgb = [1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
  applyRichFormat({background:`rgba(${rgb.join(', ')}, ${opacity})`});
}
function parseRichColor(value) {
  const span = document.createElement('span'); span.style.color=value; document.body.append(span);
  const color = getComputedStyle(span).color; span.remove();
  const values = color.match(/[\d.]+/g)?.map(Number); if (!values || values.length<3) return null;
  return {hex:'#'+values.slice(0,3).map(n=>Math.round(n).toString(16).padStart(2,'0')).join(''),alpha:values[3]??1};
}
function updateRichToolbar() {
  if (!richEditor || !$('#text-weight')) return;
  const format = richSelection ? richEditor.getFormat(richSelection.index,richSelection.length) : {};
  const weight = format.weight || (format.bold ? '700' : '400');
  $('#text-weight').value = Array.isArray(weight)?'':weight;
  $('#text-size').value = Array.isArray(format.size)?'':(format.size||'16px');
  $('#text-bold').setAttribute('aria-pressed', String(!Array.isArray(weight)&&Number(weight)>=600));
  if (typeof format.color==='string') { const parsed=parseRichColor(format.color); if(parsed)$('#text-color').value=parsed.hex; }
  if (typeof format.background==='string') { const parsed=parseRichColor(format.background); if(parsed){$('#text-background').value=parsed.hex;$('#background-opacity').value=Math.round(parsed.alpha*100);$('#opacity-value').textContent=Math.round(parsed.alpha*100)+'%';} }
  $('#text-selection-hint').textContent = richSelection?.length ? `${richSelection.length}자 선택 · 선택 부분에만 적용` : '글자를 드래그해 선택한 뒤 서식을 바꾸세요.';
}
function selectRichText(index,length) { richEditor.setSelection(index,length,'user'); richEditor.focus(); richEditor.scrollSelectionIntoView(); }
function replaceRichText(needle,replacement) {
  const text = readRichText(), lower = text.toLowerCase(), search = needle.toLowerCase(); let start=0,index=0,count=0;
  const delta = new RichDelta();
  while ((index=lower.indexOf(search,start))>=0) {
    delta.retain(index-start).delete(needle.length).insert(replacement,richAttributes(richEditor.getFormat(index,1)));
    start=index+needle.length;count++;
  }
  if(count){richSelection=null;richEditor.updateContents(delta,'user');updateRichToolbar();}
  return count;
}
