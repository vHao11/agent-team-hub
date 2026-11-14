"""Install and boot an official DSH host in a temporary directory, without model calls.

Run with this project's Python environment. The default installs an isolated copy
of the requested official host; --runtime-dir may reuse an existing independent
test runtime. It never uses or edits the caller's DSH profile or DSH_HOME.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SUPPORTED = ('0.2.2-rc.1', '0.2.2-rc.2')


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def redact(text: str) -> str:
    return re.sub(r'token=[^\s]+', 'token=<redacted>', text, flags=re.IGNORECASE)


def run(command: list[str], *, environment: dict[str, str], directory: Path, timeout: int = 180) -> subprocess.CompletedProcess:
    result = subprocess.run(command, cwd=directory, env=environment, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=timeout)
    if result.returncode:
        raise RuntimeError(redact(f'Command exited {result.returncode}: {result.stdout[-5000:]}\n{result.stderr[-5000:]}'))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', choices=SUPPORTED, default=SUPPORTED[-1])
    parser.add_argument('--runtime-dir', type=Path, help='Reuse an independently installed test runtime containing node_modules; no host upgrade is performed.')
    parser.add_argument('--package', type=Path, help='Verify this specific built bundle instead of packages/dsh-plugin/dist.')
    arguments = parser.parse_args()
    manifest = json.loads((PROJECT_ROOT / 'packages/dsh-plugin/package.json').read_text())
    tarball = arguments.package.resolve() if arguments.package else PROJECT_ROOT / 'packages/dsh-plugin/dist' / f'dsh-team-hub-{manifest["version"]}.tgz'
    if not tarball.is_file():
        raise RuntimeError('Plugin tarball is missing. Run npm pack --pack-destination dist in packages/dsh-plugin first.')
    node = shutil.which('node')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not node or (not arguments.runtime_dir and not npm):
        raise RuntimeError('Node.js 24.9+ and npm are required.')

    # Carry only OS/network settings; never inherit model credentials or an existing DSH configuration.
    allowed = {'path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec', 'pathext',
               'tmp', 'temp', 'tmpdir', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
               'ssl_cert_file', 'ssl_cert_dir', 'node_extra_ca_certs', 'lang', 'lc_all'}
    environment = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    with tempfile.TemporaryDirectory(prefix='teamhub-dsh-check-') as temporary:
        directory = Path(temporary).resolve()
        runtime = arguments.runtime_dir.resolve() if arguments.runtime_dir else directory / 'runtime'
        hub_port, dsh_port = free_port(), free_port()
        while dsh_port == hub_port:
            dsh_port = free_port()
        environment.update({
            'DSH_HOME': str(directory / 'dsh-home'),
            'DSH_AGENTS_HOME': str(directory / 'agents-home'),
            'DSH_TELEMETRY_DISABLED': '1',
            'TEAMHUB_STATE_DIR': str(directory / 'bridge-state'),
            'TEAMHUB_URL': f'http://127.0.0.1:{hub_port}', 'TEAMHUB_TOKEN': 'demo-lin',
            'DSH_SMOKE_PORT': str(dsh_port), 'DSH_SMOKE_RUNTIME_DIR': str(runtime),
            'PYTHONPATH': str(PROJECT_ROOT / 'server'),
        })
        path_key = next((key for key in environment if key.lower() == 'path'), 'PATH')
        environment[path_key] = str(runtime / 'node_modules/.bin') + os.pathsep + environment.get(path_key, '')
        node_version = run([node, '--version'], environment=environment, directory=directory).stdout.strip()
        if tuple(map(int, node_version.lstrip('v').split('.')[:3])) < (24, 9, 0):
            raise RuntimeError('Node.js 24.9+ is required.')
        if not arguments.runtime_dir:
            runtime.mkdir()
            print(f'Installing isolated official DSH {arguments.version}...', flush=True)
            run([npm, 'install', '--prefix', str(runtime), '--ignore-scripts', '--no-audit', '--no-fund',
                 f'@deepseek-ai/dsh@{arguments.version}', 'pnpm@10.34.9'],
                environment=environment, directory=directory, timeout=600)
        dsh = runtime / 'node_modules/@deepseek-ai/dsh/lib/bin.js'
        if not dsh.is_file():
            raise RuntimeError('The runtime does not contain the official DSH CLI.')
        version = run([node, str(dsh), '--version'], environment=environment, directory=directory).stdout.strip()
        if version != arguments.version:
            raise RuntimeError(f'Requested DSH {arguments.version}, but the provided runtime is {version}.')
        pnpm = shutil.which('pnpm.cmd' if os.name == 'nt' else 'pnpm', path=environment[path_key])
        if not pnpm:
            raise RuntimeError('pnpm must be available in the independent test runtime or PATH.')
        pnpm_version = run([pnpm, '--version'], environment=environment, directory=directory).stdout.strip()
        print(f'Installing bundle into a fresh temporary {version} web profile...', flush=True)
        run([node, str(dsh), 'plugin', '--profile', 'web', 'add', str(tarball)], environment=environment, directory=directory)
        config = run([node, str(dsh), '--profile', 'web', '--dump-config'], environment=environment, directory=directory)
        if 'dsh-team-hub' not in config.stdout:
            raise RuntimeError('The composed profile does not contain the plugin.')

        with (directory / 'hub.log').open('w') as log:
            hub = subprocess.Popen([sys.executable, '-m', 'teamhub', 'serve', '--demo', '--data-dir',
                                    str(directory / 'hub-data'), '--port', str(hub_port)],
                                   cwd=directory, env=environment, stdout=log, stderr=log)
            try:
                with httpx.Client(trust_env=False, timeout=2) as client:
                    for _ in range(100):
                        if hub.poll() is not None:
                            raise RuntimeError('The isolated Hub exited before its health check succeeded.')
                        try:
                            if client.get(environment['TEAMHUB_URL'] + '/api/v1/health').status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        time.sleep(.1)
                    else:
                        raise RuntimeError('The isolated Hub did not become healthy.')
                probe = run([node, str(PROJECT_ROOT / 'scripts/dsh-host-probe.mjs')],
                            environment=environment, directory=directory, timeout=60)
                summary_line = next((line for line in probe.stdout.splitlines() if line.startswith('TEAMHUB_HOST_SMOKE=')), None)
                if not summary_line:
                    raise RuntimeError('The host probe returned no verification summary.')
                summary = json.loads(summary_line.split('=', 1)[1])
                summary.update({
                    'dsh_version': version, 'node_version': node_version, 'pnpm_version': pnpm_version,
                    'platform': platform.system(), 'plugin_add': 'passed', 'dump_config': 'passed',
                    'plugin_sha256': hashlib.sha256(tarball.read_bytes()).hexdigest(),
                    'isolation': 'temporary DSH_HOME, DSH_AGENTS_HOME, Hub database and bridge state',
                })
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            finally:
                hub.terminate()
                try:
                    hub.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    hub.kill()
                    hub.wait()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(redact(str(error)), file=sys.stderr)
        raise SystemExit(1)
