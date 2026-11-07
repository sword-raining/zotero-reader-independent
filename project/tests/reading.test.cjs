const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const R=require('../content/reading-core.js');
const source=R.paper('An observational survey sampled 24 grassland sites.\n\nSoil moisture was positively associated with microbial biomass. The design does not establish causation.','Synthetic source');
function fixture(){
 const evidence=[{paragraph_id:'P0002',quote:'Soil moisture was positively associated with microbial biomass.'}];
 const draft={articleInfo:R.INFO_FIELDS.map(([key])=>({key,entries:[{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]})),sections:R.SECTIONS.map(([key])=>({key,entries:[{id:key+'-1',text:'土壤水分与微生物生物量呈正相关。',kind:key==='publication'?'interpretation':'reported',evidence:structuredClone(evidence)}]}))};
 const review={checks:R.claimSections(draft).map(s=>({entry_id:s.entries[0].id,verdict:'supported',reason:'文本明确报告关联。',evidence:s.key.startsWith('info.')?[]:structuredClone(evidence),numeric_detail:'acceptable'})),omissions:[],notes:'仅依据解析文本。'};
 return {draft,review};
}
test('new notes require all three substantive front sections; legacy loading is explicit',()=>{
 const {draft}=fixture();
 assert.deepEqual(R.SECTIONS.slice(0,3).map(s=>s[1]),['研究背景','为什么要开展这项研究','为什么能发表在这个期刊']);
 const missing=structuredClone(draft);missing.sections=missing.sections.filter(s=>s.key!=='publication');
 assert.throws(()=>R.parseDraft(JSON.stringify(missing)),{code:'STRUCTURE'});
 const legacy={sections:R.LEGACY_SECTIONS.map(([key])=>({key,entries:[{id:key+'-1',text:'旧版观点',kind:'reported',evidence:[]}]}))};
 assert.throws(()=>R.parseDraft(JSON.stringify(legacy)),{code:'STRUCTURE'});
 const loaded=R.parseDraft(JSON.stringify(legacy),{allowLegacy:true});
 assert.deepEqual(R.sectionsFor(loaded),R.LEGACY_SECTIONS);
 assert.match(R.renderDraft(loaded),/## 研究问题与依据/);assert.ok(!R.renderDraft(loaded).includes('## 为什么能发表在这个期刊'));
});
test('publication analysis cannot be promoted to reported fact even when a verifier agrees',()=>{
 const {draft,review}=fixture(),entry=draft.sections.find(s=>s.key==='publication').entries[0];
 entry.kind='reported';const result=R.assess(draft,review,source);
 assert.equal(result.status,'needs_review');assert.ok(result.majorIssues.some(i=>i.entry_id===entry.id));
 entry.kind='interpretation';assert.equal(R.assess(draft,review,source).status,'checked');
});
test('author explanations retain attribution and journal limits appear alongside publication analysis',()=>{
 const {draft,review}=fixture();draft.sections.find(s=>s.key==='mechanisms').entries[0].kind='author_interpretation';
 assert.doesNotThrow(()=>R.parseDraft(JSON.stringify(draft)));
 const text=R.renderDraft(draft,R.assess(draft,review,source));
 assert.match(text,/（作者解释）/);assert.match(text,/不代表编辑或审稿人的实际录用理由/);
 for(const text of [R.generationPrompt('ecology',source),R.verificationPrompt(source,draft),R.repairPrompt(source,draft,review,R.assess(draft,review,source),R.defaultTemplateText('ecology'))])assert.ok(text.includes('录用理由'));
});
test('two fixed templates and no free-question interface',()=>{
 assert.deepEqual(Object.keys(R.TEMPLATES),['ecology','general']);
 assert.throws(()=>R.template('free'),{code:'TEMPLATE'});
 const ui=fs.readFileSync(path.join(__dirname,'../content/codex.xhtml'),'utf8');
 assert.ok(!ui.includes('zrc-question')&&!ui.includes('<html:textarea'));
 assert.ok(ui.includes('zrc-template')&&!ui.includes('逐条核验报告'));
});
test('full source is partitioned without truncating scientific text',()=>{
 const text=('微生物🌱'.repeat(500))+' FINAL_SENTINEL';
 const p=R.paper(text);
 assert.equal(p.paragraphs.map(x=>x.text).join(''),text);
 assert.ok(new Set(p.paragraphs.map(x=>x.id)).size===p.paragraphs.length);
 assert.throws(()=>R.paper('a'.repeat(400001)),{code:'TEXT_SIZE'});
});
test('verification receives original source and claims, not generator-proposed citations',()=>{
 const {draft}=fixture();draft.sections[0].entries[0].evidence[0].quote='GENERATOR_PRIVATE_CITATION';
 const p=R.verificationPrompt(source,draft);
 assert.ok(p.includes('An observational survey'));
 assert.ok(p.includes('motivation-1'));
 assert.ok(!p.includes('GENERATOR_PRIVATE_CITATION'));
 assert.ok(R.generationPrompt('ecology',source).includes('不逐项抄录 P 值'));
});
test('complete matched evidence and supported coverage are required for checked status',()=>{
 const {draft,review}=fixture();
 assert.equal(R.assess(draft,review,source).status,'checked');
 review.checks.pop();
 assert.equal(R.assess(draft,review,source).status,'needs_review');
});
test('fabricated generator quotes cannot be rubber-stamped by verifier',()=>{
 const {draft,review}=fixture();draft.sections[0].entries[0].evidence[0].quote='A completely invented source passage.';
 assert.equal(R.assess(draft,review,source).status,'needs_review');
});
test('fabricated verifier evidence and nonexistent paragraph IDs fail locally',()=>{
 for(const change of [e=>{e.quote='invented evidence statement';},e=>{e.paragraph_id='P9999';}]){
  const {draft,review}=fixture();change(review.checks[0].evidence[0]);
  assert.equal(R.assess(draft,review,source).status,'needs_review');
 }
});
test('unsupported, contradicted, overstated, and uncertain claims never pass',()=>{
 for(const verdict of ['unsupported','contradicted','overstated','uncertain']){
  const {draft,review}=fixture();review.checks[0].verdict=verdict;
  assert.equal(R.assess(draft,review,source).status,'needs_review');
 }
});
test('duplicate, unknown, and omitted check identities cannot fake coverage',()=>{
 for(const mutate of [r=>r.checks.push({...r.checks[0]}),r=>r.checks.push({...r.checks[0],entry_id:'unknown'}),r=>{r.checks=[];}]){
  const {draft,review}=fixture();mutate(review);assert.equal(R.assess(draft,review,source).status,'needs_review');
 }
});
test('minor number detail does not block an otherwise supported note, but material omissions do',()=>{
 const {draft,review}=fixture();review.checks.find(c=>c.entry_id==='results-1').numeric_detail='unnecessary';
 assert.equal(R.assess(draft,review,source).status,'checked');
 assert.equal(R.assess(draft,review,source).minorIssues.length,1);
 const b=fixture();b.review.omissions.push({section:'design',issue:'遗漏观察研究的限定条件',evidence:[{paragraph_id:'P0001',quote:'An observational survey sampled 24 grassland sites.'}]});
 assert.equal(R.assess(b.draft,b.review,source).status,'needs_review');
});
test('not-reported entries still require explicit independent review',()=>{
 const {draft,review}=fixture();draft.sections[0].entries[0].kind='not_reported';draft.sections[0].entries[0].text='所提供文本中未报告微生物活性测定。';draft.sections[0].entries[0].evidence=[];review.checks[0].evidence=[];
 assert.equal(R.assess(draft,review,source).status,'checked');
 review.checks[0].verdict='uncertain';assert.equal(R.assess(draft,review,source).status,'needs_review');
});
test('malformed or incomplete structured outputs are rejected',()=>{
 assert.throws(()=>R.parseReview('通过，没有问题'),{code:'STRUCTURE'});
 assert.throws(()=>R.parseReview('{}'),{code:'STRUCTURE'});
 assert.throws(()=>R.parseDraft('{"sections":[]}'),{code:'STRUCTURE'});
 const {draft,review}=fixture();assert.deepEqual(R.parseDraft(JSON.stringify(draft)),draft);assert.deepEqual(R.parseReview(JSON.stringify(review)),review);
});
test('not-reported label cannot hide an affirmative unsupported assertion',()=>{
 const {draft,review}=fixture();draft.sections[0].entries[0].kind='not_reported';draft.sections[0].entries[0].evidence=[];review.checks[0].evidence=[];
 assert.equal(R.assess(draft,review,source).status,'needs_review');
});
test('rendering distinguishes draft, checked, and needs-review artifacts without a separate report',()=>{
 const {draft,review}=fixture();assert.match(R.renderDraft(draft),/精读草稿/);
 const ok=R.assess(draft,review,source);assert.match(R.renderDraft(draft,ok),/文献精读/);
 review.checks[0].verdict='overstated';const bad=R.assess(draft,review,source);
 assert.match(R.renderDraft(draft,bad),/【待核实】/);
 assert.ok(R.issueSummary(draft,bad).includes('土壤水分'));
 assert.equal(R.renderReport,undefined);
});
test('repair requests preserve original source, draft and diagnostic feedback, then require a new check',()=>{
 const {draft,review}=fixture();review.checks[0].verdict='contradicted';const assessment=R.assess(draft,review,source);
 const prompt=R.repairPrompt(source,draft,review,assessment,R.defaultTemplateText('ecology'));
 assert.ok(prompt.includes('An observational survey')&&prompt.includes('contradicted')&&prompt.includes('修订稿将再次逐条检查'));
 assert.equal(R.MAX_REPAIR_ROUNDS,2);
});
