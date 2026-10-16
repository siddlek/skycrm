'use strict';
function crmColumns(kind) {
  return kind === 'calls'
    ? [{key:'_row',label:'행번호',width:46,min:36},{key:'_task',label:'할 일',width:66,min:46},{key:'name',label:'거래처',width:160},{key:'date',label:'날짜/시간',width:185},{key:'phone',label:'전화번호',width:155},{key:'type',label:'구분',width:80},{key:'content',label:'통화내용',width:360}]
    : [{key:'_row',label:'행번호',width:46,min:36},{key:'name',label:'거래처명',width:185},{key:'phone',label:'전화1',width:155},{key:'phone2',label:'전화2',width:155},{key:'phone3',label:'전화3',width:155},{key:'content',label:'메모',width:360}];
}
function crmColumnMarkup(kind) {
  return '<colgroup>'+crmColumns(kind).map(c=>`<col data-column="${c.key}">`).join('')+'</colgroup>';
}
function initColumnResizing() {
  const table = document.querySelector('.crm-table'); if (!table) return;
  state.ui ||= {}; state.ui.columnWidths ||= {};
  const kind = table.dataset.table, definitions = crmColumns(kind), saved = state.ui.columnWidths[kind] || {};
  const widths = definitions.map(c=>Math.max(c.min||70,Math.min(2400,Number(saved[c.key])||c.width)));
  if (!Object.keys(saved).length) widths[widths.length-1] += Math.max(0,table.parentElement.clientWidth-widths.reduce((a,b)=>a+b,0));
  const apply = () => {
    table.style.width = widths.reduce((a,b)=>a+b,0)+'px';
    definitions.forEach((c,i)=>{table.querySelector(`col[data-column="${c.key}"]`).style.width=widths[i]+'px';table.querySelectorAll('[data-resize-column]')[i]?.setAttribute('aria-valuenow',String(Math.round(widths[i])));});
  };
  const save = () => { state.ui.columnWidths[kind]=Object.fromEntries(definitions.map((c,i)=>[c.key,Math.round(widths[i])]));persist(); };
  definitions.forEach((c,i)=>{
    const th=table.querySelectorAll('thead th')[i];
    const handle=document.createElement('span');handle.className='column-resizer';handle.dataset.resizeColumn=c.key;handle.tabIndex=0;
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label',c.label+' 열 너비 조절');handle.setAttribute('aria-valuemin',String(c.min||70));handle.setAttribute('aria-valuemax','2400');handle.title='드래그로 열 너비 조절 · 더블클릭으로 기본 너비';
    th.append(handle);
    handle.onpointerdown=e=>{
      if(e.button!==0)return;e.preventDefault();e.stopPropagation();
      table.querySelectorAll('thead th').forEach((head,n)=>{widths[n]=head.getBoundingClientRect().width;});
      const startX=e.clientX,startWidth=widths[i];handle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-column');
      handle.onpointermove=event=>{widths[i]=Math.max(c.min||70,Math.min(2400,startWidth+event.clientX-startX));apply();};
      const finish=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;document.body.classList.remove('resizing-column');save();};handle.onpointerup=finish;handle.onpointercancel=finish;
    };
    handle.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();widths[i]=Math.max(c.min||70,Math.min(2400,widths[i]+(e.key==='ArrowLeft'?-8:8)));apply();save();}};
    handle.ondblclick=e=>{e.preventDefault();e.stopPropagation();widths[i]=c.width;apply();save();};
  });
  apply();
}
