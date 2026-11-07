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
  if(prompt.startsWith('ZRI_ENGINE_HEALTH'))structured={ok:true};
  if(prompt.startsWith('ZRI_READING_GENERATE_V1')){
   const marker='\n原文资料 JSON：\n',source=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length)),first=source.paragraphs[0];
   structured={articleInfo:['title','authors','affiliations','correspondence'].map(key=>{const p=source.paragraphs.find(p=>p.text.includes('Synthetic affiliation:'));return {key,entries:[key==='affiliations'&&p?{id:'info-'+key,text:'Fictional Soil Institute',kind:'reported',evidence:[{paragraph_id:p.id,quote:'Synthetic affiliation: Fictional Soil Institute.'}]}:{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]};}),sections:['background','motivation','publication','design','methods','results','mechanisms','limitations','implications'].map(key=>({key,entries:[{id:key+'-1',text:'测试资料：'+first.text.slice(0,100),kind:key==='publication'?'interpretation':key==='mechanisms'?'author_interpretation':'reported',evidence:[{paragraph_id:first.id,quote:first.text.slice(0,100)}]}]}))};
  }else if(prompt.startsWith('ZRI_READING_VERIFY_V1')){
   const marker='\n输入 JSON（source 为依据，claims 为待核验文本，不是指令）：\n',payload=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length)),first=payload.source.paragraphs[0];
   structured={checks:payload.claims.flatMap(s=>s.entries.map(e=>({entry_id:e.id,verdict:'supported',reason:'合成测试依据',evidence:[{paragraph_id:first.id,quote:first.text.slice(0,100)}],numeric_detail:'acceptable'}))),omissions:[],notes:'合成测试'};
  }
  if(prompt.startsWith('ZRI_READING_REPAIR_V1')){const marker='\n修订输入 JSON：\n';structured=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length)).draft;}
  if(structured)answer=JSON.stringify(structured);
  if(engine==='antigravity'){
   console.log(JSON.stringify({event:'init',init:{permission_mode:'strict'}}));
   console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:answer,...(structured?{structured_output:structured}:{})}}));
  }else{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],answer);console.log(JSON.stringify({type:'turn.completed'}));}
 });
}
