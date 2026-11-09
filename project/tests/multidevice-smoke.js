(async()=>{
 const s=readerScope,app=s.ReaderApp,auto=s.ReaderAutomation,C=s.ReaderCoordination,R=s.ReadingCore,root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
 const assert=(v,m)=>{if(!v)throw Error(m);},sleep=ms=>new Promise(r=>s.ReaderTimers.setTimeout(r,ms));
 assert(Zotero.DataDirectory.dir===PathUtils.join(root,'data'),'Isolated library required');
 const cfg=await app.readJSON(PathUtils.join(root,'coordination-fixture.json'));assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(cfg.url),'Loopback fixture required');
 const req=async(path,value)=>{const r=await Zotero.HTTP.request(value?'POST':'GET',cfg.url+'/fixture/'+path,{...(value?{body:JSON.stringify(value),headers:{'Content-Type':'application/json'}}:{}),timeout:10000,logBodyLength:0});return JSON.parse(r.responseText);};
 const until=async fn=>{const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await sleep(150);}throw Error('Native multi-device condition timed out');};
 let modelCalls=0,executions=0;const tests=[],out=PathUtils.join(root,'multidevice-result.json'),check=async(name,fn)=>{try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests,role:cfg.role});};
 auto.state.paused=true;await auto.setEnabled(false);Zotero.Prefs.set(app.pref+'classification.mode','off',true);Zotero.Prefs.set(app.pref+'workflow.papers',1,true);Zotero.Prefs.set(app.pref+'reading.skipChinese',false,true);
 Zotero.Users.getCurrentUserID=()=>1234567;Zotero.Sync.Storage.Mode.WebDAV.prototype.getPassword=async()=> 'synthetic-only-password';
 const configID=await app.sha256Text(cfg.url);C.configuration=async()=>({base:cfg.url+'/claims/',username:'synthetic',account:'1234567',id:configID});
 await check('native WebDAV transport verifies atomic creation, three-way CAS and stale-write rejection',async()=>{await C.connect({verify:true});Zotero.Prefs.set(app.pref+'coordination.enabled',true,true);assert(C.enabled(),'enable failed');});
 assert(C.enabled(),'Fixture WebDAV probe failed');
 const entries=[],text='Synthetic experiment found a relationship between fungal diversity and resistance to drought.',paper=R.paper(text),evidence=[{paragraph_id:'P0001',quote:text}];
 for(let i=1;i<=3;i++){
  const parent=new Zotero.Item('journalArticle');parent.libraryID=lib;parent.key='PAPERAA'+(i+1);await parent.loadPrimaryData();parent.setField('title','Synthetic coordination paper '+i);parent.setField('language','en');await parent.saveTx({skipSelect:true});
  const att=new Zotero.Item('attachment');att.libraryID=lib;att.key='PDFTEST'+(i+1);await att.loadPrimaryData();att.parentID=parent.id;att.setField('title','Synthetic source');att.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;att.attachmentPath=PathUtils.join(root,'synthetic.pdf');att.attachmentContentType='application/pdf';await att.saveTx({skipSelect:true});
  const job={id:lib+':'+att.key,key:att.key,libraryID:lib,title:parent.getField('title'),state:'queued',trigger:'manual',templateID:'general',attempt:1,inputSelection:{mainKey:att.key,supplementKeys:[]},createdAt:(i-1-cfg.role+3)%3,updatedAt:Date.now(),skipChinese:false};auto.state.jobs[job.id]=job;entries.push({parent,att,job});
 }
 app.parseAttachment=async()=>{throw Error('No remote parsing allowed');};s.ReaderCodex.invoke=async()=>{modelCalls++;throw Error('No model invocation allowed');};
 const ownNotes=[];
 auto.execute=async(job,worker)=>{
  executions++;assert(worker.coordination&&worker.coordination.state==='running','No task ownership before work');await sleep(1200);
  const att=await auto.attachment(job),sources=await s.ReaderAttachments.sources(att,job.inputSelection),id=Date.now()+'-'+Zotero.Utilities.randomString(8).toLowerCase(),dir=PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','readings',id),path=PathUtils.join(dir,'workflow.json');await IOUtils.makeDirectory(dir,{createAncestors:true});
  const draft={coreFinding:{id:'core-finding',text:'Fungal diversity was associated with drought resistance in the synthetic experiment.',kind:'reported',evidence},articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:'未明确标注',kind:'not_reported',evidence:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:'未明确标注',kind:'not_reported',evidence:[]}]}))};
  draft.sections.find(x=>x.key==='results').entries=[{id:'results',text:'Treatment-level observations support the central relationship.',kind:'reported',evidence}];
  const review={mode:'full-review',checked_ids:R.claimSections(draft).flatMap(x=>x.entries.map(e=>e.id)),issues:[],notes:''},assessment=R.assess(draft,review,paper),w={status:'checked',createdAt:new Date().toISOString(),templateID:'general',templateVersion:6,source:sources[0],inputSources:sources,inputSelection:job.inputSelection,queueJobID:job.id,bibliography:await s.ReaderNotes.bibliography(att),resultFile:'reading.md',shortFinding:s.WorkflowCore.brief(draft,assessment)};
  await app.writeJSON(PathUtils.join(dir,'draft.json'),draft);await app.writeJSON(PathUtils.join(dir,'source-index.json'),paper);await app.writeJSON(PathUtils.join(dir,'verification.json'),{review,assessment});await IOUtils.writeUTF8(PathUtils.join(dir,'draft.md'),s.ReaderCodex.renderReading(draft,null,w));w.draftSHA256=await app.sha256(PathUtils.join(dir,'draft.md'));await IOUtils.writeUTF8(PathUtils.join(dir,'reading.md'),s.ReaderCodex.renderReading(draft,assessment,w));w.resultSHA256=await app.sha256(PathUtils.join(dir,'reading.md'));await app.writeJSON(path,w);job.workflowPath=path;
  const result=await s.ReaderNotes.save(path,att);const note=await Zotero.Items.getByLibraryAndKeyAsync(lib,result.notes.reading.key);ownNotes.push({parentKey:(await Zotero.Items.getAsync(att.parentID)).key,noteKey:note.key,html:note.getNote()});return result;
 };
 await req('barrier/'+cfg.role,{});await until(async()=> (await req('barrier')).ready);
 auto.state.paused=false;auto.schedule(0);
 await check('a real isolated Zotero worker saves only the paper it acquired',async()=>{await until(()=>executions>=1&&auto.running.size===0);assert(ownNotes.length===1,'Expected one owned task per participating client');for(const n of ownNotes){assert(n.html.includes('核心发现')&&n.html.indexOf('核心发现')<n.html.indexOf('文献信息'),'Verified summary not before bibliographic section');assert(n.html.includes('Treatment-level observations'),'Main results were lost');}for(const n of ownNotes)await req('notes/'+n.parentKey,n);});
 await check('synchronized saved notes are adopted without a second reading or a second note',async()=>{
  await until(async()=>Object.keys(await req('notes')).length===3);const all=await req('notes');
  for(const [key,n]of Object.entries(all)){if(await Zotero.Items.getByLibraryAndKeyAsync(lib,n.noteKey))continue;const parent=await Zotero.Items.getByLibraryAndKeyAsync(lib,key),note=new Zotero.Item('note');note.libraryID=lib;note.key=n.noteKey;await note.loadPrimaryData();note.parentID=parent.id;note.setNote(n.html);await note.saveTx({skipSelect:true});}
  // Real item notifications wake waiting jobs; no manual requeue or copy of queue/cache state.
  await until(()=>entries.every(e=>['done','imported'].includes(e.job.state))&&auto.running.size===0);
  assert(executions===1&&modelCalls===0,'Another reading ran after peer save');for(const e of entries){assert(e.parent.getNotes().length===1,'Duplicate note appeared');assert(e.parent.getCollections().length===0,'Manual entry changed classifications');}
 });
 await check('language gate covers automatic, single and resumed jobs before execution',async()=>{
  const att=entries[0].att,parent=entries[0].parent;Zotero.Prefs.set(app.pref+'reading.skipChinese',true,true);parent.setField('language','en');parent.setField('title','全球气候变化对干旱区影响分析');await parent.saveTx({skipSelect:true});const old=Zotero.PDFWorker.getFullText;Zotero.PDFWorker.getFullText=async()=>({text:'本文研究全球气候变化对干旱生态系统的影响及其关键关系。'.repeat(20)});
  try{for(const job of [{trigger:'auto'},{trigger:'manual'},{}]){let error;try{await s.ReaderLanguage.check(att,job);}catch(e){error=e;}assert(error?.code==='LANGUAGE_SKIPPED','Chinese entry was allowed');}await s.ReaderLanguage.check(att,{skipChinese:false});
    const originalJob=entries[0].job;Zotero.Prefs.set(app.pref+'auto.enabled',true,true);
    for(const trigger of ['auto','manual']){const j={...originalJob,trigger,state:'running',skipChinese:undefined,notes:null,workflowPath:null,cancelRequested:false},w=auto.createWorker(j);auto.state.jobs[j.id]=j;auto.running.set(j.id,w);await auto.runJob(w);assert(j.languageSkipped&&j.state==='cancelled','Real execute entry did not skip Chinese');}
    const resumed={...originalJob,state:'verification_incomplete',skipChinese:undefined,notes:null,cancelRequested:false,workflowPath:PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','readings','12345678-abcdefgh','workflow.json')};auto.state.jobs[resumed.id]=resumed;await auto.startResumeJob(resumed,false).promise;assert(resumed.languageSkipped&&resumed.state==='cancelled','Resume entry did not skip Chinese');assert(executions===1&&modelCalls===0,'Chinese gate reached execution');auto.state.jobs[originalJob.id]=originalJob;
   }finally{Zotero.PDFWorker.getFullText=old;}
 });
 await auto.shutdown();await app.writeJSON(out,{completed:true,role:cfg.role,tests,executions,ownedNotes:ownNotes.map(n=>({parentKey:n.parentKey,noteKey:n.noteKey})),realModelRequests:modelCalls,syntheticData:true,personalLibraryTouched:false,pluginVersion:(await app.readJSON(PathUtils.join(root,'fixture-config.json'))).pluginVersion,zoteroVersion:Zotero.version});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'multidevice-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
