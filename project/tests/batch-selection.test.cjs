const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 let queued=0,submitted;const scope={BatchCore:require('../content/batch-core.js'),AttachmentCore:require('../content/attachment-core.js'),NoteCore:require('../content/note-core.js'),ReaderAutomation:{enqueueBatch:async entries=>{queued++;submitted=entries;return {members:[],outcomes:{},added:entries.length,existing:0,skipped:0,rejected:[],noteKeys:{},languages:{}};}}};vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../content/batch-runtime.js'),'utf8'),scope);const b=scope.ReaderBatch;b.app={safeError:e=>e.message};b.render=()=>{};b.buildList=()=>{};
 const entry=(id,patch={})=>({id,groupID:id,display:id,libraryID:1,selected:true,language:'en',issue:'',mainKey:id,supplementKeys:[],pdfs:[{key:id}],...patch});return {b,entry,queued:()=>queued,submitted:()=>submitted};
}
test('main-selection blockers include only selected eligible papers and validate the chosen PDF',()=>{
 const {b,entry}=fixture();b.entries=[entry('READY001'),entry('MISSING1',{mainKey:null}),entry('UNSEL001',{mainKey:null,selected:false}),entry('CHINESE1',{language:'zh-CN',mainKey:null}),entry('INVALID1',{mainKey:'UNKNOWN1'}),entry('DUPLIC01',{pdfs:[{key:'DUPLIC01',duplicateOf:'OTHER001'}]})];assert.deepEqual(Array.from(b.pendingMain(),x=>x.id),['MISSING1','INVALID1','DUPLIC01']);
});
test('clicking Start with an unresolved paper locates its radio button and never enqueues a partial batch',async()=>{
 const f=fixture(),e=f.entry('MISSING1',{mainKey:null});f.b.entries=[f.entry('READY001'),e];let focus=0,scroll=0;f.b.rows.set(e,{querySelector:()=>({focus(){focus++;},scrollIntoView(){scroll++;}})});await f.b.start();assert.equal(focus,1);assert.equal(scroll,1);assert.equal(f.queued(),0);assert.equal(f.b.submitting,false);assert.match(f.b.message,/MISSING1/);
});
test('after choosing a main PDF or excluding the unresolved paper, all remaining selected papers are submitted',async()=>{
 for(const exclude of [false,true]){const f=fixture(),e=f.entry('SECOND01',{mainKey:null});f.b.entries=[f.entry('READY001'),e];if(exclude)e.selected=false;else e.mainKey='SECOND01';await f.b.start();assert.equal(f.queued(),1);assert.equal(f.submitted().length,exclude?1:2);assert.equal(f.submitted()[0].inputSelection.mainKey,'READY001');assert.equal(f.b.submitted,true);}
});
