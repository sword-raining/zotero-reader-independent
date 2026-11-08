(async()=>{
 const s=readerScope,app=s.ReaderApp,auto=s.ReaderAutomation,notes=s.ReaderNotes,codex=s.ReaderCodex,engines=s.ReaderEngines,root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
 const assert=(v,m)=>{if(!v)throw Error(m);},sleep=ms=>new Promise(r=>s.ReaderTimers.setTimeout(r,ms));
 const until=async(fn,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(40);}throw Error('Condition timed out');};
 assert(Zotero.DataDirectory.dir===PathUtils.join(root,'data'),'Isolated profile required');
 app.safeError=e=>String(e)+' '+(e.stack||''); // Synthetic fixture diagnostics only.
 const cfg=await app.readJSON(PathUtils.join(root,'fixture-config.json'));if(Object.entries(cfg).some(([k,v])=>k.startsWith('live')&&v))throw Error('Live model flags forbidden');
 const tests=[],out=PathUtils.join(root,'workflow-result.json'),savedMetadata={};let totalModelCalls=0,standaloneClassificationCalls=0,modelActive=0,peakModelCalls=0,verifyActive=0,peakVerifications=0,parseCalls=0,allowResume=false,win;
 const check=async(name,fn)=>{try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests});};
 auto.state.paused=true;await auto.setEnabled(false);auto.settleMs=0;auto.pollMs=40;
 for(const [name,value]of Object.entries({'workflow.papers':2,'workflow.checks':2,'workflow.repairs':2,'delivery.mode':'auto','classification.mode':'confirm','ai.generation.engine':'codex','ai.verification.engine':'codex','ai.classification.engine':'codex','ai.generation.model':'','ai.verification.model':'','ai.classification.model':''}))Zotero.Prefs.set(app.pref+name,value,true);
 engines.resolve=async engine=>({command:cfg.nodePath,prefix:[PathUtils.join(root,'fake-engines.cjs'),engine],engine});
 const originalRun=codex.run;
 codex.run=async function(exe,args,extra={}){
  const model=typeof extra.input==='string'&&args.includes('exec')&&!args.includes('--help'),verification=model&&extra.input.startsWith('ZRI_READING_VERIFY_V2');
  if(model){totalModelCalls++;if(extra.input.startsWith('ZRI_CLASSIFY'))standaloneClassificationCalls++;peakModelCalls=Math.max(peakModelCalls,++modelActive);if(verification)peakVerifications=Math.max(peakVerifications,++verifyActive);await sleep(90);}
  try{const r=await originalRun.call(this,exe,args,extra);if(verification&&!allowResume&&extra.input.includes('NEEDS_RESUME'))await IOUtils.writeUTF8(args[args.indexOf('--output-last-message')+1],'{}');return r;}
  finally{if(model){modelActive--;if(verification)verifyActive--;}}
 };
 app.parseAttachment=async function(att){
  parseCalls++;const {source}=await this.source(att),base=this.attachmentDir(source),generation=source.sha256.slice(0,16)+'-synthetic',dir=PathUtils.join(base,generation),markdown='# '+att.getField('title')+'\n\nSynthetic research reports twenty four independent field sites.\n\nSynthetic affiliation: Fictional Soil Institute.';
  await IOUtils.makeDirectory(dir,{createAncestors:true});await IOUtils.writeUTF8(PathUtils.join(dir,'full.md'),markdown);await IOUtils.writeUTF8(PathUtils.join(dir,'mineru-result.zip'),'synthetic');
  const manifest={schema:1,status:'complete',source,options:this.options(),optionsKey:s.MineruCore.settingsKey(this.options()),markdown:'full.md',markdownSha256:await this.sha256(PathUtils.join(dir,'full.md')),files:[{path:'full.md',size:(await IOUtils.stat(PathUtils.join(dir,'full.md'))).size}]};
  await this.writeJSON(PathUtils.join(dir,'reader-manifest.json'),manifest);await this.writeJSON(PathUtils.join(base,'current.json'),{generation});return {dir,manifest,cached:false};
 };
 const originalSave=notes.save;notes.save=async function(file,att,...rest){savedMetadata[att.key]=await app.readJSON(file);return originalSave.call(this,file,att,...rest);};
 const collection=async name=>{const c=new Zotero.Collection();c.libraryID=lib;c.name=name;await c.saveTx();return c;};
 const inbox=await collection('00_新导入文献'),archive=await collection('Archive'),other=await collection('Keep existing membership');await auto.setCollection(inbox.key);
 const make=async(title,tag)=>{const p=new Zotero.Item('journalArticle');p.libraryID=lib;p.setField('title',title);p.addToCollection(inbox.id);p.addToCollection(other.id);p.addTag(tag);await p.saveTx({skipSelect:true});const a=new Zotero.Item('attachment');a.libraryID=lib;a.parentID=p.id;a.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;a.attachmentPath=PathUtils.join(root,'synthetic.pdf');a.attachmentContentType='application/pdf';a.setField('title',title);await a.saveTx({skipSelect:true});return {p,a};};
 const first=await make('Synthetic Paper A','/read'),second=await make('Synthetic Paper B __SIM_FIXABLE__','/unread');const originalPDF=await app.sha256(first.a.attachmentPath);
 let firstJob,secondJob;
 await check('two native paper workers each run one complete-source check without mixing results',async()=>{
  firstJob=await auto.enqueueManual(first.a,'general');secondJob=await auto.enqueueManual(second.a,'general');auto.state.paused=false;auto.schedule(0);
  await until(()=>['done','failed'].includes(firstJob.state)&&['done','failed'].includes(secondJob.state)&&auto.running.size===0);
  assert(firstJob.state==='done'&&secondJob.state==='done',firstJob.message+' / '+secondJob.message);assert(peakModelCalls>=2&&peakVerifications>=2,'concurrency was not observed');
  assert(firstJob.notes.reading.key!==secondJob.notes.reading.key,'mixed notes');
  for(const pair of [first,second]){const j=auto.state.jobs[lib+':'+pair.a.key],n=await Zotero.Items.getByLibraryAndKeyAsync(lib,j.notes.reading.key);assert(n.parentID===pair.p.id,'wrong note parent');}
 });
 await check('a reported factual problem is repaired by the generation channel and checked again before saving',async()=>{assert(savedMetadata[second.a.key]?.correctionRounds===1,'repair/recheck did not occur');assert(savedMetadata[second.a.key]?.verificationCompleted===1,'incomplete grouped verification');});
 await check('checked notes contain the short finding and AI tag without changing human read labels or PDFs',async()=>{
  assert(first.p.getTags().some(t=>t.tag==='AI精读')&&first.p.getTags().some(t=>t.tag==='/read'),'AI/human tag missing');assert(second.p.getTags().some(t=>t.tag==='/unread')&&!second.p.getTags().some(t=>t.tag==='/read'),'human read state overwritten');
  const note=await Zotero.Items.getByLibraryAndKeyAsync(lib,firstJob.notes.reading.key);assert(note.getNote().includes('核心发现')&&note.getNote().includes('【读后判断】'),'brief or labels missing');assert(await app.sha256(first.a.attachmentPath)===originalPDF,'original PDF changed');
 });
 await check('classification suggestions are durable but do not move items without confirmation',async()=>{
  assert(first.p.inCollection(inbox.id)&&second.p.inCollection(inbox.id),'unapproved move occurred');
  assert(s.ReaderClassifier.proposals[lib+':'+first.p.key]?.status==='pending','proposal absent');
  assert(totalModelCalls===6&&standaloneClassificationCalls===0,'unexpected extra model requests: '+totalModelCalls);
  assert(s.ReaderClassifier.proposals[lib+':'+second.p.key]?.targetKey===archive.key&&s.ReaderClassifier.proposals[lib+':'+second.p.key]?.reason==='Final checked suggestion','not the final checked suggestion');
 });
 await check('native confirmation changes only inbox/target membership and preserves other classifications',async()=>{
  await s.ReaderClassifier.confirm(lib+':'+first.p.key,[archive.key],{removeSource:true});assert(first.p.inCollection(archive.id)&&!first.p.inCollection(inbox.id)&&first.p.inCollection(other.id),'incorrect membership change');
 });
 await check('a human note change blocks a stale classification proposal without overwriting edits',async()=>{
  const note=await Zotero.Items.getByLibraryAndKeyAsync(lib,secondJob.notes.reading.key);note.setNote(note.getNote()+'<p>HUMAN EDIT KEEP</p>');await note.saveTx({skipSelect:true});let error;try{await s.ReaderClassifier.confirm(lib+':'+second.p.key,archive.key);}catch(e){error=e;}
  assert(error?.code==='CLASSIFY_CHANGED'&&second.p.inCollection(inbox.id)&&note.getNote().includes('HUMAN EDIT KEEP'),'manual edit protection failed');
 });
 const interrupted=await make('Synthetic NEEDS_RESUME','/unread');let retryJob,retained;
 await check('malformed review retains its draft and presents a direct continue button in the native queue',async()=>{
  retryJob=await auto.enqueueManual(interrupted.a,'general');await until(()=>['verification_incomplete','failed'].includes(retryJob.state)&&auto.running.size===0);assert(retryJob.state==='verification_incomplete',retryJob.message);
  retained=retryJob.workflowPath;assert(await IOUtils.exists(PathUtils.join(PathUtils.parent(retained),'draft.json')),'draft lost');
  await engines.discoverAll();Zotero.Utilities.Internal.openPreferences(app.paneID);await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-auto-enabled')?.dataset.bound;});
  const row=[...win.document.querySelectorAll('.zr-job-action')].find(n=>n.textContent.includes('NEEDS_RESUME'));assert(row&&[...row.querySelectorAll('button')].some(b=>b.textContent==='继续检查'),'continue button missing');
  assert(win.document.getElementById('zri-language').value==='auto','parser requires manual language');assert(win.document.getElementById('zri-template-choice').menupopup.children.length===1,'multiple reading templates remain');
 });
 await check('the queue continue action reuses the draft and source, then saves and suggests classification without reimport',async()=>{
  const before=parseCalls;allowResume=true;const row=[...win.document.querySelectorAll('.zr-job-action')].find(n=>n.textContent.includes('NEEDS_RESUME'));[...row.querySelectorAll('button')].find(b=>b.textContent==='继续检查').click();
  await until(()=>retryJob.state==='done'&&auto.running.size===0);assert(parseCalls===before,'resume parsed the paper again');assert(retryJob.notes.reading.key,'no saved note');assert(s.ReaderClassifier.proposals[lib+':'+interrupted.p.key]?.status==='pending','resume classification missing');
 });
 win?.close();await auto.shutdown();
 await app.writeJSON(out,{completed:true,tests,peakModelCalls,peakVerifications,parseCalls,zoteroVersion:Zotero.version,pluginVersion:cfg.pluginVersion,realModelRequests:0,totalModelCalls,standaloneClassificationCalls,syntheticCLI:true,personalLibraryTouched:false});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'workflow-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
