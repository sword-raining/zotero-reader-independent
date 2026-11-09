"use strict";
var CoordinationCore;
(function(root){
 const keyOK=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 const idOK=x=>typeof x==='string'&&/^[a-zA-Z0-9-]{16,80}$/.test(x);
 const noteOK=x=>typeof x==='string'&&/^[A-Z0-9]{8}$/.test(x);
 const states=new Set(['running','parked','committing','done','available']);
 function error(code,message){return Object.assign(new Error(message),{code});}
 function validate(r,key){
  if(!r||r.schema!==1||r.task!==key||!keyOK(r.task)||!idOK(r.owner)||!idOK(r.token)||!states.has(r.state)||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isFinite(r.updatedAt)||!Number.isFinite(r.expiresAt)||!keyOK(r.inputHash)||r.state==='done'&&!noteOK(r.noteKey))throw error('COORD_FORMAT','协作记录格式无法确认，已停止争抢；未覆盖远端记录。');
  return r;
 }
 class Client {
  constructor({store,owner,nonce,leaseMs=12*60*1000}){if(!idOK(owner)||typeof nonce!=='function'||leaseMs<60000||leaseMs>3600000)throw error('COORD_CONFIG','协作身份或有效期无效。');Object.assign(this,{store,owner,nonce,leaseMs});}
  async load(key){if(!keyOK(key))throw error('COORD_KEY','协作任务身份无效。');const s=await this.store.read(key);if(!Number.isFinite(s.now))throw error('COORD_CLOCK','协作服务没有可确认的服务器时间。');if(s.record){validate(s.record,key);if(!s.etag||/^W\//i.test(s.etag))throw error('COORD_ETAG','协作服务未提供强版本标记，未继续。');}return s;}
  async write(key,record,etag){validate(record,key);return this.store.write(key,record,etag);}
  async claim(key,inputHash,{resumeToken=null}={}){
   if(!keyOK(inputHash))throw error('COORD_INPUT','无法确认本轮附件指纹。');
   const s=await this.load(key),r=s.record;
   if(r?.state==='done')return {kind:r.inputHash===inputHash?'done':'different-input',record:r};
   if(r?.state==='committing')return {kind:'committing',record:r};
   const mine=r?.state==='parked'&&r.owner===this.owner&&r.token===resumeToken&&r.inputHash===inputHash;
   if(r&&(r.state==='parked'&&!mine||r.state==='running'&&r.expiresAt>s.now))return {kind:r.state==='parked'?'parked':'busy',record:r,retryMs:Math.max(5000,r.expiresAt-s.now+3000)};
   const token=mine?r.token:this.nonce();if(!idOK(token))throw error('COORD_CONFIG','协作令牌无效。');
   const next={schema:1,task:key,inputHash,owner:this.owner,token,state:'running',revision:(r?.revision||0)+1,updatedAt:s.now,expiresAt:s.now+this.leaseMs};
   if(!await this.write(key,next,s.etag))return {kind:'race',retryMs:5000};
   return {kind:'owned',handle:{key,token,inputHash,state:'running'}};
  }
  async owned(h,{allowCommit=false}={}){
   const s=await this.load(h.key),r=s.record;
   if(!r||r.owner!==this.owner||r.token!==h.token||r.inputHash!==h.inputHash||!(r.state==='running'&&r.expiresAt>s.now||allowCommit&&r.state==='committing'))throw error('COORD_LOST','此篇处理权已失效，已停止后续调用和写入；本地草稿保留。');
   return s;
  }
  async change(h,state,extra={},allowCommit=false){
   const s=await this.owned(h,{allowCommit}),r=s.record;
   if(r.state==='committing'&&state!=='done')throw error('COORD_COMMIT','此篇已进入保存保护，不能自动释放或重跑。');
   const next={...r,...extra,state,revision:r.revision+1,updatedAt:s.now,expiresAt:state==='running'?s.now+this.leaseMs:0};
   if(!await this.write(h.key,next,s.etag))throw error('COORD_LOST','另一端已更新处理权，未执行后续写入；本地稿件保留。');
   h.state=state;return next;
  }
  async rollback(h){const s=await this.owned(h,{allowCommit:true});if(s.record.state!=='committing')throw error('COORD_PHASE','没有可撤回的保存保护。');if(!await this.write(h.key,{...s.record,state:'parked',revision:s.record.revision+1,updatedAt:s.now,expiresAt:0},s.etag))throw error('COORD_LOST','保存回滚记录待确认。');h.state='parked';}
  renew(h){return this.change(h,'running');}
  commit(h){return this.change(h,'committing');}
  complete(h,noteKey){if(!noteOK(noteKey))throw error('COORD_NOTE','尚未确认已保存笔记，未登记完成。');return this.change(h,'done',{noteKey},true);}
  park(h){return this.change(h,'parked');}
  release(h){return this.change(h,'available');}
 }
 // Both create-if-absent and compare-and-swap must be proved on a disposable resource.
 async function probe(store,key,nonce){
  const r={schema:1,task:key,inputHash:key,owner:nonce(),token:nonce(),state:'available',revision:1,updatedAt:0,expiresAt:0};
  let written=false;
  try{
   const first=await store.read(key);if(first.record)throw error('COORD_PROBE','检测名称已存在，未覆盖。');r.updatedAt=first.now;
   if(!await store.write(key,r,null))throw error('COORD_PROBE','服务拒绝检测写入。');written=true;
   if(await store.write(key,{...r,revision:2},null))throw error('COORD_UNSAFE','服务忽略了“仅新建”条件，不能用于多机协作。');
   const a=await store.read(key);if(a.record.revision!==1||!a.etag||/^W\//i.test(a.etag))throw error('COORD_UNSAFE','服务的版本标记不可靠，不能用于多机协作。');
   const tries=await Promise.all([2,3,4].map(revision=>store.write(key,{...r,revision},a.etag)));
   if(tries.filter(Boolean).length!==1)throw error('COORD_UNSAFE','三端同时领取检测未得到唯一成功者，未启用协作。');
   const b=await store.read(key);if(b.record.revision!==[2,3,4][tries.indexOf(true)]||b.etag===a.etag)throw error('COORD_UNSAFE','服务未保留唯一获胜版本，未启用协作。');
   if(await store.write(key,{...r,revision:9},a.etag))throw error('COORD_UNSAFE','服务允许过期版本覆盖，未启用协作。');
   const c=await store.read(key);if(c.record.revision!==b.record.revision)throw error('COORD_UNSAFE','条件失败后内容发生变化，未启用协作。');
   return {protocol:1,atomicCreate:true,atomicUpdate:true,contenders:3};
  }finally{if(written)try{await store.removeProbe(key);}catch(_){/* Only this random probe may remain; never delete a task record. */}}
 }
 const api={Client,probe,validate,error,keyOK,idOK};CoordinationCore=api;root.CoordinationCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
