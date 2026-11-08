var WorkflowCore;
(function(root){
 'use strict';
 const limits=(input={})=>{
  const validRepair=(typeof input.repairs==='number'||typeof input.repairs==='string'&&input.repairs.trim()!=='')&&Number.isInteger(Number(input.repairs));
  return {papers:Math.max(1,Math.min(4,Number.parseInt(input.papers)||2)),checks:1,repairs:input.autoRepair===false?0:Math.max(0,Math.min(5,validRepair?Number(input.repairs):2))};
 };
 function reviewGroups(draft,count){
  const sections=[...(draft.articleInfo||[]).map(s=>({...s,key:'info.'+s.key})),...draft.sections];
  const groups=Array.from({length:Math.min(count,sections.length)},()=>({articleInfo:[],sections:[],size:0}));
  for(const section of sections){const group=groups.reduce((a,b)=>a.size<=b.size?a:b);group.size+=section.entries.length;
   if(section.key.startsWith('info.'))group.articleInfo.push({...section,key:section.key.slice(5)});else group.sections.push(section);}
  return groups.map(({articleInfo,sections})=>({articleInfo,sections}));
 }
 function mergeReviews(draft,groups,reviews){
  if(groups.length!==reviews.length)throw Error('Incomplete parallel verification');
  if(reviews.every(r=>r.mode==='full-review')){
   const combined={mode:'full-review',checked_ids:[],issues:[],notes:''};
   for(let i=0;i<groups.length;i++){
    const expected=new Set([...(groups[i].articleInfo||[]),...groups[i].sections].flatMap(s=>s.entries.map(e=>e.id))),ids=reviews[i].checked_ids;
    if(ids.length!==expected.size||new Set(ids).size!==ids.length||ids.some(id=>!expected.has(id))||reviews[i].issues.some(r=>!expected.has(r.entry_id)))throw Error('Verification coverage incomplete');
    combined.checked_ids.push(...ids);combined.issues.push(...reviews[i].issues);combined.notes+=reviews[i].notes+'\n';
   }
   return combined;
  }
  if(reviews.some(r=>r.mode==='full-review'))throw Error('Mixed verification protocols');
  const result={checks:[],omissions:[],notes:''},seen=new Set();
  for(let i=0;i<groups.length;i++){
   const expected=new Set([...(groups[i].articleInfo||[]),...groups[i].sections].flatMap(s=>s.entries.map(e=>e.id))),local=new Set();
   for(const c of reviews[i].checks){if(!expected.has(c.entry_id)||local.has(c.entry_id)||seen.has(c.entry_id))throw Error('Duplicate or unexpected verification claim');local.add(c.entry_id);seen.add(c.entry_id);result.checks.push(c);}
   if(local.size!==expected.size)throw Error('Missing verification claims');
   result.omissions.push(...reviews[i].omissions);result.notes+=`${i+1}. ${reviews[i].notes}\n`;
  }
  // Duplicate omission findings do not require repeated repairs; never drop distinct findings.
  result.omissions=result.omissions.filter((o,i,a)=>a.findIndex(x=>JSON.stringify(x)===JSON.stringify(o))===i);
  const total=[...(draft.articleInfo||[]),...draft.sections].reduce((n,s)=>n+s.entries.length,0);if(seen.size!==total)throw Error('Verification coverage incomplete');
  return result;
 }
 async function parallelMap(items,limit,action,signal){
  const controller=new AbortController(),stop=()=>controller.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const results=new Array(items.length);let cursor=0,failure;
  const run=async()=>{while(cursor<items.length&&!controller.signal.aborted){const i=cursor++;try{results[i]=await action(items[i],i,controller.signal);}catch(e){failure=failure||e;controller.abort();}}};
  try{await Promise.all(Array.from({length:Math.min(limit,items.length)},run));if(failure)throw failure;if(controller.signal.aborted){const e=new Error('Cancelled');e.code='CANCELLED';throw e;}return results;}
  finally{signal?.removeEventListener('abort',stop);}
 }
 function brief(draft,assessment){
  const passed=new Set(assessment?.checks?.filter(c=>c.passed).map(c=>c.entry_id));
  return draft.sections.find(s=>s.key==='results')?.entries.find(e=>passed.has(e.id)&&e.kind!=='not_reported'&&e.text.length<=180)?.text||'';
 }
 const api={limits,reviewGroups,mergeReviews,parallelMap,brief};WorkflowCore=api;root.WorkflowCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
