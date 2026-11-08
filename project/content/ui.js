"use strict";
var ReaderUI={
  bindActionMenus(doc){
    if(doc._zriActionMenusBound||!doc.addEventListener)return;doc._zriActionMenusBound=true;
    doc.addEventListener('click',event=>{
      const menu=event.target.closest?.('.zr-action-menu'),button=event.target.closest?.('button');
      for(const open of doc.querySelectorAll('.zr-action-menu[open]'))if(open!==menu||button&&menu===open)open.open=false;
    });
    doc.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;const open=[...doc.querySelectorAll('.zr-action-menu[open]')];if(!open.length)return;
      const focus=event.target.closest?.('.zr-action-menu')||open[open.length-1];for(const menu of open)menu.open=false;focus.querySelector('summary')?.focus();event.preventDefault();event.stopPropagation();
    });
    doc.addEventListener('focusin',event=>{for(const open of doc.querySelectorAll('.zr-action-menu[open]'))if(!open.contains(event.target))open.open=false;});
  },
  bindPreferences(win){
    this.bindActionMenus(win.document);
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
  flow(state){
    const count=state.reviewIssues?.length||0;
    if(state.editing)return {phase:'编辑中',tone:'untested',title:'修改完成后保存',detail:'保存修改后可导入为人工修改稿；不会冒充模型复查通过。',primary:'save-edit',label:'保存修改'};
    if(state.queued)return {phase:'等待处理',tone:'untested',title:'已加入队列',detail:'轮到这篇时会自动开始。若队列已暂停，请在概览继续队列。',primary:'cancel',label:'取消排队'};
    if(state.busy)return {phase:({parsing:'解析中',generating:'精读中',verifying:'检查中',correcting:'修订中'})[state.phase]||'处理中',tone:'testing',title:({parsing:'正在准备原文',generating:'正在生成完整精读',verifying:'正在完整核对原文与精读',correcting:'正在根据原文修订'})[state.phase]||'正在处理',detail:'进度会自动更新。已有草稿会保留，不需要重复点击。',primary:'cancel',label:'停止此篇'};
    if(state.savedNoteKey)return {phase:state.resultStatus==='edited'?'人工稿已保存':'已保存',tone:state.resultStatus==='edited'?'untested':'available',title:state.resultStatus==='edited'?'人工修改稿已保存':'笔记已保存到 Zotero',detail:state.resultStatus==='edited'?'这份修改尚未重新核验，笔记中已保留人工修改标记。':'可点击查看笔记。原 PDF 和人工阅读标记保持不变。',primary:'saved',label:'查看笔记'};
    if(state.resultStatus==='checked')return {phase:'可保存',tone:'available',title:'检查已完成，可以保存笔记',detail:'点击后保存为这篇文献的子笔记，不会重新精读或核验。',primary:'import',label:'保存笔记'};
    if(state.resultStatus==='edited')return {phase:'人工修改稿',tone:'untested',title:'修改已保存，可保存为人工稿',detail:'这份修改尚未重新核验，导入后会明确标注为人工修改稿。',primary:'import',label:'保存人工修改稿'};
    if(state.resultStatus==='needs_review')return {phase:'待修订',tone:'unavailable',title:count?`还有 ${count} 处需要修订`:'还有内容需要修订',detail:'建议先自动修订并复查。下方可查看草稿、问题原因和对应原文片段。',primary:'resume',label:'自动修订并复查'};
    if(state.resultStatus==='verification_incomplete'||['verifying','correcting'].includes(state.resultStatus))return {phase:'检查中断',tone:'untested',title:'草稿已保留，继续检查即可',detail:'不会重新解析 PDF，也不需要删除文献；检查完成后按保存设置导入。',primary:'resume',label:'继续检查'};
    return {phase:state.resultStatus?'已停止':'待开始',tone:'untested',title:state.resultStatus?'尚未完成精读，可重试':'准备开始精读',detail:'使用统一模板生成完整精读，再对照原文检查。',primary:'send',label:state.resultStatus?'重试精读':'开始精读'};
  },
  reading(win,state){
    const doc=win.document,body=doc.getElementById('zrc-answer'),flow=this.flow(state);
    if(body._source!==state.answer&&!state.editing){
      const html=NoteCore.markdownHTML(state.answer||'');body.innerHTML=html?'<div xmlns="http://www.w3.org/1999/xhtml">'+html+'</div>':'';body._source=state.answer;
      const content=body.firstElementChild;
      if(content)for(const heading of [...content.querySelectorAll('h2,h3')])if(heading.textContent.trim()==='文献信息'){
        const level=heading.localName,details=doc.createElementNS('http://www.w3.org/1999/xhtml','details'),summary=doc.createElementNS('http://www.w3.org/1999/xhtml','summary');details.className='zr-bibliography';summary.textContent='文献信息 · 展开完整题录';details.appendChild(summary);heading.before(details);
        let next=heading.nextSibling;heading.remove();while(next&&!(next.nodeType===1&&next.localName===level)){const following=next.nextSibling;details.appendChild(next);next=following;}
      }
    }
    const phase=doc.getElementById('zrc-phase');phase.textContent=flow.phase;phase.dataset.state=flow.tone;
    doc.getElementById('zrc-next-title').textContent=flow.title;doc.getElementById('zrc-next-description').textContent=flow.detail;doc.getElementById('zrc-next-step').dataset.state=flow.tone;
    body.hidden=!!state.editing;doc.getElementById('zrc-editor-wrap').hidden=!state.editing;
    const attention=doc.getElementById('zrc-attention');attention.hidden=state.busy||state.editing||!state.report||['checked','edited'].includes(state.resultStatus);
    attention.querySelector('summary').textContent=state.resultStatus==='verification_incomplete'?'查看中断原因':state.resultStatus==='needs_review'?'查看需要修订的内容':'查看说明';
    const box=doc.getElementById('zrc-issues'),issues=state.reviewIssues||[],key=JSON.stringify(issues);
    doc.getElementById('zrc-attention-text').textContent=issues.length?'':state.report||'';
    if(box._issuesKey!==key&&doc.createElementNS){
      box.replaceChildren();box._issuesKey=key;
      for(const [index,issue]of issues.entries()){
        const el=name=>doc.createElementNS('http://www.w3.org/1999/xhtml',name),card=el('details'),summary=el('summary');card.className='zr-issue';card.open=index===0;summary.textContent=`问题 ${index+1} · ${issue.text.length>100?issue.text.slice(0,100)+'…':issue.text}`;card.appendChild(summary);
        for(const [label,text]of [['草稿内容',issue.text],['需要修订',issue.reason]]){const p=el('p'),strong=el('strong');strong.textContent=label+'：';p.appendChild(strong);p.appendChild(doc.createTextNode(text));card.appendChild(p);}
        const label=el('p');label.className='zr-caption';label.textContent=issue.evidence?.length?'原文片段（解析文本）':'未取得匹配的原文片段，可打开正文 PDF 核对。';card.appendChild(label);
        for(const e of issue.evidence||[]){const quote=el('blockquote');quote.textContent=e.quote;quote.tabIndex=0;card.appendChild(quote);}
        box.appendChild(card);
      }
      if(issues.length)attention.open=true;
    }
    return flow;
  }
};
