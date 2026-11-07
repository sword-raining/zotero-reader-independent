async function runStage4Smoke(app,scope,main,check){
  const auto=scope.ReaderAutomation,notes=scope.ReaderNotes,codex=scope.ReaderCodex;
  const root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
  const previousRequest=app.request,originalRun=codex.run;
  const sleep=ms=>Zotero.Promise.delay(ms);
  const assert=(v,m)=>{if(!v)throw new Error(m);};
  const until=async(fn,ms=18000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(50);}throw new Error('condition did not settle');};
  const createPDF=async(title,file=PathUtils.join(root,'synthetic.pdf'),parent=null,synced=false)=>{
    const att=new Zotero.Item('attachment');att.libraryID=lib;if(parent)att.parentID=parent.id;
    att.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;att.attachmentPath=file;
    att.attachmentContentType='application/pdf';att.setField('title',title);att.synced=synced;
    await att.saveTx({skipSelect:true,skipSyncedUpdate:synced});return att;
  };
  const parent=new Zotero.Item('journalArticle');parent.libraryID=lib;parent.setField('title','Synthetic automatic reading tests');
  parent.setCreators([{firstName:'Ada',lastName:'Example',creatorTypeID:Zotero.CreatorTypes.getID('author')},{firstName:'Lei',lastName:'Example',creatorTypeID:Zotero.CreatorTypes.getID('author')}]);
  for(const [key,value]of Object.entries({publicationTitle:'Synthetic Journal',date:'2026/2',DOI:'10.0000/synthetic',volume:'1',issue:'2',pages:'e-test',libraryCatalog:'7.25 (Q2)',callNumber:'2'}))parent.setField(key,value);
  await parent.saveTx({skipSelect:true});
  const old=await createPDF('Added before enabling');
  const batch=new Map();let number=0,modelCalls=0,concurrent=0,maxConcurrent=0;
  app.request=async(url,opts)=>{
    if(url.endsWith('/file-urls/batch')){
      const f=JSON.parse(opts.body).files[0],id='queue-batch-'+(++number);batch.set(id,f);
      return {status:200,data:{code:0,data:{batch_id:id,file_urls:['https://example.com/upload/'+id]}}};
    }
    if(opts.method==='PUT')return {status:200};
    if(url.includes('/extract-results/batch/')){
      const id=url.split('/').pop(),f=batch.get(id);
      return {status:200,data:{code:0,data:{extract_result:[{data_id:f.data_id,file_name:f.name,state:'done',full_zip_url:'https://example.com/result/'+id}]}}};
    }
    const f=batch.get(url.split('/').pop());
    const fixture=f?.name==='verification-failure.pdf'?'fixture-verification-error.zip':f?.name==='slow.pdf'?'fixture-slow.zip':'fixture.zip';
    return {status:200,data:await IOUtils.read(PathUtils.join(root,fixture))};
  };
  codex.run=async function(executable,args,extra){
    const model=args[0]==='exec'&&!args.includes('--help');if(model){modelCalls++;concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);}
    try{return await originalRun.call(this,executable,args,extra);}finally{if(model)concurrent--;}
  };
  auto.settleMs=0;auto.pollMs=50;auto.state.paused=true;
  await app.saveKey('isolated-test-key-not-a-real-token');
  let first,second,completed;
  try{
    await check('automatic reading is off by default and enabling does not scan old PDFs',async()=>{
      assert(!auto.enabled(),'automatic reading enabled on installation');await sleep(80);
      assert(!auto.state.jobs[lib+':'+old.key],'old item captured before enable');
      await auto.setEnabled(true);await sleep(80);
      assert(!auto.state.jobs[lib+':'+old.key],'enable scanned existing library');
    });
    await check('actual Zotero add events queue PDFs once and ignore notes, sync and modifications',async()=>{
      first=await createPDF('Automatic PDF A',undefined,parent);second=await createPDF('Automatic PDF B');
      const synced=await createPDF('Synced PDF ignored',undefined,parent,true);
      const n=new Zotero.Item('note');n.libraryID=lib;n.parentID=parent.id;n.setNote('<p>ordinary note</p>');await n.saveTx({skipSelect:true});
      old.setField('title','Old PDF modified');await old.saveTx({skipSelect:true});
      await until(()=>auto.state.jobs[lib+':'+first.key]&&auto.state.jobs[lib+':'+second.key]);
      auto.notify('add','item',[first.id],{});await sleep(80);
      assert(!auto.state.jobs[lib+':'+old.key]&&!auto.state.jobs[lib+':'+synced.key],'old or synced item queued');
      assert(Object.keys(auto.state.jobs).length===2,'duplicate or non-PDF event enqueued');
    });
    await check('automatic queue runs serially and creates only one reading note per PDF',async()=>{
      auto.state.paused=false;await auto.persist();auto.schedule(0);
      await until(()=>['done','needs_review'].includes(auto.state.jobs[lib+':'+second.key]?.state));
      const a=auto.state.jobs[lib+':'+first.key],b=auto.state.jobs[lib+':'+second.key];
      assert(a.state==='done'&&b.state==='done','automatic reading failed: '+a.message+' / '+b.message);
      assert(maxConcurrent===1,'model calls ran concurrently');assert(modelCalls===4,'automatic pipeline did not use two model calls per PDF');
      const note=await Zotero.Items.getAsync(a.notes.reading.id);
      assert(note.parentID===parent.id,'notes attached to wrong parent');
      assert(note.getNote().includes('研究背景')&&!a.notes.verification,'note content incomplete');
      assert(note.getNote().includes('文献信息')&&note.getNote().includes('Ada Example')&&note.getNote().includes('Fictional Soil Institute'),'bibliography or checked affiliation missing');
      assert(note.getNote().includes('7.25')&&note.getNote().includes('Q2')&&note.getNote().includes('2区')&&note.getNote().includes('条目未记录'),'Zotero One fields or unknown metric year missing');
      const metadata=await app.readJSON(a.workflowPath),md=await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(a.workflowPath),metadata.resultFile));
      assert(metadata.bibliography.metrics.impactFactor==='7.25'&&md.includes('作者：Ada Example')&&md.includes('影响因子：7.25'),'Markdown and workflow do not preserve the same bibliography');
      assert(note.getRelationsByPredicate('dc:relation').every(u=>u.startsWith('http://zotero.org/')),'invalid sync relation');
      assert(Object.keys(auto.state.jobs).length===2,'generated notes caused recursive processing');
      completed=a;
    });
    await check('same reading deduplicates notes and preserves manual edits',async()=>{
      const note=await Zotero.Items.getAsync(completed.notes.reading.id);
      note.setNote(note.getNote()+'<p>MY_MANUAL_EDIT</p>');await note.saveTx({skipSelect:true});
      const r=await notes.save(completed.workflowPath,first);
      assert(r.notes.reading.id===note.id&&Object.keys(r.notes).length===1,'duplicate notes created');
      assert(note.getNote().includes('MY_MANUAL_EDIT'),'manual edit overwritten');
      const meta=await app.readJSON(completed.workflowPath);delete meta.zoteroNotes;await app.writeJSON(completed.workflowPath,meta);
      const recovered=await notes.save(completed.workflowPath,first);
      assert(recovered.notes.reading.id===note.id,'failed to recover notes after missing local map');
    });
    await check('missing PDF waits until a local file is available',async()=>{
      const path=PathUtils.join(root,'arriving-later.pdf');await IOUtils.remove(path,{ignoreAbsent:true});
      const att=await createPDF('Waiting for file',path);await until(()=>auto.state.jobs[lib+':'+att.key]);
      await sleep(100);assert(auto.state.jobs[lib+':'+att.key].state==='waiting_file','missing file was processed');
      await IOUtils.writeUTF8(path,'%PDF-1.4\nSynthetic delayed file\n%%EOF');auto.schedule(0);
      await until(()=>['done','failed'].includes(auto.state.jobs[lib+':'+att.key].state));
      assert(auto.state.jobs[lib+':'+att.key].state==='done','delayed PDF did not complete');
    });
    await check('verification failure keeps the local draft without creating a Zotero note',async()=>{
      const path=PathUtils.join(root,'verification-failure.pdf');await IOUtils.writeUTF8(path,'%PDF-1.4\nSynthetic failure fixture');
      const att=await createPDF('Verification failure draft',path);await until(()=>auto.state.jobs[lib+':'+att.key]?.state==='verification_incomplete');
      const job=auto.state.jobs[lib+':'+att.key];
      assert(!job.notes,'unverified result was imported');
      assert(await IOUtils.exists(PathUtils.join(PathUtils.parent(job.workflowPath),'draft.md')),'draft was not retained');
      let caught;try{await notes.save(job.workflowPath,att);}catch(e){caught=e;}
      assert(caught?.code==='NOTE_UNRESOLVED','unmodified unresolved draft was manually imported');
    });
    await check('turning automation off cancels queued and active automatic tasks',async()=>{
      auto.state.paused=true;
      const queued=await createPDF('Cancelled pending PDF');await until(()=>auto.state.jobs[lib+':'+queued.key]);
      await auto.setEnabled(false);assert(auto.state.jobs[lib+':'+queued.key].state==='cancelled','queued automatic task not cancelled');
      await auto.setEnabled(true);auto.state.paused=false;
      const slowPath=PathUtils.join(root,'slow.pdf');await IOUtils.writeUTF8(slowPath,'%PDF-1.4\nSynthetic slow fixture');
      const slow=await createPDF('Cancelled active PDF',slowPath);auto.schedule(0);
      await until(()=>auto.activeJob?.key===slow.key&&auto.activeJob.phase==='reading');
      await auto.setEnabled(false);
      await until(()=>auto.state.jobs[lib+':'+slow.key].state==='cancelled');
      assert(!auto.state.jobs[lib+':'+slow.key].notes,'cancelled task generated notes');
    });
    await check('manual full workflow still works with automation disabled',async()=>{
      await auto.setEnabled(false);auto.state.paused=false;
      const job=await auto.enqueueManual(old,'general');auto.schedule(0);
      await until(()=>['done','failed'].includes(job.state));assert(job.state==='done','manual workflow failed: '+job.message);
      assert(!auto.enabled(),'manual processing enabled automation');
      assert(job.templateID==='general'&&job.notes.reading.id,'manual template or notes missing');
    });
    await check('standalone PDF gets linked standalone notes without fabricated parent metadata',async()=>{
      const att=await createPDF('Standalone synthetic PDF');
      const job=await auto.enqueueManual(att,'ecology');auto.schedule(0);await until(()=>['done','failed'].includes(job.state));
      assert(job.state==='done','standalone PDF failed: '+job.message);
      const note=await Zotero.Items.getAsync(job.notes.reading.id);
      assert(!note.parentID&&!att.parentID,'created or reassigned a parent item');
      assert(note.getNote().includes('/items/'+att.key),'standalone note lacks source link');
    });
    const fork=async(status)=>{
      const previous=PathUtils.parent(completed.workflowPath),id=Date.now()+'-'+Zotero.Utilities.randomString(8).toLowerCase();
      const dir=PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','readings',id);await IOUtils.makeDirectory(dir);
      for(const name of ['draft.json','source-index.json','verification.json'])await IOUtils.writeUTF8(PathUtils.join(dir,name),await IOUtils.readUTF8(PathUtils.join(previous,name)));
      const m=await app.readJSON(completed.workflowPath);m.status=status;delete m.zoteroNotes;await app.writeJSON(PathUtils.join(dir,'workflow.json'),m);
      return {dir,id,path:PathUtils.join(dir,'workflow.json')};
    };
    await check('single-note write rolls back on failure',async()=>{
      const f=await fork('checked'),save=Zotero.Item.prototype.save;let caught;
      Zotero.Item.prototype.save=async function(...args){const result=await save.apply(this,args);if(this.isNote()&&this.getNote().includes(f.id))throw new Error('simulated note write failure');return result;};
      try{await notes.save(f.path,first);}catch(e){caught=e;}finally{Zotero.Item.prototype.save=save;}
      assert(caught,'write failure not propagated');
      const count=await Zotero.DB.valueQueryAsync('SELECT COUNT(*) FROM itemNotes WHERE note LIKE ?',['%ZRI:'+f.id+':%']);
      assert(count===0,'partial note pair survived rollback');
    });
    await check('stored bibliographic snapshot is not silently replaced by later Zotero One updates',async()=>{
      const f=await fork('checked'),old=parent.getField('libraryCatalog');
      parent.setField('libraryCatalog','99.9 (Q4)');await parent.saveTx({skipSelect:true});
      try{
        const result=await notes.save(f.path,first),note=await Zotero.Items.getAsync(result.notes.reading.id);
        assert(note.getNote().includes('7.25')&&!note.getNote().includes('99.9'),'historical reading adopted a later metric without a new snapshot');
      }finally{parent.setField('libraryCatalog',old);await parent.saveTx({skipSelect:true});}
    });
    await check('older seven-section results remain readable and import without invented new sections',async()=>{
      const f=await fork('checked'),draft=await app.readJSON(PathUtils.join(f.dir,'draft.json'));
      const legacy={sections:scope.ReadingCore.LEGACY_SECTIONS.map(([key])=>({...draft.sections.find(s=>s.key===(key==='question'?'motivation':key)),key}))};
      const ids=new Set(legacy.sections.flatMap(s=>s.entries.map(e=>e.id)));
      const saved=await app.readJSON(PathUtils.join(f.dir,'verification.json'));saved.review.checks=saved.review.checks.filter(c=>ids.has(c.entry_id));
      await app.writeJSON(PathUtils.join(f.dir,'draft.json'),legacy);await app.writeJSON(PathUtils.join(f.dir,'verification.json'),saved);
      const meta=await app.readJSON(f.path);meta.templateVersion=2;await app.writeJSON(f.path,meta);
      const result=await notes.save(f.path,first),note=await Zotero.Items.getAsync(result.notes.reading.id);
      assert(note.getNote().includes('研究问题与依据')&&!note.getNote().includes('为什么能发表在这个期刊'),'legacy note was upgraded with fabricated sections');
      await codex.openResult(main,f.path,{key:first.key,libraryID:first.libraryID});
      await until(()=>codex.window?.document.getElementById('zrc-answer'));
      assert(codex.state.answer.includes('研究问题与依据')&&!codex.state.answer.includes('## 研究背景'),'legacy reading cannot be reopened');
      codex.window.close();
    });
    await check('readonly destination is rejected before writing notes',async()=>{
      const get=Zotero.Libraries.get;let caught;
      Zotero.Libraries.get=function(id){return id===987654?{editable:false,libraryType:'group'}:get.call(this,id);};
      try{await notes.destination({libraryID:987654,isPDFAttachment:()=>true,deleted:false});}catch(e){caught=e;}finally{Zotero.Libraries.get=get;}
      assert(caught?.code==='NOTE_READONLY','readonly library accepted');
    });
    await runBatchSmoke(app,scope,main,check,{createPDF,until,sleep});
    await runAttachmentsSmoke(app,scope,main,check,{createPDF,until,sleep});
    await runSettingsSmoke(app,scope,main,check,{createPDF,until,sleep,parent});
    await check('queue state survives reload without reprocessing completed PDFs',async()=>{
      await auto.setEnabled(false);await auto.persist();const before=Object.keys(auto.state.jobs).length,callsBefore=modelCalls;
      await auto.shutdown();await auto.init(app,notes);await sleep(100);
      assert(Object.keys(auto.state.jobs).length===before,'queue history lost');assert(modelCalls===callsBefore,'completed PDFs reprocessed on reload');
    });
  }finally{
    await auto.setEnabled(false);auto.state.paused=false;await auto.persist();
    await auto.stopBatch(Object.values(auto.state.jobs).filter(j=>['waiting_file','queued','running'].includes(j.state)).map(j=>({id:j.id,attempt:j.attempt})));
    if(auto.active)await auto.active.catch(()=>{});
    codex.run=originalRun;app.request=previousRequest;auto.settleMs=2000;auto.pollMs=3000;
  }
}
