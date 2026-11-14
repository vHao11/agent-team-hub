"""验证源码发行包不会混入本机状态和旧构建产物。"""
import importlib.util
import json
from pathlib import Path
import sys
import zipfile


def test_source_release_excludes_local_state_and_stale_packages(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / 'scripts' / 'package_release.py'
    spec = importlib.util.spec_from_file_location('package_release_test', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / 'source'
    files = {
        'pyproject.toml': '[project]\nversion = "0.2.0"\n',
        'README.md': '# 示例\n',
        'web/dist/index.html': '<!doctype html>',
        'web/src/main.tsx': '// 源码\n',
        'packages/dsh-plugin/dist/dsh-team-hub-0.1.0.tgz': '旧插件包',
        'packages/cli/dist/agent-team-hub-cli-0.1.0.tgz': '旧客户端包',
        'tests/state.sqlite': '本地数据库',
        'tests/state.sqlite-wal': '本地数据库日志',
        'scripts/debug.log': '本地日志',
        'scripts/.env.local': '本地配置',
    }
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
    output = tmp_path / 'release.zip'
    monkeypatch.setattr(module, 'ROOT', root)
    monkeypatch.setattr(sys, 'argv', ['package_release.py', '--output', str(output)])

    module.main()

    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        assert archive.testzip() is None
        assert 'agent-team-hub/web/dist/index.html' in names
        assert 'agent-team-hub/web/src/main.tsx' in names
        assert not any(name.endswith(('.tgz', '.sqlite', '.sqlite-wal', '.log', '.env.local')) for name in names)
        manifest = json.loads(archive.read('agent-team-hub/RELEASE.json'))
        assert manifest['version'] == '0.2.0'
