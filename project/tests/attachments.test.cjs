const {test}=require('node:test'),assert=require('node:assert/strict');
const A=require('../content/attachment-core.js'),R=require('../content/reading-core.js'),W=require('../content/wiki-core.js');
test('supplement labels are hints; duplicate bytes are eliminated without selecting supplements',()=>{
 for(const name of ['Supplementary Information','supporting_information.pdf','Appendix A','补充材料','MOESM1.pdf','mmc1.pdf'])assert.ok(A.isSupplement('',name),name);
 assert.ok(!A.isSupplement('Microbial information networks','paper.pdf'));
 const files=[{key:'dup',itemID:2,sha256:'same',supplement:false},{key:'main',itemID:1,sha256:'same',supplement:false},{key:'supp',sha256:'other',supplement:true}];
 const p=A.plan(files);assert.equal(p.mainKey,'main');assert.equal(p.pdfs[0].duplicateOf,'main');assert.deepEqual(p.supplementKeys,[]);assert.equal(p.duplicateCount,1);
 assert.equal(files[0].duplicateOf,undefined);
});
test('different versions and unverified cloud duplicates require a main choice',()=>{
 for(const files of [[{key:'a',sha256:'one'},{key:'b',sha256:'two'}],[{key:'a',sha256:'one'},{key:'b',sha256:null}],[{key:'s',supplement:true}]]){
  const p=A.plan(files);assert.equal(p.mainKey,'');assert.throws(()=>A.selection(p));
 }
 const p=A.plan([{key:'a',sha256:'one'},{key:'b',sha256:'two'}]);p.mainKey='a';p.supplementKeys=['a','b'];
 assert.deepEqual(A.selection(p),{mainKey:'a',supplementKeys:['b']});
});
test('source equality includes supplements, roles, hashes and chosen scope',()=>{
 const main={key:'a',libraryID:1,role:'main',sha256:'one'},supp={key:'b',libraryID:1,role:'supplement',sha256:'two'};
 assert.ok(A.sameSources([main,supp],[supp,main]));assert.ok(!A.sameSources([main],[main,supp]));
 assert.ok(!A.sameSources([main,supp],[main,{...supp,sha256:'changed'}]));
 assert.ok(!A.sameSources([main,supp],[{...main,role:'supplement'},{...supp,role:'main'}]));
});
test('main and supplemental evidence retain distinct identities through verification and Wiki receipts',()=>{
 const inputs=[{id:'M',label:'正文',role:'main',key:'AAAA1111',name:'paper.pdf',markdown:'Main paper reports twenty four independent sites.'},{id:'S1',label:'补充材料 1',role:'supplement',key:'BBBB2222',name:'sup.pdf',markdown:'Supplement reports the laboratory extraction protocol.'}];
 const paper=R.paperSet(inputs,'test');assert.deepEqual(paper.paragraphs.map(p=>p.id),['M-P0001','S1-P0001']);
 const evidence=[{paragraph_id:'S1-P0001',quote:'laboratory extraction protocol'}];assert.deepEqual(R.evidenceIssues(evidence,paper,true),[]);
 assert.ok(R.evidenceIssues([{...evidence[0],paragraph_id:'M-P0001'}],paper,true).length);
 assert.equal(A.evidenceText({evidence},inputs),'补充材料 1 S1-P0001');
 assert.match(R.verificationPrompt(paper,{sections:[]}),/source_id/);
 const receipt=W.receipt({},inputs[0],inputs);assert.equal(receipt.attachments.length,2);assert.equal(receipt.attachments[1].role,'supplement');
 assert.deepEqual(R.paperSet([inputs[0]]).paragraphs.map(p=>p.id),['P0001']);
 assert.throws(()=>R.paperSet([{markdown:'x'.repeat(250000)},{markdown:'x'.repeat(250000)}]),{code:'TEXT_SIZE'});
});
