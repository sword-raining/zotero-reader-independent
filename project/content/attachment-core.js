var AttachmentCore;
(function(root){
  "use strict";
  function isSupplement(title,name){
    return /(?:supplement(?:al|ary)?|supporting[\s_.-]*(?:information|materials?|data)|appendi(?:x|ces)|\bsuppl\b|\bSI\b|\bESM\b|MOESM\d*|\bmmc\d+|[._-]sapp(?:[._-]\d+)?(?:\.pdf|\b)|补充(?:材料|信息|数据|文件)?|支撑材料|支持信息|附录)/i.test(`${title||''} ${name||''}`);
  }
  function versionHint(text){
    const t=String(text||'').slice(0,8000).replace(/[_-]+/g,' ');
    if(/\b(?:author(?:'s)?\s+)?accepted\s+(?:manuscript|version)|\bauthor\s+manuscript\b|\b(?:uncorrected|journal\s+pre)\s*proof\b|作者接受稿|接受(?:版本|稿)|录用稿/i.test(t))return 'accepted';
    if(/\bpreprint\b|\b(?:bio|med)rxiv\b|\barxiv\b|未经同行评审|预印本/i.test(t))return 'preprint';
    if(/\bversion\s+of\s+record\b|\bpublished\s+(?:version|online|by)\b|\bfinal\s+published\b|正式发表版|出版版本|已发表版本/i.test(t))return 'published';
    if(/(?:©|copyright)\s*(?:\d{4}|the author)/i.test(t)&&/(?:doi\s*[:.]|doi\.org\/|10\.\d{4,9}\/)/i.test(t))return 'published';
    return 'unknown';
  }
  function normalizeDOI(value){let v=String(value||'').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi\s*:\s*/i,'').replace(/[.,;]+$/,'').toLowerCase();while(v.endsWith(')')&&(v.match(/\)/g)||[]).length>(v.match(/\(/g)||[]).length)v=v.slice(0,-1);return /^10\.\d{4,9}\/\S+$/.test(v)?v:'';}
  function inspectText(text,{title='',doi=''}={}){
    const t=String(text||'').normalize('NFKC').slice(0,12000),clean=s=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),wanted=clean(title),head=t.slice(0,7000),flat=clean(head);
    const titleMatch=wanted.length>=12&&flat.includes(wanted),titlePosition=titleMatch?flat.indexOf(wanted):-1;
    const lines=t.replace(/\f/g,'\n').split(/\r?\n/);let offset=0,supplement=false;
    for(const raw of lines){const line=raw.replace(/^\s*[#*\d.\s-]+/,'').trim();if(offset>1800)break;
      const header=/^(?:(?:electronic|online)\s+)?(?:supporting\s+(?:information|materials?)|supplement(?:ary|al)?\s+(?:information|materials?|appendi(?:x|ces)|data|methods))\s*(?:$|[:：—-]|(?:for|to|of)\b)/i.test(line)||/^(?:补充材料|补充信息|补充数据|支持信息|支撑材料|电子附录)(?:\s|$|[:：])/u.test(line);
      if(header&&clean(line)!==wanted&&(titlePosition<0||clean(t.slice(0,offset)).length<=titlePosition||offset<100)){supplement=true;break;}offset+=raw.length+1;
    }
    const metaHead=t.slice(0,Math.min(2400,Math.max(100,t.search(/\babstract\b|\bintroduction\b|摘要|引言/i)<0?2400:t.search(/\babstract\b|\bintroduction\b|摘要|引言/i))));
    const dois=[...new Set((metaHead.match(/10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/g)||[]).map(normalizeDOI))],parentDOI=normalizeDOI(doi),headerTitleMatch=wanted.length>=12&&clean(t.slice(0,2400)).includes(wanted);
    const detectedDOI=dois.length===1?dois[0]:'',parentMatch=headerTitleMatch||parentDOI&&dois.includes(parentDOI)?'match':!supplement&&parentDOI&&detectedDOI&&detectedDOI!==parentDOI?'mismatch':'unknown';
    const identity={detectedDOI,parentMatch,parentDOI,identityReason:parentMatch==='mismatch'?'PDF 首页 DOI 与题录不同':parentMatch==='match'?'首页题名或 DOI 与题录一致':'尚未确认 PDF 与题录的对应关系'};
    const version=versionHint(head),body=/\babstract\b|\bintroduction\b|\bresults\b|摘要|引言|研究结果/i.test(head);
    return supplement?{...identity,role:'supplement',version:'unknown',reason:'首页标明补充材料'}:(titleMatch||parentMatch==='match')&&body?{...identity,role:'main',version,reason:'首页题名与题录相符，含论文正文结构'}:{...identity,role:'unknown',version,reason:'未能从文本明确区分正文与补充材料'};
  }
  function plan(files){
    files=files.map(f=>({...f,version:f.version||versionHint(`${f.title||''} ${f.name||''}`),versionSource:f.versionSource||'name'}));
    const rank=f=>({published:4,accepted:3,unknown:2,preprint:1}[f.version||versionHint(`${f.title||''} ${f.name||''}`)]||2);
    const compare=(a,b)=>Number(b.parentMatch==='match')-Number(a.parentMatch==='match')||rank(b)-rank(a)||Number(b.role==='main')-Number(a.role==='main')||Number(b.local)-Number(a.local)||(a.itemID||0)-(b.itemID||0)||String(a.key).localeCompare(String(b.key));
    const hashes=new Map(),mapped=new Map();
    const ordered=[...files].sort((a,b)=>Number(a.supplement)-Number(b.supplement)||compare(a,b));
    for(const f of ordered){const duplicateOf=f.sha256?hashes.get(f.sha256):null;mapped.set(f.key,{...f,duplicateOf:duplicateOf||null});if(f.sha256&&!duplicateOf)hashes.set(f.sha256,f.key);}
    const pdfs=files.map(f=>mapped.get(f.key)),candidates=pdfs.filter(f=>!f.duplicateOf&&!f.supplement&&f.parentMatch!=='mismatch').sort(compare),main=candidates[0],version=main&&(main.version||versionHint(`${main.title||''} ${main.name||''}`));
    const versionLabel={published:'已发表版本',accepted:'接受稿',preprint:'预印本',unknown:'版本未明确'};
    return {pdfs,mainKey:main?.key||'',supplementKeys:[],duplicateCount:pdfs.filter(f=>f.duplicateOf).length,selectionReason:main?`已自动选择正文（${versionLabel[version]||versionLabel.unknown}${version!=='unknown'&&main.versionSource==='name'?'，附件名线索':''}）；可改选`:''};
  }
  function selection(entry){
    const main=entry.pdfs.find(p=>p.key===entry.mainKey&&!p.duplicateOf&&p.parentMatch!=='mismatch');
    if(!main)throw new Error('请为这篇文献选择一个正文 PDF。');
    return {mainKey:main.key,supplementKeys:entry.pdfs.filter(p=>!p.duplicateOf&&p.parentMatch!=='mismatch'&&p.key!==main.key&&entry.supplementKeys.includes(p.key)).map(p=>p.key)};
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
  const api={isSupplement,versionHint,normalizeDOI,inspectText,plan,selection,sameSources,evidenceText};AttachmentCore=api;root.AttachmentCore=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
