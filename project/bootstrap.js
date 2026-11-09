var readerScope;
var readerChrome;

function install() {}
function uninstall() {}

async function startup({ rootURI }, reason) {
  await Zotero.initializationPromise;
  const root = rootURI.replace(/\/+$/, "") + "/";
  const startupService = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  readerChrome = startupService.registerChrome(Services.io.newURI(root + "manifest.json"), [
    ["content", "zotero-reader-independent", root + "content/"]
  ]);
  readerScope = { Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils };
  Services.scriptloader.loadSubScript(root + "content/core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/codex-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/engine-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/attachment-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/bibliography-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/source-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/reading-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/workflow-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/note-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/saved-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/wiki-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/queue-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/batch-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/codex-runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/engines.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/engine-preferences.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/preferences.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/note-runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/saved-runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/cleanup.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/attachments.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/attachment-maintenance.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/automation.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/classifier.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/batch-runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/ui.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/coordination-core.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/coordination-runtime.js", readerScope);
  Services.scriptloader.loadSubScript(root + "content/language.js", readerScope);
  readerScope.ReaderCodex.init(readerScope.ReaderApp);
  await readerScope.ReaderEngines.init(readerScope.ReaderApp);
  readerScope.ReaderPreferences.init(readerScope.ReaderApp);
  readerScope.ReaderNotes.init(readerScope.ReaderApp);
  await readerScope.ReaderSaved.init(readerScope.ReaderApp);
  await readerScope.ReaderClassifier.init(readerScope.ReaderApp);
  readerScope.ReaderCleanup.init(readerScope.ReaderApp);
  readerScope.ReaderAttachments.init(readerScope.ReaderApp);
  readerScope.ReaderAttachmentMaintenance.init(readerScope.ReaderApp);
  readerScope.ReaderBatch.init(readerScope.ReaderApp);
  Zotero.ReaderIndependent = readerScope.ReaderApp;
  await readerScope.ReaderCoordination.init(readerScope.ReaderApp);
  readerScope.ReaderCoordination.install();
  await readerScope.ReaderAutomation.init(readerScope.ReaderApp,readerScope.ReaderNotes);
  await readerScope.ReaderApp.startup(root);
  for (const win of Zotero.getMainWindows()) readerScope.ReaderApp.addWindow(win);
}

async function onMainWindowLoad({ window }) {
  readerScope?.ReaderApp?.addWindow(window);
}
function onMainWindowUnload({ window }) {
  readerScope?.ReaderApp?.removeWindow(window);
}
async function shutdown() {
  await readerScope?.ReaderEngines?.shutdown();
  readerScope?.ReaderBatch?.shutdown();
  await readerScope?.ReaderAttachmentMaintenance?.active?.catch(()=>{});
  await readerScope?.ReaderAutomation?.shutdown();
  await readerScope?.ReaderClassifier?.shutdown();
  await readerScope?.ReaderNotes?.serial?.catch(()=>{});
  await readerScope?.ReaderCleanup?.active?.catch(()=>{});
  readerScope?.ReaderCleanup?.shutdown();
  await readerScope?.ReaderCodex?.shutdown();
  await readerScope?.ReaderCoordination?.shutdown();
  await readerScope?.ReaderApp?.shutdown();
  if (Zotero.ReaderIndependent === readerScope?.ReaderApp) delete Zotero.ReaderIndependent;
  readerChrome?.destruct();
  readerChrome = null;
  readerScope = null;
}
