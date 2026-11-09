'use strict';
var ReaderSaved={
  app:null,records:{},io:Promise.resolve(),
  async init(app){this.app=app;this.records=(await app.readJSON(this.file()))?.records||{};},
  file(){return PathUtils.join(Zotero.DataDirectory.dir,'zotero-reader-independent','saved-notes.json');},
  async persist(){
    const snapshot={schema:1,records:JSON.parse(JSON.stringify(this.records))};
    this.io=this.io.catch(()=>{}).then(()=>this.app.writeJSON(this.file(),snapshot));await this.io;
  },
  async noteState(note){
    const record=SavedCore.read(note.getNote()),bodyHash=await this.app.sha256Text(SavedCore.body(note.getNote()));
    return {record,bodyHash,status:record&&bodyHash===record.bodySHA256?record.status:'edited'};
  },
  async record(workflow,note,status,attachment){
    const runID=SavedCore.read(note.getNote())?.runID||SavedCore.legacyRun(note.getNote());
    if(!SavedCore.validID(runID))throw NoteCore.error('SAVED_RECORD','笔记缺少本次精读标记，未清理临时内容。');
    status=(await this.noteState(note)).status;
    const entry={runID,libraryID:note.libraryID,noteKey:note.key,attachmentKey:attachment.key,status,
      inputs:SavedCore.inputs(workflow),savedAt:new Date().toISOString(),cleanup:'pending'};
    this.records[runID]=entry;await this.persist();return entry;
  },
  async byRun(runID,attachment){
    if(!attachment||attachment.deleted)return null;
    const entry=this.records[runID];if(!entry||entry.libraryID!==attachment.libraryID||entry.attachmentKey!==attachment.key)return null;
    const note=await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID,entry.noteKey);
    if(!note?.isNote()||note.deleted)return null;
    if((SavedCore.read(note.getNote())?.runID||SavedCore.legacyRun(note.getNote()))!==runID)return null;
    if((note.parentID||false)!==(attachment.parentID||false))return null;
    const state=await this.noteState(note);if(state.record&&!state.record.inputs.some(s=>s.role==='main'&&s.key===attachment.key))return null;
    if(state.record){const parent=attachment.parentID?await Zotero.Items.getAsync(attachment.parentID):null;if(state.record.itemKey!==(parent?.key||attachment.key))return null;}
    entry.status=state.status;return {note,entry,...state};
  },
  async candidates(attachment){
    const parent=attachment.parentID?await Zotero.Items.getAsync(attachment.parentID):null;
    let ids;
    if(parent)ids=parent.getNotes();
    else ids=await Zotero.DB.columnQueryAsync("SELECT N.itemID FROM itemNotes N JOIN items I ON I.itemID=N.itemID WHERE I.libraryID=? AND (N.note LIKE ? OR N.note LIKE ?)",[attachment.libraryID,'%data-zri-record=%','%ZRI:%:reading%']);
    const notes=await Zotero.Items.getAsync(ids),itemKey=parent?.key||attachment.key,result=[];
    for(const note of notes){
      if(!note||note.deleted||!note.isNote()||note.libraryID!==attachment.libraryID)continue;
      const record=SavedCore.read(note.getNote());
      if(record&&record.itemKey===itemKey&&(parent||record.inputs.some(s=>s.key===attachment.key))){
        const edited=await this.app.sha256Text(SavedCore.body(note.getNote()))!==record.bodySHA256;
        result.push({note,record,status:edited?'edited':record.status});
      }else if(!record&&SavedCore.legacyRun(note.getNote())&&(parent||note.getRelationsByPredicate('dc:relation').includes(Zotero.URI.getItemURI(attachment)))){
        result.push({note,record:null,status:'legacy'});
      }
    }
    return result.sort((a,b)=>String(b.record?.createdAt||b.note.dateModified||'').localeCompare(String(a.record?.createdAt||a.note.dateModified||'')));
  },
  async matching(attachment,selection){
    const candidates=await this.candidates(attachment);if(!candidates.some(c=>c.record))return null;
    let sources;try{sources=await ReaderAttachments.sources(attachment,selection);}catch(_){return null;}
    return candidates.find(c=>c.record&&SavedCore.matches(c.record,sources))||null;
  },
  async open(win,note){
    if(!note?.isNote()||note.deleted)throw NoteCore.error('NOTE_SOURCE','精读笔记不存在或已进入回收站。');
    const main=win?.ZoteroPane?win:Zotero.getMainWindow();
    await main.ZoteroPane.selectItem(note.id);main.focus();
  }
};
