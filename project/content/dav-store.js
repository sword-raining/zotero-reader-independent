"use strict";
var DAVStore;
(function(root){
 const keyOK=key=>/^(?:probe-)?[a-f0-9]{64}$/.test(key);
 function error(code,message){return Object.assign(new Error(message),{code});}
 function create(send,{baseURL,nonce}){
  const hints=new Map(),probeFiles=new Map();
  const versionName=(key,v)=>key+'-v'+String(v).padStart(8,'0')+'.json',headName=key=>key+'-head.json';
  const tracked=(key,name)=>{if(key.startsWith('probe-')){if(!probeFiles.has(key))probeFiles.set(key,new Set());probeFiles.get(key).add(name);}};
  const now=r=>{const value=Date.parse(r.date);if(!Number.isFinite(value))throw error('COORD_CLOCK','协作服务没有可确认的服务器时间。');return value;};
  const get=async name=>{const r=await send('GET',name);if(![200,404].includes(r.status))throw error('COORD_HTTP','协作读取失败（HTTP '+r.status+'）。');return r;};
  const json=r=>{if(r.text.length>16384)throw error('COORD_FORMAT','协作记录异常过大，未覆盖。');try{return JSON.parse(r.text);}catch(_){throw error('COORD_FORMAT','协作记录无法读取，未覆盖。');}};
  async function read(key){
   if(!keyOK(key))throw error('COORD_PATH','协作身份无效。');
   const hint=await get(headName(key));let n=hints.get(key)||1;
   if(hint.status===200)try{const value=JSON.parse(hint.text);if(Number.isSafeInteger(value.version)&&value.version>=1&&value.version<100000000)n=Math.max(n,value.version);}catch(_){}
   let r=await get(versionName(key,n));
   if(r.status===404){if(n!==1)throw error('COORD_HISTORY','协作版本暂未就绪，未从空记录重新开始。');return {record:null,etag:null,now:now(r)};}
   let record=json(r);
   for(let i=0;i<64;i++){
    const next=await get(versionName(key,n+1));
    if(next.status===404){hints.set(key,n);return {record,etag:'"zri-move-v2:'+key+':'+n+'"',now:now(next)};}
    record=json(next);n++;
   }
   throw error('COORD_HISTORY','协作版本指针落后过多，已暂停而非猜测最新处理权。');
  }
  async function write(key,value,etag){
   if(!keyOK(key))throw error('COORD_PATH','协作身份无效。');
   let previous=0;if(etag){const match=String(etag).match(/^"zri-move-v2:((?:probe-)?[a-f0-9]{64}):([1-9][0-9]{0,7})"$/);if(!match||match[1]!==key)throw error('COORD_ETAG','协作版本标记不属于此任务。');previous=Number(match[2]);}
   const version=previous+1;if(version>=100000000)throw error('COORD_HISTORY','协作版本超出支持范围。');
   const token=nonce();if(!/^[A-Za-z0-9]{16,64}$/.test(token))throw error('COORD_PATH','临时传输身份无效。');
   const temp=key+'-tmp-'+token+'.json',target=versionName(key,version);let uploaded=false;
   try{
    const body=JSON.stringify(value),put=await send('PUT',temp,body);if(![200,201,204].includes(put.status))throw error('COORD_HTTP','协作暂存失败（HTTP '+put.status+'）。');uploaded=true;tracked(key,temp);
    const moved=await send('MOVE',temp,null,{Destination:baseURL+target,Overwrite:'F'});
    if(moved.status===412)return false;
    if(moved.status!==201)throw error('COORD_UNSAFE','服务未确认创建唯一新版本（HTTP '+moved.status+'），未启用或继续协作。');
    tracked(key,target);hints.set(key,version);
    // This is only an advisory pointer. Immutable next-version creation is the actual CAS.
    try{const hint=await send('PUT',headName(key),JSON.stringify({version}));if([200,201,204].includes(hint.status))tracked(key,headName(key));}catch(_){}
    return true;
   }finally{if(uploaded)try{await send('DELETE',temp);}catch(_){/* Own random temporary file only. */}}
  }
  async function removeProbe(key){if(!key.startsWith('probe-')||!keyOK(key))throw error('COORD_PATH','只能清理本次随机检测记录。');for(const name of probeFiles.get(key)||[])await send('DELETE',name);probeFiles.delete(key);hints.delete(key);}
  return {read,write,removeProbe,protocol:'immutable-move-v2'};
 }
 const api={create};DAVStore=api;root.DAVStore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
