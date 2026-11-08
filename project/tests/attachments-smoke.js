async function runAttachmentsSmoke(app,scope,main,check,{createPDF,until,sleep}){
  const auto=scope.ReaderAutomation,batch=scope.ReaderBatch,lib=Zotero.Libraries.userLibraryID,root=PathUtils.profileDir;
  const assert=(v,m)=>{if(!v)throw new Error(m);};
  const parent=new Zotero.Item('journalArticle');parent.libraryID=lib;parent.setField('title','Paper with main, duplicates and supplements');await parent.saveTx({skipSelect:true});
  const mainPath=PathUtils.join(root,'main-article.pdf'),suppPath=PathUtils.join(root,'supporting-info.pdf'),missingPath=PathUtils.join(root,'supplement-missing.pdf');
  await auto.setEnabled(false);auto.state.paused=true;
  await IOUtils.writeUTF8(mainPath,'%PDF-1.4 main-article');await IOUtils.writeUTF8(suppPath,'%PDF-1.4 supporting-info');
  const article=await createPDF('Full text',mainPath,parent),duplicate=await createPDF('Another download',mainPath,parent),supp=await createPDF('Supporting Information',suppPath,parent),missing=await createPDF('Supplement missing locally',missingPath,parent);
  const jobID=lib+':'+article.key;
  const open=async()=>{const get=main.ZoteroPane.getSelectedItems;main.ZoteroPane.getSelectedItems=()=>[parent,article];try{await scope.ReaderCodex.openSelected(main);}finally{main.ZoteroPane.getSelectedItems=get;}await until(()=>batch.window?.document.getElementById('zrb-start'));};
  let firstWorkflow,combinedWorkflow;
  await check('paper selector excludes byte duplicates and defaults supplements including cloud files to off',async()=>{
    await open();const group=batch.entries[0],doc=batch.window.document;
    assert(batch.entries.length===1&&group.pdfs.length===4&&group.duplicateCount===1,'group or duplicate mismatch');
    assert(group.mainKey===article.key&&group.supplementKeys.length===0,'supplements were selected by default');
    assert(doc.querySelector(`input[type="radio"][value="${duplicate.key}"]`).disabled,'duplicate was selectable as another main');
    const rect=doc.querySelector(`input[type="radio"][value="${article.key}"]`).getBoundingClientRect();
    assert(rect.width>0&&rect.width<30&&rect.height<30,'radio inherited full-width text-input layout');
    assert(!doc.querySelector(`.zr-supplement-check[value="${supp.key}"]`).checked,'supplement was checked');
    assert(!doc.querySelector(`.zr-supplement-check[value="${missing.key}"]`).checked,'cloud-only supplement was included');
    const result=await batch.start();assert(result.added===1,'paper yielded multiple jobs');
    auto.state.paused=false;auto.schedule(0);await until(()=>auto.state.jobs[jobID]?.state==='done');
    firstWorkflow=auto.state.jobs[jobID].workflowPath;const workflow=await app.readJSON(firstWorkflow);
    assert(workflow.inputSources.length===1&&workflow.inputSources[0].key===article.key,'unselected attachments were parsed/read');
    assert(!auto.state.jobs[lib+':'+duplicate.key]&&!auto.state.jobs[lib+':'+supp.key],'unselected file was independently queued');
    batch.window.close();
  });
  await check('explicit supplement checkbox creates one combined reading with distinct source IDs and links',async()=>{
    auto.state.paused=true;await open();
    batch.window.document.querySelector(`.zr-supplement-check[value="${supp.key}"]`).click();
    assert(batch.entries[0].supplementKeys.includes(supp.key),'supplement checkbox did not persist');
    const result=await batch.start();assert(result.added===1&&result.skipped===0,'changed input selection reused main-only result');
    auto.state.paused=false;auto.schedule(0);await until(()=>auto.state.jobs[jobID]?.state==='done');
    combinedWorkflow=auto.state.jobs[jobID].workflowPath;const workflow=await app.readJSON(combinedWorkflow),dir=PathUtils.parent(combinedWorkflow);
    const index=await app.readJSON(PathUtils.join(dir,'source-index.json')),receipt=await app.readJSON(PathUtils.join(dir,'source.json'));
    assert(workflow.inputSources.length===2&&index.sources.length===2,'both selected files were not supplied');
    assert(index.paragraphs.some(p=>p.id.startsWith('M-'))&&index.paragraphs.some(p=>p.id.startsWith('S1-')),'file evidence IDs overlap');
    assert(receipt.attachments.length===2&&receipt.attachments[1].role==='supplement','Wiki receipt lost supplement');
    const md=await IOUtils.readUTF8(PathUtils.join(dir,workflow.resultFile)),note=await Zotero.Items.getAsync(auto.state.jobs[jobID].notes.reading.id);
    assert(md.includes('补充材料 1')&&md.includes('M-P0001'),'Markdown lacks source labels');
    assert(note.getNote().includes(supp.key)&&note.getNote().includes('补充材料 1'),'Zotero note lacks supplement link');
    assert(Object.keys(workflow.zoteroNotes).length===1,'separate supplement note generated');
    batch.window.close();
  });
  await check('selected supplemental changes invalidate skip and prevent importing stale checked content',async()=>{
    auto.state.paused=true;
    const entry={libraryID:lib,key:article.key,groupID:lib+':'+parent.key,inputSelection:{mainKey:article.key,supplementKeys:[supp.key]}};
    const before=await auto.enqueueBatch([entry],'ecology');assert(before.skipped===1,'unchanged combined result was not skipped');
    await IOUtils.writeUTF8(suppPath,'%PDF-1.4 supporting-info changed');
    let error;try{await scope.ReaderNotes.save(combinedWorkflow,article);}catch(e){error=e;}
    assert(error?.code==='NOTE_CHANGED','changed supplement did not block stale import');
    const after=await auto.enqueueBatch([entry],'ecology');assert(after.added===1&&after.skipped===0,'changed supplement was skipped');await auto.stopBatch(after.members);
    const wait=await auto.enqueueBatch([{...entry,inputSelection:{mainKey:article.key,supplementKeys:[missing.key]}}],'ecology');
    auto.state.paused=false;auto.schedule(0);await sleep(300);
    assert(auto.state.jobs[jobID].state==='waiting_file','selected cloud-only supplement was silently omitted');await auto.stopBatch(wait.members);
  });
  await check('automatic intake skips supplemental/duplicate files and prefers the published main version',async()=>{
    auto.state.paused=true;await auto.setEnabled(true);
    const copy=await createPDF('Duplicate download after auto enabled',mainPath,parent),supplement=await createPDF('Supplementary material after auto enabled',suppPath,parent);
    const ambiguousParent=new Zotero.Item('journalArticle');ambiguousParent.libraryID=lib;ambiguousParent.setField('title','Ambiguous versions');await ambiguousParent.saveTx({skipSelect:true});
    const alternate=PathUtils.join(root,'accepted-version.pdf');await IOUtils.writeUTF8(alternate,'%PDF-1.4 alternate version');
    const a=await createPDF('Published version',mainPath,ambiguousParent),b=await createPDF('Accepted manuscript',alternate,ambiguousParent);
    await until(()=>auto.state.jobs[lib+':'+copy.key]&&auto.state.jobs[lib+':'+b.key]);
    const execute=auto.execute;auto.execute=async function(job,...args){if(job.key===a.key||job.key===b.key)return {status:'awaiting_import'};return execute.call(this,job,...args);};
    auto.state.paused=false;auto.schedule(0);
    await until(()=>auto.state.jobs[lib+':'+copy.key].state==='cancelled'&&auto.state.jobs[lib+':'+a.key].state==='awaiting_import'&&auto.state.jobs[lib+':'+b.key].state==='cancelled');
    assert(!auto.state.jobs[lib+':'+supplement.key],'supplement auto-enqueued');
    assert(!auto.state.jobs[lib+':'+a.key].workflowPath&&!auto.state.jobs[lib+':'+b.key].workflowPath,'ambiguous main was sent to a model');
    const group=(await batch.collectItems([ambiguousParent])).entries[0];assert(group.mainKey===a.key,'published version not selected');auto.execute=execute;
    await auto.setEnabled(false);
  });
  await auto.setEnabled(false);auto.state.paused=false;
}
