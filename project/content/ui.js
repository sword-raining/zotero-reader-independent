"use strict";
var ReaderUI={
  bindPreferences(win){
    const root=win.document.getElementById("zri-settings");if(!root||root.dataset.bound)return;root.dataset.bound="true";
    for(const child of root.parentElement.children)if(child.localName==="h1")child.hidden=true;
    const tabs=[...root.querySelectorAll('[role="tab"]')],panels=[...root.querySelectorAll('[role="tabpanel"]')];
    const select=id=>{
      if(!tabs.some(t=>t.dataset.tab===id))id="overview";
      for(const tab of tabs){const active=tab.dataset.tab===id;tab.setAttribute("aria-selected",String(active));tab.tabIndex=active?0:-1;}
      for(const panel of panels)panel.hidden=panel.id!=="zri-panel-"+id;
      Zotero.Prefs.set(ReaderApp.pref+"ui.tab",id,true);
    };
    for(const [i,tab] of tabs.entries()){
      tab.addEventListener("click",()=>select(tab.dataset.tab));
      tab.addEventListener("keydown",e=>{
        let index;if(e.key==="ArrowRight")index=(i+1)%tabs.length;else if(e.key==="ArrowLeft")index=(i+tabs.length-1)%tabs.length;else if(e.key==="Home")index=0;else if(e.key==="End")index=tabs.length-1;else return;
        e.preventDefault();select(tabs[index].dataset.tab);tabs[index].focus();
      });
    }
    select(Zotero.Prefs.get(ReaderApp.pref+"ui.tab",true)||"overview");
    for(const button of root.querySelectorAll('[data-insert]'))button.addEventListener("click",()=>{
      const field=win.document.getElementById("zri-name-reading"),a=field.selectionStart??field.value.length,b=field.selectionEnd??a;
      field.setRangeText(button.dataset.insert,a,b,"end");field.dispatchEvent(new win.Event("input",{bubbles:true}));field.focus();
    });
  },
  reading(win,state){
    const doc=win.document,body=doc.getElementById("zrc-answer");
    if(body._source!==state.answer){
      // XUL documents otherwise parse unprefixed fragment tags into the XUL namespace.
      const html=NoteCore.markdownHTML(state.answer||"");
      body.innerHTML=html?'<div xmlns="http://www.w3.org/1999/xhtml">'+html+'</div>':"";
      body._source=state.answer;
    }
    const phase=doc.getElementById("zrc-phase");
    phase.textContent=state.busy?({parsing:"解析中",generating:"精读中",verifying:"检查中",correcting:"修正中"}[state.phase]||"处理中"):state.resultStatus==="checked"?"已完成":state.resultStatus==='verification_incomplete'?'检查未完成':state.resultStatus==='edited'?'人工修改稿':state.resultStatus?"需核对":"就绪";
    phase.dataset.state=state.busy?"testing":state.resultStatus==="checked"?"available":state.resultStatus==='verification_incomplete'?'untested':state.resultStatus?"unavailable":"untested";
    const attention=doc.getElementById("zrc-attention");attention.hidden=!state.report||state.resultStatus==="checked";
    attention.querySelector('summary').textContent=state.resultStatus==='verification_incomplete'?'检查中断，可继续检查':state.resultStatus==='edited'?'文件已有人工修改':'有内容需要人工核对';
    doc.getElementById("zrc-attention-text").textContent=state.report||"";
  }
};
