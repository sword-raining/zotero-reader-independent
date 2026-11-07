from pathlib import Path
import zipfile
import json
import time
import uuid
import argparse
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--live-codex', action='store_true', help='Send one fixed, non-document prompt using the current CLI login')
parser.add_argument('--live-verification', action='store_true', help='Verify synthetic claims with deliberately wrong facts')
parser.add_argument('--live-engines',action='store_true',help='Discover real model catalogs and test both engines with fixed structured prompts')
parser.add_argument('--live-agy-startup',action='store_true',help='Check Antigravity first/repeat startup and updater opt-out with fixed text')
parser.add_argument('--live-reading',action='store_true',help='Generate and independently check a synthetic nine-section reading using both real engines')
parser.add_argument('--visual',action='store_true',help='Open isolated UI for visual inspection, without model requests')
parser.add_argument('--visual-attachments',action='store_true',help='Open the grouped PDF picker with synthetic attachments')
parser.add_argument('--saved-cleanup',action='store_true',help='Run native saved-note and cleanup checks without model requests or UI actions')
args = parser.parse_args()

project = Path(__file__).resolve().parents[1]
profile = project.parent / 'zotero-reader-smoke-profile'
profile.mkdir(exist_ok=True)
if args.visual:
    record=project.parent/'live-engines-011-verified.json'
    if not record.exists():record=project.parent/'live-engines-08-verified.json'
    if not record.exists():record=project.parent/'live-engines-07-verified.json'
    if record.exists():shutil.copyfile(record,profile/'visual-engines.json')
(profile / 'data').mkdir(exist_ok=True)
for report in ['smoke-result.json', 'smoke-fatal.json', 'live-codex-result.json','live-verification-result.json','live-engines-result.json','live-reading-result.json','live-agy-startup-result.json']:
    (profile / report).unlink(missing_ok=True)
extensions = profile / 'extensions'
extensions.mkdir(exist_ok=True)
prefs = {
    'extensions.zotero.dataDir': str(profile / 'data'),
    'extensions.zotero.useDataDir': True,
    'extensions.zotero.firstRun': False,
    'extensions.zotero.sync.autoSync': False,
    'extensions.zotero.readerIndependent.auto.enabled': False,
    'extensions.zotero.readerIndependent.delivery.mode': 'auto',
    'extensions.zotero.readerIndependent.ui.tab': 'overview',
    'extensions.zotero.readerIndependent.ai.generation.engine':'codex',
    'extensions.zotero.readerIndependent.ai.verification.engine':'codex',
    'extensions.zotero.readerIndependent.ai.generation.model':'',
    'extensions.zotero.readerIndependent.ai.generation.effort':'',
    'extensions.zotero.readerIndependent.ai.verification.effort':'',
    'extensions.zotero.readerIndependent.ai.verification.model':'',
    'extensions.zotero.readerIndependent.templates.ecology':'',
    'extensions.zotero.readerIndependent.templates.general':'',
    'extensions.zotero.readerIndependent.noteNames.reading':'',
    'extensions.zotero.readerIndependent.noteNames.verification':'',
    'extensions.autoDisableScopes': 0,
    'extensions.enabledScopes': 15,
    'extensions.startupScanScopes': 15,
    'extensions.logging.enabled': True,
    'browser.dom.window.dump.enabled': True,
    'devtools.console.stdout.chrome': True,
    'extensions.update.enabled': False,
    'app.update.auto': False,
    'app.update.enabled': False,
    'browser.shell.checkDefaultBrowser': False,
    'toolkit.telemetry.enabled': False,
    'datareporting.healthreport.uploadEnabled': False,
}
(profile / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k,v in prefs.items()), encoding='utf-8')
(profile / 'synthetic.pdf').write_bytes(b'%PDF-1.4\nsynthetic test input, never uploaded\n%%EOF')
queue_dir=profile/'data'/'zotero-reader-independent'
queue_dir.mkdir(parents=True,exist_ok=True)
(queue_dir/'queue.json').write_text(json.dumps({'schema':1,'jobs':{},'paused':False}),encoding='utf-8')
shutil.copyfile(project/'tests/fake-codex.cjs', profile/'fake-codex.cjs')
shutil.copyfile(project/'tests/fake-engines.cjs',profile/'fake-engines.cjs')
(profile/'fixture-config.json').write_text(json.dumps({'nodePath':shutil.which('node'), 'liveCodexTest':args.live_codex,'liveVerification':args.live_verification,'liveEngines':args.live_engines,'liveReading':args.live_reading,'liveAgyStartup':args.live_agy_startup}), encoding='utf-8')
with zipfile.ZipFile(profile / 'fixture.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('paper/full.md', '# Synthetic paper\n\nSynthetic affiliation: Fictional Soil Institute.\n\nA mock table:\n\n| x | y |\n|---|---|\n|1|2|\n\n![Figure](images/figure.png)')
    z.writestr('paper/content_list.json', json.dumps([{'type':'text','text':'Synthetic paper','page_idx':0}]))
    # Valid one-pixel PNG is enough to test preservation; no remote media.
    import base64
    z.writestr('paper/images/figure.png', base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFioAAAAASUVORK5CYII='))
with zipfile.ZipFile(profile / 'traversal.zip', 'w') as z:
    z.writestr('../escaped.txt', 'reject this entry')
for name,marker in [('fixture-verification-error.zip','__SIM_VERIFY_ERROR__'),('fixture-slow.zip','__SIM_SLEEP__')]:
    with zipfile.ZipFile(profile/name,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('full.md','# Synthetic paper '+marker+'\n\nOnly synthetic test data.')
with zipfile.ZipFile(extensions / 'zotero-reader-independent@local.xpi', 'w', zipfile.ZIP_DEFLATED) as z:
    for p in [project/'manifest.json', project/'bootstrap.js', *sorted((project/'content').rglob('*'))]:
        if not p.is_file(): continue
        text = p.read_bytes()
        if p.name == 'bootstrap.js':
            text += b'''\nvar productionStartup = startup;
startup = async function(data, reason) {
  try {
    await productionStartup(data, reason);
    Services.scriptloader.loadSubScript(data.rootURI + "smoke.js", { Zotero, Services, Components, IOUtils, PathUtils, readerScope });
  } catch(e) {
    await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "smoke-result.json"), JSON.stringify({startupError:String(e),stack:e.stack}));
    Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);
  }
};
'''
        z.writestr(p.relative_to(project).as_posix(), text)
    smoke = (project/'tests/gecko-smoke.js').read_text(encoding='utf-8')
    smoke += '\n'+(project/'tests/stage4-smoke.js').read_text(encoding='utf-8')
    smoke += '\n'+(project/'tests/batch-smoke.js').read_text(encoding='utf-8')
    smoke += '\n'+(project/'tests/attachments-smoke.js').read_text(encoding='utf-8')
    smoke += '\n'+(project/'tests/settings-smoke.js').read_text(encoding='utf-8')
    if args.saved_cleanup:
        smoke=(project/'tests/saved-cleanup-smoke.js').read_text(encoding='utf-8')
    elif args.visual or args.visual_attachments:
        smoke=(project/'tests'/('visual-attachments.js' if args.visual_attachments else 'visual-ui.js')).read_text(encoding='utf-8')
    else:
        smoke += '\nrunGeckoSmoke(readerScope.ReaderApp).catch(async e => { await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "smoke-fatal.json"), JSON.stringify({error:String(e),stack:e.stack})); Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit); });\n'
    z.writestr('smoke.js', smoke)
# Seed only this test addon in the disposable profile's extension database.
xpi = extensions / 'zotero-reader-independent@local.xpi'
stamp = int(time.time() * 1000)
addon = {
    'id': 'zotero-reader-independent@local', 'syncGUID': '{' + str(uuid.uuid4()) + '}',
    'version': json.loads((project/'manifest.json').read_text(encoding='utf-8'))['version'], 'type': 'extension', 'loader': None, 'manifestVersion': 2,
    'updateURL': json.loads((project/'manifest.json').read_text(encoding='utf-8'))['applications']['zotero']['update_url'],
    'defaultLocale': {'name': 'Zotero Reader independent test', 'description': 'Isolated smoke test'},
    'visible': True, 'active': True, 'userDisabled': False, 'appDisabled': False,
    'embedderDisabled': False, 'softDisabled': False, 'foreignInstall': False,
    'installDate': stamp, 'updateDate': stamp, 'applyBackgroundUpdates': 0,
    'path': str(xpi), 'sourceURI': xpi.as_uri(), 'strictCompatibility': True,
    'locales': [], 'targetApplications': [{'id':'zotero@zotero.org','minVersion':'7.0','maxVersion':'10.*'}],
    'targetPlatforms': [], 'signedState': 0, 'seen': True, 'dependencies': [],
    'icons': {}, 'iconURL': None, 'blocklistState': 0, 'startupData': None,
    'hidden': False, 'rootURI': 'jar:' + xpi.as_uri() + '!/', 'location': 'app-profile'
}
(profile/'extensions.json').write_text(json.dumps({'schemaVersion':37,'addons':[addon]}), encoding='utf-8')
# Invalidate only this disposable profile's addon startup index.
(profile/'addonStartup.json.lz4').unlink(missing_ok=True)
print(profile)
