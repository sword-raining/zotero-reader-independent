(async()=>{
 const scope=readerScope,app=scope.ReaderApp,codex=scope.ReaderCodex,engines=scope.ReaderEngines,E=scope.EngineCore;
 const root=PathUtils.profileDir,out=PathUtils.join(root,'cli-detection-result.json'),tests=[];
 const assert=(v,m)=>{if(!v)throw Error(m);};
 assert(Zotero.DataDirectory.dir===PathUtils.join(root,'data'),'Isolated data directory required');
 const cfg=await app.readJSON(PathUtils.join(root,'fixture-config.json'));
 assert(!Object.entries(cfg).some(([k,v])=>k.startsWith('live')&&v),'No live calls allowed');
 const sleep=ms=>new Promise(r=>scope.ReaderTimers.setTimeout(r,ms));
 const until=async fn=>{const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await sleep(50);}throw Error('Synthetic test timed out');};
 const check=async(name,fn)=>{try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests});};
 const realServices=scope.Services,realSubprocess=codex.subprocess,realResolve=engines.resolve;
 const dirs={LocalAppData:PathUtils.join(root,'Local 合成用户'),AppData:PathUtils.join(root,'Roaming 合成用户'),Home:PathUtils.join(root,'Home')};
 scope.Services={...realServices,dirsvc:{get:(key,...args)=>key in dirs?{path:dirs[key]}:realServices.dirsvc.get(key,...args)},env:{get:key=>key==='CODEX_HOME'?PathUtils.join(root,'codex-home'):realServices.env.get(key)}};
 const write=async(path,text='synthetic executable; never run')=>{await IOUtils.makeDirectory(PathUtils.parent(path),{createAncestors:true,ignoreExisting:true});await IOUtils.writeUTF8(path,text);return path;};
 const main={engine:'codex',model:'',effort:''},verify={engine:'antigravity',model:'',effort:''};let win;
 try{
  codex.subprocess=()=>({pathSearch:async()=>{throw Error('Synthetic empty process PATH');}});
  await check('native Windows discovery finds a complete per-user Codex install without PATH or a fixed username',async()=>{
   const bin=PathUtils.join(dirs.LocalAppData,'OpenAI','Codex','bin');
   await IOUtils.makeDirectory(PathUtils.join(bin,'partial','codex.exe'),{createAncestors:true});
   const exe=await write(PathUtils.join(bin,'synthetic-build','codex.exe'));
   assert((await codex.resolveExecutable()).command===exe,'desktop fallback failed');
  });
  await check('native Antigravity fallback resolves per-user install and rejects invalid explicit paths',async()=>{
   const exe=await write(PathUtils.join(dirs.LocalAppData,'agy','bin','agy.exe'));
   assert((await engines.resolve('antigravity')).command===exe,'agy fallback failed');
   Zotero.Prefs.set(app.pref+'agy.path',PathUtils.join(root,'missing.exe'),true);let caught;
   try{await engines.resolve('antigravity');}catch(e){caught=e;}finally{Zotero.Prefs.set(app.pref+'agy.path','',true);}
   assert(caught?.code==='CLI_MISSING','explicit missing path silently ignored');
  });
  codex.subprocess=realSubprocess;
  const fake=engine=>({command:cfg.nodePath,prefix:[PathUtils.join(root,'fake-engines.cjs'),engine],engine});
  engines.resolve=async engine=>fake(engine);
  for(const [which,stage] of [['generation',main],['verification',verify]])for(const field of ['engine','model','effort'])Zotero.Prefs.set(app.pref+'ai.'+which+'.'+field,stage[field],true);
  await check('both synthetic CLI protocols discover models in native Zotero',async()=>{
   const r=await engines.discoverAll();assert(r.every(x=>x.status==='fulfilled'),'synthetic discovery failed');
   assert(engines.catalogs.codex.models.length&&engines.catalogs.antigravity.models.length,'models missing');
  });
  await check('native settings show a fresh synthetic connectivity success',async()=>{
   Zotero.Utilities.Internal.openPreferences(app.paneID);
   await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-codex-save')?.dataset.bound&&!win.document.getElementById('zri-codex-check').disabled;});
   win.document.getElementById('zri-codex-test').click();
   await until(()=>engines.connectivityFor(main).state==='available'&&win.document.getElementById('zri-codex-test').textContent==='测试连接');
   assert(win.document.getElementById('zri-health-generation').dataset.state==='available','fresh success not rendered');
  });
  await check('discovery failure removes old green status immediately in the already-open native settings view',async()=>{
   engines.resolve=async engine=>{if(engine==='codex')throw scope.CodexCore.error('CLI_MISSING','Synthetic CLI missing');return fake(engine);};
   try{await engines.discover('codex');}catch(_){}
   assert(engines.catalogs.codex.error,'missing current error');
   const badge=win.document.getElementById('zri-health-generation');
   assert(badge.dataset.state!=='available'&&!badge.textContent.includes('通过'),'old success still visible');
   assert(win.document.getElementById('zri-ai-detection').textContent.includes('Synthetic CLI missing'),'current detection error not rendered');
  });
  await check('successful retry refreshes the native error text and badge without claiming a refreshed catalog',async()=>{
   engines.resolve=async engine=>fake(engine);
   win.document.getElementById('zri-codex-test').click();
   await until(()=>engines.connectivityFor(main).state==='available'&&win.document.getElementById('zri-codex-test').textContent==='测试连接');
   const detail=win.document.getElementById('zri-ai-detection').textContent;
   assert(!detail.includes('Synthetic CLI missing')&&detail.includes('模型目录待刷新'),'stale error or incorrect catalog freshness');
   assert(win.document.getElementById('zri-health-generation').dataset.state==='available','retry success not rendered');
  });
  await check('editing and saving a CLI path invalidates success in the native settings view and on disk',async()=>{
   const field=win.document.getElementById('zri-codex-path');field.value=PathUtils.join(root,'changed.exe');field.dispatchEvent(new win.Event('input',{bubbles:true}));
   assert(win.document.getElementById('zri-health-generation').dataset.state!=='available','unsaved path still green');
   engines.setPath('codex',field.value);await engines.healthIO;
   assert(!Object.values(await app.readJSON(PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','model-health.json'))).some(r=>r.engine==='codex'&&r.success),'stale success persisted after path change');
  });
 }finally{win?.close();scope.Services=realServices;codex.subprocess=realSubprocess;engines.resolve=realResolve;await engines.healthIO;}
 await app.writeJSON(out,{completed:true,tests,pluginVersion:cfg.pluginVersion,zoteroVersion:Zotero.version,realModelRequests:0,syntheticCLI:true,personalLibraryTouched:false,headless:true});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'cli-detection-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
