const {chromium} = require('playwright-core');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1100}}), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:8000');
    const legacyText = 'before SELECT after\n둘째 줄\n';
    await page.evaluate(text => localStorage.setItem('skycrm-web-preview-v1',JSON.stringify({calls:[],clients:[],memos:[
      {id:'parent',kind:'task',name:'상위',content:'상위 내용',done:false,parent:''},
      {id:'child',kind:'task',name:'하위',content:'하위 내용',done:false,parent:'parent'},
      {id:'grandchild',kind:'task',name:'손자',content:'손자 내용',done:false,parent:'child'},
      {id:'independent',kind:'task',name:'별도',content:'별도 내용',done:false,parent:''},
      {id:'rich-note',kind:'note',name:'서식 검증',content:text}
    ]})),legacyText);
    await page.reload(); await page.locator('[data-tab=memos]').click();
    const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('skycrm-web-preview-v1')));
    await page.locator('[data-fold-task=parent]').click();
    await page.locator('[data-task-id=parent] [data-memo-done]').check();
    for (const id of ['parent','child','grandchild']) assert.equal((await state()).memos.find(m=>m.id===id).done,true);
    assert.equal((await state()).memos.find(m=>m.id==='independent').done,false);
    await page.locator('#task-filter').selectOption('pending'); assert.deepEqual(await page.locator('[data-task-id]').evaluateAll(rows=>rows.map(r=>r.dataset.taskId)),['independent']);
    await page.locator('#task-filter').selectOption('done'); assert.equal(await page.locator('[data-task-id]').count(),3); assert.equal(await page.locator('[data-task-id] input:not(:checked)').count(),0);
    await page.locator('[data-task-id=child] [data-memo-done]').click(); assert.equal((await state()).memos.find(m=>m.id==='grandchild').done,false); assert.equal(await page.locator('[data-task-id]').count(),1);
    await page.locator('#task-filter').selectOption('pending'); assert.equal(await page.locator('[data-task-id]').count(),3); assert.equal(await page.locator('[data-task-id=parent]').count(),0);
    await page.locator('#task-filter').selectOption('done'); await page.locator('[data-task-id=parent] [data-memo-done]').click(); assert.equal(await page.locator('[data-task-id]').count(),0);
    await page.reload(); await page.locator('[data-tab=memos]').click(); assert.equal(await page.locator('#task-filter').inputValue(),'done'); await page.locator('#task-filter').selectOption('all');
    await page.locator('[data-memo-edit=rich-note]').click(); assert.equal(await page.evaluate(()=>readRichText()),legacyText);
    assert.equal(await page.locator('.memo-editor #find-text').count(),0);
    // Select only SELECT by dragging in the rendered editor, then use real toolbar controls.
    const bounds = await page.evaluate(() => {
      const root=document.querySelector('#memo-content'),walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
      while(node=walker.nextNode()){if(node.textContent.startsWith('before SELECT')){const a=document.createRange(),b=document.createRange();a.setStart(node,7);a.setEnd(node,8);b.setStart(node,12);b.setEnd(node,13);const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return {start:{x:x.left+.2,y:x.y+x.height/2},end:{x:y.right-.2,y:y.y+y.height/2}};}}
    });
    await page.mouse.move(bounds.start.x,bounds.start.y); await page.mouse.down(); await page.mouse.move(bounds.end.x,bounds.end.y,{steps:12}); await page.mouse.up();
    await page.waitForFunction(()=>richSelection?.index===7&&richSelection.length===6,{},{timeout:5000});
    await page.locator('#text-bold').click(); assert.equal(await page.evaluate(()=>richEditor.getFormat(7,6).weight),'700');
    await page.locator('#text-weight').selectOption('900'); await page.locator('#text-size').selectOption('28px');
    await page.locator('#text-color').evaluate(el=>{el.value='#ff0000';el.dispatchEvent(new Event('input',{bubbles:true}))});
    await page.locator('#text-background').evaluate(el=>{el.value='#00ff00';el.dispatchEvent(new Event('input',{bubbles:true}))});
    const slider=await page.locator('#background-opacity').boundingBox(); await page.mouse.click(slider.x+slider.width/2,slider.y+slider.height/2);
    let format = await page.evaluate(()=>richEditor.getFormat(7,6)); assert.equal(format.weight,'900'); assert.equal(format.size,'28px'); assert.equal(format.color,'#ff0000'); assert.match(format.background,/rgba\(0, 255, 0, 0\.5\)/);
    const plain = await page.evaluate(()=>richEditor.getFormat(0,6)); assert.ok(!plain.weight&&!plain.size&&!plain.color&&!plain.background); const suffix=await page.evaluate(()=>richEditor.getFormat(14,5)); assert.ok(!suffix.weight&&!suffix.size&&!suffix.color&&!suffix.background);
    assert.equal(await page.evaluate(()=>readRichText()),legacyText);
    // Saved formatting survives page changes and reload without changing neighboring text.
    await page.locator('[data-add-page]').click(); await page.locator('#memo-content').fill('별도 페이지'); const second=(await state()).memos.find(m=>m.id==='rich-note').activePageId,first=(await state()).memos.find(m=>m.id==='rich-note').pages[0].id;
    await page.locator(`[data-page-id="${first}"]`).click(); assert.equal(await page.evaluate(()=>richEditor.getFormat(7,6).size),'28px'); await page.reload(); await page.locator('[data-tab=memos]').click(); await page.locator('[data-memo-edit=rich-note]').click();
    assert.equal(await page.evaluate(()=>readRichText()),legacyText); assert.equal(await page.evaluate(()=>richEditor.getFormat(7,6).weight),'900'); assert.match(await page.evaluate(()=>richEditor.getFormat(7,6).background),/0\.5\)/);
    // Replacing selected styled text retains formatting and can be undone once.
    await page.locator('#memo-content').focus(); await page.keyboard.press('Control+f'); await page.locator('#find-text').fill('SELECT'); await page.locator('#replace-text').fill('CHANGED'); await page.locator('[data-tool=replace]').click(); assert.equal(await page.evaluate(()=>readRichText()),legacyText.replace('SELECT','CHANGED')); assert.equal(await page.evaluate(()=>richEditor.getFormat(7,7).weight),'900'); await page.keyboard.press('Escape'); await page.locator('#memo-content').focus(); await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(()=>readRichText()),legacyText); assert.equal(await page.evaluate(()=>richEditor.getFormat(7,6).weight),'900');
    await page.evaluate(()=>richEditor.setSelection(7,6,'user')); await page.locator('#clear-text-background').click(); assert.ok(!(await page.evaluate(()=>richEditor.getFormat(7,6))).background);
    await page.locator(`[data-page-id="${second}"]`).click(); assert.equal(await page.evaluate(()=>readRichText()),'별도 페이지'); assert.ok(!(await page.evaluate(()=>richEditor.getFormat(0,4))).weight);
    // No selection must never accidentally restyle the entire page.
    await page.evaluate(()=>richEditor.setSelection(0,0,'user')); await page.locator('#text-weight').selectOption('700'); assert.ok(!(await page.evaluate(()=>richEditor.getFormat(0,4))).weight); assert.match(await page.locator('#status').textContent(),/먼저/);
    // Literal HTML in legacy content is kept as text, never interpreted as markup.
    await page.locator('#memo-content').fill('<img src=x onerror=alert(1)>'); assert.equal(await page.locator('#memo-content img').count(),0); assert.equal((await state()).memos.find(m=>m.id==='rich-note').pages[1].content,'<img src=x onerror=alert(1)>');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      const panel=await page.locator('#memo-editor').boundingBox(),editor=await page.locator('#memo-rich').boundingBox(),footer=await page.locator('footer').boundingBox();
      assert.ok(editor.y+editor.height<=panel.y+panel.height,'rich editor stays inside memo panel');
      assert.ok(editor.y+editor.height<=footer.y,'rich editor does not overlap footer');
    }
    assert.deepEqual(errors,[]);
    console.log('PASS Chromium: subtree completion/uncompletion, strict persisted filters, literal legacy text/newline preservation, mouse-selected weight/size/color/RGBA background, selection-only formatting, clear background, formatted page reload, rich replace/undo and plain-text safety');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
