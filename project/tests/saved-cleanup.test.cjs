const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const S=require('../content/saved-core.js'),N=require('../content/note-core.js');
const rootDir=path.resolve(__dirname,'../..'),runID='1794000000000-abcdefgh',mainKey='ABCD1234',parentKey='PARENT23';
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function fileObject(p){return {path:path.resolve(p),normalize(){this.path=path.normalize(this.path);},exists(){try{sync.lstatSync(this.path);return true;}catch(_){return false;}},isSymlink(){return sync.lstatSync(this.path).isSymbolicLink();},isDirectory(){return sync.statSync(this.path).isDirectory();},get parent(){return path.dirname(this.path)===this.path?null:fileObject(path.dirname(this.path));}};}
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(rootDir,'saved-test-')),base=path.join(root,'zotero-reader-independent');
 const io={exists:async p=>{try{await fs.access(p);return true;}catch(_){return false;}},makeDirectory:p=>fs.mkdir(p,{recursive:true}),readUTF8:p=>fs.readFile(p,'utf8'),writeUTF8:(p,s)=>fs.writeFile(p,s),
  getChildren:async(p,o={})=>{try{return(await fs.readdir(p)).map(n=>path.join(p,n));}catch(e){if(o.ignoreAbsent&&e.code==='ENOENT')return [];throw e;}},remove:(p,o)=>fs.rm(p,{recursive:!!o?.recursive,force:!!o?.ignoreAbsent})};
 const sourceFile=path.join(root,'original.pdf');await fs.writeFile(sourceFile,'original user PDF');
 const main={id:12,key:mainKey,libraryID:1,parentID:11,file:sourceFile,getField:()=> 'main.pdf',isPDFAttachment:()=>true,getFilePathAsync(){return Promise.resolve(this.file);}};
 const parent={id:11,key:parentKey,libraryID:1,getNotes:()=>[note.id]};
 let html='<div data-schema-version="9"><h1>Reading</h1><a href="zotero://open-pdf/library/items/'+mainKey+'">PDF</a><p>Checked content</p><!-- ZRI:'+runID+':reading --></div>';
 const record={schema:1,runID,itemKey:parentKey,status:'checked',createdAt:'2026-11-06T00:00:00Z',inputs:[{key:mainKey,role:'main',sha256:hash('original user PDF')}],bodySHA256:hash(S.body(html))};
 html=S.embed(html,record);
 const note={id:13,key:'NOTE1234',libraryID:1,parentID:11,isNote:()=>true,getNote:()=>html,getRelationsByPredicate:()=>['http://zotero.org/users/1/items/'+mainKey]};
 const items=()=>[main,parent,note];
 const app={pref:'test.',state:{busy:false},activeRun:null,safeError:e=>e.message,
  readJSON:async p=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(_){return null;}},
  writeJSON:async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v));},sha256:async p=>hash(await fs.readFile(p)),sha256Text:async s=>hash(s),
  attachmentDir:s=>{assert.ok(S.validKey(s.key)&&Number.isInteger(s.libraryID));return path.join(scope.Zotero.DataDirectory.dir,'zotero-reader-independent','cache',String(s.libraryID),s.key);},
  async source(att){const data=await fs.readFile(att.file);return {path:att.file,source:{libraryID:att.libraryID,key:att.key,name:path.basename(att.file),sha256:hash(data),size:data.length}};}};
 const scope={SavedCore:S,NoteCore:N,QueueCore:require('../content/queue-core.js'),BatchCore:require('../content/batch-core.js'),ReadingCore:require('../content/reading-core.js'),AttachmentCore:require('../content/attachment-core.js'),
  IOUtils:io,PathUtils:{join:path.join,parent:path.dirname,filename:path.basename},ReaderTimers:{setTimeout,clearTimeout},
  ReaderCodex:{active:null,state:{output:''},update(v){Object.assign(this.state,v);}},
  ReaderNotes:{destination:async att=>{if(!att)throw new Error('missing');return {parentID:att.parentID,pdfURL:'zotero://open-pdf/library/items/'+att.key};}},
  Zotero:{isWin:process.platform==='win32',File:{pathToFile:fileObject},DataDirectory:{dir:root},
   URI:{getItemURI:att=>'http://zotero.org/users/1/items/'+att.key},Utilities:{randomString:()=> 'abc123'},
   Items:{getAsync:async id=>Array.isArray(id)?items().filter(x=>id.includes(x.id)):items().find(x=>x.id===id),getByLibraryAndKeyAsync:async(lib,key)=>items().find(x=>x.libraryID===lib&&x.key===key)},
   DB:{columnQueryAsync:async()=>[note.id]},Prefs:{get:()=>false}}};
 vm.createContext(scope);
 for(const name of ['saved-runtime.js','cleanup.js','attachments.js','automation.js'])vm.runInContext(await fs.readFile(path.join(__dirname,'../content',name),'utf8'),scope);
 await fs.mkdir(base,{recursive:true});scope.ReaderAttachments.init(app);await scope.ReaderSaved.init(app);scope.ReaderCleanup.init(app);scope.ReaderAutomation.app=app;scope.ReaderAutomation.notes=scope.ReaderNotes;
 scope.ReaderCleanup.isLink=file=>file.isSymlink(); // Native Windows attributes are exercised by the Zotero host test.
 const dir=path.join(base,'readings',runID),workflowPath=path.join(dir,'workflow.json'),cacheBase=app.attachmentDir({libraryID:1,key:mainKey}),cache=path.join(cacheBase,'aaaaaaaaaaaaaaaa-12345678-abcdefgh'),run=path.join(base,'codex-runs','1794000000001-bcdefghi');
 const source=(await app.source(main)).source;
 const w={source,inputSources:[{...source,role:'main'}],status:'checked',resultFile:'reading.md',resultSHA256:hash('reading'),draftSHA256:hash('draft'),zoteroNotes:{reading:{key:note.key}},noteStatus:'checked'};
 await app.writeJSON(workflowPath,w);await fs.writeFile(path.join(dir,'draft.md'),'draft');await fs.writeFile(path.join(dir,'reading.md'),'reading');await app.writeJSON(path.join(dir,'source-index.json'),{paragraphs:[{text:'private source'}]});
 await app.writeJSON(path.join(cache,'reader-manifest.json'),{source,files:[{path:'paper/full.md'}]});await fs.mkdir(path.join(cache,'paper'));await fs.writeFile(path.join(cache,'paper/full.md'),'parsed paper');await fs.writeFile(path.join(cache,'mineru-result.zip'),'zip');await app.writeJSON(path.join(cacheBase,'current.json'),{generation:path.basename(cache)});
 await app.writeJSON(path.join(run,'run.json'),{readingID:runID,status:'complete'});await fs.writeFile(path.join(run,'answer.json'),'model output');
 scope.ReaderAutomation.state.jobs['1:'+mainKey]={id:'1:'+mainKey,key:mainKey,libraryID:1,state:'running',workflowPath};
 const register=()=>scope.ReaderSaved.record(w,note,'checked',main);
 try{await fn({root,base,scope,app,main,parent,note,w,workflowPath,dir,cacheBase,cache,run,register,record,editNote:s=>html+=s});}
 finally{const real=await fs.realpath(root);assert.equal(path.dirname(real).toLowerCase(),rootDir.toLowerCase());assert.ok(path.basename(real).startsWith('saved-test-'));await fs.rm(real,{recursive:true,force:true});}
}
test('saved receipt contains stable keys and hashes, with no local IDs or absolute paths',()=>{
 const r={schema:1,runID,itemKey:parentKey,status:'checked',inputs:[{key:mainKey,role:'main',sha256:'a'.repeat(64)}],bodySHA256:'b'.repeat(64)};
 const html='<div><a href="zotero://open-pdf/library/items/'+mainKey+'">原文</a><p>正文</p></div>';
 const embedded=S.embed(html,r);assert.deepEqual(S.read(embedded),r);assert.equal(S.strip(embedded),html);
 const editorHTML=embedded.replace(/\sdata-zri-record="[^"]*"/,'').replace(/></g,'>\n<');
 assert.deepEqual(S.read(editorHTML),r);assert.equal(S.body(editorHTML),S.body(html));
 assert.ok(S.matches(r,[{key:'ZZZZ9999',libraryID:99,role:'main',sha256:'a'.repeat(64)}]));
 assert.ok(!S.matches(r,[{key:mainKey,role:'main',sha256:'c'.repeat(64)}]));
 assert.equal(S.read('<div data-zri-record="broken">x</div>'),null);assert.throws(()=>S.embed('<div>x</div>',{...r,runID:'../../outside'}));
});
test('after confirmed import, reading files, owned runs and unused cache are removed but source PDF and note survive',()=>fixture(async f=>{
 await f.register();const html=f.note.getNote(),result=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);
 assert.equal(result.state,'done');for(const p of [f.dir,f.cacheBase,f.run])assert.equal(await f.scope.IOUtils.exists(p),false,p);
 assert.equal(await fs.readFile(f.main.file,'utf8'),'original user PDF');assert.equal(f.note.getNote(),html);assert.equal(f.scope.ReaderSaved.records[runID].cleanup,'done');
 await f.scope.ReaderAutomation.compactImported(f.workflowPath,{status:'checked',notes:f.w.zoteroNotes,cleanup:result});assert.equal(f.scope.ReaderAutomation.state.jobs['1:'+mainKey].workflowPath,undefined);
}));
test('unconfirmed imports, deleted notes and edited Markdown remain untouched',async()=>{
 for(const mode of ['unconfirmed','deleted','edited'])await fixture(async f=>{
  if(mode!=='unconfirmed')await f.register();if(mode==='deleted')f.note.deleted=true;if(mode==='edited')await fs.appendFile(path.join(f.dir,'reading.md'),' human edit');
  assert.equal((await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main)).state,'retained');
  for(const p of [f.dir,f.cacheBase,f.run])assert.equal(await f.scope.IOUtils.exists(p),true);
 });
});
test('cache still used by another unfinished reading is retained while imported result is cleaned',()=>fixture(async f=>{
 await f.register();await f.app.writeJSON(path.join(f.base,'readings','1794000000002-cdefghij','workflow.json'),{source:f.w.source,status:'verification_incomplete'});
 const result=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(result.state,'done');assert.ok(await f.scope.IOUtils.exists(f.cacheBase));assert.ok(!await f.scope.IOUtils.exists(f.dir));
}));
test('extra user files protect the reading directory, and extra cache files protect cache content',async()=>{
 for(const where of ['reading','cache'])await fixture(async f=>{
  await f.register();const file=path.join(where==='reading'?f.dir:f.cache,'my-added-file.txt');await fs.writeFile(file,'user file');
  await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(await fs.readFile(file,'utf8'),'user file');
 });
});
test('cleanup refuses links and targets outside the private data directory',()=>fixture(async f=>{
 await f.register();const outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep.txt'),'keep');
 await assert.rejects(f.scope.ReaderCleanup.remove(outside),{code:'CLEANUP_PATH'});
 await fs.symlink(outside,path.join(f.cache,'link'),process.platform==='win32'?'junction':'dir');
 const result=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(result.state,'retained');assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
}));
test('cleanup failure does not undo the note and retry safely finishes remaining files',()=>fixture(async f=>{
 await f.register();const remove=f.scope.IOUtils.remove;f.scope.IOUtils.remove=async(p,o)=>{if(p===f.dir)throw new Error('simulated busy file');return remove(p,o);};
 assert.equal((await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main)).state,'retained');assert.ok(S.read(f.note.getNote()));
 f.scope.IOUtils.remove=remove;assert.equal((await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main)).state,'done');
}));
test('another computer with different local IDs and no local history finds synced notes and skips duplicate processing',()=>fixture(async f=>{
 const second=path.join(f.root,'second-pc');await fs.mkdir(second);f.scope.Zotero.DataDirectory.dir=second;
 f.main.id=80;f.main.parentID=81;f.parent.id=81;f.note.id=82;for(const x of [f.main,f.parent,f.note])x.libraryID=7;
 f.scope.ReaderSaved.records={};f.scope.ReaderAutomation.state.jobs={};
 const found=await f.scope.ReaderSaved.matching(f.main);assert.equal(found.note.key,f.note.key);
 const result=await f.scope.ReaderAutomation.enqueueBatch([{libraryID:7,key:mainKey}],'ecology');assert.equal(result.skipped,1);assert.equal(result.added,0);assert.equal(result.noteKeys['7:'+mainKey],f.note.key);
 f.editNote('<p>Human edit after sync</p>');assert.equal((await f.scope.ReaderSaved.matching(f.main)).status,'edited');
 await fs.appendFile(f.main.file,' changed source');assert.equal(await f.scope.ReaderSaved.matching(f.main),null);
}));
test('legacy synced notes remain discoverable without claiming their PDF version was verified',()=>fixture(async f=>{
 const plain=S.strip(f.note.getNote());f.note.getNote=()=>plain;const candidates=await f.scope.ReaderSaved.candidates(f.main);
 assert.equal(candidates.length,1);assert.equal(candidates[0].status,'legacy');assert.equal(await f.scope.ReaderSaved.matching(f.main),null);
}));
test('manual cleanup waits for an in-flight note transaction',()=>fixture(async f=>{
 await f.register();f.scope.ReaderNotes.pending=1;
 await assert.rejects(f.scope.ReaderCleanup.sweep(),{code:'BUSY'});assert.ok(await f.scope.IOUtils.exists(f.dir));
}));


async function obsoleteReview(f,{edited=false,tracked=false,badHash=false}={}){
 const R=require('../content/reading-core.js'),W=require('../content/wiki-core.js');f.scope.ReadingCore=R;f.scope.WikiCore=W;f.scope.IOUtils.stat=async p=>({size:(await fs.stat(p)).size});
 const draft={sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:'Synthetic generated text',kind:key==='publication'?'interpretation':'reported',evidence:[]}]}))},assessment={status:'needs_review',hasMajorIssues:true,checks:draft.sections.map(s=>({entry_id:s.entries[0].id,passed:false}))};
 const text=W.decorate(R.renderDraft(draft,assessment,f.w.bibliography,f.w.inputSources,{legacyAttribution:true}),f.w.bibliography,{...f.w,status:'needs_review'});
 await f.app.writeJSON(path.join(f.dir,'internal','draft-2-resume-1.json'),draft);await f.app.writeJSON(path.join(f.dir,'internal','check-2-resume-1.json'),{assessment});await fs.writeFile(path.join(f.dir,'review-needed.md'),text+(edited?' Human edit':''));if(tracked)f.w.generatedMarkdown={'review-needed.md':badHash?'0'.repeat(64):hash(text)};await f.app.writeJSON(f.workflowPath,f.w);return text;
}
test('a byte-exact legacy review draft no longer blocks cleanup after the final note is saved',()=>fixture(async f=>{
 await f.register();await obsoleteReview(f);assert.equal(await f.scope.ReaderCleanup.readingUnmodified(f.dir,f.w),true);assert.equal((await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main)).state,'done');assert.equal(await f.scope.IOUtils.exists(f.dir),false);
}));
test('edited or unprovable old intermediate files remain protected with a specific filename',()=>fixture(async f=>{
 await f.register();await obsoleteReview(f,{edited:true});const r=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(r.state,'retained');assert.match(r.message,/review-needed.md/);assert.equal(await f.scope.IOUtils.exists(f.dir),true);
}));
test('a recorded intermediate checksum is enforced and cannot be bypassed by legacy replay',async()=>{
 for(const badHash of [false,true])await fixture(async f=>{await f.register();await obsoleteReview(f,{tracked:true,badHash});const r=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(r.state,badHash?'retained':'done');});
});
test('changes to the current imported result remain protected even with reproducible historic data',()=>fixture(async f=>{
 await f.register();const text=await obsoleteReview(f);await fs.writeFile(path.join(f.dir,'reading.md'),text);const r=await f.scope.ReaderCleanup.afterSave(f.workflowPath,f.main);assert.equal(r.state,'retained');assert.match(r.message,/reading.md/);
}));
