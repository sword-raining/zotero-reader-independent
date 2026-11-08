"""Offline checks for this portable development snapshot; standard library only."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true', help='Also verify the original handoff files and release hash')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
project = root / 'project'
work = root / '.work'
node = shutil.which('node')
if not node:
    raise SystemExit('Node.js is not on PATH. Install/configure Node.js, then rerun this command.')

if args.baseline:
    for line in (root / 'CHECKSUMS.sha256').read_text(encoding='utf-8').splitlines():
        digest, relative = line.split('  ', 1)
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise SystemExit(f'Invalid or missing handoff file: {relative}')
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise SystemExit(f'Handoff checksum mismatch: {relative}. Use no --baseline for intentional source edits.')

work.mkdir(exist_ok=True)
env = dict(os.environ, PYTHONIOENCODING='utf-8')
def run(command):
    result = subprocess.run(command, cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout

for file in [project / 'bootstrap.js', *sorted((project / 'content').glob('*.js')), *sorted((project / 'tests').glob('*.js'))]:
    run([node, '--check', str(file)])
for file in (project / 'content').glob('*.xhtml'):
    ET.parse(file)
tests = sorted((project / 'tests').glob('*.test.cjs'))
log = run([node, '--test', '--test-reporter=tap', *map(str, tests)])
(work / 'unit.log').write_text(log, encoding='utf-8')
passed = re.search(r'^# pass (\d+)$', log, re.MULTILINE)
failed = re.search(r'^# fail (\d+)$', log, re.MULTILINE)
if not passed or not failed or failed.group(1) != '0':
    raise SystemExit('Unexpected test output; inspect .work/unit.log')

version = json.loads((project / 'manifest.json').read_text(encoding='utf-8'))['version']
target = work / f'zotero-reader-independent-{version}.xpi'
run([sys.executable, str(project / 'build.py'), '--output', str(target)])
files = [project / 'manifest.json', project / 'bootstrap.js', *sorted((project / 'content').rglob('*'))]
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == {p.relative_to(project).as_posix() for p in files if p.is_file()}
    for file in files:
        if file.is_file():
            assert archive.read(file.relative_to(project).as_posix()) == file.read_bytes()
digest = hashlib.sha256(target.read_bytes()).hexdigest()
release = root / 'release' / f'zotero-reader-independent-{version}.xpi'
baseline_match = release.exists() and hashlib.sha256(release.read_bytes()).hexdigest() == digest
if args.baseline and not baseline_match:
    raise SystemExit('Rebuilt XPI differs from the bundled release.')
record = {'version': version, 'passed': int(passed.group(1)), 'failed': 0, 'syntaxAndXML': True, 'packageMatchesSource': True,
          'matchesBundledRelease': baseline_match, 'xpiSHA256': digest, 'modelRequests': 0, 'zoteroLaunched': False}
(work / 'check-result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(record, ensure_ascii=True))
