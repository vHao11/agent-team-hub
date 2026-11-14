"""Verify real Hub-to-DSH synchronization using the labelled live probe."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import time
import uuid
from urllib.parse import urlparse

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', type=Path, required=True)
    args = parser.parse_args()
    record = args.record.resolve()
    if not record.is_relative_to((Path.home() / '.dsh/teamhub/backups').resolve()):
        raise RuntimeError('Validation record must be in the private backup directory')
    state = json.loads(record.read_text(encoding='utf-8'))
    if not state.get('local_todo_id') or not state.get('title', '').startswith('【系统验收测试】'):
        raise RuntimeError('The record does not describe a linked, labelled test pipeline')
    latest = json.loads((Path.home() / '.dsh/logs/web-3080-network/latest.json').read_text(encoding='utf-8-sig'))
    log = Path(latest['stdout']).read_text(encoding='utf-8', errors='replace')
    match = re.search(r'^dsh web:\s+(https?://\S+)', log, re.MULTILINE)
    if not match:
        raise RuntimeError('No authenticated local DSH URL found')
    url = match.group(1)
    parsed = urlparse(url)
    if parsed.hostname != '127.0.0.1' or parsed.port != 3080:
        raise RuntimeError('Unexpected DSH address')
    token = (Path.home() / '.dsh/teamhub/admin-token.txt').read_text(encoding='utf-8-sig').strip()
    def save():
        temporary = record.with_name(record.name + '.' + uuid.uuid4().hex + '.tmp')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, record)
    with httpx.Client(trust_env=False, follow_redirects=True, timeout=5) as client:
        client.get(url).raise_for_status()
        headers = {'Authorization': 'Bearer ' + token}
        base = 'http://127.0.0.1:8765/api/v1'
        def get_pipeline():
            response = client.get(base + '/pipelines/' + state['pipeline_id'], headers=headers)
            response.raise_for_status()
            return response.json()
        def control(action):
            versions = state.setdefault('operation_versions', {})
            if action not in versions:
                versions[action] = get_pipeline()['pipeline']['version']
                save()
            response = client.post(base + '/pipelines/' + state['pipeline_id'] + '/' + action, headers=headers,
                json={'operation_id': 'stage2-live-' + state['run_id'] + '-' + action,
                      'expected_version': versions[action]})
            response.raise_for_status()
        def wait_for(lane, pipeline_status, item_status):
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                response = client.get('http://127.0.0.1:3080/todo-kanban/api/board')
                response.raise_for_status()
                board = response.json()
                matches = [(column, card) for column, cards in board['columns'].items() for card in cards
                           if (card.get('hub') or {}).get('pipelineId') == state['pipeline_id']]
                if len(matches) == 1:
                    column, card = matches[0]
                    hub = card['hub']
                    if (column == lane and card['id'] == state['local_todo_id'] and hub['pipelineStatus'] == pipeline_status
                            and hub['status'] == item_status and (board.get('hubSync') or {}).get('state') == 'synced'):
                        return
                time.sleep(.5)
            raise RuntimeError('Automatic board synchronization did not reach ' + pipeline_status)
        for action, expected, lane, item in [('pause', 'paused', 'waiting', 'open'),
                                             ('resume', 'active', 'todo', 'open'),
                                             ('cancel', 'cancelled', 'dropped', 'cancelled')]:
            if action in state.get('verified_actions', []):
                continue
            control(action)
            wait_for(lane, expected, item)
            state.setdefault('verified_actions', []).append(action)
            save()
            print(json.dumps({'action': action, 'pipeline_status': expected, 'board_column': lane, 'automatic': True}), flush=True)
        state['sync_verified'] = True
        state['final_status'] = 'cancelled'
        save()


if __name__ == '__main__':
    main()
