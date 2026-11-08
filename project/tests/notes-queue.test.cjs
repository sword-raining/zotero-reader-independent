const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const N=require('../content/note-core.js');
const Q=require('../content/queue-core.js');
const R=require('../content/reading-core.js');
function noteFixture(status='checked'){
 const draft={sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key+'-1',text:'研究结果 <img src=x onerror=alert(1)> & 需核验',kind:key==='publication'?'interpretation':key==='mechanisms'?'author_interpretation':'reported',evidence:[]}]}))};
 const assessment={status:'checked',checkedEntries:9,totalEntries:9,checks:draft.sections.map(s=>({entry_id:s.entries[0].id,passed:true,issues:[],check:{verdict:'supported',reason:'测试依据',evidence:[{paragraph_id:'P0001',quote:'Evidence <script>unsafe</script>'}]}}))};
 return {workflow:{status,templateID:'ecology',createdAt:'2026-11-05T00:00:00Z'},draft,assessment,
  review:{notes:'局限',omissions:[]},title:'测试论文',pdfTitle:'<unsafe.pdf>',pdfURL:'zotero://open-pdf/library/items/ABCD1234',sections:R.SECTIONS,runID:'12345678-abcdefgh'};
}
test('note HTML escapes model and source content and keeps only controlled links',()=>{
 const html=N.render(noteFixture());
 assert.ok(!html.reading.includes('<img')&&html.verification===undefined);
 assert.ok(html.reading.includes('&lt;img')&&html.reading.includes('&lt;unsafe.pdf&gt;'));
 assert.ok(html.reading.includes('zotero://open-pdf/library/items/ABCD1234'));
 assert.throws(()=>N.sourceLink('javascript:alert(1)','bad'),{code:'NOTE_LINK'});
});
test('note front sections and claim attribution survive import into Zotero HTML',()=>{
 const f=noteFixture();f.draft.sections[0].entries[0].evidence=[{paragraph_id:'P0001',quote:'Synthetic full verification evidence, retained internally.'}];const before=JSON.stringify({draft:f.draft,assessment:f.assessment});
 const html=N.render(f).reading;
 assert.equal(JSON.stringify({draft:f.draft,assessment:f.assessment}),before);assert.ok(!html.includes('<h2>原文依据</h2>')&&!html.includes('Synthetic full verification evidence'));assert.ok(html.includes(f.pdfURL));
 const manual=N.render({...f,manualEdited:true,manualMarkdown:'## 原文依据\n用户自己写的引用应保留。'}).reading;assert.ok(manual.includes('原文依据')&&manual.includes('用户自己写的引用应保留'));
 const headings=['研究背景','为什么要开展这项研究','为什么能发表在这个期刊'];
 assert.ok(headings.every(h=>html.includes('<h2>'+h+'</h2>')));
 assert.ok(html.indexOf(headings[0])<html.indexOf(headings[1])&&html.indexOf(headings[1])<html.indexOf(headings[2]));
 assert.ok(html.includes('【作者解释】')&&html.includes('【读后判断】')&&html.includes('不代表编辑或审稿人的实际录用理由'));
});
test('note titles visibly distinguish checked, needs-review and incomplete drafts',()=>{
 assert.match(N.render(noteFixture()).reading,/<h1>精读笔记｜作者未提供 年份未提供｜测试论文<\/h1>/);
 assert.match(N.render(noteFixture('needs_review')).reading,/需核对草稿/);
 assert.match(N.render(noteFixture('verification_incomplete')).reading,/未完成检查/);
});
test('a local recomputation cannot upgrade a previously flagged workflow',()=>{
 const f=noteFixture('needs_review');assert.equal(N.render(f).status,'needs_review');
 const g=noteFixture();g.assessment.status='needs_review';assert.equal(N.render(g).status,'needs_review');
});
test('same-run markers are role-specific and reject path-like identifiers',()=>{
 assert.notEqual(N.identity('12345678-abcdefgh','reading'),N.identity('12345678-abcdefgh','verification'));
 assert.throws(()=>N.identity('../other','reading'));
 assert.throws(()=>N.identity('12345678-abcdefgh','arbitrary'));
 const h=N.render(noteFixture());assert.ok(h.reading.includes(N.identity('12345678-abcdefgh','reading')));
});
const eligible={enabled:true,event:'add',isPDF:true,deleted:false,synced:false,libraryID:1,userLibraryID:1,generated:false,epoch:4,currentEpoch:4};
test('automatic capture is limited to newly added local PDFs while enabled',()=>{
 assert.equal(Q.captureAllowed(eligible),true);
 for(const patch of [{enabled:false},{event:'modify'},{isPDF:false},{deleted:true},{synced:true},{libraryID:2},{generated:true},{epoch:3}])assert.equal(Q.captureAllowed({...eligible,...patch}),false);
});
test('duplicate add notifications do not enqueue repeated model runs',()=>{
 const state={jobs:{}},item={id:1,libraryID:1,key:'ABCD1234',title:'PDF'};
 assert.equal(Q.enqueue(state,item).created,true);
 assert.equal(Q.enqueue(state,item).created,false);
 state.jobs['1:ABCD1234'].state='done';assert.equal(Q.enqueue(state,item).created,false);
 assert.equal(Q.enqueue(state,item,{trigger:'manual'}).created,true);
 assert.equal(state.jobs['1:ABCD1234'].attempt,2);
});
test('a growing or missing file remains pending until stable',()=>{
 const job={};assert.equal(Q.ready(job,null,0,2000),false);
 assert.equal(Q.ready(job,{size:100,lastModified:1},0,2000),false);
 assert.equal(Q.ready(job,{size:110,lastModified:2},1500,2000),false);
 assert.equal(Q.ready(job,{size:110,lastModified:2},2500,2000),false);
 assert.equal(Q.ready(job,{size:110,lastModified:2},3500,2000),true);
});
test('FIFO queue respects pause, active work and disabled automatic processing',()=>{
 const state={jobs:{a:{state:'queued',trigger:'auto',createdAt:1},b:{state:'queued',trigger:'manual',createdAt:2}}};
 assert.equal(Q.next(state,{enabled:true}),state.jobs.a);
 assert.equal(Q.next(state,{enabled:false}),state.jobs.b);
 assert.equal(Q.next(state,{enabled:true,paused:true}),null);
 assert.equal(Q.next(state,{enabled:true,busy:true}),null);
});
test('interrupted jobs are not silently rerun on restart',()=>{
 const state={jobs:{a:{state:'running'},b:{state:'done'}}};Q.recover(state);
 assert.equal(state.jobs.a.state,'failed');assert.equal(state.jobs.b.state,'done');
});
test('settings have the automation checkbox and no separate note-save button',()=>{
 const dir=path.join(__dirname,'../content');
 const prefs=fs.readFileSync(path.join(dir,'preferences.xhtml'),'utf8');
 assert.ok(prefs.includes('zri-auto-enabled')&&prefs.includes('默认关闭'));
 assert.ok(prefs.includes('不扫描旧文献'));
 const dialog=fs.readFileSync(path.join(dir,'codex.xhtml'),'utf8');
 assert.ok(dialog.includes('开始精读'));assert.ok(!dialog.includes('保存到 Zotero'));
});


test('note rendering adds each attribution once without rewriting model claims or manual Markdown',()=>{
 const f=noteFixture();for(const s of f.draft.sections){const e=s.entries[0],label=R.attributionLabel(s.key,e.kind);if(label)e.text=label+label+' 正文 <unsafe>。';}
 const original=structuredClone(f.draft),html=N.render(f).reading;assert.deepEqual(f.draft,original);assert.ok(html.includes('【读后判断】 正文 &lt;unsafe&gt;。'));assert.ok(html.includes('【作者解释】 正文 &lt;unsafe&gt;。'));assert.ok(!html.includes('【作者解释】【作者解释】'));
 const manual='- 【作者解释】【作者解释】 人工文本保留';const edited=N.render({...f,manualEdited:true,manualMarkdown:manual});assert.ok(edited.reading.includes('【作者解释】【作者解释】 人工文本保留'));
});
