'use strict';
const KEY = 'skycrm-web-preview-v1';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now()+'-'+Math.random();
let state = {calls:[], clients:[], memos:[]};
try { const saved = JSON.parse(localStorage.getItem(KEY)); if(saved && ['calls','clients','memos'].every(k=>Array.isArray(saved[k]))) state=saved; }
catch { $('#status').textContent='저장 데이터를 읽지 못했습니다. 새 화면으로 시작합니다.'; }
let tab='calls', selected='', query='', memoId='', sortKey='', ascending=true;
const localDate = () => {const d=new Date();return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,19)};
const today = localDate().slice(0,10);
const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth()-1);
let start= new Date(lastMonth-lastMonth.getTimezoneOffset()*60000).toISOString().slice(0,10), end=today;
function persist(){try{localStorage.setItem(KEY, JSON.stringify(state));$('#status').textContent='저장됨 · '+new Date().toLocaleTimeString('ko-KR');return true}catch{$('#status').textContent='저장 실패: 브라우저 저장 공간을 확인하세요. 창을 닫기 전에 내용을 복사해 주세요.';return false}}
function render(){
 if(tab==='memos'){renderMemos();return}
 if(tab==='clients'){
 $('#app').innerHTML=`<div class="search-row"><label for="search">거래처 검색:</label><input id="search" type="search" placeholder="거래처 검색..." value="${esc(query)}"></div><div id="list" class="scroll"></div><div class="actions client-buttons"><button class="primary" id="new-client">새 거래처 등록</button><button class="danger" id="delete-selected">선택 거래처 삭제</button></div>`;
 $('#new-client').onclick=()=>openClient();
 }else{
 $('#app').innerHTML=`<form id="call-form"><fieldset><legend>신규 통화 기록</legend><div class="call-grid"><label for="call-name">거래처명:</label><input id="call-name" name="name" list="client-names" placeholder="거래처명을 입력하세요"><span>유형:</span><div class="radios"><label><input type="radio" name="type" value="수신" checked>수신</label><label><input type="radio" name="type" value="송신">송신</label></div><label for="call-phone">연락처:</label><input id="call-phone" name="phone" type="tel"></div><datalist id="client-names">${state.clients.map(c=>`<option value="${esc(c.name)}"></option>`).join('')}</datalist></fieldset><textarea name="content" placeholder="통화 내용을 입력하세요..." aria-label="통화 내용"></textarea><div class="actions call-actions"><button class="primary" type="submit">저장</button><button class="danger" type="button" id="delete-selected">선택 로그 삭제</button></div></form><fieldset><legend>검색 필터</legend><div class="filter"><label>기간: <input id="start" type="date" value="${start}"></label><span>~</span><input id="end" type="date" aria-label="종료일" value="${end}"><input id="search" type="search" placeholder="검색어..." value="${esc(query)}"><button class="primary" id="find-calls">검색</button></div></fieldset><div id="list" class="scroll"></div><p class="muted">행 선택 후 삭제 · 셀을 더블클릭하면 수정 · 열 제목을 클릭하면 정렬</p>`;
 $('#call-form').onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));state.calls.unshift({...data,id:uid(),date:localDate()});if(data.name.trim()&&!state.clients.some(c=>c.name===data.name))state.clients.push({id:uid(),name:data.name,phone:'',phone2:'',phone3:'',content:''});persist();render()};
 $('#call-name').onchange=e=>{const client=state.clients.find(c=>c.name===e.target.value);if(client&&!$('#call-phone').value)$('#call-phone').value=client.phone||''};
 $('#start').onchange=e=>{start=e.target.value;renderList()};$('#end').onchange=e=>{end=e.target.value;renderList()};$('#find-calls').onclick=renderList;
 }
 $('#search').oninput=e=>{query=e.target.value;renderList()};$('#delete-selected').onclick=()=>deleteItem(tab,selected);renderList();
}
function filtered(kind){let rows=state[kind].filter(x=>[x.name,x.phone,x.phone2,x.phone3,x.content,x.type].some(v=>String(v||'').toLowerCase().includes(query.toLowerCase())));if(kind==='calls')rows=rows.filter(x=>(!start||String(x.date).slice(0,10)>=start)&&(!end||String(x.date).slice(0,10)<=end));if(sortKey)rows=[...rows].sort((a,b)=>String(a[sortKey]||'').localeCompare(String(b[sortKey]||''),'ko')*(ascending?1:-1));return rows}
function renderList(){
 const calls=tab==='calls', cols=calls?[['name','거래처'],['date','날짜/시간'],['phone','전화번호'],['type','구분'],['content','통화내용']]:[['name','거래처명'],['phone','전화1'],['phone2','전화2'],['phone3','전화3'],['content','메모']];
 const rows=filtered(tab);
 $('#list').innerHTML=`<table><thead><tr><th class="number"></th>${calls?'<th style="width:65px">할 일</th>':''}${cols.map(([key,label])=>`<th><button data-sort="${key}">${label}${sortKey===key?(ascending?' ▴':' ▾'):''}</button></th>`).join('')}</tr></thead><tbody>${rows.map((x,i)=>`<tr data-row="${esc(x.id)}" class="${selected===x.id?'selected':''}"><td class="number">${i+1}</td>${calls?`<td><input type="checkbox" data-call-task="${esc(x.id)}" aria-label="할 일에 연결" ${state.memos.some(m=>m.sourceCallId===x.id&&m.kind==='task')?'checked':''}></td>`:''}${cols.map(([key])=>`<td data-cell="${key}" data-id="${esc(x.id)}">${esc(key==='date'?String(x[key]||'').replace('T',' '):x[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length?'':'<p class="empty">표시할 항목이 없습니다.</p>'}`;
}
function deleteItem(kind,id){if(kind==='memos'){deleteMemo(id);return}if(!id){$('#status').textContent='삭제할 항목을 먼저 선택해 주세요.';return}if(!confirm('선택한 항목을 삭제할까요?'))return;state[kind]=state[kind].filter(x=>x.id!==id);selected='';persist();render()}
function openClient(id){const c=state.clients.find(x=>x.id===id)||{};$('#client-form').reset();for(const key of ['id','name','phone','phone2','phone3','content'])$('#client-form').elements[key].value=c[key]||'';$('#client-dialog').showModal();$('#client-form [name=name]').focus()}
$('#close-client').onclick=()=>$('#client-dialog').close();
$('#client-form').onsubmit=e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));data.name=data.name.trim();if(!data.name)return;if(state.clients.some(c=>c.name===data.name&&c.id!==data.id)){alert('같은 이름의 거래처가 있습니다.');return}const old=state.clients.find(c=>c.id===data.id);if(old)Object.assign(old,data);else state.clients.push({...data,id:uid()});persist();$('#client-dialog').close();render()};
$('nav').onclick=e=>{const b=e.target.closest('[data-tab]');if(!b)return;closeMemoOverlays();tab=b.dataset.tab;selected='';query='';sortKey='';document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));render()};
$('#app').addEventListener('click',e=>{
 const sort=e.target.closest('[data-sort]');if(sort){ascending=sortKey===sort.dataset.sort?!ascending:true;sortKey=sort.dataset.sort;renderList();return}
 const row=e.target.closest('[data-row]');if(row){selected=row.dataset.row;document.querySelectorAll('[data-row]').forEach(r=>r.classList.toggle('selected',r===row))}
});
$('#app').addEventListener('change',e=>{if(e.target.matches('[data-call-task]')){const call=state.calls.find(c=>c.id===e.target.dataset.callTask);let item=state.memos.find(m=>m.sourceCallId===call.id);if(item)changeMemoKind(item,e.target.checked?'task':'note');else if(e.target.checked){item=makeMemo('task',{name:call.name,phone:call.phone,content:call.content});item.sourceCallId=call.id;}persist()}});
$('#app').ondblclick=e=>{const cell=e.target.closest('[data-cell]');if(!cell)return;const item=state[tab].find(x=>x.id===cell.dataset.id),key=cell.dataset.cell;cell.contentEditable='true';cell.focus();const original=item[key]||'';cell.onkeydown=event=>{if(event.key==='Escape'){cell.textContent=original;cell.blur()}if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();cell.blur()}};cell.onblur=()=>{const value=cell.textContent;if(tab==='clients'&&key==='name'&&(!value.trim()||state.clients.some(c=>c.id!==item.id&&c.name===value))){cell.textContent=original;$('#status').textContent='거래처명은 비어 있거나 중복될 수 없습니다.'}else{item[key]=value;persist()}cell.contentEditable='false'}};
render();
