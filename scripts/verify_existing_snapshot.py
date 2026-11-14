"""Check an existing workspace migration using only an isolated online backup."""
from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import sqlite3
import sys
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path

def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def tables(connection):
    names = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_versions'")]
    return {name: [row[1] for row in connection.execute(f'PRAGMA table_info({quote(name)})')] for name in names}


def fingerprints(connection, schema):
    result = {}
    for name, columns in schema.items():
        select = ', '.join(map(quote, columns))
        rows = connection.execute(f'SELECT {select} FROM {quote(name)}')
        hashes = sorted(hashlib.sha256(pickle.dumps(row, protocol=4)).digest() for row in rows)
        result[name] = (len(hashes), hashlib.sha256(b''.join(hashes)).digest())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('data_dir', type=Path)
    parser.add_argument('--installed', action='store_true', help='Validate the package installed in this Python environment')
    args = parser.parse_args()
    if not args.installed:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
    from teamhub.__main__ import backup
    from teamhub.db import Database
    with tempfile.TemporaryDirectory(prefix='teamhub-existing-migration-') as temporary:
        root = Path(temporary).resolve()
        archive = root / 'snapshot.zip'
        backup(args.data_dir.expanduser().resolve(), archive)
        restored = root / 'restored'
        restored.mkdir()
        with zipfile.ZipFile(archive) as source:
            for entry in source.infolist():
                target = (restored / entry.filename).resolve()
                if not target.is_relative_to(restored) or entry.is_dir():
                    raise RuntimeError('Unexpected backup entry')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(entry))
                if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(source.read(entry)).digest():
                    raise RuntimeError('Backup restoration failed')
            artifact_count = sum(entry.filename.startswith('artifacts/') for entry in source.infolist())
        snapshot = restored / 'teamhub.db'
        with closing(sqlite3.connect(snapshot)) as connection:
            old_version = connection.execute('SELECT version FROM schema_versions').fetchone()[0]
            old_schema = tables(connection)
            original = fingerprints(connection, old_schema)
        database = Database(restored)
        database.close()
        with closing(sqlite3.connect(snapshot)) as connection:
            version = connection.execute('SELECT version FROM schema_versions').fetchone()[0]
            integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
            foreign_key_errors = connection.execute('PRAGMA foreign_key_check').fetchall()
            migrated = fingerprints(connection, old_schema)
        if original != migrated or integrity != 'ok' or foreign_key_errors:
            raise RuntimeError('Existing rows or database integrity changed during migration')
        print(json.dumps({'result': 'passed', 'old_schema': old_version, 'new_schema': version,
                          'existing_tables_verified': len(original), 'existing_rows_verified': sum(x[0] for x in original.values()),
                          'artifacts_verified': artifact_count, 'production_modified': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
