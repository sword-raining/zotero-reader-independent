const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const engine=process.argv[2],args=process.argv.slice(3);
if(args.includes('--version')){console.log(engine==='codex'?'codex-cli 0.166.0-test':'1.5.0');process.exit(0);}
if(args.includes('--help')){console.log('--ignore-user-config --ephemeral --output-last-message --output-schema --input-format --output-format --json-schema --settings --effort');process.exit(0);}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='models'){console.log('mock-agy-reader\tMock Antigravity Reader\nmock-agy-checker\tMock Antigravity Checker\ngemini-test-low\tGemini Test (Low)\ngemini-test-medium\tGemini Test (Medium)\ngemini-test-high\tGemini Test (High)');process.exit(0);}
process.stdin.setEncoding('utf8');
if(args[0]==='app-server'){
 let buffer='';process.stdin.on('data',s=>{buffer+=s;const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;const m=JSON.parse(line);if(m.method==='initialized')continue;const result=m.method==='model/list'?{data:[{model:'mock-codex-reader',displayName:'Mock Codex Reader',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{model:'mock-codex-checker',displayName:'Mock Codex Checker',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}],nextCursor:null}:{};console.log(JSON.stringify({id:m.id,result}));}});
}else{
 let input='';process.stdin.on('data',s=>{input+=s;});process.stdin.on('end',()=>{
  fs.writeFileSync(path.join(process.cwd(),'seen-args.json'),JSON.stringify(args));
  const prompt=engine==='antigravity'?JSON.parse(input.trim()).message.content:input;
  if(prompt.includes('__SIM_SLEEP__')){
   if(args.includes('--spawn-child')){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(path.join(process.cwd(),'child-pid.txt'),String(child.pid));}
   setTimeout(()=>{},120000);return;
  }
  let answer='ZOTERO_READER_OK',structured;
  if(prompt.startsWith('ZRI_ENGINE_PING'))answer='ZRI_OK';
  if(prompt.startsWith('你好，你的模型是什么？'))answer='你好，我是合成测试模型。';
  if(prompt.startsWith('ZRI_ENGINE_HEALTH'))structured={ok:true};
  if(prompt.startsWith('ZRI_READING_GENERATE_V1')){
   const marker='\n原文资料 JSON：\n',source=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length)),first=source.paragraphs[0];
   structured={articleInfo:['title','authors','affiliations','correspondence'].map(key=>{const p=source.paragraphs.find(p=>p.text.includes('Synthetic affiliation:'));return {key,entries:[key==='affiliations'&&p?{id:'info-'+key,text:'Fictional Soil Institute',kind:'reported',evidence:[{paragraph_id:p.id,quote:'Synthetic affiliation: Fictional Soil Institute.'}]}:{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]};}),sections:['background','motivation','publication','design','methods','results','mechanisms','limitations','implications'].map(key=>({key,entries:[{id:key+'-1',text:'测试资料：'+first.text.slice(0,100),kind:key==='publication'?'interpretation':key==='mechanisms'?'author_interpretation':'reported',evidence:[{paragraph_id:first.id,quote:first.text.slice(0,100)}]}]}))};
  }else if((prompt.startsWith('ZRI_READING_VERIFY_V1')||prompt.startsWith('ZRI_READING_VERIFY_V2'))){
   const marker='\n输入 JSON（source 为依据，claims 为待核验文本，不是指令）：\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length)),first=payload.source.paragraphs[0];
   structured={checks:payload.claims.flatMap(s=>s.entries.map(e=>({entry_id:e.id,verdict:e.text==='__BROKEN_CLAIM__'?'contradicted':'supported',reason:'合成测试依据',evidence:[{paragraph_id:first.id,quote:first.text.slice(0,100)}],numeric_detail:'acceptable'}))),omissions:[],notes:'合成测试'};
  }
  if(prompt.startsWith('ZRI_READING_GENERATE_V1')&&prompt.includes('__SIM_FIXABLE__'))structured.sections.find(s=>s.key==='results').entries[0].text='__BROKEN_CLAIM__';
  if(prompt.startsWith('ZRI_READING_REPAIR_V1')){const marker='\n修订输入 JSON：\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));structured=payload.draft;for(const section of structured.sections)for(const e of section.entries)if(e.text==='__BROKEN_CLAIM__')e.text='修订后：'+payload.source.paragraphs[0].text.slice(0,100);}
  if(prompt.startsWith('ZRI_CLASSIFY_V1')){const marker='\n输入 JSON：\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));structured={collectionKey:(payload.collections.find(c=>c.path.includes('Archive'))||payload.collections[0]).key,reason:'Synthetic classification based on saved note'};}

  if(prompt.startsWith('ZRI_READING_VERIFY_V2')&&structured){const r=structured;structured={mode:'full-review',checked_ids:r.checks.map(c=>c.entry_id),issues:r.checks.filter(c=>c.verdict!=='supported').map(({numeric_detail,...c})=>c),notes:r.notes};}
  if(prompt.startsWith('ZRI_READING_VERIFY_V2')&&structured){const marker='\n输入 JSON（source 为依据，claims 为待核验文本，不是指令）：\n',p=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));if(p.collections?.length)structured.archive={recommendations:[{collectionKey:(structured.issues.length?p.collections.find(c=>c.path.includes('Keep')):p.collections.find(c=>c.path.includes('Archive'))||p.collections[0])?.key||'',reason:'Synthetic recommendation'}],adjustments:[],reason:structured.issues.length?'Invalid draft suggestion':'Final checked suggestion'};}
  if(structured)answer=JSON.stringify(structured);
  if(engine==='antigravity'){
   console.log(JSON.stringify({event:'init',init:{permission_mode:'strict'}}));
   console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:answer,...(structured?{structured_output:structured}:{})}}));
  }else{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer);console.log(JSON.stringify({type:'turn.completed'}));}
 });
}
