(async()=>{
  if(!Zotero.DataDirectory.dir.startsWith(PathUtils.profileDir))throw new Error('Isolated profile required');
  await readerScope.ReaderAutomation.setEnabled(false);readerScope.ReaderAutomation.state.paused=true;
  let main;for(let i=0;i<60;i++){main=Zotero.getMainWindow();if(main?.document.getElementById('zotero-itemmenu'))break;await Zotero.Promise.delay(250);}
  const parent=new Zotero.Item('journalArticle');parent.libraryID=Zotero.Libraries.userLibraryID;parent.setField('title','示例文献｜草地微生物与碳循环（界面测试）');await parent.saveTx({skipSelect:true});
  const mainPath=PathUtils.join(PathUtils.profileDir,'visual-main.pdf'),supPath=PathUtils.join(PathUtils.profileDir,'supporting-information.pdf');
  await IOUtils.writeUTF8(mainPath,'%PDF-1.4 synthetic main for UI');await IOUtils.writeUTF8(supPath,'%PDF-1.4 synthetic supplement for UI');
  for(const [title,path] of [['正文 PDF',mainPath],['正文的重复下载',mainPath],['Supplementary Information',supPath]]){
    const att=new Zotero.Item('attachment');att.libraryID=parent.libraryID;att.parentID=parent.id;att.attachmentLinkMode=Zotero.Attachments.LINK_MODE_LINKED_FILE;att.attachmentContentType='application/pdf';att.attachmentPath=path;att.setField('title',title);await att.saveTx({skipSelect:true});
  }
  const get=main.ZoteroPane.getSelectedItems;main.ZoteroPane.getSelectedItems=()=>[parent];
  try{await readerScope.ReaderBatch.open(main);}finally{main.ZoteroPane.getSelectedItems=get;}
  for(let i=0;i<60;i++){if(readerScope.ReaderBatch.window?.document.getElementById('zrb-start'))break;await Zotero.Promise.delay(100);}
  readerScope.ReaderBatch.window.document.title='Zotero Reader — 附件选择隔离预览';
})();
