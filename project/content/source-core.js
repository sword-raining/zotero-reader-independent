/* Read-only assembly of MinerU text and omitted page footnotes. */
var SourceCore;
(function(root){
 'use strict';
 const VERSION=1,MAX_CHARS=400000,MAX_JSON_BYTES=32*1024*1024,MAX_TOTAL_JSON_BYTES=64*1024*1024;
 class SourceError extends Error{constructor(code,message){super(message);this.name='SourceError';this.code=code;}}
 const error=(code,message)=>new SourceError(code,message);
 const format=path=>/(?:^|\/)layout\.json$/i.test(path)?'layout':/(?:^|\/)(?:[^/]*_)?content_list_v2\.json$/i.test(path)?'v2':/(?:^|\/)(?:[^/]*_)?content_list\.json$/i.test(path)?'v1':null;
 function files(manifest){return (manifest.files||[]).filter(f=>f&&typeof f.path==='string'&&format(f.path)).map(f=>({...f,format:format(f.path)})).sort((a,b)=>['v1','v2','layout'].indexOf(a.format)-['v1','v2','layout'].indexOf(b.format)||a.path.localeCompare(b.path));}
 const comparable=text=>String(text).replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/\s+/gu,'');
 function footnotes(data,kind){
  const found=[];
  const add=(text,pageIndex)=>{if(typeof text!=='string'||!text.trim())return;found.push({text:text.trim(),pageIndex:Number.isInteger(pageIndex)&&pageIndex>=0&&pageIndex<10000?pageIndex:null});};
  if(kind==='v1'){
   if(!Array.isArray(data))throw error('SOURCE_STRUCTURE','页面脚注的结构化内容格式无效。');
   for(const item of data)if(item?.type==='page_footnote'){if(typeof item.text!=='string')throw error('SOURCE_STRUCTURE','页面脚注缺少可读取的文本。');add(item.text,item.page_idx);}
  }else if(kind==='v2'){
   if(!Array.isArray(data)||data.some(page=>!Array.isArray(page)))throw error('SOURCE_STRUCTURE','新版页面脚注的结构化内容格式无效。');
   for(const [pageIndex,page]of data.entries())for(const item of page)if(item?.type==='page_footnote'){
    const parts=item.content?.page_footnote_content;if(!Array.isArray(parts)||parts.some(p=>typeof p?.content!=='string'))throw error('SOURCE_STRUCTURE','新版页面脚注缺少可读取的文本。');add(parts.map(p=>p.content).join(' '),pageIndex);
   }
  }else if(kind==='layout'){
   if(!Array.isArray(data?.pdf_info))throw error('SOURCE_STRUCTURE','页面布局记录格式无效。');
   for(const [index,page]of data.pdf_info.entries())for(const item of [...(page.discarded_blocks||[]),...(page.para_blocks||[]),...(page.preproc_blocks||[])])if(item?.type==='page_footnote'){
    if(!Array.isArray(item.lines))throw error('SOURCE_STRUCTURE','页面布局脚注缺少文本行。');
    const lines=item.lines.map(line=>{if(!Array.isArray(line.spans)||line.spans.some(s=>typeof s?.content!=='string'))throw error('SOURCE_STRUCTURE','页面布局脚注缺少文本片段。');return line.spans.map(s=>s.content).join(' ');});add(lines.join(' '),Number.isInteger(page.page_idx)?page.page_idx:index);
   }
  }else throw error('SOURCE_STRUCTURE','未知的页面脚注格式。');
  return found;
 }
 function assertPageLimit(inputs,limit){
  if(!limit)return;let seen=0;
  const check=(index,hasContent=true)=>{if(!hasContent)return;if(!Number.isInteger(index)||index<0)throw error('SOURCE_SCOPE','解析结果缺少可靠页码，未猜测前 20 页。');seen++;if(index>=limit)throw error('SOURCE_SCOPE','解析结果包含阅读范围以外的页面，未把它冒充前 20 页。');};
  for(const input of inputs){if(input.format==='v1'&&Array.isArray(input.data))for(const row of input.data)check(row?.page_idx);else if(input.format==='v2'&&Array.isArray(input.data))for(const [i,page]of input.data.entries())check(i,Array.isArray(page)&&page.length>0);else if(input.format==='layout'&&Array.isArray(input.data?.pdf_info))for(const [i,page]of input.data.pdf_info.entries())check(Number.isInteger(page.page_idx)?page.page_idx:i,[...(page.para_blocks||[]),...(page.discarded_blocks||[]),...(page.preproc_blocks||[])].length>0);}
  if(!seen)throw error('SOURCE_SCOPE','解析结果没有可核对的页码，未自动采用不明范围的内容。');
 }
 function assemble(markdown,inputs=[]){
  if(typeof markdown!=='string'||!markdown.trim())throw error('NO_TEXT','解析正文为空。');
  if(markdown.length>MAX_CHARS)throw error('TEXT_SIZE','解析正文过长，未截断后发送。');
  const main=comparable(markdown),seen=new Set(),added=[],inspected=[];let chars=markdown.length;
  for(const input of inputs){const notes=footnotes(input.data,input.format);inspected.push({path:input.path,format:input.format,footnotes:notes.length});
   for(const note of notes){const normalized=comparable(note.text);if(!normalized||seen.has(normalized)||main.includes(normalized))continue;seen.add(normalized);const prefix=note.pageIndex===null?'【解析结果中的页面脚注】':`【解析结果中的页面脚注 · PDF 第 ${note.pageIndex+1} 页】`,block=prefix+'\n'+note.text;chars+=block.length+2;if(chars>MAX_CHARS)throw error('TEXT_SIZE','正文与页面脚注合计过长，未截断后发送。');added.push({...note,path:input.path,block});}
  }
  return {markdown:markdown+(added.length?'\n\n'+added.map(n=>n.block).join('\n\n'):''),diagnostics:{version:VERSION,structuredAvailable:inputs.length>0,inspected,addedFootnotes:added.length,footnotePages:[...new Set(added.map(n=>n.pageIndex).filter(x=>x!==null))].map(x=>x+1)}};
 }
 const api={VERSION,MAX_CHARS,MAX_JSON_BYTES,MAX_TOTAL_JSON_BYTES,SourceError,files,footnotes,assertPageLimit,assemble};SourceCore=api;root.SourceCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
