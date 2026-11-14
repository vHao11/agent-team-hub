"""Local install helpers. Machine-readable output never includes credentials."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone


def write_private(path: Path, contents: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(contents)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def update_environment(path: Path, values: dict[str, str]):
    """Update only these dotenv bindings, including duplicates and multiline values."""
    from dotenv.parser import parse_stream
    original = path.read_bytes() if path.exists() else b''
    bom = original.startswith(b'\xef\xbb\xbf')
    text = original.decode('utf-8-sig')
    newline = '\r\n' if '\r\n' in text else '\n'
    seen, parts = set(), []
    for binding in parse_stream(io.StringIO(text)):
        if binding.error:
            raise RuntimeError('Existing DSH .env is not valid dotenv; fix its syntax before installing.')
        if binding.key not in values:
            parts.append(binding.original.string)
            continue
        key = binding.key
        match = re.search(r'(?m)^[ \t]*(?:export[ \t]+)?' + re.escape(key) + r'[ \t]*=', binding.original.string)
        prefix = binding.original.string[:match.start()] if match else ''
        parts.append(prefix)
        if key not in seen:
            parts.append(key + '=' + json.dumps(values[key], ensure_ascii=False) + newline)
            seen.add(key)
    result = ''.join(parts)
    for key, value in values.items():
        if key not in seen:
            if result and not result.endswith(('\n', '\r')):
                result += newline
            result += key + '=' + json.dumps(value, ensure_ascii=False) + newline
    encoded = (b'\xef\xbb\xbf' if bom else b'') + result.encode('utf-8')
    if encoded == original:
        return {'changed': False, 'path': str(path)}
    backup = None
    if path.exists():
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = path.with_name(path.name + '.teamhub-backup-' + stamp)
        write_private(backup, original)
    write_private(path, encoded)
    return {'changed': True, 'path': str(path), 'backup': str(backup) if backup else None}


def prepare(data_dir: Path, port: int, demo: bool):
    from sqlalchemy import func, select
    from teamhub.bootstrap import ensure_mode, initialize_workspace, seed_demo
    from teamhub.db import Database, users
    from teamhub.service import Hub
    database = Database(data_dir)
    connection_file = data_dir / 'install-connection.json'
    try:
        ensure_mode(database, demo)
        hub = Hub(database, demo=demo)
        if demo:
            seed_demo(hub)
            token = 'demo-lin'
        else:
            with database.read() as connection:
                populated = bool(connection.execute(select(func.count()).select_from(users)).scalar_one())
            if not populated:
                token = initialize_workspace(database)['token']
            else:
                stored = json.loads(connection_file.read_text(encoding='utf-8')) if connection_file.exists() else {}
                token = os.environ.get('TEAMHUB_INSTALL_TOKEN') or stored.get('token') or os.environ.get('TEAMHUB_TOKEN')
                if not token:
                    raise RuntimeError('Workspace already exists. Supply its current member token with -Token or TEAMHUB_TOKEN; no identity was reset.')
        try:
            actor = hub.actor(token)
        except Exception:
            raise RuntimeError('The supplied credential does not match this local workspace; no identity was reset.') from None
        url = f'http://127.0.0.1:{port}'
        write_private(connection_file, json.dumps({'url': url, 'token': token, 'demo': demo}, ensure_ascii=False, indent=2).encode('utf-8'))
        return {'url': url, 'connection_file': str(connection_file), 'data_dir': str(data_dir), 'user_id': actor['id'], 'demo': demo}
    finally:
        database.close()


def probe(url, token, demo):
    import httpx
    try:
        with httpx.Client(trust_env=False, timeout=2) as client:
            health = client.get(url + '/api/v1/health')
            if health.status_code != 200:
                return False
            state = health.json()
            if state.get('status') != 'ok' or state.get('demo_mode') is not demo:
                return False
            identity = client.get(url + '/api/v1/auth/me', headers={'Authorization': 'Bearer ' + token})
            return identity.status_code == 200 and bool(identity.json().get('id'))
    except (httpx.HTTPError, ValueError):
        return False


def start_service(data_dir: Path, port: int):
    connection = json.loads((data_dir / 'install-connection.json').read_text(encoding='utf-8'))
    url, token, demo = connection['url'], connection['token'], connection['demo']
    if url != f'http://127.0.0.1:{port}':
        raise RuntimeError('Connection port differs from the requested local service.')
    if probe(url, token, demo):
        return {'service': 'reused', 'url': url}
    with socket.socket() as check:
        if check.connect_ex(('127.0.0.1', port)) == 0:
            raise RuntimeError('The selected port is occupied by another service or identity. Choose -Port; no existing process was stopped.')
    logs = data_dir / 'logs'
    logs.mkdir(exist_ok=True)
    command = [sys.executable, '-m', 'teamhub', 'serve', '--data-dir', str(data_dir), '--host', '127.0.0.1', '--port', str(port)]
    if demo:
        command.append('--demo')
    options = {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    with (logs / 'server.stdout.log').open('ab') as output, (logs / 'server.stderr.log').open('ab') as errors:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=errors, **options)
    for _ in range(60):
        if probe(url, token, demo):
            write_private(data_dir / 'install-service.json', json.dumps({'pid': process.pid, 'url': url}).encode())
            return {'service': 'started', 'pid': process.pid, 'url': url}
        if process.poll() is not None:
            raise RuntimeError(f'Hub exited during startup. Inspect logs in {logs}.')
        time.sleep(0.5)
    process.terminate()
    raise RuntimeError(f'Hub did not become ready. Only the newly started Hub process was stopped; inspect {logs}.')


def configure(data_dir: Path, dsh_home: Path):
    connection = json.loads((data_dir / 'install-connection.json').read_text(encoding='utf-8'))
    if not probe(connection['url'], connection['token'], connection['demo']):
        raise RuntimeError('Hub identity verification failed; DSH environment was not changed.')
    if not dsh_home.is_dir():
        raise RuntimeError('DSH_HOME must already exist.')
    return update_environment(dsh_home / '.env', {'TEAMHUB_URL': connection['url'], 'TEAMHUB_TOKEN': connection['token']})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'start', 'configure-env'])
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--demo', action='store_true')
    parser.add_argument('--dsh-home')
    arguments = parser.parse_args()
    data_dir = Path(arguments.data_dir).resolve()
    try:
        if not 1 <= arguments.port <= 65535:
            raise RuntimeError('Port must be between 1 and 65535.')
        if arguments.command == 'prepare':
            result = prepare(data_dir, arguments.port, arguments.demo)
        elif arguments.command == 'start':
            result = start_service(data_dir, arguments.port)
        else:
            if not arguments.dsh_home:
                raise RuntimeError('--dsh-home is required.')
            result = configure(data_dir, Path(arguments.dsh_home).resolve())
        print(json.dumps(result, ensure_ascii=True))
    except (RuntimeError, OSError, ValueError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=True), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
