(async()=>{
 const s=readerScope,app=s.ReaderApp,auto=s.ReaderAutomation,root=PathUtils.profileDir,lib=Zotero.Libraries.userLibraryID;
 const assert=(v,m)=>{if(!v)throw Error(m);},tests=[],out=PathUtils.join(root,'collection-watch-result.json'),layout=[];
 assert(Zotero.DataDirectory.dir===PathUtils.join(root,'data'),'Isolated profile required');
 const sleep=ms=>new Promise(r=>s.ReaderTimers.setTimeout(r,ms)),until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await sleep(30);}throw Error('Condition timed out');};
 const check=async(name,fn)=>{try{await fn();tests.push({name,ok:true});}catch(e){tests.push({name,ok:false,error:String(e),stack:e.stack});}await app.writeJSON(out,{completed:false,tests});};
 app.parseAttachment=async()=>{throw Error('No real parsing allowed');};s.ReaderCodex.invoke=async()=>{throw Error('No model calls allowed');};
 auto.state.paused=true;await auto.setEnabled(false);
 const collection=async(name,parent)=>{const c=new Zotero.Collection();c.libraryID=lib;c.name=name;if(parent)c.parentID=parent.id;await c.saveTx();return c;};
 const target=await collection('00_新导入文献'),other=await collection('其他分类'),child=await collection('子分类',target);
 const paper=async(name,c)=>{const p=new Zotero.Item('journalArticle');p.libraryID=lib;p.setField('title',name);if(c)p.addToCollection(c.id);await p.saveTx({skipSelect:true});return p;};
 const pdf=async(p,name='Synthetic main',synced=false)=>{const a=new Zotero.Item('attachment');a.libraryID=lib;a.parentID=p.id;a.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;a.attachmentPath=PathUtils.join(root,'synthetic.pdf');a.attachmentContentType='application/pdf';a.setField('title',name);a.synced=synced;await a.saveTx({skipSelect:true,skipSyncedUpdate:synced});return a;};
 const key=a=>lib+':'+a.key;let moved,late,win;
 const before=await paper('Already in selected collection',target),oldPDF=await pdf(before);
 await sleep(80);
 await check('selecting and enabling a collection does not scan existing papers',async()=>{await auto.setCollection(target.key);await auto.setEnabled(true);await sleep(100);assert(!auto.state.jobs[key(oldPDF)],'existing paper scanned');});
 await check('actual collection-item add events capture an existing paper and its synced PDF once',async()=>{
  const p=await paper('Moved into selected folder',other);moved=await pdf(p,'Synthetic main',true);await sleep(80);assert(!auto.state.jobs[key(moved)],'outside PDF captured');
  p.addToCollection(target.id);await p.saveTx({skipSelect:true});await until(()=>auto.state.jobs[key(moved)]);
  auto.notify('add','collection-item',[target.id+'-'+p.id],{});await sleep(60);assert(auto.state.jobs[key(moved)].attempt===1,'duplicate event requeued');
 });
 await check('a new PDF added after its parent is in scope triggers automatically',async()=>{const p=await paper('Parent first',target);await sleep(60);late=await pdf(p);await until(()=>auto.state.jobs[key(late)]);});
 await check('siblings and child collections are excluded and supplemental PDFs stay unqueued',async()=>{
  const p=await paper('Other folder',other),a=await pdf(p),q=await paper('Child folder',child),b=await pdf(q),sup=await pdf(before,'Supporting information');await sleep(120);
  assert(!auto.state.jobs[key(a)]&&!auto.state.jobs[key(b)]&&!auto.state.jobs[key(sup)],'excluded item queued');
 });
 await check('server-style synced membership additions do not trigger reading',async()=>{
  const p=await paper('Synchronized membership',other),a=await pdf(p,'Synthetic synced main',true);p.addToCollection(target.id);p.synced=true;await p.saveTx({skipSelect:true,skipSyncedUpdate:true});await sleep(120);
  assert(!auto.state.jobs[key(a)],'sync membership queued');
 });
 await check('moving a queued paper out cancels it before parsing, and reentry safely queues one attempt',async()=>{
  const p=await Zotero.Items.getAsync(moved.parentID);p.removeFromCollection(target.id);await p.saveTx({skipSelect:true});await until(()=>auto.state.jobs[key(moved)].state==='cancelled');
  let caught;try{await auto.execute(auto.state.jobs[key(moved)]);}catch(e){caught=e;}assert(caught?.code==='CANCELLED','out-of-scope task reached parser');
  p.addToCollection(target.id);await p.saveTx({skipSelect:true});await until(()=>auto.state.jobs[key(moved)].attempt===2);
  auto.state.jobs[key(moved)].state='done';auto.notify('add','collection-item',[target.id+'-'+p.id],{});await sleep(80);assert(auto.state.jobs[key(moved)].attempt===2,'completed paper regenerated');
 });
 await check('switching the watched folder cancels pending automatic work without backfilling the new folder',async()=>{
  const existing=Object.keys(auto.state.jobs).length;await auto.setCollection(other.key);await sleep(60);assert(auto.state.jobs[key(late)].state==='cancelled','old scope task retained');assert(Object.keys(auto.state.jobs).length===existing,'new scope scanned');await auto.setCollection(target.key);
 });
 await check('native folder picker lists the synthetic collection and enable control stays one line at narrow widths',async()=>{
  for(const engine of ['codex','antigravity']){s.ReaderEngines.catalogs[engine]={models:[{id:'synthetic'}],detectedAt:new Date().toISOString(),cached:false};s.ReaderEngines.runtime[engine]={state:'ready',key:'synthetic'};}
  Zotero.Utilities.Internal.openPreferences(app.paneID);await until(()=>{win=Services.wm.getMostRecentWindow('zotero:pref');return win?.document.getElementById('zri-auto-enabled')?.dataset.bound;});
  await auto.populateCollections(win);const picker=win.document.getElementById('zri-auto-collection');assert([...picker.menupopup.children].some(n=>n.getAttribute('value')===target.key&&n.getAttribute('label').includes('00_新导入文献')),'collection missing from native menu');
  const settings=win.document.getElementById('zri-settings'),toggle=win.document.getElementById('zri-auto-enabled').parentElement,span=toggle.querySelector('span');
  for(const width of [760,520,340]){settings.style.width=width+'px';settings.style.maxWidth=width+'px';await sleep(60);const range=win.document.createRange();range.selectNodeContents(span);const rects=[...range.getClientRects()],tops=[...new Set(rects.map(r=>Math.round(r.top)))];assert(tops.length===1,'enable text wraps at '+width);assert(win.getComputedStyle(toggle).flexShrink==='0','toggle allowed to shrink');layout.push({width,textLines:tops.length,labelWidth:toggle.getBoundingClientRect().width});}
  win.close();win=null;
 });
 await auto.setEnabled(false);await auto.shutdown();
 await app.writeJSON(out,{completed:true,tests,layout,zoteroVersion:Zotero.version,realModelRequests:0,personalLibraryTouched:false,syntheticItems:true,headless:true});
})().catch(async e=>{await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir,'collection-watch-fatal.json'),JSON.stringify({error:String(e),stack:e.stack}));}).finally(()=>Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit));
