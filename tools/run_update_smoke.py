"""Exercise the published update feed with Zotero's updater in a disposable profile.
Requires the current release/feed to be public. No personal profile or credentials are used.
The 1.0.1 seed has only update_url changed: the real old .invalid URL cannot bootstrap itself.
"""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys
import time
import uuid
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--zotero', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
profile = root / '.work' / ('update-native-' + uuid.uuid4().hex[:8])
prepare = root / 'project/tests/prepare_smoke.py'
code = prepare.read_text(encoding='utf-8').replace('.work/queue-toggle-profile', profile.relative_to(root).as_posix())
old_args = sys.argv[:]
try:
    sys.argv = [str(prepare), '--queue-toggle']
    exec(compile(code, str(prepare), 'exec'), {'__file__': str(prepare), '__name__': '__main__'})
finally:
    sys.argv = old_args
manifest = json.loads((root / 'project/manifest.json').read_text(encoding='utf-8'))
app = manifest['applications']['zotero']
update = json.loads((root / 'updates.json').read_text(encoding='utf-8'))['addons'][app['id']]['updates'][0]
(profile / 'update-fixture.json').write_text(json.dumps({'id': app['id'], 'version': manifest['version'], 'updateURL': app['update_url'], 'updateLink': update['update_link']}), encoding='utf-8')
seed = profile / 'extensions' / (app['id'] + '.xpi')
with zipfile.ZipFile(root / 'release/zotero-reader-independent-1.0.1.xpi') as previous, zipfile.ZipFile(seed, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in previous.namelist():
        data = previous.read(name)
        if name == 'manifest.json':
            old_manifest = json.loads(data)
            old_manifest['applications']['zotero']['update_url'] = app['update_url']
            data = json.dumps(old_manifest).encode('utf-8')
        archive.writestr(name, data)
tester_id = 'zri-update-smoke@local'
tester = profile / 'extensions' / (tester_id + '.xpi')
with zipfile.ZipFile(tester, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('manifest.json', json.dumps({'manifest_version': 2, 'name': 'Isolated updater test', 'version': '1.0', 'applications': {'zotero': {'id': tester_id, 'update_url': 'https://test.invalid/updates.json', 'strict_min_version': '7.0', 'strict_max_version': '10.*'}}}))
    archive.writestr('bootstrap.js', (root / 'project/tests/update-smoke.js').read_bytes())
db_path = profile / 'extensions.json'
db = json.loads(db_path.read_text(encoding='utf-8'))
entry = db['addons'][0]
entry.update(version='1.0.1', updateURL=app['update_url'])
helper = dict(entry)
helper.update(id=tester_id, version='1.0', syncGUID='{' + str(uuid.uuid4()) + '}', path=str(tester), sourceURI=tester.as_uri(), rootURI='jar:' + tester.as_uri() + '!/', updateURL='https://test.invalid/updates.json', defaultLocale={'name': 'Isolated updater test', 'description': 'Synthetic updater harness'})
db['addons'].append(helper)
db_path.write_text(json.dumps(db), encoding='utf-8')
with (profile / 'user.js').open('a', encoding='utf-8') as prefs:
    prefs.write('\nuser_pref("extensions.update.enabled", true);\nuser_pref("extensions.update.autoUpdateDefault", true);\n')
env = dict(os.environ, MOZ_HEADLESS='1', MOZ_NO_REMOTE='1')
process = subprocess.Popen([args.zotero, '-no-remote', '-new-instance', '-profile', str(profile), '-datadir', str(profile / 'data'), '-headless', '-purgecaches'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
print('PROFILE=' + str(profile), flush=True)
deadline = time.monotonic() + 150
while time.monotonic() < deadline:
    report_path = profile / 'update-result.json'
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding='utf-8'))
        if report.get('completed') or report.get('error'):
            print(json.dumps(report, ensure_ascii=True), flush=True)
            raise SystemExit(0 if report.get('completed') and all(t['ok'] for t in report['tests']) else 1)
    time.sleep(.4)
raise SystemExit('Native update check timed out; inspect only ' + str(profile))
