"""Package a reviewed source checkout; never include runtime data or dependencies."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IGNORED = {'.git', '.venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'build'}
ROOT_FILES = {'README.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'pyproject.toml', 'constraints-tested.txt', '.gitignore'}
ROOT_DIRS = {'server', 'web', 'packages', 'examples', 'docs', 'scripts', 'tests', '.github'}


def include(path):
    relative = path.relative_to(ROOT)
    if path.is_symlink() or not path.is_file():
        return False
    if any(part in IGNORED or part.endswith('.egg-info') or part.startswith('.teamhub') for part in relative.parts):
        return False
    # 界面构建结果是源码发行包的一部分；其他 dist 目录可能包含旧的发行包。
    if 'dist' in relative.parts and relative.parts[:2] != ('web', 'dist'):
        return False
    if path.suffix in {'.pyc', '.pyo', '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite-wal', '.sqlite-shm',
                       '.sqlite3', '.sqlite3-wal', '.sqlite3-shm', '.log', '.tsbuildinfo'} or path.name.startswith('.env'):
        return False
    if relative.parts[:3] == ('server', 'teamhub', 'static'):
        return False
    return (len(relative.parts) == 1 and relative.name in ROOT_FILES) or relative.parts[0] in ROOT_DIRS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--wheel', help='Optional prebuilt wheel to include under distributions/')
    arguments = parser.parse_args()
    target = Path(arguments.output).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        parser.error('Output already exists; choose a new release filename.')
    if not (ROOT / 'web/dist/index.html').is_file():
        parser.error('Build the frontend before packaging: cd web && npm ci && npm run build')
    wheel = Path(arguments.wheel).resolve() if arguments.wheel else None
    if wheel:
        with zipfile.ZipFile(wheel) as built:
            for name in built.namelist():
                if name.startswith('teamhub/') and not name.endswith('/'):
                    current = (ROOT / 'web/dist' / name.removeprefix('teamhub/static/')) if name.startswith('teamhub/static/') else (ROOT / 'server' / name)
                    if not current.is_file() or current.read_bytes() != built.read(name):
                        parser.error(f'Wheel is stale or inconsistent: {name}. Build it again before packaging.')
    paths = sorted(path for path in ROOT.rglob('*') if include(path))
    tracked = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, text=True)
    if tracked.returncode == 0:
        packaged = {path.relative_to(ROOT).as_posix() for path in paths}
        missing = set(filter(None, tracked.stdout.split('\0'))) - packaged
        if missing:
            parser.error('Tracked files missing from release: ' + ', '.join(sorted(missing)))
    commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
    manifest = {
        'project': 'agent-team-hub', 'version': tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))['project']['version'],
        'packaged_at': datetime.now(timezone.utc).isoformat(),
        'source_commit': commit.stdout.strip() if commit.returncode == 0 else None,
        'python_build_runtime': sys.version.split()[0],
        'source_files': len(paths),
        'sha256': {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
    }
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            archive.write(path, 'agent-team-hub/' + path.relative_to(ROOT).as_posix())
        if arguments.wheel:
            archive.write(wheel, 'agent-team-hub/distributions/' + wheel.name)
        archive.writestr('agent-team-hub/RELEASE.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    print(json.dumps({'file': str(target), 'bytes': target.stat().st_size, 'files': len(paths),
                      'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
