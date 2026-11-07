async function runSettingsSmoke(app,scope,main,check,helpers){
  const {createPDF,until,sleep,parent}=helpers,engines=scope.ReaderEngines,prefs=scope.ReaderPreferences,codex=scope.ReaderCodex,auto=scope.ReaderAutomation;
  const root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
  const config=await app.readJSON(PathUtils.join(root,'fixture-config.json'));
  const realResolve=engines.resolve,realDiscoverAll=engines.discoverAll,originalInvoke=codex.invoke;
  const keys=['ai.generation.engine','ai.generation.model','ai.generation.effort','ai.verification.engine','ai.verification.model','ai.verification.effort','delivery.mode','templates.ecology','noteNames.reading','noteNames.verification'];
  const previous=Object.fromEntries(keys.map(k=>[k,Zotero.Prefs.get(app.pref+k,true)]));
  const fake=engine=>({command:config.nodePath,prefix:[PathUtils.join(root,'fake-engines.cjs'),engine],engine});
  const assert=(v,m)=>{if(!v)throw new Error(m);};let win,job,inferenceCalls=0;
  engines.resolve=async engine=>fake(engine);
  engines.discoverAll=async()=>Promise.allSettled([engines.discover('codex'),engines.discover('antigravity')]);
  codex.invoke=async function(...args){inferenceCalls++;return originalInvoke.apply(this,args);};
  try{
    await check('both engine catalogs are discovered via their native protocols',async()=>{
      const results=await engines.discoverAll();assert(results.every(r=>r.status==='fulfilled'),'model discovery failed');
      assert(engines.catalogs.codex.models.some(m=>m.id==='mock-codex-reader'),'Codex RPC models absent');
      assert(engines.catalogs.antigravity.models.some(m=>m.id==='mock-agy-reader'),'agy model list absent');
    });
    await check('CLI preflight is cached and quick connectivity does not claim high-effort validation',async()=>{
      engines.probeCache.clear();const run=codex.run;let probes=0;
      codex.run=async function(exe,args,...rest){if(args.includes('--version')||args.includes('--help')||args[0]==='login')probes++;return run.call(this,exe,args,...rest);};
      try{await engines.prepare('codex');await engines.prepare('codex');assert(probes===3,'warm preparation repeated CLI version/help/login');}finally{codex.run=run;}
      const high={engine:'codex',model:'mock-codex-reader',effort:'high'};delete engines.health[scope.EngineCore.healthKey(high)];
      delete engines.health[scope.EngineCore.healthKey({...high,effort:'low'})];
      const quick=await codex.testConnection(()=>{},high,{mode:'quick'});
      assert(quick.testedStage.effort==='low'&&quick.metadata.effort==='low','quick request did not use advertised lower effort');
      assert(engines.healthFor(high).state==='untested'&&engines.connectivityFor(high).state==='available','quick request falsely validated high effort');
      assert(engines.healthFor({...high,effort:'low'}).state==='untested','plain connectivity was mislabeled as structured-output validation');
      const exact=await codex.testConnection(()=>{},high,{mode:'exact'});assert(exact.metadata.effort==='high'&&engines.healthFor(high).state==='available','exact test lost selected effort');
    });
    await check('all nine preference menus open native popups and accept menu commands',async()=>{
      Zotero.Utilities.Internal.openPreferences(app.paneID);
      await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-template-save')?.dataset.bound&&!win.document.getElementById('zri-codex-check').disabled;});
      win.document.title='Zotero Reader — 隔离测试';
      const doc=win.document,menus=[...doc.querySelectorAll('#zri-settings menulist')];
      assert(menus.length===9&&!doc.querySelector('#zri-settings select'),'unconverted HTML selection control');
      for(const menu of menus){
        const panel=menu.closest('[role="tabpanel"]');doc.getElementById(panel.getAttribute('aria-labelledby')).click();
        const detail=menu.closest('details');if(detail)detail.open=true;
        menu.scrollIntoView({block:'nearest'});win.focus();
        await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
        menu.open=true;try{await until(()=>menu.menupopup.state==='open',3000);}catch(e){throw new Error(menu.id+' popup did not open: '+menu.menupopup.state);}
        menu.open=false;try{await until(()=>menu.menupopup.state==='closed',3000);}catch(e){throw new Error(menu.id+' popup did not close: '+menu.menupopup.state);}
        assert(menu.itemCount>=2,'missing choices: '+menu.id);
        const original=menu.value,item=menu.getItemAtIndex(menu.selectedIndex===0?1:0),target=item.getAttribute('value');
        item.doCommand();assert(menu.value===target,'native menu choice failed: '+menu.id);
        const restore=[...menu.menupopup.children].find(n=>n.getAttribute('value')===original);restore?.doCommand();
      }
      win.close();win=null;
    });
    await check('settings separate engines/models and persist editable template, delivery and names',async()=>{
      Zotero.Utilities.Internal.openPreferences(app.paneID);
      await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-template-save')?.dataset.bound&&!win.document.getElementById('zri-codex-check').disabled;});
      const get=id=>win.document.getElementById(id),change=el=>el.selectedItem.doCommand();
      const tabs=[...win.document.querySelectorAll('#zri-settings [role="tab"]')];
      tabs[0].click();tabs[0].dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      assert(tabs[1].getAttribute('aria-selected')==='true','keyboard tab navigation failed');
      assert([...win.document.querySelectorAll('#zri-settings [role="tabpanel"]')].filter(p=>!p.hidden).length===1,'inactive settings panels remain visible');
      assert(!get('zri-name-verification'),'obsolete report naming field present');
      get('zri-ai-gen-engine').value='antigravity';change(get('zri-ai-gen-engine'));
      get('zri-codex-model').value='gemini-test';change(get('zri-codex-model'));
      assert(get('zri-codex-model').itemCount===4,'Antigravity variants were not grouped');
      get('zri-effort-generation').value='0';get('zri-effort-generation').dispatchEvent(new win.Event('input',{bubbles:true}));
      get('zri-ai-ver-engine').value='codex';change(get('zri-ai-ver-engine'));
      const invalid=win.document.createXULElement('menuitem');invalid.setAttribute('value','unknown-model');invalid.setAttribute('label','Unknown');get('zri-codex-verify-model').menupopup.appendChild(invalid);
      get('zri-codex-verify-model').value='unknown-model';change(get('zri-codex-verify-model'));get('zri-codex-save').click();
      assert(engines.stage('generation').engine==='codex','invalid verification model partially saved generation settings');
      get('zri-codex-verify-model').value='mock-codex-checker';change(get('zri-codex-verify-model'));
      assert(get('zri-effort-verification').max==='2','unsupported reasoning level added to checker');
      get('zri-effort-verification').value='2';get('zri-effort-verification').dispatchEvent(new win.Event('input',{bubbles:true}));
      get('zri-codex-save').click();
      assert(engines.stage('generation').engine==='antigravity'&&engines.stage('verification').engine==='codex','stage engines not independent');
      assert(engines.stage('generation').model==='gemini-test-low'&&engines.stage('verification').model==='mock-codex-checker','stage models not saved');
      assert(engines.stage('generation').effort==='low'&&engines.stage('verification').effort==='high','stage reasoning strengths not saved independently');
      get('zri-template-text').value=scope.ReadingCore.defaultTemplateText('ecology')+'\nCUSTOM_TEMPLATE_TEST：突出对照与研究边界。';get('zri-template-save').click();
      assert(prefs.templateText('ecology').includes('CUSTOM_TEMPLATE_TEST'),'template not persisted');
      get('zri-delivery-mode').value='manual';get('zri-name-reading').value='自定精读_{title}';get('zri-delivery-save').click();
      assert(prefs.delivery()==='manual'&&prefs.naming().reading==='自定精读_{title}','delivery/names not persisted');
      win.close();win=null;
    });
    await check('reasoning sliders restore saved values and reset when the selected model changes',async()=>{
      Zotero.Utilities.Internal.openPreferences(app.paneID);
      await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-codex-save')?.dataset.bound&&!win.document.getElementById('zri-codex-check').disabled;});
      const get=id=>win.document.getElementById(id);
      assert(get('zri-codex-model').value==='gemini-test'&&get('zri-effort-generation').value==='0','grouped Antigravity selection did not restore');
      assert(get('zri-effort-verification').value==='2'&&get('zri-effort-value-verification').textContent==='高','checker strength did not restore');
      get('zri-codex-verify-model').value='mock-codex-reader';get('zri-codex-verify-model').selectedItem.doCommand();
      assert(get('zri-effort-verification').value==='0'&&get('zri-effort-value-verification').textContent==='默认','new model inherited previous custom strength');
      get('zri-codex-verify-model').value='';get('zri-codex-verify-model').selectedItem.doCommand();
      assert(get('zri-effort-verification').disabled,'automatic model exposed unsupported explicit levels');
      win.close();win=null; // Unsaved control changes must not alter persisted stages.
    });
    await check('connection test button can cancel an ongoing request without changing reading settings',async()=>{
      Zotero.Utilities.Internal.openPreferences(app.paneID);
      await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-codex-save')?.dataset.bound&&!win.document.getElementById('zri-codex-check').disabled;});
      const before=JSON.stringify([engines.stage('generation'),engines.stage('verification')]),invoke=codex.invoke;
      codex.invoke=async(input,context,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(scope.CodexCore.error('CANCELLED','test cancelled')),{once:true});});
      try{
        const button=win.document.getElementById('zri-codex-test');button.click();await until(()=>codex.active&&button.textContent==='停止测试');button.click();
        await until(()=>!codex.active&&button.textContent==='测试连接');
        assert(JSON.stringify([engines.stage('generation'),engines.stage('verification')])===before,'test changed reading model/effort');
      }finally{codex.invoke=invoke;win.close();win=null;}
    });
    await check('cross-engine workflow saves Markdown without automatically writing notes',async()=>{
      const att=await createPDF('Manual delivery cross-engine fixture',undefined,parent);
      job=await auto.enqueueManual(att,'ecology');auto.schedule(0);
      await until(()=>['awaiting_import','failed'].includes(job.state),25000);
      assert(job.state==='awaiting_import','manual delivery failed: '+job.message);
      assert(!job.notes,'manual mode wrote notes automatically');
      const m=await app.readJSON(job.workflowPath);
      assert(m.generatorEngine==='antigravity'&&m.verifierEngine==='codex','cross-engine metadata incorrect');
      assert(m.templateText.includes('CUSTOM_TEMPLATE_TEST'),'template snapshot missing');
      assert(m.generatorModel==='gemini-test-low'&&m.verifierModel==='mock-codex-checker','models not routed to stages');
      assert(m.generatorEffort==='low'&&m.verifierEffort==='high','workflow did not record independent strengths');
      const generated=await app.readJSON(PathUtils.join(PathUtils.parent(m.generationRun),'run.json'));
      assert(generated.engine==='antigravity-cli','Antigravity adapter was not used');
      const md=await IOUtils.readUTF8(PathUtils.join(PathUtils.parent(job.workflowPath),m.resultFile));
      assert(md.startsWith('---\n')&&md.includes('reading_note_title: "自定精读_')&&md.includes('wiki_stage: "input"'),'Wiki envelope or selected note title missing');
      const receipt=await app.readJSON(PathUtils.join(PathUtils.parent(job.workflowPath),'source.json'));
      assert(receipt.item_key===parent.key&&receipt.attachments[0].sha256===m.source.sha256,'source receipt not linked to the parent and PDF version');
      const genArgs=await app.readJSON(PathUtils.join(PathUtils.parent(m.generationRun),'work','seen-args.json'));
      const checkArgs=await app.readJSON(PathUtils.join(PathUtils.parent(m.verificationRun),'work','seen-args.json'));
      assert(genArgs[genArgs.indexOf('--model')+1]==='gemini-test-low'&&genArgs[genArgs.indexOf('--effort')+1]==='low','generation strength did not reach CLI');
      assert(checkArgs.includes('model_reasoning_effort="high"'),'verification strength did not reach CLI');
    });
    await check('edited Markdown imports with custom names and retains an unverified-edit label',async()=>{
      const m=await app.readJSON(job.workflowPath),dir=PathUtils.parent(job.workflowPath),md=PathUtils.join(dir,m.resultFile);
      await IOUtils.writeUTF8(md,(await IOUtils.readUTF8(md))+'\n\n## 人工修改\n这是人工编辑专用测试。<script>bad()</script>');
      const callsBefore=inferenceCalls;
      await codex.openResult(main,job.workflowPath,job);await until(()=>codex.window?.document.getElementById('zrc-import'));
      assert(!codex.window.document.getElementById('zrc-import').hidden,'manual import button missing');
      assert(codex.state.answer.includes('人工编辑专用测试'),'preview did not read edited Markdown');
      const result=await auto.importResult(job.workflowPath);
      assert(result.status==='edited'&&job.state==='imported','edited draft was promoted to checked');
      const note=await Zotero.Items.getAsync(result.notes.reading.id),html=note.getNote();
      assert(html.includes('自定精读_')&&html.includes('人工修改稿（未重新检查）'),'custom name or mandatory status missing');
      assert(html.includes('人工编辑专用测试')&&!html.includes('<script>'),'edited Markdown unsafe or lost');
      assert(inferenceCalls===callsBefore,'import invoked a model');
      const repeated=await auto.importResult(job.workflowPath);assert(repeated.notes.reading.id===note.id,'repeated import duplicated note');
      codex.window.close();
    });
    await check('Antigravity cancellation terminates its owned child process tree',async()=>{
      const work=PathUtils.join(root,'agy-cancel-test');await IOUtils.makeDirectory(work,{ignoreExisting:true});
      const executable={...fake('antigravity'),prefix:[...fake('antigravity').prefix,'--spawn-child']};
      const controller=new main.AbortController(),args=scope.EngineCore.agyArguments({settingsPath:PathUtils.join(work,'settings.json'),timeoutMs:10000});
      const pending=codex.run(executable,args,{workdir:work,input:JSON.stringify({event:'user',message:{content:'__SIM_SLEEP__'}})+'\n',signal:controller.signal,timeoutMs:10000});
      pending.catch(()=>{});
      await until(()=>IOUtils.exists(PathUtils.join(work,'child-pid.txt')),5000);
      const pid=parseInt(await IOUtils.readUTF8(PathUtils.join(work,'child-pid.txt')),10);controller.abort();
      let caught;try{await pending;}catch(e){caught=e;}assert(caught?.code==='CANCELLED','AGY cancellation did not settle');
      const system=Services.dirsvc.get('SysD',Components.interfaces.nsIFile).path;
      const listed=await codex.run({command:PathUtils.join(system,'tasklist.exe'),prefix:[]},['/FI','PID eq '+pid,'/NH'],{timeoutMs:5000});
      assert(!new RegExp('\\b'+pid+'\\b').test(listed.stdout),'owned AGY child remains alive');
    });
  }finally{
    if(win&&!win.closed)win.close();
    if(codex.window&&!codex.window.closed)codex.window.close();
    if(job&&['waiting_file','queued','running'].includes(job.state))await auto.stopBatch([{id:job.id,attempt:job.attempt}]);
    for(const [k,value] of Object.entries(previous))Zotero.Prefs.set(app.pref+k,value===undefined?'':value,true);
    engines.resolve=realResolve;engines.discoverAll=realDiscoverAll;codex.invoke=originalInvoke;
  }
}
