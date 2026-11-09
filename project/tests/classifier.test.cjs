const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const N=require('../content/note-core.js');
async function fixture(){
 const collections=[{id:1,key:'SOURCE01',name:'Inbox'},{id:2,key:'TARGET01',name:'Target'},{id:3,key:'OTHER001',name:'Other'},{id:4,key:'EXTRA001',name:'Extra one'},{id:5,key:'EXTRA002',name:'Extra two'}].map(c=>({...c,libraryID:1,deleted:false})),members=new Set([1,3]),prefs={'test.classification.mode':'confirm'};let saves=0,calls=0;
 const parent={id:1,key:'PARENT01',libraryID:1,deleted:false,getField:()=> 'Synthetic title',isEditable:()=>true,inCollection:id=>members.has(id),addToCollection:id=>members.add(id),removeFromCollection:id=>members.delete(id),save:async()=>{saves++;}},note={id:2,key:'NOTE0001',libraryID:1,parentID:1,deleted:false,body:'<p>Checked synthetic note</p>',getNote(){return this.body;}},att={id:3,key:'PDF00001',parentID:1,libraryID:1};
 const items=[parent,note,att],scope={NoteCore:N,ReadingCore:require('../content/reading-core.js'),PathUtils:{join:path.join},SavedCore:{body:x=>x},ReaderEngines:{stage:()=>({engine:'codex',model:'synthetic-classifier',effort:''})},ReaderAutomation:{collectionKey:()=> 'SOURCE01',running:new Map(),state:{jobs:{'1:PDF00001':{state:'done',notes:{reading:{key:'NOTE0001'}}}}}},Zotero:{DataDirectory:{dir:'synthetic'},Libraries:{userLibraryID:1},Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v},Collections:{getByLibrary:()=>collections,get:id=>collections.find(c=>c.id===id),getByLibraryAndKeyAsync:async(_,key)=>collections.find(c=>c.key===key)},Items:{getAsync:async id=>items.find(i=>i.id===id),getByLibraryAndKeyAsync:async(_,key)=>items.find(i=>i.key===key)},DB:{executeTransaction:fn=>fn()}}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/classifier.js'),'utf8'),scope);const classifier=scope.ReaderClassifier;
 await classifier.init({pref:'test.',readJSON:async()=>null,writeJSON:async()=>{},sha256Text:async t=>'hash:'+t});
 const codex={invoke:async(prompt,ctx,signal,report,request)=>{calls++;assert.equal(request.model,'synthetic-classifier');assert.equal(ctx.stage,'classification');return {answer:JSON.stringify({collectionKey:'TARGET01',reason:'Synthetic fit'})};}};
 const suggest=(options={})=>classifier.suggest({id:'1:PDF00001',libraryID:1,key:'PDF00001',autoCollectionKey:'SOURCE01'},{status:options.noteStatus||'checked',notes:{reading:{key:'NOTE0001'}},archiveSuggestion:options.archiveSuggestion===undefined?{collectionKey:'TARGET01',reason:'Checked topic fit',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+note.body}:options.archiveSuggestion},codex,undefined,options);
 return {classifier,members,prefs,parent,note,suggest,scope,codex,saves:()=>saves,calls:()=>calls};
}
test('classification proposes without changing membership; explicit confirmation preserves other collections',async()=>{
 const f=await fixture();await f.suggest();assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);assert.equal(f.classifier.proposals['1:PARENT01'].status,'pending');await f.classifier.confirm('1:PARENT01','TARGET01');assert.deepEqual([...f.members].sort(),[1,2,3]);assert.equal(f.saves(),1);
});
test('disabled classification and dismiss never move an item',async()=>{const f=await fixture();f.prefs['test.classification.mode']='off';await f.suggest();assert.equal(f.calls(),0);f.prefs['test.classification.mode']='confirm';await f.suggest();await f.classifier.dismiss('1:PARENT01');assert.equal(f.saves(),0);assert.deepEqual([...f.members],[1,3]);});
test('human note edits and changed source membership block stale classification proposals',async()=>{
 for(const change of [f=>f.note.body+=' HUMAN EDIT',f=>f.members.delete(1)]){const f=await fixture();await f.suggest();change(f);await assert.rejects(f.classifier.confirm('1:PARENT01','TARGET01',{removeSource:true}),{code:'CLASSIFY_CHANGED'});assert.equal(f.saves(),0);assert.equal(f.members.has(2),false);}
});
test('unknown targets fail while manual additions can be outside the model suggestion root',async()=>{
 const f=await fixture();await f.suggest();await assert.rejects(f.classifier.confirm('1:PARENT01','MISSING1'),{code:'CLASSIFY_TARGET'});f.prefs['test.classification.rootKey']='MISSING1';await f.classifier.confirm('1:PARENT01','TARGET01');assert.equal(f.members.has(2),true);assert.equal(f.members.has(1),true);
});

test('unfinished or replacement reading runs cannot use an older archive proposal',async()=>{
 for(const state of ['queued','running','needs_review','verification_incomplete','failed','awaiting_import']){const f=await fixture();await f.suggest();f.scope.ReaderAutomation.state.jobs['1:PDF00001'].state=state;await assert.rejects(f.classifier.confirm('1:PARENT01','TARGET01'),{code:'CLASSIFY_UNFINISHED'});assert.equal(f.saves(),0);assert.equal(f.members.has(1),true);}
 const f=await fixture();await f.suggest();f.scope.ReaderAutomation.state.jobs['1:PDF00001'].notes.reading.key='NEWNOTE1';await assert.rejects(f.classifier.confirm('1:PARENT01','TARGET01'),{code:'CLASSIFY_UNFINISHED'});assert.equal(f.saves(),0);
});

test('one confirmation adds multiple selected categories and leaves the intake and other memberships intact',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',['TARGET01','EXTRA001','EXTRA002','EXTRA001']);assert.deepEqual([...f.members].sort(),[1,2,3,4,5]);assert.equal(f.saves(),1);
 const p=f.classifier.proposals['1:PARENT01'];assert.deepEqual(Array.from(p.confirmedTargetKeys),['TARGET01','EXTRA001','EXTRA002']);assert.equal(p.removedSource,false);assert.equal(p.targetKey,'TARGET01');
});
test('the user can reject the recommendation and choose only extra categories',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',['EXTRA001','EXTRA002']);assert.equal(f.members.has(2),false);assert.deepEqual([...f.members].sort(),[1,3,4,5]);
});
test('intake removal happens only when explicitly requested alongside selected destinations',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',['TARGET01','EXTRA001'],{removeSource:true});assert.deepEqual([...f.members].sort(),[2,3,4]);assert.equal(f.classifier.proposals['1:PARENT01'].approvedRemoveSource,true);
});
test('invalid multi-selection is rejected before any selected category is added',async()=>{
 const f=await fixture();await f.suggest();await assert.rejects(f.classifier.confirm('1:PARENT01',['EXTRA001','UNKNOWN1']),{code:'CLASSIFY_TARGET'});assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
});
test('adding categories does not require a paper to still be in the original intake collection',async()=>{
 const f=await fixture();await f.suggest();f.members.delete(1);await f.classifier.confirm('1:PARENT01',['EXTRA001']);assert.deepEqual([...f.members].sort(),[3,4]);
});
test('a human-confirmed saved manual note can be classified without being mislabeled as an unfinished task',async()=>{
 const f=await fixture();f.scope.ReaderAutomation.state.jobs['1:PDF00001'].state='imported';await f.suggest({noteStatus:'edited'});assert.equal(f.classifier.proposals['1:PARENT01'].noteStatus,'edited');await f.classifier.confirm('1:PARENT01',['EXTRA001']);assert.equal(f.members.has(4),true);
});

test('regenerating a same-note suggestion preserves manual extra selections',async()=>{
 const f=await fixture();await f.suggest();const p=f.classifier.proposals['1:PARENT01'];f.classifier.selections.set(p.id,{noteHash:p.noteHash,keys:new Set(['EXTRA001']),removeSource:false,search:'extra'});await f.suggest({force:true});assert.equal(f.calls(),1);assert.deepEqual([...f.classifier.selections.get(p.id).keys],['EXTRA001']);
});

test('opening a manual selection while an automatic suggestion is queued does not suppress the model suggestion',async()=>{
 const f=await fixture();await f.suggest();const p=f.classifier.proposals['1:PARENT01'];p.origin='manual';p.targetKey='';await f.suggest();assert.equal(f.calls(),0);assert.equal(f.classifier.proposals[p.id].origin,'review');assert.equal(f.classifier.proposals[p.id].targetKey,'TARGET01');
});

test('only the explicit boolean removal option can remove the intake membership',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',['EXTRA001'],{removeSource:'false'});assert.equal(f.members.has(1),true);assert.equal(f.classifier.proposals['1:PARENT01'].approvedRemoveSource,false);
});

function popupHost(f){let opened=0;f.scope.Zotero.getMainWindow=()=>({openDialog(){opened++;const win={closed:false,focus(){},close(){this.closed=true;f.classifier.unbindDialog(this);}};return win;}});return ()=>opened;}
test('automatic archive prompt waits for completed saved work and never stacks windows',async()=>{
 const f=await fixture(),opened=popupHost(f);f.scope.ReaderAutomation.running.set('1:PDF00001',{});await f.suggest();f.classifier.maybePrompt();assert.equal(opened(),0);
 f.scope.ReaderAutomation.running.clear();f.classifier.maybePrompt();const first=f.classifier.dialog;assert.equal(opened(),1);f.classifier.maybePrompt();await f.classifier.render();assert.equal(opened(),1);assert.equal(f.classifier.dialog,first);
});
test('closing the archive window defers ready proposals without changing categories or immediately reopening',async()=>{
 const f=await fixture(),opened=popupHost(f);await f.suggest();f.classifier.maybePrompt();assert.equal(opened(),1);f.classifier.dialog.close();await f.classifier.io;await f.classifier.render();assert.equal(opened(),1);assert.equal(f.classifier.proposals['1:PARENT01'].status,'pending');assert.equal(f.classifier.proposals['1:PARENT01'].autoPrompt,false);assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
 f.classifier.showDialog('1:PARENT01',{manual:true});assert.equal(opened(),2);
});
test('confirming the current paper advances to the next ready proposal in the same window',async()=>{
 const f=await fixture(),opened=popupHost(f);await f.suggest();f.classifier.maybePrompt();const win=f.classifier.dialog;
 f.scope.ReaderAutomation.state.jobs['1:PDF00002']={state:'done',notes:{reading:{key:'NOTE0002'}}};f.classifier.proposals.second={id:'second',status:'pending',autoPrompt:true,jobID:'1:PDF00002',noteKey:'NOTE0002',createdAt:new Date().toISOString()};
 f.classifier.maybePrompt();assert.equal(f.classifier.currentID,'1:PARENT01');await f.classifier.confirm('1:PARENT01',['TARGET01']);assert.equal(opened(),1);assert.equal(f.classifier.dialog,win);assert.equal(f.classifier.currentID,'second');
});
test('a confirmation from an obsolete dialog cannot act on a replacement note or source',async()=>{
 const f=await fixture();await f.suggest();const p=f.classifier.proposals['1:PARENT01'];await assert.rejects(f.classifier.confirm(p.id,['TARGET01'],{expectedNoteHash:'old hash',expectedSourceKey:p.sourceKey}),{code:'CLASSIFY_CHANGED'});await assert.rejects(f.classifier.confirm(p.id,['TARGET01'],{expectedNoteHash:p.noteHash,expectedSourceKey:'OTHERSRC'}),{code:'CLASSIFY_CHANGED'});assert.equal(f.saves(),0);
});

test('a suggestion finishing after the user deferred the same note does not reopen its dialog',async()=>{
 const f=await fixture(),opened=popupHost(f);await f.suggest();f.classifier.maybePrompt();f.classifier.dialog.close();
 const p=f.classifier.proposals['1:PARENT01'];p.origin='manual';p.targetKey='';let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r),original=f.codex.invoke;
 f.codex.invoke=async(...args)=>{started();await gate;return original(...args);};const pending=f.suggest({force:true});await began;f.classifier.deferAll();const before=opened();release();await pending;await f.classifier.render();assert.equal(opened(),before);assert.equal(f.classifier.proposals[p.id].autoPrompt,false);assert.ok(f.classifier.proposals[p.id].deferredAt);
});

test('automatic suggestions reuse checked review with zero additional model requests',async()=>{
 const f=await fixture();await f.suggest();assert.equal(f.calls(),0);assert.equal(f.classifier.proposals['1:PARENT01'].origin,'review');assert.equal(f.classifier.proposals['1:PARENT01'].targetKey,'TARGET01');
});
test('missing or manually edited review keeps manual selection without an automatic model call',async()=>{
 for(const options of [{archiveSuggestion:null},{noteStatus:'edited'}]){const f=await fixture();await f.suggest(options);assert.equal(f.calls(),0);assert.equal(f.classifier.proposals['1:PARENT01'].targetKey,'');assert.equal(f.classifier.proposals['1:PARENT01'].origin,'manual');}
});
test('changed saved note, source, scope, or target cannot reuse a review suggestion',async()=>{
 for(const change of [{noteHash:'old hash'},{noteKey:'OLDNOTE1'},{sourceKey:'OLDSRC01'},{rootKey:'old root'},{collectionKey:'DELETED1'}]){const f=await fixture();await f.suggest({archiveSuggestion:{collectionKey:'TARGET01',reason:'Test',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body,...change}});assert.equal(f.calls(),0);assert.equal(f.classifier.proposals['1:PARENT01'].targetKey,'');}
});
test('an explicitly requested new suggestion uses the checker settings',async()=>{
 const f=await fixture();let stage;f.scope.ReaderEngines.stage=which=>{stage=which;return {model:'synthetic-classifier'};};await f.suggest({force:true});assert.equal(stage,'verification');assert.equal(f.calls(),1);
});


test('a completed saved note can finish with existing categories and no item write',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',[]);assert.equal(f.classifier.proposals['1:PARENT01'].status,'confirmed');assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
});
test('intake-only removal needs no new category when another membership already exists',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',[],{removeSource:true});assert.deepEqual([...f.members],[3]);assert.equal(f.saves(),1);
});
test('empty completion still checks note identity and rejects a human edit',async()=>{
 const f=await fixture();await f.suggest();f.note.body+=' HUMAN';await assert.rejects(f.classifier.confirm('1:PARENT01',[]),{code:'CLASSIFY_CHANGED'});assert.equal(f.saves(),0);
});
test('removing the last membership without a destination is rejected before mutation',async()=>{
 const f=await fixture();f.members.delete(3);await f.suggest();await assert.rejects(f.classifier.confirm('1:PARENT01',[],{removeSource:true}),{code:'CLASSIFY_TARGET'});assert.deepEqual([...f.members],[1]);assert.equal(f.saves(),0);
});
test('only explicitly selected old memberships are removed together with chosen additions',async()=>{
 const f=await fixture();await f.suggest();await f.classifier.confirm('1:PARENT01',['TARGET01'],{removeKeys:['OTHER001'],removeSource:true});assert.deepEqual([...f.members],[2]);assert.deepEqual(Array.from(f.classifier.proposals['1:PARENT01'].confirmedRemovedKeys),['OTHER001']);
});
test('conflicting or stale removal selections reject every planned change',async()=>{
 for(const options of [{removeKeys:['TARGET01']},{removeKeys:['MISSING1']},{removeKeys:['SOURCE01']}]){const f=await fixture();await f.suggest();await assert.rejects(f.classifier.confirm('1:PARENT01',['TARGET01'],options),{code:'CLASSIFY_TARGET'});assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);}
 const f=await fixture();await f.suggest();f.members.delete(3);await assert.rejects(f.classifier.confirm('1:PARENT01',['TARGET01'],{removeKeys:['OTHER001']}),{code:'CLASSIFY_CHANGED'});assert.equal(f.members.has(2),false);
});
test('multiple checked suggestions and proposed removals remain advisory until individually confirmed',async()=>{
 const f=await fixture();await f.suggest({archiveSuggestion:{recommendations:['TARGET01','EXTRA001','EXTRA002'].map(collectionKey=>({collectionKey,reason:'Relevant dimension'})),adjustments:[{collectionKey:'OTHER001',reason:'Synthetic mismatch'}],reason:'Synthetic review',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body}});const p=f.classifier.proposals['1:PARENT01'];assert.equal(p.recommendations.length,3);assert.equal(p.adjustments.length,1);assert.equal(f.calls(),0);assert.deepEqual([...f.members],[1,3]);await f.classifier.confirm(p.id,['EXTRA001']);assert.deepEqual([...f.members],[1,3,4]);
});
test('review context includes current memberships even outside the suggestion scope',async()=>{
 const f=await fixture();const c=await f.classifier.reviewContext({source:{libraryID:1,key:'PDF00001'}});assert.ok(c.currentCollections.some(x=>x.key==='OTHER001'));assert.ok(c.collections.find(x=>x.key==='OTHER001').current);assert.ok(!c.currentCollections.some(x=>x.key==='SOURCE01'));
});


test('automatic mode files an unclassified new paper without a confirmation',async()=>{
 const f=await fixture();f.members.delete(3);f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.deepEqual([...f.members],[2]);assert.equal(p.approvalMode,'automatic');assert.equal(p.status,'confirmed');assert.equal(f.calls(),0);
});
test('automatic archiving keeps the saved note and membership when no reliable recommendations exist',async()=>{
 for(const options of [{archiveSuggestion:null},{archiveSuggestion:{recommendations:[],adjustments:[],reason:'No fit',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:<p>Checked synthetic note</p>'}},{noteStatus:'edited'}]){const f=await fixture();f.prefs['test.classification.mode']='auto';await f.suggest(options);const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await assert.rejects(f.classifier.autoArchive(job,p,worker),{code:'CLASSIFY_AUTO'});assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);assert.equal(p.autoPrompt,false);}
});
test('mode changes, cancellation and unrelated workers cannot authorize an automatic mutation',async()=>{
 for(const change of [(f,j,w)=>f.prefs['test.classification.mode']='off',(f,j,w)=>j.cancelRequested=true,(f,j,w)=>f.scope.ReaderAutomation.running.set('1:PDF00001',{job:j})]){const f=await fixture();f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);change(f,job,worker);await assert.rejects(f.classifier.autoArchive(job,p,worker),{code:'CLASSIFY_MODE'});assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);}
});
test('automatic mode does not replay old proposals merely on rendering or opening settings',async()=>{
 const f=await fixture(),opened=popupHost(f);delete f.prefs['test.classification.mode'];assert.equal(f.classifier.mode(),'auto');await f.suggest({archiveSuggestion:null});await f.classifier.render();f.classifier.maybePrompt();assert.equal(opened(),0);assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
});
test('auto archive still rejects a note changed since recommendation',async()=>{
 const f=await fixture();f.members.delete(3);f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);f.note.body+=' Human edit';await assert.rejects(f.classifier.autoArchive(job,p,worker),{code:'CLASSIFY_CHANGED'});assert.deepEqual([...f.members],[1]);assert.equal(f.saves(),0);
});

test('an invalid explicit archive mode does not enable automatic library mutations',async()=>{const f=await fixture();f.prefs['test.classification.mode']='invalid';assert.equal(f.classifier.mode(),'off');assert.equal(f.classifier.enabled(),false);});

test('existing memberships turn new-category recommendations into confirmation even in automatic mode',async()=>{
 const f=await fixture(),opened=popupHost(f);f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'];assert.equal(p.requiresReview,true);assert.equal(p.autoEligible,false);assert.equal(opened(),1);assert.deepEqual([...f.members],[1,3]);assert.equal(f.calls(),0);
 const job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.equal(p.status,'pending');assert.equal(f.saves(),0);f.scope.ReaderAutomation.running.clear();await f.classifier.confirm(p.id,['TARGET01']);assert.deepEqual([...f.members].sort(),[1,2,3]);
});
test('a removal-only suggestion is presented with a reason and only an explicit selection removes the old category',async()=>{
 const f=await fixture();f.members.add(4);f.prefs['test.classification.mode']='auto';await f.suggest({archiveSuggestion:{recommendations:[],adjustments:[{collectionKey:'OTHER001',reason:'Current reading contradicts this category'}],reason:'Review old classification',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body}});const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.equal(p.requiresReview,true);assert.deepEqual([...f.members].sort(),[1,3,4]);f.scope.ReaderAutomation.running.clear();await f.classifier.confirm(p.id,[],{removeKeys:['OTHER001']});assert.deepEqual([...f.members].sort(),[1,4]);assert.equal(p.approvalMode,'manual');
});
test('agreeing with existing categories does not prompt or reassign the paper',async()=>{
 const f=await fixture(),opened=popupHost(f);f.members.delete(1);f.prefs['test.classification.mode']='auto';await f.suggest({archiveSuggestion:{collectionKey:'OTHER001',reason:'Existing category fits',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body}});const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.equal(p.requiresReview,false);assert.equal(p.status,'confirmed');assert.equal(opened(),0);assert.equal(f.saves(),0);assert.deepEqual([...f.members],[3]);
});
test('a category added during the automatic transaction redirects to review before any mutation',async()=>{
 const f=await fixture();f.members.delete(3);f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);f.scope.Zotero.DB.executeTransaction=async fn=>{f.members.add(3);return fn();};await f.classifier.autoArchive(job,p,worker);assert.equal(p.requiresReview,true);assert.equal(p.status,'pending');assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
});
test('Later defers an existing-category review without moving anything or reopening it',async()=>{
 const f=await fixture(),opened=popupHost(f);f.prefs['test.classification.mode']='auto';await f.suggest();const p=f.classifier.proposals['1:PARENT01'];assert.equal(opened(),1);await f.classifier.deferCurrent(p.id);await f.classifier.render();assert.equal(p.status,'pending');assert.ok(p.deferredAt);assert.equal(p.autoPrompt,false);assert.equal(opened(),1);assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);
});

test('one-click suggestion adoption adds and removes only proposed memberships and keeps other categories',async()=>{
 const f=await fixture();f.members.add(4);await f.suggest({archiveSuggestion:{recommendations:[{collectionKey:'TARGET01',reason:'Fits the reading'}],adjustments:[{collectionKey:'OTHER001',reason:'Does not fit'}],reason:'Synthetic review',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body}});await f.classifier.applySuggested('1:PARENT01');assert.deepEqual([...f.members].sort(),[1,2,4]);assert.equal(f.classifier.proposals['1:PARENT01'].approvalMode,'suggested');assert.equal(f.calls(),0);
});
test('one-click suggestions retain the same stale-note and missing-target protection as manual confirmation',async()=>{
 const f=await fixture();await f.suggest();f.note.body+=' HUMAN EDIT';await assert.rejects(f.classifier.applySuggested('1:PARENT01'),{code:'CLASSIFY_CHANGED'});assert.equal(f.saves(),0);assert.deepEqual([...f.members],[1,3]);
});

async function restartConfirming(f,{applied=false,edited=false,missingPlan=false,failPersist=false}={}){
 f.parent.isRegularItem=()=>true;f.note.isNote=()=>true;await f.suggest();const p=f.classifier.proposals['1:PARENT01'];Object.assign(p,{status:'confirming',approvedAt:'2026-11-09T00:00:00Z',approvedTargetKeys:['TARGET01'],approvedRemovedKeys:['OTHER001'],approvedRemoveSource:true});
 if(applied){f.members.delete(1);f.members.delete(3);f.members.add(2);}if(edited)f.note.body+=' human change';if(missingPlan)delete p.approvedRemovedKeys;const app=f.classifier.app;app.readJSON=async()=>({proposals:{[p.id]:p}});if(failPersist)app.writeJSON=async()=>{throw Error('Read only');};await f.classifier.init(app);return p;
}
test('restart verifies an already committed classification instead of applying it twice',async()=>{const f=await fixture(),p=await restartConfirming(f,{applied:true});assert.equal(p.status,'confirmed');assert.equal(p.recovery,'verified-applied');assert.equal(p.autoEligible,false);assert.equal(p.autoPrompt,false);assert.equal(f.saves(),0);assert.deepEqual([...f.members],[2]);assert.equal(f.classifier.recovered.size,1);});
test('restart makes an uncommitted, edited or incomplete confirmation reviewable without touching categories',async()=>{for(const options of [{},{applied:true,edited:true},{missingPlan:true}]){const f=await fixture(),p=await restartConfirming(f,options);assert.equal(p.status,'pending');assert.equal(p.lastError,'CONFIRM_INTERRUPTED');assert.equal(p.requiresReview,true);assert.equal(p.autoEligible,false);assert.equal(p.autoPrompt,false);assert.equal(f.saves(),0);assert.equal(f.calls(),0);if(options.edited)assert.equal(p.noteStatus,'edited');}});
test('a recovery journal write failure leaves recovered state visible instead of breaking plugin startup',async()=>{const f=await fixture();const p=await restartConfirming(f,{failPersist:true});assert.equal(p.status,'pending');assert.match(f.classifier.recoveryWarning,/未写入/);assert.equal(f.saves(),0);});
const adjustedSuggestion=f=>({recommendations:[{collectionKey:'TARGET01',reason:'Fits current reading'}],adjustments:[{collectionKey:'OTHER001',reason:'Unrelated to current reading'}],reason:'Synthetic classification',sourceKey:'SOURCE01',rootKey:'',noteKey:'NOTE0001',noteHash:'hash:'+f.note.body});
test('explicit automatic suggestions apply only recommended additions and removals while retaining other categories',async()=>{const f=await fixture();f.members.add(4);f.prefs['test.classification.mode']='auto-adjust';await f.suggest({archiveSuggestion:adjustedSuggestion(f)});const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.deepEqual([...f.members].sort(),[2,4]);assert.equal(p.approvalMode,'automatic-suggestions');assert.equal(f.calls(),0);});
test('enabling automatic suggestions does not replay old pending proposals',async()=>{const f=await fixture();f.prefs['test.classification.mode']='auto';await f.suggest({archiveSuggestion:adjustedSuggestion(f)});f.prefs['test.classification.mode']='auto-adjust';const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);await f.classifier.autoArchive(job,p,worker);assert.equal(p.status,'pending');assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);});
test('the future-auto checkbox changes preference only after current confirmation succeeds',async()=>{for(const fail of [false,true]){const f=await fixture();await f.suggest({archiveSuggestion:adjustedSuggestion(f)});if(fail)f.note.body+=' human edit';if(fail)await assert.rejects(f.classifier.applySuggested('1:PARENT01',{autoNext:true}),{code:'CLASSIFY_CHANGED'});else await f.classifier.applySuggested('1:PARENT01',{autoNext:true});assert.equal(f.classifier.mode(),fail?'confirm':'auto-adjust');}});
test('automatic suggestion mode rechecks its authorization and refuses to leave a paper with zero categories',async()=>{for(const modeChange of [false,true]){const f=await fixture();f.prefs['test.classification.mode']='auto-adjust';const suggestion=adjustedSuggestion(f);suggestion.recommendations=[];await f.suggest({archiveSuggestion:suggestion});const p=f.classifier.proposals['1:PARENT01'],job=f.scope.ReaderAutomation.state.jobs[p.jobID],worker={job};f.scope.ReaderAutomation.running.set(p.jobID,worker);if(modeChange)f.scope.Zotero.DB.executeTransaction=async fn=>{f.prefs['test.classification.mode']='off';return fn();};await assert.rejects(f.classifier.autoArchive(job,p,worker));assert.deepEqual([...f.members],[1,3]);assert.equal(f.saves(),0);}});

test('standalone archive updates inherit the configured invocation timeout and do not change categories on timeout',async()=>{const f=await fixture();let request;f.codex.invoke=async(prompt,context,signal,report,r)=>{request=r;const e=new Error('Synthetic timeout');e.code='TIMEOUT';throw e;};const before=[...f.members],body=f.note.getNote();await assert.rejects(f.suggest({force:true}),{code:'TIMEOUT'});assert.equal(Object.hasOwn(request,'timeoutMs'),false);assert.equal(request.model,'synthetic-classifier');assert.deepEqual([...f.members],before);assert.equal(f.note.getNote(),body);assert.equal(f.saves(),0);});
