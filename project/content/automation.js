"use strict";
var ReaderAutomation={
  app:null,notes:null,state:{schema:1,jobs:{},paused:false},views:new Set(),active:null,activeJob:null,
  observer:null,timer:null,ticking:false,started:false,epoch:0,io:Promise.resolve(),lastMessage:"",settleMs:2000,pollMs:3000,
  enabled(){return Zotero.Prefs.get(this.app.pref+"auto.enabled",true)===true;},
  file(){return PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent","queue.json");},
  async init(app,notes){
    this.app=app;this.notes=notes;
    const saved=await app.readJSON(this.file());
    this.state={schema:1,jobs:{},paused:saved?.paused===true};
    for(const job of Object.values(saved?.jobs||{})){
      try{if(job.id!==QueueCore.key(job.libraryID,job.key)||!["auto","manual"].includes(job.trigger)||
        !["queued","waiting_file","running","done","imported","needs_review","verification_incomplete","awaiting_import","awaiting_selection","failed","cancelled"].includes(job.state))continue;
        this.state.jobs[job.id]=job;
      }catch(_){}
    }
    QueueCore.recover(this.state);
    for(const job of Object.values(this.state.jobs))if(job.state==='needs_review'&&job.workflowPath){
      const workflow=await app.readJSON(job.workflowPath);
      if(workflow?.status==='verification_incomplete'){job.state='verification_incomplete';job.message=ReadingCore.incompleteMessage(workflow.errorCode);}
    }
    this.started=true;this.epoch++;
    this.observer=Zotero.Notifier.registerObserver({notify:(event,type,ids,extra)=>this.notify(event,type,ids,extra)},["item"],"zri-auto-reader");
    this.schedule();
  },
  async persist(){
    const snapshot=JSON.parse(JSON.stringify(this.state));
    this.io=this.io.catch(()=>{}).then(async()=>{
      await IOUtils.makeDirectory(PathUtils.parent(this.file()),{createAncestors:true,ignoreExisting:true});
      await this.app.writeJSON(this.file(),snapshot);
    });
    try{await this.io;}catch(_){this.state.paused=true;this.lastMessage="队列无法保存，已暂停处理，请检查目录权限。";this.refreshViews();throw NoteCore.error("QUEUE_STORAGE",this.lastMessage);}
  },
  notify(event,type,ids,extra={}){
    if(!this.started||type!=="item")return;
    if(event==="add"&&this.enabled()){
      const epoch=this.epoch;
      ReaderTimers.setTimeout(()=>this.capture(ids,extra,epoch).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}),0);
    }else if(["modify","refresh"].includes(event)&&Object.values(this.state.jobs).some(j=>j.state==="waiting_file"))this.schedule();
  },
  async capture(ids,extra,epoch){
    if(!this.started||epoch!==this.epoch)return;
    let changed=false;
    for(const id of ids){
      const item=await Zotero.Items.getAsync(id);
      if(!item)continue;
      if(!QueueCore.captureAllowed({enabled:this.enabled(),event:"add",isPDF:item.isPDFAttachment(),deleted:item.deleted,
        synced:item.synced,libraryID:item.libraryID,userLibraryID:Zotero.Libraries.userLibraryID,
        generated:extra?.[id]?.zriGenerated,epoch,currentEpoch:this.epoch}))continue;
      if(AttachmentCore.isSupplement(item.getField('title'),item.attachmentFilename))continue;
      const templateID=Zotero.Prefs.get(this.app.pref+"auto.template",true)==="general"?"general":"ecology";
      const result=QueueCore.enqueue(this.state,{id:item.id,key:item.key,libraryID:item.libraryID,title:item.getField("title")},{trigger:"auto",templateID});
      changed=changed||result.created;
    }
    if(changed){await this.persist();this.refreshViews();this.schedule();}
  },
  async setEnabled(value){
    Zotero.Prefs.set(this.app.pref+"auto.enabled",Boolean(value),true);this.epoch++;
    if(!value){
      for(const job of Object.values(this.state.jobs))if(job.trigger==="auto"&&QueueCore.pending.has(job.state)){
        job.state="cancelled";job.message="自动精读已关闭";
      }
      if(this.activeJob?.trigger==="auto"){this.activeJob.cancelRequested=true;ReaderCodex.controller?.abort();}
      this.lastMessage="自动精读已关闭。";
    }else this.lastMessage="已启用：只监听此后新增的 PDF，默认只读正文；补充材料和完全重复文件跳过，正文不明确时等待选择。";
    await this.persist();this.refreshViews();this.schedule();
  },
  async enqueueManual(attachment,templateID,options={}){
    ReadingCore.template(templateID);await this.notes.destination(attachment);
    await ReaderAttachments.attachments(attachment,options.inputSelection);
    const active=options.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===options.groupID&&BatchCore.active.has(j.state));
    if(active){ReaderCodex.update({message:'这篇文献已在队列中，沿用原正文与补充材料选择。'});return active;}
    const result=QueueCore.enqueue(this.state,{id:attachment.id,key:attachment.key,libraryID:attachment.libraryID,title:attachment.getField("title")},
      {trigger:"manual",templateID,...options});
    if(result.created)await this.persist();
    ReaderCodex.update({message:result.created?"已加入精读队列；完成后按保存设置生成结果。":"这个 PDF 已在处理队列中。"});
    this.refreshViews();this.schedule();return result.job;
  },
  async enqueueBatch(entries,templateID,{skipProcessed=true}={}){
    ReadingCore.template(templateID);
    const ready=[],rejected=[];
    // Finish read-only validation before adding this batch to the shared queue.
    for(const entry of BatchCore.unique(entries)){
      try{
        const att=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,entry.key);
        await this.notes.destination(att);
        await ReaderAttachments.attachments(att,entry.inputSelection);
        const id=QueueCore.key(att.libraryID,att.key),existing=(entry.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===entry.groupID&&BatchCore.active.has(j.state)))||this.state.jobs[id];
        let sourceMatches=false,saved=null;
        if(skipProcessed&&existing&&BatchCore.completed.has(existing.state)&&existing.workflowPath){
          const previous=await this.app.readJSON(existing.workflowPath);
          if(previous?.source?.key===att.key&&previous.source.libraryID===att.libraryID){
            sourceMatches=await ReaderAttachments.matches(previous,att,entry.inputSelection);
          }
        }
        if(skipProcessed&&!sourceMatches&&!BatchCore.active.has(existing?.state))saved=await ReaderSaved.matching(att,entry.inputSelection);
        ready.push({att,sourceMatches,entry,saved});
      }catch(e){rejected.push({id:`${entry.libraryID}:${entry.key}`,title:entry.display||entry.title||entry.key,reason:this.app.safeError(e)});}
    }
    const result={added:0,existing:0,skipped:0,rejected,members:[],noteKeys:{},outcomes:Object.fromEntries(rejected.map(r=>[r.id,"无法加入："+r.reason]))};
    const batchID=`${Date.now()}-${Zotero.Utilities.randomString(6).toLowerCase()}`;
    let changed=false;
    for(const {att,sourceMatches,entry,saved} of ready){
      const id=QueueCore.key(att.libraryID,att.key),existing=(entry.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===entry.groupID&&BatchCore.active.has(j.state)))||this.state.jobs[id];
      const action=BatchCore.decision(existing,{skipProcessed,sourceMatches});
      if(saved&&action!=='existing'){
        result.skipped++;result.outcomes[id]=saved.status==='edited'?'已跳过：已有笔记（人工修改稿），所选资料未变化':'已跳过：已有 Zotero 精读笔记，所选资料未变化';
        result.noteKeys[id]=saved.note.key;continue;
      }
      if(action==="skip"){result.skipped++;result.outcomes[id]="已跳过：已有精读结果，所选资料未变化";continue;}
      if(action==="existing"){
        // Explicit manual selection can run a queued automatic task even when auto mode is off.
        if(existing.state!=="running"&&existing.trigger==="auto"){existing.trigger="manual";changed=true;}
        result.existing++;result.members.push({id:existing.id,entryID:id,attempt:existing.attempt});continue;
      }
      const {job}=QueueCore.enqueue(this.state,{id:att.id,key:att.key,libraryID:att.libraryID,title:entry.display||att.getField("title")},{trigger:"manual",templateID,inputSelection:entry.inputSelection,groupID:entry.groupID});
      job.skipSaved=skipProcessed;
      job.batchID=batchID;result.added++;changed=true;result.members.push({id,attempt:job.attempt});
    }
    if(changed)await this.persist();
    this.lastMessage=`批量：新增 ${result.added} 篇，已在队列 ${result.existing} 篇，跳过已处理 ${result.skipped} 篇，无法加入 ${rejected.length} 篇。`;
    this.refreshViews();this.schedule();return result;
  },
  async stopBatch(members){
    for(const member of members){
      const job=this.state.jobs[member.id];
      if(!job||job.attempt!==member.attempt)continue;
      if(QueueCore.pending.has(job.state)){job.state="cancelled";job.cancelRequested=true;job.message="已停止本批次任务";job.updatedAt=Date.now();}
      else if(job.state==="running"&&this.activeJob===job){job.cancelRequested=true;ReaderCodex.controller?.abort();}
    }
    await this.persist();this.refreshViews();this.schedule();
  },
  schedule(ms=250){
    if(!this.started)return;
    if(this.timer)ReaderTimers.clearTimeout(this.timer);
    this.timer=ReaderTimers.setTimeout(()=>{this.timer=null;this.tick().catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();});},ms);
  },
  async attachment(job){return Zotero.Items.getByLibraryAndKeyAsync(job.libraryID,job.key);},
  async tick(){
    if(!this.started||this.ticking||this.active)return;
    this.ticking=true;
    try{
      if(this.state.paused||ReaderCodex.active||ReaderCleanup.active||ReaderNotes.pending||this.app.state.busy)return;
      let changed=false;
      for(const job of Object.values(this.state.jobs)){
        if(!QueueCore.pending.has(job.state)||(job.trigger==="auto"&&!this.enabled()))continue;
        try{
          const att=await this.attachment(job);
          if(!att||att.deleted||!att.isPDFAttachment())throw NoteCore.error("QUEUE_SOURCE","来源 PDF 不存在或已进入回收站。");
          const inputs=await ReaderAttachments.attachments(att,job.inputSelection),stamps=[];
          for(const input of inputs){const path=await input.getFilePathAsync();stamps.push(path&&await IOUtils.exists(path)?await IOUtils.stat(path):null);}
          const stat=stamps.every(s=>s&&s.size>0)?{size:stamps.reduce((n,s)=>n+s.size,0),lastModified:stamps.map(s=>s.size+':'+s.lastModified).join('|')}:null;
          const was=job.state,stamp=job.fileStamp;
          const ready=QueueCore.ready(job,stat,Date.now(),this.settleMs);
          if(ready&&job.trigger==='auto'){
            const group=(await ReaderAttachments.collectItems([att])).entries[0];
            if(!group||group.issue)throw NoteCore.error('ATTACHMENT_SELECTION',group?.issue||'无法读取文献附件。');
            const file=group.pdfs.find(f=>f.key===att.key);
            job.groupID=group.groupID;
            if(file?.supplement||file?.duplicateOf){job.state='cancelled';job.message=file.duplicateOf?'内容完全重复，自动精读已跳过':'补充材料默认不自动精读；需要时在文献附件选择中勾选。';}
            else if(!group.mainKey){job.state='awaiting_selection';job.message='无法确定唯一正文。请右键该文献开始精读，并选择正文 PDF。';}
            else if(group.mainKey!==att.key){job.state='cancelled';job.message='这篇文献的另一附件已作为正文，未重复加入。';}
            else {job.inputSelection={mainKey:att.key,supplementKeys:[]};job.title=group.display;}
            if(job.state==='queued'){
              const saved=await ReaderSaved.matching(att,job.inputSelection);
              if(saved){job.state=saved.status==='edited'?'imported':'done';job.notes={reading:{key:saved.note.key,id:saved.note.id}};job.message='已有 Zotero 精读笔记，未重复处理';}
            }
          }
          changed=changed||was!==job.state||stamp!==job.fileStamp;
        }catch(e){job.state="failed";job.message=this.app.safeError(e);job.errorCode=e.code||"LOCAL";changed=true;}
      }
      if(changed)await this.persist();
      const job=QueueCore.next(this.state,{enabled:this.enabled(),paused:this.state.paused,busy:Boolean(ReaderCodex.active||this.app.state.busy)});
      if(!job)return;
      job.state="running";job.message="正在准备精读";job.updatedAt=Date.now();this.activeJob=job;
      await this.persist();
      if((job.trigger==="auto"&&!this.enabled())||job.cancelRequested){job.state="cancelled";this.activeJob=null;await this.persist();return;}
      if(this.state.paused){job.state="queued";this.activeJob=null;await this.persist();return;}
      this.active=this.execute(job);
      this.refreshViews();
      try{
        const result=await this.active;
        job.state=result.status==="awaiting_import"?"awaiting_import":result.status==='verification_incomplete'?'verification_incomplete':result.status==="checked"?"done":result.notes?'imported':"needs_review";
        job.notes=result.notes;job.message=result.status==='verification_incomplete'?result.message:result.status==="awaiting_import"?"精读已完成，等待导入":result.status==="checked"?"已生成精读笔记":"草稿仍需核对，未自动导入";
        if(result.notes){job.message=result.message||result.cleanup?.message||(result.status==='edited'?'已导入人工修改稿':'已生成精读笔记');await this.compactImported(job.workflowPath,result);}
      }catch(e){job.state=!this.started&&!job.cancelRequested?"failed":e.code==="CANCELLED"||job.cancelRequested?"cancelled":"failed";job.errorCode=e.code||"LOCAL";job.message=!this.started&&!job.cancelRequested?"Zotero 退出导致任务中断，可点击重试检查已有结果":this.app.safeError(e);}
      finally{job.updatedAt=Date.now();this.active=null;this.activeJob=null;await this.persist();this.refreshViews();}
    }finally{
      this.ticking=false;
      if(this.started&&!this.active&&!this.state.paused&&Object.values(this.state.jobs).some(j=>QueueCore.pending.has(j.state)&&(j.trigger==="manual"||this.enabled())))this.schedule(this.pollMs);
    }
  },
  async execute(job){
    return ReaderCodex.exclusive(async signal=>{
      const att=await this.attachment(job),destination=await this.notes.destination(att);
      job.deliveryMode=job.deliveryMode||ReaderPreferences.delivery();
      MineruCore.cancelled(signal);
      this.app.controller=ReaderCodex.controller;
      this.app.update({busy:true,title:job.title,message:"准备解析 PDF…"});
      ReaderCodex.update({title:job.title,attachment:att,savedNoteKey:null,inputSelection:job.inputSelection,groupID:job.groupID,cache:null,templateID:job.templateID,
        answer:"",report:"",phase:"parsing",resultStatus:"",view:"reading",output:"",deliveryPending:false,source:job.deliveryMode==="manual"?"先生成 Markdown":"完成后导入笔记",message:"准备解析 PDF…"});
      try{
        // A synced PDF may only become local after batch selection. Recheck then.
        if(job.skipSaved&&!job.workflowPath){
          const saved=await ReaderSaved.matching(att,job.inputSelection);
          if(saved){const message='已有 Zotero 精读笔记，未重复解析或调用模型。';ReaderCodex.update({savedNoteKey:saved.note.key,resultStatus:saved.status,source:'已有 Zotero 精读笔记',message,deliveryPending:false});return {status:saved.status,notes:{reading:{key:saved.note.key,id:saved.note.id,reused:true}},skipped:true,message};}
        }
        // Retry a completed local result without another model request.
        const previous=job.workflowPath?await this.app.readJSON(job.workflowPath):null;
        if(previous&&["checked","needs_review","verification_incomplete"].includes(previous.status)){
          await ReaderAttachments.validateWorkflow(previous,att);
          if(previous.status!=="checked")return this.unresolved(job);
          if(job.deliveryMode==="manual"||ReaderPreferences.delivery()==="manual")return this.awaitImport(job);
          job.phase="notes";job.message="正在生成 Zotero 笔记";this.refreshViews();
          const result=await this.notes.save(job.workflowPath,att);
          this.noteSaved(job.workflowPath,result);return result;
        }
        job.phase="parsing";job.message="解析 PDF";await this.persist();
        const inputSources=await ReaderAttachments.sources(att,job.inputSelection,signal),documents=[];
        let cache,totalChars=0;
        for(const source of inputSources){
          const attachment=await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID,source.key);
          job.message='解析'+source.label;this.refreshViews();
          const parsed=await this.app.parseAttachment(attachment,false,signal);
          if(parsed.manifest.source.sha256!==source.sha256)throw NoteCore.error('PDF_CHANGED','所选 PDF 在准备期间发生变化，请重新精读。');
          const mdPath=PathUtils.join(parsed.dir,...MineruCore.safeZipPath(parsed.manifest.markdown).split('/'));
          if((await IOUtils.stat(mdPath)).size>4*CodexCore.MAX_PAPER_CHARS)throw NoteCore.error('TEXT_SIZE','所选资料过长，未发送模型。请减少补充材料。');
          const markdown=await IOUtils.readUTF8(mdPath);totalChars+=markdown.length;
          if(totalChars>CodexCore.MAX_PAPER_CHARS)throw NoteCore.error('TEXT_SIZE','正文与所选补充材料合计过长，未发送模型。请减少补充材料。');
          documents.push({...source,markdown});
          source.cacheGeneration=PathUtils.filename(parsed.dir);source.markdownSHA256=parsed.manifest.markdownSha256;
          if(source.role==='main'){cache=parsed;ReaderCodex.update({cache});}
        }
        const paper=ReadingCore.paperSet(documents,job.title);
        job.phase="reading";await this.persist();
        try{
          await ReaderCodex.readPaper(paper,{source:cache.manifest.source,inputSources,inputSelection:job.inputSelection||{mainKey:att.key,supplementKeys:[]},groupID:job.groupID,bibliography:destination.bibliography,cacheGeneration:PathUtils.filename(cache.dir),markdownSHA256:cache.manifest.markdownSha256,queueJobID:job.id},signal,
            {created:async path=>{job.workflowPath=path;await this.persist();}});
        }catch(e){
          if(signal.aborted)throw CodexCore.error("CANCELLED","已停止本次任务，本地草稿保留，未继续生成笔记。");
          const workflow=job.workflowPath?await this.app.readJSON(job.workflowPath):null;
          if(workflow?.status!=="verification_incomplete")throw e;
          job.errorCode=e.code||"VERIFICATION";
        }
        MineruCore.cancelled(signal);
        const finalWorkflow=await this.app.readJSON(job.workflowPath);
        if(finalWorkflow?.status!=="checked")return this.unresolved(job);
        if(job.deliveryMode==="manual"||ReaderPreferences.delivery()==="manual")return this.awaitImport(job);
        job.phase="notes";job.message="正在生成 Zotero 笔记";await this.persist();this.refreshViews();
        const result=await this.notes.save(job.workflowPath,att);
        this.noteSaved(job.workflowPath,result);
        return result;
      }finally{this.app.controller=null;this.app.update({busy:false});}
    });
  },
  async unresolved(job){
    const workflow=await this.app.readJSON(job.workflowPath),incomplete=workflow?.status==='verification_incomplete';
    const status=incomplete?'verification_incomplete':'needs_review',message=incomplete?ReadingCore.incompleteMessage(workflow.errorCode):'仍有重要内容需要核对，请展开问题说明；当前草稿未导入。';
    ReaderCodex.update({output:job.workflowPath,deliveryPending:true,resultStatus:status,message,...(incomplete?{report:message}:{})});
    return {status,message};
  },
  async awaitImport(job){
    await this.persist();
    ReaderCodex.update({output:job.workflowPath,resultStatus:'checked',deliveryPending:true,message:"精读内容已保存为 Markdown，检查后即可导入。"});
    return {status:"awaiting_import"};
  },
  async importResult(workflowPath){
    const workflow=await this.app.readJSON(workflowPath);
    const saved=ReaderSaved.records[PathUtils.filename(PathUtils.parent(workflowPath))];
    const source=workflow?.source||(saved?{libraryID:saved.libraryID,key:saved.attachmentKey}:null);
    if(!source)throw NoteCore.error("NOTE_SOURCE","精读结果缺少来源信息。");
    const att=await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID,source.key);
    const result=await this.notes.save(workflowPath,att,{preferMarkdown:true});
    const id=QueueCore.key(att.libraryID,att.key),job=this.state.jobs[id];
    if(job?.workflowPath===workflowPath){job.state=result.status==="checked"?"done":"imported";job.notes=result.notes;job.message=result.cleanup?.message||"已导入精读笔记";job.updatedAt=Date.now();await this.persist();}
    await this.compactImported(workflowPath,result);this.noteSaved(workflowPath,result);
    this.refreshViews();return result;
  },
  noteSaved(path,result){
    if(ReaderCodex.state.output!==path)return;
    ReaderCodex.update({deliveryPending:false,source:'已保存为 Zotero 笔记',savedNoteKey:result.notes?.reading?.key,
      message:result.cleanup?.message||(result.status==='edited'?'已导入人工修改稿。':result.cleanup?.state==='done'?'已导入精读笔记，临时内容已清理。':'已导入精读笔记。'),
      ...(result.cleanup?.state==='done'?{output:'',cache:null}:{})});
  },
  async compactImported(path,result){
    if(result.cleanup?.state!=='done')return;
    for(const job of Object.values(this.state.jobs))if(job.workflowPath===path){
      job.notes=result.notes;job.state=result.status==='checked'?'done':'imported';job.savedRunID=PathUtils.filename(PathUtils.parent(path));
      delete job.workflowPath;delete job.fileStamp;delete job.stableSince;delete job.itemID;delete job.errorCode;delete job.cancelRequested;
    }
    await this.persist();
  },
  async retryFailed(){
    for(const job of Object.values(this.state.jobs))if(job.state==="failed"&&(job.trigger==="manual"||this.enabled())){
      job.state="waiting_file";job.message="等待重试";job.cancelRequested=false;job.fileStamp=null;job.stableSince=null;
    }
    await this.persist();this.refreshViews();this.schedule();
  },
  async togglePaused(){this.state.paused=!this.state.paused;await this.persist();this.refreshViews();this.schedule();},
  stopCurrent(){if(this.activeJob){this.activeJob.cancelRequested=true;ReaderCodex.controller?.abort();}},
  bindPreferences(win){
    const get=id=>win.document.getElementById("zri-auto-"+id);
    if(!get("enabled")||get("enabled").dataset.bound)return;
    get("enabled").dataset.bound="true";this.views.add(win);win.addEventListener("unload",()=>this.views.delete(win),{once:true});
    get("enabled").addEventListener("change",()=>this.setEnabled(get("enabled").checked).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}));
    get("template").value=Zotero.Prefs.get(this.app.pref+"auto.template",true)==="general"?"general":"ecology";
    get("template").addEventListener("command",()=>Zotero.Prefs.set(this.app.pref+"auto.template",get("template").value,true));
    get("pause").addEventListener("click",()=>this.togglePaused().catch(()=>{}));
    get("retry").addEventListener("click",()=>this.retryFailed().catch(()=>{}));
    get("stop").addEventListener("click",()=>this.stopCurrent());
    this.refreshViews();
  },
  refreshViews(){
    if(typeof ReaderBatch!=="undefined")ReaderBatch.render();
    const labels={waiting_file:"等待文件",queued:"排队中",running:"处理中",done:"已生成笔记",imported:'已导入人工稿',needs_review:"草稿待复核",verification_incomplete:'检查未完成',awaiting_import:"Markdown 待导入",awaiting_selection:"待选择正文",failed:"失败",cancelled:"已停止或跳过"};
    for(const win of [...this.views]){
      if(win.closed){this.views.delete(win);continue;}
      const get=id=>win.document.getElementById("zri-auto-"+id);if(!get("enabled"))continue;
      get("enabled").checked=this.enabled();get("pause").textContent=this.state.paused?"继续队列":"暂停队列";
      get("stop").disabled=!this.activeJob;
      const jobs=Object.values(this.state.jobs).sort((a,b)=>b.updatedAt-a.updatedAt);
      const pending=jobs.filter(j=>["waiting_file","queued","running"].includes(j.state));
      get("status").textContent=(this.lastMessage?this.lastMessage+"\n":"")+`等待或处理中：${pending.length} 项。`+(this.state.paused?"队列已暂停，当前任务可继续完成。":"");
      const visible=[...pending,...jobs.filter(j=>!pending.includes(j))].slice(0,12);
      get("jobs").textContent=visible.map(j=>{
        const msg=this.activeJob===j?(j.phase==="parsing"?this.app.state.message:j.phase==="reading"?ReaderCodex.state.message:j.message):j.message;
        return `${labels[j.state]||j.state} · ${j.title}\n  ${msg}`;
      }).join("\n")||"暂无任务。启用后，新添加的 PDF 将出现在这里。";
    }
  },
  async shutdown(){
    this.started=false;if(this.timer)ReaderTimers.clearTimeout(this.timer);this.timer=null;
    if(this.observer)Zotero.Notifier.unregisterObserver(this.observer);this.observer=null;
    if(this.active)ReaderCodex.controller?.abort();
    if(this.active)await this.active.catch(()=>{});
    await this.persist().catch(()=>{});this.views.clear();
  }
};
