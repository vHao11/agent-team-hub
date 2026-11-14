"""验证升级前备份覆盖桥接订阅并可在候选版本恢复。"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

from teamhub.app import create_app

ROOT = Path(__file__).resolve().parents[1]


def test_backup_includes_bridge_state_and_validates_candidate(tmp_path):
    hub, dsh, bridge = tmp_path / 'hub', tmp_path / 'dsh', tmp_path / 'bridge'
    app = create_app(hub / 'data', demo=True)
    app.state.database.close()
    board = dsh / 'state/todo-kanban/board.json'
    board.parent.mkdir(parents=True)
    board.write_text('{}', encoding='utf-8')
    superagent = dsh / 'state/superagent/orchestrator.sqlite'
    superagent.parent.mkdir(parents=True)
    with sqlite3.connect(superagent) as connection:
        connection.execute('CREATE TABLE synthetic (id INTEGER PRIMARY KEY)')
    profile = dsh / 'profiles/web'
    profile.mkdir(parents=True)
    (profile / 'package.json').write_text('{}', encoding='utf-8')
    (bridge / 'pipeline-board').mkdir(parents=True)
    (bridge / 'pipeline-board' / 'subscription.json').write_text('{"synthetic": true}', encoding='utf-8')
    machine = tmp_path / 'machine.json'
    machine.write_text(json.dumps({'dshHome': str(dsh), 'profile': 'web'}), encoding='utf-8')
    command = [sys.executable, str(ROOT / 'scripts/backup_stage2_local.py'), '--hub-home', str(hub), '--dsh-home', str(dsh),
               '--machine-file', str(machine), '--candidate-python', sys.executable, '--source-python', sys.executable,
               '--bridge-state-dir', str(bridge), '--label', 'adapter-test']
    env = {**os.environ, 'PYTHONPATH': str(ROOT / 'server')}
    result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf-8', timeout=30, check=True)
    backup = Path(json.loads(result.stdout)['backup_dir'])
    manifest = json.loads((backup / 'backup-manifest.json').read_text(encoding='utf-8'))
    assert 'bridge-state/pipeline-board/subscription.json' in manifest['files']
    assert (backup / 'bridge-state/pipeline-board/subscription.json').read_text(encoding='utf-8') == '{"synthetic": true}'
    assert manifest['hub_restore_migration'] == 'passed'
