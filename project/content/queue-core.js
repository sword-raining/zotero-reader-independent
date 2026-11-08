var QueueCore;
(function(root){
  "use strict";
  const pending=new Set(["queued","waiting_file"]);
  const terminal=new Set(["done","imported","needs_review","verification_incomplete","awaiting_import","awaiting_selection","failed","cancelled"]);
  function key(libraryID,itemKey){
    if(!Number.isInteger(libraryID)||libraryID<0||!/^[A-Z0-9]{8}$/.test(itemKey))throw new Error("Invalid PDF identity");
    return `${libraryID}:${itemKey}`;
  }
  function captureAllowed({enabled,event,isPDF,deleted,synced,libraryID,userLibraryID,generated,epoch,currentEpoch}){
    return Boolean(enabled&&event==="add"&&isPDF&&!deleted&&!synced&&!generated&&libraryID===userLibraryID&&epoch===currentEpoch);
  }
  function enqueue(state,item,{trigger="auto",templateID="general",now=Date.now(),inputSelection,groupID}={}){
    const id=key(item.libraryID,item.key),existing=state.jobs[id];
    if(existing&&(existing.resumePending||!terminal.has(existing.state)||trigger==="auto")&&!(trigger==='auto'&&existing.state==='cancelled'&&existing.scopeCancelled&&!existing.workflowPath))return {job:existing,created:false};
    const job={id,libraryID:item.libraryID,key:item.key,itemID:item.id,title:item.title||item.key,trigger,templateID,
      state:"waiting_file",phase:"waiting",createdAt:now,updatedAt:now,attempt:(existing?.attempt||0)+1,message:"等待 PDF 文件就绪",workflowPath:null,
      ...(inputSelection?{inputSelection:JSON.parse(JSON.stringify(inputSelection))}:{}),...(groupID?{groupID}: {})};
    state.jobs[id]=job;return {job,created:true};
  }
  function ready(job,stat,now=Date.now(),settleMs=2000){
    if(!stat||stat.size<=0){job.fileStamp=null;job.stableSince=null;job.state="waiting_file";return false;}
    const stamp=`${stat.size}:${stat.lastModified}`;
    if(stamp!==job.fileStamp){job.fileStamp=stamp;job.stableSince=now;job.state="waiting_file";return false;}
    if(now-job.stableSince<settleMs)return false;
    job.state="queued";job.message="等待精读";return true;
  }
  function next(state,{enabled,paused,busy}={}){
    if(paused||busy)return null;
    return Object.values(state.jobs).filter(j=>j.state==="queued"&&(j.trigger==="manual"||enabled))
      .sort((a,b)=>a.createdAt-b.createdAt)[0]||null;
  }
  function recover(state){
    for(const job of Object.values(state.jobs))if(job.state==="running"){
      job.state="failed";job.message="上次任务中断，点击重试可继续检查已有结果";
    }
    return state;
  }
  const api={key,captureAllowed,enqueue,ready,next,recover,pending,terminal};QueueCore=api;root.QueueCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
