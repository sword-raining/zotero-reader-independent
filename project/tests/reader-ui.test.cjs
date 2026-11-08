const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope={};vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/ui.js'),'utf8'),scope);const UI=scope.ReaderUI;
test('reader always presents one unambiguous next action for interruption, issues, checked and saved states',()=>{
 for(const [state,action,label]of [[{resultStatus:'verification_incomplete'},'resume','继续检查'],[{resultStatus:'needs_review',reviewIssues:[{}]},'resume','自动修订并复查'],[{resultStatus:'checked'},'import','保存笔记'],[{savedNoteKey:'NOTE0001'},'saved','查看笔记'],[{busy:true,phase:'verifying'},'cancel','停止此篇']]){const flow=UI.flow(state);assert.equal(flow.primary,action);assert.equal(flow.label,label);}
});
test('manual editing is clearly distinguished from a checked import',()=>{assert.equal(UI.flow({editing:true}).primary,'save-edit');const flow=UI.flow({resultStatus:'edited'});assert.equal(flow.label,'保存人工修改稿');assert.match(flow.detail,/尚未重新核验/);});
test('legacy transient verification states never appear as confirmed content errors',()=>{for(const resultStatus of ['verifying','correcting']){const flow=UI.flow({resultStatus});assert.equal(flow.phase,'检查中断');assert.equal(flow.primary,'resume');}});
test('same-task worker completion refreshes the view while unrelated workers cannot overwrite it',()=>{
 const s={ReaderAutomation:{running:new Map()},ReaderUI:UI};vm.createContext(s);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/codex-runtime.js'),'utf8'),s);const c=s.ReaderCodex;let renders=0;c.render=()=>renders++;c.window={closed:false};c.state={followJobID:'one',title:'Full paper title',bibliography:{title:'same'},answer:'draft',output:'old'};
 c.syncWorker({id:'other',workflowPath:'bad'},{state:{answer:'foreign'}});assert.equal(c.state.answer,'draft');
 s.ReaderAutomation.running.set('one',{});c.syncWorker({id:'one',workflowPath:'same'},{state:{busy:true,phase:'verifying',answer:'current'}});assert.equal(c.state.busy,true);assert.equal(c.state.title,'Full paper title');
 s.ReaderAutomation.running.delete('one');c.syncWorker({id:'one',workflowPath:'same',state:'needs_review'},{state:{busy:false,resultStatus:'needs_review',reviewIssues:[{text:'issue'}],answer:'current'}});assert.equal(c.state.resultStatus,'needs_review');assert.equal(UI.flow(c.state).primary,'resume');assert.equal(c.state.busy,false);assert.ok(renders>=2);
});
test('saved-note completion supersedes stale cached file state in an open viewer',()=>{
 const s={ReaderAutomation:{running:new Map()}};vm.createContext(s);vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/codex-runtime.js'),'utf8'),s);const c=s.ReaderCodex;c.render=()=>{};c.window={closed:false};c.state={followJobID:'one',title:'Paper',output:'removed/workflow.json'};
 c.syncWorker({id:'one',state:'done',notes:{reading:{key:'NOTE0001'}}},{state:{busy:false,resultStatus:'checked',answer:'final'}});assert.equal(c.state.savedNoteKey,'NOTE0001');assert.equal(c.state.output,'');assert.equal(UI.flow(c.state).primary,'saved');
});
