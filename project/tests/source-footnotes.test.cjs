const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const S=require('../content/source-core.js'),R=require('../content/reading-core.js'),M=require('../content/core.js');
const md='# Synthetic paper\n\nMain text without affiliations.',note='<sup>1</sup>Fictional Research Institute, Example City. <sup>2</sup>Example University. e-mail: test@example.invalid';
const v1=[{type:'page_footnote',text:note,page_idx:0},{type:'footer',text:'Repeated journal footer',page_idx:0},{type:'page_number',text:'1',page_idx:0}];
const v2=[[{type:'page_footnote',content:{page_footnote_content:[{type:'text',content:note}]}}]];
const layout={pdf_info:[{page_idx:0,discarded_blocks:[{type:'page_footnote',lines:[{spans:[{type:'text',content:note}]}]},{type:'footer',lines:[{spans:[{content:'Journal footer'}]}]}]}]};
const input=(format,data)=>({path:format+'.json',format,data});
test('all three MinerU formats recover the missing footnote without adding headers or page numbers',()=>{
 for(const [format,data]of [['v1',v1],['v2',v2],['layout',layout]]){const a=S.assemble(md,[input(format,data)]);assert.ok(a.markdown.startsWith(md));assert.ok(a.markdown.includes(note));assert.ok(!a.markdown.includes('Repeated journal footer'));assert.equal(a.diagnostics.addedFootnotes,1);assert.deepEqual(a.diagnostics.footnotePages,[1]);}
});
test('parallel JSON representations and footnotes already in Markdown are not repeated',()=>{
 const a=S.assemble(md,[input('v1',v1),input('v2',v2),input('layout',layout)]);assert.equal(a.diagnostics.addedFootnotes,1);assert.equal(a.markdown.split('Fictional Research Institute').length,2);
 const plain=note.replace(/<[^>]+>/g,'');assert.equal(S.assemble(md+'\n\n'+plain,[input('v1',v1)]).diagnostics.addedFootnotes,0);assert.equal(S.assemble(a.markdown,[input('v1',v1)]).markdown,a.markdown);
});
test('a partially included note is kept in full and different mathematical signs are not deduplicated',()=>{
 const notes=[{type:'page_footnote',text:'Effect = +2 units',page_idx:1},{type:'page_footnote',text:'Effect = -2 units',page_idx:2}];const a=S.assemble(md+'\n\nFictional Research Institute',[input('v1',v1),input('v1',notes)]);assert.equal(a.diagnostics.addedFootnotes,3);assert.ok(a.markdown.includes(note));assert.ok(a.markdown.includes('PDF 第 3 页'));
});
test('missing structured output remains explicitly unavailable while malformed footnotes are rejected',()=>{
 const a=S.assemble(md);assert.equal(a.markdown,md);assert.equal(a.diagnostics.structuredAvailable,false);
 for(const [format,data]of [['v1',{}],['v2',[{}]],['layout',{}],['v1',[{type:'page_footnote'}]],['v2',[[{type:'page_footnote',content:{}}]]]])assert.throws(()=>S.assemble(md,[input(format,data)]),{code:'SOURCE_STRUCTURE'});
});
test('unknown page indices are not invented and overlong enriched input is not truncated',()=>{
 const a=S.assemble(md,[input('v1',[{type:'page_footnote',text:note,page_idx:'unknown'}])]);assert.deepEqual(a.diagnostics.footnotePages,[]);assert.ok(!a.markdown.includes('第 1 页'));assert.throws(()=>S.assemble('x'.repeat(S.MAX_CHARS-2),[input('v1',v1)]),{code:'TEXT_SIZE'});
});
test('main and selected supplemental footnotes remain separate and can be cited by the verifier',()=>{
 const a=S.assemble(md,[input('v1',v1)]),b=S.assemble('Synthetic supplement',[input('v1',[{type:'page_footnote',text:'Supplement-specific note',page_idx:3}])]);const paper=R.paperSet([{name:'main',markdown:a.markdown},{name:'supplement',markdown:b.markdown}]);const main=paper.paragraphs.find(p=>p.text.includes('Fictional Research Institute')),sup=paper.paragraphs.find(p=>p.text.includes('Supplement-specific note'));assert.ok(main.id.startsWith('M-'));assert.ok(sup.id.startsWith('S1-'));assert.deepEqual(R.evidenceIssues([{paragraph_id:main.id,quote:'Fictional Research Institute, Example City.'}],paper,true),[]);
});
function runtime(){
 const scope={SourceCore:S,MineruCore:M,Components:{utils:{importGlobalProperties(){}}},ChromeUtils:{importESModule:()=>({})},PathUtils:{join:path.posix.join},IOUtils:{},Zotero:{}};vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/runtime.js'),'utf8'),scope);const files=new Map([['/cache/full.md',md],['/cache/doc_content_list.json',JSON.stringify(v1)],['/cache/doc_content_list_v2.json',JSON.stringify(v2)],['/cache/layout.json',JSON.stringify(layout)]]);let reads=[];scope.IOUtils.stat=async p=>{if(!files.has(p))throw Error('Missing');return {size:Buffer.byteLength(files.get(p))};};scope.IOUtils.readUTF8=async p=>{reads.push(p);return files.get(p);};const app=scope.ReaderApp;app.sha256Text=async s=>crypto.createHash('sha256').update(s).digest('hex');const cache={dir:'/cache',manifest:{markdown:'full.md',files:[...files].map(([p,s])=>({path:p.slice(7),size:Buffer.byteLength(s)}))}};return {scope,app,cache,files,reads};
}
test('runtime reuses an old cache read-only and records the exact enriched input fingerprint',async()=>{
 const f=runtime(),before=[...f.files],a=await f.app.readModelSource(f.cache);assert.equal(a.diagnostics.addedFootnotes,1);assert.equal(a.diagnostics.fingerprints.length,3);assert.equal(a.diagnostics.assembledSHA256,await f.app.sha256Text(a.markdown));assert.deepEqual([...f.files],before);
});
test('runtime rejects traversal, corrupted JSON, changed size and oversized JSON before invoking a model',async()=>{
 let f=runtime();f.cache.manifest.files=[{path:'../doc_content_list.json'}];await assert.rejects(f.app.readModelSource(f.cache));assert.ok(!f.reads.some(p=>p.includes('../')));
 f=runtime();f.files.set('/cache/doc_content_list.json','{');await assert.rejects(f.app.readModelSource(f.cache),{code:'CACHE_CHANGED'});
 f=runtime();f.files.set('/cache/doc_content_list.json','{');delete f.cache.manifest.files[1].size;await assert.rejects(f.app.readModelSource(f.cache),{code:'SOURCE_STRUCTURE'});
 f=runtime();f.scope.IOUtils.stat=async p=>({size:p.endsWith('.json')?S.MAX_JSON_BYTES+1:md.length});await assert.rejects(f.app.readModelSource(f.cache),{code:'SOURCE_SIZE'});
});
