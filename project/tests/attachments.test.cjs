const {test}=require('node:test'),assert=require('node:assert/strict');
const A=require('../content/attachment-core.js'),R=require('../content/reading-core.js'),W=require('../content/wiki-core.js');
test('supplement labels are hints; duplicate bytes are eliminated without selecting supplements',()=>{
 for(const name of ['Supplementary Information','supporting_information.pdf','Appendix A','补充材料','MOESM1.pdf','mmc1.pdf'])assert.ok(A.isSupplement('',name),name);
 assert.ok(!A.isSupplement('Microbial information networks','paper.pdf'));
 const files=[{key:'dup',itemID:2,sha256:'same',supplement:false},{key:'main',itemID:1,sha256:'same',supplement:false},{key:'supp',sha256:'other',supplement:true}];
 const p=A.plan(files);assert.equal(p.mainKey,'main');assert.equal(p.pdfs[0].duplicateOf,'main');assert.deepEqual(p.supplementKeys,[]);assert.equal(p.duplicateCount,1);
 assert.equal(files[0].duplicateOf,undefined);
});
test('multiple main versions choose one deterministically while supplemental-only groups still need a main',()=>{
 const files=[{key:'accepted',itemID:1,sha256:'a',title:'Accepted manuscript'},{key:'published',itemID:2,sha256:'b',title:'Published version'}];assert.equal(A.plan(files).mainKey,'published');assert.equal(A.plan([...files].reverse()).mainKey,'published');
 const equal=[{key:'second',itemID:2,sha256:'two'},{key:'first',itemID:1,sha256:'one'}];assert.equal(A.plan(equal).mainKey,'first');const onlySupp=A.plan([{key:'s',supplement:true}]);assert.equal(onlySupp.mainKey,'');assert.throws(()=>A.selection(onlySupp));
 const p=A.plan([{key:'a',sha256:'one'},{key:'b',sha256:'two'}]);p.mainKey='a';p.supplementKeys=['a','b'];assert.deepEqual(A.selection(p),{mainKey:'a',supplementKeys:['b']});
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

test('PDF header text identifies supporting information even when its filename is generic',()=>{
 const title='Synthetic soil ecology across dryland gradients';for(const marker of ['Supporting Information','Supplementary Information for','Supplemental Material','补充材料']){const r=A.inspectText(marker+'\n'+title+'\nMethods and tables',{title});assert.equal(r.role,'supplement',marker);}assert.ok(A.isSupplement('','pnas.251071122.sapp.pdf'));
});
test('accepted dates and ordinary supplementary mentions do not misclassify a published main paper',()=>{
 const title='Synthetic soil ecology across dryland gradients';const r=A.inspectText(title+'\nPublished online 2025\nAccepted 12 July 2025\nAbstract\nThis study includes supplementary information in a separate file.',{title});assert.equal(r.role,'main');assert.equal(r.version,'published');assert.equal(A.inspectText(title+'\nAccepted Manuscript\nAbstract\nPublished online 2025',{title}).version,'accepted');
});
test('article titles containing supporting-information words are not supplemental headers',()=>{
 const title='Supporting Information Processing in Ecological Models';const r=A.inspectText(title+'\nVersion of Record\nAbstract\nA synthetic research article.',{title});assert.equal(r.role,'main');assert.equal(r.version,'published');
});
test('preprints rank below published and accepted versions and unknowns remain visibly unknown',()=>{
 assert.equal(A.versionHint('bioRxiv preprint doi: 10.1000/example'),'preprint');assert.equal(A.versionHint('Accepted 15 June 2025'),'unknown');assert.equal(A.inspectText('').role,'unknown');assert.equal(A.plan([{key:'pre',title:'Preprint'},{key:'accepted',title:'Author accepted manuscript'}]).mainKey,'accepted');assert.match(A.plan([{key:'unknown',title:'PDF'}]).selectionReason,/版本未明确/);
});

test('PDF metadata correspondence uses the header DOI even when the filename claims a different paper',()=>{
 const title='Correct original parent paper about microbial diversity',foreign=A.inspectText('DOI: 10.1111/gcb.16387\nA different research paper\nAbstract\nEvidence',{title,doi:'10.1038/ncomms10541'});assert.equal(foreign.parentMatch,'mismatch');assert.equal(foreign.detectedDOI,'10.1111/gcb.16387');const good=A.inspectText('DOI: 10.1038/ncomms10541\n'+title+'\nAbstract',{title,doi:'10.1038/ncomms10541'});assert.equal(good.parentMatch,'match');const p=A.plan([{key:'foreign',version:'published',parentMatch:'mismatch'},{key:'right',version:'accepted',parentMatch:'match'}]);assert.equal(p.mainKey,'right');assert.equal(A.plan([{key:'foreign',parentMatch:'mismatch'}]).mainKey,'');
});
test('DOI normalization accepts standard prefixes, removes unmatched URL punctuation and rejects non-DOI values',()=>{assert.equal(A.normalizeDOI('https://doi.org/10.1000/ABC).'),'10.1000/abc');assert.equal(A.normalizeDOI('ordinary title'),'');assert.equal(A.normalizeDOI('10.1000/(abc)'),'10.1000/(abc)');});
