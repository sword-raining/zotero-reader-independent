"use strict";
var ReaderEngines={
  app:null,catalogs:{},health:{},probeCache:new Map(),inflight:{},controllers:{},closing:false,views:new Set(),
  async init(app){
    this.app=app;this.closing=false;this.probeCache.clear();
    const dir=PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent");
    this.health=(await app.readJSON(PathUtils.join(dir,"model-health.json")))||{};
    for(const engine of ['codex','antigravity']){
      const cached=await app.readJSON(PathUtils.join(dir,`models-${engine}.json`));
      if(cached?.models?.length)this.catalogs[engine]={...cached,models:EngineCore.normalizeModels(cached.models),cached:true};
    }
  },
  async prepare(engine,signal){
    const executable=await this.resolve(engine),stat=await IOUtils.stat(executable.command);
    const key=JSON.stringify([engine,executable.command,executable.prefix,stat.size,stat.lastModified]);
    const cached=this.probeCache.get(key);
    if(cached&&Date.now()-cached.at<300000)return {executable,version:cached.version,cached:true};
    const version=await this.probe(engine,executable,signal);
    this.probeCache.set(key,{version,at:Date.now()});return {executable,version,cached:false};
  },
  async recordHealth(stage,result){
    const key=EngineCore.healthKey(stage),record={key,engine:stage.engine,model:stage.model||null,effort:stage.effort||null,testedAt:new Date().toISOString(),success:result.success===true,version:result.version||null,errorCode:result.errorCode||null,durationMs:result.durationMs||null};
    if(!result.connectivityOnly)this.health[key]=record;
    if(result.requestedStage){const alias=EngineCore.connectionKey(result.requestedStage,this.catalogs[stage.engine]);this.health[alias]={...record,key:alias,testedStage:{...stage}};}
    try{const dir=PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent");await IOUtils.makeDirectory(dir,{createAncestors:true,ignoreExisting:true});await this.app.writeJSON(PathUtils.join(dir,"model-health.json"),this.health);}catch(_){}
    return record;
  },
  healthFor(stage){return EngineCore.healthState(this.health[EngineCore.healthKey(stage)],stage,this.catalogs[stage.engine]);},
  connectivityFor(stage){
    const record=this.health[EngineCore.connectionKey(stage,this.catalogs[stage.engine])];
    if(!record?.testedStage)return {state:'untested',label:'尚未验证'};
    const actual=record.testedStage,h=EngineCore.healthState({...record,key:EngineCore.healthKey(actual)},actual,this.catalogs[stage.engine]);
    return {...h,testedStage:actual,label:h.state==='available'?`连通通过（${EngineCore.effortLabel(actual.effort)}档测试）`:h.label};
  },
  stage(which){
    const p=this.app.pref;
    const gen=Zotero.Prefs.get(p+"ai.generation.engine",true)==="antigravity"?"antigravity":"codex";
    const configured=Zotero.Prefs.get(p+`ai.${which}.engine`,true);
    const engine=which==="generation"?gen:["codex","antigravity"].includes(configured)?configured:gen;
    const selected=Zotero.Prefs.get(p+`ai.${which}.model`,true);
    const legacy=which==="generation"?Zotero.Prefs.get(p+"codex.model",true):Zotero.Prefs.get(p+"codex.verifyModel",true)||Zotero.Prefs.get(p+"codex.model",true);
    const model=CodexCore.options({model:selected===undefined?legacy:selected}).model;
    const saved=Zotero.Prefs.get(p+`ai.${which}.effort`,true);
    return {engine,model,effort:saved||EngineCore.inferredEffort({engine,model})};
  },
  async validateEffort(stage){
    if(!stage.effort)return;
    if(!this.catalogs[stage.engine]?.models?.some(m=>m.id===stage.model))await this.discover(stage.engine);
    if(!EngineCore.validEffort(stage,this.catalogs[stage.engine]))throw CodexCore.error("EFFORT","当前模型目录不支持所选思考强度，请刷新目录并重新选择。");
  },
  async resolve(engine){
    if(engine==="codex")return ReaderCodex.resolveExecutable();
    const custom=String(Zotero.Prefs.get(this.app.pref+"agy.path",true)||"").trim().replace(/^"(.*)"$/,"$1");
    const candidates=[];
    if(custom)candidates.push(custom);
    else{
      try{candidates.push(await ReaderCodex.subprocess().pathSearch(Zotero.isWin?"agy.exe":"agy"));}catch(_){}
      if(Zotero.isWin){const local=Services.dirsvc.get("LocalAppData",Components.interfaces.nsIFile).path;candidates.push(PathUtils.join(local,"agy","bin","agy.exe"));}
    }
    for(const path of candidates)if(PathUtils.isAbsolute(path)&&await IOUtils.exists(path)&&(!Zotero.isWin||/\.exe$/i.test(path)))return {command:path,prefix:[],engine:"antigravity"};
    throw CodexCore.error("CLI_MISSING","未找到 Antigravity CLI（agy），请安装登录或在高级设置中指定程序路径。");
  },
  async probe(engine,exe,signal){
    if(engine==="codex")return ReaderCodex.probe(exe,signal);
    const version=await ReaderCodex.run(exe,["--version"],{signal,timeoutMs:15000});
    const found=version.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/);
    if(version.exitCode!==0||!found)throw CodexCore.error("CLI_VERSION","无法确认 Antigravity CLI 版本。");
    const help=await ReaderCodex.run(exe,["--help"],{signal,timeoutMs:15000});
    if(help.exitCode!==0||!["--input-format","--output-format","--json-schema","--settings"].every(flag=>help.stdout.includes(flag)||help.stderr.includes(flag)))throw CodexCore.error("CLI_VERSION","当前 Antigravity CLI 不支持所需调用方式，请更新 CLI。");
    return "Antigravity CLI "+found[0];
  },
  async terminateTree(proc){
    if(proc.exitCode!==null&&proc.exitCode!==undefined)return;
    if(Zotero.isWin&&Number.isInteger(proc.pid)&&proc.pid>0){
      try{
        const system=Services.dirsvc.get("SysD",Components.interfaces.nsIFile).path;
        const r=await CodexCore.runProcess({spawn:s=>ReaderCodex.subprocess().call(s),command:PathUtils.join(system,"taskkill.exe"),args:["/PID",String(proc.pid),"/T","/F"],timeoutMs:5000,timers:ReaderTimers});
        if(r.exitCode===0)return;
      }catch(_){}
    }
    await proc.kill(0);
  },
  async discover(engine){
    if(this.closing)throw CodexCore.error("CANCELLED","模型检测已停止。");
    if(this.inflight[engine])return this.inflight[engine];
    const controller=new AbortController();this.controllers[engine]=controller;
    this.inflight[engine]=(async()=>{
      const {executable:exe,version}=await this.prepare(engine,controller.signal);
      let models;
      if(engine==="codex")models=await EngineCore.codexCatalog(ReaderCodex.run.bind(ReaderCodex),exe,controller.signal);
      else{
        const r=await ReaderCodex.run(exe,["models"],{timeoutMs:45000,signal:controller.signal});
        models=EngineCore.parseAgyModels(r.stdout);
        if(r.exitCode!==0||!models.length){const e=CodexCore.classifyFailure(r.stderr+"\n"+r.stdout,r.exitCode);throw CodexCore.error(e.code,e.message.replace(/Codex/g,"Antigravity"));}
      }
      const catalog={engine,version,models,detectedAt:new Date().toISOString(),source:engine==="codex"?"model/list":"agy models",cached:false};
      this.catalogs[engine]=catalog;
      const dir=PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent");await IOUtils.makeDirectory(dir,{ignoreExisting:true,createAncestors:true});
      await this.app.writeJSON(PathUtils.join(dir,`models-${engine}.json`),catalog);
      return catalog;
    })();
    try{return await this.inflight[engine];}
    catch(e){
      if(!(e instanceof CodexCore.CodexError))e=CodexCore.error("MODEL_DISCOVERY",EngineCore.name(engine)+" 模型目录读取失败，请重试检测或检查 CLI 登录与网络。");
      let cached=await this.app.readJSON(PathUtils.join(Zotero.DataDirectory.dir,"zotero-reader-independent",`models-${engine}.json`));
      if(engine==="codex"&&!cached?.models?.length){
        const home=Services.env.get("CODEX_HOME")||PathUtils.join(Services.dirsvc.get("Home",Components.interfaces.nsIFile).path,".codex");
        const raw=await this.app.readJSON(PathUtils.join(home,"models_cache.json"));
        if(raw?.models?.length)cached={engine,models:EngineCore.normalizeModels(raw.models),detectedAt:raw.fetched_at,version:raw.client_version,source:"Codex 本地模型缓存"};
      }
      if(cached?.models?.length)this.catalogs[engine]={...cached,models:EngineCore.normalizeModels(cached.models),cached:true,error:this.app.safeError(e)};
      else this.catalogs[engine]={engine,models:[],error:this.app.safeError(e),cached:false};
      throw e;
    }finally{delete this.inflight[engine];delete this.controllers[engine];}
  },
  async discoverAll(){return Promise.allSettled([this.discover("codex"),this.discover("antigravity")]);},
  async shutdown(){this.closing=true;for(const c of Object.values(this.controllers))c.abort();await Promise.allSettled(Object.values(this.inflight));},
  async invokeAgy(input,request,signal,report){
    const {executable:exe,version}=request.prepared||await this.prepare("antigravity",signal);
    await this.app.writeJSON(request.settingsPath,EngineCore.agySettings);
    const reader=EngineCore.agyReader(report);
    const r=await ReaderCodex.run(exe,EngineCore.agyArguments(request),{workdir:request.workdir,input:JSON.stringify({event:"user",message:{content:input}})+"\n",
      timeoutMs:request.timeoutMs,signal,onStdout:text=>reader.push(text)});
    const final=reader.finish();
    if(r.exitCode!==0||final?.status!=="SUCCESS"){
      const e=CodexCore.classifyFailure(String(final?.error||"")+"\n"+r.stderr,r.exitCode);
      throw CodexCore.error(e.code,e.message.replace(/Codex/g,"Antigravity"));
    }
    const answer=final.structured_output!==undefined?JSON.stringify(final.structured_output):final.response;
    if(typeof answer!=="string"||!answer.trim())throw CodexCore.error("NO_ANSWER","Antigravity 没有返回完整的最终结果。");
    if(answer.length>CodexCore.MAX_ANSWER_BYTES)throw CodexCore.error("ANSWER_SIZE","Antigravity 返回结果过大。");
    return {answer,version,modelReported:request.model||null};
  }
};
