var BatchCore;
(function(root){
  "use strict";
  const active=new Set(["waiting_file","queued","running"]);
  const completed=new Set(["done","imported","needs_review","verification_incomplete","awaiting_import"]);
  function decision(existing,{skipProcessed=true,sourceMatches=false}={}){
    if(existing&&active.has(existing.state))return "existing";
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
      let status=job?.attempt===member.attempt?job.state:member.lastTerminal||"replaced";
      if(["done","imported","needs_review","verification_incomplete","awaiting_import","failed","cancelled"].includes(status))member.lastTerminal=status;
      if(["queued","waiting_file"].includes(status))status="waiting";
      if(Object.hasOwn(counts,status))counts[status]++;
    }
    return counts;
  }
  const api={active,completed,decision,unique,progress};BatchCore=api;root.BatchCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
