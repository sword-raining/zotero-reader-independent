"""Reproducible XPI packaging; tests and development tools stay out of the addon."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
args = parser.parse_args()
target = Path(args.output).resolve()
target.parent.mkdir(parents=True, exist_ok=True)
files = [root / 'manifest.json', root / 'bootstrap.js', *sorted((root / 'content').rglob('*'))]
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for path in files:
        if not path.is_file():
            continue
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 11, 5, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, path.read_bytes())
print(json.dumps({'file': str(target), 'bytes': target.stat().st_size,
                  'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}, ensure_ascii=False))
