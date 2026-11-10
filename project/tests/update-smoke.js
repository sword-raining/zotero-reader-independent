async function startup() {
  await Zotero.initializationPromise;
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const report = { completed: false, tests: [], personalLibraryTouched: false, realModelRequests: 0, zoteroVersion: Zotero.version };
  const output = PathUtils.join(PathUtils.profileDir, 'update-result.json');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const save = () => IOUtils.writeUTF8(output, JSON.stringify(report));
  const check = async (name, fn) => { await fn(); report.tests.push({ name, ok: true }); await save(); };
  const findUpdate = addon => new Promise((resolve, reject) => {
    let available = null;
    addon.findUpdates({
      onUpdateAvailable(_addon, install) { available = install; },
      onUpdateFinished(_addon, error) { error ? reject(new Error('Update check failed: ' + error)) : resolve(available); }
    }, AddonManager.UPDATE_WHEN_USER_REQUESTED);
  });
  try {
    const config = JSON.parse(await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, 'update-fixture.json')));
    assert(Zotero.DataDirectory.dir === PathUtils.join(PathUtils.profileDir, 'data'), 'Isolated data directory required');
    let addon, install;
    await check('seed retains 1.0.1 production code with only its update URL changed for the bootstrap test', async () => {
      addon = await AddonManager.getAddonByID(config.id);
      assert(addon?.version === '1.0.1' && addon.updateURL === config.updateURL, 'Unexpected seed identity/update URL');
    });
    await check('native updater discovers the published 1.0.2 release through the public HTTPS feed', async () => {
      install = await findUpdate(addon);
      assert(install?.version === config.version && install.sourceURI.spec === config.updateLink, 'Wrong or missing update');
      report.downloadURL = install.sourceURI.spec;
    });
    await check('native updater downloads and installs the public XPI with its update hash', async () => {
      await new Promise((resolve, reject) => {
        install.addListener({
          onDownloadFailed(item) { reject(new Error('Download failed: ' + item.error)); },
          onInstallFailed(item) { reject(new Error('Install failed: ' + item.error)); },
          onInstallEnded(_item, installed) { resolve(installed); }
        });
        install.install();
      });
      addon = await AddonManager.getAddonByID(config.id);
      assert(addon.version === config.version && addon.updateURL === config.updateURL, 'Installed version/update URL mismatch');
      report.installedVersion = addon.version;
    });
    await check('Zotero permits automatic updates when the user enables that setting', async () => {
      addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_ENABLE;
      assert(AddonManager.shouldAutoUpdate(addon), 'Automatic updates are not eligible');
    });
    await check('checking the installed latest version offers no duplicate update', async () => {
      assert(await findUpdate(addon) === null, 'Latest version was offered another update');
    });
    report.completed = true;
  } catch (error) { report.error = String(error); report.stack = error.stack; }
  finally { await save(); Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit); }
}
function install() {}
function uninstall() {}
function shutdown() {}
