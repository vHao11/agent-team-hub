"""Run the stage-2 launcher using an isolated demo workspace and port."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--expected-version', default='0.2.0')
    parser.add_argument('--require-contract', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='teamhub-launcher-check-') as temporary:
        root = Path(temporary).resolve()
        command = ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                   str(ROOT / 'scripts/start-teamhub-stage2.ps1'), '-TeamHubHome', str(root),
                   '-PythonPath', str(args.python.resolve()), '-DataDir', str(root / 'demo'), '-ExpectedVersion', args.expected_version, '-Demo']
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            occupied = listener.getsockname()[1]
            blocked = subprocess.run(command + ['-Port', str(occupied)], capture_output=True, timeout=30,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            reason = blocked.stderr.decode('utf-8', errors='replace') + blocked.stderr.decode('gbk', errors='replace')
            if blocked.returncode == 0 or (root / 'demo').exists() or '端口仍被占用' not in reason:
                raise RuntimeError('An occupied port was not rejected before creating data')
        with socket.socket() as unused:
            unused.bind(('127.0.0.1', 0))
            port = unused.getsockname()[1]
        output_path = root / 'launcher-output.log'
        output = output_path.open('wb')
        process = subprocess.Popen(command + ['-Port', str(port)], stdout=output, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for _ in range(200):
                if process.poll() is not None:
                    raise RuntimeError('Candidate launcher exited before becoming healthy: ' +
                                       output_path.read_text(encoding='utf-8', errors='replace')[-3000:])
                try:
                    with opener.open(f'http://127.0.0.1:{port}/api/v1/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            else:
                raise RuntimeError('Candidate launcher did not become healthy')
            with opener.open(f'http://127.0.0.1:{port}/openapi.json', timeout=5) as response:
                api = json.load(response)
            if '/api/v1/pipelines' not in api['paths'] or api['info']['version'] != args.expected_version:
                raise RuntimeError('Candidate server is not the expected pipeline-capable version')
            if args.require_contract:
                request = urllib.request.Request(f'http://127.0.0.1:{port}/api/v1/integration/contract',
                                                 headers={'Authorization': 'Bearer demo-lin'})
                with opener.open(request, timeout=5) as response:
                    if json.load(response)['local_adapter_protocol']['version'] != 1:
                        raise RuntimeError('Candidate integration contract is not version 1')
        finally:
            # Terminate only the process tree created for this isolated test.
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            process.wait(timeout=10)
            output.close()
        print(json.dumps({'result': 'passed', 'occupied_port_guard': True, 'installed_server': args.expected_version,
                          'pipeline_api': True, 'integration_contract': args.require_contract, 'production_modified': False}))


if __name__ == '__main__':
    main()
