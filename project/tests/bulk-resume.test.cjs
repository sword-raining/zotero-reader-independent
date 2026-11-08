const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const B=require('../content/batch-core.js');
const N=require('../content/note-core.js'),Q=require('../content/queue-core.js');
function fixture(){
 const scope={NoteCore:N,CodexCore:N,QueueCore:Q,ReaderCodex:{state:{},syncWorker(){}},ReaderCleanup:{active:null,completedActive:null},ReaderNotes:{pending:0,saving:()=>false},ReaderPreferences:{workflow:()=>({papers:2}),delivery:()=> 'manual'},Zotero:{Prefs:{get:()=>false}}};vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../content/automation.js'),'utf8'),scope);
 const a=scope.ReaderAutomation;a.started=true;a.app={state:{},pref:'test.',safeError:e=>e.message,readJSON:async()=>({status:'checked'})};a.persist=async()=>{};a.refreshViews=()=>{};a.schedule=()=>{};a.refreshResumeState=async job=>(job.resumeAvailable=job.valid!==false);a.checkResumeMarkdown=async job=>{if(job.edited)throw N.error('MANUAL_EDIT','edited draft');};
 const add=(id,state='verification_incomplete')=>a.state.jobs[id]={id,title:id,key:id,state,trigger:'manual',workflowPath:'/readings/'+id+'/workflow.json',resumeAvailable:true,resumeNeedsRepair:false};
 const calls=[],releases={};a.createWorker=job=>({job,codex:{resumeVerification:async(path,{repair})=>{calls.push({id:job.id,repair});await new Promise(r=>releases[job.id]=r);}}});
 return {a,scope,add,calls,releases};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('one-click continuation queues incomplete, cancelled and review drafts while preserving edited, missing and saved work',async()=>{
 const f=fixture();f.add('interrupted');f.add('stopped','cancelled');f.add('review','needs_review');f.add('saved','done').notes={reading:{key:'NOTE'}};f.add('missing').valid=false;f.add('edited').edited=true;f.add('language','cancelled').languageSkipped=true;f.add('editor');f.scope.ReaderCodex.state={editing:true,followJobID:'editor'};f.a.state.paused=true;
 const r=await f.a.continueAll();assert.equal(r.queued,3);assert.equal(r.skipped,2);assert.equal(f.a.state.paused,false);assert.equal(f.a.state.jobs.review.resumePending.repair,true);assert.equal(f.a.state.jobs.stopped.resumePending.repair,false);assert.equal(f.calls.length,0);assert.match(f.a.bulkResumeMessage,/edited draft/);
});
test('continuations respect the shared paper limit and queue pause then run the next paper only once',async()=>{
 const f=fixture();for(const id of ['one','two','three'])f.add(id);await f.a.continueAll();await f.a.tick();await settle();assert.equal(f.a.running.size,2);assert.deepEqual(f.calls.map(x=>x.id),['one','two']);
 await f.a.togglePaused();f.releases.one();await f.a.running.get('one').promise;await f.a.tick();assert.equal(f.calls.length,2);assert.ok(f.a.state.jobs.three.resumePending);await f.a.togglePaused();await f.a.tick();await settle();assert.equal(f.a.running.size,2);assert.deepEqual(f.calls.map(x=>x.id),['one','two','three']);f.releases.two();f.releases.three();await f.a.active;assert.equal(f.a.state.jobs.three.state,'awaiting_import');
});
test('repeated bulk clicks do not enqueue duplicate work and active papers occupy concurrency slots',async()=>{
 const f=fixture();f.add('one');f.add('two');const busy=f.add('running','running');f.a.running.set(busy.id,{job:busy,promise:Promise.resolve()});const [a,b]=await Promise.all([f.a.continueAll(),f.a.continueAll()]);assert.equal(a,b);assert.equal(a.queued,2);await f.a.tick();await settle();assert.equal(f.calls.length,1);assert.equal(f.a.running.size,2);f.releases.one();await f.a.running.get('one').promise;f.a.running.clear();
});
test('queued changes and an editor opened before dispatch prevent overwriting a retained draft',async()=>{
 const f=fixture();f.add('changed');f.add('editor');await f.a.continueAll();f.a.state.jobs.changed.edited=true;f.scope.ReaderCodex.state={editing:true,followJobID:'editor'};await f.a.tick();assert.equal(f.calls.length,0);assert.equal(f.a.state.jobs.changed.resumePending,undefined);assert.match(f.a.state.jobs.changed.message,/edited draft/);assert.equal(f.a.state.jobs.editor.resumePending,undefined);
});
test('stop cancels queued continuations and prevents intake from continuing after asynchronous preflight',async()=>{
 const f=fixture();f.add('queued');await f.a.continueAll();f.a.stopCurrent();assert.equal(f.a.state.jobs.queued.resumePending,undefined);assert.equal(f.a.state.jobs.queued.state,'cancelled');assert.equal(f.a.state.jobs.queued.cancelReason,'user-all');
 let release;f.a.checkResumeMarkdown=()=>new Promise(r=>release=r);const pending=f.a.continueAll();await settle();f.a.stopCurrent();release();assert.equal((await pending).queued,0);await f.a.tick();assert.equal(f.calls.length,0);
});
test('a queued continuation cannot be replaced by another batch enqueue or automatically restarted after shutdown',async()=>{
 const f=fixture(),job=f.add('1:ABCD1234','cancelled');job.libraryID=1;job.key='ABCD1234';await f.a.continueAll();assert.equal(B.decision(job,{skipProcessed:false}),'existing');assert.equal(B.progress([{id:job.id,attempt:job.attempt}],f.a.state.jobs).waiting,1);assert.equal(Q.enqueue(f.a.state,{libraryID:1,key:job.key},{trigger:'manual'}).created,false);await f.a.shutdown();assert.equal(job.resumePending,undefined);assert.equal(job.cancelReason,'shutdown');await f.a.tick();assert.equal(f.calls.length,0);
});

test('the unified toggle starts once, then aborts running work and holds queued continuations for the next start',async()=>{
 const f=fixture();for(const id of ['one','two','three'])f.add(id);f.a.state.jobs.two.state='needs_review';let aborted=0;
 f.a.createWorker=job=>{const controller={abort(){aborted++;f.releases[job.id]?.();}};return {job,codex:{controller,resumeVerification:async()=>{f.calls.push(job.id);await new Promise(r=>f.releases[job.id]=r);if(job.cancelRequested)throw N.error('CANCELLED','paused');}}};};
 assert.equal(f.a.queueActive(),false);await f.a.toggleRun();await f.a.tick();await settle();assert.equal(f.a.queueActive(),true);assert.equal(f.a.running.size,2);await f.a.toggleRun();assert.equal(aborted,2);assert.equal(f.a.state.paused,true);assert.equal(f.a.running.size,0);assert.equal(f.a.queueActive(),false);assert.equal(f.a.state.jobs.one.cancelReason,'user-pause');assert.ok(f.a.state.jobs.three.resumePending);await f.a.tick();assert.equal(f.calls.length,2);
 await f.a.toggleRun();assert.equal(f.a.state.paused,false);assert.ok(f.a.state.jobs.one.resumePending&&f.a.state.jobs.two.resumePending);assert.equal(f.a.state.jobs.two.resumePending.repair,true);assert.equal(f.a.state.jobs.three.resumePending.path,f.a.state.jobs.three.workflowPath);
});
test('pausing while start is preparing prevents any late worker from launching',async()=>{
 const f=fixture();f.add('one');let release;f.a.checkResumeMarkdown=()=>new Promise(r=>release=r);const start=f.a.toggleRun();await settle();const pause=f.a.toggleRun();assert.equal(f.a.state.paused,true);release();await Promise.all([start,pause]);assert.equal(f.a.state.jobs.one.resumePending,undefined);await f.a.tick();assert.equal(f.calls.length,0);
});
test('a user-paused generation without a complete draft restarts only on explicit Start and keeps its old path',async()=>{
 const f=fixture(),job=f.add('early','cancelled');job.pausedByControl=true;job.pauseRequested=true;job.hasReadingDraft=false;job.resumeAvailable=false;f.a.refreshResumeState=async()=>false;f.a.app.readJSON=async()=>({status:'generation_failed'});f.a.state.paused=true;
 await f.a.toggleRun();assert.equal(job.state,'waiting_file');assert.equal(job.workflowPath,'/readings/early/workflow.json');assert.equal(job.pauseRequested,undefined);assert.equal(f.calls.length,0);
});
test('the settings toolbar exposes one shared start-pause control and no separate continue-all button',()=>{
 const html=fs.readFileSync(require.resolve('../content/preferences.xhtml'),'utf8');assert.equal((html.match(/id="zri-auto-pause"/g)||[]).length,1);assert.ok(!html.includes('id="zri-auto-continue-all"')&&!html.includes('id="zri-auto-stop"'));
});
