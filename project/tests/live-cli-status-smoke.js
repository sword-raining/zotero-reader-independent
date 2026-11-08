(async()=>{
 const app=readerScope.ReaderApp,engines=readerScope.ReaderEngines,codex=readerScope.ReaderCodex,root=PathUtils.profileDir;
 if(Zotero.DataDirectory.dir!==PathUtils.join(root,'data'))throw Error('Isolated data directory required');
 const cfg=await app.readJSON(PathUtils.join(root,'fixture-config.json'));if(!cfg.liveCLIStatus)throw Error('Explicit live probe flag required');
 const out=PathUtils.join(root,'live-cli-status-result.json'),report={completed:false,pluginVersion:cfg.pluginVersion,zoteroVersion:Zotero.version,startedAt:new Date().toISOString(),documentRequests:0,channels:[]};
 await app.writeJSON(out,report);
 for(const engine of ['codex','antigravity']){
  const entry={engine,phase:'path',status:'running'};report.channels.push(entry);await app.writeJSON(out,report);
  try{
   entry.executable=(await engines.resolve(engine)).command;entry.phase='preflight';await app.writeJSON(out,report);
   entry.version=(await engines.prepare(engine)).version;entry.phase='catalog';await app.writeJSON(out,report);
   const catalog=await engines.discover(engine);entry.models=catalog.models;entry.catalogSource=catalog.source;entry.phase='connection';await app.writeJSON(out,report);
   const result=await codex.testConnection(()=>{},{engine,model:'',effort:''},{mode:'quick'});
   entry.testedStage=result.testedStage;entry.connection={success:true,mode:'quick',durationMs:result.durationMs,answer:result.answer.trim()};entry.status='passed';entry.phase='complete';
  }catch(e){entry.status='failed';entry.errorCode=e.code||'LOCAL';entry.message=app.safeError(e);}
  await app.writeJSON(out,report);
 }
 report.completed=true;report.completedAt=new Date().toISOString();report.personalLibraryTouched=false;await app.writeJSON(out,report);
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'live-cli-status-fatal.json'),JSON.stringify({error:String(e)}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
