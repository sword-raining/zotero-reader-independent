"use strict";
var LanguageCore;
(function(root){
 function textKind(text){const s=String(text||'').slice(0,24000),han=(s.match(/[\u3400-\u9fff]/g)||[]).length,latin=(s.match(/[A-Za-z]/g)||[]).length;if(han>=100&&han/(han+latin)>=0.35)return 'zh';if(latin>=400&&han/(han+latin)<0.05)return 'en';return 'unknown';}
 function titleChinese(title){const s=String(title||''),han=(s.match(/[\u3400-\u9fff]/g)||[]).length,latin=(s.match(/[A-Za-z]/g)||[]).length;return han>=6&&han/(han+latin)>=0.6;}
 function infer({language='',title='',text=''}={}){const raw=String(language).trim().toLowerCase().replace(/_/g,'-');const chinese=raw.split(/[;,/|+、&]+/).some(x=>/^(?:zh(?:-[a-z0-9]+)*|zho|chi|cmn|chinese|中文|汉语|漢語|简体中文|繁体中文)$/.test(x.trim()));const kind=textKind(text);if(kind!=='unknown')return {kind,chinese:kind==='zh',basis:'PDF 正文文字'};if(chinese)return {kind:'zh',chinese:true,basis:'Zotero 语言字段'};if(titleChinese(title))return {kind:'zh',chinese:true,basis:'中文题名（正文语言尚未确认）'};return {kind:/^(en(?:-[a-z0-9]+)*|eng|english|英文|英语)$/.test(raw)?'en':'unknown',chinese:false,basis:raw?'Zotero 语言字段':'语言未明确'};}
 const api={infer,textKind,titleChinese};LanguageCore=api;root.LanguageCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
var ReaderLanguage={
 cache:new Map(),
 skip(job){if(job?.skipChinese!==undefined)return job.skipChinese!==false;return Zotero.Prefs.get(ReaderApp.pref+'reading.skipChinese',true)!==false;},
 async inspect(att,{text=''}={}){
  const item=att.parentID?await Zotero.Items.getAsync(att.parentID):att,language=item?.isRegularItem?.()?String(item.getField('language')||''):'',title=item?.getField('title')||'';
  if(text)return LanguageCore.infer({language,title,text});
  const initial=LanguageCore.infer({language,title});
  if(!LanguageCore.titleChinese(title)||BatchCore.languageInfo(language).chinese||!Zotero.PDFWorker?.getFullText)return initial;
  try{
   const path=await att.getFilePathAsync(),stat=path&&await IOUtils.stat(path);if(!stat||stat.size>40*1024*1024)return initial;
   const key=att.libraryID+':'+att.key+':'+stat.size+':'+stat.lastModified;if(this.cache.has(key))return this.cache.get(key);
   let timer;const result=await Promise.race([Zotero.PDFWorker.getFullText(att.id,2,true),new Promise(resolve=>{timer=ReaderTimers.setTimeout(()=>resolve(null),5000);})]).finally(()=>ReaderTimers.clearTimeout(timer));
   const next=LanguageCore.infer({language,title,text:result?.text||''});if(this.cache.size>256)this.cache.clear();this.cache.set(key,next);return next;
  }catch(_){return initial;}
 },
 async check(att,job,text=''){if(!this.skip(job))return;const info=await this.inspect(att,{text});if(info.chinese)throw NoteCore.error('LANGUAGE_SKIPPED','已跳过中文论文（'+info.basis+'）；未继续精读，已有稿件保留。需要处理中文时可关闭“默认跳过中文论文”，或在本次批量选择中取消跳过。');},
 bind(win){const box=win.document.getElementById('zri-skip-chinese');if(!box||box.dataset.bound)return;box.dataset.bound='true';box.checked=this.skip();box.addEventListener('change',()=>Zotero.Prefs.set(ReaderApp.pref+'reading.skipChinese',box.checked,true));}
};
