var BatchCore;
(function(root){
  "use strict";
  const active=new Set(["waiting_file","queued","running"]);
  const completed=new Set(["done","imported","needs_review","verification_incomplete","awaiting_import"]);
  function languageInfo(value){
    const raw=String(value||'').trim();if(!raw)return {raw,kind:'unknown',label:'未标注',chinese:false};
    const parts=raw.toLowerCase().replace(/_/g,'-').split(/[;,/|+、&]+/u).map(x=>x.replace(/\s*[（(][^）)]*[）)]/g,'').trim()).filter(Boolean);
    const zh=x=>/^(?:zh(?:-[a-z0-9]{1,8})*|zho|chi|cmn(?:-[a-z0-9]{1,8})*|chinese|(?:simplified|traditional) chinese|中文|汉语|漢語|简体中文|繁体中文|簡體中文|繁體中文)$/.test(x);
    const en=x=>/^(?:en(?:-[a-z0-9]{1,8})*|eng|english|英文|英语|英語)$/.test(x);
    const chinese=parts.some(zh);
    if(chinese)return {raw,kind:'zh',label:parts.every(zh)?'中文':'多语言（含中文）',chinese:true};
    if(parts.length&&parts.every(en))return {raw,kind:'en',label:'英文',chinese:false};
    return {raw,kind:'unknown',label:'其他／未识别',chinese:false};
  }
  function decision(existing,{skipProcessed=true,sourceMatches=false}={}){
    if(existing&&(existing.resumePending||active.has(existing.state)))return "existing";
    if(existing&&completed.has(existing.state)&&skipProcessed&&sourceMatches)return "skip";
    return "enqueue";
  }
  function unique(items){
    const seen=new Set();
    return items.filter(item=>{const id=`${item.libraryID}:${item.key}`;if(seen.has(id))return false;seen.add(id);return true;});
  }
  function progress(members,jobs){
    const counts={waiting:0,running:0,done:0,imported:0,needs_review:0,verification_incomplete:0,awaiting_import:0,failed:0,cancelled:0,replaced:0};
    for(const member of members){
      const job=jobs[member.id];
      let status=job?.attempt===member.attempt?(job.resumePending?'queued':job.state):member.lastTerminal||"replaced";
      if(["done","imported","needs_review","verification_incomplete","awaiting_import","failed","cancelled"].includes(status))member.lastTerminal=status;
      if(["queued","waiting_file"].includes(status))status="waiting";
      if(Object.hasOwn(counts,status))counts[status]++;
    }
    return counts;
  }
  const api={active,completed,decision,unique,progress,languageInfo};BatchCore=api;root.BatchCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
