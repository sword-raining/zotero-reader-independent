const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const B=require('../content/batch-core.js'),Q=require('../content/queue-core.js'),N=require('../content/note-core.js');
function fixture(language='zh-CN'){
 let value=language,parsed=0;const parent={isRegularItem:()=>true,getField:k=>k==='language'?value:'Synthetic title'},att={libraryID:1,key:'PDF00001',id:10,parentID:1};const scope={BatchCore:B,QueueCore:Q,NoteCore:N,ReadingCore:{template:()=>{}},ReaderCleanup:{},ReaderCodex:{},ReaderAttachments:{attachments:async()=>{parsed++;},matches:async()=>false},ReaderSaved:{matching:async()=>null},Zotero:{Items:{getByLibraryAndKeyAsync:async()=>att,getAsync:async()=>parent},Utilities:{randomString:()=> 'abc123'}}};vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/automation.js'),'utf8'),scope);const auto=scope.ReaderAutomation;auto.app={safeError:e=>e.message};auto.notes={destination:async()=>({})};auto.persist=async()=>{};auto.refreshViews=()=>{};auto.schedule=()=>{};auto.enabled=()=>true;return {auto,att,scope,entry:{libraryID:1,key:att.key,language:'en',display:'Synthetic'},setLanguage:x=>value=x,validated:()=>parsed};
}
test('batch admission rechecks actual language and skips Chinese before attachment or saved-result work',async()=>{
 const f=fixture();const r=await f.auto.enqueueBatch([f.entry],'general');assert.equal(r.added,0);assert.equal(r.skippedChinese,1);assert.equal(r.languages['1:PDF00001'],'zh-CN');assert.equal(f.validated(),0);assert.equal(Object.keys(f.auto.state.jobs).length,0);
});
test('explicitly opting in permits Chinese while English and unmarked entries remain eligible',async()=>{
 for(const [language,skipChinese] of [['zh',false],['en',true],['',true]]){const f=fixture(language),r=await f.auto.enqueueBatch([f.entry],'general',{skipChinese});assert.equal(r.added,1);assert.equal(r.skippedChinese,0);assert.equal(r.members.length,1);assert.equal(f.auto.state.jobs['1:PDF00001'].skipChinese,skipChinese);}
});
test('excluding an already running Chinese paper does not stop or replace that task',async()=>{
 const f=fixture(),job={id:'1:PDF00001',state:'running',attempt:3};f.auto.state.jobs[job.id]=job;const r=await f.auto.enqueueBatch([f.entry],'general');assert.equal(r.skippedChinese,1);assert.equal(f.auto.state.jobs[job.id],job);assert.equal(job.state,'running');
});
