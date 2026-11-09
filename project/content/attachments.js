"use strict";
var ReaderAttachments={
  app:null,inspections:new Map(),probeBusy:false,probeTimeoutMs:5000,
  init(app){this.app=app;},
  async inspectPDF(att,file,parent){
    if(!file.local||!file.sha256)return {role:'unknown',version:'unknown',reason:'文件尚未就绪',roleSource:'unavailable'};
    const key=[file.libraryID,file.key,file.sha256,parent.getField('title')||'',parent.isRegularItem?.()?parent.getField('DOI')||'':''].join(':');if(this.inspections.has(key))return this.inspections.get(key);
    const unchanged=async()=>{const path=await att.getFilePathAsync(),stat=path&&await IOUtils.stat(path);return path===file.path&&stat?.size===file.size&&stat?.lastModified===file.lastModified;};
    const remember=result=>{if(this.inspections.size>=256)this.inspections.delete(this.inspections.keys().next().value);this.inspections.set(key,result);return result;};
    const classify=(text,source)=>({...AttachmentCore.inspectText(text,{title:parent.getField('title'),doi:parent.isRegularItem?.()?parent.getField('DOI'):''}),roleSource:source});
    try{
      if(this.app.cached&&this.app.options){const cache=await this.app.cached({libraryID:file.libraryID,key:file.key,name:file.name,sha256:file.sha256,size:file.size},this.app.options());
        if(cache){const name=MineruCore.safeZipPath(cache.manifest.markdown),path=PathUtils.join(cache.dir,...name.split('/'));
          if((await IOUtils.stat(path)).size<=4*1024*1024){const result=classify(await IOUtils.readUTF8(path),'cache');if(await unchanged()&&(result.role!=='unknown'||result.version!=='unknown'||result.parentMatch==='match'||result.parentMatch==='mismatch'))return remember(result);}
        }
      }
    }catch(_){}
    if(this.probeBusy||!Zotero.PDFWorker?.getFullText||file.size>40*1024*1024)return {role:'unknown',version:'unknown',reason:'未提取本地文本，沿用附件信息',roleSource:'unavailable'};
    this.probeBusy=true;
    const probe=Promise.resolve().then(()=>Zotero.PDFWorker.getFullText(att.id,2,true)).then(async result=>{
      if(!await unchanged())return {role:'unknown',version:'unknown',reason:'文件发生变化',roleSource:'unavailable'};
      return remember(classify(result?.text||'','local'));
    }).catch(()=>({role:'unknown',version:'unknown',reason:'无法提取本地文本',roleSource:'unavailable'})).finally(()=>{this.probeBusy=false;});
    let timer;try{return await Promise.race([probe,new Promise(resolve=>{timer=ReaderTimers.setTimeout(()=>resolve({role:'unknown',version:'unknown',reason:'本地识别暂未完成',roleSource:'unavailable'}),this.probeTimeoutMs);})]);}finally{if(timer)ReaderTimers.clearTimeout(timer);}
  },
  async collectItems(items,{preflight=false}={}){
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
        let path='',local=false,sha256=null,size=0,lastModified=0;
        try{
          await ReaderNotes.destination(att);
          path=await att.getFilePathAsync();local=Boolean(path&&await IOUtils.exists(path));
          if(local){
            const before=await IOUtils.stat(path);size=before.size;lastModified=before.lastModified;
            if(before.size>0&&before.size<=MineruCore.MAX_PDF_BYTES){
              sha256=preflight&&this.app.preflightSHA256?await this.app.preflightSHA256(path,before):await this.app.sha256(path);const after=await IOUtils.stat(path);
              if(before.size!==after.size||before.lastModified!==after.lastModified)sha256=null;
            }
          }
        }catch(e){issue=this.app.safeError(e);}
        const title=att.getField('title')||att.key,name=path?PathUtils.filename(path):att.attachmentFilename||'';
        files.push({key:att.key,itemID:att.id,libraryID:att.libraryID,title,name,path,size,lastModified,local,sha256,supplement:AttachmentCore.isSupplement(title,name)});
      }
      const initial=AttachmentCore.plan(files),unique=initial.pdfs.filter(f=>!f.duplicateOf);
      if(unique.length){
        const detected=new Map();
        for(const f of unique){const att=pdfs.find(a=>a.key===f.key);detected.set(f.key,await this.inspectPDF(att,f,parent));}
        for(const f of files){const first=initial.pdfs.find(x=>x.key===f.key),result=detected.get(first.duplicateOf||f.key);if(!result)continue;Object.assign(f,result);f.supplement=result.role==='supplement'||result.role!=='main'&&f.supplement;f.versionSource=result.version==='unknown'?'name':result.roleSource;f.version=result.version==='unknown'?AttachmentCore.versionHint(f.title+' '+f.name):result.version;}
      }
      const plan=AttachmentCore.plan(files);
      groups.set(groupID,{groupID,id:plan.mainKey?QueueCore.key(parent.libraryID,plan.mainKey):groupID,libraryID:parent.libraryID,key:plan.mainKey,
        parentID:parent.id,parentKey:parent.key,display:parent.getField('title')||parent.key,language:parent.isRegularItem()?String(parent.getField('language')||''):'',issue,selected:!issue,...plan});
    }
    const entries=[...groups.values()];if(typeof ReaderAttachmentMaintenance!=='undefined')await ReaderAttachmentMaintenance.prepare(entries);
    return {entries,ignored,selectedCount:items.length};
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
  async sources(main,selection,signal,{preflight=false}={}){
    const attachments=await this.attachments(main,selection),result=[],seen=new Set();
    for(const att of attachments){
      const {source,path}=await this.app.source(att,signal,{preflight});
      const parent=att.parentID?await Zotero.Items.getAsync(att.parentID):null;
      if(parent?.isRegularItem?.()){
        const stat=await IOUtils.stat(path),identity=await this.inspectPDF(att,{...source,path,local:true,lastModified:stat.lastModified},parent);
        if(identity.parentMatch==='mismatch')throw NoteCore.error('ATTACHMENT_MISMATCH','PDF 首页 DOI 与父题录不符，请先修复附件归属，再精读或保存笔记。');
      }
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
