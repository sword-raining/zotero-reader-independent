"use strict";
var ReaderPreferences={
  app:null,
  init(app){this.app=app;},
  workflow(){return WorkflowCore.limits(Object.fromEntries(['papers','repairs','autoRepair'].map(k=>[k,Zotero.Prefs.get(this.app.pref+'workflow.'+k,true)])));},
  delivery(){return Zotero.Prefs.get(this.app.pref+"delivery.mode",true)==="manual"?"manual":"auto";},
  templateText(id){return ReadingCore.validateTemplateText(Zotero.Prefs.get(this.app.pref+"templates.unified",true)||ReadingCore.defaultTemplateText(id));},
  naming(){return Object.fromEntries(Object.keys(NoteCore.DEFAULT_NAMES).map(role=>{const saved=Zotero.Prefs.get(this.app.pref+"noteNames."+role,true);return [role,NoteCore.validateName(!saved||saved==='精读｜{title}'?NoteCore.DEFAULT_NAMES[role]:saved)];}));},
  bind(win){
    const doc=win.document,get=id=>doc.getElementById("zri-"+id);
    if(!get("template-save")||get("template-save").dataset.bound)return;
    get("template-save").dataset.bound="true";
    let current="general",drafts={general:this.templateText("general")};
    get("template-choice").value=current;get("template-text").value=drafts[current];
    get("template-choice").addEventListener("command",()=>{drafts[current]=get("template-text").value;current=get("template-choice").value;get("template-text").value=drafts[current];});
    get("template-save").addEventListener("click",()=>{
      try{const text=ReadingCore.validateTemplateText(get("template-text").value);Zotero.Prefs.set(this.app.pref+"templates.unified",text,true);drafts[current]=text;get("template-status").textContent="当前模板已保存。背景、研究动机、发表价值等九个栏目与独立核验仍然保留。";}
      catch(e){get("template-status").textContent=this.app.safeError(e);}
    });
    get("template-reset").addEventListener("click",()=>{drafts[current]=ReadingCore.defaultTemplateText(current);get("template-text").value=drafts[current];get("template-status").textContent="已恢复默认内容，点击保存后生效。";});
    get("delivery-mode").value=this.delivery();const naming=this.naming();
    get("name-reading").value=naming.reading;
    const preview=()=>{
      try{const values={title:"示例文献标题",author:"Xu",year:"2026",journal:"Global Change Biology",itemKey:"H5J2C5PU",pdf:"paper.pdf",date:NoteCore.localDate(new Date().toISOString()),template:"论文精读",status:"已检查"};
        get("name-preview").textContent=NoteCore.noteTitle(get("name-reading").value,values,"checked");
      }catch(e){get("name-preview").textContent=this.app.safeError(e);}
    };
    get("name-reading").addEventListener("input",preview);preview();
    get("delivery-save").addEventListener("click",()=>{
      try{
        const names={reading:NoteCore.validateName(get("name-reading").value)};
        Zotero.Prefs.set(this.app.pref+"delivery.mode",get("delivery-mode").value==="manual"?"manual":"auto",true);
        for(const [key,value] of Object.entries(names))Zotero.Prefs.set(this.app.pref+"noteNames."+key,value,true);
        get("delivery-status").textContent="保存方式和笔记命名已保存。已有笔记不会自动改名或覆盖。";
        ReaderCodex.render();
      }catch(e){get("delivery-status").textContent=this.app.safeError(e);}
    });
    get("name-reset").addEventListener("click",()=>{get("name-reading").value=NoteCore.DEFAULT_NAMES.reading;preview();get("delivery-status").textContent="命名已恢复默认，保存后生效。";});
  }
};
