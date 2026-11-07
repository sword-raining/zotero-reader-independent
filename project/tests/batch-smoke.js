async function runBatchSmoke(app,scope,main,check,helpers){
  const {createPDF,until,sleep}=helpers,auto=scope.ReaderAutomation,batch=scope.ReaderBatch;
  const lib=Zotero.Libraries.userLibraryID,root=PathUtils.profileDir;
  const assert=(v,m)=>{if(!v)throw new Error(m);};
  const parent=new Zotero.Item('journalArticle');parent.libraryID=lib;parent.setField('title','Synthetic batch selection');await parent.saveTx({skipSelect:true});
  const aPath=PathUtils.join(root,'batch-a.pdf'),bPath=PathUtils.join(root,'batch-b.pdf');
  await IOUtils.writeUTF8(aPath,'%PDF-1.4\nSynthetic batch A');await IOUtils.writeUTF8(bPath,'%PDF-1.4\nSynthetic batch B');
  const a=await createPDF('Batch A',aPath,parent),b=await createPDF('Batch B',bPath,parent),standalone=await createPDF('Batch standalone');
  const nonPDF=new Zotero.Item('journalArticle');nonPDF.libraryID=lib;nonPDF.setField('title','No PDF fixture');await nonPDF.saveTx({skipSelect:true});
  const entry=att=>({libraryID:att.libraryID,key:att.key,display:att.getField('title')});
  let selected;
  await auto.setEnabled(false);auto.state.paused=true;
  await check('batch selection expands parents and deduplicates mixed parent/PDF selections',async()=>{
    selected=await batch.collectItems([parent,a,standalone,nonPDF]);
    assert(selected.entries.length===2,'mixed selection not grouped by paper');
    assert(selected.ignored===1,'non-PDF selection not reported');
    assert(selected.entries.some(e=>e.pdfs.some(p=>p.key===b.key)&&!e.mainKey),'second main candidate missing or chosen arbitrarily');
  });
  await check('batch dialog supports exclusion and starts selected PDFs without enabling automation',async()=>{
    const get=main.ZoteroPane.getSelectedItems;main.ZoteroPane.getSelectedItems=()=>[parent,a,standalone,nonPDF];
    try{await batch.open(main);}finally{main.ZoteroPane.getSelectedItems=get;}
    await until(()=>batch.window?.document.getElementById('zrb-start'));
    assert(batch.window.document.getElementById('zrb-list').querySelectorAll('.zr-paper-check').length===2,'batch list incorrect');
    const menu=batch.window.document.getElementById('zrb-template');menu.open=true;await until(()=>menu.menupopup.state==='open');menu.open=false;
    menu.getItemAtIndex(1).doCommand();assert(batch.templateID==='general','batch template menu command did not apply');
    batch.window.document.querySelector(`input[type="radio"][value="${a.key}"]`).click();
    const result=await batch.start();assert(result.added===2,'excluded attachment was enqueued');
    assert(!auto.state.jobs[lib+':'+b.key],'excluded PDF has a job');
    auto.state.paused=false;auto.schedule(0);
    await until(()=>result.members.every(m=>['done','failed'].includes(auto.state.jobs[m.id].state)));
    assert(result.members.every(m=>auto.state.jobs[m.id].state==='done'),'batch processing failed');
    assert(result.members.every(m=>auto.state.jobs[m.id].templateID==='general'),'common template not applied');
    assert(!auto.enabled(),'batch enabled automatic intake');
    // The queue status changes before its async persistence and view refresh finish.
    await until(()=>batch.window.document.getElementById('zrb-progress').textContent.includes('完成 2'));
    batch.window.close();
  });
  await check('batch skips processed unchanged files and reuses queued jobs',async()=>{
    auto.state.paused=true;const attempt=auto.state.jobs[lib+':'+a.key].attempt;
    const result=await auto.enqueueBatch([entry(a),entry(b),entry(a)],'ecology',{skipProcessed:true});
    assert(result.added===1&&result.skipped===1,'processed file not skipped or duplicate selected');
    assert(auto.state.jobs[lib+':'+a.key].attempt===attempt,'processed PDF rerun unexpectedly');
    const again=await auto.enqueueBatch([entry(b)],'general',{skipProcessed:false});
    assert(again.existing===1&&again.added===0,'queued PDF duplicated');
    assert(auto.state.jobs[lib+':'+b.key].templateID==='ecology','existing template changed silently');
    auto.state.paused=false;auto.schedule(0);await until(()=>auto.state.jobs[lib+':'+b.key].state==='done');
  });
  await check('batch detects a changed PDF instead of skipping its old result',async()=>{
    const previous=auto.state.jobs[lib+':'+a.key].workflowPath;
    await IOUtils.writeUTF8(aPath,'%PDF-1.4\nSynthetic batch A changed');
    const result=await auto.enqueueBatch([entry(a)],'ecology',{skipProcessed:true});
    assert(result.added===1&&result.skipped===0,'changed PDF skipped');
    await until(()=>auto.state.jobs[lib+':'+a.key].state==='done');
    assert(auto.state.jobs[lib+':'+a.key].workflowPath!==previous,'old reading reused for changed PDF');
  });
  await check('one rejected selection does not prevent valid PDFs from entering a batch',async()=>{
    const fresh=await createPDF('Batch valid alongside rejection',undefined,parent),destination=auto.notes.destination;
    auto.state.paused=true;
    auto.notes.destination=async function(att){if(att?.key===b.key)throw scope.NoteCore.error('NOTE_READONLY','Simulated readonly target');return destination.call(this,att);};
    let result;try{result=await auto.enqueueBatch([entry(b),entry(fresh)],'ecology',{skipProcessed:false});}finally{auto.notes.destination=destination;}
    assert(result.added===1&&result.rejected.length===1,'partial eligibility not handled');
    auto.state.paused=false;auto.schedule(0);await until(()=>auto.state.jobs[lib+':'+fresh.key].state==='done');
  });
  await check('a failed batch job does not block subsequent PDFs',async()=>{
    const bad=await createPDF('Batch failure fixture',undefined,parent),good=await createPDF('Batch continues after failure',undefined,parent);
    const parse=app.parseAttachment;
    app.parseAttachment=async function(att,...args){if(att.key===bad.key)throw scope.NoteCore.error('BATCH_TEST_FAILURE','Synthetic parsing failure');return parse.call(this,att,...args);};
    try{
      await auto.enqueueBatch([entry(bad),entry(good)],'ecology',{skipProcessed:false});auto.schedule(0);
      await until(()=>auto.state.jobs[lib+':'+good.key].state==='done');
      assert(auto.state.jobs[lib+':'+bad.key].state==='failed','first failure not recorded');
    }finally{app.parseAttachment=parse;}
  });
  await check('stop batch cancels its active and pending jobs without cancelling unrelated work',async()=>{
    const slow=await createPDF('Batch stop active',PathUtils.join(root,'slow.pdf'),parent),pending=await createPDF('Batch stop pending',undefined,parent),other=await createPDF('Unrelated manual task',undefined,parent);
    auto.state.paused=true;
    const result=await auto.enqueueBatch([entry(slow),entry(pending)],'ecology',{skipProcessed:false});
    const unrelated=await auto.enqueueManual(other,'ecology');
    auto.state.paused=false;auto.schedule(0);
    await until(()=>auto.activeJob?.key===slow.key&&auto.activeJob.phase==='reading');
    await auto.stopBatch(result.members);
    await until(()=>unrelated.state==='done');
    assert(auto.state.jobs[lib+':'+slow.key].state==='cancelled','active batch task not stopped');
    assert(auto.state.jobs[lib+':'+pending.key].state==='cancelled','queued batch task not stopped');
    assert(!unrelated.cancelRequested,'unrelated task was cancelled');
  });
  await check('batch can explicitly rerun processed PDFs when skip is disabled',async()=>{
    const attempt=auto.state.jobs[lib+':'+b.key].attempt;
    const result=await auto.enqueueBatch([entry(b)],'general',{skipProcessed:false});
    assert(result.added===1&&auto.state.jobs[lib+':'+b.key].attempt===attempt+1,'explicit rerun ignored');
    await until(()=>auto.state.jobs[lib+':'+b.key].state==='done');
  });
}
