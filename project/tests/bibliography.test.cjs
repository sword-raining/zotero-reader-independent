const {test}=require('node:test'),assert=require('node:assert/strict');
const B=require('../content/bibliography-core.js'),R=require('../content/reading-core.js'),N=require('../content/note-core.js');
const item={itemType:'journalArticle',title:'Synthetic study',creators:[{creatorType:'author',firstName:'Ada',lastName:'Example'},{creatorType:'author',name:'Test Consortium'},{creatorType:'editor',name:'Editor'}],publicationTitle:'Synthetic Journal',date:'2026/2',volume:'32',issue:'2',pages:'e-test',DOI:'10.0000/test',libraryCatalog:'12.5 (Q1)',callNumber:'1',extra:''};
test('existing Zotero One fields provide metrics and author order without a network lookup',()=>{
 const b=B.fromItem(item,{oneAvailable:true});assert.deepEqual(b.authors,['Ada Example','Test Consortium']);
 assert.equal(b.metrics.impactFactor,'12.5');assert.equal(b.metrics.jcrQuartile,'Q1');assert.equal(b.metrics.casDivision,'1区');assert.ok(b.metrics.source.startsWith('Zotero One'));
 assert.equal(b.metrics.year,'');assert.equal(new Map(B.rows(b)).get('指标年份'),'Zotero未记录');
});
test('publication date and provider update dates are not silently treated as metric years',()=>{
 assert.equal(B.fromItem({...item,extra:'Zotero One updated: 2026-06-17'}).metrics.year,'');
 assert.equal(B.fromItem({...item,extra:'JCR年度: 2026'}).metrics.year,'');
 assert.equal(B.fromItem({...item,extra:'JIF Year: 2025'}).metrics.year,'2025');
 assert.equal(B.fromItem({...item,extra:'影响因子年度：2024'}).metrics.year,'2024');
});
test('ordinary catalogues/call numbers are not invented impact factors or CAS divisions',()=>{
 const b=B.fromItem({...item,libraryCatalog:'Crossref',callNumber:'QA76.9'});assert.equal(b.metrics.impactFactor,'');assert.equal(b.metrics.casDivision,'');
 assert.equal(B.fromItem({...item,itemType:'book'}).metrics.impactFactor,'');
 assert.equal(B.fromItem({...item,itemType:'conferencePaper',libraryCatalog:'',callNumber:'CCF A'}).metrics.ccf,'A');
 assert.equal(B.fromItem({...item,libraryCatalog:'',callNumber:'2'}, {oneAvailable:true}).metrics.casDivision,'2区');
});
test('absent parent metadata falls back to extracted title/authors and never invents correspondence',()=>{
 const info=[{key:'title',entries:[{id:'a',text:'PDF title',kind:'reported'}]},{key:'authors',entries:[{id:'b',text:'PDF Author',kind:'reported'}]}];
 const rows=new Map(B.rows(B.fromItem({}, {attachmentTitle:'filename.pdf'}),info));assert.equal(rows.get('题目'),'PDF title');assert.equal(rows.get('作者'),'PDF Author');assert.equal(rows.get('通讯作者'),'未明确标注');
});
test('title/affiliation claims require independent coverage and original quotes',()=>{
 const source=R.paper('Affiliation: Fictional Soil Institute. Corresponding author: Ada Example.');
 const draft={articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:key==='affiliations'?'Fictional Soil Institute':'所提供文本未提供此字段',kind:key==='affiliations'?'reported':'not_reported',evidence:key==='affiliations'?[{paragraph_id:'P0001',quote:'Affiliation: Fictional Soil Institute.'}]:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key,text:'所提供文本未报告此项',kind:'not_reported',evidence:[]}]}))};
 const review={checks:R.claimSections(draft).flatMap(s=>s.entries.map(e=>({entry_id:e.id,verdict:'supported',reason:'test',numeric_detail:'acceptable',evidence:e.evidence}))),omissions:[],notes:''};
 assert.equal(R.assess(draft,review,source).status,'checked');review.checks=review.checks.filter(c=>c.entry_id!=='info-affiliations');assert.equal(R.assess(draft,review,source).status,'needs_review');
 assert.ok(R.verificationPrompt(source,draft).includes('info.affiliations'));
 assert.throws(()=>R.parseDraft(JSON.stringify({sections:draft.sections})),{code:'STRUCTURE'});
 assert.doesNotThrow(()=>R.parseDraft(JSON.stringify({sections:draft.sections}),{allowLegacy:true}));
});
test('bibliographic HTML is escaped and edited Markdown does not get a duplicate header',()=>{
 const b=B.fromItem({...item,title:'<script>bad()</script>'});
 const args={workflow:{status:'checked',templateID:'general',createdAt:'2026-11-06T00:00:00Z',bibliography:b},draft:{sections:[]},assessment:{status:'checked'},title:'test',pdfTitle:'test.pdf',pdfURL:'zotero://open-pdf/library/items/ABCD1234',sections:[],runID:'12345678-test'};
 const html=N.render(args).reading;assert.ok(!html.includes('<script>')&&html.includes('&lt;script&gt;'));assert.ok(html.includes('12.5')&&html.includes('Q1'));
 const edited=N.render({...args,manualEdited:true,manualMarkdown:'## 文献信息\n- 作者：人工编辑'}).reading;
 assert.equal((edited.match(/文献信息/g)||[]).length,1);assert.ok(edited.includes('人工编辑'));
});
