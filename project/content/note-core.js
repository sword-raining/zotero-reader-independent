var NoteCore;
(function(root){
  "use strict";
  const B=root.BibliographyCore||(typeof require!=="undefined"?require('./bibliography-core.js'):null);
  class NoteError extends Error { constructor(code,message){super(message);this.name="NoteError";this.code=code;} }
  const error=(code,message)=>new NoteError(code,message);
  const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const DEFAULT_NAMES={reading:"精读笔记｜{author} {year}｜{title}"};
  function validateName(value){
    if(typeof value!=="string"||!value.trim()||value.length>200)throw error("NOTE_NAME","笔记命名格式不能为空，且不能超过 200 字符。");
    if(/[{}]/.test(value.replace(/\{(?:title|author|year|journal|itemKey|pdf|date|template|status)\}/g,"")))throw error("NOTE_NAME","命名支持 {title}、{author}、{year}、{journal}、{itemKey}、{pdf}、{date}、{template}、{status}。");
    return value.trim();
  }
  function noteTitle(format,values,status){
    let text=validateName(format).replace(/\{(title|author|year|journal|itemKey|pdf|date|template|status)\}/g,(_,key)=>String(values[key]||""))
      .replace(/[\r\n\t]+/g," ").trim().slice(0,200);
    if(status!=="checked"&&!text.includes(values.status)){
      const suffix=`【${values.status}】`;text=text.slice(0,200-suffix.length)+suffix;
    }
    return text;
  }
  function localDate(iso){
    const date=new Date(iso);if(!Number.isFinite(date.getTime()))return "";
    const parts=Object.fromEntries(new Intl.DateTimeFormat("en",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date).map(p=>[p.type,p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function markdownHTML(text){
    let body=String(text);
    if(/^---\r?\n/.test(body)){body=body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,"").replace(/^\s*# [^\n]*\r?\n/,"");}
    const lines=body.replace(/^# (?:文本核验完成[^\n]*|待人工复核的精读草稿|精读草稿：尚未核验|文献精读|需核对的精读草稿|精读草稿)\r?\n/,"").split(/\r?\n/);
    let html="",list=false;
    for(const line of lines){
      const bullet=line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/),heading=line.match(/^(#{1,6})\s+(.+)$/);
      if(bullet){if(!list){html+="<ul>";list=true;}html+=`<li><p>${escape(bullet[1])}</p></li>`;continue;}
      if(list){html+="</ul>";list=false;}
      if(heading)html+=`<h${Math.min(heading[1].length+1,6)}>${escape(heading[2])}</h${Math.min(heading[1].length+1,6)}>`;
      else if(line.trim())html+=`<p>${escape(line)}</p>`;
    }
    return html+(list?"</ul>":"");
  }
  function identity(runID,role){
    if(!/^[a-z0-9-]{8,100}$/.test(runID)||!["reading","verification"].includes(role))throw error("NOTE_ID","精读结果标识无效。");
    return `ZRI:${runID}:${role}`;
  }
  function sourceLink(url,title){
    if(!/^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8}$/.test(url))throw error("NOTE_LINK","来源 PDF 链接无效。");
    return `<a href="${escape(url)}">${escape(title)}</a>`;
  }
  function render({workflow,draft,assessment,title,pdfTitle,pdfURL,sections,runID,naming=DEFAULT_NAMES,manualEdited=false,manualMarkdown=""}){
    const status=manualEdited?"edited":workflow.status==="verification_incomplete"||!assessment?"incomplete":workflow.status==="checked"&&assessment.status==="checked"?"checked":"needs_review";
    const labels={checked:"已检查",needs_review:"需核对草稿",incomplete:"未完成检查",edited:"人工修改稿（未重新检查）"};
    const label=labels[status]||labels.incomplete;
    const values={...B.titleFields(workflow.bibliography,title),pdf:pdfTitle,date:localDate(workflow.createdAt),status:label,template:"论文精读"};
    let html=`<div data-schema-version="9"><h1>${escape(noteTitle(naming.reading||DEFAULT_NAMES.reading,values,status))}</h1>`+
      `<p>${sourceLink(pdfURL,pdfTitle)} · ${escape(values.date)}</p>`;
    const readingCore=root.ReadingCore||(typeof require!=='undefined'?require('./reading-core.js'):null),scope=readingCore.scopeNotice(workflow.inputSources||[]);if(scope&&!manualEdited)html+=`<p>${escape(scope)}</p>`;
    if(status==='checked'&&typeof workflow.shortFinding==='string'&&workflow.shortFinding.length<=180&&draft.coreFinding?.text===workflow.shortFinding&&assessment.checks.some(c=>c.entry_id===draft.coreFinding.id&&c.passed))html+=`<p><strong>核心发现：</strong>${escape(workflow.shortFinding)}</p>`;
    if(status!=="checked")html+=`<p><strong>${escape(label)}</strong> — ${escape(status==="edited"?"自动检查仅针对修改前内容。":"本稿尚有需要人工核对的内容。")}</p>`;
    if(manualEdited)html+=markdownHTML(manualMarkdown);
    else {
      const rows=B.rows(workflow.bibliography||{},draft.articleInfo,assessment);
      if(rows.length)html+='<h2>文献信息</h2>'+rows.map(([label,value])=>`<p><strong>${escape(label)}：</strong>${escape(value)}</p>`).join('')+`<p><em>${escape(B.sourceNotice)}</em></p>`;
      const inputSources=workflow.inputSources||[];
      if(inputSources.length)html+='<h2>本次阅读资料</h2>'+inputSources.map(s=>`<p>${escape(s.label)}：${sourceLink(s.pdfURL,s.name||s.title||s.key)}</p>`).join('')+(inputSources.length===1?'<p>仅阅读正文，未纳入其他附件。</p>':'');
      for(const [key,name] of sections){
      html+=`<h2>${escape(name)}</h2>`;
      if(key==="publication")html+="<p><em>本节是基于所提供材料的发表价值分析，不代表编辑或审稿人的实际录用理由。</em></p>";
      html+="<ul>";
      for(const entry of draft.sections.find(s=>s.key===key).entries){
        const check=assessment?.checks.find(c=>c.entry_id===entry.id);
        const R=root.ReadingCore||(typeof require!=='undefined'?require('./reading-core.js'):null);
        const label=R.attributionLabel(key,entry.kind),attribution=label?escape(label)+' ':'';
        const A=root.AttachmentCore||(typeof require!=='undefined'?require('./attachment-core.js'):null);
        const evidence=inputSources.length>1?A.evidenceText(entry,inputSources):'';
        html+=`<li><p>${check&&!check.passed?"<strong>待核对：</strong>":""}${attribution}${escape(R.displayEntryText(key,entry))}${evidence?' <em>〔依据：'+escape(evidence)+'〕</em>':''}</p></li>`;
      }
      html+="</ul>";
      }
      // Evidence remains in the verification workflow; final notes do not append its quotation collection.
    }
    html+=`<p><em>检查依据为解析文本，不含图像及外部资料。</em></p><!-- ${escape(identity(runID,"reading"))} --></div>`;
    return {reading:html,status};
  }
  const api={NoteError,error,escape,identity,sourceLink,render,DEFAULT_NAMES,validateName,noteTitle,localDate,markdownHTML};NoteCore=api;root.NoteCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
