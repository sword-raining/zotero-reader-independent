const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Q=require('../content/queue-core.js'),S=require('../content/saved-core.js'),N=require('../content/note-core.js');
function fixture(){
 const runID='1794000000000-testdone',base='/synthetic/zotero-reader-independent',file=base+'/readings/'+runID+'/workflow.json',data=new Map(),writes=new Map();let cleaned=0,unmodified=true,records=0;
 const job={id:'1:PDF00001',key:'PDF00001',libraryID:1,title:'Completed paper',trigger:'manual',attempt:1,state:'done',createdAt:1,updatedAt:2,workflowPath:file,notes:{reading:{key:'NOTE0001'}}},proposal={id:'1:PARENT01',jobID:job.id,libraryID:1,itemKey:'PARENT01',noteKey:'NOTE0001',status:'confirmed',confirmedAt:'2026-11-08T00:00:00Z'};
 const html=S.embed('<div><a href="zotero://open-pdf/library/items/PDF00001">PDF</a><p>Saved note</p><!-- ZRI:'+runID+':reading --></div>',{schema:1,runID,itemKey:'PARENT01',status:'checked',createdAt:'2026-11-08T00:00:00Z',inputs:[{key:job.key,role:'main',sha256:'a'.repeat(64)}],bodySHA256:'b'.repeat(64)});
 const att={key:job.key,libraryID:1,parentID:1,isPDFAttachment:()=>true},note={key:'NOTE0001',libraryID:1,parentID:1,isNote:()=>true,getNote:()=>html};
 data.set(file,{status:'checked',source:{libraryID:1,key:job.key},zoteroNotes:job.notes,noteStatus:'checked'});
 const app={pref:'test.',safeError:e=>e.message,state:{busy:false},readJSON:async p=>data.get(p)||null,writeJSON:async(p,value)=>writes.set(p,JSON.parse(JSON.stringify(value)))};
 const scope={QueueCore:Q,SavedCore:S,NoteCore:N,PathUtils:{join:path.posix.join,parent:path.posix.dirname,filename:path.posix.basename},IOUtils:{exists:async p=>data.has(p),makeDirectory:async()=>{}},ReaderCodex:{state:{},active:null},ReaderNotes:{pending:0},ReaderClassifier:{proposals:{[proposal.id]:proposal},persist:async()=>{}},ReaderSaved:{record:async()=>{records++;return {status:"checked"};},noteState:async()=>({status:"checked"})},Zotero:{DataDirectory:{dir:'/synthetic'},Items:{getByLibraryAndKeyAsync:async(_,key)=>key===att.key?att:key===note.key?note:null}}};
 vm.createContext(scope);for(const f of ['automation.js','cleanup.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../content',f),'utf8'),scope);
 const auto=scope.ReaderAutomation,clean=scope.ReaderCleanup;auto.app=app;auto.state.jobs[job.id]=job;auto.refreshViews=()=>{};auto.schedule=()=>{};auto.noteSaved=()=>{};clean.init(app);clean.safeTree=async()=>{};clean.readingUnmodified=async()=>unmodified;clean.afterSave=async p=>{cleaned++;data.delete(p);return {state:'done'};};
 return {scope,auto,clean,job,proposal,att,note,app,data,writes,file,runID,cleaned:()=>cleaned,records:()=>records,setModified:()=>unmodified=false};
}
test('one cleanup removes safe generated cache and hides completed history while retaining a deduplication receipt',async()=>{
 const f=fixture(),noteBefore=f.note.getNote();const r=await f.clean.sweepCompleted();assert.equal(r.cleaned,1);assert.equal(f.cleaned(),1);assert.equal(f.records(),1);assert.equal(f.note.getNote(),noteBefore);const receipt=f.auto.state.jobs[f.job.id];assert.ok(f.auto.historyHidden(receipt));assert.equal(receipt.title,undefined);assert.equal(receipt.workflowPath,undefined);assert.equal(receipt.notes.reading.key,'NOTE0001');
 const reloaded=structuredClone(f.writes.get(f.auto.file()));assert.equal(Q.enqueue(reloaded,{libraryID:1,key:f.job.key},{trigger:'auto'}).created,false);assert.equal(Q.enqueue(reloaded,{libraryID:1,key:f.job.key},{trigger:'manual'}).created,true);assert.equal(reloaded.jobs[f.job.id].historyClearedAt,undefined);
});
test('already-cleaned cache still allows history removal and repeated clicks are idempotent',async()=>{
 const f=fixture();f.data.delete(f.file);delete f.job.workflowPath;f.job.savedRunID=f.runID;assert.equal((await f.clean.sweepCompleted()).cleaned,1);assert.equal(f.cleaned(),0);assert.equal((await f.clean.sweepCompleted()).cleaned,0);
});
test('running and unresolved tasks and unconfirmed or stale archive records are retained',async()=>{
 for(const state of ['running','queued','needs_review','verification_incomplete','awaiting_import','failed']){const f=fixture();f.job.state=state;assert.equal((await f.clean.sweepCompleted()).cleaned,0);assert.equal(f.cleaned(),0);assert.equal(f.auto.state.jobs[f.job.id],f.job);}
 for(const mutate of [f=>f.proposal.status='pending',f=>f.job.classificationPending=true,f=>f.proposal.noteKey='OTHER001',f=>f.auto.running.set(f.job.id,{job:f.job})]){const f=fixture();mutate(f);assert.equal((await f.clean.sweepCompleted()).cleaned,0);assert.equal(f.cleaned(),0);}
});
test('a modified draft, missing note or active editor prevents both cache and history cleanup',async()=>{
 for(const mutate of [f=>f.setModified(),f=>f.note.deleted=true,f=>f.scope.ReaderCodex.state={editing:true,followJobID:f.job.id}]){const f=fixture();mutate(f);const r=await f.clean.sweepCompleted();assert.equal(r.retained,1);assert.equal(f.cleaned(),0);assert.equal(f.auto.state.jobs[f.job.id],f.job);assert.ok(r.details[0].reason);}
});
test('unrelated running work continues while a finished task is cleaned',async()=>{
 const f=fixture(),other={id:'1:OTHER001',key:'OTHER001',libraryID:1,state:'running'};f.auto.state.jobs[other.id]=other;const worker={job:other};f.auto.running.set(other.id,worker);f.auto.activeJob=other;f.auto.active=Promise.resolve();f.scope.ReaderCodex.state={busy:true,attachment:{key:other.key,libraryID:1}};const r=await f.clean.sweepCompleted();assert.equal(r.cleaned,1);assert.equal(r.skipped,1);assert.equal(f.auto.running.get(other.id),worker);assert.equal(f.auto.state.jobs[other.id],other);
});
test('a failed cache cleanup keeps its history available for retry',async()=>{
 const f=fixture();f.clean.afterSave=async()=>({state:'retained',message:'Synthetic cache permission error'});const r=await f.clean.sweepCompleted();assert.equal(r.retained,1);assert.equal(f.auto.state.jobs[f.job.id],f.job);assert.equal(f.auto.historyHidden(f.job),false);
});
test('queue write failure restores the visible job after successful cache cleanup',async()=>{
 const f=fixture();f.app.writeJSON=async()=>{throw Error('Synthetic queue write failure');};const r=await f.clean.sweepCompleted();assert.equal(r.retained,1);assert.equal(f.cleaned(),1);assert.equal(f.auto.state.jobs[f.job.id],f.job);assert.equal(f.auto.historyHidden(f.job),false);assert.equal(f.auto.historyClearing.size,0);
});
test('changed task or confirmation while awaiting a receipt prevents deletion',async()=>{
 const f=fixture();f.scope.ReaderClassifier.persist=async()=>{f.proposal.status='pending';};const r=await f.clean.sweepCompleted();assert.equal(r.retained,1);assert.equal(f.cleaned(),0);assert.equal(f.auto.state.jobs[f.job.id],f.job);
});
test('concurrent cleanup requests share the operation and release their locks',async()=>{
 const f=fixture();let release,entered;const gate=new Promise(r=>release=r),began=new Promise(r=>entered=r);f.clean.afterSave=async()=>{entered();await gate;return {state:'done'};};const a=f.clean.sweepCompleted();await began;const b=f.clean.sweepCompleted();assert.ok(f.auto.historyClearing.has(f.job.id));release();const [x,y]=await Promise.all([a,b]);assert.equal(x,y);assert.equal(x.cleaned,1);assert.equal(f.auto.historyClearing.size,0);assert.equal(f.clean.completedActive,null);
});

test('cleaning an edited saved note preserves the edited task status',async()=>{const f=fixture();f.scope.ReaderSaved.noteState=async()=>({status:'edited'});const r=await f.clean.sweepCompleted();assert.equal(r.cleaned,1);assert.equal(f.auto.state.jobs[f.job.id].state,'imported');});


test('old and new existing-note skips stay out of the queue and cleanup totals without changing any file',async()=>{
 const f=fixture();delete f.job.workflowPath;f.job.notes.reading.reused=true;f.scope.ReaderClassifier.proposals={};f.setModified();const before=f.note.getNote(),record=JSON.stringify(f.job);
 assert.ok(f.auto.historyHidden(f.job));const r=await f.clean.sweepCompleted();assert.equal(r.cleaned,0);assert.equal(r.skipped,0);assert.equal(r.retained,0);assert.equal(f.cleaned(),0);assert.equal(f.records(),0);assert.ok(f.data.has(f.file));assert.equal(f.note.getNote(),before);assert.equal(JSON.stringify(f.job),record);
 const reload=JSON.parse(record);assert.ok(f.auto.historyHidden(reload));assert.equal(Q.enqueue(f.auto.state,{libraryID:1,key:f.job.key},{trigger:'auto'}).created,false);
 const explicit=Q.enqueue(f.auto.state,{libraryID:1,key:f.job.key},{trigger:'manual'});assert.equal(explicit.created,true);assert.equal(f.auto.historyHidden(explicit.job),false);
});
test('real work, local drafts and explicit archive requests are not hidden as existing-note skips',()=>{
 for(const mutate of [f=>f.job.state='running',f=>f.job.notes.reading.reused=false,f=>f.job.workflowPath=f.file,f=>f.job.savedRunID=f.runID,f=>f.job.classificationPending=true,f=>f.job.classificationStatus='failed',f=>f.scope.ReaderClassifier.proposals={pending:{jobID:f.job.id,noteKey:f.note.key,status:'pending'}}]){
  const f=fixture();delete f.job.workflowPath;f.job.notes.reading.reused=true;f.scope.ReaderClassifier.proposals={};mutate(f);assert.equal(f.auto.historyHidden(f.job),false);
 }
});
