'use strict';
var ReaderCleanup={
  app:null,active:null,completedActive:null,
  init(app){this.app=app;},
  root(){return PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent');},
  isLink(file){
    if(!Zotero.isWin)return file.isSymlink();
    try{
      if(!this._winAttributes){
        const {ctypes}=ChromeUtils.importESModule('resource://gre/modules/ctypes.sys.mjs');
        this._winLibrary=ctypes.open('kernel32.dll');
        this._winAttributes=this._winLibrary.declare('GetFileAttributesW',ctypes.winapi_abi,ctypes.uint32_t,ctypes.jschar.ptr);
      }
      const p=file.path,extended=p.startsWith('\\\\?\\')?p:p.startsWith('\\\\')?'\\\\?\\UNC\\'+p.slice(2):'\\\\?\\'+p;
      const attributes=Number(this._winAttributes(extended));
      if(attributes===0xFFFFFFFF)throw new Error('Path attributes unavailable');
      return !!(attributes&0x400); // FILE_ATTRIBUTE_REPARSE_POINT includes junctions.
    }catch(_){throw NoteCore.error('CLEANUP_CHECK','无法确认 Windows 路径属性，临时内容已保留。');}
  },
  shutdown(){this._winLibrary?.close();this._winLibrary=null;this._winAttributes=null;},
  async safeTree(path){
    const root=Zotero.File.pathToFile(this.root()),file=Zotero.File.pathToFile(path);
    root.normalize();file.normalize();
    const fold=s=>Zotero.isWin?s.toLowerCase():s,base=fold(root.path),target=fold(file.path);
    if(target===base||!target.startsWith(base+(Zotero.isWin?'\\':'/')))throw NoteCore.error('CLEANUP_PATH','清理路径不属于本插件的临时目录。');
    for(let p=file;p&&fold(p.path)!==base;p=p.parent)if(p.exists()&&this.isLink(p))throw NoteCore.error('CLEANUP_LINK','临时目录含链接，未自动清理。');
    if(this.isLink(root))throw NoteCore.error('CLEANUP_LINK','插件目录是链接，未自动清理。');
    if(!await IOUtils.exists(path))return;
    if(this.isLink(file))throw NoteCore.error('CLEANUP_LINK','临时目录含链接，未自动清理。');
    if(file.isDirectory())for(const child of await IOUtils.getChildren(path))await this.safeTree(child);
  },
  async remove(path){await this.safeTree(path);await IOUtils.remove(path,{recursive:true,ignoreAbsent:true});},
  async protectedCacheKeys(runID){
    const protectedKeys=new Set();let uncertain=false;
    for(const dir of await IOUtils.getChildren(PathUtils.join(this.root(),'readings'),{ignoreAbsent:true})){
      const id=PathUtils.filename(dir);if(id===runID)continue;
      if(!SavedCore.validID(id)){uncertain=true;continue;}
      const w=await this.app.readJSON(PathUtils.join(dir,'workflow.json'));
      if(!w?.source){uncertain=true;continue;}
      for(const s of w.inputSources||[w.source])protectedKeys.add(`${s.libraryID}:${s.key}`);
    }
    for(const job of Object.values(ReaderAutomation.state.jobs)){
      if(job.workflowPath===PathUtils.join(this.root(),'readings',runID,'workflow.json'))continue;
      if(['done','imported','cancelled'].includes(job.state)&&!job.workflowPath)continue;
      for(const key of [job.key,...(job.inputSelection?.supplementKeys||[])])protectedKeys.add(`${job.libraryID}:${key}`);
    }
    return {protectedKeys,uncertain};
  },
  async legacyMarkdownMatches(dir,w,name,digest){
    // Only untracked, non-current outputs may use this compatibility proof.
    if(!['reading.md','review-needed.md'].includes(name)||name===(w.resultFile||'draft.md'))return false;
    const internal=PathUtils.join(dir,'internal');if(!await IOUtils.exists(internal))return false;
    await this.safeTree(dir);
    const files=await IOUtils.getChildren(internal);if(files.length>200)return false;
    const parse=path=>{const m=PathUtils.filename(path).match(/^(draft|check)-(\d+)(?:-resume-(\d+))?\.json$/);return m?{path,type:m[1],round:Number(m[2]),resume:Number(m[3]||0)}:null;};
    const entries=files.map(parse).filter(Boolean),drafts=entries.filter(x=>x.type==='draft'),checks=entries.filter(x=>x.type==='check').sort((a,b)=>b.resume-a.resume||b.round-a.round);
    const loaded=new Map();let bytes=0;
    const read=async path=>{if(loaded.has(path))return loaded.get(path);const stat=await IOUtils.stat(path);bytes+=stat.size;if(stat.size>8*1024*1024||bytes>32*1024*1024)return null;const data=await this.app.readJSON(path);loaded.set(path,data);return data;};
    for(const check of checks){
      const info=await read(check.path),assessment=info?.assessment;if(assessment?.status!==(name==='reading.md'?'checked':'needs_review'))continue;
      const source=drafts.filter(d=>d.round===check.round&&d.resume<=check.resume).sort((a,b)=>b.resume-a.resume)[0];if(!source)continue;
      const draft=await read(source.path);if(!draft)continue;
      for(const legacyAttribution of [false,true])for(const status of [assessment.status,'verifying']){
        let text;try{text=WikiCore.decorate(ReadingCore.renderDraft(draft,assessment,w.bibliography,w.inputSources,{legacyAttribution}),w.bibliography,{...w,status});}catch(_){continue;}
        if(await this.app.sha256Text(text)===digest)return true;
      }
    }
    return false;
  },
  async readingUnmodified(dir,w,{explain=false}={}){
    const fail=(name,reason)=>{if(explain)throw NoteCore.error('CLEANUP_PROTECTED',name+'：'+reason+'，已保留。');return false;};
    const allowed=new Set(['workflow.json','draft.json','draft.md','reading.md','review-needed.md','verification.json','source.json','source-index.json','internal']);
    for(const child of await IOUtils.getChildren(dir)){
      const name=PathUtils.filename(child);if(!allowed.has(name))return fail(name,'目录中有额外文件');
      if(name==='internal')for(const file of await IOUtils.getChildren(child))if(!/^(?:draft|check)-\d+(?:-resume-\d+)?\.json$/.test(PathUtils.filename(file)))return fail('internal/'+PathUtils.filename(file),'不是已知的生成记录');
    }
    for(const name of ['draft.md','reading.md','review-needed.md']){
      const path=PathUtils.join(dir,name);if(!await IOUtils.exists(path))continue;
      const importedName=w.resultFile||'draft.md',current=await this.app.sha256(path);
      const hash=name===importedName?(w.importedMarkdownSHA256||(w.resultFile?w.resultSHA256:w.draftSHA256)):name==='draft.md'?w.draftSHA256:w.generatedMarkdown?.[name];
      if(hash){if(current!==hash)return fail(name,'内容与保存记录不一致');}
      else if(!await this.legacyMarkdownMatches(dir,w,name,current))return fail(name,'无法确认这份旧中间稿未经修改');
    }
    return true;
  },
  async afterSave(workflowPath,attachment){
    const id=PathUtils.filename(PathUtils.parent(workflowPath));
    if(!SavedCore.validID(id)||workflowPath!==PathUtils.join(this.root(),'readings',id,'workflow.json'))return {state:'retained',message:'结果路径无法确认，临时内容已保留。'};
    try{
      const saved=await ReaderSaved.byRun(id,attachment);
      if(!saved)return {state:'retained',message:'笔记保存记录尚未确认，临时内容已保留。'};
      const dir=PathUtils.parent(workflowPath),w=await this.app.readJSON(workflowPath);
      if(!w){saved.entry.cleanup='done';await ReaderSaved.persist();return {state:'done'};}
      if(!w.zoteroNotes?.reading?.key||w.zoteroNotes.reading.key!==saved.note.key)return {state:'retained',message:'笔记映射尚未保存，临时内容已保留。'};
      if(!await this.readingUnmodified(dir,w,{explain:true}))return {state:'retained',message:'本地稿件有修改或额外文件，已保留，未自动清理。'};
      const {protectedKeys,uncertain}=await this.protectedCacheKeys(id),cachePaths=[];let cacheRetained=uncertain||!!this.app.activeRun;
      if(!uncertain&&!this.app.activeRun)for(const s of w.inputSources||[w.source]){
        if(protectedKeys.has(`${s.libraryID}:${s.key}`)){cacheRetained=true;continue;}
        const base=this.app.attachmentDir(s);if(!await IOUtils.exists(base))continue;
        let known=true;
        for(const child of await IOUtils.getChildren(base)){
          const name=PathUtils.filename(child);if(['current.json','pending.json'].includes(name))continue;
          if(!/^[a-z0-9-]+$/.test(name)){known=false;break;}
          const m=await this.app.readJSON(PathUtils.join(child,'reader-manifest.json'));
          if(m?.source?.key!==s.key||m.source.libraryID!==s.libraryID){known=false;break;}
          const allowed=new Set(['mineru-result.zip','reader-manifest.json',...(m.files||[]).map(f=>f.path)]);
          const visit=async(path,prefix='')=>{for(const p of await IOUtils.getChildren(path)){const relative=prefix+PathUtils.filename(p),f=Zotero.File.pathToFile(p);if(f.isDirectory())await visit(p,relative+'/');else if(!allowed.has(relative))known=false;}};
          await this.safeTree(child);await visit(child);
        }
        if(known&&!cachePaths.includes(base))cachePaths.push(base);else if(!known)cacheRetained=true;
      }
      const runPaths=[];
      for(const path of await IOUtils.getChildren(PathUtils.join(this.root(),'codex-runs'),{ignoreAbsent:true})){
        if(!SavedCore.validID(PathUtils.filename(path)))continue;
        const m=await this.app.readJSON(PathUtils.join(path,'run.json'));
        if(m?.readingID===id&&m.status!=='running')runPaths.push(path);
      }
      for(const path of [...cachePaths,...runPaths,dir])await this.safeTree(path);
      // The note and compact receipt are durable before any deletion starts.
      saved.entry.cleanup='pending';await ReaderSaved.persist();
      for(const path of [...cachePaths,...runPaths])await this.remove(path);
      if(!await this.readingUnmodified(dir,w,{explain:true}))return {state:'retained',message:'清理期间稿件发生修改，已保留稿件。'};
      await this.remove(dir);
      saved.entry.cleanup='done';saved.entry.cleanedAt=new Date().toISOString();await ReaderSaved.persist();
      return {state:'done',sharedCacheRetained:cacheRetained,...(cacheRetained?{message:'笔记已保存，稿件与调用记录已清理；仍在使用或含额外文件的缓存已保留。'}:{})};
    }catch(e){return {state:'retained',message:'笔记已保存，临时内容暂未清理：'+this.app.safeError(e)};}
  },
  async sweepCompleted(){
    if(this.completedActive)return this.completedActive;
    if(this.active)throw NoteCore.error('BUSY','生成缓存正在清理，请稍后再试。');
    this.completedActive=Promise.resolve().then(async()=>{
      const result={cleaned:0,retained:0,skipped:0,sharedCacheRetained:0,details:[]},jobs=Object.values(ReaderAutomation.state.jobs);
      for(const job of jobs){
        if(ReaderAutomation.historyHidden(job))continue;
        const proposal=ReaderAutomation.completedProposal(job);
        if(!proposal){result.skipped++;continue;}
        const title=job.title||job.key;
        ReaderAutomation.historyClearing.add(job.id);
        try{
          const view=ReaderCodex.state||{};
          if(ReaderNotes.pending||view.editing&&(view.followJobID===job.id||view.output===job.workflowPath)||view.busy&&view.attachment?.key===job.key&&view.attachment?.libraryID===job.libraryID)throw NoteCore.error('HISTORY_BUSY','正在保存笔记或编辑此稿，记录与缓存保留。');
          const att=await Zotero.Items.getByLibraryAndKeyAsync(job.libraryID,job.key),note=await Zotero.Items.getByLibraryAndKeyAsync(job.libraryID,job.notes.reading.key);
          if(!att||att.deleted||!att.isPDFAttachment()||!note?.isNote()||note.deleted||note.parentID!==att.parentID)throw NoteCore.error('HISTORY_NOTE','未能确认当前 PDF 与已保存笔记，记录保留。');
          const embedded=SavedCore.read(note.getNote()),runID=embedded?.runID||SavedCore.legacyRun(note.getNote());
          if(!SavedCore.validID(runID)||job.savedRunID&&job.savedRunID!==runID)throw NoteCore.error('HISTORY_NOTE','笔记识别信息与任务不一致，记录保留。');
          const path=PathUtils.join(this.root(),'readings',runID,'workflow.json');
          if(job.workflowPath&&job.workflowPath!==path)throw NoteCore.error('HISTORY_PATH','当前草稿路径无法确认，记录保留。');
          await this.safeTree(PathUtils.parent(path));
          const exists=await IOUtils.exists(path),w=exists?await this.app.readJSON(path):null;
          if(exists&&(!w||w.source?.libraryID!==job.libraryID||w.source?.key!==job.key||w.zoteroNotes?.reading?.key!==note.key||!['checked','needs_review','verification_incomplete'].includes(w.status)))throw NoteCore.error('HISTORY_DRAFT','当前草稿还未确认保存，记录与缓存保留。');
          if(w&&!await this.readingUnmodified(PathUtils.parent(path),w,{explain:true}))throw NoteCore.error('HISTORY_EDITED','本地稿件有后续修改或额外文件，记录与缓存保留。');
          if(ReaderAutomation.state.jobs[job.id]!==job||ReaderAutomation.completedProposal(job)!==proposal)throw NoteCore.error('HISTORY_CHANGED','任务或归档状态已变化，记录保留。');
          await ReaderClassifier.persist();
          let cleanup={state:'done'};
          if(w){
            await ReaderSaved.record(w,note,w.noteStatus||(job.state==='imported'?'edited':'checked'),att);
            if(ReaderAutomation.state.jobs[job.id]!==job||ReaderAutomation.completedProposal(job)!==proposal)throw NoteCore.error('HISTORY_CHANGED','任务或归档状态已变化，记录与缓存保留。');
            cleanup=await this.afterSave(path,att);
            if(cleanup.state!=='done')throw NoteCore.error('HISTORY_RETAINED',cleanup.message||'缓存暂未清理，记录保留以便重试。');
          }
          await ReaderAutomation.hideCompletedHistory(job,proposal,runID);
          ReaderAutomation.noteSaved(path,{notes:job.notes,status:job.state==='imported'?'edited':'checked',cleanup});
          result.cleaned++;if(cleanup.sharedCacheRetained)result.sharedCacheRetained++;
        }catch(e){result.retained++;result.details.push({id:job.id,title,reason:this.app.safeError(e)});}
        finally{ReaderAutomation.historyClearing.delete(job.id);}
      }
      return result;
    });
    try{return await this.completedActive;}finally{this.completedActive=null;ReaderAutomation.refreshViews();ReaderAutomation.schedule();}
  },
  async sweep(){
    if(this.completedActive)throw NoteCore.error('BUSY','正在清理已完成任务，请稍后重试。');
    if(this.active)return this.active;
    if(ReaderCodex.active||ReaderAutomation.active||ReaderNotes.pending||this.app.state.busy)throw NoteCore.error('BUSY','请等待当前精读、导入或解析结束后再清理。');
    this.active=(async()=>{
      let cleaned=0,retained=0;
      for(const dir of await IOUtils.getChildren(PathUtils.join(this.root(),'readings'),{ignoreAbsent:true})){
        if(!SavedCore.validID(PathUtils.filename(dir)))continue;
        const path=PathUtils.join(dir,'workflow.json'),w=await this.app.readJSON(path);
        if(!w?.zoteroNotes?.reading?.key)continue;
        const att=await Zotero.Items.getByLibraryAndKeyAsync(w.source?.libraryID,w.source?.key),note=await Zotero.Items.getByLibraryAndKeyAsync(w.source?.libraryID,w.zoteroNotes.reading.key);
        if(!att||!note?.isNote()||note.deleted){retained++;continue;}
        if((SavedCore.read(note.getNote())?.runID||SavedCore.legacyRun(note.getNote()))!==PathUtils.filename(dir)){retained++;continue;}
        await ReaderSaved.record(w,note,w.noteStatus==='edited'?'edited':'checked',att);
        const result=await this.afterSave(path,att);if(result.state==='done'){cleaned++;const saved={notes:w.zoteroNotes,status:w.noteStatus||'checked',cleanup:result};await ReaderAutomation.compactImported(path,saved);ReaderAutomation.noteSaved(path,saved);}else retained++;
      }
      return {cleaned,retained};
    })();
    try{return await this.active;}finally{this.active=null;}
  }
};
