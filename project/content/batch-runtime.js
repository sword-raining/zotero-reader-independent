"use strict";
var ReaderBatch={
  app:null,window:null,entries:[],selectedCount:0,ignored:0,members:[],submitting:false,submitted:false,
  templateID:"ecology",skipProcessed:true,message:"",rowStatus:new Map(),rowActions:new Map(),outcomes:{},
  init(app){this.app=app;},
  async collectItems(items){
    return ReaderAttachments.collectItems(items);
  },
  async open(win,collected=null){
    if(this.submitting){this.window?.focus();return;}
    const selected=(win.ZoteroPane||Zotero.getActiveZoteroPane()).getSelectedItems();
    if(!selected?.length)throw NoteCore.error("BATCH_SELECTION","请先多选需要精读的文献或 PDF。");
    collected=collected||await this.collectItems(selected);
    if(!collected.entries.length)throw NoteCore.error("BATCH_SELECTION","所选条目没有 PDF 附件。");
    Object.assign(this,collected,{members:[],outcomes:{},submitted:false,message:"每篇文献选择一个正文。补充材料默认不读，需要时勾选。",skipProcessed:true});
    this.templateID=Zotero.Prefs.get(this.app.pref+"reading.batchTemplate",true)==="general"?"general":"ecology";
    if(this.window&&!this.window.closed){this.buildList();this.render();this.window.focus();}
    else win.openDialog("chrome://zotero-reader-independent/content/batch.xhtml","","chrome,dialog=no,resizable,centerscreen",{batch:this});
  },
  bindWindow(win){
    this.window=win;const get=id=>win.document.getElementById("zrb-"+id);
    get("template").addEventListener("command",()=>{this.templateID=get("template").value;Zotero.Prefs.set(this.app.pref+"reading.batchTemplate",this.templateID,true);});
    get("skip").addEventListener("change",()=>{this.skipProcessed=get("skip").checked;});
    get("all").addEventListener("click",()=>{for(const e of this.entries)e.selected=!e.issue;this.buildList();this.render();});
    get("none").addEventListener("click",()=>{for(const e of this.entries)e.selected=false;this.buildList();this.render();});
    get("start").addEventListener("click",()=>this.start().catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get("pause").addEventListener("click",()=>ReaderAutomation.togglePaused().catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get("stop").addEventListener("click",()=>ReaderAutomation.stopBatch(this.members).catch(e=>{this.message=this.app.safeError(e);this.render();}));
    this.buildList();this.render();
  },
  unbindWindow(win){if(this.window===win){this.window=null;this.rowStatus.clear();}},
  buildList(){
    if(!this.window||this.window.closed)return;
    const doc=this.window.document,list=doc.getElementById("zrb-list");list.replaceChildren();this.rowStatus.clear();this.rowActions.clear();
    for(const entry of this.entries){
      const el=(tag,text)=>{const n=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(text)n.textContent=text;return n;};
      const label=el('section');label.className="zr-batch-row";
      const heading=el('label'),input=el('input');input.type="checkbox";input.checked=entry.selected;input.className='zr-paper-check';
      input.disabled=Boolean(entry.issue)||this.submitting||this.submitted;
      input.addEventListener("change",()=>{entry.selected=input.checked;this.render();});
      heading.append(input,el('strong',' '+entry.display));label.append(heading);
      if(entry.issue)label.append(el('p',entry.issue));
      const summary=el('p',entry.mainKey?'正文已选 · 补充材料 '+entry.supplementKeys.length+' 份':"有多个正文候选或仅有疑似补充材料，请选择正文。");summary.className='zr-caption';label.append(summary);
      const files=el('div');files.className='zr-attachment-list';
      for(const pdf of entry.pdfs){
        const row=el('div');row.className='zr-attachment-row';
        const mainLabel=el('label'),radio=el('input');radio.type='radio';radio.name='main-'+entry.groupID;radio.value=pdf.key;radio.checked=entry.mainKey===pdf.key;
        radio.disabled=Boolean(entry.issue||pdf.duplicateOf)||this.submitting||this.submitted;
        radio.addEventListener('change',()=>{
          if(!radio.checked)return;
          entry.mainKey=entry.key=pdf.key;entry.id=QueueCore.key(entry.libraryID,pdf.key);entry.supplementKeys=entry.supplementKeys.filter(k=>k!==pdf.key);
          this.buildList();this.render();
        });
        mainLabel.append(radio,doc.createTextNode(' '+(pdf.duplicateOf?'重复文件':radio.checked?'已选正文':'设为正文')+' · '+pdf.title));row.append(mainLabel);
        const info=el('small',`${pdf.name}${pdf.supplement?' · 疑似补充材料':''}${!pdf.local?' · 尚未下载':''}${pdf.duplicateOf?' · 内容完全重复，已排除':''}`);info.className='zr-caption';row.append(info);
        if(!pdf.duplicateOf&&pdf.key!==entry.mainKey){
          const supplementLabel=el('label'),include=el('input');include.type='checkbox';include.className='zr-supplement-check';include.value=pdf.key;include.checked=entry.supplementKeys.includes(pdf.key);
          include.disabled=Boolean(entry.issue)||this.submitting||this.submitted;
          include.addEventListener('change',()=>{entry.supplementKeys=include.checked?[...entry.supplementKeys,pdf.key]:entry.supplementKeys.filter(k=>k!==pdf.key);this.buildList();this.render();});
          supplementLabel.append(include,doc.createTextNode(' 作为补充材料参考'));row.append(supplementLabel);
        }
        files.append(row);
      }
      label.append(files);
      const state=doc.createElementNS("http://www.w3.org/1999/xhtml","div");state.className="zr-caption";
      label.appendChild(state);this.rowStatus.set(entry.id,state);
      const view=doc.createElementNS("http://www.w3.org/1999/xhtml","button");view.type="button";view.textContent="查看结果 / 导入";view.hidden=true;
      view.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();try{const member=this.members.find(m=>(m.entryID||m.id)===entry.id),job=ReaderAutomation.state.jobs[member?.id||entry.id],key=entry.savedNoteKey||job?.notes?.reading?.key;if(key)await ReaderSaved.open(Zotero.getMainWindow(),await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,key));else if(job?.workflowPath)await ReaderCodex.openResult(this.window,job.workflowPath,job);}catch(error){this.message=this.app.safeError(error);this.render();}});
      label.appendChild(view);this.rowActions.set(entry.id,view);
      list.appendChild(label);
    }
  },
  async start(){
    if(this.submitting||this.submitted)return;
    const entries=this.entries.filter(e=>e.selected&&!e.issue).map(e=>({...e,key:e.mainKey,inputSelection:AttachmentCore.selection(e)}));
    if(!entries.length)throw NoteCore.error("BATCH_EMPTY","请至少选择一个可处理的 PDF。");
    this.submitting=true;this.message="正在核对所选 PDF 和已有结果…";this.buildList();this.render();
    try{
      const result=await ReaderAutomation.enqueueBatch(entries,this.templateID,{skipProcessed:this.skipProcessed});
      this.members=result.members;this.outcomes=result.outcomes;this.submitted=true;
      for(const entry of this.entries)entry.savedNoteKey=result.noteKeys?.[entry.id]||null;
      this.message=`新增 ${result.added} 篇；已在队列 ${result.existing} 篇；跳过已处理 ${result.skipped} 篇；无法加入 ${result.rejected.length} 篇。`;
      if(result.rejected.length)this.message+="\n"+result.rejected.map(r=>`${r.title}：${r.reason}`).join("\n");
      return result;
    }finally{this.submitting=false;this.buildList();this.render();}
  },
  render(){
    if(!this.window||this.window.closed)return;
    const get=id=>this.window.document.getElementById("zrb-"+id),locked=this.submitting||this.submitted;
    const selected=this.entries.filter(e=>e.selected&&!e.issue).length;
    get("summary").textContent=`所选 ${this.selectedCount} 个条目，整理为 ${this.entries.length} 篇文献；排除内容完全重复的 PDF ${this.entries.reduce((n,e)=>n+e.duplicateCount,0)} 份；忽略无 PDF 条目 ${this.ignored} 个。`;
    get("template").value=this.templateID;get("template").disabled=locked;
    get("skip").checked=this.skipProcessed;get("skip").disabled=locked;
    get("all").disabled=locked;get("none").disabled=locked;
    const unresolved=this.entries.some(e=>e.selected&&!e.issue&&!e.mainKey);
    get("start").disabled=locked||!selected||unresolved;get("start").textContent=this.submitted?"已加入队列":unresolved?'请先选择正文':`加入精读队列（${selected} 篇）`;
    get("pause").textContent=ReaderAutomation.state.paused?"继续队列":"暂停队列";
    const p=BatchCore.progress(this.members,ReaderAutomation.state.jobs);
    const labels={waiting_file:"等待本地文件",queued:"排队中",running:"处理中",done:"已生成笔记",imported:'已导入人工稿',needs_review:"草稿待复核",verification_incomplete:'检查未完成',awaiting_import:"Markdown 待导入",failed:"失败",cancelled:"已停止"};
    for(const entry of this.entries){
      const member=this.members.find(m=>(m.entryID||m.id)===entry.id),job=member&&ReaderAutomation.state.jobs[member.id];
      let text=this.outcomes[entry.id]||"";
      if(member&&job?.attempt===member.attempt)text=(labels[job.state]||job.state)+(job.state==="failed"?"："+job.message:"");
      else if(member)text=labels[member.lastTerminal]||"已由后续任务替换";
      const row=this.rowStatus.get(entry.id);if(row&&row.textContent!==text)row.textContent=text;
      const view=this.rowActions.get(entry.id);if(view){const hasNote=entry.savedNoteKey||(member&&job?.attempt===member.attempt&&job.notes?.reading?.key);view.textContent=hasNote?'查看笔记':'查看结果 / 导入';view.hidden=!hasNote&&!(member&&job?.attempt===member.attempt&&job.workflowPath&&['done','needs_review','verification_incomplete','awaiting_import'].includes(job.state));}
    }
    get("stop").disabled=!this.members.length||!(p.waiting+p.running);
    get("status").textContent=this.message+(ReaderAutomation.state.paused?"\n队列已暂停，可点击“继续队列”。":"");
    get("progress").textContent=this.members.length?`本批进度：等待 ${p.waiting} · 处理中 ${p.running} · 完成 ${p.done} · 已导入人工稿 ${p.imported} · 待导入 ${p.awaiting_import} · 待复核 ${p.needs_review} · 检查未完成 ${p.verification_incomplete} · 失败 ${p.failed} · 已停止 ${p.cancelled}`+(p.replaced?` · 已由后续任务替换 ${p.replaced}`:""):"";
  },
  shutdown(){if(this.window&&!this.window.closed)this.window.close();this.window=null;}
};
