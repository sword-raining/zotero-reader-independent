"use strict";
var ReaderBatch={
  app:null,window:null,entries:[],selectedCount:0,ignored:0,members:[],submitting:false,submitted:false,maintaining:false,
  templateID:"general",skipProcessed:true,skipChinese:true,message:"",selectionNotice:false,focusedSelection:null,rowStatus:new Map(),rowActions:new Map(),rows:new Map(),outcomes:{},
  init(app){this.app=app;},
  async collectItems(items){
    return ReaderAttachments.collectItems(items);
  },
  async open(win,collected=null){
    if(this.submitting||this.maintaining){this.window?.focus();return;}
    const selected=(win.ZoteroPane||Zotero.getActiveZoteroPane()).getSelectedItems();
    if(!selected?.length)throw NoteCore.error("BATCH_SELECTION","请先多选需要精读的文献或 PDF。");
    collected=collected||await this.collectItems(selected);
    if(!collected.entries.length)throw NoteCore.error("BATCH_SELECTION","所选条目没有 PDF 附件。");
    Object.assign(this,collected,{members:[],outcomes:{},submitted:false,selectionNotice:false,focusedSelection:null,message:"每篇文献选择一个正文。补充材料默认不读，需要时勾选。",skipProcessed:true,skipChinese:true});
    this.templateID="general";
    if(this.window&&!this.window.closed){this.buildList();this.render();this.window.focus();}
    else win.openDialog("chrome://zotero-reader-independent/content/batch.xhtml","","chrome,dialog=no,resizable,centerscreen",{batch:this});
  },
  hasMain(entry){return !!entry.mainKey&&entry.pdfs.some(pdf=>pdf.key===entry.mainKey&&!pdf.duplicateOf&&pdf.parentMatch!=='mismatch');},
  selectedEntries(){return this.entries.filter(e=>e.selected&&!e.issue&&!this.excludedChinese(e));},
  pendingMain(){return this.selectedEntries().filter(e=>!this.hasMain(e));},
  focusPendingMain(){
    const pending=this.pendingMain(),entry=pending[0];if(!entry)return;
    this.selectionNotice=true;this.focusedSelection=entry;this.message=`还有 ${pending.length} 篇需选择正文，已定位：${entry.display}。请选择正文，或取消勾选这篇后再加入队列。`;this.render();
    const row=this.rows.get(entry),target=row?.querySelector('input[type="radio"]:not(:disabled)')||row?.querySelector('.zr-paper-check');
    target?.scrollIntoView({block:'center',inline:'nearest'});target?.focus({preventScroll:true});
  },
  excludedChinese(entry){return this.skipChinese&&BatchCore.languageInfo(entry.language).chinese;},
  bindWindow(win){
    this.window=win;const get=id=>win.document.getElementById("zrb-"+id);
    get("template").addEventListener("command",()=>{this.templateID=get("template").value;Zotero.Prefs.set(this.app.pref+"reading.batchTemplate",this.templateID,true);});
    get("skip").addEventListener("change",()=>{this.skipProcessed=get("skip").checked;});
    get("skip-chinese").addEventListener("change",()=>{this.skipChinese=get("skip-chinese").checked;this.buildList();this.render();});
    get("all").addEventListener("click",()=>{for(const e of this.entries)if(!this.excludedChinese(e))e.selected=!e.issue;this.buildList();this.render();});
    get("none").addEventListener("click",()=>{for(const e of this.entries)e.selected=false;this.buildList();this.render();});
    get('clean-duplicates').addEventListener('click',()=>this.maintain('cleanup').catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get('repair-parents').addEventListener('click',()=>this.maintain('repair').catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get("start").addEventListener("click",()=>this.start().catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get("pause").addEventListener("click",()=>ReaderAutomation.toggleRun().catch(e=>{this.message=this.app.safeError(e);this.render();}));
    get("stop").addEventListener("click",()=>ReaderAutomation.stopBatch(this.members).catch(e=>{this.message=this.app.safeError(e);this.render();}));
    this.buildList();this.render();
  },
  unbindWindow(win){if(this.window===win){this.window=null;this.rowStatus.clear();this.rows.clear();}},
  buildList(){
    if(!this.window||this.window.closed)return;
    const doc=this.window.document,list=doc.getElementById("zrb-list");list.replaceChildren();this.rowStatus.clear();this.rowActions.clear();this.rows.clear();
    for(const entry of this.entries){
      const el=(tag,text)=>{const n=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(text)n.textContent=text;return n;};
      const label=el('section');label.className="zr-batch-row";label.dataset.entryId=entry.id;this.rows.set(entry,label);const language=BatchCore.languageInfo(entry.language),excluded=this.excludedChinese(entry);
      const heading=el('label'),input=el('input');input.type="checkbox";input.checked=entry.selected&&!excluded;input.className='zr-paper-check';
      input.disabled=Boolean(entry.issue)||excluded||this.submitting||this.submitted||this.maintaining;
      input.addEventListener("change",()=>{entry.selected=input.checked;this.render();});
      heading.append(input,el('strong',' '+entry.display));label.append(heading);
      const lang=el('p','语言：'+language.label+(language.raw?'（'+language.raw+'）':'')+(excluded?' · 本批跳过':language.kind==='unknown'?' · 请核对，未按中文跳过':''));lang.className='zr-caption';lang.dataset.language=language.kind;label.append(lang);
      if(entry.issue)label.append(el('p',entry.issue));
      const summary=el('p',this.hasMain(entry)?(entry.manualMain?'正文已选':entry.selectionReason||'正文已选')+' · 补充材料 '+entry.supplementKeys.length+' 份':"仅识别到补充材料或附件信息不足，请指定正文。");summary.className='zr-caption';label.append(summary);
      const files=el('div');files.className='zr-attachment-list';
      for(const pdf of entry.pdfs){
        const row=el('div');row.className='zr-attachment-row';
        const mainLabel=el('label'),radio=el('input');radio.type='radio';radio.name='main-'+entry.groupID;radio.value=pdf.key;radio.checked=entry.mainKey===pdf.key;
        radio.disabled=Boolean(entry.issue||pdf.duplicateOf||pdf.parentMatch==='mismatch')||excluded||this.submitting||this.submitted||this.maintaining;
        radio.addEventListener('change',()=>{
          if(!radio.checked)return;
          entry.manualMain=true;entry.mainKey=entry.key=pdf.key;entry.id=QueueCore.key(entry.libraryID,pdf.key);entry.supplementKeys=entry.supplementKeys.filter(k=>k!==pdf.key);
          this.buildList();this.render();
        });
        mainLabel.append(radio,doc.createTextNode(' '+(pdf.duplicateOf?'重复文件':radio.checked?'已选正文':'设为正文')+' · '+pdf.title));row.append(mainLabel);
        const roleSource={local:'本地解析',cache:'已有解析结果'}[pdf.roleSource],versionSource={local:'本地解析',cache:'已有解析结果',name:'附件名线索'}[pdf.versionSource];
        const info=el('small',`${pdf.name}${pdf.role==='supplement'?' · 已识别为补充材料'+(roleSource?'（'+roleSource+'）':''):pdf.supplement?' · 疑似补充材料':''}${pdf.version&&pdf.version!=='unknown'?' · '+({published:'已发表版本',accepted:'接受稿',preprint:'预印本'}[pdf.version]||'')+(versionSource?'（'+versionSource+'）':''):''}${!pdf.local?' · 尚未下载':''}${pdf.duplicateOf?' · 内容完全重复，已排除':''}`);info.className='zr-caption';row.append(info);
        if(pdf.parentMatch==='mismatch'){const warning=el('p','题录不符：PDF 首页 DOI '+pdf.detectedDOI+'。'+(pdf.repairTarget?'修复后归到「'+pdf.repairTarget.title+'」。'+(pdf.repairTarget.pdfCount?'目标已有 PDF，将比对内容并优先保留有批注或引用的副本。':'保留附件、批注和专属笔记。'):'未找到唯一匹配题录，暂不用于本篇精读。'));warning.className='zr-attachment-warning';row.append(warning);}
        if(!pdf.duplicateOf&&pdf.key!==entry.mainKey){
          const supplementLabel=el('label'),include=el('input');include.type='checkbox';include.className='zr-supplement-check';include.value=pdf.key;include.checked=entry.supplementKeys.includes(pdf.key);
          include.disabled=Boolean(entry.issue||pdf.parentMatch==='mismatch')||excluded||this.submitting||this.submitted||this.maintaining;
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
  async maintain(action){
    if(this.submitting||this.submitted||this.maintaining)return;const entries=this.selectedEntries().map(e=>JSON.parse(JSON.stringify(e)));if(!entries.length)return;
    const chosen=new Map(this.entries.map(e=>[e.groupID,{selected:e.selected,main:e.manualMain?e.mainKey:null,supplements:e.supplementKeys}]));this.maintaining=true;this.selectionNotice=false;this.message=action==='cleanup'?'正在核对重复副本、批注和笔记引用…':'正在核对 PDF 与目标题录，准备保留附件身份迁移…';this.buildList();this.render();
    try{const result=await ReaderAttachmentMaintenance[action](entries),parents=await Zotero.Items.getAsync([...new Set(this.entries.map(e=>e.parentID).filter(Boolean))]);for(const parent of parents)await parent.reload?.(['childItems'],true);const collected=await this.collectItems(parents);Object.assign(this,collected);for(const entry of this.entries){const old=chosen.get(entry.groupID);if(!old)continue;entry.selected=old.selected;if(old.main&&entry.pdfs.some(f=>f.key===old.main&&!f.duplicateOf&&f.parentMatch!=='mismatch')){entry.mainKey=entry.key=old.main;entry.id=QueueCore.key(entry.libraryID,old.main);entry.manualMain=true;}entry.supplementKeys=old.supplements.filter(k=>entry.pdfs.some(f=>f.key===k&&!f.duplicateOf&&f.parentMatch!=='mismatch')&&k!==entry.mainKey);}
      this.message=(action==='cleanup'?`已将 ${result.cleaned} 份重复 PDF 附件移入 Zotero 回收站，保留 ${result.kept} 份。`:`已处理 ${result.fixed} 份错挂附件：迁移 ${result.moved} 份 PDF、${result.notesMoved} 份专属笔记，${result.trashed} 份相同副本移入回收站；${result.kept} 份保留。`)+(result.details.length?'\n'+result.details.join('\n'):'');return result;
    }finally{this.maintaining=false;this.buildList();this.render();}
  },
  async start(){
    if(this.submitting||this.submitted||this.maintaining)return;
    if(this.pendingMain().length){this.focusPendingMain();return;}
    const skippedChinese=this.entries.filter(e=>e.selected&&!e.issue&&this.excludedChinese(e)).length;
    const entries=this.selectedEntries().map(e=>({...e,key:e.mainKey,inputSelection:AttachmentCore.selection(e)}));
    if(!entries.length)throw NoteCore.error("BATCH_EMPTY","请至少选择一个可处理的 PDF。");
    this.selectionNotice=false;this.focusedSelection=null;this.submitting=true;this.message="正在核对所选 PDF 和已有结果…";this.buildList();this.render();
    try{
      const result=await ReaderAutomation.enqueueBatch(entries,this.templateID,{skipProcessed:this.skipProcessed,skipChinese:this.skipChinese});
      this.members=result.members;this.outcomes=result.outcomes;this.submitted=true;
      for(const entry of this.entries){entry.savedNoteKey=result.noteKeys?.[entry.id]||null;if(result.languages?.[entry.id]!==undefined)entry.language=result.languages[entry.id];}
      this.message=`新增 ${result.added} 篇；已在队列 ${result.existing} 篇；跳过已有结果 ${result.skipped} 篇；跳过中文 ${skippedChinese+(result.skippedChinese||0)} 篇；无法加入 ${result.rejected.length} 篇。`;
      if(result.rejected.length)this.message+="\n"+result.rejected.map(r=>`${r.title}：${r.reason}`).join("\n");
      return result;
    }finally{this.submitting=false;this.buildList();this.render();}
  },
  render(){
    if(!this.window||this.window.closed)return;
    const get=id=>this.window.document.getElementById("zrb-"+id),locked=this.submitting||this.submitted||this.maintaining;
    const selected=this.selectedEntries().length;
    get("summary").textContent=`所选 ${this.selectedCount} 个条目，整理为 ${this.entries.length} 篇文献；排除内容完全重复的 PDF ${this.entries.reduce((n,e)=>n+e.duplicateCount,0)} 份；忽略无 PDF 条目 ${this.ignored} 个。`+(this.skipChinese?` 按语言字段跳过中文 ${this.entries.filter(e=>this.excludedChinese(e)).length} 篇。`:"");
    get("template").value=this.templateID;get("template").disabled=locked;
    get("skip").checked=this.skipProcessed;get("skip").disabled=locked;get("skip-chinese").checked=this.skipChinese;get("skip-chinese").disabled=locked;
    get("all").disabled=locked;get("none").disabled=locked;
    const maintenance=get('maintenance'),eligible=this.selectedEntries(),duplicates=eligible.reduce((n,e)=>n+e.pdfs.filter(f=>f.duplicateOf&&f.parentMatch!=='mismatch').length,0),foreign=eligible.flatMap(e=>e.pdfs.filter(f=>f.parentMatch==='mismatch')),repairable=foreign.filter(f=>f.repairTarget);
    if(maintenance){maintenance.hidden=!duplicates&&!foreign.length;get('maintenance-summary').textContent=`附件整理：重复副本 ${duplicates} 份，题录不符 ${foreign.length} 份`;get('clean-duplicates').hidden=!duplicates;get('clean-duplicates').disabled=locked;get('clean-duplicates').textContent=`一键清理重复 PDF（${duplicates} 份）`;get('repair-parents').hidden=!repairable.length;get('repair-parents').disabled=locked;get('repair-parents').textContent=`一键修复已确认归属（${repairable.length} 份）`;}
    const unresolved=this.pendingMain();
    if(this.selectionNotice&&!locked)this.message=unresolved.length?`还有 ${unresolved.length} 篇需选择正文。`+(unresolved.includes(this.focusedSelection)?`已定位：${this.focusedSelection.display}。请选择正文，或取消勾选这篇。`:'点击“选择正文”定位下一篇，或取消勾选暂不处理的文献。'):selected?'所选文献的正文已确认，可以加入精读队列。':'请勾选本次要处理的文献。';
    get("start").disabled=locked||!selected;get("start").textContent=this.submitted?"已加入队列":unresolved.length?`选择正文（${unresolved.length} 篇待确认）`:selected?`加入精读队列（${selected} 篇）`:"请选择文献";
    get("start").title=unresolved.length?'点击定位尚未选择正文的文献；也可取消勾选暂不处理的文献':'';
    const hint=get('selection-hint');if(hint){hint.hidden=locked||!unresolved.length;hint.textContent=`已选 ${selected} 篇，其中 ${unresolved.length} 篇需选择正文。点击下方“选择正文”定位；不处理的文献可以取消勾选。`;}
    for(const [entry,row]of this.rows){const pending=unresolved.includes(entry);row.classList.toggle('needs-main',pending);row.dataset.needsMain=String(pending);}
    get("pause").textContent=ReaderAutomation.pausing?"正在暂停…":ReaderAutomation.queueActive()?"全部暂停":"开始";get("pause").disabled=!!ReaderAutomation.pausing;get("pause").hidden=!this.submitted&&!ReaderAutomation.queueActive();get("pause").title='控制整个任务队列';
    const p=BatchCore.progress(this.members,ReaderAutomation.state.jobs);
    const labels={waiting_file:"等待本地文件",queued:"排队中",running:"处理中",done:"已生成笔记",imported:'已导入人工稿',needs_review:"草稿待复核",verification_incomplete:'检查未完成',awaiting_import:"Markdown 待导入",failed:"失败",cancelled:"已停止"};
    for(const entry of this.entries){
      const member=this.members.find(m=>(m.entryID||m.id)===entry.id),job=member&&ReaderAutomation.state.jobs[member.id];
      let text=this.outcomes[entry.id]||(this.excludedChinese(entry)?"本批跳过中文论文":"");
      if(member&&job?.attempt===member.attempt)text=(job.languageSkipped?'本批跳过中文论文':labels[job.state]||job.state)+(job.state==="failed"?"："+job.message:"");
      else if(member)text=labels[member.lastTerminal]||"已由后续任务替换";
      const row=this.rowStatus.get(entry.id);if(row&&row.textContent!==text)row.textContent=text;
      const view=this.rowActions.get(entry.id);if(view){const hasNote=entry.savedNoteKey||(member&&job?.attempt===member.attempt&&job.notes?.reading?.key);view.textContent=hasNote?'查看笔记':'查看结果 / 导入';view.hidden=!hasNote&&!(member&&job?.attempt===member.attempt&&job.workflowPath&&['done','needs_review','verification_incomplete','awaiting_import'].includes(job.state));}
    }
    get("stop").hidden=!this.submitted;get("stop").disabled=!this.members.length||!(p.waiting+p.running);
    get("status").textContent=this.message+(ReaderAutomation.state.paused?"\n队列已暂停，加入后可点击“开始”。":"");
    get("progress").textContent=this.members.length?`本批进度：等待 ${p.waiting} · 处理中 ${p.running} · 完成 ${p.done} · 已导入人工稿 ${p.imported} · 待导入 ${p.awaiting_import} · 待复核 ${p.needs_review} · 检查未完成 ${p.verification_incomplete} · 失败 ${p.failed} · 已停止 ${p.cancelled}`+(p.replaced?` · 已由后续任务替换 ${p.replaced}`:""):"";
  },
  shutdown(){if(this.window&&!this.window.closed)this.window.close();this.window=null;}
};
