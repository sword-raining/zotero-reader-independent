(async()=>{
  const app=readerScope.ReaderApp,engines=readerScope.ReaderEngines;
  if(!Zotero.DataDirectory.dir.startsWith(PathUtils.profileDir))throw new Error('Visual inspection must use the isolated profile');
  const verified=await app.readJSON(PathUtils.join(PathUtils.profileDir,'visual-engines.json'));
  engines.health={};
  engines.discoverAll=async()=>{
    for(const engine of ['codex','antigravity']){
      const actual=verified?.[engine];
      engines.catalogs[engine]=actual?.success?{engine,models:actual.models,version:actual.version,cached:true}:{engine,models:[],cached:true};
    }
    return [];
  };
  for(const [which,engine] of [['generation','codex'],['verification','antigravity']]){
    const record=verified?.[engine]?.test;
    if(record?.success){
      const actual={engine,model:record.model,effort:record.effort};
      const key=record.requestedModel?readerScope.EngineCore.connectionKey({engine,model:record.requestedModel},verified[engine]):readerScope.EngineCore.healthKey(actual);
      engines.health[key]={...record,key,engine,...(record.requestedModel?{testedStage:actual}:{})};
    }
    Zotero.Prefs.set(app.pref+`ai.${which}.engine`,engine,true);
    Zotero.Prefs.set(app.pref+`ai.${which}.model`,record?.requestedModel||record?.model||'',true);
    Zotero.Prefs.set(app.pref+`ai.${which}.effort`,record?.requestedEffort||record?.effort||'',true);
  }
  let main;
  for(let i=0;i<60;i++){main=Zotero.getMainWindow();if(main?.document.getElementById('zotero-itemmenu'))break;await Zotero.Promise.delay(250);}
  const service=readerScope.ReaderCodex;
  service.state={title:'精读界面示例 · 合成内容',source:'本页仅用于检查排版，不是论文研究结论。',templateID:'ecology',busy:false,phase:'complete',resultStatus:'checked',report:'',output:'',deliveryPending:false,
    message:'示例：检查完成后只保留精读正文。',answer:'# 文献精读\n\n## 研究问题与依据\n\n- 说明研究关注的问题，以及现有证据能够支持到什么程度。\n\n## 研究设计\n\n- 简明记录研究对象、对照设置和关键处理条件。\n\n## 分析方法\n\n- 解释方法与研究问题之间的对应关系，区分相关关系和因果判断。\n\n## 主要结果\n\n- 用自然语言概括核心发现，仅在必要时保留关键数值。\n\n## 机制解释\n\n- 【读后推断】将作者提出的解释与读者延伸思考分别表述。\n\n## 局限与替代解释\n\n- 保留研究设计与所提供文本的适用边界。\n\n## 研究启发\n\n- 将后续可检验的问题明确标注为研究设想。'};
  service.showWindow(main);
  Zotero.Utilities.Internal.openPreferences(app.paneID);
  let win;
  for(let i=0;i<80;i++){
    win=Services.wm.getMostRecentWindow('zotero:pref');
    if(win?.document.getElementById('zri-codex-save')?.dataset.bound)break;
    await Zotero.Promise.delay(250);
  }
  if(win){win.document.title='Zotero Reader — 界面检查';win.resizeTo(1120,850);}
  await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'visual-ready.json'),JSON.stringify({ready:Boolean(win)}));
})();
