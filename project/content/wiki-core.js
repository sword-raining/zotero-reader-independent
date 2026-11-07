var WikiCore;
(function(root){
  "use strict";
  const B=root.BibliographyCore||(typeof require!=='undefined'?require('./bibliography-core.js'):null);
  const N=root.NoteCore||(typeof require!=='undefined'?require('./note-core.js'):null);
  function titles(bibliography,workflow){
    const fields=B.titleFields(bibliography,bibliography?.attachmentTitle||'未命名文献');
    const status=workflow.status==='checked'?'已检查':'待核对草稿';
    const values={...fields,pdf:bibliography?.attachmentTitle||'',date:N.localDate(workflow.createdAt),status,template:workflow.templateID==='ecology'?'生态与土壤微生物精读':'通用论文精读'};
    return {title:`${fields.author} ${fields.year}｜${fields.title}`,readingTitle:N.noteTitle(workflow.readingNaming?.reading||N.DEFAULT_NAMES.reading,values,workflow.status==='checked'?'checked':'needs_review')};
  }
  function decorate(body,bibliography={},workflow={}){
    if(!workflow.wikiInput)return body;
    const t=titles(bibliography,workflow),created=N.localDate(workflow.createdAt);
    const front={title:t.title,reading_note_title:t.readingTitle,record_type:'literature-reading-input',wiki_stage:'input',
      tags:[...new Set(['文献精读',...(bibliography.tags||[])])],keywords:bibliography.tags||[],author:'Zotero Reader',created,updated:created,
      sources:['source.json'],source_base:'same-directory',source_ids:bibliography.sourceID?[bibliography.sourceID]:[],
      zotero_library_id:bibliography.libraryID||null,zotero_library_type:bibliography.libraryType||null,
      zotero_item_key:bibliography.itemKey||workflow.source?.key||null,zotero_attachment_key:bibliography.attachmentKey||workflow.source?.key||null,
      includes_supplements:(workflow.inputSources||[]).some(s=>s.role==='supplement'),
      doi:bibliography.doi||null,review_status:workflow.status==='checked'?'ai-text-checked; human-review-pending':workflow.status==='needs_review'?'ai-text-checked-with-issues; human-review-required':'draft; verification-incomplete',
      verification_manifest:'workflow.json',reading_scope:'parsed-text-only; figures-not-checked; journal-metrics-copied-from-Zotero'};
    return ['---',...Object.entries(front).map(([k,v])=>`${k}: ${JSON.stringify(v)}`),'---','',body.replace(/^# [^\n]*/,`# ${t.title}${workflow.status==='checked'?'':'【待核对草稿】'}`)].join('\n');
  }
  function receipt(bibliography={},source={},inputSources=[]){
    return {schema_version:1,source_type:source.synthetic?'synthetic-test':'zotero-reference',library_id:bibliography.libraryID||null,library_type:bibliography.libraryType||'local',
      item_key:bibliography.itemKey||source.key||null,title:bibliography.title||'',creators:bibliography.creators||[],date:bibliography.date||'',doi:bibliography.doi||'',zotero_uri:bibliography.itemURI||'',
      attachments:(inputSources.length?inputSources:source.key?[source]:[]).map(s=>({key:s.key,filename:s.name||'',role:s.role||'main',label:s.label||'正文',source_id:s.id||'M',content_type:'application/pdf',sha256:s.sha256||null})),
      scope:'Source identity and hash reference only. The reading is derived input; compiling and updating Wiki pages is a later step.'};
  }
  const api={titles,decorate,receipt};WikiCore=api;root.WikiCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
