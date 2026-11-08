const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const C=require('../content/codex-core.js'),E=require('../content/engine-core.js');
const work=path.resolve(__dirname,'../../.work');
async function fixture(action){
 await fs.mkdir(work,{recursive:true});const root=await fs.mkdtemp(path.join(work,'cli-test-')),prefs={},dirs={LocalAppData:path.join(root,'Local 用户'),AppData:path.join(root,'Roaming 用户'),Home:path.join(root,'Home')};
 const io={stat:async p=>{const s=await fs.stat(p);return {type:s.isDirectory()?'directory':'regular',size:s.size,lastModified:s.mtimeMs};},exists:async p=>{try{await fs.access(p);return true;}catch(_){return false;}},getChildren:async p=>(await fs.readdir(p)).map(n=>path.join(p,n)),makeDirectory:p=>fs.mkdir(p,{recursive:true})};
 const app={pref:'test.',readJSON:async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(_){return null;}},writeJSON:async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));},safeError:e=>e.message};
 const scope={CodexCore:C,EngineCore:E,PathUtils:{join:path.join,parent:path.dirname,filename:path.basename,isAbsolute:path.isAbsolute},IOUtils:io,AbortController,ReaderTimers:{setTimeout,clearTimeout},
  Services:{dirsvc:{get:k=>({path:dirs[k]})},env:{get:()=>''}},Components:{interfaces:{nsIFile:{}}},Zotero:{isWin:true,DataDirectory:{dir:root},Prefs:{get:k=>prefs[k],set:(k,v)=>prefs[k]=v}}};
 vm.createContext(scope);for(const file of ['codex-runtime.js','engines.js'])vm.runInContext(await fs.readFile(path.join(__dirname,'../content',file),'utf8'),scope);
 const codex=scope.ReaderCodex,engines=scope.ReaderEngines;codex.init(app);await engines.init(app);
 const search={};codex.subprocess=()=>({pathSearch:async n=>{if(search[n])return search[n];throw Error('Synthetic missing PATH');}});
 const write=async(p,content='synthetic executable')=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);return p;};
 const stage={engine:'codex',model:'',effort:''};
 const fake=await write(path.join(root,'mock.exe'));engines.probe=async()=> 'synthetic-1';
 const ready=async()=>{engines.resolve=async()=>({command:fake,prefix:[]});await engines.prepare('codex');await engines.recordHealth(stage,{success:true,version:'synthetic-1',connectivityOnly:true,requestedStage:stage});};
 try{await action({root,dirs,scope,prefs,io,app,codex,engines,search,write,fake,stage,ready});}
 finally{await engines.healthIO;const real=await fs.realpath(root);assert.equal(path.dirname(real).toLowerCase(),work.toLowerCase());await fs.rm(real,{recursive:true,force:true});}
}
test('Codex desktop fallback derives user directories and selects the newest complete executable',()=>fixture(async f=>{
 const bin=path.join(f.dirs.LocalAppData,'OpenAI','Codex','bin'),older=await f.write(path.join(bin,'old-hash','codex.exe')),newer=await f.write(path.join(bin,'new-hash','codex.exe'));
 await fs.utimes(older,1,1);await fs.utimes(newer,2,2);await fs.mkdir(path.join(bin,'partial','codex.exe'),{recursive:true});
 assert.equal((await f.codex.resolveExecutable()).command,newer);
 await fs.unlink(newer);assert.equal((await f.codex.resolveExecutable()).command,older);
}));
test('explicit and PATH Codex installations take precedence and invalid custom paths never silently fall back',()=>fixture(async f=>{
 const desktop=await f.write(path.join(f.dirs.LocalAppData,'OpenAI','Codex','bin','v','codex.exe')),explicit=await f.write(path.join(f.root,'custom.exe'));
 f.search['codex.exe']=explicit;assert.equal((await f.codex.resolveExecutable()).command,explicit);
 f.prefs['test.codex.path']='"'+desktop+'"';assert.equal((await f.codex.resolveExecutable()).command,desktop);
 f.prefs['test.codex.path']=path.join(f.root,'missing.exe');await assert.rejects(f.codex.resolveExecutable(),{code:'CLI_PATH'});
}));
test('npm Codex shims still resolve to native binaries and Antigravity uses per-user fallback',()=>fixture(async f=>{
 const base=path.join(f.dirs.AppData,'npm'),native=await f.write(path.join(base,'node_modules','@openai','codex','vendor','x86_64-pc-windows-msvc','codex','codex.exe'));
 assert.equal((await f.codex.resolveExecutable()).command,native);
 const agy=await f.write(path.join(f.dirs.LocalAppData,'agy','bin','agy.exe'));assert.equal((await f.engines.resolve('antigravity')).command,agy);
 f.prefs['test.agy.path']=path.join(f.root,'not-an-executable.exe');await fs.mkdir(f.prefs['test.agy.path']);await assert.rejects(f.engines.resolve('antigravity'),{code:'CLI_MISSING'});
}));
test('missing CLI discovery invalidates old connectivity and retains cached model choices without success',()=>fixture(async f=>{
 await f.ready();assert.equal(f.engines.connectivityFor(f.stage).state,'available');
 await f.app.writeJSON(path.join(f.root,'zotero-reader-independent','models-codex.json'),{models:[{id:'cached-model'}],version:'synthetic-1'});
 f.engines.resolve=async()=>{throw C.error('CLI_MISSING','Synthetic missing CLI');};await assert.rejects(f.engines.discover('codex'),{code:'CLI_MISSING'});
 assert.equal(f.engines.catalogs.codex.models[0].id,'cached-model');assert.ok(f.engines.catalogs.codex.error);
 assert.notEqual(E.latestHealth(f.engines.healthFor(f.stage),f.engines.connectivityFor(f.stage)).state,'available');
 await f.engines.healthIO;await f.engines.init(f.app);assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
test('successful catalog refresh after failure cannot revive a previous connectivity success',()=>fixture(async f=>{
 await f.ready();f.engines.failed('codex',C.error('NETWORK','synthetic outage'));
 f.scope.EngineCore={...E,codexCatalog:async()=>[{id:'new-model'}]};await f.engines.discover('codex');
 assert.equal(f.engines.runtime.codex.state,'ready');assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
test('a fresh successful connection clears old detection errors but does not claim a refreshed model catalog',()=>fixture(async f=>{
 await f.ready();f.engines.catalogs.codex={models:[{id:'cached'}],cached:true,error:'old CLI missing'};
 let renders=0;f.engines.views.add(()=>renders++);
 await f.engines.recordHealth(f.stage,{success:true,version:'synthetic-1',connectivityOnly:true,requestedStage:f.stage});
 assert.equal(f.engines.catalogs.codex.error,null);assert.equal(f.engines.catalogs.codex.needsRefresh,true);
 assert.equal(f.engines.connectivityFor(f.stage).state,'available');assert.ok(renders>0);
}));
test('changing a path or replacing its binary invalidates both full and quick success',()=>fixture(async f=>{
 await f.ready();await f.engines.recordHealth(f.stage,{success:true,version:'synthetic-1'});
 f.engines.setPath('codex',path.join(f.root,'another.exe'));assert.notEqual(f.engines.healthFor(f.stage).state,'available');assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
 await f.ready();await fs.appendFile(f.fake,' changed');await f.engines.prepare('codex');assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
test('a late catalog result from a changed path cannot overwrite newer detection state',()=>fixture(async f=>{
 await f.ready();let started,release;const start=new Promise(r=>started=r),finish=new Promise(r=>release=r);
 f.scope.EngineCore={...E,codexCatalog:async()=>{started();await finish;return [{id:'obsolete'}];}};
 const pending=f.engines.discover('codex');await start;f.engines.setPath('codex',path.join(f.root,'new.exe'));release();
 await assert.rejects(pending,{code:'CANCELLED'});assert.notEqual(f.engines.catalogs.codex?.models?.[0]?.id,'obsolete');assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
test('cancelled connection tests replace older green results without claiming model unavailability',()=>fixture(async f=>{
 await f.ready();f.codex.exclusive=fn=>fn(new AbortController().signal);f.codex.invoke=async()=>{throw C.error('CANCELLED','synthetic cancellation');};
 await assert.rejects(f.codex.testConnection(()=>{},f.stage,{mode:'quick'}),{code:'CANCELLED'});
 const state=f.engines.connectivityFor(f.stage);assert.equal(state.state,'untested');assert.match(state.label,/未完成/);
}));
test('persisted legacy successes and a same-version binary at a different path require retesting',()=>fixture(async f=>{
 await f.ready();const records=JSON.parse(JSON.stringify(f.engines.health));await f.engines.init(f.app);assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
 f.engines.health=records;f.engines.resolve=async()=>({command:await f.write(path.join(f.root,'different.exe')),prefix:[]});await f.engines.prepare('codex');assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));

test('same-millisecond failed or cancelled checks cannot be hidden by full-test success',()=>{
 const passed={state:'available',label:'old success',testedAt:'2026-11-07T05:00:00.000Z'};
 for(const state of ['untested','unavailable'])assert.equal(E.latestHealth(passed,{state,label:'new failure',testedAt:passed.testedAt}).state,state);
});
test('a connection test waits for pending catalog failure then records its own newer result',()=>fixture(async f=>{
 await f.ready();let release;const pending=new Promise((_,reject)=>release=()=>reject(C.error('NETWORK','synthetic discovery failure')));
 f.engines.inflight.codex=pending;f.codex.exclusive=fn=>fn(new AbortController().signal);let invoked=false;
 f.codex.invoke=async()=>{invoked=true;return {answer:'ZRI_OK',metadata:{version:'synthetic-1',cliKey:f.engines.runtime.codex.key}};};
 const test=f.codex.testConnection(()=>{},f.stage,{mode:'quick'});await Promise.resolve();assert.equal(invoked,false);release();await test;
 assert.equal(f.engines.connectivityFor(f.stage).state,'available');
}));


test('ordinary connectivity accepts a short greeting reply without schema or model-name matching',()=>fixture(async f=>{
 await f.ready();f.codex.exclusive=fn=>fn(new AbortController().signal);
 f.codex.invoke=async(prompt,context,signal,report,request)=>{assert.ok(prompt.length<100);assert.match(prompt,/你好/);assert.equal(request.schema,undefined);assert.notEqual(request.effort,'high');return {answer:'你好，我无法可靠确认自己的型号。',metadata:{version:'synthetic-1',cliKey:f.engines.runtime.codex.key}};};
 const result=await f.codex.testConnection(()=>{},f.stage);assert.match(result.answer,/无法可靠确认/);assert.equal(f.engines.connectivityFor(f.stage).state,'available');
}));
test('an empty greeting response cannot pass connectivity',()=>fixture(async f=>{
 await f.ready();f.codex.exclusive=fn=>fn(new AbortController().signal);f.codex.invoke=async()=>({answer:'  ',metadata:{}});
 await assert.rejects(f.codex.testConnection(()=>{},f.stage),{code:'HEALTH_FORMAT'});assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
test('explicit structured verification still rejects a prose reply',()=>fixture(async f=>{
 await f.ready();f.codex.exclusive=fn=>fn(new AbortController().signal);f.codex.invoke=async(prompt,context,signal,report,request)=>{assert.ok(request.schema);return {answer:'你好',metadata:{}};};
 await assert.rejects(f.codex.testConnection(()=>{},f.stage,{mode:'exact'}),{code:'HEALTH_FORMAT'});
}));
test('stopping while waiting for a catalog returns promptly without a model request',()=>fixture(async f=>{
 await f.ready();const controller=new AbortController();f.codex.exclusive=fn=>fn(controller.signal);f.engines.inflight.codex=new Promise(()=>{});let invoked=false;f.codex.invoke=async()=>{invoked=true;};
 const pending=f.codex.testConnection(()=>{},f.stage);controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(invoked,false);assert.notEqual(f.engines.connectivityFor(f.stage).state,'available');
}));
