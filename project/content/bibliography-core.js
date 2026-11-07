var BibliographyCore;
(function(root){
  "use strict";
  const clean=value=>String(value??"").replace(/[\r\n]+/g," ").trim();
  function extraValue(extra,labels){
    for(const line of String(extra||"").split(/\r?\n/)){
      const m=line.match(/^\s*([^:：]+)[:：]\s*(.*?)\s*$/);
      if(m&&labels.some(label=>label.toLowerCase()===m[1].trim().toLowerCase()))return clean(m[2]);
    }
    return "";
  }
  function fromItem(data={},options={}){
    const primary=(data.creators||[]).find(c=>c.creatorType==='author');
    const authors=(data.creators||[]).filter(c=>c.creatorType==="author").map(c=>clean(c.name||[c.firstName,c.lastName].filter(Boolean).join(" "))).filter(Boolean);
    const rawIF=clean(data.libraryCatalog),rawRank=clean(data.callNumber);
    // Zotero One documents these two existing Zotero fields; no network request.
    const match=data.itemType==="journalArticle"?rawIF.match(/^(?:IF\s*[:：]?\s*)?(\d+(?:\.\d+)?)(?:\s*[（(]\s*(Q[1-4])\s*[)）])?$/i):null;
    const year=extraValue(data.extra,["JIF Year","Impact Factor Year","IF Year","影响因子年份","影响因子年度"]);
    const zone=data.itemType==="journalArticle"&&(match||options.oneAvailable)?rawRank.match(/^([1-4])\s*区?(?:\s*(TOP))?$/i):null;
    const ccf=["journalArticle","conferencePaper"].includes(data.itemType)&&/^(?:CCF\s*[-:：]?\s*)?[ABC]$/i.test(rawRank)?rawRank.replace(/^CCF\s*[-:：]?\s*/i,"").toUpperCase():"";
    const uri=clean(options.itemURI),remote=uri.match(/\/(users|groups)\/(\d+)\/items\//);
    const itemKey=clean(options.itemKey||data.key),libraryID=remote?remote[2]:options.libraryID?`local:${options.libraryID}`:'';
    const sourceID=itemKey&&libraryID?`zotero:${remote?.[1]==='groups'?'group:':''}${libraryID}:${itemKey}`:'';
    return {schema:1,title:clean(data.title),authors,firstAuthor:clean(primary?.lastName||primary?.name||primary?.firstName),year:clean(data.date).match(/\b(?:19|20)\d{2}\b/)?.[0]||'',
      creators:(data.creators||[]).map(c=>({...c})),itemKey,attachmentKey:clean(options.attachmentKey),libraryID,libraryType:remote?.[1]||'local',itemURI:uri,sourceID,
      tags:(data.tags||[]).map(t=>clean(typeof t==='string'?t:t.tag)).filter(t=>t&&!t.startsWith('/')),
      journal:clean(data.publicationTitle),date:clean(data.date),
      volume:clean(data.volume),issue:clean(data.issue),pages:clean(data.pages),doi:clean(data.DOI),itemType:clean(data.itemType),
      attachmentTitle:clean(options.attachmentTitle),
      metrics:{impactFactor:match?match[1]:"",jcrQuartile:match?.[2]?.toUpperCase()||"",casDivision:zone?zone[1]+"区"+(zone[2]?" TOP":""):"",ccf,
        year:/^(?:19|20)\d{2}$/.test(year)?year:"",rawIF:match?rawIF:"",rawRank:match?rawRank:"",
        source:options.oneAvailable?"Zotero One（条目已有记录）":"Zotero 条目已有记录（兼容 Zotero One 字段）"}};
  }
  function titleFields(record={},fallback='未命名文献'){
    return {author:record.firstAuthor||record.authors?.[0]||'作者未提供',year:record.year||clean(record.date).match(/\b(?:19|20)\d{2}\b/)?.[0]||'年份未提供',
      title:record.title||fallback,journal:record.journal||'期刊未提供',itemKey:record.itemKey||''};
  }
  function field(info,key,assessment){
    const entries=info?.find(x=>x.key===key)?.entries||[];
    return entries.map(e=>{
      const check=assessment?.checks?.find(c=>c.entry_id===e.id);
      return (check&&!check.passed?"【待核实】":"")+clean(e.text);
    }).join("；");
  }
  function rows(record={},info,assessment){
    if(!info&&!record.schema)return [];
    const metrics=record.metrics||{},title=record.title||field(info,"title",assessment)||record.attachmentTitle||"未提供";
    const authorText=record.authors?.length?record.authors.join("；"):field(info,"authors",assessment)||"未提供";
    const issue=[record.volume&&record.volume+"卷",record.issue&&record.issue+"期",record.pages].filter(Boolean).join("，");
    const sourceLabel=metrics.source||"Zotero 条目已有记录（Zotero One 字段）";
    return [
      ["题目",title],["作者",authorText],
      ["作者单位",field(info,"affiliations",assessment)||"解析文本未提供"],
      ["通讯作者",field(info,"correspondence",assessment)||"解析文本未提供；不按作者顺序猜测"],
      ["期刊",record.journal||"Zotero 题录未提供"],["发表日期",record.date||"Zotero 题录未提供"],
      ...(issue?[["卷期与页码/文章号",issue]]:[]),["DOI",record.doi||"Zotero 题录未提供"],
      ["影响因子",metrics.impactFactor||"条目未提供，可先用 Zotero One 更新"],
      ["JCR 分区",metrics.jcrQuartile||"条目未提供"],
      ["中科院分区 / CCF",metrics.casDivision||(metrics.ccf?"CCF "+metrics.ccf:metrics.rawRank||"条目未提供")],
      ["指标年份",metrics.year||"条目未记录"],
      ["指标来源",sourceLabel+"；读取文库编目/索书号，不额外联网查询"],
    ];
  }
  const sourceNotice="题录优先读取 Zotero，缺失时采用有依据的正文信息；作者单位及通讯作者依据解析文本提取。期刊指标保留条目已有记录。";
  function markdown(record,info,assessment){
    const values=rows(record,info,assessment);if(!values.length)return "";
    return ["## 文献信息","",...values.map(([label,value])=>`- ${label}：${value}`),"",sourceNotice,""].join("\n");
  }
  const api={fromItem,titleFields,rows,markdown,sourceNotice};BibliographyCore=api;root.BibliographyCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
