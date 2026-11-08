var EngineCore;
(function(root){
  "use strict";
  const validID=id=>typeof id==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id);
  const name=engine=>engine==="antigravity"?"Antigravity":"ChatGPT（Codex CLI 通道）";
  const healthSchema={type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false};
  const EFFORTS=["none","minimal","low","medium","high","xhigh","max","ultra"];
  const effortLabel=value=>({none:"关闭",minimal:"极低",low:"低",medium:"中",high:"高",xhigh:"很高",max:"最高",ultra:"Ultra"}[value]||"默认");
  const healthKey=stage=>`${stage.engine}|${stage.model||"__default__"}`+(stage.effort?`|${stage.effort}`:"");
  function healthState(record,stage,catalog,now=Date.now()){
    if(!record||record.key!==healthKey(stage))return {state:"untested",label:"尚未验证"};
    const time=Date.parse(record.testedAt);
    if(!Number.isFinite(time)||now-time>24*60*60*1000||now<time-60000||catalog?.version&&record.version&&catalog.version!==record.version)return {state:"untested",label:"需要重新验证"};
    const incomplete=['TIMEOUT','NETWORK','CANCELLED'].includes(record.errorCode);
    const label=record.success?"测试通过":record.errorCode==='TIMEOUT'?"测试超时，尚未确认":incomplete?"测试未完成":"测试未通过";
    return {state:record.success?"available":incomplete?"untested":"unavailable",label,testedAt:record.testedAt};
  }
  function latestHealth(full,connection){
    const candidates=[{...full,scope:'full'},{...connection,scope:'connectivity'}].filter(r=>r.testedAt);
    const latest=candidates.sort((a,b)=>Date.parse(b.testedAt)-Date.parse(a.testedAt) || Number(a.state==='available')-Number(b.state==='available'))[0];
    if(!latest)return full;
    if(latest.state==='available')latest.label=latest.scope==='full'?'完整验证通过':`连通通过（${effortLabel(latest.testedStage?.effort)}档）`;
    return latest;
  }
  function normalizeModels(rows){
    const seen=new Set(),result=[];
    for(const m of rows||[]){
      const id=m.model||m.slug||m.id;
      if(!validID(id)||m.hidden||m.visibility==="hide"||seen.has(id))continue;
      if(Array.isArray(m.inputModalities)&&!m.inputModalities.includes("text"))continue;
      const raw=m.supportedReasoningEfforts||m.supported_reasoning_levels||m.reasoningEfforts||[];
      const reasoningEfforts=EFFORTS.filter(e=>raw.some(r=>(typeof r==="string"?r:r?.reasoningEffort||r?.effort)===e));
      const defaultEffort=m.defaultReasoningEffort||m.default_reasoning_level||m.defaultEffort||"";
      seen.add(id);result.push({id,label:String(m.displayName||m.display_name||m.label||id).slice(0,200),isDefault:m.isDefault===true,
        ...(reasoningEfforts.length?{reasoningEfforts,defaultEffort:reasoningEfforts.includes(defaultEffort)?defaultEffort:""}:{})});
    }
    return result;
  }
  function parseAgyModels(text){
    const rows=[];
    for(const line of text.replace(/\x1b\[[0-9;]*m/g,"").split(/\r?\n/)){
      const m=line.trim().match(/^([^\s]+)(?:\t+| {2,})(.+)$/);
      if(m&&validID(m[1])&&!/^(model|slug|id|fetching|available)$/i.test(m[1]))rows.push({id:m[1],label:m[2].trim()});
    }
    return normalizeModels(rows);
  }
  function modelChoices(engine,catalog){
    const groups=new Map();
    for(const m of catalog?.models||[]){
      const suffix=engine==="antigravity"&&m.id.match(/^(.*)-(low|medium|high)$/);
      const id=suffix?suffix[1]:m.id,effort=suffix?suffix[2]:"";
      if(!groups.has(id))groups.set(id,{id,label:suffix?m.label.replace(/\s*\((?:Low|Medium|High)\)\s*$/i,""):m.label,variants:[]});
      groups.get(id).variants.push({model:m.id,effort});
    }
    return [...groups.values()];
  }
  function effortChoices(stage,catalog){
    if(!stage.model)return [{value:"",label:"默认"}];
    if(stage.engine==="antigravity"){
      const group=modelChoices(stage.engine,catalog).find(g=>g.variants.some(v=>v.model===stage.model));
      const variants=group?.variants.filter(v=>v.effort)||[];
      return variants.length?EFFORTS.flatMap(e=>variants.filter(v=>v.effort===e).map(v=>({value:e,label:effortLabel(e),model:v.model}))):[{value:"",label:"默认"}];
    }
    const model=catalog?.models?.find(m=>m.id===stage.model);
    return [{value:"",label:"默认"},...(model?.reasoningEfforts||[]).map(value=>({value,label:effortLabel(value)}))];
  }
  function inferredEffort(stage){return stage.engine==="antigravity"?(stage.model?.match(/-(low|medium|high)$/)?.[1]||""):"";}
  function validEffort(stage,catalog){
    if(!stage.effort)return true;
    return effortChoices(stage,catalog).some(c=>c.value===stage.effort&&(!c.model||c.model===stage.model));
  }
  function quickStage(stage,catalog){
    const choices=effortChoices(stage,catalog).filter(c=>c.value),choice=choices[0];
    return choice?{engine:stage.engine,model:choice.model||stage.model,effort:choice.value}:{engine:stage.engine,model:stage.model||"",effort:""};
  }
  function connectionKey(stage,catalog){
    const family=modelChoices(stage.engine,catalog).find(g=>g.variants.some(v=>v.model===stage.model));
    return `connectivity:${stage.engine}|${family?.id||stage.model||"__default__"}`;
  }
  const agySettings={agentMode:"",toolPermission:"strict",allowNonWorkspaceAccess:false,notifications:false,
    disableSlashCommands:true,statusLine:{enabled:false},title:{enabled:false},
    permissions:{allow:[],ask:[],deny:["command(*)","read_file(*)","write_file(*)","read_url(*)","execute_url(*)","mcp(*)"]}};
  function agyArguments({model,effort,schemaPath,settingsPath,timeoutMs}){
    const args=["--input-format","stream-json","--output-format","stream-json","--disable-slash-commands",
      "--sandbox","--settings",settingsPath,"--print-timeout",`${Math.ceil(timeoutMs/1000)}s`];
    if(model){if(!validID(model))throw new Error("Invalid model ID");args.push("--model",model);}
    if(effort){if(!["low","medium","high"].includes(effort))throw new Error("Invalid Antigravity effort");args.push("--effort",effort);}
    if(schemaPath)args.push("--json-schema",schemaPath);
    return args;
  }
  function agyReader(report=()=>{}){
    let buffer="",result=null,count=0;
    return {push(text){
      buffer+=text;if(buffer.length>5*1024*1024)throw new Error("Antigravity output limit exceeded");
      const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){let event;try{event=JSON.parse(line);}catch(_){continue;}
        if(event.event==="init")report("Antigravity 已启动，正在生成…");
        if(event.event==="result"){count++;result=event.result;}
      }
    },finish(){if(buffer.trim()){this.push("\n");}return count===1?result:null;}};
  }
  async function codexCatalog(run,executable,signal){
    let buffer="",send,id=0,waiting=new Map(),models=[];
    const receive=text=>{
      buffer+=text;if(buffer.length>2*1024*1024)throw new Error("Model catalog output too large");
      const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){let message;try{message=JSON.parse(line);}catch(_){continue;}
        const pending=waiting.get(message.id);if(!pending)continue;waiting.delete(message.id);
        message.error?pending.reject(new Error("Model catalog RPC rejected")):pending.resolve(message.result);
      }
    };
    const request=(method,params)=>new Promise((resolve,reject)=>{
      const key=++id;waiting.set(key,{resolve,reject});send.write(JSON.stringify({id:key,method,params})+"\n").catch(reject);
    });
    const response=await run(executable,["app-server","--listen","stdio://","--disable","plugins","--disable","plugin_discovery_prefetch","--disable","shell_snapshot"],{timeoutMs:45000,signal,onStdout:receive,
      writeInput:async stdin=>{
        send=stdin;await request("initialize",{clientInfo:{name:"zotero_reader_independent",title:"Zotero Reader",version:"0.14.24"}});
        await stdin.write(JSON.stringify({method:"initialized"})+"\n");
        let cursor=null;
        for(let page=0;page<10;page++){
          const result=await request("model/list",{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
          if(!Array.isArray(result?.data))throw new Error("Invalid model catalog");
          models.push(...result.data);cursor=result.nextCursor;if(!cursor)break;
        }
      }});
    if(response.exitCode!==0)throw new Error("Model catalog process failed");
    const normalized=normalizeModels(models);if(!normalized.length)throw new Error("No models returned");return normalized;
  }
  const api={validID,name,EFFORTS,effortLabel,modelChoices,effortChoices,inferredEffort,validEffort,quickStage,connectionKey,healthSchema,healthKey,healthState,latestHealth,normalizeModels,parseAgyModels,agySettings,agyArguments,agyReader,codexCatalog};EngineCore=api;root.EngineCore=api;
  if(typeof module!=="undefined")module.exports=api;
})(globalThis);
