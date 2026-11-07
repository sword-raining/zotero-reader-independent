"use strict";
var ReaderCodex = {
  app: null, window: null, active: null, controller: null,
  state: { title: "", source: "", cache: null, templateID: "ecology", answer: "", report: "", view: "reading", message: "就绪", output: "", busy: false },
  init(app) { this.app = app; },
  options() {
    const pref = this.app.pref + "codex.";
    return { ...CodexCore.options({ path: Zotero.Prefs.get(pref + "path", true), model: ReaderEngines.stage("generation").model,
      timeoutMinutes: Zotero.Prefs.get(pref + "timeoutMinutes", true) }),
      verifyModel: ReaderEngines.stage("verification").model };
  },
  subprocess() { return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess; },
  async nativeFromPath(path) {
    if (!path || !PathUtils.isAbsolute(path)) return null;
    if (!Zotero.isWin) {
      if (await this.subprocess().isExecutableFile(path)) return { command: path, prefix: [] };
      return null;
    }
    if (/\.exe$/i.test(path) && await IOUtils.exists(path)) return { command: path, prefix: [] };
    if (!/codex\.(cmd|ps1)$/i.test(PathUtils.filename(path))) return null;
    const base = PathUtils.parent(path);
    const roots = [PathUtils.join(base, "node_modules", "@openai", "codex")];
    for (const packageRoot of roots) {
      for (const [pkg, triple] of [["codex-win32-x64", "x86_64-pc-windows-msvc"], ["codex-win32-arm64", "aarch64-pc-windows-msvc"]]) {
        const vendors = [PathUtils.join(packageRoot, "node_modules", "@openai", pkg, "vendor"),
          PathUtils.join(base, "node_modules", "@openai", pkg, "vendor"), PathUtils.join(packageRoot, "vendor")];
        for (const vendor of vendors) for (const bin of ["bin", "codex"]) {
          const native = PathUtils.join(vendor, triple, bin, "codex.exe");
          if (await IOUtils.exists(native)) return { command: native, prefix: [] };
        }
      }
    }
    return null;
  },
  async resolveExecutable() {
    const custom = this.options().path;
    if (custom) {
      const found = await this.nativeFromPath(custom);
      if (found) return found;
      throw CodexCore.error("CLI_PATH", "无法从该路径找到原生 Codex 程序。Windows 请填写 codex.exe 的完整路径；npm 的 codex.cmd 可自动解析。");
    }
    for (const name of Zotero.isWin ? ["codex.exe", "codex.cmd"] : ["codex"]) {
      try {
        const found = await this.nativeFromPath(await this.subprocess().pathSearch(name));
        if (found) return found;
      } catch (_) {}
    }
    if (Zotero.isWin) {
      const appData = Services.dirsvc.get("AppData", Components.interfaces.nsIFile).path;
      const found = await this.nativeFromPath(PathUtils.join(appData, "npm", "codex.cmd"));
      if (found) return found;
    }
    throw CodexCore.error("CLI_MISSING", "未找到 Codex CLI。请安装并登录本机 CLI，或在插件设置中填写可执行文件路径。");
  },
  run(executable, args, extra = {}) {
    // Antigravity's background updater can create a visible console even though
    // Gecko hides the main child. Disable updates only for this invocation;
    // append preserves the existing login, proxy and executable environment.
    return CodexCore.runProcess({ spawn: spec => this.subprocess().call(spec), command: executable.command,
      args: [...executable.prefix, ...args], timers: ReaderTimers,
      ...(executable.engine==="antigravity"?{terminate:proc=>ReaderEngines.terminateTree(proc),
        environment:{AGY_CLI_DISABLE_AUTO_UPDATE:"true"},environmentAppend:true}:{}),...extra });
  },
  async probe(executable, signal) {
    const version = await this.run(executable, ["--version"], { timeoutMs: 15000, signal });
    if (version.exitCode !== 0 || !/codex(?:-cli)?\s+\d+\.\d+/i.test(version.stdout)) {
      throw CodexCore.error("CLI_VERSION", "所选程序没有返回可识别的 Codex CLI 版本。");
    }
    const help = await this.run(executable, ["exec", "--help"], { timeoutMs: 15000, signal });
    if (help.exitCode !== 0 || !["--ignore-user-config", "--ephemeral", "--output-last-message", "--output-schema"].every(flag => help.stdout.includes(flag))) {
      throw CodexCore.error("CLI_VERSION", "当前 Codex CLI 版本不支持本插件需要的调用方式，请更新 CLI。");
    }
    const login = await this.run(executable, ["login", "status"], { timeoutMs: 15000, signal });
    if (login.exitCode !== 0) throw CodexCore.error("LOGIN", "Codex CLI 尚未登录，请先在本机完成 codex login。");
    return version.stdout.match(/codex(?:-cli)?\s+[0-9][A-Za-z0-9.+-]*/i)?.[0] || "Codex CLI";
  },
  async bindPreferences(win) { return ReaderEnginePreferences.bind(win); },
  async openSelected(win) {
    if (this.state.busy) { this.showWindow(win); return; }
    const collected=await ReaderAttachments.selected(win);
    if(!collected.entries.length)throw CodexCore.error('SELECTION','所选文献没有 PDF 附件。');
    const entry=collected.entries[0];
    if(collected.entries.length!==1||entry.pdfs.length!==1||!entry.mainKey)return ReaderBatch.open(win,collected);
    if(entry.issue)throw CodexCore.error('SELECTION',entry.issue);
    const attachment=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,entry.mainKey);
    const { source } = await this.app.source(attachment);
    const cache = await this.app.cached(source, this.app.options());
    await ReaderNotes.destination(attachment);
    const saved=await ReaderSaved.matching(attachment,AttachmentCore.selection(entry));
    const chosen = Zotero.Prefs.get(this.app.pref + "reading.template", true);
    this.state = { title: attachment.getField("title") || source.name, source: cache?"已有解析缓存。完成后按设置生成笔记，或保存 Markdown 待导入。":"尚无解析缓存。开始后先向 MinerU 上传 PDF，再精读、核验并按设置保存结果。",
      cache, attachment,savedNoteKey:saved?.note.key,inputSelection:AttachmentCore.selection(entry),groupID:entry.groupID,templateID: Object.hasOwn(ReadingCore.TEMPLATES, chosen) ? chosen : "ecology", answer: "", report: "", view: "reading", message:saved?'已有精读笔记，可查看笔记，或重新精读生成新结果。':"选择模板后开始。", output: "", busy: false };
    this.showWindow(win);
    if (this.window && !this.window.closed) this.render();
  },
  showWindow(win) {
    if (this.window && !this.window.closed) { this.window.focus(); return; }
    win.openDialog("chrome://zotero-reader-independent/content/codex.xhtml", "", "chrome,dialog=no,resizable,centerscreen", { service: this });
  },
  bindWindow(win) {
    this.window = win;
    const get = id => win.document.getElementById("zrc-" + id);
    get("template").value = this.state.templateID;
    get("template").addEventListener("command", () => {
      this.state.templateID = get("template").value;
      Zotero.Prefs.set(this.app.pref + "reading.template", this.state.templateID, true);
      this.render();
    });
    get("send").addEventListener("click", () => ReaderAutomation.enqueueManual(this.state.attachment,this.state.templateID,{inputSelection:this.state.inputSelection,groupID:this.state.groupID}).catch(e => this.update({ message: this.app.safeError(e) })));
    get("cancel").addEventListener("click", () => {ReaderAutomation.stopCurrent();this.controller?.abort();});
    get("folder").addEventListener("click", () => { if (this.state.output) Zotero.File.reveal(this.state.output); });
    get("import").addEventListener("click",()=>{const path=this.state.output;ReaderAutomation.importResult(path).catch(e=>this.update({message:this.app.safeError(e)}));});
    get('resume').addEventListener('click',()=>this.resumeVerification(this.state.output).catch(e=>this.update({message:this.app.safeError(e)})));
    get('refresh').addEventListener('click',()=>this.refreshResult().catch(e=>this.update({message:this.app.safeError(e)})));
    get('saved').addEventListener('click',async()=>{try{const note=await Zotero.Items.getByLibraryAndKeyAsync(this.state.attachment.libraryID,this.state.savedNoteKey);await ReaderSaved.open(Zotero.getMainWindow(),note);}catch(e){this.update({message:this.app.safeError(e)});}});
    this.render();
  },
  unbindWindow(win) { if (this.window === win) this.window = null; },
  update(values) { Object.assign(this.state, values); this.render(); if(typeof ReaderAutomation!=="undefined")ReaderAutomation.refreshViews(); },
  render() {
    if (!this.window || this.window.closed) return;
    const get = id => this.window.document.getElementById("zrc-" + id);
    get("title").textContent = this.state.title;
    get("source").textContent = this.state.source;
    get("status").textContent = this.state.message;
    ReaderUI.reading(this.window,this.state);
    get("template").value = this.state.templateID;
    get("template").disabled = this.state.busy;
    get("send").disabled = this.state.busy || !this.state.attachment;
    get("send").textContent=(this.state.answer||this.state.savedNoteKey)&&!this.state.busy?"重新精读":"开始精读";
    get("send").classList.toggle("zr-primary",!this.state.deliveryPending&&!this.state.savedNoteKey);
    get("cancel").disabled = !this.state.busy;
    get("folder").disabled = !this.state.output;
    get("import").hidden=!this.state.deliveryPending;get("import").disabled=this.state.busy||!this.state.output||!["checked","edited"].includes(this.state.resultStatus);
    get('resume').hidden=!this.state.deliveryPending||this.state.resultStatus!=='verification_incomplete';get('resume').disabled=this.state.busy;
    get('refresh').hidden=!this.state.output;get('refresh').disabled=this.state.busy;
    get('saved').hidden=!this.state.savedNoteKey;get('saved').disabled=this.state.busy;
    const hint=!this.state.deliveryPending?'':this.state.resultStatus==='verification_incomplete'?'尚未完成检查：先点击“继续检查”，通过后即可导入。':this.state.resultStatus==='needs_review'?'仍有待核对内容：展开上方问题说明；修改 Markdown 后点击“刷新文件”，可导入人工修改稿。':this.state.resultStatus==='edited'?'将作为人工修改稿导入；修改后的内容未经模型重新检查。':'';
    get('import-hint').textContent=hint;get('import').title=hint;get('import').setAttribute('aria-describedby','zrc-import-hint');
  },
  async refreshResult(){
    const path=this.state.output,workflow=await this.app.readJSON(path);
    if(!workflow?.source)throw NoteCore.error('NOTE_SOURCE','无法找到当前精读结果。');
    return this.openResult(this.window||Zotero.getMainWindow(),path,workflow.source);
  },
  async openLatest(win){
    const collected=await ReaderAttachments.selected(win);
    if(collected.entries.length!==1)throw NoteCore.error("SELECTION","请选中一篇文献或它的 PDF 查看已有精读结果。");
    const entry=collected.entries[0],keys=new Set(entry.pdfs.map(p=>p.key));
    const jobs=Object.values(ReaderAutomation.state.jobs).filter(j=>j.libraryID===entry.libraryID&&keys.has(j.key)&&j.workflowPath).sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const job of jobs)if(await IOUtils.exists(job.workflowPath))return this.openResult(win,job.workflowPath,job);
    const found=new Map();
    for(const key of keys){const att=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,key);for(const result of await ReaderSaved.candidates(att))found.set(result.note.key,result);}
    const latest=[...found.values()].sort((a,b)=>String(b.record?.createdAt||b.note.dateModified||'').localeCompare(String(a.record?.createdAt||a.note.dateModified||'')))[0];
    if(!latest)throw NoteCore.error('NO_RESULT','尚未找到本地草稿或已同步的精读笔记，请先完成 Zotero 数据同步。');
    return ReaderSaved.open(win,latest.note);
  },
  async openResult(win,path,expected){
    if(this.state.busy)throw NoteCore.error("BUSY","当前模型任务正在运行，请完成或停止后再查看其他结果。");
    const dir=PathUtils.parent(path),id=PathUtils.filename(dir);
    NoteCore.identity(id,"reading");
    if(path!==PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent","readings",id,"workflow.json"))throw NoteCore.error("NOTE_PATH","结果目录无效。");
    const workflow=await this.app.readJSON(path);
    if(!workflow){const att=await Zotero.Items.getByLibraryAndKeyAsync(expected.libraryID,expected.key),saved=await ReaderSaved.byRun(id,att);if(saved)return ReaderSaved.open(win,saved.note);}
    if(!workflow?.source||workflow.source.key!==expected.key||workflow.source.libraryID!==expected.libraryID)throw NoteCore.error("NOTE_MISMATCH","精读结果与所选 PDF 不匹配。");
    const attachment=await Zotero.Items.getByLibraryAndKeyAsync(expected.libraryID,expected.key);
    const draft=ReadingCore.parseDraft(await IOUtils.readUTF8(PathUtils.join(dir,"draft.json")),{allowLegacy:Number(workflow.templateVersion||1)<4});
    let answer=this.renderReading(draft,null,workflow),report=ReadingCore.incompleteMessage(workflow.errorCode);
    if(["checked","needs_review"].includes(workflow.status)){
      const saved=await this.app.readJSON(PathUtils.join(dir,"verification.json")),paper=await this.app.readJSON(PathUtils.join(dir,"source-index.json"));
      const review=ReadingCore.parseReview(JSON.stringify(saved?.review)),assessment=ReadingCore.assess(draft,review,paper);
      answer=this.renderReading(draft,assessment,workflow);report=assessment.hasMajorIssues?ReadingCore.issueSummary(draft,assessment):"";
    }
    let manuallyEdited=false;
    const mdName=workflow.resultFile||"draft.md";
    if(["reading.md","review-needed.md","draft.md"].includes(mdName)){
      const mdPath=PathUtils.join(dir,mdName);
      if(await IOUtils.exists(mdPath)&&(await IOUtils.stat(mdPath)).size<=4*1024*1024){
        const current=await IOUtils.readUTF8(mdPath),expectedHash=workflow.resultFile?workflow.resultSHA256:workflow.draftSHA256;
        manuallyEdited=expectedHash?(await this.app.sha256(mdPath))!==expectedHash:current!==answer;answer=current;
        if(manuallyEdited)report="Markdown 已被修改。检查结论仅针对修改前内容，导入时会标注为人工修改稿。";
      }
    }
    this.state={title:attachment?.getField("title")||expected.title||expected.key,source:"已有精读结果。导入不请求模型；核验状态保持不变。",attachment,inputSelection:workflow.inputSelection,groupID:workflow.groupID,cache:null,templateID:workflow.templateID,
      answer,report,savedNoteKey:workflow.zoteroNotes?.reading?.key,phase:"complete",resultStatus:manuallyEdited?"edited":workflow.status,view:"reading",output:path,busy:false,deliveryPending:!workflow.zoteroNotes,
      message:workflow.zoteroNotes?"已有精读笔记；不会重复覆盖。":manuallyEdited||workflow.status==="checked"?"查看正文后，可导入精读笔记。":workflow.status==='verification_incomplete'?ReadingCore.incompleteMessage(workflow.errorCode):"请展开问题说明核对；修改 Markdown 后点击“刷新文件”，或重新精读。"};
    this.showWindow(win);this.render();
  },
  async exclusive(action) {
    if(ReaderCleanup.active||ReaderNotes.pending)throw CodexCore.error('BUSY','正在保存笔记或清理临时内容，请稍后开始。');
    if (this.active) throw CodexCore.error("BUSY", "已有模型调用正在进行，请等待完成或先停止。");
    this.controller = new AbortController();
    this.update({ busy: true });
    this.active = Promise.resolve().then(() => action(this.controller.signal));
    try { return await this.active; }
    finally { this.active = null; this.controller = null; this.update({ busy: false }); }
  },
  async readAndVerify() {
    return this.exclusive(async signal => {
      this.update({ answer: "", report: "", view: "reading", output: "", message: "正在检查解析结果和模型…" });
      const { source } = await this.app.source(this.state.attachment, signal);
      const cache = await this.app.cached(source, this.app.options());
      if (!cache || cache.dir !== this.state.cache.dir) throw CodexCore.error("CACHE_CHANGED", "PDF 或解析结果已变化，请关闭此窗口并重新打开后再发送。");
      const mdPath = PathUtils.join(cache.dir, ...MineruCore.safeZipPath(cache.manifest.markdown).split("/"));
      if ((await IOUtils.stat(mdPath)).size > CodexCore.MAX_PAPER_CHARS * 4) throw CodexCore.error("TEXT_SIZE", "正文过长，尚未发送；本阶段不会自动截断正文。");
      const markdown = await IOUtils.readUTF8(mdPath);
      const paper = ReadingCore.paper(markdown, this.state.title);
      return this.readPaper(paper, {source,bibliography:await ReaderNotes.bibliography(this.state.attachment),cacheGeneration:PathUtils.filename(cache.dir), markdownSHA256:cache.manifest.markdownSha256}, signal);
    });
  },
  async readPaper(paper, context, signal, hooks = {}) {
    const resumed=hooks.resume;
    const templateID=resumed?.metadata.templateID||this.state.templateID;
    ReadingCore.template(templateID);
    const generation=ReaderEngines.stage("generation"),verification=ReaderEngines.stage("verification");
    const templateText=resumed?.metadata.templateText||ReaderPreferences.templateText(templateID);
    const id=resumed?PathUtils.filename(resumed.dir):`${Date.now()}-${Zotero.Utilities.randomString(8).toLowerCase()}`;
    const dir=PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent","readings",id),internal=PathUtils.join(dir,"internal");
    await IOUtils.makeDirectory(internal,{createAncestors:true});
    const workflowPath=PathUtils.join(dir,"workflow.json");
    const metadata=resumed?{...resumed.metadata}:{schema:2,templateID,templateVersion:ReadingCore.VERSION,wikiInput:true,readingNaming:ReaderPreferences.naming(),status:"generating",createdAt:new Date().toISOString(),
      generatorEngine:generation.engine,verifierEngine:verification.engine,generatorModel:generation.model||null,verifierModel:verification.model||null,
      generatorEffort:generation.effort||null,verifierEffort:verification.effort||null,
      templateText,correctionRounds:0,maxCorrectionRounds:ReadingCore.MAX_REPAIR_ROUNDS,verificationMethod:"fresh-session-against-source-plus-local-quote-checks",...context};
    if(resumed){
      metadata.verificationResumes=(Number(metadata.verificationResumes)||0)+1;metadata.lastResumeAt=new Date().toISOString();
      metadata.verifierEngine=verification.engine;metadata.verifierModel=verification.model||null;metadata.verifierEffort=verification.effort||null;
      metadata.status='verifying';metadata.safeToImport=false;delete metadata.errorCode;
    }
    await this.app.writeJSON(workflowPath,metadata);
    if(!resumed){await this.app.writeJSON(PathUtils.join(dir,"source-index.json"),paper);await this.app.writeJSON(PathUtils.join(dir,'source.json'),WikiCore.receipt(metadata.bibliography,metadata.source,metadata.inputSources));}
    this.update({output:workflowPath,savedNoteKey:null,phase:resumed?'verifying':"generating",resultStatus:"",report:""});if(hooks.created)await hooks.created(workflowPath);
    let draft=resumed?.draft,review,assessment;
    const suffix=resumed?'-resume-'+metadata.verificationResumes:'';
    const storeDraft=async round=>{
      await this.app.writeJSON(PathUtils.join(dir,"draft.json"),draft);
      await this.app.writeJSON(PathUtils.join(internal,`draft-${round}${suffix}.json`),draft);
      const text=this.renderReading(draft,null,metadata);await IOUtils.writeUTF8(PathUtils.join(dir,"draft.md"),text);
      metadata.draftSHA256=await this.app.sha256(PathUtils.join(dir,"draft.md"));
      this.update({answer:text});
    };
    try{
      if(!resumed){const generated=await this.invoke(ReadingCore.generationPrompt(templateID,paper,templateText),{readingID:id,stage:"generation",templateID},signal,
        ()=>this.update({message:"正在整理研究问题、方法与核心发现…",phase:"generating"}),{schema:ReadingCore.draftSchema,...generation});
      draft=ReadingCore.parseDraft(generated.answer);metadata.generationRun=generated.output;await storeDraft(0);}
      for(let round=resumed?Math.max(0,Math.min(Number(metadata.correctionRounds)||0,ReadingCore.MAX_REPAIR_ROUNDS)):0;round<=ReadingCore.MAX_REPAIR_ROUNDS;round++){
        if(signal?.aborted)throw CodexCore.error("CANCELLED","已停止本次精读。");
        metadata.status="verifying";await this.app.writeJSON(workflowPath,metadata);
        this.update({message:round?"正在复查修订后的完整内容…":"正在对照原文检查…",phase:"verifying"});
        const verified=await this.invoke(ReadingCore.verificationPrompt(paper,draft),{readingID:id,stage:"verification",round,templateID},signal,
          ()=>{}, {schema:ReadingCore.reviewSchema,...verification});
        review=ReadingCore.parseReview(verified.answer);assessment=ReadingCore.assess(draft,review,paper);
        metadata.verificationRun=verified.output;
        await this.app.writeJSON(PathUtils.join(internal,`check-${round}${suffix}.json`),{review,assessment});
        await this.app.writeJSON(PathUtils.join(dir,"verification.json"),{review,assessment});
        if(!assessment.hasMajorIssues||round===ReadingCore.MAX_REPAIR_ROUNDS)break;
        metadata.status="correcting";await this.app.writeJSON(workflowPath,metadata);
        this.update({message:`发现需要修正的内容，正在修正（${round+1}/${ReadingCore.MAX_REPAIR_ROUNDS}）…`,phase:"correcting"});
        try{
          const corrected=await this.invoke(ReadingCore.repairPrompt(paper,draft,review,assessment,templateText),{readingID:id,stage:"correction",round:round+1,templateID},signal,
            ()=>{}, {schema:ReadingCore.draftSchema,...generation});
          const next=ReadingCore.parseDraft(corrected.answer);
          draft=next;assessment=null;review=null;
          metadata.correctionRounds=round+1;metadata.lastCorrectionRun=corrected.output;
          metadata.lastCorrectionEngine=generation.engine;metadata.lastCorrectionModel=generation.model||null;metadata.lastCorrectionEffort=generation.effort||null;
          await storeDraft(round+1);
        }catch(e){
          if(signal?.aborted||e.code==="CANCELLED")throw e;
          metadata.correctionErrorCode=e.code||"LOCAL";break;
        }
      }
      if(!assessment)throw ReadingCore.error("CHECK_INCOMPLETE","修订稿尚未完成复查。");
      if(signal?.aborted)throw CodexCore.error("CANCELLED","已停止，未发布结果。");
      const answer=this.renderReading(draft,assessment,metadata),resultName=assessment.hasMajorIssues?"review-needed.md":"reading.md";
      await IOUtils.writeUTF8(PathUtils.join(dir,resultName),answer);
      Object.assign(metadata,{status:assessment.status,safeToImport:!assessment.hasMajorIssues,resultFile:resultName,resultSHA256:await this.app.sha256(PathUtils.join(dir,resultName)),
        checkedEntries:assessment.checkedEntries,totalEntries:assessment.totalEntries,completedAt:new Date().toISOString()});
      await this.app.writeJSON(workflowPath,metadata);
      const summary=assessment.hasMajorIssues?ReadingCore.issueSummary(draft,assessment):"";
      this.update({answer,report:summary,output:workflowPath,phase:"complete",resultStatus:assessment.status,
        message:assessment.hasMajorIssues?"仍有重要内容需要核对，已保留本地草稿。":metadata.correctionRounds?"已修正并复查，精读内容已完成。":"检查完成，未发现重要问题。"});
      return {dir,answer,assessment,metadata};
    }catch(e){
      Object.assign(metadata,{status:draft?"verification_incomplete":"generation_failed",safeToImport:false,errorCode:e.code||"LOCAL"});
      await this.app.writeJSON(workflowPath,metadata);
      this.update({message:draft?ReadingCore.incompleteMessage(e.code):this.app.safeError(e),phase:"error",resultStatus:metadata.status,deliveryPending:Boolean(draft),report:draft?ReadingCore.incompleteMessage(e.code):"还没有完整的精读内容。"});
      throw e;
    }
  },
  async resumeVerification(path){
    if(this.app.state.busy)throw CodexCore.error('BUSY','当前仍在解析 PDF，请稍后继续检查。');
    const dir=PathUtils.parent(path),id=PathUtils.filename(dir);NoteCore.identity(id,'reading');
    if(path!==PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','readings',id,'workflow.json'))throw NoteCore.error('NOTE_PATH','精读结果目录无效。');
    return this.exclusive(async signal=>{
      const metadata=await this.app.readJSON(path);
      if(metadata?.status!=='verification_incomplete'||metadata.zoteroNotes)throw NoteCore.error('NOTE_STATE','这份结果不处于可继续检查的草稿状态，请刷新结果。');
      const attachment=await Zotero.Items.getByLibraryAndKeyAsync(metadata.source?.libraryID,metadata.source?.key);
      await ReaderNotes.destination(attachment);
      const {source}=await this.app.source(attachment,signal);
      if(source.sha256!==metadata.source.sha256)throw NoteCore.error('NOTE_CHANGED','正文 PDF 已改变，请重新精读。');
      await ReaderAttachments.validateWorkflow(metadata,attachment);
      const mdName=metadata.resultFile||'draft.md';
      if(!['draft.md','review-needed.md','reading.md'].includes(mdName))throw NoteCore.error('NOTE_PATH','结果文件名无效。');
      const mdPath=PathUtils.join(dir,mdName),hash=metadata.resultFile?metadata.resultSHA256:metadata.draftSHA256;
      if(await IOUtils.exists(mdPath)&&(!hash||await this.app.sha256(mdPath)!==hash))throw NoteCore.error('MANUAL_EDIT','Markdown 已被人工修改，未覆盖修改稿。请点击“刷新文件”后导入人工修改稿；继续检查仅适用于未修改的结构化草稿。');
      const draft=ReadingCore.parseDraft(await IOUtils.readUTF8(PathUtils.join(dir,'draft.json')),{allowLegacy:Number(metadata.templateVersion||1)<4});
      const paper=await this.app.readJSON(PathUtils.join(dir,'source-index.json'));
      if(!paper?.paragraphs?.length)throw NoteCore.error('NOTE_EVIDENCE','原文段落索引缺失，无法继续检查。');
      const job=ReaderAutomation.state.jobs[metadata.queueJobID||QueueCore.key(attachment.libraryID,attachment.key)];
      this.update({attachment,templateID:metadata.templateID,inputSelection:metadata.inputSelection,groupID:metadata.groupID,output:path,deliveryPending:true});
      let result;
      try{
        result=await this.readPaper(paper,{},signal,{resume:{metadata,draft,dir}});
      }catch(e){
        if(job?.workflowPath===path){job.state='verification_incomplete';job.errorCode=e.code||'LOCAL';job.message=ReadingCore.incompleteMessage(e.code);job.updatedAt=Date.now();await ReaderAutomation.persist();}
        this.update({deliveryPending:true});throw e;
      }
      if(job?.workflowPath===path){job.state=result.assessment.status==='checked'?'awaiting_import':'needs_review';job.message=result.assessment.status==='checked'?'检查完成，可以导入笔记':'仍有重要内容需要核对';delete job.errorCode;job.updatedAt=Date.now();await ReaderAutomation.persist();}
      this.update({deliveryPending:true,message:result.assessment.status==='checked'?'检查完成，点击“导入笔记”即可保存。':'检查完成，仍有重要内容需要核对，请展开问题说明。'});
      return result;
    });
  },
  renderReading(draft,assessment,workflow){
    const body=ReadingCore.renderDraft(draft,assessment,workflow.bibliography,workflow.inputSources);
    return WikiCore.decorate(body,workflow.bibliography,{...workflow,status:assessment?.status||'draft'});
  },
  testConnection(report = () => {},stage=ReaderEngines.stage("generation"),{mode="exact"}={}) {
    const requested={engine:stage.engine,model:stage.model||"",effort:stage.effort||""};
    const selected=mode==="quick"?EngineCore.quickStage(requested,ReaderEngines.catalogs[requested.engine]):requested;
    return this.exclusive(async signal=>{
      const started=Date.now();
      try{
        const quick=mode==='quick',prompt=quick?'ZRI_ENGINE_PING\nReply with exactly ZRI_OK. Do not use tools.':'ZRI_ENGINE_HEALTH\nReturn exactly the JSON object {"ok":true}. Do not use tools.';
        const result=await this.invoke(prompt,{test:true,testMode:mode},signal,report,{...selected,...(quick?{}:{schema:EngineCore.healthSchema}),timeoutMs:quick?60000:180000});
        let data;try{data=JSON.parse(result.answer);}catch(_){}
        if(quick?result.answer.trim()!=='ZRI_OK':data?.ok!==true)throw CodexCore.error("HEALTH_FORMAT",quick?"模型有响应，但没有返回测试标记。":"模型有响应，但未通过结构化输出检查。");
        await ReaderEngines.recordHealth(selected,{success:true,connectivityOnly:quick,version:result.metadata.version,durationMs:Date.now()-started,...(quick?{requestedStage:requested}:{})});return {...result,testedStage:selected,requestedStage:requested,durationMs:Date.now()-started};
      }catch(e){
        if(e.code!=="CANCELLED")await ReaderEngines.recordHealth(selected,{success:false,errorCode:e.code,connectivityOnly:mode==='quick',...(mode==="quick"?{requestedStage:requested}:{})});
        throw e;
      }
    });
  },
  async invoke(input, context, signal, report, request = {}) {
    const started=Date.now();
    const engine=request.engine||ReaderEngines.stage("generation").engine;
    report(`正在检查 ${EngineCore.name(engine)}…`);
    const prepared=await ReaderEngines.prepare(engine,signal),executable=prepared.executable;
    let version=prepared.version;const preflightMs=Date.now()-started;
    const opts = this.options();
    const model = request.model === undefined ? opts.model : CodexCore.options({model:request.model}).model;
    const effort=request.effort||"";
    await ReaderEngines.validateEffort({engine,model,effort});
    const runID = `${Date.now()}-${Zotero.Utilities.randomString(8).toLowerCase()}`;
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "zotero-reader-independent", "codex-runs", runID);
    const workdir = PathUtils.join(dir, "work");
    await IOUtils.makeDirectory(workdir, { createAncestors: true });
    const extension = request.schema ? "json" : "md";
    const temporary = PathUtils.join(dir, "answer.pending."+extension), output = PathUtils.join(dir, "answer."+extension);
    const schemaPath = request.schema ? PathUtils.join(dir,"output-schema.json") : null;
    if(schemaPath) await this.app.writeJSON(schemaPath,request.schema);
    const metadata = { schema: 1, engine: engine+"-cli", version, modelRequested: model || null,effort:effort||null,
      mode: "text-only", createdAt: new Date().toISOString(), status: "running", ...context };
    const infoPath = PathUtils.join(dir, "run.json");
    await this.app.writeJSON(infoPath, metadata);
    const events = CodexCore.eventReader(report);
    try {
      report(`正在调用 ${EngineCore.name(engine)}，正文通过标准输入传入…`);
      const callStarted=Date.now();
      if(engine==="antigravity"){
        const result=await ReaderEngines.invokeAgy(input,{model,effort,prepared,workdir,schemaPath,settingsPath:PathUtils.join(dir,"agy-settings.json"),timeoutMs:request.timeoutMs||opts.timeoutMinutes*60000},signal,report);
        metadata.version=result.version;await IOUtils.writeUTF8(temporary,result.answer);
      }else{
        const result = await this.run(executable, CodexCore.argumentsFor({ model, effort, workdir, output: temporary, schemaPath }), {
        workdir, input, signal, timeoutMs: request.timeoutMs||opts.timeoutMinutes * 60000, onStdout: text => events.push(text)
      });
      if (result.exitCode !== 0 || events.failure()) throw CodexCore.classifyFailure(events.failure() + "\n" + result.stderr, result.exitCode);
      }
      if (!await IOUtils.exists(temporary)) throw CodexCore.error("NO_ANSWER", "Codex 没有生成最终回答文件；不会把过程日志当作回答。");
      const stat = await IOUtils.stat(temporary);
      if (stat.size > CodexCore.MAX_ANSWER_BYTES) throw CodexCore.error("ANSWER_SIZE", "回答文件异常过大，未发布为成功结果。");
      const answer = await IOUtils.readUTF8(temporary);
      if (!answer.trim()) throw CodexCore.error("NO_ANSWER", "Codex 返回了空回答，请重试。");
      if (signal?.aborted) throw CodexCore.error("CANCELLED", "已停止本次调用，未保存不完整回答。");
      await IOUtils.move(temporary, output, { noOverwrite: true });
      const completed = { ...metadata, status: "complete", completedAt: new Date().toISOString(), answerFile: "answer."+extension,timing:{preflightMs,callMs:Date.now()-callStarted,totalMs:Date.now()-started,preflightCached:prepared.cached} };
      await this.app.writeJSON(infoPath, completed);
      return { answer, output, metadata: completed };
    } catch (e) {
      await IOUtils.remove(temporary, { ignoreAbsent: true });
      const safe = e instanceof CodexCore.CodexError ? e : CodexCore.error("LOCAL", "模型调用或结果保存失败，请检查本机配置和目录权限。");
      await this.app.writeJSON(infoPath, { ...metadata, status: "failed", errorCode: safe.code });
      throw safe;
    }
  },
  async shutdown() {
    this.controller?.abort();
    if (this.active) await this.active.catch(() => {});
    if (this.window && !this.window.closed) this.window.close();
    this.window = null;
  }
};
