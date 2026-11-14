"""Exercise the version-specific profile upgrader in an isolated DSH_HOME."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, *, cwd, env, success=True):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=240)
    if (result.returncode == 0) != success:
        raise RuntimeError(f'Unexpected exit {result.returncode}: {result.stdout[-3000:]} {result.stderr[-3000:]}')
    return result


def digest(path):
    return hashlib.sha256(path.read_bytes()).digest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--old-plugin-dir', type=Path, required=True)
    parser.add_argument('--pnpm-compat-dir', type=Path, required=True)
    parser.add_argument('--new-package', type=Path, required=True)
    parser.add_argument('--old-version', default='0.1.0-workbench.3bd3d820')
    parser.add_argument('--new-version', default='0.2.0')
    args = parser.parse_args()
    runtime, old_plugin = args.runtime_dir.resolve(), args.old_plugin_dir.resolve()
    if json.loads((old_plugin / 'package.json').read_text(encoding='utf-8'))['version'] != args.old_version:
        raise RuntimeError('Unexpected old plugin version')
    node, dsh = runtime / 'node.exe', runtime / 'node_modules/@deepseek-ai/dsh/lib/bin.js'
    npm = runtime / 'node_modules/npm/bin/npm-cli.js'
    with tempfile.TemporaryDirectory(prefix='teamhub-profile-upgrade-') as temporary:
        root = Path(temporary).resolve()
        if not root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise RuntimeError('Isolation directory is outside the temporary directory')
        home, packages, workbench = root / 'dsh', root / 'packages', root / 'workbench'
        local = root / 'local-teamhub'
        for directory in (packages, workbench, local):
            directory.mkdir()
        shutil.copytree(args.pnpm_compat_dir.resolve(), local / 'pnpm-compat')
        (local / 'admin-token.txt').write_text('synthetic-token', encoding='utf-8')
        env = dict(os.environ, DSH_HOME=str(home), DSH_AGENTS_HOME=str(root / 'agents'),
                   DSH_TELEMETRY_DISABLED='1', PATH=str(runtime) + os.pathsep + os.environ.get('PATH', ''))
        run(['git', 'init', '-q'], cwd=workbench, env=env)
        run([str(node), str(npm), 'pack', '--ignore-scripts', '--pack-destination', str(packages)], cwd=old_plugin, env=env)
        old_package = next(packages.glob('dsh-team-hub-*.tgz'))
        run([str(node), str(dsh), 'plugin', '--profile', 'web', 'add', str(old_package)], cwd=root, env=env)
        profile = home / 'profiles/web'
        package_json = profile / 'package.json'
        installed = profile / 'node_modules/dsh-team-hub/package.json'
        before = digest(package_json)
        profile_files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml']
        def profile_snapshot():
            return {name: digest(profile / name) if (profile / name).is_file() else None for name in profile_files}
        original_profile = profile_snapshot()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            machine = {'dshHome': str(home), 'profile': 'web', 'nodeExe': str(node), 'webPort': port,
                       'workbenchRoot': str(workbench), 'pnpmCmd': str(local / 'pnpm-compat/pnpm.cmd'),
                       'localProfile': {'version': 1, 'localBundles': ['dsh-team-hub'], 'localDependencies': ['dsh-team-hub']}}
            machine_file = root / 'machine.local.json'
            machine_file.write_text(json.dumps(machine), encoding='utf-8')
            command = ['powershell.exe', '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                       str(ROOT / 'scripts/upgrade-dsh-profile-stage2.ps1'), '-MachineFile', str(machine_file),
                       '-PackageFile', str(args.new_package.resolve()), '-TeamHubHome', str(local),
                       '-CurrentVersion', args.old_version, '-TargetVersion', args.new_version]
            running = run(command, cwd=root, env=env, success=False)
            if 'DSH 仍在运行' not in running.stderr:
                raise RuntimeError('Running-profile guard did not report the expected reason')
            if digest(package_json) != before:
                raise RuntimeError('Running-profile guard changed the profile')
        dirty = workbench / 'untracked.txt'
        dirty.write_text('synthetic', encoding='utf-8')
        blocked = run(command, cwd=root, env=env, success=False)
        if '工作台状态不干净' not in blocked.stderr:
            raise RuntimeError('Dirty-workbench guard did not report the expected reason')
        if digest(package_json) != before:
            raise RuntimeError('Dirty-workbench guard changed the profile')
        dirty.unlink()
        wrong_version = list(command)
        wrong_version[wrong_version.index('-CurrentVersion') + 1] = '9.9.9'
        refused = run(wrong_version, cwd=root, env=env, success=False)
        if '检测到非预期的 Team Hub 版本' not in refused.stderr or profile_snapshot() != original_profile:
            raise RuntimeError('Unexpected current version was not rejected without changes')
        bad_command = list(command)
        bad_command[bad_command.index('-PackageFile') + 1] = str(old_package)
        failed = run(bad_command, cwd=root, env=env, success=False)
        if '安装后的插件版本不正确' not in failed.stderr:
            raise RuntimeError('Rollback test did not reach the installed-version check')
        if profile_snapshot() != original_profile or json.loads(installed.read_text(encoding='utf-8'))['version'] != args.old_version:
            raise RuntimeError('Failed installation did not restore the old profile')
        run(command, cwd=root, env=env)
        if json.loads(installed.read_text(encoding='utf-8'))['version'] != args.new_version:
            raise RuntimeError('Expected plugin version was not installed')
        after = digest(package_json)
        run(command, cwd=root, env=env)
        if digest(package_json) != after:
            raise RuntimeError('Repeat installation changed the profile')
        backups = list((local / 'profile-backups').glob('*/package.json'))
        if not backups or all(digest(value) != before for value in backups):
            raise RuntimeError('Original profile backup was not retained')
        print(json.dumps({'result': 'passed', 'running_guard': True, 'dirty_guard': True, 'version_guard': True, 'failed_install_rollback': True,
                          'upgrade': True, 'repeat_noop': True, 'profile_backup': True, 'production_modified': False}))


if __name__ == '__main__':
    main()
