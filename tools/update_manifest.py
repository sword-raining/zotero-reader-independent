"""Generate the public Zotero update feed from an existing release XPI."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'project/manifest.json').read_text(encoding='utf-8'))
app = manifest['applications']['zotero']
version = manifest['version']
repo = 'sword-raining/zotero-reader-independent'
expected_url = f'https://raw.githubusercontent.com/{repo}/main/updates.json'
if app['update_url'] != expected_url:
    raise SystemExit('Unexpected update URL; verify the public repository before publishing.')
filename = f'zotero-reader-independent-{version}.xpi'
package = root / 'release' / filename
if not package.is_file():
    raise SystemExit(f'Build and stage release/{filename} first.')
with zipfile.ZipFile(package) as archive:
    packaged = json.loads(archive.read('manifest.json'))
    if packaged != manifest:
        raise SystemExit('Release manifest differs from the current source manifest.')
feed = {'addons': {app['id']: {'updates': [{
    'version': version,
    'update_link': f'https://github.com/{repo}/releases/download/v{version}/{filename}',
    'update_hash': 'sha256:' + hashlib.sha256(package.read_bytes()).hexdigest(),
    'applications': {'zotero': {key: app[key] for key in ('strict_min_version', 'strict_max_version')}}
}]}}}
(root / 'updates.json').write_text(json.dumps(feed, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'version': version, 'feed': expected_url, 'update': feed['addons'][app['id']]['updates'][0]}))
