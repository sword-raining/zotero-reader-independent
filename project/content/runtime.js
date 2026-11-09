"use strict";
Components.utils.importGlobalProperties(["fetch", "AbortController", "TextDecoder", "TextEncoder", "URL", "Blob", "File"]);
var ReaderTimers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
var ReaderApp = {
  id: "zotero-reader-independent@local",
  pref: "extensions.zotero.readerIndependent.",
  paneID: "zotero-reader-independent-settings",
  credentialOrigin: "chrome://zotero-reader-independent",
  credentialRealm: "MinerU API",
  windows: new Set(),
  taskWindows: new Set(),
  state: { busy: false, title: "", message: "就绪", preview: "", resultDir: "", detail: "" },
  previewHashes: new Map(), previewHashTTL:60000, previewHashLimit:512,
  controller: null,
  activeRun: null,
  async startup(rootURI) {
    this.rootURI = rootURI;
    await Zotero.PreferencePanes.register({
      pluginID: this.id, id: this.paneID, label: "Zotero Reader 独立版",
      src: rootURI + "content/preferences.xhtml",stylesheets:[rootURI+"content/ui.css"]
    });
  },
  async shutdown() {
    this.controller?.abort();
    if (this.activeRun) await this.activeRun.catch(() => {});
    for (const win of [...this.windows]) this.removeWindow(win);
    for (const win of [...this.taskWindows]) { if (!win.closed) win.close(); }
    this.taskWindows.clear();
    Zotero.PreferencePanes.unregister(this.paneID);
  },
  keyLogin() {
    try {
      return Services.logins.findLogins(this.credentialOrigin, null, this.credentialRealm)
        .find(login => login.username === "mineru") || null;
    } catch (_) {
      throw MineruCore.error("KEY_STORAGE", "无法访问 Zotero 凭据存储，请解锁或检查 Zotero 配置。");
    }
  },
  async saveKey(value) {
    const key = MineruCore.normalizeKey(value);
    const login = Components.classes["@mozilla.org/login-manager/loginInfo;1"]
      .createInstance(Components.interfaces.nsILoginInfo);
    login.init(this.credentialOrigin, null, this.credentialRealm, "mineru", key, "", "");
    const existing = this.keyLogin();
    if (existing) Services.logins.modifyLogin(existing, login);
    else await Services.logins.addLoginAsync(login);
  },
  clearKey() {
    const login = this.keyLogin();
    if (login) Services.logins.removeLogin(login);
  },
  options() {
    return MineruCore.settings({
      model: Zotero.Prefs.get(this.pref + "model", true),
      language: Zotero.Prefs.get(this.pref + "languageMode", true) || "auto",
      ocr: Zotero.Prefs.get(this.pref + "ocr", true)
    });
  },
  bindPreferences(win) {
    ReaderUI.bindPreferences(win);
    const doc = win.document;
    const get = id => doc.getElementById("zri-" + id);
    if (!get("save") || get("save").dataset.bound) return;
    get("save").dataset.bound = "true";
    const status = message => { get("settings-status").textContent = message; };
    const showKeyState = () => {
      try { get("key-state").textContent = this.keyLogin() ? "已保存密钥。输入框留空即可继续使用。" : "尚未保存密钥。"; }
      catch (e) { status(this.safeError(e)); }
    };
    const opts = this.options();
    get("model").value = opts.model;
    get("language").value = opts.language;
    get("ocr").checked = opts.ocr;
    showKeyState();
    get("show").addEventListener("click", () => {
      const visible = get("key").type === "password";
      get("key").type = visible ? "text" : "password";
      get("show").textContent = visible ? "隐藏" : "显示";
    });
    get("save").addEventListener("click", async () => {
      get("save").disabled = true;
      try {
        if (get("key").value.trim()) await this.saveKey(get("key").value);
        const options = MineruCore.settings({ model: get("model").value, language: get("language").value, ocr: get("ocr").checked });
        for (const [name, value] of Object.entries(options)) Zotero.Prefs.set(this.pref + (name === "language" ? "languageMode" : name), value, true);
        get("key").value = "";
        get("key").type = "password";
        get("show").textContent = "显示";
        showKeyState();
        status("设置已保存。保存本身不会上传 PDF；实际解析时会验证密钥是否有效。");
      } catch (e) { status(this.safeError(e)); }
      finally { get("save").disabled = false; }
    });
    get("clear").addEventListener("click", () => {
      try { this.clearKey(); get("key").value = ""; showKeyState(); status("已清除密钥，已有解析结果仍可查看。"); }
      catch (e) { status(this.safeError(e)); }
    });
    ReaderCodex.bindPreferences(win).catch(e => status(this.safeError(e)));
    ReaderAutomation.bindPreferences(win);
    ReaderClassifier.bind(win);
    ReaderCoordination.bind(win);
    ReaderLanguage.bind(win);
    ReaderIndexes.bind(win);
    ReaderPreferences.bind(win);
    const clean=get('cleanup-saved'),cleanupStatus=get('cleanup-status');clean.addEventListener('click',async()=>{
      clean.disabled=true;clean.textContent='正在清理…';cleanupStatus.textContent='正在核对已保存笔记与生成记录…';
      try{const r=await ReaderCleanup.sweepCompleted();if(win.closed)return;cleanupStatus.textContent=`已清理 ${r.cleaned} 项完成任务。`+(r.retained?` ${r.retained} 项保留：\n`+r.details.map(x=>x.title+'：'+x.reason).join('\n'):'')+(r.skipped?`\n${r.skipped} 项未完成或未确认归档，继续保留。`:'')+(r.sharedCacheRetained?'\n仍在使用或含额外文件的共享解析缓存已保留。':'');}
      catch(e){if(!win.closed)cleanupStatus.textContent=this.safeError(e);}
      finally{if(!win.closed){clean.disabled=false;clean.textContent='清理已完成任务';cleanupStatus.scrollIntoView({block:'nearest'});}}
    });
  },
  addWindow(win) {
    if (this.windows.has(win)) return;
    const doc = win.document;
    const parent = doc.getElementById("zotero-itemmenu");
    if (!parent) return;
    const menu = doc.createXULElement("menu");
    menu.id = "zri-menu";
    menu.setAttribute("label", "Zotero Reader");
    const popup = doc.createXULElement("menupopup");
    const actions = [
      ['zri-menu-read','精读文献…',()=>ReaderCodex.openSelected(win)],
      ['zri-menu-result','打开精读结果…',()=>ReaderCodex.openLatest(win)],
      ['zri-menu-settings','设置…',()=>Zotero.Utilities.Internal.openPreferences(this.paneID)]
    ];
    for(const [id,label,action]of actions){const item=doc.createXULElement('menuitem');item.id=id;item.setAttribute('label',label);item.addEventListener('command',()=>Promise.resolve().then(action).catch(e=>this.alert(win,this.safeError(e))));popup.appendChild(item);}
    const updateMenu=()=>{
      const selected=(win.ZoteroPane||Zotero.getActiveZoteroPane()).getSelectedItems()||[],groups=new Set(selected.filter(item=>!item.deleted&&(item.isRegularItem()||item.isPDFAttachment())).map(item=>item.libraryID+':'+(item.parentID||item.id)));
      const read=doc.getElementById('zri-menu-read'),result=doc.getElementById('zri-menu-result');if(!read||!result)return;
      read.setAttribute('label',groups.size>1?'精读选中文献…':'精读文献…');read.disabled=!groups.size;result.disabled=groups.size!==1;
    };
    popup.addEventListener('popupshowing',event=>{if(event.target===popup)updateMenu();});
    menu.appendChild(popup);
    parent.appendChild(menu);
    this.windows.add(win);
  },
  removeWindow(win) {
    win.document.getElementById("zri-menu")?.remove();
    this.windows.delete(win);
  },
  alert(win, text) { Services.prompt.alert(win, "Zotero Reader", text); },
  safeError(e) {
    return e instanceof MineruCore.ReaderError || e instanceof CodexCore.CodexError || e instanceof ReadingCore.ReadingError || e instanceof NoteCore.NoteError ? e.message : "操作失败，请检查文件读写权限或稍后重试。未记录密钥和服务器原始响应。";
  },
  update(values) {
    Object.assign(this.state, values);
    for (const win of this.taskWindows) { if (!win.closed) this.renderTask(win); }
    if(typeof ReaderAutomation!=="undefined")ReaderAutomation.refreshViews();
  },
  showTask(win) {
    for (const task of this.taskWindows) { if (!task.closed) { task.focus(); return; } }
    win.openDialog("chrome://zotero-reader-independent/content/task.xhtml", "", "chrome,dialog=no,resizable,centerscreen", { app: this });
  },
  bindTask(win) {
    this.taskWindows.add(win);
    const doc = win.document;
    doc.getElementById("zri-task-cancel").addEventListener("click", () => this.controller?.abort());
    doc.getElementById("zri-task-folder").addEventListener("click", () => {
      if (this.state.resultDir) Zotero.File.reveal(PathUtils.join(this.state.resultDir, "reader-manifest.json"));
    });
    this.renderTask(win);
  },
  unbindTask(win) { this.taskWindows.delete(win); },
  renderTask(win) {
    const get = id => win.document.getElementById("zri-task-" + id);
    get("title").textContent = this.state.title;
    get("status").textContent = this.state.message;
    get("detail").textContent = this.state.detail;
    get("preview").textContent = this.state.preview;
    get("cancel").disabled = !this.state.busy;
    get("folder").disabled = !this.state.resultDir;
  },
  async selectedAttachments(win) {
    const items = (win.ZoteroPane || Zotero.getActiveZoteroPane()).getSelectedItems();
    const result = new Map();
    for (const item of items || []) {
      if (item.isPDFAttachment()) result.set(item.id, item);
      else if (item.isRegularItem()) {
        for (const id of item.getAttachments()) {
          const attachment = await Zotero.Items.getAsync(id);
          if (attachment.isPDFAttachment()) result.set(id, attachment);
        }
      }
    }
    if (!result.size) throw MineruCore.error("SELECTION", "请选中 PDF 附件，或至少包含一个 PDF 附件的文献。");
    return [...result.values()];
  },
  async startSelected(win, force, explicitAttachments=null) {
    if(ReaderCleanup.active||ReaderNotes.pending)throw MineruCore.error('BUSY','正在保存笔记或清理临时内容，请稍后解析。');
    if(ReaderAutomation.active){ReaderCodex.showWindow(win);return;}
    if (this.state.busy) { this.showTask(win); return; }
    const attachments = explicitAttachments||await this.selectedAttachments(win);
    this.controller = new AbortController();
    this.update({ busy: true, resultDir: "", preview: "", detail: "", title: "准备解析", message: "正在检查 PDF…" });
    this.showTask(win);
    this.activeRun = this.runAttachments(attachments, force, this.controller.signal);
    try { await this.activeRun; }
    finally { this.activeRun = null; this.controller = null; this.update({ busy: false }); }
  },
  async runAttachments(attachments, force, signal) {
    let completed = 0;
    const failures = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      this.update({ title: `${i + 1} / ${attachments.length} · ${att.getField("title") || att.key}`,
        resultDir: "", preview: "", detail: "", message: "检查 PDF 和已有缓存…" });
      try {
        MineruCore.cancelled(signal);
        const result = await this.parseAttachment(att, force, signal);
        await this.present(result);
        completed++;
      } catch (e) {
        const message = this.safeError(e);
        failures.push(`${att.getField("title") || att.key}：${message}`);
        this.update({ message, detail: failures.join("\n") });
        if (signal.aborted || ["KEY_MISSING", "KEY_FORMAT", "AUTH", "API_A0202", "API_A0211"].includes(e.code)) break;
      }
    }
    if (attachments.length > 1) this.update({ message: `处理结束：成功 ${completed} / ${attachments.length}。`, detail: failures.join("\n") });
  },
  cacheRoot() { return PathUtils.join(Zotero.DataDirectory.dir, "zotero-reader-independent", "cache"); },
  attachmentDir(source) {
    if (!Number.isInteger(source.libraryID) || source.libraryID < 0 || !/^[A-Z0-9]{8}$/.test(source.key)) {
      throw MineruCore.error("SOURCE_ID", "PDF 附件标识无效。");
    }
    return PathUtils.join(this.cacheRoot(), String(source.libraryID), source.key);
  },
  async sha256(path, signal) {
    const hasher = Components.classes["@mozilla.org/security/hash;1"].createInstance(Components.interfaces.nsICryptoHash);
    hasher.init(hasher.SHA256);
    let offset = 0;
    while (true) {
      MineruCore.cancelled(signal);
      const chunk = await IOUtils.read(path, { offset, maxBytes: 1024 * 1024 });
      if (!chunk.length) break;
      hasher.update(chunk, chunk.length);
      offset += chunk.length;
    }
    return Array.from(hasher.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  },
  async sha256Text(text){
    const bytes=new TextEncoder().encode(text),hash=Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
    hash.init(hash.SHA256);hash.update(bytes,bytes.length);return Array.from(hash.finish(false),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  },
  async preflightSHA256(path,info,signal){
    MineruCore.cancelled(signal);
    const now=Date.now(),stamp=String(info.size)+':'+String(info.lastModified),saved=this.previewHashes.get(path);
    if(saved&&saved.stamp===stamp&&now-saved.at>=0&&now-saved.at<this.previewHashTTL)return saved.hash;
    this.previewHashes.delete(path);
    const hash=await this.sha256(path,signal),after=await IOUtils.stat(path);
    MineruCore.cancelled(signal);
    if(after.size!==info.size||after.lastModified!==info.lastModified)throw MineruCore.error('PDF_CHANGED','预检时 PDF 仍在变化，请稍后重试。');
    if(this.previewHashes.size>=this.previewHashLimit)this.previewHashes.delete(this.previewHashes.keys().next().value);
    this.previewHashes.set(path,{stamp,hash,at:now});return hash;
  },
  async source(attachment, signal, {preflight=false}={}) {
    const path = await attachment.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) throw MineruCore.error("PDF_MISSING", "PDF 尚未下载到本机，请先在 Zotero 中打开或下载附件。");
    const info = await IOUtils.stat(path);
    if (!info.size) throw MineruCore.error("EMPTY", "PDF 文件为空。");
    if (info.size > MineruCore.MAX_PDF_BYTES) throw MineruCore.error("SIZE", "PDF 超过 200 MB，请拆分后再解析。");
    const source = { libraryID: attachment.libraryID, key: attachment.key, name: PathUtils.filename(path),
      size: info.size, sha256: preflight?await this.preflightSHA256(path,info,signal):await this.sha256(path, signal) };
    const after=await IOUtils.stat(path);
    if(info.size!==after.size||info.lastModified!==after.lastModified||path!==await attachment.getFilePathAsync())throw MineruCore.error('PDF_CHANGED','PDF 在读取期间发生变化，本次未继续。');
    return { source, path };
  },
  assertIndexes(){if(typeof ReaderIndexes!=='undefined')ReaderIndexes.assertHealthy();},
  async readJSON(path) {
    if(typeof ReaderIndexes!=='undefined'){const name=ReaderIndexes.name(path);if(name)return ReaderIndexes.store.open(path,name);}
    try { return JSON.parse(await IOUtils.readUTF8(path)); } catch (_) { return null; }
  },
  async writeJSON(path, value) {
    if(typeof ReaderIndexes!=='undefined'){const name=ReaderIndexes.name(path);if(name)return ReaderIndexes.store.save(path,name,value);}
    await IOUtils.writeUTF8(path, JSON.stringify(value, null, 2), { tmpPath: path + ".tmp" });
  },
  async readModelSource(cache,signal){
    MineruCore.cancelled(signal);
    const mdPath=PathUtils.join(cache.dir,...MineruCore.safeZipPath(cache.manifest.markdown).split('/'));
    if((await IOUtils.stat(mdPath)).size>SourceCore.MAX_CHARS*4)throw MineruCore.error('TEXT_SIZE','解析正文过长，未发送模型。');
    const markdown=await IOUtils.readUTF8(mdPath),inputs=[],fingerprints=[];let total=0;
    for(const file of SourceCore.files(cache.manifest)){
      MineruCore.cancelled(signal);
      const path=PathUtils.join(cache.dir,...MineruCore.safeZipPath(file.path).split('/'));
      const size=(await IOUtils.stat(path)).size;total+=size;
      if(size>SourceCore.MAX_JSON_BYTES||total>SourceCore.MAX_TOTAL_JSON_BYTES)throw MineruCore.error('SOURCE_SIZE','页面脚注的结构化结果过大，未忽略后继续精读。');
      if(Number.isFinite(file.size)&&file.size!==size)throw MineruCore.error('CACHE_CHANGED','结构化解析缓存已变化，请重新解析后再精读。');
      const text=await IOUtils.readUTF8(path);let data;try{data=JSON.parse(text);}catch(_){throw MineruCore.error('SOURCE_STRUCTURE','页面脚注的结构化结果无法读取，未忽略后继续精读。');}
      inputs.push({path:file.path,format:file.format,data});fingerprints.push({path:file.path,sha256:await this.sha256Text(text)});
    }
    let assembled;try{assembled=SourceCore.assemble(markdown,inputs);}catch(e){throw MineruCore.error(e.code||'SOURCE_STRUCTURE',e.message);}
    MineruCore.cancelled(signal);
    return {...assembled,diagnostics:{...assembled.diagnostics,fingerprints,assembledSHA256:await this.sha256Text(assembled.markdown)}};
  },
  async cached(source, options) {
    const base = this.attachmentDir(source);
    const pointer = await this.readJSON(PathUtils.join(base, "current.json"));
    if (!/^[a-z0-9-]+$/.test(pointer?.generation || "")) return null;
    const dir = PathUtils.join(base, pointer.generation);
    const manifest = await this.readJSON(PathUtils.join(dir, "reader-manifest.json"));
    if (!MineruCore.cacheMatches(manifest, source, options) || !Array.isArray(manifest.files)) return null;
    try {
      for (const file of manifest.files) {
        const path = PathUtils.join(dir, ...MineruCore.safeZipPath(file.path).split("/"));
        if ((await IOUtils.stat(path)).size !== file.size) return null;
      }
      const markdownPath = PathUtils.join(dir, ...MineruCore.safeZipPath(manifest.markdown).split("/"));
      if (await this.sha256(markdownPath) !== manifest.markdownSha256) return null;
      return { dir, manifest, cached: true };
    } catch (_) { return null; }
  },
  async parseAttachment(attachment, force, signal) {
    const { source, path } = await this.source(attachment, signal);
    const options = this.options();
    const base = this.attachmentDir(source);
    await IOUtils.makeDirectory(base, { createAncestors: true, ignoreExisting: true });
    if (!force) {
      const cache = await this.cached(source, options);
      if (cache) return cache;
    }
    const key = MineruCore.normalizeKey(this.keyLogin()?.password);
    const journalPath = PathUtils.join(base, "pending.json");
    const journal = force ? null : await this.readJSON(journalPath);
    const matchingJournal = journal?.source?.sha256 === source.sha256 && journal?.optionsKey === MineruCore.settingsKey(options) &&
      /^[A-Za-z0-9_-]+$/.test(journal?.batchID || "") && Date.now() - journal.uploadedAt < 24 * 60 * 60 * 1000;
    const client = new MineruCore.Client({ request: this.request.bind(this), sleep: this.sleep.bind(this) });
    let parsed;
    try {
      parsed = await client.parse({ key, file: new Blob([await File.createFromFileName(path)], { type: "" }),
        source, options, signal, resume: matchingJournal ? journal : null,
        report: (stage, message) => this.update({ message }),
        checkpoint: data => this.writeJSON(journalPath, { ...data, source, optionsKey: MineruCore.settingsKey(options) })
      });
    } catch (e) {
      if (["PARSE_FAILED", "API_-60012", "API_-60013", "RESULT_MISMATCH"].includes(e.code)) {
        await IOUtils.remove(journalPath, { ignoreAbsent: true });
      }
      throw e;
    }
    MineruCore.cancelled(signal);
    this.update({ message: "正在校验并保存解析结果…" });
    if (await this.sha256(path, signal) !== source.sha256) throw MineruCore.error("PDF_CHANGED", "解析期间 PDF 内容发生了变化，请重新解析。");
    const result = await this.saveResult(base, source, options, parsed, signal);
    await IOUtils.remove(journalPath, { ignoreAbsent: true });
    return result;
  },
  async saveResult(base, source, options, parsed, signal) {
    const generation = `${source.sha256.slice(0, 16)}-${Date.now()}-${Zotero.Utilities.randomString(6).toLowerCase()}`;
    const dir = PathUtils.join(base, generation);
    await IOUtils.makeDirectory(dir, { ignoreExisting: false });
    const zipPath = PathUtils.join(dir, "mineru-result.zip");
    await IOUtils.write(zipPath, parsed.bytes);
    parsed.bytes = null;
    const files = await this.extractResults(zipPath, dir, signal);
    const markdownFiles = files.filter(f => /(?:^|\/)full\.md$/i.test(f.path));
    const fallback = files.filter(f => /\.md$/i.test(f.path));
    const markdown = markdownFiles.length === 1 ? markdownFiles[0] : fallback.length === 1 ? fallback[0] : null;
    if (!markdown) throw MineruCore.error("RESULT_MD", "解析结果中没有唯一可识别的正文 Markdown，未发布缓存。");
    const markdownPath = PathUtils.join(dir, ...markdown.path.split("/"));
    if (!(await IOUtils.readUTF8(markdownPath)).trim()) throw MineruCore.error("RESULT_MD", "解析正文为空，未发布缓存。");
    const manifest = {
      schema: 1, status: "complete", provider: "mineru-cloud", source, options,
      optionsKey: MineruCore.settingsKey(options), createdAt: new Date().toISOString(),
      batchID: parsed.batchID, markdown: markdown.path,
      markdownSha256: await this.sha256(markdownPath, signal), files
    };
    await this.writeJSON(PathUtils.join(dir, "reader-manifest.json"), manifest);
    MineruCore.cancelled(signal);
    // Publish only a complete generation. Previous successful results remain intact on failure.
    await this.writeJSON(PathUtils.join(base, "current.json"), { generation });
    return { dir, manifest, cached: false };
  },
  async extractResults(zipPath, dir, signal) {
    const zip = Components.classes["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
    const plans = [];
    const targets = new Set();
    let total = 0;
    let count = 0;
    try {
      zip.open(Zotero.File.pathToFile(zipPath));
      const entries = zip.findEntries(null);
      while (entries.hasMore()) {
        if (++count > 10000) throw MineruCore.error("ZIP_SIZE", "结果压缩包文件过多。");
        const name = entries.getNext();
        const entry = zip.getEntry(name);
        const relative = MineruCore.safeZipPath(name);
        if (entry.isDirectory) continue;
        total += entry.realSize;
        if (entry.realSize > 64 * 1024 * 1024 || total > 1024 * 1024 * 1024) throw MineruCore.error("ZIP_SIZE", "解压后的结果超过本地大小限制。");
        if (!/\.(md|json|png|jpe?g|webp|gif|bmp|tiff?)$/i.test(relative)) continue;
        if (["reader-manifest.json", "mineru-result.zip"].includes(relative.toLowerCase())) throw MineruCore.error("ZIP_PATH", "结果文件名与插件元数据冲突。");
        if (targets.has(relative.toLowerCase())) throw MineruCore.error("ZIP_PATH", "结果压缩包包含重复路径。");
        targets.add(relative.toLowerCase());
        plans.push({ name, path: relative, size: entry.realSize });
      }
      for (const plan of plans) {
        MineruCore.cancelled(signal);
        const path = PathUtils.join(dir, ...plan.path.split("/"));
        await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
        const input = zip.getInputStream(plan.name);
        const binary = Components.classes["@mozilla.org/binaryinputstream;1"].createInstance(Components.interfaces.nsIBinaryInputStream);
        binary.setInputStream(input);
        try { await IOUtils.write(path, new Uint8Array(binary.readByteArray(plan.size))); }
        finally { binary.close(); }
        if ((await IOUtils.stat(path)).size !== plan.size) throw MineruCore.error("ZIP_SIZE", "解析文件写入不完整。");
      }
      return plans.map(({ path, size }) => ({ path, size }));
    } finally { zip.close(); }
  },
  async present(result) {
    const path = PathUtils.join(result.dir, ...MineruCore.safeZipPath(result.manifest.markdown).split("/"));
    const text = await IOUtils.readUTF8(path);
    const images = result.manifest.files.filter(f => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f.path)).length;
    const contentLists = result.manifest.files.filter(f => /content_list(?:_v\d+)?\.json$/i.test(f.path)).length;
    this.update({ message: result.cached ? "已读取独立缓存，无需重新上传。" : "PDF 解析完成，结果已保存。",
      resultDir: result.dir, preview: text.slice(0, 150000) + (text.length > 150000 ? "\n\n[预览仅显示前 150,000 字符；保存的正文完整。]" : ""),
      detail: `已保存 ${result.manifest.files.length} 个文件，含 ${images} 个图片文件。` +
        (contentLists ? "结构化内容已保存。" : "服务未提供 content_list，后续不能据此保证页码定位。") });
  },
  async viewSelected(win) {
    if (this.state.busy) { this.showTask(win); return; }
    const attachments = await this.selectedAttachments(win);
    const { source } = await this.source(attachments[0]);
    const result = await this.cached(source, this.options());
    if (!result) throw MineruCore.error("NO_CACHE", "此 PDF 在当前解析设置下没有完整有效的缓存，请先解析。");
    this.update({ title: attachments[0].getField("title") || source.name });
    await this.present(result);
    this.showTask(win);
  },
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      MineruCore.cancelled(signal);
      const onAbort = () => {
        ReaderTimers.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(MineruCore.error("CANCELLED", "已停止本地等待；已提交的云端任务可能继续运行。"));
      };
      const timer = ReaderTimers.setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
  async request(url, options) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = ReaderTimers.setTimeout(() => { timedOut = true; controller.abort(); }, options.timeout || 60000);
    try {
      MineruCore.cancelled(options.signal);
      const response = await fetch(url, {
        method: options.method, headers: options.headers, body: options.body, signal: controller.signal,
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"
      });
      if (!response.ok || options.responseType === "empty") {
        await response.body?.cancel();
        return { status: response.status };
      }
      const max = options.maxBytes || 2 * 1024 * 1024;
      const announced = Number(response.headers.get("content-length"));
      if (announced > max) { await response.body?.cancel(); throw MineruCore.error("RESPONSE_SIZE", "服务器返回的结果过大。"); }
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > max) { await reader.cancel(); throw MineruCore.error("RESPONSE_SIZE", "服务器返回的结果过大。"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (options.responseType === "bytes") return { status: response.status, data: bytes };
      try { return { status: response.status, data: JSON.parse(new TextDecoder().decode(bytes)) }; }
      catch (_) { throw MineruCore.error("RESPONSE", "服务器返回了无效的 JSON 响应。"); }
    } catch (e) {
      MineruCore.cancelled(options.signal);
      if (timedOut) throw MineruCore.error("TIMEOUT", "网络请求超时，可稍后重试。", true);
      if (e instanceof MineruCore.ReaderError) throw e;
      throw MineruCore.error("NETWORK", "网络连接失败，请检查网络后重试。", true);
    } finally {
      ReaderTimers.clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }
};
