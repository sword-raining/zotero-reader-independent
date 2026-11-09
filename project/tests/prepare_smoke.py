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
parser.add_argument('--cli-detection',action='store_true',help='Run isolated CLI discovery and settings state regressions with synthetic CLIs')
parser.add_argument('--live-cli-status',action='store_true',help='Probe real local CLIs and send one fixed non-document ping per channel')
parser.add_argument('--collection-watch',action='store_true',help='Test collection intake and compact settings layout with synthetic items')
parser.add_argument('--workflow',action='store_true',help='Test concurrent paper/review workflow, resume, labels and confirmed classification with synthetic data')
parser.add_argument('--reader-ui',action='store_true',help='Exercise and capture the guided native reader with synthetic data')
parser.add_argument('--archive-ui',action='store_true',help='Test recommendation, manual import trigger and multi-collection confirmation with synthetic data')
parser.add_argument('--settings-ui',action='store_true',help='Check settings alignment and greeting feedback in an isolated profile with mocked models')
parser.add_argument('--attribution',action='store_true',help='Check label formatting and manual-edit preservation with synthetic data')
parser.add_argument('--completed-cleanup',action='store_true',help='Check one-click completed task cleanup and queue history with synthetic data')
parser.add_argument('--footnote-source',action='store_true',help='Verify omitted page-footnote input using old synthetic cache and mocked models')
parser.add_argument('--batch-language',action='store_true',help='Verify language filtering and saved-note skipping in an isolated batch preview')
parser.add_argument('--auto-archive',action='store_true',help='Test automatic archive after saving with synthetic papers and fake model calls')
parser.add_argument('--cancel-resume',action='store_true',help='Test explicit continuation after cancellation with retained synthetic drafts')
parser.add_argument('--bulk-save',action='store_true',help='Test one-click saving with synthetic notes and zero model calls')
parser.add_argument('--bulk-resume',action='store_true',help='Test one-click continuation, shared concurrency and pause with synthetic drafts')
parser.add_argument('--queue-toggle',action='store_true',help='Test a single Start/Pause All button and checkpoint recovery with synthetic tasks')
parser.add_argument('--existing-classification',action='store_true',help='Test confirmation of suggestions for already classified papers using a synthetic saved reading')
parser.add_argument('--batch-selection',action='store_true',help='Test actionable main-PDF selection blockers in a long synthetic batch')
parser.add_argument('--attachment-selection',action='store_true',help='Verify automatic role and published-version selection using real local extraction of synthetic PDFs')
parser.add_argument('--attachment-maintenance',action='store_true',help='Test exact duplicate trash and DOI-confirmed reparenting with synthetic annotated PDFs')
parser.add_argument('--multidevice',action='store_true',help='Test three isolated clients against a loopback synthetic WebDAV coordinator')
parser.add_argument('--note-consistency',action='store_true',help='Test conflicting same-run saves, edited recovery and interrupted archive confirmation using synthetic data')
args = parser.parse_args()

project = Path(__file__).resolve().parents[1]
profile = project.parent / ('.work/multidevice-profile' if args.multidevice else '.work/note-consistency-profile' if args.note_consistency else '.work/attachment-maintenance-profile' if args.attachment_maintenance else '.work/attachment-selection-profile' if args.attachment_selection else '.work/batch-selection-profile' if args.batch_selection else '.work/existing-classification-profile' if args.existing_classification else '.work/queue-toggle-profile' if args.queue_toggle else '.work/bulk-resume-profile' if args.bulk_resume else '.work/bulk-save-profile' if args.bulk_save else '.work/cancel-resume-profile' if args.cancel_resume else '.work/auto-archive-profile' if args.auto_archive else '.work/batch-language-profile' if args.batch_language else '.work/footnote-source-profile' if args.footnote_source else '.work/completed-cleanup-profile' if args.completed_cleanup else '.work/attribution-profile' if args.attribution else '.work/settings-ui-profile' if args.settings_ui else '.work/archive-ui-profile' if args.archive_ui else '.work/reader-ui-profile' if args.reader_ui else '.work/workflow-profile' if args.workflow else '.work/collection-watch-profile' if args.collection_watch else '.work/live-cli-status-profile' if args.live_cli_status else '.work/cli-detection-profile' if args.cli_detection else 'zotero-reader-smoke-profile')
profile.mkdir(parents=True,exist_ok=True)
if args.visual:
    record=project.parent/'live-engines-011-verified.json'
    if not record.exists():record=project.parent/'live-engines-08-verified.json'
    if not record.exists():record=project.parent/'live-engines-07-verified.json'
    if record.exists():shutil.copyfile(record,profile/'visual-engines.json')
(profile / 'data').mkdir(exist_ok=True)
for report in ['smoke-result.json', 'smoke-fatal.json', 'live-codex-result.json','live-verification-result.json','live-engines-result.json','live-reading-result.json','live-agy-startup-result.json','cli-detection-result.json','cli-detection-fatal.json','collection-watch-result.json','collection-watch-fatal.json','live-cli-status-result.json','live-cli-status-fatal.json','workflow-result.json','workflow-fatal.json','reader-ui-result.json','reader-ui-fatal.json','archive-ui-result.json','archive-ui-fatal.json','settings-ui-result.json','settings-ui-fatal.json','attribution-result.json','attribution-fatal.json','completed-cleanup-result.json','completed-cleanup-fatal.json','footnote-source-result.json','footnote-source-fatal.json','batch-language-result.json','batch-language-fatal.json','auto-archive-result.json','auto-archive-fatal.json','cancel-resume-result.json','cancel-resume-fatal.json','bulk-save-result.json','bulk-save-fatal.json','bulk-resume-result.json','bulk-resume-fatal.json','queue-toggle-result.json','queue-toggle-fatal.json','existing-classification-result.json','existing-classification-fatal.json','batch-selection-result.json','batch-selection-fatal.json','attachment-selection-result.json','attachment-selection-fatal.json','attachment-maintenance-result.json','attachment-maintenance-fatal.json','note-consistency-result.json','note-consistency-fatal.json']:
    (profile / report).unlink(missing_ok=True)
extensions = profile / 'extensions'
extensions.mkdir(exist_ok=True)
prefs = {
    'extensions.zotero.dataDir': str(profile / 'data'),
    'extensions.zotero.useDataDir': True,
    'extensions.zotero.firstRun': False,
    'extensions.zotero.firstRun2': False,
    'extensions.zoteroWinWordIntegration.skipInstallation': True,
    'extensions.zoteroOpenOfficeIntegration.skipInstallation': True,
    'extensions.zotero.sync.autoSync': False,
    'extensions.zotero.readerIndependent.auto.enabled': False,
    'extensions.zotero.readerIndependent.reading.skipChinese': bool(args.batch_language),
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
(profile/'fixture-config.json').write_text(json.dumps({'pluginVersion':json.loads((project/'manifest.json').read_text(encoding='utf-8'))['version'], 'nodePath':shutil.which('node'), 'liveCLIStatus':args.live_cli_status, 'liveCodexTest':args.live_codex,'liveVerification':args.live_verification,'liveEngines':args.live_engines,'liveReading':args.live_reading,'liveAgyStartup':args.live_agy_startup}), encoding='utf-8')
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
    if args.multidevice:
        smoke=(project/'tests/multidevice-smoke.js').read_text(encoding='utf-8')
    elif args.note_consistency:
        smoke=(project/'tests/note-consistency-smoke.js').read_text(encoding='utf-8')
    elif args.attachment_maintenance:
        smoke=(project/'tests/attachment-maintenance-smoke.js').read_text(encoding='utf-8')
    elif args.attachment_selection:
        smoke=(project/'tests/attachment-selection-smoke.js').read_text(encoding='utf-8')
    elif args.batch_selection:
        smoke=(project/'tests/batch-selection-smoke.js').read_text(encoding='utf-8')
    elif args.existing_classification:
        smoke=(project/'tests/existing-classification-smoke.js').read_text(encoding='utf-8')
    elif args.queue_toggle:
        smoke=(project/'tests/queue-toggle-smoke.js').read_text(encoding='utf-8')
    elif args.bulk_resume:
        smoke=(project/'tests/bulk-resume-smoke.js').read_text(encoding='utf-8')
    elif args.bulk_save:
        smoke=(project/'tests/bulk-save-smoke.js').read_text(encoding='utf-8')
    elif args.cancel_resume:
        smoke=(project/'tests/cancel-resume-smoke.js').read_text(encoding='utf-8')
    elif args.auto_archive:
        smoke=(project/'tests/auto-archive-smoke.js').read_text(encoding='utf-8')
    elif args.batch_language:
        smoke=(project/'tests/batch-language-smoke.js').read_text(encoding='utf-8')
    elif args.footnote_source:
        smoke=(project/'tests/footnote-source-smoke.js').read_text(encoding='utf-8')
    elif args.completed_cleanup:
        smoke=(project/'tests/completed-cleanup-smoke.js').read_text(encoding='utf-8')
    elif args.attribution:
        smoke=(project/'tests/attribution-smoke.js').read_text(encoding='utf-8')
    elif args.settings_ui:
        smoke=(project/'tests/settings-ui-smoke.js').read_text(encoding='utf-8')
    elif args.archive_ui:
        smoke=(project/'tests/archive-ui-smoke.js').read_text(encoding='utf-8')
    elif args.reader_ui:
        smoke=(project/'tests/reader-ui-smoke.js').read_text(encoding='utf-8')
    elif args.workflow:
        smoke=(project/'tests/workflow-smoke.js').read_text(encoding='utf-8')
    elif args.collection_watch:
        smoke=(project/'tests/collection-watch-smoke.js').read_text(encoding='utf-8')
    elif args.live_cli_status:
        smoke=(project/'tests/live-cli-status-smoke.js').read_text(encoding='utf-8')
    elif args.cli_detection:
        smoke=(project/'tests/cli-detection-smoke.js').read_text(encoding='utf-8')
    elif args.saved_cleanup:
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
