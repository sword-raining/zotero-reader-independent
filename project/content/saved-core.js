var SavedCore;
(function(root){
  'use strict';
  const validID=id=>typeof id==='string'&&/^[a-z0-9-]{8,100}$/.test(id);
  const validKey=key=>typeof key==='string'&&/^[A-Z0-9]{8}$/.test(key);
  function valid(record){
    return record?.schema===1&&validID(record.runID)&&validKey(record.itemKey)&&['checked','edited'].includes(record.status)&&
      /^[a-f0-9]{64}$/.test(record.bodySHA256||'')&&Array.isArray(record.inputs)&&record.inputs.length>0&&record.inputs.length<=100&&
      record.inputs.every(s=>validKey(s.key)&&['main','supplement'].includes(s.role)&&(s.pageLimit===undefined||[0,20].includes(s.pageLimit))&&/^[a-f0-9]{64}$/.test(s.sha256||''))&&
      record.inputs.filter(s=>s.role==='main').length===1;
  }
  function strip(html){return String(html).replace(/\sdata-zri-record=(?:"[^"]*"|'[^']*')/g,'').replace(/(zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8})\?zri-record=[^"'&<>\s]+/g,'$1').trim();}
  function body(html){
    const decode=s=>s.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,m=>{
      const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
      if(named[m.toLowerCase()]!==undefined)return named[m.toLowerCase()];
      const hex=m[2].toLowerCase()==='x',n=parseInt(m.slice(hex?3:2,-1),hex?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):m;
    });
    const text=strip(html).replace(/<!--[\s\S]*?-->/g,'');
    return JSON.stringify({text:decode(text.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim().normalize('NFC'),
      links:[...text.matchAll(/\bhref=(?:"([^"]*)"|'([^']*)')/g)].map(m=>decode(m[1]||m[2])),
      structure:[...text.matchAll(/<\/?(?:blockquote|table|tr|td|th|img)\b[^>]*>/gi)].map(m=>m[0].toLowerCase().replace(/\s+/g,' '))});
  }
  function read(html){
    const values=[...String(html).matchAll(/\sdata-zri-record=(?:"([^"]*)"|'([^']*)')/g)].map(m=>m[1]||m[2]);
    for(const m of String(html).matchAll(/zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8}\?zri-record=([^"'&<>\s]+)/g))values.push(m[1]);
    try{const decoded=[...new Set(values.map(v=>v.length<=64000?decodeURIComponent(v):''))];if(decoded.length!==1||!decoded[0])return null;const record=JSON.parse(decoded[0]);return valid(record)?record:null;}catch(_){return null;}
  }
  function embed(html,record){
    if(!valid(record))throw new Error('Invalid saved reading receipt');
    const text=strip(html);if(!/^<div\b/.test(text))throw new Error('Missing note wrapper');
    const encoded=encodeURIComponent(JSON.stringify(record)),mainKey=record.inputs.find(s=>s.role==='main').key;
    let linked=false;
    const result=text.replace(/(href=["'])(zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/([A-Z0-9]{8}))(["'])/,(_,start,url,key,end)=>{
      if(key!==mainKey)throw new Error('Source link does not match receipt');
      linked=true;return start+url+'?zri-record='+encoded+end;
    });
    if(!linked)throw new Error('Saved note requires a persistent source link');
    return result.replace(/^<div\b/,'<div data-zri-record="'+encoded+'"');
  }
  function inputs(workflow){return (workflow.inputSources?.length?workflow.inputSources:[{...workflow.source,role:'main'}]).map(s=>({key:s.key,role:s.role||'main',sha256:s.sha256,...(s.pageLimit?{pageLimit:s.pageLimit}:{})}));}
  function matches(record,sources){
    const sort=list=>list.map(s=>`${s.role||'main'}:${s.sha256}`).sort();
    return valid(record)&&JSON.stringify(sort(record.inputs))===JSON.stringify(sort(sources))&&sources.every(want=>{const stored=record.inputs.find(x=>(x.role||'main')===(want.role||'main')&&x.sha256===want.sha256),old=stored.pageLimit||0,next=want.pageLimit||0;return !old||next>0&&old>=next;});
  }
  function legacyRun(html){return String(html).match(/<!--\s*ZRI:([a-z0-9-]{8,100}):reading\s*-->/)?.[1]||null;}
  const api={validID,validKey,valid,strip,body,read,embed,inputs,matches,legacyRun};SavedCore=api;root.SavedCore=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
