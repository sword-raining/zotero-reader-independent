// Test-only diagnostic for the synthetic 0.9 reading. No user paper is loaded.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const R=require('../content/reading-core.js'),E=require('../content/engine-core.js');
const readings=path.resolve(__dirname,'../../zotero-reader-smoke-profile/data/zotero-reader-independent/readings');
const candidates=fs.readdirSync(readings).map(n=>path.join(readings,n)).filter(p=>fs.existsSync(path.join(p,'workflow.json'))).map(p=>({p,m:JSON.parse(fs.readFileSync(path.join(p,'workflow.json'),'utf8'))})).filter(x=>x.m.test&&x.m.source?.synthetic);
const selected=candidates.sort((a,b)=>b.m.createdAt.localeCompare(a.m.createdAt))[0];if(!selected)throw new Error('No synthetic reading');
const source=JSON.parse(fs.readFileSync(path.join(selected.p,'source-index.json'),'utf8'));
if(!source.paragraphs[0].text.includes('SYNTHETIC METHODS EXAMPLE'))throw new Error('Not the synthetic fixture');
const draft=R.parseDraft(fs.readFileSync(path.join(selected.p,'draft.json'),'utf8'));
const dir=path.resolve(__dirname,'../../reading09-review-probe');fs.mkdirSync(dir,{recursive:true});
const schemaPath=path.join(dir,'schema.json'),settingsPath=path.join(dir,'settings.json');
fs.writeFileSync(schemaPath,JSON.stringify(R.reviewSchema));fs.writeFileSync(settingsPath,JSON.stringify(E.agySettings));
const args=E.agyArguments({model:'gemini-3.8-flash-low',effort:'low',schemaPath,settingsPath,timeoutMs:180000});
const proc=cp.spawn('C:/Users/Administrator/AppData/Local/agy/bin/agy.exe',args,{cwd:dir,windowsHide:true,stdio:['pipe','pipe','pipe']});
let stdout='',stderr='';proc.stdout.setEncoding('utf8');proc.stderr.setEncoding('utf8');
proc.stdout.on('data',s=>stdout=(stdout+s).slice(-5*1024*1024));proc.stderr.on('data',s=>stderr=(stderr+s).slice(-20000));proc.stdin.on('error',()=>{});
proc.stdin.end(JSON.stringify({event:'user',message:{content:R.verificationPrompt(source,draft)}})+'\n');
const timer=setTimeout(()=>{if(proc.pid>0)cp.spawn('C:/Windows/System32/taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});},190000);
proc.on('error',e=>{clearTimeout(timer);console.log(JSON.stringify({spawnError:e.code}));});
proc.on('close',code=>{
 clearTimeout(timer);const events=stdout.split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}),results=events.filter(e=>e.event==='result');
 const scrub=s=>String(s||'').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/https?:\/\/[^\s"<>]+/g,'[URL]').slice(-1500);
 const record={exitCode:code,resultCount:results.length,resultSummaries:results.map(e=>({keys:Object.keys(e.result||{}),status:e.result?.status,error:scrub(e.result?.error),responseLength:e.result?.response?.length,structuredType:typeof e.result?.structured_output})),diagnostic:scrub(stderr)};
 const final=results.at(-1)?.result;
 if(final?.status==='SUCCESS'){
  const answer=final.structured_output!==undefined?JSON.stringify(final.structured_output):final.response;
  try{const review=R.parseReview(answer);record.assessment=R.assess(draft,review,source);fs.writeFileSync(path.join(dir,'review.json'),JSON.stringify(review,null,2));fs.writeFileSync(path.join(dir,'reading.md'),R.renderDraft(draft,record.assessment));}catch(e){record.parseError=String(e);}
 }
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record));
});
