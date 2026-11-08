"use strict";
var ReaderEnginePreferences={
  async bind(win){
    const doc=win.document,get=id=>doc.getElementById(id);
    if(!get("zri-codex-save")||get("zri-codex-save").dataset.bound)return;
    get("zri-codex-save").dataset.bound="true";
    const app=ReaderCodex.app,p=app.pref;
    const stages={generation:ReaderEngines.stage("generation"),verification:ReaderEngines.stage("verification")};
    const controls={generation:{engine:get("zri-ai-gen-engine"),model:get("zri-codex-model")},verification:{engine:get("zri-ai-ver-engine"),model:get("zri-codex-verify-model")}};
    for(const which of Object.keys(controls))controls[which].effort=get("zri-effort-"+which);
    get("zri-codex-path").value=Zotero.Prefs.get(p+"codex.path",true)||"";
    get("zri-agy-path").value=Zotero.Prefs.get(p+"agy.path",true)||"";
    get("zri-codex-timeout").value=ReaderCodex.options().timeoutMinutes;
    const status=text=>{if(!win.closed)get("zri-codex-status").textContent=text;};
    const option=(select,value,label)=>{const el=doc.createXULElement("menuitem");el.setAttribute("value",value);el.setAttribute("label",label);select.menupopup.appendChild(el);};
    const clearReply=which=>{const n=get("zri-test-reply-"+which);if(n){n.hidden=true;n.textContent="";}};
    const health=()=>{
      if(win.closed)return;
      for(const which of Object.keys(stages)){
        const node=get("zri-health-"+which);if(!node)continue;
        if(testing===which)continue;
        const engine=stages[which].engine,pathID=engine==='codex'?'zri-codex-path':'zri-agy-path',pref=engine==='codex'?'codex.path':'agy.path';
        const dirty=get(pathID).value.trim()!==String(Zotero.Prefs.get(p+pref,true)||'');
        const h=dirty?{state:'untested',label:'路径已修改，请重新检测'}:EngineCore.latestHealth(ReaderEngines.healthFor(stages[which]),ReaderEngines.connectivityFor(stages[which]));
        node.dataset.state=h.state;
        node.textContent=h.label+(h.testedAt?" · 上次 "+new Date(h.testedAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}):"");
        node.title=h.testedStage?`实际测试：${h.testedStage.model||'默认模型'} / ${EngineCore.effortLabel(h.testedStage.effort)}；不代表其他强度已验证。`:'';
      }
    };
    const sliders=()=>{
      for(const which of Object.keys(stages)){
        const stage=stages[which],slider=controls[which].effort,choices=EngineCore.effortChoices(stage,ReaderEngines.catalogs[stage.engine]);
        const selected=stage.effort||EngineCore.inferredEffort(stage),index=choices.findIndex(c=>c.value===selected);
        slider.min="0";slider.max=String(Math.max(0,choices.length-1));slider.step="1";slider.value=String(Math.max(0,index));slider.disabled=choices.length<2;
        const label=index<0?"已保存档位不可用":choices[index].label;
        slider.setAttribute("aria-valuetext",label);get("zri-effort-value-"+which).textContent=label;
        const ticks=get("zri-effort-ticks-"+which);ticks.replaceChildren();
        for(const choice of choices){const span=doc.createElementNS("http://www.w3.org/1999/xhtml","span");span.textContent=choice.label;ticks.appendChild(span);}
        get("zri-effort-hint-"+which).textContent=!stage.model?"选择具体模型后可调节。":slider.disabled?"当前型号未提供其他可调档位。":"";
      }
      health();
    };
    const populate=()=>{
      if(win.closed)return;
      for(const which of Object.keys(stages)){
        const stage=stages[which],c=controls[which],catalog=ReaderEngines.catalogs[stage.engine];
        c.engine.value=stage.engine;c.model.selectedItem=null;c.model.menupopup.replaceChildren();option(c.model,"","自动（使用此引擎的默认模型）");
        const choices=EngineCore.modelChoices(stage.engine,catalog);
        for(const model of choices)option(c.model,model.id,model.label+(catalog.cached?"〔缓存〕":""));
        if(stage.model&&!catalog?.models?.some(m=>m.id===stage.model))option(c.model,stage.model,stage.model+"〔已保存，当前目录未列出〕");
        c.model.value=choices.find(g=>g.variants.some(v=>v.model===stage.model))?.id||stage.model;
      }
      get("zri-ai-detection").textContent=["codex","antigravity"].map(engine=>{
        const c=ReaderEngines.catalogs[engine];
        if(!c)return EngineCore.name(engine)+"：等待检测";
        return EngineCore.name(engine)+"："+(c.version?c.version+"；":"")+
          (c.models.length?`${c.models.length} 个模型，${c.cached?"缓存目录":"CLI 返回目录"}`:"未取得模型目录")+(c.error?"；"+c.error:c.needsRefresh?"；模型目录待刷新":"");
      }).join("\n");
      sliders();
    };
    for(const which of Object.keys(stages)){
      controls[which].engine.addEventListener("command",()=>{clearReply(which);stages[which]={engine:controls[which].engine.value,model:"",effort:""};populate();});
      controls[which].model.addEventListener("command",()=>{
        clearReply(which);const stage=stages[which],choice=EngineCore.modelChoices(stage.engine,ReaderEngines.catalogs[stage.engine]).find(g=>g.id===controls[which].model.value);
        const variant=choice?.variants.find(v=>v.effort===stage.effort)||choice?.variants[0];
        stage.model=variant?.model||controls[which].model.value;stage.effort=stage.engine==="antigravity"?(variant?.effort||""):"";sliders();
      });
      controls[which].effort.addEventListener("input",()=>{
        clearReply(which);const stage=stages[which],choices=EngineCore.effortChoices(stage,ReaderEngines.catalogs[stage.engine]),choice=choices[Number(controls[which].effort.value)];
        if(!choice)return;stage.effort=choice.value;if(choice.model)stage.model=choice.model;sliders();
      });
    }
    const savePaths=()=>{
      ReaderEngines.setPath('codex',get("zri-codex-path").value);
      ReaderEngines.setPath('antigravity',get("zri-agy-path").value);
    };
    const save=()=>{
      const timeout=CodexCore.options({timeoutMinutes:get("zri-codex-timeout").value}).timeoutMinutes;
      for(const [which,stage] of Object.entries(stages)){
        CodexCore.options({model:stage.model});
        if(stage.model&&!ReaderEngines.catalogs[stage.engine]?.models?.some(m=>m.id===stage.model))throw CodexCore.error("MODEL_CATALOG","所选模型未在当前检测目录中，请刷新后重新选择。");
        if(!EngineCore.validEffort(stage,ReaderEngines.catalogs[stage.engine]))throw CodexCore.error("EFFORT","当前模型不支持所选思考强度，请刷新目录后重新选择。");
      }
      for(const [which,stage] of Object.entries(stages)){
        Zotero.Prefs.set(p+`ai.${which}.engine`,stage.engine,true);Zotero.Prefs.set(p+`ai.${which}.model`,stage.model,true);Zotero.Prefs.set(p+`ai.${which}.effort`,stage.effort||"",true);
      }
      savePaths();Zotero.Prefs.set(p+"codex.timeoutMinutes",timeout,true);
    };
    get("zri-codex-save").addEventListener("click",()=>{try{save();status("精读与核验的引擎、模型已分别保存。");}catch(e){status(app.safeError(e));}});
    const detect=async()=>{
      get("zri-codex-check").disabled=true;
      try{savePaths();status("正在读取模型目录…");const results=await ReaderEngines.discoverAll();populate();status(results?.some(r=>r.status==='rejected')?"部分目录刷新失败，已显示可用缓存和检测信息。":"目录已更新。选择模型后可测试连接。");}
      catch(e){status(app.safeError(e));}
      finally{if(!win.closed)get("zri-codex-check").disabled=false;}
    };
    get("zri-codex-check").addEventListener("click",detect);
    let testing=null;
    const testButtons=[["zri-codex-test","generation"],["zri-ai-ver-test","verification"]];
    for(const [id,which] of testButtons){
      get(id).addEventListener("click",async()=>{
        if(testing===which){ReaderCodex.controller?.abort();return;}
        if(testing)return;
        let timer;const reply=get("zri-test-reply-"+which);
        try{
          save();testing=which;for(const [other]of testButtons)get(other).disabled=other!==id;
          for(const c of Object.values(controls)){c.engine.disabled=true;c.model.disabled=true;c.effort.disabled=true;}
          get('zri-ai-test-exact').disabled=true;get('zri-codex-check').disabled=true;
          get('zri-codex-path').disabled=true;get('zri-agy-path').disabled=true;
          get(id).textContent='停止测试';get(id).setAttribute('aria-label','停止连接测试');
          const selected={...stages[which]},badge=get("zri-health-"+which),started=Date.now(),mode=get('zri-ai-test-exact').checked?'exact':'quick';
          if(reply){reply.hidden=true;reply.textContent='';}
          let phase='准备连接';const feedback=text=>{phase=text;status(text);if(!win.closed)badge.textContent=`${phase} · ${Math.floor((Date.now()-started)/1000)}秒`;};
          badge.dataset.state="testing";badge.textContent="准备连接…";
          timer=win.setInterval(()=>{if(!win.closed)badge.textContent=`${phase} · ${Math.floor((Date.now()-started)/1000)}秒`;},1000);
          const result=await ReaderCodex.testConnection(feedback,selected,{mode}),actual=result.testedStage;
          if(reply){reply.textContent=(mode==='quick'?'模型回复：':'结构化验证回复：')+result.answer.trim().slice(0,300);reply.hidden=false;}
          status(`${(result.durationMs/1000).toFixed(1)}秒 · ${actual.model||'默认模型'} / ${EngineCore.effortLabel(actual.effort)}档测试通过。`+(mode==='quick'&&EngineCore.healthKey(actual)!==EngineCore.healthKey(selected)?' 当前较高强度尚未验证。':''));
        }
        catch(e){const message=app.safeError(e);status(message);if(reply&&!win.closed){reply.textContent=message;reply.hidden=false;}}
        finally{if(timer)win.clearInterval(timer);testing=null;if(!win.closed){for(const [button,stage]of testButtons){get(button).disabled=false;get(button).textContent='测试连接';get(button).setAttribute('aria-label',stage==='generation'?'验证精读模型连接':'验证检查模型连接');}for(const c of Object.values(controls)){c.engine.disabled=false;c.model.disabled=false;}get('zri-ai-test-exact').disabled=false;get('zri-codex-check').disabled=false;get('zri-codex-path').disabled=false;get('zri-agy-path').disabled=false;populate();}}
      });
    }
    get("zri-codex-stop").addEventListener("click",()=>ReaderCodex.controller?.abort());
    for(const id of ['zri-codex-path','zri-agy-path'])get(id).addEventListener('input',()=>{for(const which of Object.keys(stages))clearReply(which);health();});
    ReaderEngines.views.add(populate);win.addEventListener('unload',()=>ReaderEngines.views.delete(populate),{once:true});
    populate();
    const fresh=['codex','antigravity'].every(e=>ReaderEngines.runtime[e]?.state==='ready'&&!ReaderEngines.catalogs[e]?.error&&ReaderEngines.catalogs[e]?.models?.length&&Date.now()-Date.parse(ReaderEngines.catalogs[e].detectedAt)<86400000);
    if(fresh)status('已载入已有模型目录；可手动刷新。');else await detect();
  }
};
