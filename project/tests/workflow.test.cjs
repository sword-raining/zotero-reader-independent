const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const W=require('../content/workflow-core.js'),R=require('../content/reading-core.js'),M=require('../content/core.js'),Q=require('../content/queue-core.js'),N=require('../content/note-core.js'),C=require('../content/codex-core.js');
const text='Synthetic research reports twenty four independent field sites.',paper=R.paper(text),evidence=[{paragraph_id:'P0001',quote:text}];
const draft=()=>({articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:'研究报告二十四个独立样地。',kind:key==='publication'?'interpretation':'reported',evidence}]}))});
const ids=d=>R.claimSections(d).flatMap(s=>s.entries.map(e=>e.id));
const review=d=>({mode:'full-review',checked_ids:ids(d),issues:[],notes:'Complete source comparison; no inconsistency found.'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('bilingual default uses the documented Chinese/English pack and keeps English-only override',()=>{
 assert.equal(M.settings().language,'auto');assert.equal(M.settingsKey({language:'auto'}),M.settingsKey({language:'ch'}));assert.notEqual(M.settingsKey({language:'auto'}),M.settingsKey({language:'en'}));
});
test('automatic language sends ch, never an unsupported auto API value',async()=>{
 let payload;const client=new M.Client({request:async(url,opts)=>{payload=JSON.parse(opts.body);throw M.error('STOP','test stop');},sleep:async()=>{}});
 await assert.rejects(client.parse({key:'synthetic-token',file:null,source:{size:10,key:'PDF00001',libraryID:1,name:'synthetic.pdf'},options:{language:'auto'}}),{code:'STOP'});assert.equal(payload.language,'ch');
});
test('workflow limits are bounded and permit zero repairs',()=>{assert.deepEqual(W.limits({papers:99,checks:99,repairs:99}),{papers:4,checks:1,repairs:5});assert.equal(W.limits({repairs:0}).repairs,0);});
test('full review grouping covers every section and bibliography claim exactly once',()=>{
 const d=draft(),g=W.reviewGroups(d,3);assert.equal(g.length,3);assert.deepEqual(g.flatMap(ids).sort(),ids(d).sort());const merged=W.mergeReviews(d,g,g.map(review));assert.equal(R.assess(d,R.parseReview(JSON.stringify(merged)),paper).status,'checked');
});
test('missing, duplicate, foreign or mixed review coverage never passes',()=>{
 const d=draft(),g=W.reviewGroups(d,2),good=g.map(review);
 for(const change of [r=>r.checked_ids.pop(),r=>r.checked_ids.push(r.checked_ids[0]),r=>r.checked_ids[0]='foreign']){const r=JSON.parse(JSON.stringify(good));change(r[0]);assert.throws(()=>W.mergeReviews(d,g,r));}
 const r=JSON.parse(JSON.stringify(good));r[0].issues.push({entry_id:'foreign'});assert.throws(()=>W.mergeReviews(d,g,r));
});
test('compact complete-review output retains fact and quote checks without routine approval paragraphs',()=>{
 const d=draft(),r=review(d);assert.equal(R.assess(d,r,paper).status,'checked');r.issues=[{entry_id:'results',verdict:'contradicted',reason:'Direction was reversed',evidence}];assert.equal(R.assess(d,r,paper).status,'needs_review');
 r.issues=[];d.sections[0].entries[0].evidence=[{paragraph_id:'P0001',quote:'fabricated source text'}];assert.equal(R.assess(d,r,paper).status,'needs_review');
});
test('complete source-paragraph evidence is accepted without truncation and longer quotes still fail structure validation',()=>{
 const quote='a'.repeat(1800),r={checks:[{entry_id:'x',verdict:'supported',numeric_detail:'acceptable',reason:'Full paragraph',evidence:[{paragraph_id:'P0001',quote}]}],omissions:[],notes:''};
 assert.doesNotThrow(()=>R.parseReview(JSON.stringify(r)));assert.deepEqual(R.evidenceIssues(r.checks[0].evidence,R.paper(quote),true),[]);r.checks[0].evidence[0].quote+='a';assert.throws(()=>R.parseReview(JSON.stringify(r)),{code:'STRUCTURE'});
});
test('parallel verifier respects its limit and retains result ordering',async()=>{let active=0,peak=0;const result=await W.parallelMap([3,2,1,0],2,async n=>{peak=Math.max(peak,++active);await wait(n*2+1);active--;return n;});assert.equal(peak,2);assert.deepEqual(result,[3,2,1,0]);});
test('one verifier failure aborts its sibling and awaits cleanup before rejecting',async()=>{let stopped=false;await assert.rejects(W.parallelMap([0,1],2,async(n,i,signal)=>{if(!n){await wait(5);throw Error('bad response');}await new Promise(r=>signal.addEventListener('abort',()=>{stopped=true;r();},{once:true}));}),/bad response/);assert.equal(stopped,true);});
test('the checked brief preserves a complete supported finding and never invents a summary',()=>{const d=draft(),a=R.assess(d,review(d),paper);assert.equal(W.brief(d,a),d.sections.find(s=>s.key==='results').entries[0].text);a.checks.find(c=>c.entry_id==='results').passed=false;assert.equal(W.brief(d,a),'');});
function scheduler(){
 const scope={QueueCore:Q,CodexCore:C,NoteCore:N,ReaderPreferences:{workflow:()=>({papers:2,checks:2,repairs:2})},ReaderCleanup:{active:null},ReaderNotes:{pending:0},ReaderCodex:{state:{},active:null},ReaderAttachments:{attachments:async a=>[a]},ReaderTimers:{setTimeout:()=>1,clearTimeout(){}},AbortController,
  IOUtils:{exists:async()=>true,stat:async()=>({size:10,lastModified:1}),makeDirectory:async()=>{}},Zotero:{Prefs:{get:()=>true},DataDirectory:{dir:'fake'},Items:{getByLibraryAndKeyAsync:async(_,key)=>({key,id:key,deleted:false,isPDFAttachment:()=>true,getFilePathAsync:async()=>key})}},PathUtils:{join:path.join,parent:path.dirname}};
 vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/automation.js'),'utf8'),scope);const a=scope.ReaderAutomation;a.app={pref:'x',state:{busy:false},writeJSON:async()=>{},safeError:e=>e.message};a.started=true;a.settleMs=0;a.persist=async()=>{};a.refreshViews=()=>{};a.schedule=()=>{};
 for(let i=1;i<=3;i++)Q.enqueue(a.state,{id:i,libraryID:1,key:'PDF0000'+i},{trigger:'manual'});
 return a;
}
test('paper workers use independent state and cancellation controllers',async()=>{
 const a=scheduler(),one=a.createWorker({id:'one'}),two=a.createWorker({id:'two'});let secondAborted=false;
 const p=one.codex.exclusive(signal=>new Promise(r=>signal.addEventListener('abort',r,{once:true}))),q=two.codex.exclusive(async signal=>{await wait(8);secondAborted=signal.aborted;});await wait(1);one.codex.controller.abort();await Promise.all([p,q]);assert.equal(secondAborted,false);assert.notEqual(one.codex.state,two.codex.state);assert.notEqual(one.app.state,two.app.state);
});
test('scheduler runs two papers, isolates one failure, and starts the next without blocking the survivor',async()=>{
 const a=scheduler(),releases={};a.execute=(job,worker)=>worker.codex.exclusive(()=>new Promise((resolve,reject)=>{releases[job.key]={resolve,reject};}));
 await a.tick();await a.tick();await wait(0);assert.equal(a.running.size,2);releases.PDF00001.reject(Error('synthetic failure'));await wait(0);await a.tick();await wait(0);assert.equal(a.state.jobs['1:PDF00001'].state,'failed');assert.equal(a.running.size,2);assert.ok(releases.PDF00003);releases.PDF00002.resolve({status:'checked'});releases.PDF00003.resolve({status:'checked'});await a.active;assert.equal(a.state.jobs['1:PDF00002'].state,'done');assert.equal(a.state.jobs['1:PDF00003'].state,'done');
});

test('one unified template includes the requested study types, missing-value text and interpretation labels',()=>{
 assert.deepEqual(Object.keys(R.TEMPLATES),['general']);const text=R.defaultTemplateText('general');assert.equal(R.defaultTemplateText('ecology'),text);
 for(const token of ['【总则与领域透镜】','数据合成/Meta分析','综述论文','校准验证集','未明确标注','Zotero未记录'])assert.ok(text.includes(token));
 assert.equal(R.attributionLabel('publication','interpretation'),'【读后判断】');assert.equal(R.attributionLabel('mechanisms','reported'),'【实证/文献证据】');
 const d=draft();d.articleInfo[0].entries[0].text='未明确标注';assert.equal(R.assess(d,review(d),paper).status,'checked');
});

test('single-paper checking stays sequential and empty repair preferences do not mean zero',()=>{
 for(const repairs of [undefined,null,'',false])assert.equal(W.limits({repairs,checks:4}).repairs,2);
 assert.equal(W.limits({checks:4}).checks,1);assert.equal(W.limits({repairs:4,autoRepair:false}).repairs,0);assert.equal(W.limits({repairs:0}).repairs,0);
});


test('archive results support three to five recommendations and preserve legacy one-item results',()=>{
 const R=require('../content/reading-core.js'),choices=['A','B','C','D','E'].map(key=>({key})),current=[{key:'OLD'}];
 const rec=choices.map(c=>({collectionKey:c.key,reason:'Synthetic fit'})),a=R.archiveSuggestion({archive:{recommendations:rec,adjustments:[{collectionKey:'OLD',reason:'Mismatch'}],reason:'Summary'}},choices,current);assert.equal(a.recommendations.length,5);assert.equal(a.adjustments.length,1);
 const legacy=R.archiveSuggestion({archive:{collectionKey:'A',reason:'Legacy'}},choices);assert.equal(legacy.recommendations[0].collectionKey,'A');assert.deepEqual(legacy.adjustments,[]);
 assert.deepEqual(R.archiveSuggestion({archive:{recommendations:[],adjustments:[],reason:'Insufficient match'}},choices).recommendations,[]);
});
test('archive parsing rejects unknown or contradictory removals and never invents filler categories',()=>{
 const R=require('../content/reading-core.js'),choices=[{key:'A'},{key:'B'}],item={collectionKey:'A',reason:'Fit'};
 for(const archive of [{recommendations:[item],adjustments:[item],reason:'Conflict'},{recommendations:[item],adjustments:[{collectionKey:'OTHER',reason:'Unknown'}],reason:'Invalid'},{recommendations:Array(6).fill(item),reason:'Too many'}])assert.equal(R.archiveSuggestion({archive},choices,choices),null);
 const a=R.archiveSuggestion({archive:{recommendations:[item,item],adjustments:[],reason:'Only one fit'}},choices);assert.equal(a.recommendations.length,1);
});
