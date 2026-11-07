'use strict';
var ReaderCleanup={
  app:null,active:null,
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
  async readingUnmodified(dir,w){
    const allowed=new Set(['workflow.json','draft.json','draft.md','reading.md','review-needed.md','verification.json','source.json','source-index.json','internal']);
    for(const child of await IOUtils.getChildren(dir)){
      const name=PathUtils.filename(child);if(!allowed.has(name))return false;
      if(name==='internal')for(const file of await IOUtils.getChildren(child))if(!/^(?:draft|check)-\d+(?:-resume-\d+)?\.json$/.test(PathUtils.filename(file)))return false;
    }
    for(const name of ['draft.md','reading.md','review-needed.md']){
      const path=PathUtils.join(dir,name);if(!await IOUtils.exists(path))continue;
      const importedName=w.resultFile||'draft.md';
      const hash=name===importedName?(w.importedMarkdownSHA256||(w.resultFile?w.resultSHA256:w.draftSHA256)):name==='draft.md'?w.draftSHA256:null;
      if(!hash||await this.app.sha256(path)!==hash)return false;
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
      if(!await this.readingUnmodified(dir,w))return {state:'retained',message:'本地稿件有修改或额外文件，已保留，未自动清理。'};
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
      if(!await this.readingUnmodified(dir,w))return {state:'retained',message:'清理期间稿件发生修改，已保留稿件。'};
      await this.remove(dir);
      saved.entry.cleanup='done';saved.entry.cleanedAt=new Date().toISOString();await ReaderSaved.persist();
      return {state:'done',sharedCacheRetained:cacheRetained,...(cacheRetained?{message:'笔记已保存，稿件与调用记录已清理；仍在使用或含额外文件的缓存已保留。'}:{})};
    }catch(e){return {state:'retained',message:'笔记已保存，临时内容暂未清理：'+this.app.safeError(e)};}
  },
  async sweep(){
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
