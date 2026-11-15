"""在临时 DSH profile 验证页面插件安装、登记、回滚和重复执行。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, *, cwd, env, success=True):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=240)
    if (result.returncode == 0) != success:
        raise RuntimeError(f'命令退出码 {result.returncode}：{result.stdout[-2000:]} {result.stderr[-2000:]}')
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--pnpm-compat-dir', type=Path, required=True)
    parser.add_argument('--existing-package', type=Path, required=True)
    parser.add_argument('--panel-package', type=Path, required=True)
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve()
    node = runtime / 'node.exe'
    dsh = runtime / 'node_modules/@deepseek-ai/dsh/lib/bin.js'
    with tempfile.TemporaryDirectory(prefix='teamhub-panel-install-check-') as temporary:
        root = Path(temporary).resolve()
        if not root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError('隔离目录不在系统临时目录。')
        home, workbench, local = root / 'dsh', root / 'workbench', root / 'teamhub'
        (workbench / 'scripts').mkdir(parents=True)
        local.mkdir()
        shutil.copytree(args.pnpm_compat_dir.resolve(), local / 'pnpm-compat')
        (workbench / 'scripts/start-workbench.ps1').write_text(
            'param([switch]$NonInteractive)\nif ($env:TEST_FAIL_SYNC) { exit 7 }\nexit 0\n', encoding='utf-8')
        env = dict(os.environ, DSH_HOME=str(home), DSH_AGENTS_HOME=str(root / 'agents'),
                   DSH_TELEMETRY_DISABLED='1', PATH=str(runtime) + os.pathsep + os.environ.get('PATH', ''),
                   GIT_AUTHOR_NAME='Panel Test', GIT_AUTHOR_EMAIL='panel-test@example.invalid',
                   GIT_COMMITTER_NAME='Panel Test', GIT_COMMITTER_EMAIL='panel-test@example.invalid')
        run(['git', 'init', '-q'], cwd=workbench, env=env)
        (workbench / '.git/info/exclude').write_text('machine.local.json\n', encoding='utf-8')
        run(['git', 'add', 'scripts/start-workbench.ps1'], cwd=workbench, env=env)
        run(['git', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test fixture'], cwd=workbench, env=env)
        run([str(node), str(dsh), 'plugin', '--profile', 'web', 'add', str(args.existing_package.resolve())], cwd=root, env=env)
        profile = home / 'profiles/web'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        machine_path = workbench / 'machine.local.json'
        machine_path.write_text(json.dumps({'dshHome': str(home), 'profile': 'web', 'nodeExe': str(node),
            'webPort': port, 'workbenchRoot': str(workbench), 'pnpmCmd': str(local / 'pnpm-compat/pnpm.cmd'),
            'localProfile': {'version': 1, 'localBundles': ['dsh-team-hub'],
                             'localDependencies': ['dsh-team-hub'], 'preferSharedDependencies': []}}), encoding='utf-8')
        manifest = profile / 'package.json'
        original = {str(p): digest(p) for p in (machine_path, manifest, profile / 'pnpm-lock.yaml', profile / 'cordis.yml')}
        original_version = json.loads((profile / 'node_modules/dsh-team-hub/package.json').read_text(encoding='utf-8'))['version']
        command = ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                   str(ROOT / 'scripts/install-dsh-web-panel.ps1'), '-MachineFile', str(machine_path),
                   '-TeamHubHome', str(local), '-PackageFile', str(args.panel_package.resolve())]
        run(command, cwd=root, env=dict(env, TEST_FAIL_SYNC='1'), success=False)
        if (local / 'dsh-team-hub-web-0.1.0.tgz').exists() or any(digest(Path(p)) != value for p, value in original.items()):
            raise RuntimeError('同步失败时没有保持原 profile。')
        wrong = list(command)
        wrong[wrong.index('-PackageFile') + 1] = str(args.existing_package.resolve())
        rejected = run(wrong, cwd=root, env=env, success=False)
        if not (local / 'dsh-team-hub-web-0.1.0.tgz').is_file() or not (local / 'profile-backups').is_dir() \
                or any(digest(Path(p)) != value for p, value in original.items()):
            changes = [Path(p).name for p, value in original.items() if digest(Path(p)) != value]
            raise RuntimeError(f'安装失败回滚检查未完成（变化：{changes}）：{rejected.stderr[-1500:]}')
        if json.loads((profile / 'node_modules/dsh-team-hub/package.json').read_text(encoding='utf-8'))['version'] != original_version:
            raise RuntimeError('安装回滚改变了原工具插件。')
        (local / 'dsh-team-hub-web-0.1.0.tgz').unlink()
        run(command, cwd=root, env=env)
        installed = json.loads((profile / 'node_modules/dsh-team-hub-web/package.json').read_text(encoding='utf-8'))
        updated = json.loads(machine_path.read_text(encoding='utf-8-sig'))
        if installed['version'] != '0.1.0' or 'dsh-team-hub-web' not in updated['localProfile']['localBundles'] \
                or 'dsh-team-hub-web' not in updated['localProfile']['localDependencies']:
            raise RuntimeError('页面插件或严格模式登记不完整。')
        if json.loads((profile / 'node_modules/dsh-team-hub/package.json').read_text(encoding='utf-8'))['version'] != original_version:
            raise RuntimeError('安装改变了原工具插件。')
        final = {str(p): digest(p) for p in (machine_path, manifest)}
        run(command, cwd=root, env=env)
        if any(digest(Path(p)) != value for p, value in final.items()):
            raise RuntimeError('重复安装产生了改动。')
        print(json.dumps({'result': 'passed', 'sync_failure_guard': True, 'rollback': True,
                          'strict_profile_registration': True, 'existing_plugin_preserved': True,
                          'repeat_noop': True, 'production_modified': False}))


if __name__ == '__main__':
    main()
