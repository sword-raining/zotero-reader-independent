const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const Q=require('../content/queue-core.js'),A=require('../content/attachment-core.js'),N=require('../content/note-core.js');
function fixture(){
 const prefs={'test.auto.enabled':true,'test.auto.collectionKey':'TARGET01'},items=new Map(),collections=new Map(),writes=[];
 const addCollection=(id,key)=>{const c={id,key,libraryID:1,deleted:false};collections.set(key,c);return c;};addCollection(10,'TARGET01');addCollection(20,'SIBLING1');addCollection(30,'CHILD001');
 const add=(id,key,{parentID=null,isPDF=false,synced=false,members=[],title='Main paper'}={})=>{const item={id,key,parentID,libraryID:1,synced,deleted:false,attachmentFilename:'paper.pdf',getField:()=>title,isPDFAttachment:()=>isPDF,isRegularItem:()=>!isPDF,inCollection:n=>members.includes(n),getAttachments:()=>[...items.values()].filter(x=>x.parentID===id).map(x=>x.id),members};items.set(id,item);return item;};
 const scope={QueueCore:Q,AttachmentCore:A,NoteCore:N,PathUtils:{join:path.join,parent:path.dirname},ReaderTimers:{setTimeout:()=>1,clearTimeout(){}},ReaderCodex:{controller:{abort(){}}},
 IOUtils:{makeDirectory:async()=>{}},Zotero:{DataDirectory:{dir:'synthetic-data'},Libraries:{userLibraryID:1},Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v},Items:{getAsync:async id=>items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...items.values()].find(i=>i.libraryID===lib&&i.key===key)},Collections:{getByLibraryAndKeyAsync:async(lib,key)=>collections.get(key)}}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/automation.js'),'utf8'),scope);
 const auto=scope.ReaderAutomation;auto.app={pref:'test.',writeJSON:async(p,v)=>writes.push(v),safeError:e=>e.message};auto.started=true;auto.state.paused=true;auto.epoch=1;
 return {auto,prefs,items,collections,add,scope,writes};
}
test('moving an existing paper into the watched collection captures its already-synced PDF once',async()=>{
 const f=fixture(),p=f.add(1,'PARENT01',{members:[10]}),a=f.add(2,'PDF00001',{parentID:1,isPDF:true,synced:true});
 await f.auto.captureCollection(['10-1'],{},1);await f.auto.captureCollection(['10-1'],{},1);
 assert.equal(Object.keys(f.auto.state.jobs).length,1);assert.equal(f.auto.state.jobs['1:PDF00001'].autoCollectionKey,'TARGET01');assert.equal(f.auto.state.jobs['1:PDF00001'].skipSaved,true);
});
test('collection scope excludes siblings, descendants and standalone files outside the selected collection',async()=>{
 const f=fixture();for(const [i,collection] of [[1,20],[3,30]]){f.add(i,'PARENT0'+i,{members:[collection]});f.add(i+1,'PDF0000'+i,{parentID:i,isPDF:true});await f.auto.capture([i+1],{},1);await f.auto.captureCollection([collection+'-'+i],{},1);}
 f.add(5,'PDF00005',{isPDF:true});await f.auto.capture([5],{},1);assert.equal(Object.keys(f.auto.state.jobs).length,0);
});
test('a PDF added after its parent entered the collection is captured but membership sync is ignored',async()=>{
 const f=fixture(),p=f.add(1,'PARENT01',{members:[10]});await f.auto.captureCollection(['10-1'],{},1);assert.equal(Object.keys(f.auto.state.jobs).length,0);
 f.add(2,'PDF00001',{parentID:1,isPDF:true});await f.auto.capture([2],{},1);assert.ok(f.auto.state.jobs['1:PDF00001']);
 const synced=f.add(3,'PARENT02',{members:[10],synced:true});f.add(4,'PDF00002',{parentID:3,isPDF:true,synced:true});await f.auto.captureCollection(['10-3'],{},1);assert.equal(f.auto.state.jobs['1:PDF00002'],undefined);
});
test('changing selected collection cancels pending automatic jobs without touching manual jobs or scanning old papers',async()=>{
 const f=fixture();f.add(1,'PDF00001',{isPDF:true,members:[10]});await f.auto.capture([1],{},1);f.auto.state.jobs.manual={trigger:'manual',state:'waiting_file'};
 f.add(2,'PDF00002',{isPDF:true,members:[20]});await f.auto.setCollection('SIBLING1');assert.equal(f.auto.state.jobs['1:PDF00001'].state,'cancelled');assert.equal(f.auto.state.jobs.manual.state,'waiting_file');assert.equal(f.auto.state.jobs['1:PDF00002'],undefined);
});
test('leaving collection cancels pending work; re-entry may retry only untouched scope-cancelled work',async()=>{
 const f=fixture(),p=f.add(1,'PARENT01',{members:[10]});f.add(2,'PDF00001',{parentID:1,isPDF:true});await f.auto.captureCollection(['10-1'],{},1);
 p.members.splice(0);await f.auto.reconcileScope();assert.equal(f.auto.state.jobs['1:PDF00001'].state,'cancelled');p.members.push(10);await f.auto.captureCollection(['10-1'],{},1);assert.equal(f.auto.state.jobs['1:PDF00001'].attempt,2);
 f.auto.state.jobs['1:PDF00001'].state='done';await f.auto.captureCollection(['10-1'],{},1);assert.equal(f.auto.state.jobs['1:PDF00001'].attempt,2);
 const j=f.auto.state.jobs['1:PDF00001'];j.state='cancelled';j.scopeCancelled=true;j.workflowPath='retained-draft';await f.auto.captureCollection(['10-1'],{},1);assert.equal(j.workflowPath,'retained-draft');assert.equal(j.attempt,2);
});
test('deleted watched collection fails closed without falling back to all PDFs',async()=>{
 const f=fixture();f.collections.get('TARGET01').deleted=true;f.add(1,'PDF00001',{isPDF:true,members:[10]});await f.auto.capture([1],{},1);assert.equal(Object.keys(f.auto.state.jobs).length,0);await assert.rejects(f.auto.setCollection('TARGET01'),{code:'AUTO_COLLECTION'});
});
test('scope-change race cannot enqueue from an obsolete notification',async()=>{
 const f=fixture();f.add(1,'PDF00001',{isPDF:true,members:[10]});f.auto.inScope=async()=>{f.auto.epoch++;return true;};await f.auto.capture([1],{},1);assert.equal(Object.keys(f.auto.state.jobs).length,0);
});
