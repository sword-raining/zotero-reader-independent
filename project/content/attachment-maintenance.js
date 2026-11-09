"use strict";
var ReaderAttachmentMaintenance={
 app:null,active:null,protectedKeys:null,notifications:[],notifyTimeoutMs:2000,
 init(app){this.app=app;},
 busy(){return ReaderAutomation.running.size||ReaderAutomation.bulkSaving||ReaderAutomation.resumeEnqueueing||ReaderAutomation.starting||ReaderCodex.active||ReaderNotes.pending||ReaderCleanup.active||ReaderCleanup.completedActive||this.app.state.busy;},
 taskUses(key,libraryID){
  if(this.protectedKeys?.has(libraryID+':'+key))return true;
  const same=source=>source?.libraryID===libraryID&&source.key===key;
  for(const job of Object.values(ReaderAutomation.state.jobs))if(job.libraryID===libraryID&&(job.key===key||job.inputSelection?.supplementKeys?.includes(key))&&(job.workflowPath||job.notes||job.resumePending||['queued','waiting_file','running','awaiting_import','needs_review','verification_incomplete'].includes(job.state)))return true;
  for(const record of Object.values(ReaderSaved.records))if(record.libraryID===libraryID&&(record.attachmentKey===key||record.inputs?.some(s=>s.key===key)))return true;
  return same(ReaderCodex.state.attachment);
 },
 async noteReferences(att){
  const ids=await Zotero.DB.columnQueryAsync('SELECT N.itemID FROM itemNotes N JOIN items I ON I.itemID=N.itemID WHERE I.libraryID=? AND N.note LIKE ?',[att.libraryID,'%'+att.key+'%']);
  return (await Zotero.Items.getAsync(ids)).filter(n=>n?.isNote()&&!n.deleted);
 },
 async protection(att,{moving=false}={}){
  if(!att||att.deleted||!att.isPDFAttachment()||!att.parentID||!att.isEditable())return '附件不可修改或没有父题录';
  if(Zotero.Reader?.getByItemID?.(att.id))return 'PDF 正在阅读器中打开';
  if(this.taskUses(att.key,att.libraryID))return '任务或已保存精读记录仍引用此附件';
  await att.loadDataType?.('childItems');await att.loadDataType?.('note');await att.loadDataType?.('tags');await att.loadDataType?.('relations');
  if(moving&&(await this.noteReferences(att)).some(n=>SavedCore.read(n.getNote())||SavedCore.legacyRun(n.getNote())))return '已有精读笔记引用此附件，需先单独核对';
  if(!moving){
   if(att.getAnnotations(true).length)return '包含 Zotero 批注';
   if(att.getNote().replace(/<[^>]*>/g,'').trim()||/<(?:img|table|audio|video|svg|a)\b/i.test(att.getNote()))return '包含附件笔记';
   if(att.getTags().length)return '包含附件标签';
   if(Object.keys(att.getRelations()).length)return '包含关联信息';
   if((await this.noteReferences(att)).length)return '已有笔记引用此 PDF';
  }
  return '';
 },
 async targetFor(file,entry){
  if(file.parentMatch!=='mismatch'||!file.detectedDOI)return null;
  const search=new Zotero.Search();search.libraryID=entry.libraryID;search.addCondition('DOI','contains',file.detectedDOI);
  const items=await Zotero.Items.getAsync(await search.search()),targets=items.filter(x=>x?.isRegularItem()&&!x.deleted&&x.id!==entry.parentID&&x.libraryID===entry.libraryID&&x.isEditable()&&AttachmentCore.normalizeDOI(x.getField('DOI'))===file.detectedDOI);
  if(targets.length!==1)return null;await targets[0].loadDataType?.('childItems');return {id:targets[0].id,key:targets[0].key,title:targets[0].getField('title'),doi:file.detectedDOI,pdfCount:(await Zotero.Items.getAsync(targets[0].getAttachments())).filter(a=>a?.isPDFAttachment()&&!a.deleted).length};
 },
 async prepare(entries){
  const matches=new Map();for(const entry of entries)for(const file of entry.pdfs){if(file.parentMatch!=='mismatch')continue;const id=entry.libraryID+':'+entry.parentID+':'+file.detectedDOI;if(!matches.has(id))matches.set(id,await this.targetFor(file,entry));file.repairTarget=matches.get(id);}
 },
 async snapshot(att){const path=await att.getFilePathAsync();if(!path||!await IOUtils.exists(path))throw NoteCore.error('ATTACHMENT_FILE','PDF 未下载，未整理。');const before=await IOUtils.stat(path),sha=await this.app.sha256(path),after=await IOUtils.stat(path);if(before.size!==after.size||before.lastModified!==after.lastModified)throw NoteCore.error('ATTACHMENT_CHANGED','PDF 正在变化，未整理。');return {path,size:after.size,stamp:after.lastModified,sha};},
 async checkSnapshot(att,snapshot,parentID){if(att.deleted||att.parentID!==parentID||!att.isEditable())throw NoteCore.error('ATTACHMENT_CHANGED','附件归属或可写状态已变化，未整理。');const current=await this.snapshot(att);if(current.path!==snapshot.path||current.sha!==snapshot.sha)throw NoteCore.error('ATTACHMENT_CHANGED','PDF 在检查后发生变化，未整理。');},
 async audit(record){const dir=PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','attachment-maintenance');await IOUtils.makeDirectory(dir,{createAncestors:true});const file=PathUtils.join(dir,Date.now()+'-'+Zotero.Utilities.randomString(6)+'.json');await this.app.writeJSON(file,{schema:1,createdAt:new Date().toISOString(),...record});return file;},
 async flushNotifications(queues){
  if(!queues.length)return {done:true};let timer;
  const notification=Zotero.Notifier.commit(queues).then(()=>({done:true}),e=>({done:false,error:this.app.safeError(e)}));
  try{return await Promise.race([notification,new Promise(resolve=>{timer=ReaderTimers.setTimeout(()=>resolve({done:false}),this.notifyTimeoutMs);})]);}finally{if(timer)ReaderTimers.clearTimeout(timer);}
 },
 async locked(action){
  this.app.assertIndexes?.();
  if(this.active)throw NoteCore.error('BUSY','附件正在整理，请稍候。');if(this.busy())throw NoteCore.error('BUSY','请先暂停精读并等待保存结束，再整理附件。');
  this.active=Promise.resolve().then(async()=>{const refs=await ReaderCleanup.protectedCacheKeys('');if(refs.uncertain)throw NoteCore.error('ATTACHMENT_DRAFT','存在无法核对的本地草稿，暂未整理附件。');this.protectedKeys=refs.protectedKeys;this.notifications=[];const result=await action();const refreshed=await this.flushNotifications(this.notifications);if(!refreshed.done){result.refreshPending=true;result.details.push('数据整理已完成；Zotero 分类树刷新尚未结束，可关闭并重新打开列表查看。');}return result;});ReaderAutomation.refreshViews();try{return await this.active;}finally{this.notifications=[];this.protectedKeys=null;this.active=null;ReaderAutomation.refreshViews();ReaderAutomation.schedule();}
 },
 async trashItem(item,notifierQueue){if(Zotero.Libraries?.get?.(item.libraryID)?.hasTrash===false)throw NoteCore.error('ATTACHMENT_TRASH','当前文库不支持回收站，未清理。');item.deleted=true;await item.save({skipSelect:true,notifierQueue,notifierData:{zriGenerated:true}});},
 async cleanup(entries){return this.locked(async()=>{
  const result={cleaned:0,kept:0,details:[]};
  for(const entry of entries){
   const groups=new Map();for(const file of entry.pdfs)if(file.sha256){if(!groups.has(file.sha256))groups.set(file.sha256,[]);groups.get(file.sha256).push(file);}
   for(const [hash,files]of groups){if(files.length<2)continue;const inspected=[];
    for(const file of files){const att=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,file.key);let reason=file.parentMatch==='mismatch'?'题录不符，先修复归属':await this.protection(att);inspected.push({file,att,reason});}
    // A referenced or annotated copy is always retained; no annotations are merged or deleted.
    const keeper=inspected.find(x=>x.reason&&x.att&&!x.att.deleted)||inspected.find(x=>x.file.key===entry.mainKey)||inspected[0];
    for(const candidate of inspected){if(candidate===keeper)continue;if(candidate.reason){result.kept++;result.details.push(candidate.file.name+'：'+candidate.reason);continue;}
     let committed=false;try{
      if(!keeper.att||keeper.att.parentID!==entry.parentID||keeper.att.deleted)throw NoteCore.error('ATTACHMENT_KEEP','保留副本已不可用，未清理。');
      const kept=await this.snapshot(keeper.att),copy=await this.snapshot(candidate.att);if(kept.sha!==hash||copy.sha!==hash)throw NoteCore.error('ATTACHMENT_CHANGED','PDF 内容已变化，未清理。');
      const record={schema:1,createdAt:new Date().toISOString(),action:'trash-duplicate',libraryID:entry.libraryID,parentKey:entry.parentKey,keeperKey:keeper.att.key,attachmentKey:candidate.att.key,sha256:hash,status:'planned'},log=await this.audit(record),notifierQueue=new Zotero.Notifier.Queue();
      await Zotero.DB.executeTransaction(async()=>{await this.checkSnapshot(keeper.att,kept,entry.parentID);await this.checkSnapshot(candidate.att,copy,entry.parentID);const reason=await this.protection(candidate.att);if(reason)throw NoteCore.error('ATTACHMENT_PROTECTED',reason);await this.trashItem(candidate.att,notifierQueue);});
      committed=true;this.notifications.push(notifierQueue);result.cleaned++;await this.app.writeJSON(log,{...record,status:'done',completedAt:new Date().toISOString()});
     }catch(e){if(!committed){try{await candidate.att?.reload?.(['primaryData'],true);}catch(_){}result.kept++;}result.details.push(candidate.file.name+'：'+(committed?'已移入回收站，后续刷新或记录未完成；':'')+this.app.safeError(e));}
    }
   }
  }
  return result;
 });},
 async matchingCopies(target,source,hash){
  await target.loadDataType?.('childItems');const copies=[];
  for(const att of await Zotero.Items.getAsync(target.getAttachments())){if(!att||att.id===source.id||att.deleted||!att.isPDFAttachment())continue;try{const snapshot=await this.snapshot(att);if(snapshot.sha===hash)copies.push({att,snapshot});}catch(_){}}
  return copies;
 },
 async repair(entries){return this.locked(async()=>{
  const result={fixed:0,moved:0,trashed:0,notesMoved:0,kept:0,details:[]};
  for(const entry of entries)for(const file of entry.pdfs){if(file.parentMatch!=='mismatch')continue;
   if(!file.repairTarget){result.kept++;result.details.push(file.name+'：未找到唯一匹配题录，保留原位');continue;}
   let att,target,notes=[],copies=[],committed=false;
   try{
    att=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,file.key);const reason=await this.protection(att,{moving:true});if(reason)throw NoteCore.error('ATTACHMENT_PROTECTED',reason);
    const snapshot=await this.snapshot(att);if(snapshot.sha!==file.sha256)throw NoteCore.error('ATTACHMENT_CHANGED','PDF 已变化，请重新检查。');const parent=await Zotero.Items.getAsync(entry.parentID);if(!parent||parent.deleted)throw NoteCore.error('ATTACHMENT_PARENT','原题录已变化。');
    const parentIdentity={title:parent.getField('title'),doi:AttachmentCore.normalizeDOI(parent.getField('DOI'))};
    const inspected=await ReaderAttachments.inspectPDF(att,{...file,path:snapshot.path,size:snapshot.size,lastModified:snapshot.stamp},parent);if(inspected.parentMatch!=='mismatch'||inspected.detectedDOI!==file.detectedDOI)throw NoteCore.error('ATTACHMENT_CHANGED','PDF 与题录对应信息已变化。');
    const found=await this.targetFor(file,entry);if(!found||found.key!==file.repairTarget.key)throw NoteCore.error('ATTACHMENT_TARGET','目标题录已变化，请重新检查。');target=await Zotero.Items.getAsync(found.id);
    copies=await this.matchingCopies(target,att,snapshot.sha);const sourceProtected=await this.protection(att),trashSource=copies.length>0&&!sourceProtected,keeper=trashSource?copies[0]:null;
    for(const note of await this.noteReferences(att))if(note.parentID===entry.parentID){const html=note.getNote(),keys=[...new Set([...html.matchAll(/\/items\/([A-Z0-9]{8})/g)].map(m=>m[1]))];if(keys.length===1&&keys[0]===att.key&&!SavedCore.read(html)&&!SavedCore.legacyRun(html))notes.push({note,html});}
    const record={schema:1,createdAt:new Date().toISOString(),action:trashSource?'trash-wrong-parent-duplicate':'reparent',libraryID:entry.libraryID,attachmentKey:att.key,fromParent:entry.parentKey,toParent:target.key,doi:file.detectedDOI,sha256:snapshot.sha,keeperKey:keeper?.att.key||att.key,noteKeys:notes.map(x=>x.note.key),status:'planned'},log=await this.audit(record),trashed=[],notifierQueue=new Zotero.Notifier.Queue();let retainedCopies=0;
    await Zotero.DB.executeTransaction(async()=>{
     await this.checkSnapshot(att,snapshot,entry.parentID);const reason=await this.protection(att,{moving:true});if(reason)throw NoteCore.error('ATTACHMENT_PROTECTED',reason);
     if(parent.deleted||parent.getField('title')!==parentIdentity.title||AttachmentCore.normalizeDOI(parent.getField('DOI'))!==parentIdentity.doi)throw NoteCore.error('ATTACHMENT_PARENT','原题录在检查后发生修改，未整理。');
     const latestTarget=await this.targetFor(file,entry);if(latestTarget?.key!==target.key)throw NoteCore.error('ATTACHMENT_TARGET','匹配目标不再唯一，未整理。');
     if(target.deleted||!target.isEditable()||target.libraryID!==att.libraryID||AttachmentCore.normalizeDOI(target.getField('DOI'))!==file.detectedDOI)throw NoteCore.error('ATTACHMENT_TARGET','目标题录已变化，未整理。');
     if(trashSource){await this.checkSnapshot(keeper.att,keeper.snapshot,target.id);const protection=await this.protection(att);if(protection)throw NoteCore.error('ATTACHMENT_PROTECTED',protection);await this.trashItem(att,notifierQueue);trashed.push(att.key);}
     else{
      for(const x of notes)if(x.note.deleted||x.note.parentID!==entry.parentID||x.note.getNote()!==x.html)throw NoteCore.error('ATTACHMENT_NOTE','关联笔记发生修改，未迁移。');
      att.parentID=target.id;await att.save({skipSelect:true,notifierQueue,notifierData:{zriGenerated:true}});for(const x of notes){if(x.note.deleted||x.note.parentID!==entry.parentID||x.note.getNote()!==x.html)throw NoteCore.error('ATTACHMENT_NOTE','关联笔记发生修改，未迁移。');x.note.parentID=target.id;await x.note.save({skipSelect:true,notifierQueue,notifierData:{zriGenerated:true}});}
      for(const copy of copies){let safe=false;try{await this.checkSnapshot(copy.att,copy.snapshot,target.id);safe=!await this.protection(copy.att);}catch(_){}if(safe){await this.trashItem(copy.att,notifierQueue);trashed.push(copy.att.key);}else retainedCopies++;}
     }
    });
    committed=true;this.notifications.push(notifierQueue);result.fixed++;result.trashed+=trashed.length;if(!trashSource){result.moved++;result.notesMoved+=notes.length;}if(retainedCopies){result.kept+=retainedCopies;result.details.push(file.name+'：目标中 '+retainedCopies+' 份相同 PDF 带保护信息，继续保留');}
    await this.app.writeJSON(log,{...record,trashedKeys:trashed,status:'done',completedAt:new Date().toISOString()});
   }catch(e){if(!committed){try{await att?.reload?.(['primaryData','childItems'],true);for(const x of notes)await x.note.reload?.(['primaryData'],true);for(const x of copies)await x.att.reload?.(['primaryData'],true);await target?.reload?.(['childItems'],true);}catch(_){}result.kept++;}result.details.push(file.name+'：'+(committed?'已整理，后续刷新或记录未完成；':'')+this.app.safeError(e));}
  }
  return result;
 });}
};
