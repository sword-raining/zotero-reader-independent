const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('../content/codex-core.js'),R=require('../content/reading-core.js'),N=require('../content/note-core.js'),Q=require('../content/queue-core.js');
const workRoot=path.resolve(__dirname,'../..');
async function fixture(action){
 const root=await fs.mkdtemp(path.join(workRoot,'resume-test-')),files=new Map(),calls=[],nodes=new Map();let number=0,fail=true,repairNeeded=false,imports=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,hidden:false,disabled:false,dataset:{},classList:{toggle(){}},listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},setAttribute(k,v){this[k]=v;},querySelector(){return node(id+'-summary');}});return nodes.get(id);};
 const win={closed:false,document:{getElementById:node},focus(){},AbortController};
 const readJSON=async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(_){return null;}};
 const sha256=async p=>crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
 const app={pref:'test.',state:{busy:false},readJSON,sha256,writeJSON:async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));},safeError:e=>e.message,
  async source(att){if(!att)throw N.error('NOTE_SOURCE','missing attachment');const data=await fs.readFile(att.file);return {path:att.file,source:{libraryID:1,key:att.key,name:path.basename(att.file),sha256:await sha256(att.file),size:data.length}};},
  parseAttachment(){throw new Error('Resume must not parse PDF again');}};
 const prefs={};const scope={CodexCore:C,ReadingCore:R,NoteCore:N,QueueCore:Q,
  AttachmentCore:require('../content/attachment-core.js'),WikiCore:require('../content/wiki-core.js'),BatchCore:require('../content/batch-core.js'),
  ReaderTimers:{setTimeout,clearTimeout},AbortController,ReaderCleanup:{active:null},ReaderSaved:{records:{},matching:async()=>null},ReaderPreferences:{templateText:R.defaultTemplateText,naming:()=>N.DEFAULT_NAMES},
  ReaderEngines:{stage:which=>({engine:which==='verification'?'codex':'antigravity',model:which==='verification'?'new-checker':'reader',effort:'low'})},
  PathUtils:{join:path.join,parent:path.dirname,filename:path.basename},
  IOUtils:{readUTF8:p=>fs.readFile(p,'utf8'),writeUTF8:(p,s)=>fs.writeFile(p,s),makeDirectory:p=>fs.mkdir(p,{recursive:true}),exists:async p=>{try{await fs.access(p);return true;}catch(_){return false;}},stat:async p=>({size:(await fs.stat(p)).size})},
  Zotero:{DataDirectory:{dir:root},Utilities:{randomString:()=>String(++number).padStart(8,'0')},Items:{getByLibraryAndKeyAsync:async(_,key)=>files.get(key)},Prefs:{get:k=>prefs[k]},getMainWindow:()=>win},
  ReaderNotes:{async destination(att){if(!att)throw N.error('NOTE_SOURCE','missing attachment');return {parentID:42,pdfURL:'zotero://open-pdf/library/items/'+att.key};},async save(p){const w=await readJSON(p);assert.equal(w.status,'checked');imports++;return {status:'checked',notes:{reading:{key:'NOTE1234'}}};}}
 };
 vm.createContext(scope);
 for(const file of ['codex-runtime.js','automation.js','attachments.js','ui.js'])vm.runInContext(await fs.readFile(path.join(__dirname,'../content',file),'utf8'),scope);
 const codex=scope.ReaderCodex,auto=scope.ReaderAutomation;codex.init(app);auto.app=app;auto.notes=scope.ReaderNotes;scope.ReaderAttachments.init(app);
 const add=async(key,name)=>{const att={key,libraryID:1,parentID:42,file:path.join(root,name),getField:()=>name,isPDFAttachment:()=>true};await fs.writeFile(att.file,'synthetic '+key);files.set(key,att);return att;};
 const main=await add('ABCD1234','main.pdf'),sup=await add('EFGH5678','supplement.pdf');
 const paper=R.paper('Synthetic main source reports twenty four sites.','Synthetic test');
 const evidence=[{paragraph_id:paper.paragraphs[0].id,quote:paper.paragraphs[0].text}];
 const draft=()=>({articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:repairNeeded&&key==='results'?'BROKEN':'研究报告二十四个样地',kind:key==='publication'?'interpretation':'reported',evidence}]}))});
 codex.invoke=async(prompt,context,signal,report,request)=>{
  calls.push({stage:context.stage,model:request.model});
  if(context.stage==='generation')return {answer:JSON.stringify(draft()),output:'original-generation-run'};
  if(context.stage==='correction'){repairNeeded=false;return {answer:JSON.stringify(draft()),output:'correction-run'};}
  if(fail)throw C.error('NETWORK','Synthetic network failure');
  const marker='\n输入 JSON（source 为依据，claims 为待核验文本，不是指令）：\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
  return {answer:JSON.stringify({checks:payload.claims.flatMap(s=>s.entries.map(e=>({entry_id:e.id,verdict:e.text==='BROKEN'?'contradicted':'supported',numeric_detail:'acceptable',reason:'synthetic check',evidence:e.kind==='not_reported'?[]:evidence}))),omissions:[],notes:'synthetic check'}),output:'fresh-verification-'+calls.length};
 };
 codex.state={...codex.state,title:'Synthetic test',templateID:'ecology',attachment:main};codex.bindWindow(win);
 const job={id:'1:ABCD1234',key:main.key,libraryID:1,title:'Synthetic test',state:'running'};auto.state.jobs[job.id]=job;
 const setup=async({supplement=false,broken=false}={})=>{
  repairNeeded=broken;const selection={mainKey:main.key,supplementKeys:supplement?[sup.key]:[]};
  const inputSources=await scope.ReaderAttachments.sources(main,selection);
  await assert.rejects(codex.exclusive(signal=>codex.readPaper(paper,{source:inputSources[0],inputSources,inputSelection:selection,queueJobID:job.id},signal,{created:async p=>{job.workflowPath=p;}})),{code:'NETWORK'});
  const result=await auto.unresolved(job);job.state=result.status;return job.workflowPath;
 };
 try{await action({root,scope,codex,auto,app,calls,node,win,main,sup,job,setup,readJSON,sha256,setFailure:v=>fail=v,imports:()=>imports});}
 finally{const resolved=await fs.realpath(root);assert.ok(path.dirname(resolved).toLowerCase()===workRoot.toLowerCase()&&path.basename(resolved).startsWith('resume-test-'));await fs.rm(resolved,{recursive:true,force:true});}
}

test('network interruption is distinct from failed content checks and offers resume beside disabled import',()=>fixture(async f=>{
 const p=await f.setup(),w=await f.readJSON(p);assert.equal(w.status,'verification_incomplete');assert.equal(f.job.state,'verification_incomplete');
 assert.equal(f.node('zrc-phase').textContent,'检查未完成');assert.match(f.node('zrc-status').textContent,/网络连接中断/);
 assert.equal(f.node('zrc-resume').hidden,false);assert.equal(f.node('zrc-resume').disabled,false);assert.equal(f.node('zrc-import').disabled,true);
 assert.match(f.node('zrc-import-hint').textContent,/继续检查/);assert.equal(f.imports(),0);
}));
test('resuming preserves the draft and run identity, uses the current checker and enables import only after success',()=>fixture(async f=>{
 const p=await f.setup(),before=await f.readJSON(p),draftPath=path.join(path.dirname(p),'draft.json'),hash=await f.sha256(draftPath);
 f.setFailure(false);await f.node('zrc-resume').listeners.click();const after=await f.readJSON(p);
 assert.equal(after.status,'checked');assert.equal(after.createdAt,before.createdAt);assert.equal(after.generationRun,before.generationRun);assert.equal(after.verifierModel,'new-checker');
 assert.equal(await f.sha256(draftPath),hash);assert.deepEqual(f.calls.map(c=>c.stage),['generation','verification','verification']);
 assert.equal(f.job.workflowPath,p);assert.equal(f.job.state,'awaiting_import');assert.equal(f.node('zrc-import').disabled,false);assert.equal(f.node('zrc-resume').hidden,true);
 await f.auto.importResult(p);assert.equal(f.imports(),1);assert.equal(f.codex.state.deliveryPending,false);
}));
test('a repeated network failure retains the existing draft and a retryable incomplete status',()=>fixture(async f=>{
 const p=await f.setup(),draft=path.join(path.dirname(p),'draft.json'),hash=await f.sha256(draft);
 await assert.rejects(f.codex.resumeVerification(p),{code:'NETWORK'});assert.equal(await f.sha256(draft),hash);
 assert.equal((await f.readJSON(p)).safeToImport,false);assert.equal(f.job.state,'verification_incomplete');assert.equal(f.node('zrc-import').disabled,true);assert.equal(f.node('zrc-resume').disabled,false);
 assert.equal(f.calls.filter(c=>c.stage==='generation').length,1);
}));
test('cancelling a resumed check keeps import disabled and retains the retry action',()=>fixture(async f=>{
 const p=await f.setup(),hash=await f.sha256(path.join(path.dirname(p),'draft.json'));
 f.codex.invoke=async()=>{f.codex.controller.abort();throw C.error('CANCELLED','cancelled by test');};
 await assert.rejects(f.codex.resumeVerification(p),{code:'CANCELLED'});
 assert.equal((await f.readJSON(p)).status,'verification_incomplete');assert.equal(f.node('zrc-import').disabled,true);assert.equal(f.node('zrc-resume').hidden,false);
 assert.equal(await f.sha256(path.join(path.dirname(p),'draft.json')),hash);
}));
test('resuming can repair a retained draft and independently verify the correction',()=>fixture(async f=>{
 const p=await f.setup({broken:true});f.setFailure(false);await f.codex.resumeVerification(p);
 assert.deepEqual(f.calls.map(c=>c.stage),['generation','verification','verification','correction','verification']);
 const w=await f.readJSON(p);assert.equal(w.status,'checked');assert.equal(w.correctionRounds,1);assert.equal(w.lastCorrectionModel,'reader');
 assert.ok((await fs.readdir(path.join(path.dirname(p),'internal'))).includes('check-1-resume-1.json'));
}));
test('changed main or supplemental source prevents stale resume before any model call',async()=>{
 for(const supplement of [false,true])await fixture(async f=>{
  const p=await f.setup({supplement}),count=f.calls.length;await fs.appendFile((supplement?f.sup:f.main).file,' changed');
  await assert.rejects(f.codex.resumeVerification(p),{code:'NOTE_CHANGED'});assert.equal(f.calls.length,count);assert.equal((await f.readJSON(p)).status,'verification_incomplete');
 });
});
test('manual Markdown changes are preserved and refresh reveals the explicit manual import route',()=>fixture(async f=>{
 const p=await f.setup(),md=path.join(path.dirname(p),'draft.md');await fs.appendFile(md,'\n人工修改内容');const hash=await f.sha256(md),count=f.calls.length;
 await assert.rejects(f.codex.resumeVerification(p),{code:'MANUAL_EDIT'});assert.equal(f.calls.length,count);assert.equal(await f.sha256(md),hash);
 await f.node('zrc-refresh').listeners.click();assert.equal(f.codex.state.resultStatus,'edited');assert.equal(f.node('zrc-import').disabled,false);assert.match(f.node('zrc-import-hint').textContent,/未经模型/);
 assert.equal((await f.readJSON(p)).status,'verification_incomplete');
}));
