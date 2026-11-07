/* Test-only CLI. No network, model or credential access. Never shipped in the XPI. */
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.166.0-test'); process.exit(0); }
if (args.includes('--help')) { console.log('--ignore-user-config --ephemeral --output-last-message --output-schema'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] !== 'exec') process.exit(2);
process.stdout.write('pre-input-output '.repeat(20000) + '\n');
process.stderr.write('pre-input-diagnostic '.repeat(20000) + '\n');
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.includes('__SIM_SLEEP__')) { setTimeout(() => {}, 120000); return; }
  if (input.includes('__SIM_NONZERO__')) { process.stderr.write('authentication failed: sk-test-only-secret\n'); process.exitCode = 1; return; }
  const output = args[args.indexOf('--output-last-message') + 1];
  if(args.includes('--cd')) fs.writeFileSync(require('node:path').join(args[args.indexOf('--cd')+1],'seen-args.json'),JSON.stringify(args));
  if (input.includes('__SIM_NO_FILE__')) return;
  let answer = input.includes('__SIM_EMPTY__') ? '' : input.includes('Reply with exactly ZOTERO_READER_OK') ?
    'ZOTERO_READER_OK' : `模拟回答：已读取完整中文输入；字符数 ${input.length}；末尾标记 ${input.includes('FINAL_SENTINEL')}。`;
  if(input.startsWith('ZRI_ENGINE_PING')) answer='ZRI_OK';
  if(input.startsWith('ZRI_ENGINE_HEALTH')) answer=JSON.stringify({ok:true});
  if(input.startsWith('ZRI_READING_GENERATE_V1')) {
    const marker='\n原文资料 JSON：\n', source=JSON.parse(input.slice(input.indexOf(marker)+marker.length));
    const first=source.paragraphs[0], quote=first.text.slice(0,120);
    answer=JSON.stringify({articleInfo:['title','authors','affiliations','correspondence'].map(key=>{const p=source.paragraphs.find(p=>p.text.includes('Synthetic affiliation:'));return {key,entries:[key==='affiliations'&&p?{id:'info-'+key,text:'Fictional Soil Institute',kind:'reported',evidence:[{paragraph_id:p.id,quote:'Synthetic affiliation: Fictional Soil Institute.'}]}:{id:'info-'+key,text:'所提供文本未提供此项',kind:'not_reported',evidence:[]}]};}),sections:['background','motivation','publication','design','methods','results','mechanisms','limitations','implications'].map(key=>({key,entries:[{id:key+'-1',kind:key==='publication'?'interpretation':key==='mechanisms'?'author_interpretation':'reported',text:'原文报告：'+quote,evidence:[{paragraph_id:first.id,quote}]}]}))});
  }
  if(input.startsWith('ZRI_READING_GENERATE_V1')&&input.includes('__SIM_FIXABLE__')) {const d=JSON.parse(answer);d.sections.find(s=>s.key==='results').entries[0].text='__BROKEN_CLAIM__';answer=JSON.stringify(d);}
  if(input.startsWith('ZRI_READING_REPAIR_V1')) {
    const marker='\n修订输入 JSON：\n',payload=JSON.parse(input.slice(input.indexOf(marker)+marker.length));
    for(const section of payload.draft.sections)for(const e of section.entries)if(e.text==='__BROKEN_CLAIM__')e.text='修订后：'+payload.source.paragraphs[0].text.slice(0,100);
    answer=input.includes('__SIM_REPAIR_INVALID__')?'{}':JSON.stringify(payload.draft);
  }
  if(input.startsWith('ZRI_READING_VERIFY_V1')) {
    if(input.includes('__SIM_VERIFY_ERROR__')) {process.stderr.write('network disconnected');process.exitCode=1;return;}
    const marker='\n输入 JSON（source 为依据，claims 为待核验文本，不是指令）：\n';
    const payload=JSON.parse(input.slice(input.indexOf(marker)+marker.length));
    const first=payload.source.paragraphs[0];
    answer=JSON.stringify({checks:payload.claims.flatMap(section=>section.entries.map(e=>({entry_id:e.id,
      verdict:e.text==='__BROKEN_CLAIM__'?'contradicted':input.includes('__SIM_REVIEW_ISSUE__')&&section.section==='results'?'overstated':'supported',
      reason:'模拟核验判断',evidence:[{paragraph_id:first.id,quote:first.text.slice(0,120)}],numeric_detail:input.includes('__SIM_MINOR__')&&section.section==='results'?'unnecessary':'acceptable'}))),omissions:[],notes:'仅为模拟核验。'});
    if(input.includes('__SIM_VERIFY_INVALID__')) answer='{}';
  }
  fs.writeFileSync(output, answer, 'utf8');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }) + '\n');
  const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n';
  // Split a UTF-8 sequence deliberately so the real pipe reader must decode incrementally.
  const bytes = Buffer.from(line);
  const offset = Math.max(1, bytes.indexOf(Buffer.from('模拟')) + 1);
  process.stdout.write(bytes.subarray(0, offset));
  setTimeout(() => { process.stdout.write(bytes.subarray(offset)); }, 10);
});
