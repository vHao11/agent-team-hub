"""Create and verify a private, non-overwriting local backup before stage-2 rollout."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import uuid
import zipfile

from verify_existing_snapshot import fingerprints, tables


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_checked(source, destination, backup_root, manifest):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f'Backup source is not a regular file: {source.name}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    before = sha(source)
    shutil.copy2(source, destination)
    if sha(destination) != before or sha(source) != before:
        raise RuntimeError(f'Backup source changed while copying: {source.name}')
    manifest[destination.relative_to(backup_root).as_posix()] = before


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hub-home', type=Path, required=True)
    parser.add_argument('--dsh-home', type=Path, required=True)
    parser.add_argument('--machine-file', type=Path, required=True)
    parser.add_argument('--candidate-python', type=Path, required=True)
    args = parser.parse_args()
    hub, dsh, machine_file = args.hub_home.resolve(), args.dsh_home.resolve(), args.machine_file.resolve()
    machine = json.loads(machine_file.read_text(encoding='utf-8-sig'))
    profile = dsh / 'profiles' / machine['profile']
    board, superagent = dsh / 'state/todo-kanban', dsh / 'state/superagent'
    if Path(machine['dshHome']).resolve() != dsh or not (hub / 'data/teamhub.db').is_file():
        raise RuntimeError('The requested Hub or DSH home does not match the machine configuration')
    backup_root = hub / 'backups'
    backup_root.mkdir(exist_ok=True)
    dest = backup_root / ('stage2-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    dest.mkdir()
    manifest = {}
    hub_zip = dest / 'hub-before-upgrade.zip'
    old_python = hub / '.venv-release-3bd3d820-a/Scripts/python.exe'
    result = subprocess.run([str(old_python), '-m', 'teamhub', 'backup', '--data-dir', str(hub / 'data'),
                             '--output', str(hub_zip)], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError('Hub backup failed; partial backup retained at ' + str(dest))
    with tempfile.TemporaryDirectory(prefix='teamhub-backup-verify-') as temporary:
        restored = Path(temporary).resolve()
        with zipfile.ZipFile(hub_zip) as archive:
            if archive.testzip() is not None:
                raise RuntimeError('Hub backup archive failed integrity validation')
            for entry in archive.infolist():
                target = (restored / entry.filename).resolve()
                if not target.is_relative_to(restored) or entry.is_dir():
                    raise RuntimeError('Unexpected archive entry')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(entry))
        with closing(sqlite3.connect(restored / 'teamhub.db')) as connection:
            schema = tables(connection)
            before = fingerprints(connection, schema)
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Restored Hub database failed integrity validation')
        migration = subprocess.run([str(args.candidate_python.resolve()), '-c',
                                    'import sys;from teamhub.db import Database; d=Database(sys.argv[1]); d.close()',
                                    str(restored)], capture_output=True, text=True)
        if migration.returncode:
            raise RuntimeError('Restored Hub backup cannot migrate to the candidate version')
        with closing(sqlite3.connect(restored / 'teamhub.db')) as connection:
            if fingerprints(connection, schema) != before or connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Restored Hub rows changed during migration')
    manifest['hub-before-upgrade.zip'] = sha(hub_zip)
    for source in board.rglob('*'):
        if source.is_symlink():
            raise RuntimeError('Board state contains a symlink; backup requires manual review')
        if source.is_file():
            copy_checked(source, dest / 'todo-kanban' / source.relative_to(board), dest, manifest)
    board_file = dest / 'todo-kanban/board.json'
    if not board_file.is_file():
        raise RuntimeError('Board state was not backed up')
    json.loads(board_file.read_text(encoding='utf-8-sig'))
    source_db = superagent / 'orchestrator.sqlite'
    target_db = dest / 'superagent/orchestrator.sqlite'
    target_db.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(source_db.as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(target_db)) as target:
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Superagent database backup failed integrity validation')
    manifest['superagent/orchestrator.sqlite'] = sha(target_db)
    for source in superagent.rglob('*'):
        if source.is_symlink():
            raise RuntimeError('Superagent state contains a symlink; backup requires manual review')
        if source.is_file() and source.name not in {'orchestrator.sqlite', 'orchestrator.sqlite-wal', 'orchestrator.sqlite-shm'}:
            copy_checked(source, dest / 'superagent' / source.relative_to(superagent), dest, manifest)
    for name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml',
                 'machine.local.yml', 'network.local.json', '.workbench-overlay.enabled'):
        source = profile / name
        if source.is_file():
            copy_checked(source, dest / 'profile' / name, dest, manifest)
    for source in (machine_file, hub / 'start-teamhub.ps1', Path(machine.get('restartScript', '')),
                   dsh / '.env'):
        if source.is_file():
            copy_checked(source, dest / 'local-config' / source.name, dest, manifest)
    (dest / 'backup-manifest.json').write_text(json.dumps({'schema': 1, 'files': manifest,
        'hub_restore_migration': 'passed', 'superagent_sqlite_integrity': 'ok', 'board_json': 'valid'}, indent=2), encoding='utf-8')
    print(json.dumps({'backup_dir': str(dest), 'hub_restore_migration': 'passed', 'superagent_integrity': 'ok',
                      'board_json': 'valid', 'copied_files': len(manifest)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
