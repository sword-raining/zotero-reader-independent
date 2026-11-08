const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const A=require('../content/attachment-core.js');
function fixture(){let calls=0,text='Synthetic soil ecology across dryland gradients\nVersion of Record\nAbstract\nMain text.',stamp=1;const file={key:'PDF00001',libraryID:1,path:'main.pdf',name:'main.pdf',size:100,lastModified:1,sha256:'hash1',local:true},att={id:1,getFilePathAsync:async()=>file.path},parent={getField:()=> 'Synthetic soil ecology across dryland gradients'};
 const scope={AttachmentCore:A,MineruCore:{safeZipPath:x=>x},PathUtils:{join:path.join},ReaderTimers:{setTimeout,clearTimeout},IOUtils:{exists:async()=>true,stat:async()=>({size:100,lastModified:stamp}),readUTF8:async()=>text},Zotero:{PDFWorker:{getFullText:async(id,pages,priority)=>{calls++;assert.equal(pages,2);assert.equal(priority,true);return {text,extractedPages:2,totalPages:10};}}}};vm.createContext(scope);vm.runInContext(fs.readFileSync(require.resolve('../content/attachments.js'),'utf8'),scope);const r=scope.ReaderAttachments;r.init({cached:async()=>null,options:()=>({})});return {r,scope,file,att,parent,calls:()=>calls,setText:v=>text=v,changeStamp:()=>stamp++};
}
test('local inspection requests two pages, caches derived hints and invalidates them when the PDF hash changes',async()=>{
 const f=fixture();let r=await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(r.role,'main');assert.equal(r.version,'published');assert.equal(r.roleSource,'local');await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(f.calls(),1);f.file.sha256='hash2';f.setText('Supporting Information\nSynthetic soil ecology across dryland gradients');r=await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(r.role,'supplement');assert.equal(f.calls(),2);
});
test('validated existing parser output is preferred and inspection never creates a cloud parsing request',async()=>{
 const f=fixture();let source;f.r.app.cached=async s=>{source=s;return {dir:'cache',manifest:{markdown:'full.md'}};};f.r.app.parseAttachment=()=>{throw Error('No cloud parsing allowed');};const r=await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(r.roleSource,'cache');assert.equal(source.sha256,'hash1');assert.equal(f.calls(),0);
});
test('a file changed during text extraction is not accepted as inspected evidence',async()=>{
 const f=fixture();f.scope.Zotero.PDFWorker.getFullText=async()=>{f.changeStamp();return {text:'Supporting Information'};};const r=await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(r.role,'unknown');assert.equal(r.roleSource,'unavailable');assert.equal(f.r.inspections.size,0);
});
test('missing or oversized PDFs do not cause local extraction or any download',async()=>{
 const f=fixture();for(const patch of [{local:false},{size:50*1024*1024},{sha256:null}]){const r=await f.r.inspectPDF(f.att,{...f.file,...patch},f.parent);assert.equal(r.role,'unknown');}assert.equal(f.calls(),0);
});
test('a slow worker does not block the picker or enqueue further probes, and late hints do not mutate the selection',async()=>{
 const f=fixture();let release,calls=0;f.r.probeTimeoutMs=5;f.scope.Zotero.PDFWorker.getFullText=()=>{calls++;return new Promise(r=>release=r);};const r=await f.r.inspectPDF(f.att,f.file,f.parent);assert.equal(r.roleSource,'unavailable');assert.equal(f.r.probeBusy,true);await f.r.inspectPDF(f.att,{...f.file,key:'PDF00002'},f.parent);assert.equal(calls,1);release({text:'Supporting Information'});await new Promise(r=>setTimeout(r,10));assert.equal(f.r.probeBusy,false);assert.equal(f.file.role,undefined);
});
