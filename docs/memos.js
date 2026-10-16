'use strict';
// Keep the original storage key. Old single-page memos become the first page.
state.folders = Array.isArray(state.folders) ? state.folders : [];
state.ui = state.ui && typeof state.ui === 'object' ? state.ui : {};
const memoNow = () => new Date().toISOString();
const memoTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? memoNow() : date.toISOString(); };
const memoById = id => state.memos.find(m => m.id === id);
const folderById = id => state.folders.find(f => f.id === id);
for (const item of state.memos) {
  item.parent = typeof item.parent === 'string' ? item.parent : '';
  item.folderId = typeof item.folderId === 'string' ? item.folderId : '';
  item.createdAt = memoTime(item.createdAt || item.updatedAt);
  item.updatedAt = memoTime(item.updatedAt || item.createdAt);
  if (!Array.isArray(item.pages)) item.pages = [{id: uid(), name: '새 탭', content: String(item.content || '')}];
  item.pages.forEach(p => { p.id ||= uid(); p.name ||= '새 탭'; p.content = String(p.content || ''); });
  if (!item.pages.some(p => p.id === item.activePageId)) item.activePageId = item.pages[0]?.id || '';
  if (item.kind !== 'task') item.parent = '';
  if (item.kind === 'task' || !folderById(item.folderId)) item.folderId = '';
}
for (const f of state.folders) { f.parent ||= ''; f.createdAt = memoTime(f.createdAt); f.updatedAt = memoTime(f.updatedAt || f.createdAt); }
function cleanParentLinks(items, lookup) {
  for (const item of items) {
    const seen = new Set([item.id]); let parent = item.parent;
    while (parent) { const ancestor = lookup(parent); if (!ancestor || seen.has(parent)) { item.parent = ''; break; } seen.add(parent); parent = ancestor.parent || ''; }
  }
}
cleanParentLinks(state.memos.filter(m => m.kind === 'task'), id => state.memos.find(m => m.id === id && m.kind === 'task'));
cleanParentLinks(state.folders, folderById);
let selectedFolder = '', history = [], historyIndex = -1, dragItem = null, menuContext = null, renameAction = null;
const activeMemo = () => memoById(memoId);
const activePage = item => item?.pages.find(p => p.id === item.activePageId);
const itemTitle = item => item.name || item.pages?.[0]?.content.split('\n')[0] || '(이름 없음)';
function uniqueName(base, names) { let value = base, n = 1; while (names.includes(value)) value = base + n++; return value; }
function makeMemo(kind, fields = {}) {
  const now = memoNow();
  const page = {id: uid(), name: '새 탭', content: fields.content || ''};
  const item = {id: uid(), kind, name: uniqueName(kind === 'task' ? '새 할 일' : '새 메모', state.memos.map(itemTitle)), phone: '', content: '', done: false, parent: '', folderId: '', createdAt: now, updatedAt: now, ...fields, pages: [page], activePageId: page.id};
  state.memos.unshift(item); return item;
}
function createMemo(kind, fields = {}) {
  const folder = kind === 'note' ? (fields.folderId ?? selectedFolder) : '';
  if (folderById(folder)) folderById(folder).collapsed = false;
  const item = makeMemo(kind, {...fields, folderId: folderById(folder) ? folder : ''});
  if (item.parent && memoById(item.parent)) memoById(item.parent).collapsed = false;
  memoId = item.id; persist(); renderMemos(); $('#memo-content')?.focus();
}
function createFolder(parent = '') {
  const now = memoNow(), folder = {id: uid(), name: uniqueName('새 폴더', state.folders.map(f => f.name)), parent: folderById(parent) ? parent : '', createdAt: now, updatedAt: now};
  if (parent && folderById(parent)) folderById(parent).collapsed = false;
  state.folders.unshift(folder); selectedFolder = folder.id; persist(); renderMemoLists(); renameFolder(folder.id);
}
function changeMemoKind(item, kind) {
  if (kind === item.kind) return;
  if (kind === 'note') { for (const child of state.memos.filter(m => m.parent === item.id)) child.parent = item.parent || ''; item.parent = ''; }
  else item.folderId = '';
  item.kind = kind; item.updatedAt = memoNow();
}
function closeMemoOverlays() { $('#find-panel').close(); hideContextMenu(); $('#rename-dialog')?.close(); }
function renderMemos() {
  closeMemoOverlays();
  $('#app').innerHTML = `<div class="memo-layout"><section class="memo-list"><div class="search-row"><input id="memo-search" type="search" aria-label="메모 검색" placeholder="제목·모든 페이지 내용 검색" value="${esc(query)}"></div><div id="memo-lists"></div></section><div id="memo-divider" role="separator" aria-label="목록과 편집 너비 조절" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" tabindex="0" title="드래그 또는 좌우 방향키로 너비 조절"></div><section class="panel memo-editor" id="memo-editor"></section></div>`;
  $('#memo-search').oninput = e => { query = e.target.value; renderMemoLists(); };
  renderMemoLists(); renderMemoEditor(); setupDivider();
}
function sortedNotes(items) {
  const mode = state.ui.noteSort || 'manual';
  if (mode === 'manual') return items;
  return [...items].sort((a,b) => mode === 'name' ? itemTitle(a).localeCompare(itemTitle(b), 'ko', {numeric:true}) : String(b[mode === 'created' ? 'createdAt' : 'updatedAt']).localeCompare(String(a[mode === 'created' ? 'createdAt' : 'updatedAt'])));
}
function matchesMemo(item) { return [item.name, ...item.pages.map(p => p.name + '\n' + p.content)].some(v => String(v || '').toLowerCase().includes(query.toLowerCase())); }
function memoRow(item, depth = 0) {
  const task = item.kind === 'task', hasChildren = task && state.memos.some(m => m.kind === 'task' && m.parent === item.id);
  const preview = activePage(item)?.content || item.pages[0]?.content || '';
  return `<tr draggable="true" data-drag-memo="${esc(item.id)}" ${task ? `data-task-id="${esc(item.id)}"` : `data-note-id="${esc(item.id)}"`} class="memo-row ${task && item.done ? 'done ' : ''}${item.id === memoId ? 'selected' : ''}" aria-selected="${item.id === memoId}">${task ? `<td><input type="checkbox" data-memo-done="${esc(item.id)}" aria-label="할 일 완료" ${item.done ? 'checked' : ''}></td>` : ''}<td data-memo-edit="${esc(item.id)}"><div class="task-title" style="padding-left:${depth * 22}px">${task ? (hasChildren ? `<button class="fold-task" data-fold-task="${esc(item.id)}" aria-label="하위 할 일 ${item.collapsed ? '펼치기' : '접기'}" aria-expanded="${!item.collapsed}">${item.collapsed ? '▸' : '▾'}</button>` : '<span class="fold-spacer"></span>') : '<span class="file-icon" aria-hidden="true">▤</span>'}<span class="memo-title" data-rename-memo="${esc(item.id)}">${esc(itemTitle(item))}</span></div><div class="preview-text" style="padding-left:${depth * 22}px">${esc(preview)}</div></td></tr>`;
}
function renderMemoLists() {
  const tasks = state.memos.filter(x => x.kind === 'task'), included = new Set();
  for (const task of tasks.filter(matchesMemo)) { let current = task; while (current && !included.has(current.id)) { included.add(current.id); current = tasks.find(t => t.id === current.parent); } }
  const taskRows = []; const visit = (parent, depth) => { for (const t of tasks.filter(x => (x.parent || '') === parent)) { if (!included.has(t.id)) continue; taskRows.push(memoRow(t, depth)); if (!t.collapsed || query) visit(t.id, depth + 1); } }; visit('', 0);
  function noteBranch(parent, depth) {
    const parts = [];
    for (const folder of sortedNotes(state.folders.filter(f => f.parent === parent))) {
      const inner = noteBranch(folder.id, depth + 1);
      if (query && !inner && !folder.name.toLowerCase().includes(query.toLowerCase())) continue;
      const expanded = !folder.collapsed || !!query;
      parts.push(`<tr class="folder-row ${selectedFolder === folder.id ? 'folder-selected' : ''}" draggable="true" data-drag-folder="${esc(folder.id)}" data-folder-id="${esc(folder.id)}"><td><div class="task-title" style="padding-left:${depth * 22}px"><button class="fold-task" data-fold-folder="${esc(folder.id)}" aria-label="폴더 ${expanded ? '접기' : '펼치기'}" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button><span class="file-icon" aria-hidden="true">▱</span><span data-rename-folder="${esc(folder.id)}">${esc(folder.name)}</span></div></td></tr>`);
      if (expanded) parts.push(inner);
    }
    for (const note of sortedNotes(state.memos.filter(m => m.kind === 'note' && (m.folderId || '') === parent && matchesMemo(m)))) parts.push(memoRow(note, depth));
    return parts.join('');
  }
  const notes = noteBranch('', 0);
  $('#memo-lists').innerHTML = `<section class="panel" data-list-kind="task"><div class="bar"><h2>할 일</h2><button class="plus" data-new-kind="task" aria-label="할 일 추가">+</button></div><p class="muted">행 가운데에 놓으면 하위로, 위·아래 가장자리에 놓으면 같은 단계로 이동</p><div class="scroll task-drop-root" data-task-root><table><thead><tr><th>완료</th><th>내용</th></tr></thead><tbody>${taskRows.join('')}</tbody></table><div class="root-drop-space" data-task-root>빈 공간에 놓으면 최상위로 이동</div></div></section><section class="panel" data-list-kind="note"><div class="bar"><h2>일반 메모</h2><div class="actions compact"><button class="folder-add" data-new-folder aria-label="폴더 추가">폴더 +</button><button class="plus" data-new-kind="note" aria-label="일반 메모 추가">+</button></div></div><div class="note-options"><select id="note-sort" aria-label="일반 메모 정렬"><option value="manual">직접 정렬 (드래그)</option><option value="name">이름순</option><option value="updated">수정 시간순 (최신 먼저)</option><option value="created">생성 시간순 (최신 먼저)</option></select><small>우클릭: 추가·삭제 / 이름 더블클릭: 수정</small></div><div class="scroll" data-note-root><table class="note-table"><thead><tr><th>폴더 / 메모</th></tr></thead><tbody>${notes}</tbody></table><div class="root-drop-space" data-note-root>폴더 밖으로 옮기려면 여기에 놓기</div></div></section>`;
  $('#note-sort').value = state.ui.noteSort || 'manual';
  $('#note-sort').onchange = e => { state.ui.noteSort = e.target.value; persist(); renderMemoLists(); };
}
function selectMemo(id) {
  const item = memoById(id); selectedFolder = item?.folderId || '';
  if (memoId === id && $('#memo-content')) return;
  memoId = id;
  $('#find-panel').close(); renderMemoEditor();
  document.querySelectorAll('.memo-row').forEach(row => { const selected = row.dataset.dragMemo === id; row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected)); });
}
function renderMemoEditor() {
  const item = activeMemo(), page = activePage(item);
  $('#memo-editor').innerHTML = item ? `<div class="editor-title"><input id="memo-name" aria-label="메모 제목" value="${esc(item.name)}" placeholder="제목"><select id="memo-kind" aria-label="메모 종류"><option value="note" ${item.kind === 'note' ? 'selected' : ''}>일반 메모</option><option value="task" ${item.kind === 'task' ? 'selected' : ''}>할 일</option></select></div><label id="memo-phone-label" ${item.kind === 'task' ? '' : 'hidden'}>전화번호 (선택)<input id="memo-phone" value="${esc(item.phone)}"></label><div class="page-tabs" role="tablist" aria-label="메모 페이지">${item.pages.map(p => `<div class="page-tab"><button role="tab" data-page-id="${esc(p.id)}" aria-selected="${p.id === item.activePageId}"><span data-rename-page="${esc(p.id)}">${esc(p.name)}</span></button><button class="close-page" data-delete-page="${esc(p.id)}" aria-label="${esc(p.name)} 페이지 삭제">×</button></div>`).join('')}<button class="add-page" data-add-page aria-label="페이지 추가">+</button></div>${page ? `<div class="toolbar" aria-label="메모 편집 도구"><button data-tool="undo" title="실행 취소">↶ 취소</button><button data-tool="redo" title="다시 실행">↷ 다시</button></div><textarea id="memo-content" aria-label="메모 내용" placeholder="내용을 입력하세요.">${esc(page.content)}</textarea><div class="editor-meta"><span id="memo-count"></span><span>자동 저장</span></div>` : '<p class="empty">위의 +로 새 페이지를 추가하세요.</p>'}` : '<p class="empty">목록 옆 + 또는 우클릭으로 추가하세요.<br>목록의 이름을 더블클릭하면 수정할 수 있습니다.</p>';
  if (!item) return;
  history = [memoSnapshot()]; historyIndex = 0;
  $('#memo-name').oninput = () => updateMemo(); $('#memo-phone').oninput = () => updateMemo();
  $('#memo-kind').onchange = e => { changeMemoKind(item, e.target.value); selectedFolder = item.folderId; persist(); renderMemoLists(); $('#memo-phone-label').hidden = item.kind !== 'task'; };
  if (page) {
    $('#memo-content').oninput = () => updateMemo();
    $('#memo-content').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && ['z','y','s'].includes(e.key.toLowerCase())) { e.preventDefault(); const k = e.key.toLowerCase(); tool(k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : ({y:'redo',s:'save'}[k])); } };
    updateCount();
  }
  updateHistoryButtons();
}
function selectPage(id) {
  const item = activeMemo(); if (!item?.pages.some(p => p.id === id) || id === item.activePageId) return;
  item.activePageId = id; persist(); $('#find-panel').close();
  if (!$('#memo-content')) { renderMemoEditor(); return; }
  $('#memo-content').value = activePage(item).content;
  document.querySelectorAll('[data-page-id]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pageId === id)));
  history = [memoSnapshot()]; historyIndex = 0; updateCount(); updateHistoryButtons();
}
function addPage() {
  const item = activeMemo(); if (!item) return;
  const p = {id: uid(), name: uniqueName('새 탭', item.pages.map(p => p.name)), content: ''};
  item.pages.push(p); item.activePageId = p.id; item.updatedAt = memoNow(); persist(); renderMemoEditor(); $('#memo-content').focus();
}
function deletePage(id) {
  const item = activeMemo(); if (!item || !confirm('이 페이지를 삭제할까요? 페이지 내용도 함께 삭제됩니다.')) return;
  const index = item.pages.findIndex(p => p.id === id); if (index < 0) return;
  item.pages.splice(index, 1); if (item.activePageId === id) item.activePageId = item.pages[Math.min(index, item.pages.length - 1)]?.id || '';
  item.content = item.pages[0]?.content || ''; item.updatedAt = memoNow(); persist(); $('#find-panel').close(); renderMemoEditor(); renderMemoLists();
}
function deleteMemo(id) {
  const item = memoById(id); if (!item || !confirm('선택한 항목과 그 안의 모든 페이지를 삭제할까요? 하위 할 일은 남깁니다.')) return;
  for (const child of state.memos.filter(m => m.parent === id)) child.parent = item.parent || '';
  state.memos = state.memos.filter(m => m.id !== id); if (memoId === id) memoId = '';
  persist(); renderMemos();
}
function deleteFolder(id) {
  const folder = folderById(id); if (!folder || !confirm('폴더를 삭제할까요? 안의 메모와 하위 폴더는 상위로 옮겨 보존합니다.')) return;
  for (const item of state.memos.filter(m => m.folderId === id)) item.folderId = folder.parent || '';
  for (const child of state.folders.filter(f => f.parent === id)) child.parent = folder.parent || '';
  state.folders = state.folders.filter(f => f.id !== id); selectedFolder = folder.parent || ''; persist(); renderMemoLists();
}
function openRename(title, value, action) {
  hideContextMenu(); if (!$('#rename-dialog')) document.body.insertAdjacentHTML('beforeend', '<dialog id="rename-dialog"><form id="rename-form"><h2 id="rename-title"></h2><label>이름<input id="rename-input" aria-label="새 이름" required maxlength="200"></label><div class="actions"><button type="submit">저장</button><button type="button" id="rename-cancel">취소</button></div></form></dialog>');
  $('#rename-title').textContent = title; $('#rename-input').value = value; renameAction = action;
  $('#rename-form').onsubmit = e => { e.preventDefault(); const name = $('#rename-input').value.trim(); if (!name) return; renameAction(name); $('#rename-dialog').close(); };
  $('#rename-cancel').onclick = () => $('#rename-dialog').close(); $('#rename-dialog').showModal(); $('#rename-input').focus(); $('#rename-input').select();
}
function renameMemo(id) { const item = memoById(id); if (item) openRename('항목 이름 수정', itemTitle(item), name => { item.name = name; item.updatedAt = memoNow(); persist(); renderMemoLists(); if (id === memoId) $('#memo-name').value = name; }); }
function renameFolder(id) { const f = folderById(id); if (f) openRename('폴더 이름 수정', f.name, name => { f.name = name; f.updatedAt = memoNow(); persist(); renderMemoLists(); }); }
function renamePage(id) { const item = activeMemo(), page = item?.pages.find(p => p.id === id); if (page) openRename('페이지 이름 수정', page.name, name => { page.name = name; item.updatedAt = memoNow(); persist(); renderMemoEditor(); renderMemoLists(); }); }
function memoSnapshot() { const item = activeMemo(); return {name: item?.name || '', phone: item?.phone || '', content: activePage(item)?.content || ''}; }
function updateHistoryButtons() { for (const [key, disabled] of [['undo', historyIndex <= 0], ['redo', historyIndex >= history.length - 1]]) { const b = $(`[data-tool=${key}]`); if (b) b.disabled = disabled; } }
function updateCount() { const editor = $('#memo-content'); if (editor) $('#memo-count').textContent = `${editor.value.length.toLocaleString()}자 · ${editor.value.split('\n').length}줄`; }
function updateMemo(record = true) {
  const item = activeMemo(); if (!item) return;
  item.name = $('#memo-name').value; item.phone = $('#memo-phone').value;
  const page = activePage(item); if (page && $('#memo-content')) page.content = $('#memo-content').value;
  item.content = item.pages[0]?.content || ''; item.updatedAt = memoNow();
  if (record) { history = history.slice(0, historyIndex + 1); history.push(memoSnapshot()); if (history.length > 200) history.shift(); historyIndex = history.length - 1; }
  persist(); updateCount(); updateHistoryButtons(); renderMemoLists(); countMatches();
}
function countMatches() {
  const editor = $('#memo-content'); if (!editor) return;
  const needle = $('#find-text').value.toLowerCase(), body = editor.value.toLowerCase(); let count = 0, index = 0;
  if (needle) while ((index = body.indexOf(needle, index)) >= 0) { count++; index += needle.length; }
  $('#find-result').textContent = needle ? `${count}개 일치 (대소문자 구분 없음)` : '';
}
function tool(action) {
  const editor = $('#memo-content'); if (!editor) return;
  if (action === 'save') { updateMemo(false); return; }
  if (action === 'focus-find') { if (!$('#find-panel').open) $('#find-panel').show(); const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd); if (selection && !selection.includes('\n')) $('#find-text').value = selection; $('#find-text').focus(); $('#find-text').select(); countMatches(); return; }
  if (action === 'close-find') { $('#find-panel').close(); editor.focus(); return; }
  if (action === 'undo' || action === 'redo') { const next = historyIndex + (action === 'undo' ? -1 : 1); if (next < 0 || next >= history.length) return; historyIndex = next; for (const key of ['name','phone','content']) $('#memo-' + key).value = history[next][key]; updateMemo(false); return; }
  if (action === 'find') { const text = $('#find-text').value; if (!text) return; let i = editor.value.toLowerCase().indexOf(text.toLowerCase(), editor.selectionEnd); if (i < 0) i = editor.value.toLowerCase().indexOf(text.toLowerCase()); if (i >= 0) { editor.focus(); editor.setSelectionRange(i, i + text.length); $('#find-result').textContent = `${i + 1}번째 글자부터 일치`; } else $('#find-result').textContent = '일치하는 내용이 없습니다.'; return; }
  if (action === 'replace') { const text = $('#find-text').value, replacement = $('#replace-text').value; if (!text) return; const body = editor.value, lower = body.toLowerCase(), search = text.toLowerCase(); let start = 0, index = 0, count = 0, output = ''; while ((index = lower.indexOf(search, start)) >= 0) { output += body.slice(start, index) + replacement; start = index + text.length; count++; } if (count) { editor.value = output + body.slice(start); updateMemo(); } $('#find-result').textContent = `${count}개 변경했습니다.`; }
}
$('#find-panel').onclick = e => { const b = e.target.closest('[data-tool]'); if (b) tool(b.dataset.tool); };
$('#find-text').oninput = countMatches;
$('#find-text').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); tool('find'); } };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideContextMenu();
  if (tab !== 'memos' || !$('#memo-content') || $('#rename-dialog')?.open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); tool('focus-find'); }
  else if (e.key === 'Escape' && $('#find-panel').open) { e.preventDefault(); tool('close-find'); }
});
function setupDivider() {
  const layout = $('.memo-layout'), divider = $('#memo-divider'); let ratio = Number(state.ui.memoSplit) || 60;
  const apply = value => { ratio = Math.max(25, Math.min(75, value)); layout.style.setProperty('--memo-split', ratio + '%'); divider.setAttribute('aria-valuenow', String(Math.round(ratio))); };
  const save = () => { state.ui.memoSplit = ratio; persist(); }; apply(ratio);
  divider.onpointerdown = e => { if (e.button !== 0 || matchMedia('(max-width:850px)').matches) return; e.preventDefault(); divider.setPointerCapture(e.pointerId); divider.classList.add('resizing'); document.body.classList.add('resizing-memo'); const rect = layout.getBoundingClientRect(); divider.onpointermove = event => apply((event.clientX - rect.left) / rect.width * 100); const finish = () => { divider.onpointermove = null; divider.onpointerup = null; divider.onpointercancel = null; divider.classList.remove('resizing'); document.body.classList.remove('resizing-memo'); save(); }; divider.onpointerup = finish; divider.onpointercancel = finish; };
  divider.onkeydown = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); apply(ratio + (e.key === 'ArrowLeft' ? -2 : 2)); save(); } };
}
function hideContextMenu() { $('#memo-context-menu')?.remove(); menuContext = null; }
function showContextMenu(e) {
  if (tab !== 'memos' || !e.target.closest('.memo-list,.page-tabs')) return;
  e.preventDefault(); hideContextMenu();
  const task = e.target.closest('[data-task-id]'), note = e.target.closest('[data-note-id]'), folder = e.target.closest('[data-folder-id]'), page = e.target.closest('[data-page-id],[data-delete-page]');
  const id = task?.dataset.taskId || note?.dataset.noteId;
  const kind = task ? 'task' : 'note', folderId = folder?.dataset.folderId || (note ? memoById(id)?.folderId : '') || '';
  menuContext = {id, kind, folderId, pageId: page?.dataset.pageId || page?.dataset.deletePage || ''};
  const b = (cmd, label) => `<button role="menuitem" data-context="${cmd}">${label}</button>`;
  let buttons = b('new-note','새 메모 추가') + b('new-folder','새 폴더 추가') + b('new-task','새 할 일 추가');
  if (id) buttons += '<hr>' + (task ? b('child','하위 할 일 추가') + b('outdent','최상위로 이동') : b('unfile','폴더 밖으로 이동')) + b('rename','이름 수정') + b('convert',task ? '일반 메모로 변경' : '할 일로 변경') + b('delete','삭제');
  if (folder) buttons += '<hr>' + b('rename-folder','폴더 이름 수정') + b('delete-folder','폴더 삭제 (내용 보존)');
  if (page) buttons = b('new-page','새 페이지 추가') + b('rename-page','페이지 이름 수정') + b('delete-page','페이지 삭제');
  document.body.insertAdjacentHTML('beforeend', `<div id="memo-context-menu" role="menu">${buttons}</div>`);
  const menu = $('#memo-context-menu'); menu.style.left = Math.min(e.clientX, innerWidth - menu.offsetWidth - 8) + 'px'; menu.style.top = Math.max(8, Math.min(e.clientY, innerHeight - menu.offsetHeight - 8)) + 'px'; menu.querySelector('button').focus();
  menu.onclick = event => { const button = event.target.closest('[data-context]'); if (!button) return; const c = menuContext; hideContextMenu(); const item = memoById(c.id); switch (button.dataset.context) {
    case 'new-note': createMemo('note', {folderId: c.folderId}); break;
    case 'new-task': createMemo('task'); break;
    case 'new-folder': createFolder(c.folderId); break;
    case 'child': createMemo('task', {parent: c.id}); break;
    case 'outdent': moveTask(c.id, ''); break;
    case 'unfile': moveNote(c.id, ''); break;
    case 'rename': renameMemo(c.id); break;
    case 'delete': deleteMemo(c.id); break;
    case 'convert': changeMemoKind(item, item.kind === 'task' ? 'note' : 'task'); persist(); renderMemos(); break;
    case 'rename-folder': renameFolder(c.folderId); break;
    case 'delete-folder': deleteFolder(c.folderId); break;
    case 'new-page': addPage(); break;
    case 'rename-page': renamePage(c.pageId); break;
    case 'delete-page': deletePage(c.pageId); break;
  } };
  menu.onkeydown = event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); } };
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#memo-context-menu')) hideContextMenu(); });
document.addEventListener('scroll', hideContextMenu, true);
$('#app').addEventListener('contextmenu', showContextMenu);
$('#app').addEventListener('click', e => {
  if (tab !== 'memos') return;
  const create = e.target.closest('[data-new-kind]'); if (create) { createMemo(create.dataset.newKind); return; }
  if (e.target.closest('[data-new-folder]')) { createFolder(); return; }
  const fold = e.target.closest('[data-fold-task]'); if (fold) { const m = memoById(fold.dataset.foldTask); m.collapsed = !m.collapsed; persist(); renderMemoLists(); return; }
  const folderFold = e.target.closest('[data-fold-folder]'); if (folderFold) { const f = folderById(folderFold.dataset.foldFolder); f.collapsed = !f.collapsed; persist(); renderMemoLists(); return; }
  const folder = e.target.closest('[data-folder-id]'); if (folder) { selectedFolder = folder.dataset.folderId; document.querySelectorAll('[data-folder-id]').forEach(row => row.classList.toggle('folder-selected', row === folder)); return; }
  const memo = e.target.closest('[data-memo-edit]'); if (memo) { selectMemo(memo.dataset.memoEdit); return; }
  if (e.target.closest('[data-add-page]')) { addPage(); return; }
  const delPage = e.target.closest('[data-delete-page]'); if (delPage) { deletePage(delPage.dataset.deletePage); return; }
  const page = e.target.closest('[data-page-id],[data-delete-page]'); if (page) { selectPage(page.dataset.pageId); return; }
  const t = e.target.closest('[data-tool]'); if (t) tool(t.dataset.tool);
});
$('#app').addEventListener('dblclick', e => {
  if (tab !== 'memos' || e.target.closest('input,textarea,.fold-task,.close-page')) return;
  const memo = e.target.closest('[data-drag-memo]'); if (memo) { renameMemo(memo.dataset.dragMemo); return; }
  const folder = e.target.closest('[data-folder-id]'); if (folder) { renameFolder(folder.dataset.folderId); return; }
  const page = e.target.closest('[data-page-id]'); if (page) renamePage(page.dataset.pageId);
});
$('#app').addEventListener('change', e => { if (e.target.matches('[data-memo-done]')) { memoById(e.target.dataset.memoDone).done = e.target.checked; persist(); renderMemoLists(); } });
function reorder(items, id, anchor, after) { const index = items.findIndex(x => x.id === id); if (index < 0) return; const [item] = items.splice(index, 1); const target = items.findIndex(x => x.id === anchor); items.splice(target < 0 ? items.length : target + (after ? 1 : 0), 0, item); }
function validParent(id, parent, lookup) { const seen = new Set([id]); let cursor = parent; while (cursor) { if (seen.has(cursor)) { $('#status').textContent = '자기 자신이나 하위 항목 아래로 이동할 수 없습니다.'; return false; } seen.add(cursor); const item = lookup(cursor); if (!item) return false; cursor = item.parent || ''; } return true; }
function moveTask(id, parent, anchor = '', after = false) {
  const item = memoById(id); if (!item || item.kind !== 'task' || id === anchor || !validParent(id, parent, x => state.memos.find(m => m.id === x && m.kind === 'task'))) return false;
  item.parent = parent; if (parent) memoById(parent).collapsed = false; if (anchor) reorder(state.memos, id, anchor, after); persist(); renderMemoLists(); return true;
}
function moveNote(id, folderId, anchor = '', after = false) {
  const item = memoById(id); if (!item || item.kind !== 'note' || (folderId && !folderById(folderId)) || id === anchor) return false;
  item.folderId = folderId; if (id === memoId) selectedFolder = folderId; if (folderId) folderById(folderId).collapsed = false; if (anchor) { reorder(state.memos, id, anchor, after); state.ui.noteSort = 'manual'; } persist(); renderMemoLists(); return true;
}
function moveFolder(id, parent, anchor = '', after = false) { const f = folderById(id); if (!f || id === anchor || !validParent(id, parent, folderById)) return false; f.parent = parent; if (parent) folderById(parent).collapsed = false; if (anchor) { reorder(state.folders, id, anchor, after); state.ui.noteSort = 'manual'; } persist(); renderMemoLists(); return true; }
function dropTarget(event) {
  if (!dragItem) return null;
  const task = event.target.closest('[data-task-id]'), note = event.target.closest('[data-note-id]'), folder = event.target.closest('[data-folder-id]');
  const zone = node => { const r = node.getBoundingClientRect(), fraction = (event.clientY - r.top) / r.height; return fraction < .25 ? 'before' : fraction > .75 ? 'after' : 'inside'; };
  if (dragItem.kind === 'task') {
    if (task) return {element: task, type:'task', id:task.dataset.taskId, zone:zone(task)};
    const root = event.target.closest('[data-task-root],[data-list-kind="task"]'); return root ? {element:root, type:'task', id:'', zone:'inside'} : null;
  }
  if (folder) return {element:folder, type:'folder', id:folder.dataset.folderId, zone:dragItem.type === 'folder' ? zone(folder) : 'inside'};
  if (note && dragItem.type === 'memo') return {element:note, type:'note', id:note.dataset.noteId, zone:zone(note) === 'after' ? 'after' : 'before'};
  const root = event.target.closest('[data-note-root],[data-list-kind="note"]'); return root ? {element:root, type:'folder', id:'', zone:'inside'} : null;
}
function clearDropMarks() { document.querySelectorAll('.drop-target,.drop-before,.drop-after').forEach(x => x.classList.remove('drop-target','drop-before','drop-after')); }
$('#app').addEventListener('dragstart', e => {
  const memo = e.target.closest('[data-drag-memo]'), folder = e.target.closest('[data-drag-folder]'); if (!memo && !folder) return;
  dragItem = memo ? {type:'memo', id:memo.dataset.dragMemo, kind:memoById(memo.dataset.dragMemo).kind} : {type:'folder', id:folder.dataset.dragFolder, kind:'note'};
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragItem.id); (memo || folder).classList.add('dragging'); hideContextMenu();
});
$('#app').addEventListener('dragover', e => { const target = dropTarget(e); if (!target) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clearDropMarks(); target.element.classList.add(target.zone === 'inside' ? 'drop-target' : 'drop-' + target.zone); });
$('#app').addEventListener('dragleave', e => { const target = dropTarget(e); if (target && !target.element.contains(e.relatedTarget)) clearDropMarks(); });
$('#app').addEventListener('drop', e => {
  const target = dropTarget(e); if (!target) return; e.preventDefault(); const dragged = dragItem; dragItem = null; clearDropMarks();
  if (dragged.kind === 'task') { const parent = !target.id || target.zone === 'inside' ? target.id : memoById(target.id).parent || ''; moveTask(dragged.id, parent, target.zone === 'inside' ? '' : target.id, target.zone === 'after'); }
  else if (dragged.type === 'memo') { const folder = target.type === 'note' ? memoById(target.id).folderId || '' : target.id; moveNote(dragged.id, folder, target.type === 'note' ? target.id : '', target.zone === 'after'); }
  else { const parent = !target.id || target.zone === 'inside' ? target.id : folderById(target.id).parent || ''; moveFolder(dragged.id, parent, target.zone === 'inside' ? '' : target.id, target.zone === 'after'); }
});
$('#app').addEventListener('dragend', () => { dragItem = null; clearDropMarks(); document.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); });
