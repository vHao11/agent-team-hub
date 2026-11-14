"""Build a Python wheel containing the production web UI and sample capabilities."""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default=str(root / 'dist'))
    arguments = parser.parse_args()
    source = root / 'web/dist'
    if not (source / 'index.html').is_file():
        parser.error('First build the frontend: cd web && npm ci && npm run build')
    # Stage the wheel separately so building it never overwrites source-tree assets.
    with tempfile.TemporaryDirectory(prefix='teamhub-wheel-build-') as temporary:
        stage = Path(temporary)
        for name in ('pyproject.toml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'):
            shutil.copy2(root / name, stage / name)
        shutil.copytree(root / 'server/teamhub', stage / 'server/teamhub',
                        ignore=shutil.ignore_patterns('static', '__pycache__', '*.pyc', '*.pyo'))
        shutil.copytree(source, stage / 'server/teamhub/static')
        subprocess.run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', str(Path(arguments.output).resolve()), str(stage)], check=True)


if __name__ == '__main__':
    main()
