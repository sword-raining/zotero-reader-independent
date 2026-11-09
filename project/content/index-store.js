"use strict";
var IndexCore;
(function(root){
 const fields={'queue.json':'jobs','saved-notes.json':'records','classification-proposals.json':'proposals','coordination-local.json':'records'};
 const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),key=x=>typeof x==='string'&&/^[A-Z0-9]{8}$/.test(x),id=x=>typeof x==='string'&&/^[a-z0-9-]{8,100}$/.test(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 function valid(name,data){
  const field=fields[name];if(!field||!object(data)||data.schema!==1||!object(data[field]))return false;
  return Object.entries(data[field]).every(([k,v])=>{
   if(!object(v))return false;
   if(name==='queue.json')return Number.isInteger(v.libraryID)&&key(v.key)&&k===v.libraryID+':'+v.key&&v.id===k&&['auto','manual'].includes(v.trigger)&&['queued','waiting_file','running','done','imported','needs_review','verification_incomplete','awaiting_import','awaiting_selection','failed','cancelled'].includes(v.state);
   if(name==='saved-notes.json')return id(k)&&v.runID===k&&Number.isInteger(v.libraryID)&&key(v.noteKey)&&key(v.attachmentKey)&&['checked','edited'].includes(v.status)&&Array.isArray(v.inputs);
   if(name==='classification-proposals.json')return Number.isInteger(v.libraryID)&&key(v.itemKey)&&key(v.noteKey)&&v.id===k&&k===v.libraryID+':'+v.itemKey&&['pending','confirming','confirmed','dismissed'].includes(v.status)&&typeof v.noteHash==='string';
   return hash(k)&&typeof v.token==='string'&&/^[A-Za-z0-9-]{16,80}$/.test(v.token)&&hash(v.inputHash);
  });
 }
 class Store {
  constructor(io,{notify=()=>{},nonce=()=>String(Date.now())}={}){Object.assign(this,{io,notify,nonce});this.entries=new Map();this.problems=new Map();this.chains=new Map();}
  isMissing(e){return e?.name==='NotFoundError'||e?.code==='ENOENT';}
  async raw(path){try{return await this.io.read(path);}catch(e){if(this.isMissing(e))return null;throw e;}}
  async block(path,name,reason,{backup=false}={}){
   if(this.problems.has(path))return this.problems.get(path);
   const problem={path,name,reason,backup:null};this.problems.set(path,problem);
   if(backup)try{const target=path+'.preserved-'+Date.now()+'-'+this.nonce()+'.bak';await this.io.copy(path,target);problem.backup=target;}catch(_){problem.backupFailed=true;}
   this.notify();return problem;
  }
  assertHealthy(){if(this.problems.size){const names=[...this.problems.values()].map(p=>p.name).join('、');const e=new Error('本地索引无法安全读取或保存（'+names+'），已暂停写入，原文件保留。请核对备份并修复后重启；不要清空索引。');e.code='INDEX_BLOCKED';throw e;}}
  open(path,name,{duringWrite=false}={}){
   if(duringWrite)return this._open(path,name);
   const task=(this.chains.get(path)||Promise.resolve()).catch(()=>{}).then(()=>this._open(path,name));this.chains.set(path,task);return task;
  }
  async _open(path,name){
   if(this.problems.has(path))return null;
   let raw;try{raw=await this.raw(path);}catch(_){await this.block(path,name,'无法读取');return null;}
   if(this.entries.has(path)&&raw!==this.entries.get(path).raw){await this.block(path,name,'文件在插件外发生变化',{backup:raw!==null});return null;}
   if(raw===null){this.entries.set(path,{name,raw:null,value:null});return null;}
   let value;try{value=JSON.parse(raw);}catch(_){await this.block(path,name,'JSON 损坏',{backup:true});return null;}
   if(!valid(name,value)){await this.block(path,name,'结构或版本无法识别',{backup:true});return null;}
   this.entries.set(path,{name,raw,value});return JSON.parse(raw);
  }
  save(path,name,value){
   // Capture at request time, then serialize all writes to this one index.
   let raw;try{raw=JSON.stringify(value,null,2);}catch(e){return Promise.reject(e);}
   const task=(this.chains.get(path)||Promise.resolve()).catch(()=>{}).then(async()=>{
    if(!this.entries.has(path))await this.open(path,name,{duringWrite:true});this.assertHealthy();
    if(!valid(name,JSON.parse(raw))){const e=new Error('拒绝写入不完整的 '+name+'，原索引保留。');e.code='INDEX_FORMAT';throw e;}
    const entry=this.entries.get(path);let current;
    try{current=await this.raw(path);}catch(_){await this.block(path,name,'保存前无法读取');this.assertHealthy();}
    if(current!==entry.raw){await this.block(path,name,'文件在插件外发生变化',{backup:current!==null});this.assertHealthy();}
    try{
     if(current!==null)await this.io.write(path+'.last-good.json',current);
     await this.io.write(path,raw);entry.raw=raw;entry.value=JSON.parse(raw);
    }catch(_){await this.block(path,name,'写入或备份失败');this.assertHealthy();}
   });this.chains.set(path,task);return task;
  }
 }
 const api={fields,valid,Store};IndexCore=api;root.IndexCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
var ReaderIndexes={
 store:null,views:new Set(),
 init(){this.store=new IndexCore.Store({read:p=>IOUtils.readUTF8(p),copy:(p,target)=>IOUtils.copy(p,target,{noOverwrite:true}),write:async(p,text)=>{await IOUtils.makeDirectory(PathUtils.parent(p),{createAncestors:true});await IOUtils.writeUTF8(p,text,{tmpPath:p+'.tmp'});}},{notify:()=>this.render(),nonce:()=>Zotero.Utilities.randomString(8)});},
 name(path){const name=PathUtils.filename(path);return Object.hasOwn(IndexCore.fields,name)&&path===PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent',name)?name:null;},
 assertHealthy(){this.store?.assertHealthy();},
 bind(win){this.views.add(win);win.addEventListener('unload',()=>this.views.delete(win),{once:true});this.render();},
 render(){const problems=[...this.store.problems.values()];for(const win of [...this.views]){if(win.closed){this.views.delete(win);continue;}const status=win.document.getElementById('zri-index-status');if(status){status.hidden=!problems.length;status.textContent=problems.length?'本地索引异常，精读、保存、归档和清理写入已暂停。'+problems.map(p=>p.name+'：'+p.reason+(p.backup?'（已备份并保留原文件）':'（原文件保留）')).join('；')+'。请核对备份、修复后重启；不要删除索引来重试。':'';}}}
};
