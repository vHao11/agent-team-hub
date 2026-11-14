"""隔离演示 Hub，验证明确授权的真实本机 Superagent 执行。"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--superagent-url', required=True, help='已运行的本机回环 Superagent 地址')
    parser.add_argument('--allow-live-superagent', action='store_true', help='允许创建一条明确标记的真实只读验收工单')
    args = parser.parse_args()
    if not args.allow_live_superagent:
        raise RuntimeError('此验证会创建真实只读验收工单，需显式传入 --allow-live-superagent。')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('需要 Node.js。')
    directory = Path(tempfile.mkdtemp(prefix='teamhub-live-superagent-evidence-')).resolve()
    if not directory.is_relative_to(Path(tempfile.gettempdir()).resolve()):
        raise RuntimeError('验证目录必须在系统临时目录内。')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('TEAMHUB_')}
    env.update(PYTHONPATH=str(ROOT / 'server'), TEAMHUB_ISOLATED_URL=f'http://127.0.0.1:{port}',
               TEAMHUB_ISOLATED_STATE=str(directory / 'bridge'), TEAMHUB_SUPERAGENT_URL=args.superagent_url,
               TEAMHUB_ALLOW_LIVE_SUPERAGENT='1')
    print(f'隔离验证数据保留在 {directory}', flush=True)
    with (directory / 'hub.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen([sys.executable, '-m', 'teamhub', 'serve', '--demo', '--host', '127.0.0.1',
                                    '--port', str(port), '--data-dir', str(directory / 'hub')],
                                   cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(trust_env=False, timeout=2) as client:
                for _ in range(100):
                    if process.poll() is not None:
                        raise RuntimeError('隔离 Hub 启动失败。')
                    try:
                        if client.get(env['TEAMHUB_ISOLATED_URL'] + '/api/v1/health').is_success:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.1)
                else:
                    raise RuntimeError('隔离 Hub 健康检查超时。')
            result = subprocess.run([node, str(ROOT / 'scripts/verify-live-superagent.mjs')],
                                    cwd=ROOT, env=env, timeout=240)
            if result.returncode:
                raise RuntimeError(f'真实 Superagent 验收未通过（退出码 {result.returncode}）；隔离证据已保留。')
        finally:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
