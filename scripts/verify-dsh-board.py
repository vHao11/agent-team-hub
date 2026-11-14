"""在临时 DSH_HOME 中验证真实 DSH、看板和 Hub 的跨组双向关联。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def redact(value):
    return re.sub(r'token=[^\s"&]+', 'token=<redacted>', value, flags=re.IGNORECASE)


def run(command, *, env, cwd, timeout=180):
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=timeout)
    if result.returncode:
        raise RuntimeError(redact(f'命令失败 ({result.returncode})：\n{result.stdout[-5000:]}\n{result.stderr[-5000:]}'))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True, help='已有 DSH 运行时目录，包含 node_modules')
    parser.add_argument('--kanban-dir', type=Path, required=True, help='已构建的 dsh-todo-kanban 源码目录')
    parser.add_argument('--playwright-entry', type=Path, required=True, help='已有 Playwright 入口')
    parser.add_argument('--chrome', type=Path, required=True, help='Chrome 可执行文件')
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve()
    board = args.kanban_dir.resolve()
    dsh = runtime / 'node_modules' / '@deepseek-ai' / 'dsh' / 'lib' / 'bin.js'
    node = shutil.which('node')
    if not node or not dsh.is_file() or not (board / 'src/index.js').is_file() or not (board / 'lib/client.js').is_file():
        raise RuntimeError('缺少 Node、DSH 或已构建的看板源码。')
    npm_cli = Path(node).resolve().parent / 'node_modules/npm/bin/npm-cli.js'
    if not npm_cli.is_file():
        raise RuntimeError('找不到 Node 旁边的 npm-cli.js。')
    allowed = {'path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec', 'pathext', 'tmp', 'temp',
               'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'lang', 'lc_all'}
    environment = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    evidence = Path(tempfile.mkdtemp(prefix='teamhub-dsh-stage2-evidence-')).resolve()
    with tempfile.TemporaryDirectory(prefix='teamhub-dsh-stage2-') as temporary:
        directory = Path(temporary).resolve()
        if not directory.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError('隔离目录必须位于系统临时目录。')
        packages = directory / 'packages'
        packages.mkdir()
        hub_port, dsh_port = free_port(), free_port()
        while hub_port == dsh_port:
            dsh_port = free_port()
        environment.update({
            'DSH_HOME': str(directory / 'dsh-home'), 'DSH_AGENTS_HOME': str(directory / 'agents'),
            'DSH_TELEMETRY_DISABLED': '1', 'DSH_SMOKE_PORT': str(dsh_port), 'DSH_SMOKE_RUNTIME_DIR': str(runtime),
            'TEAMHUB_URL': f'http://127.0.0.1:{hub_port}', 'TEAMHUB_TOKEN': 'demo-lin',
            'TEAMHUB_STATE_DIR': str(directory / 'bridge'), 'TEAMHUB_PLAYWRIGHT_ENTRY': str(args.playwright_entry.resolve()),
            'TEAMHUB_CHROME': str(args.chrome.resolve()), 'TEAMHUB_EVIDENCE_DIR': str(evidence),
            'PYTHONPATH': str(ROOT / 'server'),
        })
        external_state = directory / 'portable-board.json'
        external_config = directory / 'portable-adapters.json'
        external_config.write_text(json.dumps({'schema_version': 1, 'adapters': [{
            'name': 'portable-board', 'kind': 'board', 'command': sys.executable,
            'args': [str(ROOT / 'examples/adapters/local-json-board.py'), str(external_state), 'portable-board'],
        }]}), encoding='utf-8')
        environment['TEAMHUB_EXTERNAL_ADAPTER_CONFIG'] = str(external_config)
        environment['TEAMHUB_EXTERNAL_BOARD_STATE'] = str(external_state)
        version = run([node, str(dsh), '--version'], env=environment, cwd=directory).stdout.strip()
        print(f'正在隔离环境验证 DSH {version} 与看板源码……', flush=True)
        for package in (ROOT / 'packages/dsh-plugin', board):
            run([node, str(npm_cli), 'pack', '--ignore-scripts', '--pack-destination', str(packages)],
                env=environment, cwd=package)
        for pattern in ('dsh-team-hub-*.tgz', 'dsh-todo-kanban-*.tgz'):
            artifact = next(packages.glob(pattern))
            run([node, str(dsh), 'plugin', '--profile', 'web', 'add', str(artifact)], env=environment, cwd=directory, timeout=300)
        with (directory / 'hub.log').open('w', encoding='utf-8') as log:
            hub = subprocess.Popen([sys.executable, '-m', 'teamhub', 'serve', '--demo', '--data-dir',
                                    str(directory / 'hub-data'), '--port', str(hub_port)], cwd=directory,
                                   env=environment, stdout=log, stderr=log)
            try:
                with httpx.Client(trust_env=False, timeout=2) as client:
                    for _ in range(100):
                        if hub.poll() is not None:
                            raise RuntimeError('隔离 Hub 未能启动。')
                        try:
                            if client.get(environment['TEAMHUB_URL'] + '/api/v1/health').status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        time.sleep(.1)
                    else:
                        raise RuntimeError('隔离 Hub 健康检查超时。')
                result = run([node, str(ROOT / 'scripts/dsh-board-probe.mjs')], env=environment, cwd=directory, timeout=120)
                line = next((value for value in result.stdout.splitlines() if value.startswith('TEAMHUB_DSH_BOARD=')), None)
                if not line:
                    raise RuntimeError('隔离宿主未返回业务验证结果。')
                summary = json.loads(line.split('=', 1)[1])
                summary.update({'dsh_version': version, 'evidence_dir': str(evidence), 'isolation': '临时 DSH_HOME、Hub 和看板数据'})
                print(json.dumps(summary, ensure_ascii=False, indent=2))
            finally:
                hub.terminate()
                try:
                    hub.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    hub.kill()
                    hub.wait()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(redact(str(error)), file=sys.stderr)
        raise SystemExit(1)
