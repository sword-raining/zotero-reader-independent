const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../content/engine-core.js'),N=require('../content/note-core.js'),R=require('../content/reading-core.js');
test('reasoning levels follow each returned model and survive cached catalog normalization',()=>{
 const models=E.normalizeModels([{model:'a',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'},{reasoningEffort:'made-up'}],defaultReasoningEffort:'low'},{slug:'b',supported_reasoning_levels:[{effort:'medium'}],default_reasoning_level:'medium'}]);
 assert.deepEqual(models[0].reasoningEfforts,['low','high']);assert.deepEqual(E.normalizeModels(models),models);
 assert.deepEqual(E.effortChoices({engine:'codex',model:'a'},{models}).map(c=>c.value),['','low','high']);
 assert.equal(E.validEffort({engine:'codex',model:'a',effort:'medium'},{models}),false);
 assert.equal(E.validEffort({engine:'codex',model:'',effort:'high'},{models}),false);
 assert.notEqual(E.healthKey({engine:'codex',model:'a',effort:'high'}),E.healthKey({engine:'codex',model:'a'}));
});
test('Antigravity slider maps only advertised variants and leaves ungrouped models intact',()=>{
 const catalog={models:[{id:'gemini-test-low',label:'Gemini Test (Low)'},{id:'gemini-test-high',label:'Gemini Test (High)'},{id:'standalone',label:'Standalone'}]};
 const groups=E.modelChoices('antigravity',catalog);assert.deepEqual(groups.map(g=>g.id),['gemini-test','standalone']);assert.equal(groups[0].label,'Gemini Test');
 const stage={engine:'antigravity',model:'gemini-test-low',effort:'low'};
 assert.deepEqual(E.effortChoices(stage,catalog).map(c=>[c.value,c.model]),[['low','gemini-test-low'],['high','gemini-test-high']]);
 assert.equal(E.validEffort(stage,catalog),true);assert.equal(E.validEffort({...stage,effort:'high'},catalog),false);
 const args=E.agyArguments({model:'gemini-test-high',effort:'high',settingsPath:'x',timeoutMs:60000});assert.equal(args[args.indexOf('--effort')+1],'high');
 assert.throws(()=>E.agyArguments({model:'gemini-test-high',effort:'ultra',settingsPath:'x',timeoutMs:60000}));
});
test('availability belongs to an actually tested engine/model and expires on time or CLI changes',()=>{
 const stage={engine:'codex',model:'model-a'},now=Date.parse('2026-11-05T10:00:00Z'),catalog={version:'1'};
 const r={key:E.healthKey(stage),success:true,version:'1',testedAt:'2026-11-05T09:00:00Z'};
 assert.equal(E.healthState(null,stage,catalog,now).state,'untested');
 assert.equal(E.healthState(r,stage,catalog,now).state,'available');
 for(const changed of [{engine:'antigravity',model:'model-a'},{engine:'codex',model:'model-b'},{engine:'codex',model:''}])assert.equal(E.healthState(r,changed,catalog,now).state,'untested');
 assert.equal(E.healthState(r,stage,{version:'2'},now).state,'untested');
 assert.equal(E.healthState(r,stage,catalog,now+86400000).state,'untested');
 assert.equal(E.healthState(r,stage,catalog,now-7200000).state,'untested');
 assert.equal(E.healthState({...r,success:false},stage,catalog,now).state,'unavailable');
});
test('Codex catalogs use returned IDs and filter hidden, duplicate and non-text models',()=>{
 const rows=[{model:'model-a',displayName:'A',isDefault:true},{model:'model-a'},{slug:'hidden',visibility:'hide'},{model:'image-only',inputModalities:['image']},{slug:'model-b',display_name:'B'}];
 assert.deepEqual(E.normalizeModels(rows).map(m=>m.id),['model-a','model-b']);
 assert.equal(E.normalizeModels(rows)[0].isDefault,true);
});
test('Antigravity model parsing does not invent IDs from headings or log text',()=>{
 const rows=E.parseAgyModels('Fetching available models...\nmodel\tname\ngemini-test-low\tGemini Test (Low)\nclaude-test  Claude Test\n');
 assert.deepEqual(rows.map(m=>m.id),['gemini-test-low','claude-test']);
});
test('Antigravity arguments use stream stdin, schema and restricted session settings',()=>{
 const a=E.agyArguments({model:'gemini-test-low',schemaPath:'C:\\schema.json',settingsPath:'C:\\settings.json',timeoutMs:60000});
 assert.ok(a.includes('--input-format')&&a.includes('--json-schema'));
 assert.ok(!a.some(x=>/dangerously|continue|conversation/.test(x)));
 assert.equal(E.agySettings.toolPermission,'strict');
 for(const x of ['command(*)','write_file(*)','mcp(*)'])assert.ok(E.agySettings.permissions.deny.includes(x));
});
test('Antigravity stream reader accepts one final result and rejects multiple turns',()=>{
 const r=E.agyReader();r.push('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}');assert.equal(r.finish().response,'ok');
 const double=E.agyReader();double.push('{"event":"result","result":{}}\n{"event":"result","result":{}}\n');assert.equal(double.finish(),null);
});
test('editable template preferences cannot remove the fixed evidence and verification instructions',()=>{
 const prompt=R.generationPrompt('ecology',R.paper('Synthetic text is provided.'),'CUSTOM_FOCUS_TEST：重点关注研究设计。');
 assert.ok(prompt.includes('CUSTOM_FOCUS_TEST')&&prompt.includes('每条 reported/interpretation 必须提供')&&prompt.includes('相关关系不能'));
 assert.throws(()=>R.validateTemplateText(''),{code:'TEMPLATE_TEXT'});assert.throws(()=>R.validateTemplateText('x'.repeat(8001)),{code:'TEMPLATE_TEXT'});
});
test('note naming validates placeholders and preserves draft status even if omitted or truncated',()=>{
 assert.throws(()=>N.validateName('{unknown}'),{code:'NOTE_NAME'});
 const values={title:'A'.repeat(300),pdf:'paper.pdf',date:'2026-11-05',template:'生态',status:'待复核草稿'};
 const title=N.noteTitle('{date}_{title}',values,'needs_review');assert.ok(title.length<=200&&title.endsWith('【待复核草稿】'));
 assert.equal(N.noteTitle('{pdf}_{template}',values,'checked'),'paper.pdf_生态');
 assert.equal(N.localDate('2026-11-05T20:00:00Z'),'2026-11-06');
});
test('edited Markdown is rendered as text and cannot inject HTML or JavaScript',()=>{
 const html=N.markdownHTML('# 文本核验完成：未发现不一致\n\n## 人工修改\n- <script>alert(1)</script>\n[link](javascript:alert(1))');
 assert.ok(!html.includes('<script>')&&!html.includes('<a '));assert.ok(html.includes('&lt;script&gt;')&&html.includes('人工修改'));
});
test('Codex model discovery follows handshake, pagination and visibility rules',async()=>{
 const catalog=await E.codexCatalog(async(exe,args,opts)=>{
  for(const name of ['plugins','plugin_discovery_prefetch','shell_snapshot'])assert.ok(args.some((a,i)=>a==='--disable'&&args[i+1]===name));
  let initialized=false;const stdin={write:async text=>{
   const m=JSON.parse(text);let result;
   if(m.method==='initialize')result={};
   if(m.method==='initialized'){initialized=true;return;}
   if(m.method==='model/list'){
    assert.ok(initialized);result=m.params.cursor?{data:[{model:'second'}],nextCursor:null}:{data:[{model:'first'},{model:'hidden',hidden:true}],nextCursor:'page-two'};
   }
   queueMicrotask(()=>opts.onStdout(JSON.stringify({id:m.id,result})+'\n'));
  }};
  await opts.writeInput(stdin);return {exitCode:0};
 },{});
 assert.deepEqual(catalog.map(m=>m.id),['first','second']);
});
