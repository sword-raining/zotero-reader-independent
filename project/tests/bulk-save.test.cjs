const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const N=require('../content/note-core.js');
function fixture(){
 const scope={NoteCore:N,ReaderCodex:{state:{}},ReaderCleanup:{active:null,completedActive:null}};vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../content/automation.js'),'utf8'),scope);
 const a=scope.ReaderAutomation;a.started=true;a.app={safeError:e=>e.message};a.refreshViews=()=>{};a.schedule=()=>{};
 const add=(id,state='awaiting_import')=>a.state.jobs[id]={id,title:id,state,workflowPath:'/readings/'+id+'/workflow.json'};
 return {a,scope,add};
}
test('bulk save selects only waiting results and excludes running, editing, saved and cancelled papers',async()=>{
 const {a,scope,add}=fixture();add('ready');add('cancelled','cancelled');add('review','needs_review');add('saved').notes={reading:{key:'NOTE'}};add('running');a.running.set('running',{job:a.state.jobs.running});add('editing');scope.ReaderCodex.state={editing:true,followJobID:'editing'};add('clearing');a.historyClearing.add('clearing');
 const calls=[];a.importResult=async(path,options)=>{assert.equal(options.requireChecked,true);options.validateTask();calls.push(path);return {status:'checked'};};
 const r=await a.saveReadyNotes();assert.equal(r.saved,1);assert.deepEqual(calls,['/readings/ready/workflow.json']);assert.equal(a.bulkSaving,null);
});
test('bulk save is sequential and repeated clicks share one operation while per-paper failures do not stop other saves',async()=>{
 const {a,add}=fixture();for(const id of ['first','changed','failed','last'])add(id);let release;const gate=new Promise(r=>release=r),calls=[];let active=0,peak=0;
 a.importResult=async(path,{validateTask})=>{validateTask();calls.push(path);peak=Math.max(peak,++active);try{await gate;if(path.includes('changed'))throw N.error('NOTE_CHANGED','changed draft');if(path.includes('failed'))throw Error('write error');return {status:'checked'};}finally{active--;}};
 const first=a.saveReadyNotes(),second=a.saveReadyNotes();await Promise.resolve();release();const [r,r2]=await Promise.all([first,second]);assert.equal(r,r2);assert.equal(peak,1);assert.equal(calls.length,4);assert.equal(r.saved,2);assert.equal(r.skipped,1);assert.equal(r.failed,1);assert.match(a.bulkSaveMessage,/changed draft/);assert.match(a.bulkSaveMessage,/write error/);
});
test('bulk save revalidates tasks after waiting for cleanup and never adds tasks that appeared after the click',async()=>{
 const {a,scope,add}=fixture();const changed=add('changed');let release;scope.ReaderCleanup.active=new Promise(r=>release=r);const calls=[];a.importResult=async(path,o)=>{o.validateTask();calls.push(path);return {status:'checked'};};const promise=a.saveReadyNotes();changed.workflowPath='/other/workflow.json';add('late');release();const r=await promise;assert.equal(r.skipped,1);assert.equal(calls.length,0);
});
test('shutdown or an editor opened during a queued save prevents that note from being written',async()=>{
 for(const change of [f=>f.a.started=false,f=>f.scope.ReaderCodex.state={editing:true,followJobID:'ready'}]){const f=fixture();f.add('ready');let writes=0;f.a.importResult=async(path,o)=>{change(f);o.validateTask();writes++;return {status:'checked'};};const r=await f.a.saveReadyNotes();assert.equal(writes,0);assert.equal(r.skipped,1);}
});
test('saving locks only the current draft editor and releases locks on success or error',async()=>{
 const scope={NoteCore:N,ReaderCleanup:{active:null},ReaderAutomation:{historyClearing:new Set(),state:{jobs:{}}}};vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../content/note-runtime.js'),'utf8'),scope);const n=scope.ReaderNotes;let release;n._save=()=>new Promise(r=>release=r);const p=n.save('one',{});assert.equal(n.saving('one'),true);assert.equal(n.saving('two'),false);await Promise.resolve();release('ok');await p;assert.equal(n.pending,0);assert.equal(n.saving('one'),false);n._save=async()=>{throw Error('failed');};await assert.rejects(n.save('one',{}),/failed/);assert.equal(n.saving('one'),false);
});

test('Pause All stops not-yet-written bulk saves without importing the remaining items',async()=>{
 const {a,add}=fixture();a.persist=async()=>{};add('first');add('next');let release,writes=0;const gate=new Promise(r=>release=r);a.importResult=async(path,options)=>{await gate;options.validateTask();writes++;return {status:'checked'};};const save=a.saveReadyNotes();await Promise.resolve();const pause=a.pauseAll();release();const r=await save;await pause;assert.equal(writes,0);assert.equal(r.skipped,2);assert.equal(a.state.paused,true);assert.equal(a.pausing,null);
});
