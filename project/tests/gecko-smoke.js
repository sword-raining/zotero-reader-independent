/* Runs ONLY in a disposable Zotero profile with a synthetic file and mocked cloud. */
async function runGeckoSmoke(app) {
  // These legacy pipeline/UI checks inspect intermediate files after importing.
  // Real deletion is separately exercised by --saved-cleanup in the native host.
  const realCleanup=readerScope.ReaderCleanup.afterSave;
  readerScope.ReaderCleanup.afterSave=async()=>({state:'retained',message:'Test fixture retains intermediate files for assertions'});
  const results = [];
  const root = PathUtils.profileDir;
  const output = PathUtils.join(root, "smoke-result.json");
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const check = async (name, action) => {
    try { await action(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: String(e), stack: e.stack }); }
    await IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  };
  const C = readerScope.MineruCore;
  const realDiscoverAll=readerScope.ReaderEngines.discoverAll;
  readerScope.ReaderEngines.discoverAll=async()=>{
    for(const engine of ['codex','antigravity'])readerScope.ReaderEngines.catalogs[engine]={engine,version:'test',models:[{id:'mock-reader',label:'Mock reader'}],cached:false};
    return [];
  };
  const samplePath = PathUtils.join(root, "synthetic.pdf");
  const zipPath = PathUtils.join(root, "fixture.zip");
  const invalidZipPath = PathUtils.join(root, "traversal.zip");
  const sampleKey = "isolated-test-key-not-a-real-token";
  let main;
  for (let i = 0; i < 60; i++) {
    main = Zotero.getMainWindow();
    if (main?.document.getElementById("zotero-itemmenu")) break;
    await Zotero.Promise.delay(500);
  }
  await check("isolated data directory", async () => {
    assert(Zotero.DataDirectory.dir.startsWith(root), "test must not use the personal library");
  });
  if (!Zotero.DataDirectory.dir.startsWith(root)) return;
  await check("startup and context menu", async () => {
    assert(main, "main window absent");
    app.addWindow(main);
    assert(main.document.getElementById("zri-menu"), "menu missing");
    assert(Zotero.PreferencePanes.pluginPanes.some(p => p.id === app.paneID), "preferences registration missing");
  });
  await check("installer accepts XPI manifest and compatibility", async () => {
    const { AddonManager } = main.ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const file = Zotero.File.pathToFile(PathUtils.join(root, 'extensions', app.id + '.xpi'));
    const installer = await AddonManager.getInstallForFile(file);
    assert(!installer.error && installer.addon?.isCompatible && !installer.addon.appDisabled, 'XPI validation failed: ' + installer.error);
    assert(installer.addon.id === app.id, 'wrong installation target');
    installer.cancel();
  });
  await check("credential save/read/replace/clear in disposable profile", async () => {
    await app.saveKey(sampleKey);
    assert(app.keyLogin().password === sampleKey, "key did not persist");
    await app.saveKey(sampleKey + "-replacement");
    assert(app.keyLogin().password.endsWith("-replacement"), "key replacement failed");
    app.clearKey(); assert(!app.keyLogin(), "key not cleared");
    await app.saveKey(sampleKey);
  });
  await check("native fetch and bounded response reader without network", async () => {
    const result = await app.request('data:application/json,%7B%22sample%22%3Atrue%7D', {
      method: 'GET', headers: {}, responseType: 'json', maxBytes: 1000
    });
    assert(result.status === 200 && result.data.sample === true, "native response reader failed");
    let bounded = false;
    try { await app.request('data:text/plain,0123456789', {method:'GET',headers:{},responseType:'bytes',maxBytes:2}); }
    catch(e) { bounded = e.code === 'RESPONSE_SIZE'; }
    assert(bounded, "response size limit failed");
  });
  const fakeAttachment=new Zotero.Item('attachment');
  fakeAttachment.libraryID=Zotero.Libraries.userLibraryID;
  fakeAttachment.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;fakeAttachment.attachmentPath=samplePath;
  fakeAttachment.attachmentContentType='application/pdf';fakeAttachment.setField('title','Synthetic PDF');await fakeAttachment.saveTx({skipSelect:true});
  let saved;
  let calls = [];
  await check("full mock cloud parse with real Gecko files, ZIP, hash and cache", async () => {
    const fixture = await IOUtils.read(zipPath);
    app.request = async (url, options) => {
      calls.push({ url, method: options.method, hasAuth: Boolean(options.headers?.Authorization) });
      if (url.endsWith("/file-urls/batch")) return { status: 200, data: { code: 0, data: { batch_id: "smoke-batch", file_urls: ["https://example.com/upload"] } } };
      if (options.method === "PUT") {
        assert(typeof options.body.arrayBuffer === "function", "upload not a Blob");
        assert(options.body.size > 0, "empty upload");
        assert(!options.headers.Authorization, "token leaked to upload host");
        return { status: 200 };
      }
      if (url.includes("extract-results/batch")) return { status: 200, data: { code: 0, data: { extract_result: [
        { data_id: `reader-${fakeAttachment.libraryID}-${fakeAttachment.key}`, file_name: "synthetic.pdf", state: "done", full_zip_url: "https://example.com/result.zip" }
      ] } } };
      assert(!options.headers.Authorization, "token leaked to download host");
      return { status: 200, data: fixture };
    };
    saved = await app.parseAttachment(fakeAttachment, true, new main.AbortController().signal);
    assert(saved.manifest.status === "complete", "incomplete manifest");
    assert(saved.manifest.files.some(f => f.path.endsWith("figure.png")), "figure absent");
    assert(saved.manifest.files.some(f => f.path.endsWith("content_list.json")), "structured text absent");
    assert(calls.length === 4, "unexpected request count");
    await app.present(saved);
    assert(app.state.preview.includes("Synthetic paper"), "preview text absent");
  });
  await check("persistent cache reused without key or network", async () => {
    app.clearKey();
    const before = calls.length;
    const reused = await app.parseAttachment(fakeAttachment, false);
    assert(reused.cached, "cache not reused");
    assert(calls.length === before, "cache hit accessed network");
    // Re-open index from disk through a new source calculation.
    const { source } = await app.source(fakeAttachment);
    assert((await app.cached(source, app.options())).dir === saved.dir, "cache index not durable");
  });
  const codex = readerScope.ReaderCodex;
  const codexCore = readerScope.CodexCore;
  const reading = readerScope.ReadingCore;
  const fixtureConfig = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, 'fixture-config.json')));
  const realResolver = codex.resolveExecutable;
  const originalOptions = codex.options;
  const fakeExecutable = {command:fixtureConfig.nodePath, prefix:[PathUtils.join(root, 'fake-codex.cjs')]};
  await check('Gecko appends Antigravity update opt-out only to its child environment',async()=>{
    const updateBefore=Services.env.get('AGY_CLI_DISABLE_AUTO_UPDATE');
    const script='process.stdout.write(JSON.stringify({update:process.env.AGY_CLI_DISABLE_AUTO_UPDATE||"",path:!!process.env.PATH}))';
    const exe={command:fixtureConfig.nodePath,prefix:[]};
    const agy=await codex.run({...exe,engine:'antigravity'},['-e',script],{timeoutMs:5000});
    const other=await codex.run(exe,['-e',script],{timeoutMs:5000});
    const a=JSON.parse(agy.stdout),b=JSON.parse(other.stdout);
    assert(agy.exitCode===0&&a.update==='true'&&a.path,'update opt-out or inherited PATH missing');
    assert(other.exitCode===0&&b.update===updateBefore&&b.path,'other engine environment changed');
    assert(Services.env.get('AGY_CLI_DISABLE_AUTO_UPDATE')===updateBefore,'parent environment changed');
  });
  let codexSaved;
  await check('native Codex executable discovery and version', async () => {
    const executable = await codex.resolveExecutable();
    assert(/\.exe$/i.test(executable.command) && !executable.prefix.length, 'not a direct Windows native executable');
    const version = await codex.run(executable, ['--version'], {timeoutMs:15000});
    assert(version.exitCode === 0 && /codex/i.test(version.stdout), 'native version command failed');
  });
  codex.resolveExecutable = async () => fakeExecutable;
  await check('Gecko Codex stdin EOF, dual pipe draining and Unicode result', async () => {
    const text = codexCore.validateMarkdown('中文文本'.repeat(40000)+'FINAL_SENTINEL');
    const r = await codex.invoke(text, {test:true,question:'测试问题'}, new main.AbortController().signal, () => {});
    assert(r.answer.includes('末尾标记 true'), 'long input was truncated');
    assert(r.answer.includes('字符数 '+text.length), 'Unicode or stdin transmission mismatch');
    const info = await app.readJSON(PathUtils.join(PathUtils.parent(r.output), 'run.json'));
    assert(info.status === 'complete' && info.mode === 'text-only', 'result metadata incomplete');
    codexSaved = r;
  });
  await check('cached paper → generation → fresh verification → checked reading', async () => {
    codex.state = {...codex.state, title:'Synthetic paper', attachment:fakeAttachment, cache:saved, templateID:'ecology'};
    const r = await codex.readAndVerify();
    assert(r.assessment.status==='checked','verified workflow did not complete');
    assert(r.metadata.generationRun!==r.metadata.verificationRun,'generation and verification reused one process output');
    assert(await IOUtils.exists(PathUtils.join(r.dir,'reading.md')),'checked reading not published');
    assert(!await IOUtils.exists(PathUtils.join(r.dir,'verification.md')),'separate report was exported');
    for(const heading of ['研究背景','为什么要开展这项研究','为什么能发表在这个期刊'])assert(r.answer.includes('## '+heading),'new required front section missing: '+heading);
    assert(r.metadata.templateVersion===4&&r.assessment.totalEntries===13,'new structure or full checking coverage missing');
    assert(codex.state.busy===false,'workflow did not settle');
  });
  await check('flagged verification remains a marked draft without reading.md', async () => {
    const paper=reading.paper('# Synthetic paper __SIM_REVIEW_ISSUE__\n\nA synthetic source statement for testing.');
    const r=await codex.readPaper(paper,{test:true},new main.AbortController().signal);
    assert(r.assessment.status==='needs_review','flagged claim passed');
    assert(!await IOUtils.exists(PathUtils.join(r.dir,'reading.md')),'unchecked reading published');
    assert(await IOUtils.exists(PathUtils.join(r.dir,'review-needed.md')),'marked draft absent');
    assert(r.answer.includes('待核实'),'draft flags absent');
    assert(r.metadata.correctionRounds===2,'repair limit was not applied');
  });
  await check('major issues are corrected and the revised draft is independently rechecked',async()=>{
    let calls=[];const invoke=codex.invoke;
    codex.invoke=async function(input,context,...args){calls.push(context.stage);return invoke.call(this,input,context,...args);};
    let result;try{result=await codex.readPaper(reading.paper('# Synthetic paper __SIM_FIXABLE__\n\nOriginal source for repair.'),{test:true},new main.AbortController().signal);}finally{codex.invoke=invoke;}
    assert(JSON.stringify(calls)===JSON.stringify(['generation','verification','correction','verification']),'revised draft did not get a fresh check');
    assert(result.metadata.correctionRounds===1&&result.assessment.status==='checked','repair did not produce a checked result');
    assert(!result.answer.includes('__BROKEN_CLAIM__'),'incorrect claim survived correction');
  });
  await check('minor expression suggestions do not force extra model calls',async()=>{
    const r=await codex.readPaper(reading.paper('# Synthetic paper __SIM_MINOR__'),{test:true},new main.AbortController().signal);
    assert(r.assessment.status==='checked'&&r.metadata.correctionRounds===0,'minor feedback blocked the note');
  });
  await check('an invalid correction cannot replace the last valid draft or pass checks',async()=>{
    const r=await codex.readPaper(reading.paper('# Synthetic paper __SIM_REVIEW_ISSUE__ __SIM_REPAIR_INVALID__'),{test:true},new main.AbortController().signal);
    assert(r.assessment.hasMajorIssues&&r.metadata.safeToImport===false,'invalid correction was accepted');
    assert(!await IOUtils.exists(PathUtils.join(r.dir,'reading.md')),'invalid correction published a note');
  });
  await check('verification network failure and malformed response cannot pass', async () => {
    for(const marker of ['__SIM_VERIFY_ERROR__','__SIM_VERIFY_INVALID__']) {
      let caught;
      try{await codex.readPaper(reading.paper('# Synthetic paper '+marker),{test:true},new main.AbortController().signal);}catch(e){caught=e;}
      assert(caught,'verification error suppressed');
      const dir=PathUtils.parent(codex.state.output), info=await app.readJSON(codex.state.output);
      assert(info.status==='verification_incomplete','failed verifier marked successful');
      assert(await IOUtils.exists(PathUtils.join(dir,'draft.md')),'draft lost on verification failure');
      assert(!await IOUtils.exists(PathUtils.join(dir,'reading.md')),'failed verification published checked reading');
    }
  });
  await check('cancellation between stages prevents verification call',async()=>{
    const invoke=codex.invoke, controller=new main.AbortController();let count=0,caught;
    codex.invoke=async function(...args){count++;const r=await invoke.apply(this,args);controller.abort();return r;};
    try{await codex.readPaper(reading.paper('# Synthetic paper cancellation fixture'),{test:true},controller.signal);}catch(e){caught=e;}
    finally{codex.invoke=invoke;}
    assert(caught?.code==='CANCELLED'&&count===1,'second stage ran after cancellation');
  });
  await check('Codex failure does not publish an answer or expose diagnostics', async () => {
    let caught;
    try { await codex.invoke('__SIM_NONZERO__', {test:true}, new main.AbortController().signal, () => {}); }
    catch(e) { caught=e; }
    assert(caught?.code === 'LOGIN', 'authentication failure not classified');
    assert(!app.safeError(caught).includes('sk-test-only-secret'), 'raw diagnostic leaked');
    assert(await IOUtils.exists(codexSaved.output), 'previous successful answer was lost');
  });
  await check('missing and empty Codex final answer are rejected', async () => {
    for (const marker of ['__SIM_NO_FILE__','__SIM_EMPTY__']) {
      let caught;
      try { await codex.invoke(marker, {test:true}, new main.AbortController().signal, () => {}); }
      catch(e) { caught=e; }
      assert(caught?.code === 'NO_ANSWER', 'process log treated as answer');
    }
  });
  await check('Gecko native process timeout and cancellation settle', async () => {
    const work = PathUtils.join(root,'cancel-work'); await IOUtils.makeDirectory(work, {ignoreExisting:true});
    const args = codexCore.argumentsFor({workdir:work, output:PathUtils.join(work,'answer.md')});
    let caught;
    try { await codex.run(fakeExecutable,args,{input:'__SIM_SLEEP__',timeoutMs:300}); } catch(e) {caught=e;}
    assert(caught?.code === 'TIMEOUT','native process did not time out');
    const controller = new main.AbortController();
    const timer = main.setTimeout(()=>controller.abort(),300);
    caught=null;
    try { await codex.run(fakeExecutable,args,{input:'__SIM_SLEEP__',timeoutMs:5000,signal:controller.signal}); } catch(e) {caught=e;}
    finally {main.clearTimeout(timer);}
    assert(caught?.code === 'CANCELLED','native process did not cancel');
  });
  await check('reading window keeps checks in the background without a report tab', async () => {
    codex.showWindow(main);
    for(let i=0;i<40 && !codex.window;i++) await Zotero.Promise.delay(250);
    assert(codex.window?.document.getElementById('zrc-template'), 'template selector missing');
    assert(!codex.window.document.getElementById('zrc-question'),'free-question control remains');
    assert(codex.window.document.getElementById('zrc-template').itemCount===2,'unexpected template modes');
    const templateMenu=codex.window.document.getElementById('zrc-template');
    templateMenu.open=true;
    for(let i=0;i<30&&templateMenu.menupopup.state!=='open';i++)await Zotero.Promise.delay(100);
    assert(templateMenu.menupopup.state==='open','reading template popup did not open');templateMenu.open=false;
    templateMenu.getItemAtIndex(1).doCommand();assert(codex.state.templateID==='general','reading template command did not apply');
    assert(!codex.window.document.getElementById('zrc-report-view'),'separate report tab remains');
    assert(codex.window.document.getElementById('zrc-attention'),'unresolved issue summary absent');
    codex.update({answer:'## Synthetic heading\n\n- Synthetic content <script>unsafe()</script>'});
    const heading=codex.window.document.getElementById('zrc-answer').querySelector('h3');
    assert(heading?.namespaceURI==='http://www.w3.org/1999/xhtml'&&codex.window.getComputedStyle(heading).display==='block','reading headings did not render as HTML blocks');
    assert(!codex.window.document.getElementById('zrc-answer').querySelector('script'),'reading preview injected script markup');
    codex.window.close();
  });
  await runStage4Smoke(app,readerScope,main,check);
  codex.resolveExecutable = realResolver;
  await check("changed PDF invalidates cache", async () => {
    await IOUtils.writeUTF8(samplePath, "%PDF-1.4\nchanged synthetic fixture");
    const { source } = await app.source(fakeAttachment);
    assert(!await app.cached(source, app.options()), "changed file reused old cache");
  });
  await check("ZIP traversal is rejected without writing outside generation", async () => {
    let rejected = false;
    try { await app.extractResults(invalidZipPath, PathUtils.join(root, "rejected-result")); }
    catch (e) { rejected = e.code === "ZIP_PATH"; }
    assert(rejected, "traversal was not rejected");
    assert(!await IOUtils.exists(PathUtils.join(root, "escaped.txt")), "unsafe file written");
  });
  await check("preferences markup loaded and controls bound", async () => {
    Zotero.Utilities.Internal.openPreferences(app.paneID);
    let win;
    for (let i = 0; i < 60; i++) {
      win = Services.wm.getMostRecentWindow("zotero:pref");
      if (win?.document.getElementById("zri-save")?.dataset.bound) break;
      await Zotero.Promise.delay(250);
    }
    assert(win?.document.getElementById("zri-save")?.dataset.bound, "preferences binding failed");
    assert(win.document.getElementById("zri-key").type === "password", "key field not masked");
    assert(win.document.getElementById("zri-key").value === "", "saved key populated in DOM");
    assert(win.document.getElementById('zri-codex-save')?.dataset.bound, 'Codex preference handlers missing');
    assert(win.document.getElementById('zri-codex-test'), 'connection test button missing');
    assert(win.document.getElementById('zri-codex-verify-model'), 'verifier model setting absent');
    assert(win.document.getElementById('zri-auto-enabled')?.dataset.bound,'automation checkbox not bound');
    assert(win.document.getElementById('zri-auto-enabled').checked===false,'automation checkbox unexpectedly enabled');
    win.close();
  });
  await check("task window markup and preview", async () => {
    app.showTask(main);
    for (let i = 0; i < 40 && !app.taskWindows.size; i++) await Zotero.Promise.delay(250);
    assert(app.taskWindows.size === 1, "task window not bound");
    const win = [...app.taskWindows][0];
    assert(win.document.getElementById("zri-task-preview").textContent.includes("Synthetic paper"), "task preview failed");
    win.close();
  });
  await check("no test token in preferences or cache manifest", async () => {
    const manifest = await IOUtils.readUTF8(PathUtils.join(saved.dir, "reader-manifest.json"));
    assert(!manifest.includes(sampleKey), "token in cache manifest");
    Services.prefs.savePrefFile(null);
    const prefs = await IOUtils.readUTF8(PathUtils.join(root, "prefs.js"));
    assert(!prefs.includes(sampleKey), "token in prefs.js");
  });
  app.clearKey();
  if(fixtureConfig.liveReading){
    const E=readerScope.ReaderEngines,oldDiscover=E.discoverAll,keys=['ai.generation.engine','ai.generation.model','ai.generation.effort','ai.verification.engine','ai.verification.model','ai.verification.effort'];
    const oldPrefs=Object.fromEntries(keys.map(k=>[k,Zotero.Prefs.get(app.pref+k,true)]));
    E.discoverAll=realDiscoverAll;
    try{
      await E.discoverAll();
      const gen=E.catalogs.codex?.models?.find(m=>m.isDefault)||E.catalogs.codex?.models?.[0];
      const ver=E.catalogs.antigravity?.models?.find(m=>m.id.includes('flash')&&m.id.endsWith('-low'));
      if(!gen||!ver)throw new Error('Required live engines unavailable');
      for(const [k,v] of Object.entries({'ai.generation.engine':'codex','ai.generation.model':gen.id,'ai.generation.effort':gen.reasoningEfforts?.includes('medium')?'medium':'','ai.verification.engine':'antigravity','ai.verification.model':ver.id,'ai.verification.effort':'low'}))Zotero.Prefs.set(app.pref+k,v,true);
      codex.state={...codex.state,templateID:'general'};
      const paper=reading.paper('SYNTHETIC METHODS EXAMPLE FOR SOFTWARE TESTING. This is an unpublished teaching example, not a real journal article. No journal, DOI, editorial decision, or journal scope is supplied.\n\nTitle: Synthetic moisture and biomass teaching example. Authors: Ada Example and Lei Example. Both authors are affiliated with the Fictional Soil Institute, Test City. Corresponding author: Ada Example.\n\nBackground: Measurements of microbial biomass alone do not determine microbial process rates. The teaching example asks whether a moisture-biomass association could motivate a later water manipulation.\n\nDesign and methods: An observational survey sampled 24 synthetic grassland sites once. Sites were not randomly assigned to water treatments. Moisture and microbial biomass were compared using a linear association model.\n\nResults: Moisture was positively associated with microbial biomass in the synthetic dataset. No microbial activity, carbon residence time, or causal water effect was measured.\n\nDiscussion: The fictional authors propose water availability as one possible explanation, but soil texture and plant inputs could also explain the association. They explicitly state that this observational design does not establish causation. A future water-manipulation experiment is suggested. No figures or supplementary material are supplied.','Synthetic unpublished methods example');
      const result=await codex.exclusive(signal=>codex.readPaper(paper,{test:true,source:{synthetic:true}},signal));
      const draft=await app.readJSON(PathUtils.join(result.dir,'draft.json'));
      await app.writeJSON(PathUtils.join(root,'live-reading-result.json'),{success:result.assessment.status==='checked',status:result.assessment.status,templateVersion:result.metadata.templateVersion,models:{generation:gen.id,verification:ver.id},correctionRounds:result.metadata.correctionRounds,sectionKeys:draft.sections.map(s=>s.key),draft,markdown:result.answer,scope:'Synthetic text only; no user paper or Zotero note written'});
    }catch(e){await app.writeJSON(PathUtils.join(root,'live-reading-result.json'),{success:false,error:String(e)});}
    finally{E.discoverAll=oldDiscover;for(const[k,v]of Object.entries(oldPrefs))Zotero.Prefs.set(app.pref+k,v===undefined?'':v,true);}
  }
  if(fixtureConfig.liveAgyStartup){
    const E=readerScope.ReaderEngines,originalRun=codex.run,calls=[],tests=[];
    const before=Services.env.get('AGY_CLI_DISABLE_AUTO_UPDATE');
    codex.run=async function(exe,args,extra){
      if(exe.engine!=='antigravity')return originalRun.call(this,exe,args,extra);
      const log=PathUtils.join(root,`agy-startup-${calls.length}.log`);
      const call={kind:args.includes('--version')?'version':args.includes('--help')?'help':args[0]==='models'?'models':'chat'};calls.push(call);
      // --log-file is a chat option, not a flag accepted by the models subcommand.
      const r=await originalRun.call(this,exe,call.kind==='chat'?[...args,'--log-file',log]:args,extra);
      const text=await IOUtils.exists(log)?await IOUtils.readUTF8(log):'';
      call.exitCode=r.exitCode;
      call.updaterDisabled=text.includes('Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE');
      call.updaterSpawned=text.includes('Spawned background update process');
      return r;
    };
    try{
      E.probeCache.clear();
      const c=await E.discover('antigravity');
      const model=c.models.find(m=>m.id.includes('flash')&&m.id.endsWith('-low'));
      assert(model,'advertised low-effort Flash model missing');
      for(const name of ['first','repeat']){
        const r=await codex.testConnection(()=>{},{engine:'antigravity',model:model.id,effort:'low'},{mode:'quick'});
        tests.push({name,success:r.answer.trim()==='ZRI_OK',durationMs:r.durationMs,timing:r.metadata.timing});
      }
      const chat=calls.filter(c=>c.kind==='chat');
      const success=tests.every(t=>t.success)&&chat.length===2&&chat.every(c=>c.updaterDisabled)&&!calls.some(c=>c.updaterSpawned)&&Services.env.get('AGY_CLI_DISABLE_AUTO_UPDATE')===before;
      await app.writeJSON(PathUtils.join(root,'live-agy-startup-result.json'),{success,version:c.version,model:model.id,calls,tests,parentEnvironmentUnchanged:Services.env.get('AGY_CLI_DISABLE_AUTO_UPDATE')===before});
    }catch(e){await app.writeJSON(PathUtils.join(root,'live-agy-startup-result.json'),{success:false,error:app.safeError(e),calls,tests});}
    finally{codex.run=originalRun;}
  }
  if(fixtureConfig.liveEngines){
    readerScope.ReaderEngines.discoverAll=realDiscoverAll;
    const results={};
    for(const engine of ['codex','antigravity']){
      try{const c=await readerScope.ReaderEngines.discover(engine);results[engine]={success:true,version:c.version,models:c.models,source:c.source};}
      catch(e){results[engine]={success:false,code:e.code,message:app.safeError(e)};}
    }
    for(const engine of ['codex','antigravity'])if(results[engine].success){
      const models=results[engine].models;
      const model=engine==='codex'?(models.find(m=>m.isDefault)||models[0]):(models.find(m=>m.id.includes('flash')&&m.id.endsWith('-low'))||models[0]);
      const effort=engine==='codex'?(model.reasoningEfforts?.includes('high')?'high':model.reasoningEfforts?.[0]||''):scopeEffort(model.id);
      function scopeEffort(id){return id.match(/-(low|medium|high)$/)?.[1]||'';}
      try{const r=await codex.testConnection(()=>{},{engine,model:model.id,effort},{mode:'quick'});results[engine].test={success:true,exact:r.answer.trim()==='ZRI_OK',requestedModel:model.id,requestedEffort:effort,model:r.testedStage.model,effort:r.metadata.effort,durationMs:r.durationMs,timing:r.metadata.timing,version:r.metadata.version,testedAt:new Date().toISOString()};}
      catch(e){results[engine].test={success:false,code:e.code,message:app.safeError(e),model:model.id};}
    }
    await app.writeJSON(PathUtils.join(root,'live-engines-result.json'),results);
  }
  if(fixtureConfig.liveVerification){
    let live;
    const nativeRun=codex.run;
    codex.run=async function(executable,args,extra){
      const r=await nativeRun.call(this,executable,args,extra);
      if(args[0]==='exec'&&!args.includes('--help')&&r.exitCode!==0){
        const messages=[];
        for(const line of r.stdout.split('\n')){try{const event=JSON.parse(line);if(['error','turn.failed'].includes(event.type))messages.push(String(event.error?.message||event.message||''));}catch(_){}}
        const scrub=s=>s.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted-key]').replace(/https?:\/\/[^\s"<>]+/g,'[URL]').slice(-5000);
        await app.writeJSON(PathUtils.join(root,'live-verification-diagnostic.json'),{exitCode:r.exitCode,messages:messages.map(scrub),diagnostic:scrub(r.stderr)});
      }
      return r;
    };
    codex.options=()=>({...originalOptions.call(codex),timeoutMinutes:3});
    try{
      const paper=reading.paper('An observational survey sampled 24 grassland sites. Sites were not randomly assigned to treatments.\n\nSoil moisture was positively associated with microbial biomass. The authors explicitly state that the observational design does not establish causation.','Synthetic verification challenge');
      const texts=['该研究采用观察性调查。','研究调查了240个草地样地。','研究采用随机分配的操纵实验。','土壤水分与微生物生物量呈正相关。','研究证明水分增加导致微生物生物量增加。','作者指出观察性设计不能建立因果关系。','结果提示后续可通过操纵实验进一步检验机制。'];
      const draft={sections:reading.LEGACY_SECTIONS.map(([key],i)=>({key,entries:[{id:key+'-1',text:texts[i],kind:i===6?'interpretation':'reported',evidence:[{paragraph_id:i<3?'P0001':'P0002',quote:paper.paragraphs[i<3?0:1].text}]}]}))};
      const r=await codex.invoke(reading.verificationPrompt(paper,draft),{test:true,stage:'verification-challenge'},new main.AbortController().signal,()=>{}, {schema:reading.reviewSchema});
      const review=reading.parseReview(r.answer),assessment=reading.assess(draft,review,paper);
      const bad=['design-1','methods-1','mechanisms-1'],good=['question-1','results-1'];
      live={success:true,detectedAllInjectedErrors:bad.every(id=>['unsupported','contradicted','overstated','uncertain'].includes(review.checks.find(c=>c.entry_id===id)?.verdict)),
        acceptedSupportedClaims:good.every(id=>review.checks.find(c=>c.entry_id===id)?.verdict==='supported'),status:assessment.status,
        verdicts:review.checks.map(c=>({id:c.entry_id,verdict:c.verdict,reason:c.reason})),output:r.output};
      await app.writeJSON(PathUtils.join(root,'live-verification-full.json'),{source:paper,draft,review,assessment});
    }catch(e){live={success:false,code:e.code||'UNKNOWN',message:app.safeError(e)};}
    finally{codex.options=originalOptions;codex.run=nativeRun;}
    await app.writeJSON(PathUtils.join(root,'live-verification-result.json'),live);
  }
  if (fixtureConfig.liveCodexTest) {
    let live;
    codex.options = () => ({...originalOptions.call(codex),timeoutMinutes:3});
    try {
      const r = await codex.testConnection();
      live = {success:true,exact:JSON.parse(r.answer).ok===true,answer:r.answer.slice(0,100),output:r.output};
    } catch(e) { live={success:false,code:e.code||'UNKNOWN',message:app.safeError(e)}; }
    finally {codex.options=originalOptions;}
    await IOUtils.writeUTF8(PathUtils.join(root,'live-codex-result.json'),JSON.stringify(live,null,2));
  }
  await IOUtils.writeUTF8(output, JSON.stringify({ completed: true, tests: results }, null, 2));
  readerScope.ReaderCleanup.afterSave=realCleanup;
  Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
}
