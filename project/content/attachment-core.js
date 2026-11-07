var AttachmentCore;
(function(root){
  "use strict";
  function isSupplement(title,name){
    return /(?:supplement(?:al|ary)?|supporting[\s_.-]*(?:information|materials?|data)|appendi(?:x|ces)|\bsuppl\b|\bSI\b|\bESM\b|MOESM\d*|\bmmc\d+|补充(?:材料|信息|数据|文件)?|支撑材料|支持信息|附录)/i.test(`${title||''} ${name||''}`);
  }
  function plan(files){
    const hashes=new Map();
    // Prefer a non-supplement name when byte-identical attachments have different labels.
    const ordered=[...files].sort((a,b)=>Number(a.supplement)-Number(b.supplement)||(a.itemID||0)-(b.itemID||0));
    const mapped=new Map();
    for(const f of ordered){
      const duplicateOf=f.sha256?hashes.get(f.sha256):null;
      mapped.set(f.key,{...f,duplicateOf:duplicateOf||null});
      if(f.sha256&&!duplicateOf)hashes.set(f.sha256,f.key);
    }
    const pdfs=files.map(f=>mapped.get(f.key));
    const candidates=pdfs.filter(f=>!f.duplicateOf&&!f.supplement);
    return {pdfs,mainKey:candidates.length===1?candidates[0].key:'',supplementKeys:[],duplicateCount:pdfs.filter(f=>f.duplicateOf).length};
  }
  function selection(entry){
    const main=entry.pdfs.find(p=>p.key===entry.mainKey&&!p.duplicateOf);
    if(!main)throw new Error('请为这篇文献选择一个正文 PDF。');
    return {mainKey:main.key,supplementKeys:entry.pdfs.filter(p=>!p.duplicateOf&&p.key!==main.key&&entry.supplementKeys.includes(p.key)).map(p=>p.key)};
  }
  function sameSources(previous,current){
    const normalize=items=>items.map(s=>`${s.role||'main'}:${s.libraryID}:${s.key}:${s.sha256}`).sort();
    return JSON.stringify(normalize(previous))===JSON.stringify(normalize(current));
  }
  function evidenceText(entry,sources=[]){
    if(!sources.length)return '';
    const refs=[...new Set((entry.evidence||[]).map(e=>e.paragraph_id))];
    return refs.map(id=>{
      const source=sources.find(s=>id.startsWith(s.id+'-'))||(id.startsWith('P')?sources[0]:null);
      return source?`${source.label} ${id}`:id;
    }).join('；');
  }
  const api={isSupplement,plan,selection,sameSources,evidenceText};AttachmentCore=api;root.AttachmentCore=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
