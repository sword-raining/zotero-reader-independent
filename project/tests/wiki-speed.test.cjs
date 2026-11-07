const {test}=require('node:test'),assert=require('node:assert/strict');
const B=require('../content/bibliography-core.js'),N=require('../content/note-core.js'),W=require('../content/wiki-core.js'),E=require('../content/engine-core.js');
const bib=B.fromItem({title:'Title: "one"',date:'2026/2',creators:[{creatorType:'author',firstName:'Li-Xin',lastName:'Xu'}],tags:[{tag:'/unread'},{tag:'necromass'}],DOI:'10.0000/test'},
 {itemKey:'H5J2C5PU',attachmentKey:'U2U5G5S9',libraryID:1,itemURI:'http://zotero.org/users/9368865/items/H5J2C5PU',attachmentTitle:'paper.pdf'});
const workflow={wikiInput:true,createdAt:'2026-11-06T00:00:00Z',status:'checked',templateID:'ecology',readingNaming:N.DEFAULT_NAMES};
test('Wiki frontmatter and note title share author/year/title and stable Zotero identity',()=>{
 const md=W.decorate('# 文献精读\n\n## 研究背景\n正文',bib,workflow);
 const fields=Object.fromEntries(md.split('\n').slice(1,md.split('\n').indexOf('---',1)).map(line=>{const i=line.indexOf(':');return[line.slice(0,i),JSON.parse(line.slice(i+1))];}));
 assert.equal(fields.title,'Xu 2026｜Title: "one"');assert.equal(fields.reading_note_title,'精读笔记｜Xu 2026｜Title: "one"');
 assert.deepEqual(fields.source_ids,['zotero:9368865:H5J2C5PU']);assert.equal(fields.zotero_item_key,'H5J2C5PU');assert.equal(fields.wiki_stage,'input');assert.match(fields.review_status,/human-review-pending/);
 assert.deepEqual(fields.keywords,['necromass']);assert.deepEqual(fields.sources,['source.json']);
 const html=N.markdownHTML(md);assert.ok(html.includes('研究背景')&&!html.includes('source_ids')&&!html.includes('record_type'));
});
test('draft exports cannot claim verification, custom titles persist, and local identity is explicit',()=>{
 const draft=W.decorate('# 精读草稿\n正文',bib,{...workflow,status:'draft',readingNaming:{reading:'自定｜{author}-{year}'}});
 assert.ok(draft.includes('draft; verification-incomplete')&&!draft.includes('ai-text-checked'));
 assert.ok(draft.includes('自定｜Xu-2026'));
 const local=B.fromItem({key:'ABCD1234'},{itemKey:'ABCD1234',libraryID:1});assert.equal(local.sourceID,'zotero:local:1:ABCD1234');
 const receipt=W.receipt(bib,{key:'U2U5G5S9',sha256:'abc',name:'paper.pdf'});assert.equal(receipt.library_id,'9368865');assert.equal(receipt.item_key,'H5J2C5PU');assert.equal(receipt.attachments[0].sha256,'abc');
});
test('quick testing selects only advertised low effort and never mutates the reading configuration',()=>{
 const c={models:[{id:'gpt-test',label:'test',reasoningEfforts:['low','medium','high']}]},stage={engine:'codex',model:'gpt-test',effort:'high'};
 assert.deepEqual(E.quickStage(stage,c),{...stage,effort:'low'});assert.equal(stage.effort,'high');
 const a={models:[{id:'gemini-test-low',label:'Gemini (Low)'},{id:'gemini-test-high',label:'Gemini (High)'}]},high={engine:'antigravity',model:'gemini-test-high',effort:'high'};
 assert.equal(E.quickStage(high,a).model,'gemini-test-low');assert.equal(high.model,'gemini-test-high');
 assert.equal(E.connectionKey(high,a),E.connectionKey(E.quickStage(high,a),a));assert.notEqual(E.healthKey(high),E.healthKey(E.quickStage(high,a)));
 assert.equal(E.quickStage({...stage,model:''},c).effort,'');
});
test('the latest quick result is not hidden by an older full-configuration success',()=>{
 const full={state:'available',label:'old',testedAt:'2026-11-06T02:07:00Z'},quick={state:'available',label:'quick',testedAt:'2026-11-06T03:05:00Z',testedStage:{effort:'low'}};
 const latest=E.latestHealth(full,quick);assert.equal(latest.scope,'connectivity');assert.match(latest.label,/低档/);assert.equal(latest.testedAt,quick.testedAt);
 assert.equal(E.latestHealth({...full,testedAt:'2026-11-06T03:10:00Z'},quick).scope,'full');
});
test('a timed-out request is shown as unconfirmed rather than a proved-unavailable model',()=>{
 const stage={engine:'codex',model:'x'},testedAt='2026-11-06T03:05:00Z';
 const h=E.healthState({key:E.healthKey(stage),success:false,errorCode:'TIMEOUT',testedAt},stage,{},Date.parse(testedAt)+1000);
 assert.equal(h.state,'untested');assert.match(h.label,/超时/);assert.equal(h.testedAt,testedAt);
});
