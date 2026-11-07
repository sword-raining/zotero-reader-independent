(async()=>{
  const app=readerScope.ReaderApp,notes=readerScope.ReaderNotes,saved=readerScope.ReaderSaved,clean=readerScope.ReaderCleanup,auto=readerScope.ReaderAutomation,R=readerScope.ReadingCore,S=readerScope.SavedCore;
  const root=PathUtils.profileDir,out=PathUtils.join(root,'saved-cleanup-result.json'),tests=[];
  const assert=(v,m)=>{if(!v)throw new Error(m);};
  const check=async(name,action)=>{try{await action();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests});};
  assert(Zotero.DataDirectory.dir.startsWith(root),'Isolated profile required');await auto.setEnabled(false);auto.state.paused=true;
  const parent=new Zotero.Item('journalArticle');parent.libraryID=Zotero.Libraries.userLibraryID;parent.setField('title','Synthetic cleanup reading');await parent.saveTx({skipSelect:true});
  const att=new Zotero.Item('attachment');att.libraryID=parent.libraryID;att.parentID=parent.id;att.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;att.attachmentPath=PathUtils.join(root,'synthetic.pdf');att.attachmentContentType='application/pdf';att.setField('title','Synthetic source');await att.saveTx({skipSelect:true});
  const base=PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent'),originalHash=await app.sha256(att.attachmentPath);
  const create=async()=>{
    const id=Date.now()+'-'+Zotero.Utilities.randomString(8).toLowerCase(),dir=PathUtils.join(base,'readings',id),path=PathUtils.join(dir,'workflow.json');
    await IOUtils.makeDirectory(dir,{createAncestors:true});
    const inputSources=await readerScope.ReaderAttachments.sources(att),source=inputSources[0];
    const paper=R.paperSet([{...source,markdown:'Synthetic article reports twenty four independent field sites.'}],'Synthetic article'),evidence=[{paragraph_id:paper.paragraphs[0].id,quote:paper.paragraphs[0].text}];
    const draft={articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:'合成材料报告二十四个独立样地。',kind:key==='publication'?'interpretation':'reported',evidence}]}))};
    const review={checks:R.claimSections(draft).flatMap(s=>s.entries.map(e=>({entry_id:e.id,verdict:'supported',reason:'synthetic test',numeric_detail:'acceptable',evidence:e.evidence}))),omissions:[],notes:'synthetic test'},assessment=R.assess(draft,review,paper);
    const w={status:'checked',createdAt:new Date().toISOString(),templateID:'ecology',templateVersion:4,source,inputSources,bibliography:await notes.bibliography(att),resultFile:'reading.md'};
    await app.writeJSON(PathUtils.join(dir,'draft.json'),draft);await app.writeJSON(PathUtils.join(dir,'source-index.json'),paper);await app.writeJSON(PathUtils.join(dir,'verification.json'),{review,assessment});
    await IOUtils.writeUTF8(PathUtils.join(dir,'draft.md'),readerScope.ReaderCodex.renderReading(draft,null,w));w.draftSHA256=await app.sha256(PathUtils.join(dir,'draft.md'));
    await IOUtils.writeUTF8(PathUtils.join(dir,'reading.md'),readerScope.ReaderCodex.renderReading(draft,assessment,w));w.resultSHA256=await app.sha256(PathUtils.join(dir,'reading.md'));await app.writeJSON(path,w);
    const cacheBase=app.attachmentDir(source),generation=source.sha256.slice(0,16)+'-'+id,cache=PathUtils.join(cacheBase,generation);
    await IOUtils.makeDirectory(cache,{createAncestors:true});await IOUtils.writeUTF8(PathUtils.join(cache,'full.md'),'synthetic parsed source');await IOUtils.writeUTF8(PathUtils.join(cache,'mineru-result.zip'),'synthetic archive');
    await app.writeJSON(PathUtils.join(cache,'reader-manifest.json'),{source,files:[{path:'full.md'}]});await app.writeJSON(PathUtils.join(cacheBase,'current.json'),{generation});
    const call=PathUtils.join(base,'codex-runs',Date.now()+'-'+Zotero.Utilities.randomString(8).toLowerCase());await IOUtils.makeDirectory(call,{createAncestors:true});await app.writeJSON(PathUtils.join(call,'run.json'),{readingID:id,status:'complete'});await IOUtils.writeUTF8(PathUtils.join(call,'answer.json'),'synthetic output');
    return {id,dir,path,w,cacheBase,call};
  };
  let first,result,note;
  await check('successful native note transaction precedes cleanup and leaves PDF and quoted evidence intact',async()=>{
    first=await create();result=await notes.save(first.path,att);note=await Zotero.Items.getAsync(result.notes.reading.id);
    assert(result.cleanup?.state==='done',result.cleanup?.message||'cleanup not complete');
    assert(!await IOUtils.exists(first.dir)&&!await IOUtils.exists(first.cacheBase)&&!await IOUtils.exists(first.call),'private temporary content remains');
    assert(await app.sha256(att.attachmentPath)===originalHash,'original PDF changed');
    assert(note.getNote().includes('原文依据')&&note.getNote().includes('twenty four independent field sites'),'saved quote missing');
    assert(S.read(note.getNote())?.inputs[0].sha256===originalHash,'portable receipt missing');
    const again=await notes.save(first.path,att);assert(again.notes.reading.id===note.id&&again.notes.reading.reused,'reimport duplicated a cleaned result');
  });
  await check('exported Zotero note JSON preserves receipt through import and works without local queue or receipt file',async()=>{
    const data=note.toJSON(),copy=new Zotero.Item('note');copy.libraryID=parent.libraryID;copy.parentID=parent.id;
    copy.setNote(data.note);await copy.saveTx({skipSelect:true});assert(S.read(copy.getNote())?.runID===first.id,'note serialization lost receipt');
    saved.records={};auto.state.jobs={};
    const match=await saved.matching(att);assert(match?.record?.runID===first.id,'cannot find synchronized note without local records');
    const batch=await auto.enqueueBatch([{libraryID:att.libraryID,key:att.key}],'ecology');assert(batch.skipped===1&&batch.added===0,'synced result was queued for regeneration');
  });
  await check('editing the saved note is preserved and not represented as unchanged AI-checked content',async()=>{
    note.setNote(note.getNote()+'<p>HUMAN_EDIT_KEEP</p>');await note.saveTx({skipSelect:true});
    const found=(await saved.candidates(att)).find(x=>x.note.key===note.key);assert(found?.status==='edited','human edit was labelled checked');
    assert(note.getNote().includes('HUMAN_EDIT_KEEP'),'human edit overwritten');
  });
  await check('source-link receipt survives editor-style normalization and still routes to the correct PDF',async()=>{
    const original=note.getNote(),normalized=original.replace(/\sdata-zri-record="[^"]*"/,'').replace(/<!--[\s\S]*?-->/g,'').replace(/></g,'>\n<');
    const record=S.read(normalized);assert(record?.runID===first.id,'receipt did not survive custom-attribute removal');
    assert(S.body(normalized)===S.body(original),'harmless HTML normalization changed content fingerprint');
    const href=normalized.match(/href="(zotero:\/\/open-pdf\/[^"]*\?zri-record=[^"]*)"/)?.[1];assert(href,'persistent source link missing');
    const params={objectType:'item'},router=new Zotero.Router(params);router.add('library/items/:objectKey',()=>{params.libraryID=Zotero.Libraries.userLibraryID;});router.run(href.replace('zotero://open-pdf/',''));
    Zotero.API.parseParams(params);const items=await Zotero.API.getResultsFromParams(params);assert(items[0]?.id===att.id,'receipt parameter broke PDF source link');
    const copy=new Zotero.Item('note');copy.libraryID=parent.libraryID;copy.parentID=parent.id;copy.setNote(normalized);await copy.saveTx({skipSelect:true});
    assert((await saved.candidates(att)).some(c=>c.note.key===copy.key&&c.record?.runID===first.id),'normalized note cannot be recognized');
  });
  await check('failed native note transaction never deletes pending drafts or source cache',async()=>{
    const f=await create(),save=Zotero.Item.prototype.save;let caught;
    Zotero.Item.prototype.save=async function(...args){if(this.isNote()&&this.getNote().includes(f.id))throw new Error('Synthetic note transaction failure');return save.apply(this,args);};
    try{await notes.save(f.path,att);}catch(e){caught=e;}finally{Zotero.Item.prototype.save=save;}
    assert(caught&&await IOUtils.exists(f.path)&&await IOUtils.exists(f.cacheBase),'failed import deleted temporary data');
    const draft=await app.readJSON(f.path);assert(!draft.zoteroNotes,'failed import marked complete');
  });
  await check('manual cleanup retains unimported workflows and does not alter saved note edits',async()=>{
    const before=note.getNote(),dirs=await IOUtils.getChildren(PathUtils.join(base,'readings'));
    const r=await clean.sweep();assert(r.cleaned===0,'unimported draft cleaned');for(const dir of dirs)assert(await IOUtils.exists(dir),'unimported reading removed');assert(note.getNote()===before,'note edit altered during cleanup');
  });
  await check('native filesystem guard rejects a Windows directory link before deletion',async()=>{
    if(!Zotero.isWin)return;
    const outside=PathUtils.join(root,'outside-cleanup'),link=PathUtils.join(base,'forbidden-junction');await IOUtils.makeDirectory(outside);await IOUtils.writeUTF8(PathUtils.join(outside,'keep.txt'),'keep');
    const cfg=await app.readJSON(PathUtils.join(root,'fixture-config.json')),exe={command:cfg.nodePath,prefix:[]};
    const made=await readerScope.ReaderCodex.run(exe,['-e',"require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",outside,link]);assert(made.exitCode===0,'test junction could not be created');
    try{let caught;try{await clean.remove(link);}catch(e){caught=e;}assert(['CLEANUP_PATH','CLEANUP_LINK'].includes(caught?.code),'native link was not rejected');assert(await IOUtils.readUTF8(PathUtils.join(outside,'keep.txt'))==='keep','outside link target altered');}
    finally{const removed=await readerScope.ReaderCodex.run(exe,['-e',"const fs=require('node:fs');if(fs.existsSync(process.argv[1])&&fs.lstatSync(process.argv[1]).isSymbolicLink())fs.rmdirSync(process.argv[1]);",link]);assert(removed.exitCode===0,'test junction cleanup failed');}
  });
  await check('a batch queued before PDF download rechecks synchronized notes when the file arrives',async()=>{
    const file=await att.getFilePathAsync(),hold=file+'.hold',parse=app.parseAttachment;
    await IOUtils.move(file,hold);let queued;
    try{queued=await auto.enqueueBatch([{libraryID:att.libraryID,key:att.key}],'ecology');assert(queued.added===1,'missing local PDF was incorrectly declared unchanged');}finally{await IOUtils.move(hold,file);}
    app.parseAttachment=async()=>{throw new Error('Existing synced note must prevent parsing');};
    try{const job=auto.state.jobs[queued.members[0].id],r=await auto.execute(job);assert(r.skipped&&r.notes.reading.key,'synced note was not reused after download');job.state='done';job.notes=r.notes;}
    finally{app.parseAttachment=parse;}
  });
  await app.writeJSON(out,{completed:true,tests,modelRequests:0,personalLibraryTouched:false});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'saved-cleanup-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
