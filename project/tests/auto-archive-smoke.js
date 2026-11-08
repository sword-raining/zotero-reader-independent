(async()=>{
 const s=readerScope,app=s.ReaderApp,auto=s.ReaderAutomation,notes=s.ReaderNotes,codex=s.ReaderCodex,engines=s.ReaderEngines,root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
 const assert=(v,m)=>{if(!v)throw Error(m);},sleep=ms=>new Promise(r=>s.ReaderTimers.setTimeout(r,ms));
 const until=async(fn,ms=45000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(40);}throw Error('Condition timed out');};
 assert(Zotero.DataDirectory.dir===PathUtils.join(root,'data'),'Isolated profile required');
 app.safeError=e=>String(e)+' '+(e.stack||''); // Synthetic fixture diagnostics only.
 const cfg=await app.readJSON(PathUtils.join(root,'fixture-config.json'));if(Object.entries(cfg).some(([k,v])=>k.startsWith('live')&&v))throw Error('Live model flags forbidden');
 const tests=[],out=PathUtils.join(root,'auto-archive-result.json'),savedMetadata={};let totalModelCalls=0,standaloneClassificationCalls=0,modelActive=0,peakModelCalls=0,verifyActive=0,peakVerifications=0,parseCalls=0,allowResume=false,win;
 const check=async(name,fn)=>{try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests});};
 auto.state.paused=true;await auto.setEnabled(false);auto.settleMs=0;auto.pollMs=40;
 for(const [name,value]of Object.entries({'workflow.papers':2,'workflow.checks':2,'workflow.repairs':2,'delivery.mode':'auto','classification.mode':'auto','ai.generation.engine':'codex','ai.verification.engine':'codex','ai.classification.engine':'codex','ai.generation.model':'','ai.verification.model':'','ai.classification.model':''}))Zotero.Prefs.set(app.pref+name,value,true);
 engines.resolve=async engine=>({command:cfg.nodePath,prefix:[PathUtils.join(root,'fake-engines.cjs'),engine],engine});
 const originalRun=codex.run;
 codex.run=async function(exe,args,extra={}){
  const model=typeof extra.input==='string'&&args.includes('exec')&&!args.includes('--help'),verification=model&&extra.input.startsWith('ZRI_READING_VERIFY_V2');
  if(model){totalModelCalls++;if(extra.input.startsWith('ZRI_CLASSIFY'))standaloneClassificationCalls++;peakModelCalls=Math.max(peakModelCalls,++modelActive);if(verification)peakVerifications=Math.max(peakVerifications,++verifyActive);await sleep(90);}
  try{const r=await originalRun.call(this,exe,args,extra);if(verification){const file=args[args.indexOf('--output-last-message')+1],data=JSON.parse(await IOUtils.readUTF8(file));if(data.archive){data.archive.adjustments=[];if(extra.input.includes('NO_ARCHIVE'))data.archive={recommendations:[],adjustments:[],reason:'No reliable destination'};await IOUtils.writeUTF8(file,JSON.stringify(data));}}return r;}
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
 const make=async(title,tag)=>{const p=new Zotero.Item('journalArticle');p.libraryID=lib;p.setField('title',title);p.addToCollection(inbox.id);p.addTag(tag);await p.saveTx({skipSelect:true});const a=new Zotero.Item('attachment');a.libraryID=lib;a.parentID=p.id;a.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;a.attachmentPath=PathUtils.join(root,'synthetic.pdf');a.attachmentContentType='application/pdf';a.setField('title',title);await a.saveTx({skipSelect:true});return {p,a};};
 const first=await make('Synthetic Paper A','/read'),second=await make('Synthetic Paper B __SIM_FIXABLE__','/unread');const originalPDF=await app.sha256(first.a.attachmentPath);

 let firstJob,secondJob;
 const finished=j=>['done','failed'].includes(j.state)&&!auto.running.has(j.id);
 await check('automatic archive is the new default and completes saved tasks without opening confirmation windows',async()=>{
  Services.prefs.clearUserPref(app.pref+'classification.mode');Zotero.Prefs.set(app.pref+'classification.enabled',false,true);assert(s.ReaderClassifier.mode()==='auto','new default is not automatic');
  firstJob=await auto.enqueueManual(first.a,'general');secondJob=await auto.enqueueManual(second.a,'general');auto.state.paused=false;auto.schedule(0);await until(()=>finished(firstJob)&&finished(secondJob));
  assert(firstJob.state==='done'&&secondJob.state==='done',firstJob.message+' / '+secondJob.message);
  for(const pair of [first,second]){const p=s.ReaderClassifier.proposals[lib+':'+pair.p.key];assert(p.status==='confirmed'&&p.approvalMode==='automatic','automatic archive missing');assert(pair.p.inCollection(archive.id)&&!pair.p.inCollection(inbox.id)&&!pair.p.inCollection(other.id),'automatic membership change wrong');assert(p.confirmedRemovedKeys.length===0,'automatic archive removed other categories');}
  assert(!s.ReaderClassifier.dialog||s.ReaderClassifier.dialog.closed,'automatic archive opened a dialog');assert(standaloneClassificationCalls===0&&totalModelCalls===6,'extra classification request or incorrect retry count');
 });
 await check('only the final checked revision is archived and notes, PDFs and human tags remain intact',async()=>{
  assert(savedMetadata[second.a.key].correctionRounds===1,'repair missing');assert(s.ReaderClassifier.proposals[lib+':'+second.p.key].reason==='Final checked suggestion','old failing review was used');
  assert(first.p.getTags().some(t=>t.tag==='/read')&&second.p.getTags().some(t=>t.tag==='/unread'),'human tags changed');assert(await app.sha256(first.a.attachmentPath)===originalPDF,'PDF changed');assert(firstJob.notes.reading.key&&secondJob.notes.reading.key,'saved notes missing');
 });
 await check('rendering settings or stored pending suggestions never replays old archive actions',async()=>{
  const C=s.ReaderClassifier,p=C.proposals[lib+':'+first.p.key],legacy={...p,id:'legacy',status:'pending',autoEligible:false,autoPrompt:true};C.proposals.legacy=legacy;const before=JSON.stringify(first.p.getCollections().sort());await C.render();assert(legacy.status==='pending'&&JSON.stringify(first.p.getCollections().sort())===before,'old proposal replayed');assert(!C.dialog||C.dialog.closed,'old proposal popped up');delete C.proposals.legacy;await C.persist();
 });
 await check('no clear destination keeps the saved note in intake without a popup or forced classification',async()=>{
  const pair=await make('Synthetic NO_ARCHIVE','/unread'),job=await auto.enqueueManual(pair.a,'general');auto.schedule(0);await until(()=>finished(job));assert(job.state==='done'&&job.notes.reading.key,'note not retained');assert(pair.p.inCollection(inbox.id)&&!pair.p.inCollection(other.id)&&!pair.p.inCollection(archive.id),'uncertain paper moved');assert(job.classificationStatus==='failed'&&job.message.includes('没有明确'),'missing clear failure message');assert(!s.ReaderClassifier.dialog||s.ReaderClassifier.dialog.closed,'failure unexpectedly popped up');
 });
 await check('an archive write failure rolls back categories while preserving the saved note',async()=>{
  const pair=await make('Synthetic archive save failure','/unread'),save=pair.p.save;pair.p.save=async function(...args){if(this.inCollection(archive.id))throw Error('Synthetic archive save failure');return save.apply(this,args);};let job;try{job=await auto.enqueueManual(pair.a,'general');auto.schedule(0);await until(()=>finished(job));}finally{pair.p.save=save;}
  assert(job.state==='done'&&job.notes.reading.key&&job.classificationStatus==='failed','saved note was lost or failure hidden');assert(pair.p.inCollection(inbox.id)&&!pair.p.inCollection(other.id)&&!pair.p.inCollection(archive.id),'archive rollback failed');
 });
 await check('off mode leaves reading and saving active without generating or applying archive suggestions',async()=>{
  Zotero.Prefs.set(app.pref+'classification.mode','off',true);const pair=await make('Synthetic archive off','/unread'),job=await auto.enqueueManual(pair.a,'general');auto.schedule(0);await until(()=>finished(job));assert(job.state==='done'&&job.notes.reading.key,'reading was disabled');assert(!s.ReaderClassifier.proposals[lib+':'+pair.p.key]&&pair.p.inCollection(inbox.id),'off mode archived');
 });
 await check('manual mode still waits for an explicit decision after the note is saved',async()=>{
  Zotero.Prefs.set(app.pref+'classification.mode','confirm',true);const pair=await make('Synthetic manual decision','/unread'),job=await auto.enqueueManual(pair.a,'general');auto.schedule(0);await until(()=>finished(job)&&s.ReaderClassifier.dialog?.document.querySelector('.zr-archive-card'));const C=s.ReaderClassifier,p=C.proposals[lib+':'+pair.p.key];assert(C.currentID===p.id&&p.status==='pending'&&pair.p.inCollection(inbox.id),'manual choice was bypassed');await C.confirm(p.id,[archive.key],{removeSource:true});assert(p.approvalMode==='manual'&&pair.p.inCollection(archive.id)&&!pair.p.inCollection(inbox.id),'manual confirmation broken');
 });
 await check('settings display the selected archive mode and its accurate behavior',async()=>{
  Zotero.Prefs.set(app.pref+'classification.mode','auto',true);Zotero.Utilities.Internal.openPreferences(app.paneID);await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-classification-mode')?.dataset.bound;});assert(win.document.getElementById('zri-classification-mode').value==='auto','wrong mode displayed');assert(!win.document.getElementById('zri-classification-enabled'),'misleading old checkbox remains');assert(win.document.getElementById('zri-classification-summary').textContent.includes('已有分类'),'auto explanation missing');win.resizeTo(1100,900);win.document.getElementById('zri-classification-mode').closest('.zr-card').scrollIntoView({block:'start'});await sleep(100);const c=win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=win.innerWidth;c.height=win.innerHeight;c.getContext('2d').drawWindow(win,0,0,c.width,c.height,'white',0);await IOUtils.write(PathUtils.join(root,'auto-archive-settings.png'),Uint8Array.from(win.atob(c.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0)));win.close();
 });
 await auto.shutdown();await app.writeJSON(PathUtils.join(root,'auto-archive-result.json'),{completed:true,tests,zoteroVersion:Zotero.version,pluginVersion:cfg.pluginVersion,realModelRequests:0,syntheticCLI:true,personalLibraryTouched:false,totalModelCalls,standaloneClassificationCalls,parseCalls});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'auto-archive-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
