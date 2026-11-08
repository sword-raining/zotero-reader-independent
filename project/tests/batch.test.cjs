const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const B=require('../content/batch-core.js');
test('mixed selections deduplicate by library and attachment key without merging separate records',()=>{
 const a={libraryID:1,key:'ABCD1234'},b={libraryID:1,key:'EFGH5678'},c={libraryID:2,key:'ABCD1234'};
 assert.deepEqual(B.unique([a,b,a,c,b]),[a,b,c]);
});
test('queued and running PDFs are reused regardless of the skip-completed setting',()=>{
 for(const state of ['waiting_file','queued','running'])for(const skipProcessed of [true,false])assert.equal(B.decision({state},{skipProcessed}),'existing');
});
test('completed work is skipped only when the current PDF matches its source snapshot',()=>{
 for(const state of ['done','needs_review','verification_incomplete']){
  assert.equal(B.decision({state},{skipProcessed:true,sourceMatches:true}),'skip');
  assert.equal(B.decision({state},{skipProcessed:true,sourceMatches:false}),'enqueue');
  assert.equal(B.decision({state},{skipProcessed:false,sourceMatches:true}),'enqueue');
 }
});
test('failed, cancelled and unseen PDFs can be explicitly added again',()=>{
 for(const state of ['failed','cancelled'])assert.equal(B.decision({state},{skipProcessed:true,sourceMatches:true}),'enqueue');
 assert.equal(B.decision(null),'enqueue');
});
test('batch progress includes failures, waiting files, reviews and cancellation',()=>{
 const states=['waiting_file','queued','running','done','needs_review','verification_incomplete','failed','cancelled'];
 const members=states.map((_,i)=>({id:String(i),attempt:1}));
 const jobs=Object.fromEntries(states.map((state,i)=>[String(i),{state,attempt:1}]));
 assert.deepEqual(B.progress(members,jobs),{waiting:2,running:1,done:1,imported:0,needs_review:1,verification_incomplete:1,awaiting_import:0,failed:1,cancelled:1,replaced:0});
});
test('a later re-run does not change an earlier completed batch into running',()=>{
 const members=[{id:'x',attempt:1}];B.progress(members,{x:{attempt:1,state:'done'}});
 assert.equal(B.progress(members,{x:{attempt:2,state:'running'}}).done,1);
 assert.equal(B.progress([{id:'y',attempt:1}],{y:{attempt:2,state:'queued'}}).replaced,1);
});
test('batch UI provides template, selection, skip-completed and batch stop controls',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../content/batch.xhtml'),'utf8');
 for(const id of ['zrb-template','zrb-list','zrb-skip','zrb-start','zrb-stop','zrb-pause'])assert.ok(html.includes(id));
 assert.ok(html.includes('不需要开启自动精读'));
});


test('batch language filter recognizes Zotero Chinese codes and names, including mixed declarations',()=>{
 for(const value of ['zh','zh-CN','ZH_tw','zh-Hans-CN','zho','chi','cmn','Chinese','Chinese (Simplified)','Traditional Chinese','中文','简体中文','漢語','中文（繁体）'])assert.equal(B.languageInfo(value).chinese,true,value);
 assert.equal(B.languageInfo('en;zh-CN').chinese,true);assert.equal(B.languageInfo('English / 中文').label,'多语言（含中文）');
});
test('English and unknown metadata are not mistaken for Chinese',()=>{
 for(const value of ['en','EN_us','en-GB','eng','English','English (United States)','英文'])assert.equal(B.languageInfo(value).kind,'en',value);
 for(const value of ['',null,'fr','ja','ch','unknown'])assert.equal(B.languageInfo(value).chinese,false,String(value));assert.equal(B.languageInfo('').label,'未标注');
});
test('language filtering uses the metadata value only, without inspecting translated titles or notes',()=>{
 const scope={BatchCore:B};require('node:vm').createContext(scope);require('node:vm').runInContext(fs.readFileSync(path.join(__dirname,'../content/batch-runtime.js'),'utf8'),scope);const batch=scope.ReaderBatch;
 assert.equal(batch.skipChinese,true);assert.equal(batch.excludedChinese({language:'en',display:'中文翻译标题',note:'中文手写笔记'}),false);assert.equal(batch.excludedChinese({language:'',display:'中文标题'}),false);assert.equal(batch.excludedChinese({language:'zh-CN'}),true);batch.skipChinese=false;assert.equal(batch.excludedChinese({language:'zh-CN'}),false);
});
