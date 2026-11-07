"use strict";
var ReaderAttachments={
  app:null,
  init(app){this.app=app;},
  async collectItems(items){
    const groups=new Map();let ignored=0;
    for(const item of items){
      if(!item||item.deleted){ignored++;continue;}
      const parent=item.isPDFAttachment()&&item.parentID?await Zotero.Items.getAsync(item.parentID):item;
      if(!parent||parent.deleted||(!parent.isRegularItem()&&!parent.isPDFAttachment())){ignored++;continue;}
      const groupID=QueueCore.key(parent.libraryID,parent.key);
      if(groups.has(groupID))continue;
      const pdfs=parent.isRegularItem()?(await Zotero.Items.getAsync(parent.getAttachments())).filter(a=>a&&!a.deleted&&a.isPDFAttachment()):[parent];
      if(!pdfs.length){ignored++;continue;}
      const files=[];let issue='';
      for(const att of pdfs){
        let path='',local=false,sha256=null;
        try{
          await ReaderNotes.destination(att);
          path=await att.getFilePathAsync();local=Boolean(path&&await IOUtils.exists(path));
          if(local){
            const before=await IOUtils.stat(path);
            if(before.size>0&&before.size<=MineruCore.MAX_PDF_BYTES){
              sha256=await this.app.sha256(path);const after=await IOUtils.stat(path);
              if(before.size!==after.size||before.lastModified!==after.lastModified)sha256=null;
            }
          }
        }catch(e){issue=this.app.safeError(e);}
        const title=att.getField('title')||att.key,name=path?PathUtils.filename(path):att.attachmentFilename||'';
        files.push({key:att.key,itemID:att.id,libraryID:att.libraryID,title,name,local,sha256,supplement:AttachmentCore.isSupplement(title,name)});
      }
      const plan=AttachmentCore.plan(files);
      groups.set(groupID,{groupID,id:plan.mainKey?QueueCore.key(parent.libraryID,plan.mainKey):groupID,libraryID:parent.libraryID,key:plan.mainKey,
        display:parent.getField('title')||parent.key,issue,selected:!issue,...plan});
    }
    return {entries:[...groups.values()],ignored,selectedCount:items.length};
  },
  async selected(win){return this.collectItems((win.ZoteroPane||Zotero.getActiveZoteroPane()).getSelectedItems()||[]);},
  async attachments(main,selection={mainKey:main.key,supplementKeys:[]}){
    if(selection.mainKey!==main.key)throw NoteCore.error('ATTACHMENT_SELECTION','正文选择与队列任务不一致，请重新选择附件。');
    const result=[main];
    for(const key of new Set(selection.supplementKeys||[])){
      if(key===main.key)continue;
      const att=await Zotero.Items.getByLibraryAndKeyAsync(main.libraryID,key);
      if(!att||att.deleted||!att.isPDFAttachment()||!main.parentID||att.parentID!==main.parentID)throw NoteCore.error('ATTACHMENT_CHANGED','所选补充材料已删除、移动或不属于这篇文献，请重新选择。');
      result.push(att);
    }
    return result;
  },
  async sources(main,selection,signal){
    const attachments=await this.attachments(main,selection),result=[],seen=new Set();
    for(const att of attachments){
      const {source}=await this.app.source(att,signal);
      if(seen.has(source.sha256))continue;
      seen.add(source.sha256);
      const index=result.length,target=await ReaderNotes.destination(att);
      result.push({...source,role:index?'supplement':'main',id:index?'S'+index:'M',label:index?'补充材料 '+index:'正文',title:att.getField('title'),pdfURL:target.pdfURL});
    }
    return result;
  },
  async matches(workflow,main,selection){
    try{return AttachmentCore.sameSources(workflow.inputSources||[{...workflow.source,role:'main'}],await this.sources(main,selection));}catch(_){return false;}
  },
  async validateWorkflow(workflow,main){
    if(!workflow.inputSources?.length)return;
    const selection={mainKey:main.key,supplementKeys:workflow.inputSources.filter(s=>s.role==='supplement').map(s=>s.key)};
    if(!await this.matches(workflow,main,selection))throw NoteCore.error('NOTE_CHANGED','本次精读的正文或补充材料已变化、移动或尚未下载，请重新检查附件后精读。');
  }
};
