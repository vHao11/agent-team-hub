"""Create one clearly labelled live verification pipeline with resumable operation IDs."""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import uuid

import httpx


def save(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', type=Path, required=True)
    args = parser.parse_args()
    record = args.record.resolve()
    expected_root = (Path.home() / '.dsh/teamhub/backups').resolve()
    if not record.is_relative_to(expected_root) or not record.parent.is_dir():
        raise RuntimeError('Validation record must be inside the private backup directory')
    token = (Path.home() / '.dsh/teamhub/admin-token.txt').read_text(encoding='utf-8-sig').strip()
    with httpx.Client(base_url='http://127.0.0.1:8765/api/v1', headers={'Authorization': 'Bearer ' + token},
                      trust_env=False, timeout=15) as client:
        def call(method, url, data=None):
            response = client.request(method, url, json=data)
            response.raise_for_status()
            return response.json()
        context = call('GET', '/bootstrap')
        if context.get('demo_mode') or context['me']['role'] != 'admin' or len(context['projects']) != 1:
            raise RuntimeError('Unexpected live identity or project state; no probe created')
        if record.exists():
            state = json.loads(record.read_text(encoding='utf-8'))
            if state.get('actor_id') != context['me']['id']:
                raise RuntimeError('The validation record belongs to a different identity')
        else:
            state = {'run_id': uuid.uuid4().hex, 'actor_id': context['me']['id'], 'team_id': context['me']['team_id'],
                     'project_id': context['projects'][0]['id'], 'title': '【系统验收测试】DSH 看板同步 ' + datetime.now().strftime('%Y-%m-%d %H:%M')}
            save(record, state)
        op = lambda name: 'stage2-live-' + state['run_id'] + '-' + name
        definition = {'roles': [{'key': 'team', 'label': '验收测试组', 'kind': 'team'},
                                {'key': 'reviewer', 'label': '验收测试人', 'kind': 'reviewer'}],
                      'steps': [{'key': 'check', 'name': '关联与状态验证', 'team_role': 'team', 'reviewer_role': 'reviewer',
                                 'acceptance_spec': ['系统集成验收测试，不代表真实业务交付'], 'required_artifact_kinds': ['document']}]}
        if 'template_id' not in state:
            created = call('POST', '/workflow-templates', {'operation_id': op('template'), 'name': state['title'],
                'description': '系统验收测试模板，不用于真实业务。', 'definition': definition})
            state['template_id'], state['revision'] = created['id'], created['draft_revision']
            save(record, state)
        if 'template_version_id' not in state:
            published = call('POST', f"/workflow-templates/{state['template_id']}/publish",
                             {'operation_id': op('publish'), 'expected_revision': state['revision']})
            state['template_version_id'] = published['id']
            save(record, state)
        if 'pipeline_id' not in state:
            created = call('POST', '/pipelines', {'operation_id': op('pipeline'), 'title': state['title'],
                'description': '系统集成验收；不派单，不自动验收；测试后取消。', 'project_id': state['project_id'],
                'template_version_id': state['template_version_id'],
                'role_bindings': {'team': state['team_id'], 'reviewer': state['actor_id']}})
            state['pipeline_id'], state['initial_version'] = created['pipeline']['id'], created['pipeline']['version']
            save(record, state)
        if 'item_id' not in state:
            started = call('POST', f"/pipelines/{state['pipeline_id']}/start",
                           {'operation_id': op('start'), 'expected_version': state['initial_version']})
            state['item_id'] = started['steps'][0]['item']['id']
            save(record, state)
        view = call('GET', f"/pipelines/{state['pipeline_id']}")
        print(json.dumps({'pipeline_id': state['pipeline_id'], 'item_id': state['item_id'],
                          'status': view['pipeline']['status'], 'is_test': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
