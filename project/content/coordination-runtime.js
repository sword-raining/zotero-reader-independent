"use strict";
var ReaderCoordination={
 app:null,client:null,configID:null,active:new Map(),records:{},views:new Set(),io:Promise.resolve(),error:'',testing:false,
 enabled(){return Zotero.Prefs.get(this.app.pref+'coordination.enabled',true)===true;},
 nonce(){return Zotero.Utilities.randomString(32);},
 file(){return PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','coordination-local.json');},
 async init(app){this.app=app;this.session=this.nonce();this.client=null;const data=await app.readJSON(this.file());this.corrupt=!data&&await IOUtils.exists(this.file());this.records=data?.records||{};let id=Zotero.Prefs.get(app.pref+'coordination.device',true);if(!CoordinationCore.idOK(id)){id=this.nonce();Zotero.Prefs.set(app.pref+'coordination.device',id,true);}this.owner=id;},
 persist(){const data={schema:1,records:JSON.parse(JSON.stringify(this.records))};this.io=this.io.catch(()=>{}).then(()=>this.app.writeJSON(this.file(),data));return this.io;},
 async configuration(){
  if(Zotero.Prefs.get('sync.storage.protocol')!=='webdav')throw CoordinationCore.error('COORD_CONFIG','请先在 Zotero 同步设置中配置各端共用的 WebDAV。');
  const account=String(Zotero.Users.getCurrentUserID()||'');if(!/^\d+$/.test(account))throw CoordinationCore.error('COORD_CONFIG','请先登录并同步同一个 Zotero 账号。');
  const scheme=Zotero.Prefs.get('sync.storage.scheme'),host=String(Zotero.Prefs.get('sync.storage.url')||'');
  if(scheme!=='https'||!host||/[?#@]/.test(host))throw CoordinationCore.error('COORD_CONFIG','多机协作需要不含查询参数或凭据的 HTTPS WebDAV 地址。');
  const base='https://'+host.replace(/\/+$/,'')+'/zotero-reader-coordination-v2/';Services.io.newURI(base);
  const username=String(Zotero.Prefs.get('sync.storage.username')||'');
  const id=await this.app.sha256Text(base+'|'+username+'|'+account);return {base,username,account,id};
 },
 async makeStore(config){
  const password=await new Zotero.Sync.Storage.Mode.WebDAV({}).getPassword();if(!config.username||!password)throw CoordinationCore.error('COORD_CONFIG','本机尚未保存 WebDAV 应用密码，请在 Zotero 同步设置中填写。');
  const win=Zotero.getMainWindow(),auth='Basic '+win.btoa(String.fromCharCode(...new win.TextEncoder().encode(config.username+':'+password)));
  const request=async(method,name,body,condition)=>{
   if(name&&!/^(?:probe-)?[a-f0-9]{64}(?:-v[0-9]{8}|-head|-tmp-[A-Za-z0-9]{16,64})\.json$/.test(name))throw CoordinationCore.error('COORD_PATH','协作路径无效。');
   const headers={Authorization:auth,'Cache-Control':'no-cache',...(body?{'Content-Type':'application/json; charset=utf-8'}:{}),...condition};
   let response;try{response=await Zotero.HTTP.request(method,config.base+name,{headers,body,timeout:15000,followRedirects:false,logBodyLength:0,debug:false,successCodes:false,errorDelayIntervals:[],errorDelayMax:0});}catch(_){throw CoordinationCore.error('COORD_NETWORK','协作服务暂时无法连接，未继续争抢或写入；本地稿件保留。');}
   const status=response.status;if(this.probeTrace&&this.probeTrace.length<100)this.probeTrace.push({method,resource:!name?'directory':name.includes('-tmp-')?'temporary':name.endsWith('-head.json')?'head':'version',nameLength:name.length,status,noOverwrite:condition?.Overwrite==='F'});if(status===429||status===503)throw CoordinationCore.error('COORD_RATE','协作服务暂时限流，稍后再试；本机未绕过协作单独运行。');
   return response;
  };
  const store=DAVStore.create(async(method,name,body,headers)=>{const r=await request(method,name,body,headers);return {status:r.status,text:r.responseText||'',date:r.getResponseHeader('Date')};},{baseURL:config.base,nonce:()=>this.nonce()});
  return {...store,async prepare(){const r=await request('MKCOL','');if(![201,405].includes(r.status))throw CoordinationCore.error('COORD_HTTP','无法创建独立协作目录（HTTP '+r.status+'）。');}};
 },
 async verifyStore(store,cfg){
  this.probeTrace=[];const startedAt=new Date().toISOString();let failure=null;
  try{await store.prepare();const key=await this.app.sha256Text(this.nonce()),probeStore={...store,read:k=>store.read('probe-'+k),write:(k,v,e)=>store.write('probe-'+k,v,e),removeProbe:k=>store.removeProbe('probe-'+k)};await CoordinationCore.probe(probeStore,key,()=>this.nonce());Zotero.Prefs.set(this.app.pref+'coordination.verified',cfg.id,true);Zotero.Prefs.set(this.app.pref+'coordination.protocol',2,true);}
  catch(e){failure=e;throw e;}
  finally{const steps=this.probeTrace;this.probeTrace=null;try{await this.app.writeJSON(PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','coordination-diagnostic.json'),{schema:1,startedAt,finishedAt:new Date().toISOString(),protocol:'immutable-move-v2',serverHost:new URL(cfg.base).hostname,success:!failure,errorCode:failure?.code||null,steps});}catch(_){}}
 },
 async connect({verify=false}={}){
  this.app.assertIndexes?.();
  if(this.corrupt)throw CoordinationCore.error('COORD_LOCAL','本机协作回执损坏，已暂停；原文件保留。');
  const cfg=await this.configuration();
  if(!verify&&Zotero.Prefs.get(this.app.pref+'coordination.verified',true)!==cfg.id)throw CoordinationCore.error('COORD_VERIFY','WebDAV 或账号设置已改变，请重新检测协作能力。');
  if(!this.client||this.configID!==cfg.id||verify){const store=await this.makeStore(cfg);if(verify)await this.verifyStore(store,cfg);this.client=new CoordinationCore.Client({store,owner:this.owner,nonce:()=>this.nonce()});this.configID=cfg.id;this.account=cfg.account;await this.recoverLocalCommits();}
  return this.client;
 },
 async recoverLocalCommits(){
  for(const [key,local]of Object.entries(this.records).slice(0,100)){
   if(!local.runID||local.session===this.session||!local.attachmentKey)continue;
   try{
    const remote=await this.client.load(key),r=remote.record;if(!r||r.state!=='committing'||r.owner!==this.owner||r.token!==local.token||r.inputHash!==local.inputHash)continue;
    const att=await Zotero.Items.getByLibraryAndKeyAsync(local.libraryID,local.attachmentKey);if(!att||att.deleted)continue;
    const parent=att.parentID?await Zotero.Items.getAsync(att.parentID):att;
    if(await this.app.sha256Text(this.account+':'+parent.key)!==key)continue;
    const ids=await Zotero.DB.columnQueryAsync('SELECT N.itemID FROM itemNotes N JOIN items I ON I.itemID=N.itemID WHERE I.libraryID=? AND N.note LIKE ?',[local.libraryID,'%'+NoteCore.identity(local.runID,'reading')+'%']);
    const notes=await Zotero.Items.getAsync(ids),h={key,token:local.token,inputHash:local.inputHash,state:'committing'};
    if(notes.length===1){const n=notes[0],record=SavedCore.read(n.getNote());if(!n.deleted&&record?.runID===local.runID&&record.itemKey===parent.key&&(n.parentID||false)===(att.parentID||false)){const input=await this.app.sha256Text(JSON.stringify(record.inputs.map(x=>({key:x.key,role:x.role||'main',sha256:x.sha256,pageLimit:x.pageLimit||0})).sort((a,b)=>a.key.localeCompare(b.key))));if(input===local.inputHash){await this.client.complete(h,n.key);delete this.records[key];await this.persist();}}}
    else if(!notes.length){
     // A prior process's SQLite transaction is settled when this profile finishes startup.
     // Keep the old draft reserved for this device; do not let another device restart it.
     await this.client.rollback(h);local.session=this.session;await this.persist();
    }
   }catch(e){this.error=e.message;}
  }
 },
 async identity(att,selection){
  const parent=att.parentID?await Zotero.Items.getAsync(att.parentID):att;
  if(!parent||att.libraryID!==Zotero.Libraries.userLibraryID)throw CoordinationCore.error('COORD_LIBRARY','当前多机协作仅支持同一账号的个人文库。');
  const account=String(Zotero.Users.getCurrentUserID()||'');if(!/^\d+$/.test(account))throw CoordinationCore.error('COORD_CONFIG','请先登录 Zotero 账号。');
  const key=await this.app.sha256Text(account+':'+parent.key),sources=await ReaderAttachments.sources(att,selection);
  const inputHash=await this.app.sha256Text(JSON.stringify(sources.map(s=>({key:s.key,role:s.role||'main',sha256:s.sha256,pageLimit:s.pageLimit||0})).sort((a,b)=>a.key.localeCompare(b.key))));
  return {key,inputHash};
 },
 async acquire(att,{selection,jobID=null,abort=null}={}){
  if(!this.enabled())return null;const client=await this.connect(),{key,inputHash}=await this.identity(att,selection);
  if(this.active.has(key))throw CoordinationCore.error('COORD_BUSY','本机另一任务正在处理这篇文献，未重复运行。');
  let result=await client.claim(key,inputHash,{resumeToken:this.records[key]?.token});
  const local=this.records[key];
  if(result.kind==='committing'&&result.record.owner===this.owner&&local?.token===result.record.token&&local.runID){
   const parent=att.parentID?await Zotero.Items.getAsync(att.parentID):att;const found=(await ReaderSaved.candidates(att)).find(n=>n.record?.runID===local.runID&&n.record.itemKey===parent.key);
   if(found){const old={key,token:local.token,inputHash:result.record.inputHash,state:'committing'};await client.complete(old,found.note.key);delete this.records[key];await this.persist();result={kind:'done',record:{...result.record,state:'done',noteKey:found.note.key}};}
  }
  if(result.kind!=='owned')return {...result,key};
  const h={...result.handle,jobID,abort,client,timer:null,lost:false};this.active.set(key,h);
  this.records[key]={token:h.token,inputHash:h.inputHash,jobID,libraryID:att.libraryID,attachmentKey:att.key,session:this.session};try{await this.persist();}catch(e){this.active.delete(key);throw CoordinationCore.error('COORD_LOCAL','无法保存本机领取回执，未启动精读。');}
  this.heartbeat(h);return {kind:'owned',handle:h};
 },
 heartbeat(h){h.timer=ReaderTimers.setTimeout(async()=>{if(this.active.get(h.key)!==h||h.state!=='running')return;try{await h.client.renew(h);this.heartbeat(h);}catch(e){h.lost=true;h.error=e;h.abort?.();this.error=e.message;this.render();}},180000);},
 async check(h){if(!h)return;if(h.lost)throw h.error;await h.client.owned(h,{allowCommit:true});},
 async leave(h,{park=false,noteKey=null}={}){
  if(!h)return;if(h.timer)ReaderTimers.clearTimeout(h.timer);
  try{if(h.lost)return;if(noteKey){await h.client.complete(h,noteKey);delete this.records[h.key];}
   else if(h.state==='running'){if(park)await h.client.park(h);else{await h.client.release(h);delete this.records[h.key];}}
   // A committing record never expires or auto-releases: recovery must verify the saved note.
   await this.persist();
  }catch(e){this.error=e.message;this.render();}finally{this.active.delete(h.key);}
 },
 async enterJob(job,worker){
  if(!this.enabled())return true;
  const att=await ReaderAutomation.attachment(job);const r=await this.acquire(att,{selection:job.inputSelection,jobID:job.id,abort:()=>{worker.codex.controller?.abort();worker.app.controller?.abort();}});
  if(r?.kind==='owned'){worker.coordination=r.handle;worker.codex.coordination=r.handle;delete job.coordinationWaitUntil;return true;}
  if(r?.kind==='done'){
   const saved=await ReaderSaved.matching(att,job.inputSelection);
   if(saved?.note.key===r.record.noteKey){job.state=saved.status==='checked'?'done':'imported';job.notes={reading:{key:saved.note.key,id:saved.note.id,reused:true}};job.message='另一台已完成精读，已识别同步笔记；本机未重复处理。';return false;}
  }
  job.state='queued';job.coordinationWaitUntil=Date.now()+Math.min(15*60*1000,Math.max(15000,r?.retryMs||10*60*1000));
  const labels={busy:'另一台正在精读，本机继续处理其他文献。',race:'此篇刚被另一台领取，本机稍后核对。',parked:'另一台保留了待检查或待导入草稿，请在原电脑继续。',committing:'另一台正在保存或保存中断，暂不接手，防止重复笔记。',done:'另一台已保存笔记，等待 Zotero 数据同步后识别。','different-input':'另一台已有不同附件版本的精读结果，需核对后再处理。'};
  job.message=labels[r?.kind]||'协作状态待确认，本机暂不处理此篇。';return false;
 },
 async exitJob(job,worker){if(worker.coordination){await this.leave(worker.coordination,{park:!!job.workflowPath,noteKey:job.notes?.reading?.key||worker.coordination.noteKey});worker.coordination=null;worker.codex.coordination=null;}},
 async beforeSave(att,path,workflow){
  if(!this.enabled())return null;const {key,inputHash}=await this.identity(att,workflow.inputSelection);let h=this.active.get(key),standalone=false;
  if(!h){const r=await this.acquire(att,{selection:workflow.inputSelection});if(r.kind!=='owned')throw CoordinationCore.error('COORD_SAVE','另一台正在处理或已保存此篇；本次未创建重复笔记，本地稿件保留。');h=r.handle;standalone=true;}
  if(h.inputHash!==inputHash||h.jobID&&workflow.queueJobID!==h.jobID)throw CoordinationCore.error('COORD_BUSY','此篇另一份稿件正在处理，未借用其处理权保存。');
  if(h.state==='committing')throw CoordinationCore.error('COORD_COMMIT','此篇上次保存结果尚待确认，未重复写入。');
  this.records[key]={...this.records[key],runID:PathUtils.filename(PathUtils.parent(path))};await this.persist();
  await this.check(h);await h.client.commit(h);if(h.timer)ReaderTimers.clearTimeout(h.timer);return {h,standalone};
 },
 async rollbackSave(guard){if(!guard)return;try{await guard.h.client.rollback(guard.h);}catch(e){this.error=e.message;}if(guard.standalone)await this.leave(guard.h,{park:true});},
 async saved(guard,key){if(!guard)return;guard.h.noteKey=key;if(guard.standalone)await this.leave(guard.h,{noteKey:key});},
 async archive(p,action){
  this.app.assertIndexes?.();
  if(!this.enabled())return action();
  // The reading owner retains a non-expiring commit guard until automatic archive finishes.
  const readingKey=await this.app.sha256Text(String(Zotero.Users.getCurrentUserID())+':'+p.itemKey),h=this.active.get(readingKey);
  if(h&&h.jobID===p.jobID)await this.check(h);
  const client=await this.connect(),reading=await client.load(readingKey);if(!h&&reading.record&&reading.record.state!=='done'&&reading.record.state!=='available')throw CoordinationCore.error('COORD_ARCHIVE','另一端仍在处理此篇，暂不并行调整分类。');
  const key=await this.app.sha256Text('archive:'+readingKey),hash=await this.app.sha256Text(p.noteKey+':'+p.noteHash),claim=await client.claim(key,hash);
  if(claim.kind!=='owned')throw CoordinationCore.error('COORD_ARCHIVE','另一台正在调整此篇分类，或上次归档结果待确认；本次未重复归档。');
  const guard=claim.handle;await client.commit(guard);
  const settle=async()=>{const s=await client.owned(guard,{allowCommit:true});if(!await client.write(key,{...s.record,state:'available',revision:s.record.revision+1,updatedAt:s.now,expiresAt:0},s.etag))throw CoordinationCore.error('COORD_ARCHIVE','归档已执行，协作记录待确认。');};
  try{const result=await action();await settle();return result;}catch(e){if(p.status==='pending'||p.status==='confirmed')try{await settle();}catch(_){}throw e;}
 },
 install(){
  const service=this,read=ReaderCodex.readPaper,invoke=ReaderCodex.invoke,confirm=ReaderClassifier.confirm;
  ReaderCodex.readPaper=async function(paper,context,signal,hooks){
   if(!service.enabled())return read.call(this,paper,context,signal,hooks);
   if(this.coordination){await service.check(this.coordination);return read.call(this,paper,context,signal,hooks);}
   const inputContext=hooks?.resume?.metadata||context;if(!inputContext?.source)throw NoteCore.error('NOTE_SOURCE','缺少续检来源身份，原稿已保留。');
   const att=await Zotero.Items.getByLibraryAndKeyAsync(inputContext.source.libraryID,inputContext.source.key),r=await service.acquire(att,{selection:inputContext.inputSelection,abort:()=>this.controller?.abort()});
   if(r.kind!=='owned')throw CoordinationCore.error('COORD_BUSY','另一台正在处理或已有结果，本机未重复精读。');this.coordination=r.handle;
   try{return await read.call(this,paper,context,signal,hooks);}finally{await service.leave(r.handle,{park:true});this.coordination=null;}
  };
  ReaderCodex.invoke=async function(...args){if(service.enabled()&&this.coordination){await service.check(this.coordination);if(this.coordination.state!=='running')throw CoordinationCore.error('COORD_PHASE','此篇已进入保存阶段，未重复请求精读模型。');}return invoke.apply(this,args);};
  ReaderClassifier.confirm=async function(id,...args){const p=this.proposals[id];return p?service.archive(p,()=>confirm.call(this,id,...args)):confirm.call(this,id,...args);};
 },
 bind(win){
  const get=id=>win.document.getElementById('zri-coordination-'+id);if(!get('toggle')||get('toggle').dataset.bound)return;get('toggle').dataset.bound='true';this.views.add(win);win.addEventListener('unload',()=>this.views.delete(win),{once:true});
  get('toggle').addEventListener('click',async()=>{if(this.testing)return;if(ReaderAutomation.running.size||ReaderAutomation.bulkSaving||ReaderAutomation.starting||ReaderAutomation.resumeEnqueueing||ReaderCodex.active||ReaderNotes.pending||Object.values(ReaderClassifier.proposals).some(p=>p.status==='confirming')){this.error='请先暂停并等待当前任务收尾，再切换协作方式。';this.render();return;}this.testing=true;this.error='';const wasPaused=ReaderAutomation.state.paused;ReaderAutomation.state.paused=true;this.render();try{await ReaderAutomation.persist();if(this.enabled()){Zotero.Prefs.set(this.app.pref+'coordination.enabled',false,true);}else{await this.connect({verify:true});Zotero.Prefs.set(this.app.pref+'coordination.enabled',true,true);}}catch(e){this.error=e.message;}finally{ReaderAutomation.state.paused=wasPaused;await ReaderAutomation.persist();ReaderAutomation.schedule();this.testing=false;this.render();}});this.render();
 },
 render(){for(const win of [...this.views]){if(win.closed){this.views.delete(win);continue;}const button=win.document.getElementById('zri-coordination-toggle'),status=win.document.getElementById('zri-coordination-status');if(button){button.disabled=this.testing;button.textContent=this.testing?'检测三端领取中…':this.enabled()?'关闭并行防重复':'检测并开启（仅同时运行时）';}if(status)status.textContent=this.error||(this.enabled()?'已开启：同一文献先领取再精读，其他机器继续处理别篇。所有处理端都需安装新版并开启。':'未开启。轮换设备可直接使用；已保存笔记先完成 Zotero 同步。仅同时运行重叠任务时才需检测开启。');}},
 async shutdown(){for(const h of this.active.values()){if(h.timer)ReaderTimers.clearTimeout(h.timer);h.abort?.();}this.client=null;this.views.clear();await this.io.catch(()=>{});}
};
