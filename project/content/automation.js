"use strict";
var ReaderAutomation={
  app:null,notes:null,state:{schema:1,jobs:{},paused:false},views:new Set(),active:null,activeJob:null,bulkSaving:null,bulkSaveProgress:null,bulkSaveMessage:"",resumeEnqueueing:null,resumeEpoch:0,bulkResumeMessage:"",starting:null,pausing:null,savePauseEpoch:0,
  observer:null,timer:null,ticking:false,started:false,epoch:0,running:new Map(),historyClearing:new Set(),io:Promise.resolve(),lastMessage:"",settleMs:2000,pollMs:3000,
  attachmentMaintenanceBusy(){return typeof ReaderAttachmentMaintenance!=='undefined'&&!!ReaderAttachmentMaintenance.active;},
  enabled(){return Zotero.Prefs.get(this.app.pref+"auto.enabled",true)===true;},
  collectionKey(){return String(Zotero.Prefs.get(this.app.pref+'auto.collectionKey',true)||'');},
  async collection(){
    const key=this.collectionKey();if(!key)return null;
    const c=await Zotero.Collections.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,key);
    return c&&!c.deleted?c:null;
  },
  async inScope(item,key=this.collectionKey()){
    if(!key)return true;
    const c=await this.collection();if(!c||c.key!==key||item.libraryID!==c.libraryID)return false;
    const owner=item.parentID?await Zotero.Items.getAsync(item.parentID):item;
    return !!owner&&!owner.deleted&&owner.inCollection(c.id);
  },
  async setCollection(key){
    key=String(key||'');
    if(key){const c=await Zotero.Collections.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID,key);if(!c||c.deleted)throw NoteCore.error('AUTO_COLLECTION','所选分类不存在，请刷新分类列表。');}
    if(key===this.collectionKey())return;
    Zotero.Prefs.set(this.app.pref+'auto.collectionKey',key,true);this.epoch++;
    for(const job of Object.values(this.state.jobs))if(job.trigger==='auto'&&(QueueCore.pending.has(job.state)||job.resumePending)){
      delete job.resumePending;this.recordCancellation(job,'scope-change');job.state='cancelled';job.scopeCancelled=true;job.message='监听分类已变更，未处理旧队列';job.updatedAt=Date.now();
    }
    for(const w of this.running.values())if(w.job.trigger==='auto')this.cancelJob(w.job,'scope-change');
    this.lastMessage='监听范围已保存，仅处理此后进入范围的文献，不补扫已有条目。';
    await this.persist();this.refreshViews();this.schedule();
  },
  async reconcileScope(){
    let changed=false;
    for(const job of Object.values(this.state.jobs)){
      if(job.trigger!=='auto'||(!(QueueCore.pending.has(job.state)||job.resumePending)&&!this.isRunning(job)))continue;
      const att=await this.attachment(job);
      if(att&&(job.autoCollectionKey||'')===this.collectionKey()&&await this.inScope(att))continue;
      if(this.isRunning(job)){this.cancelJob(job,'out-of-scope');}
      else {delete job.resumePending;this.recordCancellation(job,'out-of-scope');job.state='cancelled';job.scopeCancelled=true;}
      job.message='文献已移出监听范围，自动任务已停止';job.updatedAt=Date.now();changed=true;
    }
    if(changed){await this.persist();this.refreshViews();}
  },
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
    for(const job of Object.values(this.state.jobs))if(job.resumePending){delete job.resumePending;job.message='上次排队的续检未开始，草稿保留；可再次一键继续。';}
    for(const job of Object.values(this.state.jobs))if(job.classificationStatus==='running'){job.classificationPending=false;job.classificationStatus='failed';job.classificationError='上次分类建议中断，可重新生成';job.message='笔记已保存；上次分类建议中断';}
    for(const job of Object.values(this.state.jobs))if(job.state==='needs_review'&&job.workflowPath){
      const workflow=await app.readJSON(job.workflowPath);
      if(workflow?.status==='verification_incomplete'){job.state='verification_incomplete';job.message=ReadingCore.incompleteMessage(workflow.errorCode);}
    }
    for(const job of Object.values(this.state.jobs))if(['cancelled','failed','verification_incomplete','needs_review'].includes(job.state))await this.refreshResumeState(job);
    let recovered=false;
    if(typeof ReaderClassifier!=='undefined')for(const p of ReaderClassifier.recovered?.values?.()||[]){const job=this.state.jobs[p.jobID];if(!job||!['done','imported'].includes(job.state)||job.notes?.reading?.key!==p.noteKey)continue;job.classificationPending=false;job.classificationForce=false;job.classificationStatus=p.status;job.message=p.recoveryMessage;if(p.noteStatus==='edited')job.state='imported';if(p.status==='confirmed')job.archiveConfirmedAt=p.confirmedAt;recovered=true;}
    if(recovered)try{await this.persist();}catch(_){}
    this.started=true;this.epoch++;
    this.observer=Zotero.Notifier.registerObserver({notify:(event,type,ids,extra)=>this.notify(event,type,ids,extra)},["item","collection-item","collection"],"zri-auto-reader");
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
    if(!this.started)return;
    if(type==='item'&&['add','modify'].includes(event)&&Object.values(this.state.jobs).some(j=>j.coordinationWaitUntil))this.wakePeerNotes(ids).catch(()=>{});
    if(type==='collection-item'&&this.collectionKey()){
      if(event==='add'&&this.enabled()){
        const epoch=this.epoch;
        ReaderTimers.setTimeout(()=>this.captureCollection(ids,extra,epoch).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}),0);
      }else if(event==='remove')this.reconcileScope().catch(()=>{});
      return;
    }
    if(type==='collection'&&['delete','trash'].includes(event)){this.reconcileScope().catch(()=>{});return;}
    if(type!=="item")return;
    if(event==="add"&&this.enabled()){
      const epoch=this.epoch;
      ReaderTimers.setTimeout(()=>this.capture(ids,extra,epoch).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}),0);
    }else if(["modify","refresh"].includes(event)&&Object.values(this.state.jobs).some(j=>j.state==="waiting_file"))this.schedule();
  },
  async wakePeerNotes(ids){const parents=new Set();for(const id of ids){const n=await Zotero.Items.getAsync(id);if(n?.isNote()&&n.parentID&&SavedCore.read(n.getNote()))parents.add(n.parentID);}if(!parents.size)return;for(const job of Object.values(this.state.jobs))if(job.coordinationWaitUntil){const att=await this.attachment(job);if(parents.has(att?.parentID))delete job.coordinationWaitUntil;}this.schedule();},
  async captureCollection(ids,extra,epoch){
    const collection=await this.collection();if(!collection||!this.enabled()||!this.started||epoch!==this.epoch)return;
    const pdfIDs=[];
    for(const id of ids){
      const match=String(id).match(/^(\d+)-(\d+)$/);if(!match||Number(match[1])!==collection.id)continue;
      const item=await Zotero.Items.getAsync(Number(match[2]));
      // A local membership edit marks its owner unsynced; a server sync does not.
      if(!item||item.deleted||item.synced&&!(typeof ReaderCoordination!=='undefined'&&ReaderCoordination.enabled())||item.libraryID!==collection.libraryID||extra?.[id]?.zriGenerated)continue;
      if(item.isRegularItem())pdfIDs.push(...item.getAttachments());
      else if(item.isPDFAttachment())pdfIDs.push(item.id);
    }
    await this.capture([...new Set(pdfIDs)],{},epoch,true);
  },
  async capture(ids,extra,epoch,fromCollection=false){
    this.app.assertIndexes?.();
    if(!this.started||epoch!==this.epoch)return;
    let changed=false;
    for(const id of ids){
      const item=await Zotero.Items.getAsync(id);
      if(!item)continue;
      if(!QueueCore.captureAllowed({enabled:this.enabled(),event:"add",isPDF:item.isPDFAttachment(),deleted:item.deleted,
        synced:fromCollection||this.collectionKey()&&typeof ReaderCoordination!=='undefined'&&ReaderCoordination.enabled()?false:item.synced,libraryID:item.libraryID,userLibraryID:Zotero.Libraries.userLibraryID,
        generated:extra?.[id]?.zriGenerated,epoch,currentEpoch:this.epoch}))continue;
      if(!await this.inScope(item))continue;
      if(epoch!==this.epoch||!this.enabled())return;
      if(AttachmentCore.isSupplement(item.getField('title'),item.attachmentFilename))continue;
      const templateID="general";
      const result=QueueCore.enqueue(this.state,{id:item.id,key:item.key,libraryID:item.libraryID,title:item.getField("title")},{trigger:"auto",templateID});
      if(result.created){result.job.autoCollectionKey=this.collectionKey();result.job.skipSaved=true;}
      changed=changed||result.created;
    }
    if(changed){await this.persist();this.refreshViews();this.schedule();}
  },
  async setEnabled(value){
    Zotero.Prefs.set(this.app.pref+"auto.enabled",Boolean(value),true);this.epoch++;
    if(!value){
      for(const job of Object.values(this.state.jobs))if(job.trigger==="auto"&&(QueueCore.pending.has(job.state)||job.resumePending)){
        delete job.resumePending;this.recordCancellation(job,'auto-disabled');job.state="cancelled";job.message="自动精读已关闭";
      }
      for(const w of this.running.values())if(w.job.trigger==='auto')this.cancelJob(w.job,'auto-disabled');
      this.lastMessage="自动精读已关闭。";
    }else this.lastMessage=this.collectionKey()?"已启用：仅监听此后进入所选分类的文献，不包含子分类、不补扫已有条目。":"已启用：监听此后新增的 PDF；可选择监听分类来限定范围。";
    await this.persist();this.refreshViews();this.schedule();
  },
  async enqueueManual(attachment,templateID,options={}){
    this.app.assertIndexes?.();
    if(this.attachmentMaintenanceBusy())throw NoteCore.error('BUSY','正在整理附件，请稍后加入精读。');
    if(this.historyClearing.has(QueueCore.key(attachment.libraryID,attachment.key)))await ReaderCleanup.completedActive;
    ReadingCore.template(templateID);await this.notes.destination(attachment);
    await ReaderAttachments.attachments(attachment,options.inputSelection);
    const active=options.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===options.groupID&&(j.resumePending||BatchCore.active.has(j.state)));
    if(active){ReaderCodex.update({message:'这篇文献已在队列中，沿用原正文与补充材料选择。'});return active;}
    if(this.attachmentMaintenanceBusy())throw NoteCore.error('BUSY','正在整理附件，请稍后加入精读。');
    const result=QueueCore.enqueue(this.state,{id:attachment.id,key:attachment.key,libraryID:attachment.libraryID,title:attachment.getField("title")},
      {trigger:"manual",templateID,...options});
    if(result.created)await this.persist();
    ReaderCodex.update({message:result.created?"已加入精读队列；完成后按保存设置生成结果。":"这个 PDF 已在处理队列中。"});
    this.refreshViews();this.schedule();return result.job;
  },
  async batchLanguage(att){
    const owner=att?.parentID?await Zotero.Items.getAsync(att.parentID):att;
    if(typeof ReaderLanguage!=='undefined'){const info=await ReaderLanguage.inspect(att);if(info.chinese)return 'zh';}
    return owner?.isRegularItem?.()?String(owner.getField('language')||''):'';
  },
  async enqueueBatch(entries,templateID,{skipProcessed=true,skipChinese=typeof ReaderLanguage!=='undefined'?ReaderLanguage.skip():true}={}){
    this.app.assertIndexes?.();
    if(ReaderCleanup.completedActive)await ReaderCleanup.completedActive;
    ReadingCore.template(templateID);
    const ready=[],rejected=[];
    // Finish read-only validation before adding this batch to the shared queue.
    for(const entry of BatchCore.unique(entries)){
      try{
        const att=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,entry.key);
        await this.notes.destination(att);
        const language=await this.batchLanguage(att);
        if(skipChinese!==false&&BatchCore.languageInfo(language).chinese){ready.push({att,entry,language,skipLanguage:true});continue;}
        await ReaderAttachments.attachments(att,entry.inputSelection);
        const id=QueueCore.key(att.libraryID,att.key),existing=(entry.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===entry.groupID&&(j.resumePending||BatchCore.active.has(j.state))))||this.state.jobs[id];
        let sourceMatches=false,saved=null;
        if(skipProcessed&&existing&&BatchCore.completed.has(existing.state)&&existing.workflowPath){
          const previous=await this.app.readJSON(existing.workflowPath);
          if(previous?.source?.key===att.key&&previous.source.libraryID===att.libraryID){
            sourceMatches=await ReaderAttachments.matches(previous,att,entry.inputSelection);
          }
        }
        if(skipProcessed&&!sourceMatches&&!BatchCore.active.has(existing?.state))saved=await ReaderSaved.matching(att,entry.inputSelection);
        ready.push({att,sourceMatches,entry,saved,language});
      }catch(e){rejected.push({id:`${entry.libraryID}:${entry.key}`,title:entry.display||entry.title||entry.key,reason:this.app.safeError(e)});}
    }
    if(this.attachmentMaintenanceBusy())throw NoteCore.error('BUSY','正在整理附件，请稍后加入精读。');
    const result={added:0,existing:0,skipped:0,skippedChinese:0,languages:{},rejected,members:[],noteKeys:{},outcomes:Object.fromEntries(rejected.map(r=>[r.id,"无法加入："+r.reason]))};
    const batchID=`${Date.now()}-${Zotero.Utilities.randomString(6).toLowerCase()}`;
    let changed=false;
    for(const {att,sourceMatches,entry,saved,language,skipLanguage} of ready){
      const id=QueueCore.key(att.libraryID,att.key),existing=(entry.groupID&&Object.values(this.state.jobs).find(j=>j.groupID===entry.groupID&&(j.resumePending||BatchCore.active.has(j.state))))||this.state.jobs[id];
      result.languages[id]=language;
      if(skipLanguage){result.skippedChinese++;result.outcomes[id]='本批跳过：Zotero 语言字段标为中文'+(BatchCore.active.has(existing?.state)?'；已有任务未中断':'');continue;}
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
      job.skipSaved=skipProcessed;job.skipChinese=skipChinese!==false;
      job.batchID=batchID;result.added++;changed=true;result.members.push({id,attempt:job.attempt});
    }
    if(changed)await this.persist();
    this.lastMessage=`批量：新增 ${result.added} 篇，已在队列 ${result.existing} 篇，跳过已有结果 ${result.skipped} 篇，跳过中文 ${result.skippedChinese} 篇，无法加入 ${rejected.length} 篇。`;
    this.refreshViews();this.schedule();return result;
  },
  async stopBatch(members,{reason='user-batch'}={}){
    for(const member of members){
      const job=this.state.jobs[member.id];
      if(!job||job.attempt!==member.attempt)continue;
      if((QueueCore.pending.has(job.state)||job.resumePending)){delete job.resumePending;this.recordCancellation(job,reason);job.state="cancelled";await this.refreshResumeState(job);job.message=this.cancellationMessage(job);job.updatedAt=Date.now();}
      else if(job.state==="running"&&this.isRunning(job))this.cancelJob(job,reason);
    }
    await this.persist();this.refreshViews();this.schedule();
  },
  schedule(ms=250){
    if(!this.started)return;
    if(this.timer)ReaderTimers.clearTimeout(this.timer);
    this.timer=ReaderTimers.setTimeout(()=>{this.timer=null;this.tick().catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();});},ms);
  },
  async attachment(job){return Zotero.Items.getByLibraryAndKeyAsync(job.libraryID,job.key);},
  createWorker(job){
    const app=Object.create(this.app);app.state={...this.app.state,busy:false};app.taskWindows=new Set();app.windows=new Set();app.controller=null;app.activeRun=null;
    app.update=values=>{Object.assign(app.state,values);if(values.message)job.message=values.message;this.refreshViews();};
    if(this.app.options){const options=this.app.options();app.options=()=>({...options,pageLimit:job.inputSelection?.pageLimit===undefined?options.pageLimit:job.inputSelection.pageLimit});}
    const codex=Object.create(ReaderCodex);codex.app=app;codex.window=null;codex.active=null;codex.controller=null;codex.state={...ReaderCodex.state,busy:false,output:'',answer:'',attachment:null,templateID:job.templateID,reviewIssues:[],report:'',message:'',resultStatus:'',savedNoteKey:null,bibliography:null,deliveryPending:false,queued:false,editing:false,followJobID:null};
    codex.update=values=>{Object.assign(codex.state,values);if(values.message)job.message=values.message;ReaderCodex.syncWorker?.(job,codex);this.refreshViews();};
    codex.exclusive=async action=>{
      if(codex.active)throw CodexCore.error('BUSY','此篇文献仍在处理。');
      codex.controller=new AbortController();codex.update({busy:true});
      codex.active=Promise.resolve().then(()=>action(codex.controller.signal));
      try{return await codex.active;}finally{codex.active=null;codex.controller=null;codex.update({busy:false});}
    };
    return {job,app,codex,promise:null};
  },
  isRunning(job){return this.running.has(job.id)||this.activeJob===job;},
  recordCancellation(job,reason='user-item'){
    if(!job.cancelRequested){job.cancelReason=reason;job.cancelRequestedAt=new Date().toISOString();}job.cancelRequested=true;
  },
  cancellationMessage(job){
    const reasons={'user-pause':'任务已全部暂停','user-item':'此篇任务已由停止操作取消','user-batch':'本批次已被停止','user-all':'本次任务已被统一停止',shutdown:'Zotero 或插件关闭时任务中断','scope-change':'监听范围已改变','out-of-scope':'文献已移出监听范围','auto-disabled':'自动精读已关闭'};
    return (reasons[job.cancelReason]||'任务已停止，旧记录未注明触发来源')+'；'+(job.resumeAvailable?'草稿已保留，可继续检查。':'本次记录保留，尚无可续检的完整草稿。');
  },
  async refreshResumeState(job){
    job.resumeAvailable=false;job.resumeNeedsRepair=false;job.hasReadingDraft=false;
    if(!job.workflowPath)return false;
    try{
      const dir=PathUtils.parent(job.workflowPath),id=PathUtils.filename(dir);NoteCore.identity(id,'reading');
      if(job.workflowPath!==PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','readings',id,'workflow.json'))return false;
      const w=await this.app.readJSON(job.workflowPath);
      job.hasReadingDraft=await IOUtils.exists(PathUtils.join(dir,'draft.json'));
      job.resumeAvailable=!!w&&!job.notes?.reading?.key&&!job.languageSkipped&&!w.zoteroNotes&&['verification_incomplete','needs_review','verifying','correcting'].includes(w.status)&&job.hasReadingDraft;
      job.resumeNeedsRepair=w?.status==='needs_review';
      if(job.state==='cancelled'&&(job.errorCode==='CANCELLED'||job.cancelRequested))job.message=this.cancellationMessage(job);
      return job.resumeAvailable;
    }catch(_){return false;}
  },
  canResumeJob(job){return !!job.workflowPath&&job.hasReadingDraft!==false&&!job.notes?.reading?.key&&!job.languageSkipped&&!job.resumePending&&!this.isRunning(job)&&(['verification_incomplete','needs_review'].includes(job.state)||['cancelled','failed'].includes(job.state)&&job.resumeAvailable&&!job.languageSkipped);},
  cancelJob(job,reason='user-item'){this.recordCancellation(job,reason);if(job.resumePending){delete job.resumePending;job.state='cancelled';job.message=this.cancellationMessage(job);job.updatedAt=Date.now();this.persist().catch(()=>{});this.refreshViews();this.schedule();return;}const worker=this.running.get(job.id);if(worker)worker.codex.controller?.abort();else if(this.activeJob===job)ReaderCodex.controller?.abort();},
  updateActivity(){
    this.activeJob=this.running.values().next().value?.job||null;
    this.active=this.running.size?Promise.allSettled([...this.running.values()].map(w=>w.promise)):null;
  },
  async suggestAfterSave(job,result,worker,{force=false}={}){
    if(typeof ReaderClassifier==='undefined'||!force&&(!ReaderClassifier.enabled()||result.skipped||result.notes?.reading?.reused)||!['checked','edited'].includes(result.status))return null;
    if(this.state.paused||job.pauseRequested){this.deferClassification(job,result,force);return null;}
    job.phase='classification';job.classificationStatus='running';job.classificationError='';
    try{
      job.message=force?'笔记已保存，正在请求检查模型建议':'笔记已保存，正在准备归档选择';this.refreshViews();
      const proposal=await worker.codex.exclusive(signal=>ReaderClassifier.suggest(job,result,worker.codex,signal,{force}));
      if(!force&&['auto','auto-adjust'].includes(ReaderClassifier.mode())&&proposal?.status!=='confirmed')await ReaderClassifier.autoArchive(job,proposal,worker);
      job.classificationStatus=proposal?.status||'skipped';job.message=proposal?.status==='confirmed'?(job.message||'自动归档完成'):proposal?.status==='pending'?(proposal.requiresReview?'笔记已保存；已有分类的调整建议待你确认，当前归属保持不变':'笔记已保存；请查看推荐理由，可追加分类后确认'):'笔记已保存；可在“归档／添加分类”中继续选择';return proposal;
    }catch(e){if(job.pauseRequested){this.deferClassification(job,result,force);return null;}job.classificationStatus='failed';job.classificationError=this.app.safeError(e);job.message='笔记已保存；建议未完成：'+job.classificationError;return null;}
  },
  deferClassification(job,result,force=false){
    job.classificationPending=true;job.classificationForce=force;job.archiveSuggestion=result.archiveSuggestion;job.classificationStatus='paused';job.message='笔记已保存，归档已暂停；点击开始后继续。';
  },
  async requestClassification(id,{force=false,archiveSuggestion=null}={}){
    if(this.historyClearing.has(id))throw NoteCore.error('BUSY','正在清理此篇完成记录，请稍后更新推荐。');
    const job=this.state.jobs[id];if(typeof ReaderClassifier==='undefined'||!ReaderClassifier.eligible(job))throw NoteCore.error('CLASSIFY_UNFINISHED','请先完成精读并保存笔记，再生成分类建议。');
    if(this.running.has(id))throw NoteCore.error('BUSY','此篇仍在收尾，请稍后生成建议。');
    job.archiveSuggestion=archiveSuggestion;job.classificationPending=true;job.classificationForce=force;job.classificationError='';job.message=force?'已排队请求检查模型建议，尚未改变分类':'正在准备已有建议，尚未改变分类';job.updatedAt=Date.now();
    await this.persist();this.refreshViews();ReaderClassifier.render();this.schedule();
  },
  async runClassification(worker){
    const job=worker.job,force=job.classificationForce===true;delete job.pauseRequested;delete job.pausedByControl;job.classificationPending=false;job.classificationForce=false;job.cancelRequested=false;
    try{await this.persist();if(!this.started)return;await this.suggestAfterSave(job,{status:job.state==='imported'?'edited':'checked',notes:job.notes,archiveSuggestion:job.archiveSuggestion},worker,{force});}
    finally{if(!job.classificationPending)delete job.archiveSuggestion;job.updatedAt=Date.now();this.running.delete(job.id);this.updateActivity();ReaderCodex.syncWorker?.(job,worker.codex);await this.persist();this.refreshViews();ReaderClassifier.render();this.schedule();}
  },
  async freezeScope(job){
    const w=job.workflowPath?await this.app.readJSON(job.workflowPath):null,selection=w?.inputSelection||job.inputSelection||{mainKey:job.key,supplementKeys:[]};
    const limit=w?(Number(w.inputSources?.[0]?.pageLimit)||0):selection.pageLimit===undefined?(Number(this.app.options?.().pageLimit)||0):Number(selection.pageLimit);
    job.inputSelection={...selection,pageLimit:limit};
  },
  async runJob(worker){
    const {job}=worker;
    try{
      await this.persist();
      if(!this.started||job.cancelRequested||(job.trigger==='auto'&&!this.enabled()))throw CodexCore.error('CANCELLED','任务已停止');
      if(typeof ReaderLanguage!=='undefined')await ReaderLanguage.check(await this.attachment(job),job);
      await this.freezeScope(job);
      if(typeof ReaderCoordination!=='undefined'&&!await ReaderCoordination.enterJob(job,worker))return;
      const result=await this.execute(job,worker);
      job.state=result.status==='awaiting_import'?'awaiting_import':result.status==='verification_incomplete'?'verification_incomplete':result.status==='checked'?'done':result.notes?'imported':'needs_review';
      job.notes=result.notes;job.message=result.status==='verification_incomplete'?result.message:result.status==='awaiting_import'?'精读已完成，等待导入':result.status==='checked'?'已生成精读笔记':'草稿仍需核对，未自动导入';
      if(result.notes){job.message=result.message||result.cleanup?.message||'已保存精读笔记';await this.compactImported(job.workflowPath,result);}
      await this.suggestAfterSave(job,result,worker);
      return result;
    }catch(e){if(worker.coordination?.lost)e=worker.coordination.error;job.state=e.code==='LANGUAGE_SKIPPED'?'cancelled':!this.started&&!job.cancelRequested?'failed':e.code==='CANCELLED'||job.cancelRequested?'cancelled':'failed';job.languageSkipped=e.code==='LANGUAGE_SKIPPED';job.errorCode=e.code||'LOCAL';job.message=this.app.safeError(e);if(job.state==='cancelled'||job.state==='failed')await this.refreshResumeState(job);}
    finally{if(['verification_incomplete','needs_review'].includes(job.state))await this.refreshResumeState(job);if(typeof ReaderCoordination!=='undefined')await ReaderCoordination.exitJob(job,worker);job.updatedAt=Date.now();this.running.delete(job.id);this.updateActivity();ReaderCodex.syncWorker?.(job,worker.codex);await this.persist();this.refreshViews();if(typeof ReaderClassifier!=='undefined')ReaderClassifier.render();this.schedule();}
  },
  async tick(){
    this.app.assertIndexes?.();
    if(!this.started||this.ticking)return;
    this.ticking=true;
    try{
      if(this.attachmentMaintenanceBusy()||this.state.paused||this.starting||this.resumeEnqueueing||ReaderCodex.active||ReaderCleanup.active||ReaderCleanup.completedActive||ReaderNotes.pending||this.app.state.busy)return;
      let changed=false;
      for(const job of Object.values(this.state.jobs)){
        if(!QueueCore.pending.has(job.state)||(job.trigger==="auto"&&!this.enabled())||job.coordinationWaitUntil>Date.now())continue;
        try{
          const att=await this.attachment(job);
          if(!att||att.deleted||!att.isPDFAttachment())throw NoteCore.error("QUEUE_SOURCE","来源 PDF 不存在或已进入回收站。");
          if(job.trigger==='auto'&&((job.autoCollectionKey||'')!==this.collectionKey()||!await this.inScope(att))){this.recordCancellation(job,'out-of-scope');job.state='cancelled';job.scopeCancelled=true;job.message='文献已移出监听范围，未开始处理';changed=true;continue;}
          const inputs=await ReaderAttachments.attachments(att,job.inputSelection),stamps=[];
          for(const input of inputs){const path=await input.getFilePathAsync();stamps.push(path&&await IOUtils.exists(path)?await IOUtils.stat(path):null);}
          const stat=stamps.every(s=>s&&s.size>0)?{size:stamps.reduce((n,s)=>n+s.size,0),lastModified:stamps.map(s=>s.size+':'+s.lastModified).join('|')}:null;
          const was=job.state,stamp=job.fileStamp;
          const ready=QueueCore.ready(job,stat,Date.now(),this.settleMs);
          if(ready&&job.trigger==='auto'){
            let group=(await ReaderAttachments.collectItems([att],{preflight:true})).entries[0];
            if(!group||group.issue)throw NoteCore.error('ATTACHMENT_SELECTION',group?.issue||'无法读取文献附件。');
            let file=group.pdfs.find(f=>f.key===att.key);
            if(file?.supplement||file?.duplicateOf||!group.mainKey||group.mainKey!==att.key){
              group=(await ReaderAttachments.collectItems([att])).entries[0];
              if(!group||group.issue)throw NoteCore.error('ATTACHMENT_SELECTION',group?.issue||'无法确认最新附件选择。');
              file=group.pdfs.find(f=>f.key===att.key);
            }
            job.groupID=group.groupID;
            if(file?.supplement||file?.duplicateOf){job.state='cancelled';job.message=file.duplicateOf?'内容完全重复，自动精读已跳过':'补充材料默认不自动精读；需要时在文献附件选择中勾选。';}
            else if(!group.mainKey){job.state='awaiting_selection';job.message='无法确定唯一正文。请右键该文献开始精读，并选择正文 PDF。';}
            else if(group.mainKey!==att.key){job.state='cancelled';job.message='这篇文献的另一附件已作为正文，未重复加入。';}
            else {job.inputSelection={mainKey:att.key,supplementKeys:[]};job.title=group.display;}
            if(job.state==='queued'){
              const preview=await ReaderSaved.matching(att,job.inputSelection,{preflight:true});
              const saved=preview?await ReaderSaved.matching(att,job.inputSelection):null;
              if(saved){job.state=saved.status==='edited'?'imported':'done';job.notes={reading:{key:saved.note.key,id:saved.note.id}};job.message='已有 Zotero 精读笔记，未重复处理';}
            }
          }
          changed=changed||was!==job.state||stamp!==job.fileStamp;
        }catch(e){job.state="failed";job.message=this.app.safeError(e);job.errorCode=e.code||"LOCAL";changed=true;}
      }
      if(changed)await this.persist();
      const limit=ReaderPreferences.workflow().papers;
      while(this.running.size<limit&&!this.state.paused&&this.started&&!this.resumeEnqueueing){
        const resume=Object.values(this.state.jobs).find(j=>j.resumePending&&!this.isRunning(j)&&!(j.coordinationWaitUntil>Date.now()));
        if(resume){await this.dispatchResume(resume);continue;}
        const job=QueueCore.next(this.state,{enabled:this.enabled(),paused:this.state.paused,busy:Boolean(ReaderCodex.active||this.app.state.busy)});
        if(!job)break;
        job.state='running';job.message='正在准备精读';job.updatedAt=Date.now();
        const worker=this.createWorker(job);this.running.set(job.id,worker);worker.promise=this.runJob(worker);this.updateActivity();this.refreshViews();
      }
      while(this.running.size<limit&&!this.state.paused){
        const job=Object.values(this.state.jobs).find(j=>j.classificationPending&&!this.running.has(j.id));if(!job)break;
        if(typeof ReaderClassifier==='undefined'||!ReaderClassifier.eligible(job)){job.classificationPending=false;changed=true;continue;}
        const worker=this.createWorker(job);this.running.set(job.id,worker);worker.promise=this.runClassification(worker);this.updateActivity();this.refreshViews();ReaderClassifier.render();
      }
      if(changed)await this.persist();
    }finally{
      this.ticking=false;
      if(this.started&&!this.state.paused&&this.running.size<ReaderPreferences.workflow().papers&&Object.values(this.state.jobs).some(j=>j.resumePending||j.classificationPending||QueueCore.pending.has(j.state)&&(j.trigger==="manual"||this.enabled())))this.schedule(this.pollMs);
    }
  },
  async execute(job,worker=null){
    this.app.assertIndexes?.();
    const codex=worker?.codex||ReaderCodex,app=worker?.app||this.app;
    return codex.exclusive(async signal=>{
      const att=await this.attachment(job),destination=await this.notes.destination(att);
      if(job.skipChinese&&BatchCore.languageInfo(await this.batchLanguage(att)).chinese)throw NoteCore.error('LANGUAGE_SKIPPED','本批已跳过：当前 Zotero 语言字段标为中文，未解析或调用模型。');
      if(job.trigger==='auto'&&((job.autoCollectionKey||'')!==this.collectionKey()||!await this.inScope(att)))throw NoteCore.error('CANCELLED','文献已移出监听范围，未开始处理。');
      if(job.trigger==='auto'){
        const current=(await ReaderAttachments.collectItems([att])).entries[0],file=current?.pdfs.find(f=>f.key===att.key);
        if(!current||current.issue||!current.mainKey)throw NoteCore.error('ATTACHMENT_SELECTION',current?.issue||'开始前无法确认正文，请重新选择。');
        if(file?.supplement||file?.duplicateOf||current.mainKey!==att.key)throw CodexCore.error('CANCELLED','开始前附件选择已变化，本次未重复读取或将补充材料作为正文。');
      }
      job.deliveryMode=job.deliveryMode||ReaderPreferences.delivery();
      MineruCore.cancelled(signal);
      app.controller=codex.controller;
      app.update({busy:true,title:job.title,message:"准备解析 PDF…"});
      codex.update({title:job.title,attachment:att,savedNoteKey:null,inputSelection:job.inputSelection,groupID:job.groupID,cache:null,templateID:job.templateID,
        answer:"",report:"",phase:"parsing",resultStatus:"",view:"reading",output:"",deliveryPending:false,source:job.deliveryMode==="manual"?"先生成 Markdown":"完成后导入笔记",message:"准备解析 PDF…"});
      try{
        // A synced PDF may only become local after batch selection. Recheck then.
        if(job.skipSaved&&!job.workflowPath){
          const saved=await ReaderSaved.matching(att,job.inputSelection);
          if(saved){const message='已有 Zotero 精读笔记，未重复解析或调用模型。';codex.update({savedNoteKey:saved.note.key,resultStatus:saved.status,source:'已有 Zotero 精读笔记',message,deliveryPending:false});return {status:saved.status,notes:{reading:{key:saved.note.key,id:saved.note.id,reused:true}},skipped:true,message};}
        }
        // Retry a completed local result without another model request.
        const previous=job.workflowPath?await app.readJSON(job.workflowPath):null;
        if(previous&&["checked","needs_review","verification_incomplete"].includes(previous.status)){
          await ReaderAttachments.validateWorkflow(previous,att);
          if(previous.status!=="checked")return this.unresolved(job,codex);
          if(job.deliveryMode==="manual"||ReaderPreferences.delivery()==="manual")return this.awaitImport(job,codex);
          job.phase="notes";job.message="正在生成 Zotero 笔记";this.refreshViews();
          const result=await this.notes.save(job.workflowPath,att,{validateTask:()=>{if(job.cancelRequested)throw CodexCore.error('CANCELLED','任务已暂停或停止，完整结果保留。');}});
          this.noteSaved(job.workflowPath,result);return result;
        }
        job.phase="parsing";job.message="解析 PDF";await this.persist();
        const inputSources=await ReaderAttachments.sources(att,job.inputSelection,signal),documents=[];
        let cache,totalChars=0;
        for(const source of inputSources){
          const attachment=await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID,source.key);
          job.message='解析'+source.label;this.refreshViews();
          const parsed=await app.parseAttachment(attachment,false,signal);
          if(parsed.manifest.source.sha256!==source.sha256)throw NoteCore.error('PDF_CHANGED','所选 PDF 在准备期间发生变化，请重新精读。');
          const assembled=await app.readModelSource(parsed,signal),markdown=assembled.markdown;totalChars+=markdown.length;
          source.textAssembly=assembled.diagnostics;
          if(totalChars>CodexCore.MAX_PAPER_CHARS)throw NoteCore.error('TEXT_SIZE','正文与所选补充材料合计过长，未发送模型。请减少补充材料。');
          documents.push({...source,markdown});
          source.cacheGeneration=PathUtils.filename(parsed.dir);source.markdownSHA256=parsed.manifest.markdownSha256;
          if(source.role==='main'){cache=parsed;codex.update({cache});}
        }
        const paper=ReadingCore.paperSet(documents,job.title);
        job.phase="reading";await this.persist();
        try{
          await codex.readPaper(paper,{source:cache.manifest.source,inputSources,inputSelection:job.inputSelection||{mainKey:att.key,supplementKeys:[]},groupID:job.groupID,bibliography:destination.bibliography,cacheGeneration:PathUtils.filename(cache.dir),markdownSHA256:cache.manifest.markdownSha256,sourceAssemblyVersion:SourceCore.VERSION,queueJobID:job.id},signal,
            {created:async path=>{job.workflowPath=path;await this.persist();}});
        }catch(e){
          if(signal.aborted)throw CodexCore.error("CANCELLED","已停止本次任务，本地草稿保留，未继续生成笔记。");
          const workflow=job.workflowPath?await app.readJSON(job.workflowPath):null;
          if(workflow?.status!=="verification_incomplete")throw e;
          job.errorCode=e.code||"VERIFICATION";
        }
        MineruCore.cancelled(signal);
        const finalWorkflow=await app.readJSON(job.workflowPath);
        if(finalWorkflow?.status!=="checked")return this.unresolved(job,codex);
        if(job.deliveryMode==="manual"||ReaderPreferences.delivery()==="manual")return this.awaitImport(job,codex);
        job.phase="notes";job.message="正在生成 Zotero 笔记";await this.persist();this.refreshViews();
        const result=await this.notes.save(job.workflowPath,att,{validateTask:()=>{if(job.cancelRequested)throw CodexCore.error('CANCELLED','任务已暂停或停止，完整结果保留。');}});
        this.noteSaved(job.workflowPath,result);
        return result;
      }finally{app.controller=null;app.update({busy:false});}
    });
  },
  async unresolved(job,codex=ReaderCodex){
    const workflow=await this.app.readJSON(job.workflowPath),incomplete=workflow?.status==='verification_incomplete';
    const status=incomplete?'verification_incomplete':'needs_review',message=incomplete?ReadingCore.incompleteMessage(workflow.errorCode):'仍有重要内容需要核对，请展开问题说明；当前草稿未导入。';
    codex.update({output:job.workflowPath,deliveryPending:true,resultStatus:status,message,...(incomplete?{report:message}:{})});
    return {status,message};
  },
  async awaitImport(job,codex=ReaderCodex){
    await this.persist();
    codex.update({output:job.workflowPath,resultStatus:'checked',deliveryPending:true,message:"精读内容已保存为 Markdown，检查后即可导入。"});
    return {status:"awaiting_import"};
  },
  readyForBulkSave(job){
    const view=ReaderCodex.state||{};
    return job.state==='awaiting_import'&&!!job.workflowPath&&!job.notes?.reading?.key&&!this.isRunning(job)&&!this.historyClearing.has(job.id)&&!(view.editing&&(view.followJobID===job.id||view.output===job.workflowPath));
  },
  async saveReadyNotes(){
    if(this.bulkSaving)return this.bulkSaving;
    const pauseEpoch=this.savePauseEpoch;
    const jobs=Object.values(this.state.jobs).filter(j=>this.readyForBulkSave(j)).map(job=>({job,id:job.id,path:job.workflowPath}));
    this.bulkSaveProgress={total:jobs.length,completed:0};this.bulkSaveMessage='正在保存已通过检查的笔记…';
    this.bulkSaving=Promise.resolve().then(async()=>{
      if(ReaderCleanup.active)await ReaderCleanup.active;if(ReaderCleanup.completedActive)await ReaderCleanup.completedActive;
      const result={saved:0,reused:0,skipped:0,failed:0,details:[]};
      for(const snapshot of jobs){
        const {job,id,path}=snapshot;
        const validateTask=()=>{if(!this.started||pauseEpoch!==this.savePauseEpoch||this.state.jobs[id]!==job||job.workflowPath!==path||!this.readyForBulkSave(job))throw NoteCore.error('NOTE_BULK_STATE','任务已变化、正在编辑或插件正在关闭，本次跳过。');};
        try{validateTask();const saved=await this.importResult(path,{requireChecked:true,validateTask});if(saved.status!=='checked')throw NoteCore.error('NOTE_BULK_REVIEW','稿件需要单独核对，未批量保存。');result.saved++;if(saved.notes?.reading?.reused)result.reused++;}
        catch(e){
          if(this.state.jobs[id]===job&&job.notes?.reading?.key&&['done','imported'].includes(job.state)){result.saved++;result.details.push({id,title:job.title||job.key,reason:'笔记已保存，后续处理需检查：'+this.app.safeError(e)});}
          else{const skipped=['NOTE_BULK_STATE','NOTE_BULK_REVIEW','NOTE_CHANGED','NOTE_UNRESOLVED','BUSY'].includes(e.code);if(skipped)result.skipped++;else result.failed++;result.details.push({id,title:job.title||job.key,reason:this.app.safeError(e)});}
        }
        this.bulkSaveProgress.completed++;this.refreshViews();
      }
      this.bulkSaveMessage=`已保存 ${result.saved} 篇；跳过 ${result.skipped} 篇；未保存成功 ${result.failed} 篇。`+(result.details.length?'\n'+result.details.map(x=>x.title+'：'+x.reason).join('\n'):'');return result;
    });
    this.refreshViews();try{return await this.bulkSaving;}finally{this.bulkSaving=null;this.bulkSaveProgress=null;this.refreshViews();this.schedule();}
  },
  async importResult(workflowPath,{requireChecked=false,validateTask=null}={}){
    validateTask?.();
    if([...this.running.values()].some(w=>w.job.workflowPath===workflowPath))throw NoteCore.error('BUSY','此篇仍在处理，请等待任务结束后导入。');
    const workflow=await this.app.readJSON(workflowPath);
    const saved=ReaderSaved.records[PathUtils.filename(PathUtils.parent(workflowPath))];
    const source=workflow?.source||(saved?{libraryID:saved.libraryID,key:saved.attachmentKey}:null);
    if(!source)throw NoteCore.error("NOTE_SOURCE","精读结果缺少来源信息。");
    const att=await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID,source.key);
    const result=await this.notes.save(workflowPath,att,{preferMarkdown:true,requireChecked,validateTask});
    const id=QueueCore.key(att.libraryID,att.key),job=this.state.jobs[id];
    if(job?.workflowPath===workflowPath){job.state=result.status==="checked"?"done":"imported";job.notes=result.notes;job.message=result.cleanup?.message||"已导入精读笔记";job.updatedAt=Date.now();await this.persist();}
    await this.compactImported(workflowPath,result);this.noteSaved(workflowPath,result);
    if(job?.notes?.reading?.key===result.notes?.reading?.key&&typeof ReaderClassifier!=='undefined'&&ReaderClassifier.enabled())await this.requestClassification(job.id,{archiveSuggestion:result.archiveSuggestion});
    this.refreshViews();return result;
  },
  noteSaved(path,result){
    if(ReaderCodex.state.output!==path)return;
    ReaderCodex.update({deliveryPending:false,resultStatus:result.status,source:'已保存为 Zotero 笔记',savedNoteKey:result.notes?.reading?.key,
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
  resumeCandidate(job,{probe=false}={}){
    const view=ReaderCodex.state||{};
    // Persisted draft flags may predate generation; inspect disk before trusting them.
    const eligible=probe?!!job.workflowPath&&!job.notes?.reading?.key&&!job.languageSkipped&&!job.resumePending&&!this.isRunning(job)&&['verification_incomplete','needs_review','cancelled','failed'].includes(job.state):this.canResumeJob(job);
    return eligible&&!this.historyClearing.has(job.id)&&!ReaderNotes.saving?.(job.workflowPath)&&!(view.editing&&(view.followJobID===job.id||view.output===job.workflowPath));
  },
  async checkResumeMarkdown(job){
    const w=await this.app.readJSON(job.workflowPath),name=w?.resultFile||'draft.md';
    if(!['draft.md','reading.md','review-needed.md'].includes(name))throw NoteCore.error('NOTE_PATH','草稿文件名无效，未加入续检。');
    const path=PathUtils.join(PathUtils.parent(job.workflowPath),name),hash=w?.resultFile?w.resultSHA256:w?.draftSHA256;
    if(await IOUtils.exists(path)&&(!hash||await this.app.sha256(path)!==hash))throw NoteCore.error('MANUAL_EDIT','草稿有人工修改，请单独核对，未自动覆盖。');
  },
  async continueAll(){
    if(this.resumeEnqueueing)return this.resumeEnqueueing;
    const epoch=this.resumeEpoch,snapshots=Object.values(this.state.jobs).filter(j=>this.resumeCandidate(j,{probe:true})).map(job=>({job,path:job.workflowPath,state:job.state}));
    this.state.paused=false;this.bulkResumeMessage='正在核对可继续的草稿…';
    this.resumeEnqueueing=Promise.resolve().then(async()=>{
      const result={queued:0,skipped:0,details:[]};
      if(ReaderCleanup.completedActive)await ReaderCleanup.completedActive;
      if(ReaderCleanup.active)await ReaderCleanup.active;
      for(const {job,path,state}of snapshots){
        try{
          const valid=()=>this.started&&epoch===this.resumeEpoch&&this.state.jobs[job.id]===job&&job.workflowPath===path&&job.state===state&&this.resumeCandidate(job,{probe:true});
          if(!valid())throw NoteCore.error('NOTE_STATE','任务已变化或续检已停止，本次跳过。');
          if(!await this.refreshResumeState(job))throw NoteCore.error('NOTE_STATE','缺少可继续检查的完整草稿，本次保留。');
          await this.checkResumeMarkdown(job);
          if(!valid()||!this.canResumeJob(job))throw NoteCore.error('NOTE_STATE','任务已变化或正在编辑，本次跳过。');
          job.resumePending={path,repair:job.state==='needs_review'||job.resumeNeedsRepair||!!(job.pauseRequested&&job.resumeRepair)};job.cancelRequested=false;delete job.cancelReason;delete job.cancelRequestedAt;
          job.message=job.resumePending.repair?'已排队，等待自动修订并复查':'已排队，等待继续检查现有草稿';job.updatedAt=Date.now();result.queued++;
        }catch(e){result.skipped++;result.details.push((job.title||job.key)+'：'+this.app.safeError(e));}
      }
      await this.persist();this.bulkResumeMessage=`已加入续检队列 ${result.queued} 篇`+(result.skipped?`；跳过 ${result.skipped} 篇`:'')+'。'+(result.details.length?'\n'+result.details.join('\n'):'');return result;
    });
    this.refreshViews();try{return await this.resumeEnqueueing;}finally{this.resumeEnqueueing=null;this.refreshViews();this.schedule();}
  },
  async dispatchResume(job){
    const pending=job.resumePending;if(!pending)return;
    try{
      if(job.workflowPath!==pending.path||!await this.refreshResumeState(job))throw NoteCore.error('NOTE_STATE','草稿已变化或不再可续检，未重新精读。');
      await this.checkResumeMarkdown(job);
      if(!this.started||this.state.paused||this.resumeEnqueueing||this.running.size>=ReaderPreferences.workflow().papers||this.isRunning(job))return;
      if(this.state.jobs[job.id]!==job||job.resumePending!==pending||job.workflowPath!==pending.path)return;
      const view=ReaderCodex.state||{};
      if(job.notes?.reading?.key||ReaderNotes.saving?.(job.workflowPath)||view.editing&&(view.followJobID===job.id||view.output===job.workflowPath))throw NoteCore.error('BUSY','此篇已保存或正在编辑，已跳过自动续检。');
      delete job.pauseRequested;delete job.pausedByControl;this.startResumeJob(job,pending.repair||job.resumeNeedsRepair);
    }catch(e){if(this.state.jobs[job.id]===job&&job.resumePending===pending){delete job.resumePending;job.message='未开始续检：'+this.app.safeError(e);job.updatedAt=Date.now();await this.persist();this.refreshViews();}}
  },
  async continueJob(id,{repair=false}={}){
    this.app.assertIndexes?.();
    if(ReaderCleanup.completedActive)await ReaderCleanup.completedActive;
    const job=this.state.jobs[id];if(job&&this.isRunning(job))return this.running.get(id)?.promise;
    if(!job||!job.workflowPath||!['verification_incomplete','needs_review','failed','cancelled'].includes(job.state)||job.languageSkipped)throw NoteCore.error('NOTE_STATE','当前任务没有可续检的草稿。');
    const path=job.workflowPath;
    if(!await this.refreshResumeState(job))throw NoteCore.error('NOTE_STATE','未找到可继续核验的完整草稿；尚未生成草稿时请重新开始精读。');
    if(this.state.jobs[id]!==job||job.workflowPath!==path)throw NoteCore.error('NOTE_STATE','任务记录已变化，请重新打开。');
    if(this.isRunning(job))return this.running.get(id)?.promise;
    repair=repair||job.resumeNeedsRepair;
    if(!this.resumeCandidate(job))throw NoteCore.error('BUSY','此篇正在编辑、保存或已排队，请稍后继续。');
    if(this.running.size>=ReaderPreferences.workflow().papers)throw NoteCore.error('BUSY','正在处理的篇数已达设置上限，请稍后继续检查。');
    if(this.attachmentMaintenanceBusy())throw NoteCore.error('BUSY','正在整理附件，请稍后继续。');
    return this.startResumeJob(job,repair).promise;
  },
  startResumeJob(job,repair){
    delete job.resumePending;delete job.pauseRequested;delete job.pausedByControl;job.resumeRepair=repair;const worker=this.createWorker(job);job.state='running';job.cancelRequested=false;delete job.cancelReason;delete job.cancelRequestedAt;job.resumeAvailable=false;job.message='正在继续检查现有草稿';job.updatedAt=Date.now();
    this.running.set(job.id,worker);
    worker.promise=(async()=>{
      try{
        await this.persist();
        if(!this.started||job.cancelRequested)throw CodexCore.error('CANCELLED','续检已停止，草稿保留。');
        if(typeof ReaderLanguage!=='undefined')await ReaderLanguage.check(await this.attachment(job),job);
        await this.freezeScope(job);
        if(typeof ReaderCoordination!=='undefined'&&!await ReaderCoordination.enterJob(job,worker)){if(job.state==='queued')job.resumePending={path:job.workflowPath,repair};return;}
        await worker.codex.resumeVerification(job.workflowPath,{repair});
        const w=await this.app.readJSON(job.workflowPath);
        if(w.status==='checked'){
          if(ReaderPreferences.delivery()==='manual'){job.state='awaiting_import';job.message='检查完成，等待导入';}
          else{const att=await this.attachment(job),result=await this.notes.save(job.workflowPath,att,{validateTask:()=>{if(job.cancelRequested)throw CodexCore.error('CANCELLED','任务已暂停或停止，完整结果保留。');}});job.state='done';job.notes=result.notes;job.message='复查通过，笔记已保存';await this.compactImported(job.workflowPath,result);await this.suggestAfterSave(job,result,worker);}
        }else{job.state='needs_review';job.message='仍有需要修订的内容，草稿已保留';}
      }catch(e){if(worker.coordination?.lost)e=worker.coordination.error;const w=await this.app.readJSON(job.workflowPath);if(w&&this.app.errorDiagnostic){w.lastResumeFailure={at:new Date().toISOString(),...this.app.errorDiagnostic(e)};try{await this.app.writeJSON(job.workflowPath,w);}catch(_){}}job.state=e.code==='LANGUAGE_SKIPPED'||e.code==='CANCELLED'||job.cancelRequested?'cancelled':w?.status==='verification_incomplete'?'verification_incomplete':'failed';job.languageSkipped=e.code==='LANGUAGE_SKIPPED';job.message=this.app.safeError(e);job.errorCode=e.code||'INTERNAL';await this.refreshResumeState(job);}
      finally{if(['verification_incomplete','needs_review'].includes(job.state))await this.refreshResumeState(job);if(typeof ReaderCoordination!=='undefined')await ReaderCoordination.exitJob(job,worker);if(!job.pauseRequested)delete job.resumeRepair;this.running.delete(job.id);this.updateActivity();ReaderCodex.syncWorker?.(job,worker.codex);job.updatedAt=Date.now();await this.persist();this.refreshViews();if(typeof ReaderClassifier!=='undefined')ReaderClassifier.render();this.schedule();}
    })();this.updateActivity();this.refreshViews();return worker;
  },
  historyHidden(job){return !!job.historyClearedAt&&['done','imported'].includes(job.state)&&!this.isRunning(job)&&!job.classificationPending;},
  completedProposal(job){
    if(!job||this.historyHidden(job)||!['done','imported'].includes(job.state)||!job.notes?.reading?.key||this.isRunning(job)||job.classificationPending||job.classificationStatus==='running')return null;
    if(typeof ReaderClassifier==='undefined')return null;
    return Object.values(ReaderClassifier.proposals).find(p=>p.jobID===job.id&&p.noteKey===job.notes.reading.key&&p.status==='confirmed')||null;
  },
  async hideCompletedHistory(job,proposal,runID){
    if(this.state.jobs[job.id]!==job||this.completedProposal(job)!==proposal)throw NoteCore.error('HISTORY_CHANGED','任务状态已变化，记录保留。');
    const compact={id:job.id,libraryID:job.libraryID,key:job.key,trigger:job.trigger,state:job.state,attempt:job.attempt||1,createdAt:job.createdAt,updatedAt:Date.now(),notes:job.notes,savedRunID:runID,archiveConfirmedAt:proposal.confirmedAt,historyClearedAt:new Date().toISOString(),...(job.inputSelection?{inputSelection:job.inputSelection}:{}),...(job.groupID?{groupID:job.groupID}:{}),...(job.autoCollectionKey?{autoCollectionKey:job.autoCollectionKey}:{})};
    this.state.jobs[job.id]=compact;
    try{await this.persist();}catch(e){if(this.state.jobs[job.id]===compact)this.state.jobs[job.id]=job;this.refreshViews();throw e;}
    this.refreshViews();return compact;
  },
  async retryFailed(){
    for(const job of Object.values(this.state.jobs))if(job.state==="failed"&&!job.resumePending&&(job.trigger==="manual"||this.enabled())){
      job.state="waiting_file";job.message="等待重试";job.cancelRequested=false;job.fileStamp=null;job.stableSince=null;
    }
    await this.persist();this.refreshViews();this.schedule();
  },
  queueActive(){
    return !!(this.running.size||this.bulkSaving||!this.state.paused&&(this.starting||this.resumeEnqueueing||Object.values(this.state.jobs).some(j=>j.resumePending||j.classificationPending||QueueCore.pending.has(j.state)&&(j.trigger==='manual'||this.enabled()))));
  },
  toggleRun(){if(this.pausing)return this.pausing;return this.queueActive()?this.pauseAll():this.startAll();},
  async startAll(){
    if(this.starting)return this.starting;if(this.pausing)return this.pausing;
    const epoch=this.resumeEpoch;this.state.paused=false;this.lastMessage='';
    this.starting=Promise.resolve().then(async()=>{
      let restarted=0;const restartSkipped=[];
      for(const job of Object.values(this.state.jobs)){
        if(!this.started||this.state.paused||epoch!==this.resumeEpoch)return;
        if(!(job.pausedByControl||['cancelled','failed'].includes(job.state))||this.isRunning(job)||job.resumePending||job.notes?.reading?.key||job.languageSkipped||job.scopeCancelled||['scope-change','out-of-scope','auto-disabled'].includes(job.cancelReason)||job.trigger==='auto'&&!this.enabled())continue;
        const view=ReaderCodex.state||{};
        if(this.historyClearing.has(job.id)||ReaderNotes.saving?.(job.workflowPath)||view.editing&&(view.followJobID===job.id||view.output===job.workflowPath))continue;
        const path=job.workflowPath;
        await this.refreshResumeState(job);
        if(!this.started||this.state.paused||epoch!==this.resumeEpoch||this.state.jobs[job.id]!==job||job.workflowPath!==path)return;
        if(job.resumeAvailable)continue;
        const w=path?await this.app.readJSON(path):null;
        if(!this.started||this.state.paused||epoch!==this.resumeEpoch)return;
        if(w?.zoteroNotes)continue;
        if(w?.status==='checked'||!job.hasReadingDraft&&(!path||['generating','generation_failed'].includes(w?.status))){
          try{if(path)await this.checkResumeMarkdown(job);}catch(e){restartSkipped.push((job.title||job.key)+'：'+this.app.safeError(e));continue;}
          const latestView=ReaderCodex.state||{};
          if(!this.started||this.state.paused||epoch!==this.resumeEpoch||this.state.jobs[job.id]!==job||job.workflowPath!==path)return;
          if(this.isRunning(job)||job.resumePending||job.notes?.reading?.key||ReaderNotes.saving?.(path)||latestView.editing&&(latestView.followJobID===job.id||latestView.output===path))continue;
          job.state='waiting_file';job.cancelRequested=false;delete job.pauseRequested;delete job.pausedByControl;delete job.cancelReason;delete job.cancelRequestedAt;job.fileStamp=null;job.stableSince=null;
          job.message=w?.status==='checked'?'等待保存已完成的结果':'等待继续；尚未完成的初稿将重新生成';job.updatedAt=Date.now();restarted++;
        }
      }
      if(!this.started||this.state.paused||epoch!==this.resumeEpoch)return;
      const result=await this.continueAll();result.restarted=restarted;result.skipped+=restartSkipped.length;result.details.push(...restartSkipped);
      if(restarted)this.bulkResumeMessage+=` 已重新排队 ${restarted} 篇中断任务。`;
      if(restartSkipped.length)this.bulkResumeMessage+='\n'+restartSkipped.join('\n');
      return result;
    });
    this.refreshViews();try{return await this.starting;}finally{this.starting=null;this.refreshViews();this.schedule();}
  },
  async pauseAll(){
    if(this.pausing)return this.pausing;
    this.state.paused=true;this.resumeEpoch++;this.savePauseEpoch++;
    const workers=[...this.running.values()];
    for(const job of Object.values(this.state.jobs))if(job.resumePending)job.message='已暂停，点击开始后继续检查';
    for(const worker of workers){worker.job.pauseRequested=true;worker.job.pausedByControl=true;this.cancelJob(worker.job,'user-pause');worker.app?.controller?.abort();}
    this.lastMessage='正在暂停全部任务，保留已有草稿…';
    this.pausing=Promise.resolve().then(async()=>{
      await this.persist();
      await Promise.allSettled([...workers.map(w=>w.promise),this.starting,this.resumeEnqueueing,this.bulkSaving].filter(Boolean));
      for(const {job}of workers){
        if(this.state.jobs[job.id]!==job||!job.pausedByControl)continue;
        if(job.notes?.reading?.key){delete job.pausedByControl;if(!job.classificationPending)delete job.pauseRequested;continue;}
        if(job.state==='awaiting_import'){delete job.pausedByControl;delete job.pauseRequested;continue;}
        await this.refreshResumeState(job);job.message=job.resumeAvailable?'已暂停，草稿已保留；点击开始后继续检查。':job.hasReadingDraft?'已暂停，草稿已保留。':'已暂停；尚未完成的初稿将在下次开始时重新生成。';
      }
      this.lastMessage='已全部暂停，点击“开始”继续。';this.bulkResumeMessage='';await this.persist();
    });
    this.refreshViews();try{return await this.pausing;}finally{this.pausing=null;this.refreshViews();}
  },
  async togglePaused(){this.state.paused=!this.state.paused;await this.persist();this.refreshViews();this.schedule();},
  stopCurrent(reason='user-all'){this.resumeEpoch++;for(const job of Object.values(this.state.jobs))if(job.resumePending)this.cancelJob(job,reason);for(const w of this.running.values())this.cancelJob(w.job,reason);if(!this.running.size&&this.activeJob)this.cancelJob(this.activeJob,reason);},
  async populateCollections(win){
    if(win.closed)return;const select=win.document.getElementById('zri-auto-collection');if(!select)return;
    const add=(value,label)=>{const n=win.document.createXULElement('menuitem');n.setAttribute('value',value);n.setAttribute('label',label);select.menupopup.appendChild(n);};
    select.menupopup.replaceChildren();add('','全部新增 PDF（当前个人文库）');
    const collections=Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID,true),key=this.collectionKey();
    for(const c of collections){
      const names=[c.name],seen=new Set([c.id]);let p=c.parentID;
      while(p&&!seen.has(p)){seen.add(p);const parent=Zotero.Collections.get(p);if(!parent)break;names.unshift(parent.name);p=parent.parentID;}
      add(c.key,names.join(' / '));
    }
    if(key&&!collections.some(c=>c.key===key))add(key,'所选分类不存在，请重新选择');
    select.value=key;
  },
  bindPreferences(win){
    const get=id=>win.document.getElementById("zri-auto-"+id);
    if(!get("enabled")||get("enabled").dataset.bound)return;
    get("enabled").dataset.bound="true";this.views.add(win);win.addEventListener("unload",()=>this.views.delete(win),{once:true});
    get("enabled").addEventListener("change",()=>this.setEnabled(get("enabled").checked).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}));
    this.populateCollections(win).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();});
    get('collection').addEventListener('command',()=>this.setCollection(get('collection').value).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}));
    get('collections-refresh').addEventListener('click',()=>this.populateCollections(win).catch(()=>{}));
    const papers=win.document.getElementById('zri-workflow-papers'),repair=win.document.getElementById('zri-workflow-repairs'),automatic=win.document.getElementById('zri-workflow-autoRepair'),options=ReaderPreferences.workflow();
    if(papers){papers.value=options.papers;papers.addEventListener('change',()=>{papers.value=WorkflowCore.limits({papers:papers.value}).papers;Zotero.Prefs.set(this.app.pref+'workflow.papers',Number(papers.value),true);this.schedule();});}
    if(repair&&automatic){
      automatic.checked=options.repairs>0;repair.value=options.repairs||2;repair.disabled=!automatic.checked;
      const saveRepair=()=>{repair.value=Math.max(1,WorkflowCore.limits({repairs:repair.value}).repairs);repair.disabled=!automatic.checked;Zotero.Prefs.set(this.app.pref+'workflow.repairs',Number(repair.value),true);Zotero.Prefs.set(this.app.pref+'workflow.autoRepair',automatic.checked,true);};
      automatic.addEventListener('change',saveRepair);repair.addEventListener('change',saveRepair);
    }
    get("template").value="general";
    get("template").addEventListener("command",()=>Zotero.Prefs.set(this.app.pref+"auto.template",get("template").value,true));
    get("pause").addEventListener("click",()=>this.toggleRun().catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}));
    get("retry").addEventListener("click",()=>this.retryFailed().catch(()=>{}));
    get('save-ready')?.addEventListener('click',()=>this.saveReadyNotes().catch(e=>{this.bulkSaveMessage=this.app.safeError(e);this.refreshViews();}));
    this.refreshViews();
  },
  refreshViews(){
    if(typeof ReaderBatch!=="undefined")ReaderBatch.render();
    const labels={waiting_file:"等待文件",queued:"排队中",running:"处理中",done:"已保存笔记",imported:'已导入人工稿',needs_review:"草稿待复核",verification_incomplete:'检查未完成',awaiting_import:"等待保存笔记",awaiting_selection:"待选择正文",failed:"失败",cancelled:"已停止或跳过"};
    for(const win of [...this.views]){
      if(win.closed){this.views.delete(win);continue;}
      const get=id=>win.document.getElementById("zri-auto-"+id);if(!get("enabled"))continue;
      get("enabled").checked=this.enabled();get("pause").textContent=this.pausing?"正在暂停…":this.queueActive()?"全部暂停":"开始";get("pause").disabled=!!this.pausing;get("pause").title=this.queueActive()?"暂停当前运行和排队中的任务，保留已有草稿":"开始队列并继续已有草稿；待复核稿自动修订并复查";
      const jobs=Object.values(this.state.jobs).filter(j=>!this.historyHidden(j)).sort((a,b)=>b.updatedAt-a.updatedAt);
      const retryable=jobs.some(j=>j.state==='failed'&&!j.resumePending&&(j.trigger==='manual'||this.enabled()));get('retry').hidden=!retryable;const management=get('management');if(management){management.hidden=!retryable;if(management.hidden)management.open=false;}
      const continueStatus=get('continue-status');
      if(continueStatus){continueStatus.hidden=!this.bulkResumeMessage;continueStatus.textContent=this.bulkResumeMessage;}
      const saveReady=get('save-ready'),saveStatus=get('save-status');
      if(saveReady){const count=jobs.filter(j=>this.readyForBulkSave(j)).length;saveReady.hidden=!count&&!this.bulkSaving;saveReady.disabled=!!this.bulkSaving;saveReady.textContent=this.bulkSaving?`正在保存（${this.bulkSaveProgress?.completed||0}/${this.bulkSaveProgress?.total||0}）`:`一键保存笔记（${count} 篇）`;}
      if(saveStatus){saveStatus.hidden=!this.bulkSaveMessage;saveStatus.textContent=this.bulkSaveMessage;}
      const pending=jobs.filter(j=>["waiting_file","queued","running"].includes(j.state)||j.resumePending||j.classificationPending||this.running.has(j.id));
      get("status").textContent=(this.lastMessage?this.lastMessage+"\n":"")+`等待或处理中：${pending.length} 项。`+(this.state.paused?"队列已暂停，点击“开始”继续。":"");
      const visible=[...pending,...jobs.filter(j=>!pending.includes(j))].slice(0,12);
      const actions=get('actions');if(actions){
        const opened=new Set([...actions.querySelectorAll('details[open][data-job-more]')].map(n=>n.dataset.jobMore));
        const active=win.document.activeElement,focused=win.document.hasFocus?.()&&actions.contains(active)?{jobID:active.closest('[data-job-id]')?.dataset.jobId,action:active.dataset.action}:null;
        actions.replaceChildren();
        for(const j of visible){
          const doc=win.document,el=(tag,text)=>{const n=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(text!==undefined)n.textContent=text;return n;};
          const row=el('div');row.className='zr-job-action';row.dataset.jobId=j.id;
          const head=el('div');head.className='zr-job-heading';const title=el('span',(j.pausedByControl||j.resumePending&&this.state.paused?'已暂停':j.resumePending?'等待续检':j.state==='cancelled'&&j.resumeAvailable?'已停止，可继续检查':labels[j.state]||j.state)+' · '+(j.title||j.key));head.appendChild(title);row.appendChild(head);
          const controls=el('div');controls.className='zr-job-controls';head.appendChild(controls);
          const message=el('p',(j.message||'')+(j.state==='failed'&&!j.workflowPath?' 可在“队列操作”中重试失败项。':''));message.className='zr-caption';row.appendChild(message);
          const available=[];const add=(id,label,fn,disabled=false)=>available.push({id,label,fn,disabled});
          if(j.notes?.reading?.key)add('saved','查看笔记',async()=>ReaderSaved.open(win,await Zotero.Items.getByLibraryAndKeyAsync(j.libraryID,j.notes.reading.key)));
          if(typeof ReaderClassifier!=='undefined'&&ReaderClassifier.eligible(j))add('archive','归档／添加分类',()=>ReaderClassifier.openForJob(j.id),this.isRunning(j)||j.classificationPending);
          if(j.workflowPath&&!(['cancelled','failed'].includes(j.state)&&j.hasReadingDraft===false))add('result',this.isRunning(j)?'查看进度':'查看结果',()=>ReaderCodex.openResult(win,j.workflowPath,j));
          if(this.canResumeJob(j))add('resume',j.state==='needs_review'||j.resumeNeedsRepair?'自动修订并复查':'继续检查',()=>this.continueJob(j.id,{repair:j.state==='needs_review'||j.resumeNeedsRepair}),this.running.size>=ReaderPreferences.workflow().papers);
          if(this.isRunning(j)||j.resumePending)add('stop','停止此篇',()=>this.cancelJob(j));
          const needsArchive=typeof ReaderClassifier!=='undefined'&&Object.values(ReaderClassifier.proposals).some(p=>p.jobID===j.id&&p.noteKey===j.notes?.reading?.key&&p.status==='pending');
          const choose=id=>available.find(a=>a.id===id);
          const primary=this.isRunning(j)?choose('result'):choose('resume')||(needsArchive&&!j.classificationPending?choose('archive'):null)||choose('saved')||choose('result');
          const makeButton=(a,main=false)=>{const b=el('button',main&&a.id==='archive'?'确认归档':a.label);b.dataset.action=a.id;b.disabled=!!a.disabled;if(main){b.className='zr-task-primary';b.dataset.primaryAction='true';}if(a.id==='stop')b.classList.add('zr-danger');b.addEventListener('click',()=>Promise.resolve().then(a.fn).catch(e=>{this.lastMessage=this.app.safeError(e);this.refreshViews();}));return b;};
          if(primary)controls.appendChild(makeButton(primary,true));
          const secondary=available.filter(a=>a!==primary);
          if(secondary.length){const more=el('details');more.className='zr-action-menu zr-task-more';more.dataset.jobMore=j.id;more.open=opened.has(j.id);const summary=el('summary','更多');summary.dataset.action='more';summary.setAttribute('aria-label','更多操作：'+(j.title||j.key));more.appendChild(summary);const panel=el('div');panel.className='zr-menu-panel';for(const a of secondary)panel.appendChild(makeButton(a));more.appendChild(panel);controls.appendChild(more);}
          actions.appendChild(row);
        }
        if(focused?.jobID){const row=[...actions.children].find(n=>n.dataset.jobId===focused.jobID);const target=row&&[...row.querySelectorAll('[data-action]')].find(n=>n.dataset.action===focused.action);target?.focus({preventScroll:true});}
      }
      get('jobs').hidden=!!actions;
      if(actions&&!visible.length)actions.textContent='暂无任务。';
      get("jobs").textContent=visible.map(j=>{
        const msg=j.message;
        return `${labels[j.state]||j.state} · ${j.title}\n  ${msg}`;
      }).join("\n")||"暂无任务。启用后，新添加的 PDF 将出现在这里。";
    }
  },
  async shutdown(){
    this.started=false;this.resumeEpoch++;for(const job of Object.values(this.state.jobs))if(job.resumePending)this.cancelJob(job,'shutdown');if(this.timer)ReaderTimers.clearTimeout(this.timer);this.timer=null;
    if(this.observer)Zotero.Notifier.unregisterObserver(this.observer);this.observer=null;
    if(this.active)this.stopCurrent('shutdown');
    if(this.active)await this.active.catch(()=>{});
    if(this.starting)await this.starting.catch(()=>{});
    if(this.pausing)await this.pausing.catch(()=>{});
    if(this.resumeEnqueueing)await this.resumeEnqueueing.catch(()=>{});
    if(this.bulkSaving)await this.bulkSaving.catch(()=>{});
    if(ReaderCleanup.completedActive)await ReaderCleanup.completedActive.catch(()=>{});
    await this.persist().catch(()=>{});this.views.clear();
  }
};
