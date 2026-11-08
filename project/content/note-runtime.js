"use strict";
var ReaderNotes={
  app:null, serial:Promise.resolve(),pending:0,pendingPaths:new Map(),
  init(app){this.app=app;},
  async bibliography(attachment){
    const parent=attachment?.parentID?await Zotero.Items.getAsync(attachment.parentID):null;
    return BibliographyCore.fromItem(parent?.toJSON?.()||{},{attachmentTitle:attachment?.getField?.("title")||"",oneAvailable:Boolean(Zotero.ZoteroIF),itemKey:parent?.key||attachment?.key,attachmentKey:attachment?.key,libraryID:attachment?.libraryID,itemURI:attachment?.id?Zotero.URI.getItemURI(parent||attachment):''});
  },
  async destination(attachment){
    if(!attachment||!attachment.isPDFAttachment()||attachment.deleted)throw NoteCore.error("NOTE_SOURCE","来源 PDF 已不存在或已进入回收站。");
    const library=Zotero.Libraries.get(attachment.libraryID);
    if(!library?.editable||!["user","group"].includes(library.libraryType))throw NoteCore.error("NOTE_READONLY","当前文库不能写入精读笔记。");
    const parent=attachment.parentID?await Zotero.Items.getAsync(attachment.parentID):null;
    if(parent&&(!parent.isRegularItem()||parent.deleted||!parent.isEditable()||parent.libraryID!==attachment.libraryID))throw NoteCore.error("NOTE_PARENT","来源文献不能接收笔记，请检查所属文库和回收站状态。");
    let prefix="library";
    if(library.libraryType==="group"){
      const match=Zotero.URI.getItemURI(attachment).match(/\/groups\/(\d+)\/items\//);
      if(!match)throw NoteCore.error("NOTE_LINK","无法定位群组文库中的来源 PDF。");
      prefix="groups/"+match[1];
    }
    return {libraryID:attachment.libraryID,parentID:parent?.id||false,
      collections:parent?[]:attachment.getCollections(),
      title:parent?.getField("title")||attachment.getField("title")||attachment.key,
      bibliography:BibliographyCore.fromItem(parent?.toJSON?.()||{},{attachmentTitle:attachment.getField("title")||attachment.key,oneAvailable:Boolean(Zotero.ZoteroIF),itemKey:parent?.key||attachment.key,attachmentKey:attachment.key,libraryID:attachment.libraryID,itemURI:Zotero.URI.getItemURI(parent||attachment)}),
      pdfTitle:attachment.getField("title")||attachment.key,pdfURL:`zotero://open-pdf/${prefix}/items/${attachment.key}`};
  },
  saving(path){return (this.pendingPaths.get(path)||0)>0;},
  async checkedSavedNote(note,runID,attachment){
    const record=SavedCore.read(note.getNote());
    if(!record||record.runID!==runID||record.status!=='checked'||note.libraryID!==attachment.libraryID||(note.parentID||false)!==(attachment.parentID||false)||!record.inputs.some(s=>s.role==='main'&&s.key===attachment.key)||await this.app.sha256Text(SavedCore.body(note.getNote()))!==record.bodySHA256)throw NoteCore.error('NOTE_BULK_REVIEW','已有笔记经过修改或无法确认核验状态，请单独查看，未重复保存。');
  },
  save(workflowPath,attachment,options={}){
    if(typeof ReaderAttachmentMaintenance!=='undefined'&&ReaderAttachmentMaintenance.active)return Promise.reject(NoteCore.error('BUSY','正在整理附件，请稍后保存。'));
    if(typeof ReaderAutomation!=='undefined'&&[...ReaderAutomation.historyClearing||[]].some(id=>ReaderAutomation.state.jobs[id]?.workflowPath===workflowPath))return Promise.reject(NoteCore.error('BUSY','正在清理此篇完成记录，请稍后保存。'));
    if(ReaderCleanup.active)return Promise.reject(NoteCore.error('BUSY','正在清理生成缓存，请稍后导入。'));
    this.pending++;this.pendingPaths.set(workflowPath,(this.pendingPaths.get(workflowPath)||0)+1);
    const task=this.serial.then(()=>this._save(workflowPath,attachment,options));
    this.serial=task.catch(()=>{});return task.finally(()=>{this.pending--;const count=this.pendingPaths.get(workflowPath)-1;if(count)this.pendingPaths.set(workflowPath,count);else this.pendingPaths.delete(workflowPath);});
  },
  async _save(workflowPath,attachment,options={}){
    options.validateTask?.();
    const dir=PathUtils.parent(workflowPath),runID=PathUtils.filename(dir);
    NoteCore.identity(runID,"reading");
    const expected=PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent","readings",runID,"workflow.json");
    if(workflowPath!==expected)throw NoteCore.error("NOTE_PATH","精读结果目录不属于本插件。");
    const workflow=await this.app.readJSON(workflowPath);
    if(!workflow){
      const saved=await ReaderSaved.byRun(runID,attachment);
      if(saved&&options.requireChecked){await this.checkedSavedNote(saved.note,runID,attachment);options.validateTask?.();}
      if(saved)return {notes:{reading:{key:saved.note.key,id:saved.note.id,reused:true}},status:saved.entry.status,parentID:saved.note.parentID,cleanup:{state:'done'}};
    }
    if(workflow&&options.preferMarkdown&&["verifying","correcting"].includes(workflow.status)){
      if(ReaderAutomation.running&&[...ReaderAutomation.running.values()].some(w=>w.job.workflowPath===workflowPath))throw NoteCore.error("BUSY","此篇仍在处理，未导入正在变化的稿件。");
      workflow.status="verification_incomplete"; // A user-confirmed manual import of an interrupted draft.
    }
    if(!workflow||!["checked","needs_review","verification_incomplete"].includes(workflow.status))throw NoteCore.error("NOTE_STATE","当前没有可保存的完整精读草稿。");
    if(workflow.source?.key!==attachment.key||workflow.source?.libraryID!==attachment.libraryID)throw NoteCore.error("NOTE_MISMATCH","精读结果与来源 PDF 不匹配。");
    const target=await this.destination(attachment);
    const current=await this.app.source(attachment);
    if(current.source.sha256!==workflow.source.sha256)throw NoteCore.error("NOTE_CHANGED","PDF 已发生变化，精读结果仍保存在本地；请对新版 PDF 重新精读。");
    await ReaderAttachments.validateWorkflow(workflow,attachment);
    const draft=ReadingCore.parseDraft(await IOUtils.readUTF8(PathUtils.join(dir,"draft.json")),{allowLegacy:Number(workflow.templateVersion||1)<4});
    const paper=await this.app.readJSON(PathUtils.join(dir,"source-index.json"));
    let review=null,assessment=null;
    if(["checked","needs_review"].includes(workflow.status)){
      const saved=await this.app.readJSON(PathUtils.join(dir,"verification.json"));
      review=ReadingCore.parseReview(JSON.stringify(saved?.review));
      if(!Array.isArray(paper?.paragraphs))throw NoteCore.error("NOTE_EVIDENCE","缺少原文定位依据，不能生成已核验笔记。");
      assessment=ReadingCore.assess(draft,review,paper);
    }
    const naming=workflow.readingNaming||ReaderPreferences.naming();
    let manualMarkdown="",manualEdited=false,importedMarkdownSHA256=null,importedMarkdownPath=null;
    if(options.preferMarkdown){
      const filename=workflow.resultFile||"draft.md";
      if(!["reading.md","review-needed.md","draft.md"].includes(filename))throw NoteCore.error("NOTE_PATH","Markdown 结果文件名无效。");
      const mdPath=PathUtils.join(dir,filename);importedMarkdownPath=mdPath;
      if(!await IOUtils.exists(mdPath))throw NoteCore.error("NOTE_MARKDOWN","Markdown 文件不存在，无法导入。");
      if((await IOUtils.stat(mdPath)).size>4*1024*1024)throw NoteCore.error("NOTE_MARKDOWN","Markdown 文件过大，未导入。");
      manualMarkdown=await IOUtils.readUTF8(mdPath);if(!manualMarkdown.trim())throw NoteCore.error("NOTE_MARKDOWN","Markdown 文件为空，未导入。");
      importedMarkdownSHA256=await this.app.sha256(mdPath);
      const expectedHash=workflow.resultFile?workflow.resultSHA256:workflow.draftSHA256;
      manualEdited=expectedHash?importedMarkdownSHA256!==expectedHash:manualMarkdown!==ReaderCodex.renderReading(draft,assessment,workflow);
    }
    if(options.requireChecked&&(manualEdited||workflow.status!=='checked'||assessment?.status!=='checked'))throw NoteCore.error('NOTE_BULK_REVIEW','稿件有修改或尚未通过检查，请打开结果单独核对后保存。');
    if(!manualEdited&&(workflow.status!=="checked"||assessment?.status!=="checked"))throw NoteCore.error("NOTE_UNRESOLVED","还有重要问题未解决，暂不导入。请重新精读，或修改 Markdown 后再导入人工修改稿。");
    const html=NoteCore.render({workflow,draft,review,assessment,...target,sections:ReadingCore.sectionsFor(draft),runID,naming,manualEdited,manualMarkdown});
    const notes={};let savedReadingBody=null;
    await Zotero.DB.executeTransaction(async()=>{
      options.validateTask?.();
      if(options.requireChecked&&importedMarkdownPath&&await this.app.sha256(importedMarkdownPath)!==importedMarkdownSHA256)throw NoteCore.error('NOTE_CHANGED','保存前稿件发生变化，本次跳过，原稿保留。');
      // Recheck target immediately before writes. Never overwrite a user-edited note.
      const latest=await this.destination(attachment);
      if(latest.parentID!==target.parentID)throw NoteCore.error("NOTE_MOVED","PDF 的所属文献刚刚发生变化，请重试生成笔记。");
      for(const role of ["reading"]){
        const marker=NoteCore.identity(runID,role);
        const mapped=workflow.zoteroNotes?.[role]?.key?await Zotero.Items.getByLibraryAndKeyAsync(target.libraryID,workflow.zoteroNotes[role].key):null;
        let matching=mapped?.isNote()?[mapped]:[];
        if(!matching.length){
          // Read-only recovery if the post-commit local mapping was interrupted.
          // Do not store arbitrary identifiers in relations: Zotero sync requires item URIs there.
          const ids=await Zotero.DB.columnQueryAsync("SELECT N.itemID FROM itemNotes N JOIN items I ON I.itemID=N.itemID WHERE I.libraryID=? AND N.note LIKE ?",[target.libraryID,"%"+marker+"%"]);
          matching=(await Zotero.Items.getAsync(ids)).filter(item=>item.isNote());
        }
        if(matching.some(n=>n.deleted))throw NoteCore.error("NOTE_TRASHED","同次生成的笔记已被移入回收站，不会自动恢复或重建。");
        if(matching.length&&options.requireChecked){if(matching.length!==1)throw NoteCore.error('NOTE_BULK_REVIEW','已有多份同次笔记，请单独查看，未重复保存。');await this.checkedSavedNote(matching[0],runID,attachment);}
        options.validateTask?.();
        if(matching.length){notes[role]={key:matching[0].key,id:matching[0].id,reused:true};continue;}
        const note=new Zotero.Item("note");note.libraryID=target.libraryID;
        if(target.parentID)note.parentID=target.parentID;
        else if(target.collections.length)note.setCollections(target.collections);
        const record={schema:1,runID,itemKey:target.bibliography.itemKey||attachment.key,status:html.status,
          createdAt:workflow.createdAt,inputs:SavedCore.inputs(workflow),bodySHA256:await this.app.sha256Text(SavedCore.body(html[role]))};
        note.setNote(SavedCore.embed(html[role],record));
        note.addRelation("dc:relation",Zotero.URI.getItemURI(attachment));
        for(const source of workflow.inputSources||[]){
          if(source.key===attachment.key)continue;
          const supplemental=await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID,source.key);
          if(supplemental)note.addRelation('dc:relation',Zotero.URI.getItemURI(supplemental));
        }
        options.validateTask?.();
        await note.save({skipSelect:true,notifierData:{zriGenerated:true}});
        notes[role]={key:note.key,id:note.id,reused:false};
        if(role==='reading')savedReadingBody=SavedCore.body(note.getNote());
      }
      if(html.status==='checked'&&!notes.reading.reused){
        const owner=target.parentID?await Zotero.Items.getAsync(target.parentID):attachment;
        owner.addTag('AI精读');await owner.save({skipSelect:true,notifierData:{zriGenerated:true}});
      }
    });
    // Embedded record IDs provide recovery even if this file write is interrupted.
    const reused=Object.values(notes).every(n=>n.reused),status=reused?(workflow.noteStatus||html.status):html.status;
    let stored=false;
    const savedWorkflow={...workflow,zoteroNotes:{...workflow.zoteroNotes,...notes},noteStatus:status,
      noteNaming:reused?(workflow.noteNaming||naming):naming,
      manualMarkdownEdited:reused?(workflow.manualMarkdownEdited||false):manualEdited,
      importedMarkdownSHA256:reused?(workflow.importedMarkdownSHA256||null):importedMarkdownSHA256,
      noteSavedAt:reused?(workflow.noteSavedAt||new Date().toISOString()):new Date().toISOString()};
    try{await this.app.writeJSON(workflowPath,savedWorkflow);stored=true;}catch(_){}
    let cleanup={state:'retained',message:'笔记已保存，临时记录未完成保存，稍后可重试清理。'};
    if(stored){
      try{const note=await Zotero.Items.getByLibraryAndKeyAsync(target.libraryID,notes.reading.key);await ReaderSaved.record(savedWorkflow,note,status,attachment);cleanup=await ReaderCleanup.afterSave(workflowPath,attachment);}
      catch(e){cleanup={state:'retained',message:'笔记已保存，临时内容暂未清理：'+this.app.safeError(e)};}
    }
    let archiveSuggestion=null;
    if(!reused&&!manualEdited&&status==='checked'&&workflow.classificationReview){
      if(savedReadingBody!==null)archiveSuggestion={...workflow.classificationReview,noteKey:notes.reading.key,noteHash:await this.app.sha256Text(savedReadingBody)};
    }
    return {notes,status,parentID:target.parentID,cleanup,archiveSuggestion};
  }
};
