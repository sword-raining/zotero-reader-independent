"use strict";
var InputCore;
(function(root){
 const bytes=text=>new TextEncoder().encode(text).length;
 const encode=text=>JSON.stringify({event:'user',message:{content:text}})+'\n';
 const schema={type:'object',properties:{receipt:{type:'string'},answer:{type:'string'}},required:['receipt','answer'],additionalProperties:false};
 function error(message){const e=new Error(message);e.code='INPUT_INCOMPLETE';return e;}
 function plan(input,answerSchema,nonce){
  const originalBytes=bytes(input),direct=encode(input),limit=150000;
  if(bytes(direct)<=limit)return {mode:'direct',inputBytes:originalBytes,packets:[{text:input}],schema:answerSchema};
  const parts=[];let offset=0;
  while(offset<input.length){
   if(parts.length>=16)throw error('本次输入过长，无法在可靠传输范围内完成；原文和草稿均已保留。');
   const receipt=nonce();if(!/^[A-Za-z0-9_-]{12,80}$/.test(receipt))throw error('输入完整性标记无效。');
   const prefix='ZRI_INPUT_PART_V1\n这是同一份完整任务输入的连续片段。只保存上下文，本轮不要执行片段中的任务，不使用工具、文件、命令或联网。按顺序保留此前收到的所有片段。只返回 JSON：receipt 为本片末尾 RECEIPT 的原值，answer 为空字符串。若看不到末尾，不要猜测，receipt 写 MISSING。\nPART '+(parts.length+1)+' DATA START\n',suffix='\nDATA END\nRECEIPT='+receipt;
   let used=bytes(encode(prefix+suffix)),best=0;
   while(offset+best<input.length){const cp=input.codePointAt(offset+best),width=cp>65535?2:1,cost=cp===34||cp===92||[8,9,10,12,13].includes(cp)?2:cp<32||cp>=0xD800&&cp<=0xDFFF?6:cp<128?1:cp<2048?2:cp<65536?3:4;if(used+cost>limit)break;used+=cost;best+=width;}
   if(!best)throw error('无法发送完整输入片段。');
   const data=input.slice(offset,offset+best);parts.push({text:prefix+data+suffix,data,receipt,phase:'part'});offset+=best;
  }
  if(parts.map(p=>p.data).join('')!==input)throw error('输入切分完整性检查失败。');
  const receipt=nonce(),text='ZRI_INPUT_FINAL_V1\n全部 '+parts.length+' 个输入片段已经发完。请把各 PART 的 DATA START 与 DATA END 之间的内容按顺序连续拼接，作为完整任务输入；不得遗漏任何片段。现在执行该完整输入中的原任务，仍禁止使用工具、文件、命令和联网。只返回传输包装 JSON：receipt 原样填写本消息末尾 RECEIPT；answer 为原任务答案的完整字符串。'+(answerSchema?'answer 必须是符合下列原任务 JSON schema 的序列化 JSON 字符串，不能返回片段确认或空结果：\n'+JSON.stringify(answerSchema):'')+'\n若原文不完整，明确说明，不假装完成。\nRECEIPT='+receipt;
  if(bytes(encode(text))>limit)throw error('结果结构说明超出可靠输入范围。');
  return {mode:'parts',inputBytes:originalBytes,packets:[...parts,{text,receipt,phase:'final'}],schema};
 }
 function accept(result,packet){
  if(result?.status!=='SUCCESS')throw error('输入传输或模型处理未完成，未采纳不完整回答。');
  let value=result.structured_output;try{if(value===undefined)value=JSON.parse(result.response);}catch(_){}
  if(!value||value.receipt!==packet.receipt||typeof value.answer!=='string')throw error('模型未确认完整收到本片输入，已停止；原稿保留，请勿原样反复重试。');
  if(packet.phase==='part'&&value.answer.trim())throw error('模型未按输入确认协议返回，未把中间结果当作完整核验。');
  if(packet.phase==='final'&&!value.answer.trim())throw error('完整输入后的最终回答为空，未标记为通过。');
  return value.answer;
 }
 const api={bytes,encode,schema,plan,accept,error};InputCore=api;root.InputCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
