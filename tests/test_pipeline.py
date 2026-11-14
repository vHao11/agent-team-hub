from __future__ import annotations

import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from conftest import assert_error, auth, operation, success
from teamhub.__main__ import backup
from teamhub.app import create_app


def definition():
    return {
        "roles": [
            {"key": "implementation", "label": "实施团队", "kind": "team"},
            {"key": "testing", "label": "测试团队", "kind": "team"},
            {"key": "reviewer", "label": "验收人", "kind": "reviewer"},
        ],
        "steps": [
            {"key": "implement", "name": "接口适配", "team_role": "implementation", "reviewer_role": "reviewer",
             "acceptance_spec": ["提交适配结果"], "required_artifact_kinds": ["report"]},
            {"key": "test", "name": "联调验证", "team_role": "testing", "reviewer_role": "reviewer",
             "acceptance_spec": ["提交联调结果"], "required_artifact_kinds": ["document"]},
        ],
    }


def published(api):
    draft = success(api.post('/api/v1/workflow-templates', headers=auth(), json={
        "operation_id": operation(), "name": "跨组接口改造", "definition": definition()}))
    validation = success(api.post(f"/api/v1/workflow-templates/{draft['id']}/validate", headers=auth()))
    assert validation["valid"]
    version = success(api.post(f"/api/v1/workflow-templates/{draft['id']}/publish", headers=auth(), json={
        "operation_id": operation(), "expected_revision": draft["draft_revision"]}))
    return draft, version


def new_pipeline(api, version, **overrides):
    body = {"operation_id": operation(), "title": "接口升级", "project_id": "proj-interface",
            "template_version_id": version["id"], "role_bindings": {"implementation": "team-clearing",
            "testing": "team-qa", "reviewer": "u-lin"}}
    body.update(overrides)
    return success(api.post('/api/v1/pipelines', headers=auth(), json=body))


def control(api, view, action, **overrides):
    return api.post(f"/api/v1/pipelines/{view['pipeline']['id']}/{action}", headers=auth(), json={
        "operation_id": operation(), "expected_version": view["pipeline"]["version"], **overrides})


def item_context(step, pipeline):
    return {"pipeline_attempt_id": step["attempt"]["id"], "pipeline_generation": pipeline["generation"]}


def item_command(api, step, pipeline, action, person, **kwargs):
    return api.post(f"/api/v1/work-items/{step['item']['id']}/{action}", headers=auth(person), json={
        "operation_id": operation(), "expected_version": step["item"]["version"],
        **item_context(step, pipeline), **kwargs})


def read_pipeline(api, view):
    return success(api.get(f"/api/v1/pipelines/{view['pipeline']['id']}", headers=auth()))


def submit_step(api, step, pipeline, person, kind):
    return api.post(f"/api/v1/work-items/{step['item']['id']}/deliveries", headers=auth(person), json={
        "operation_id": operation(), "expected_version": step["item"]["version"],
        "spec_revision": step["item"]["spec_revision"], "summary": "本轮交付",
        "artifacts": [{"label": "结果", "url": "https://example.com/result", "kind": kind}],
        **item_context(step, pipeline)})


def review_step(api, step, pipeline, delivery, decision="approve", **kwargs):
    return api.post(f"/api/v1/deliveries/{delivery['id']}/reviews", headers=auth(), json={
        "operation_id": operation(), "expected_version": step["item"]["version"], "decision": decision,
        **item_context(step, pipeline), **kwargs})


def test_template_versions_and_serial_cross_team_flow(api):
    draft, version1 = published(api)
    cloned = success(api.post(f"/api/v1/workflow-templates/{draft['id']}/clone", headers=auth(), json={"operation_id": operation()}))
    changed = definition()
    changed["steps"][0]["name"] = "新版适配"
    updated = success(api.put(f"/api/v1/workflow-templates/{draft['id']}", headers=auth(), json={
        "operation_id": operation(), "expected_revision": cloned["draft_revision"], "name": "跨组接口改造",
        "definition": changed}))
    version2 = success(api.post(f"/api/v1/workflow-templates/{draft['id']}/publish", headers=auth(), json={
        "operation_id": operation(), "expected_revision": updated["draft_revision"]}))
    assert version1["version"] == 1 and version2["version"] == 2

    view = new_pipeline(api, version1)
    assert view["steps"][0]["definition"]["name"] == "接口适配"
    assert all(step["state"] == "waiting" for step in view["steps"])
    start_id = operation()
    started = success(control(api, view, 'start', operation_id=start_id))
    replayed = success(control(api, view, 'start', operation_id=start_id))
    assert replayed["steps"][0]["item"]["id"] == started["steps"][0]["item"]["id"]
    step = started["steps"][0]
    assert step["item"]["owner_team_id"] == 'team-trading'
    assert step["item"]["pending_target_team_id"] == 'team-clearing'
    assert started["steps"][1]["item"] is None
    assert_error(api.post(f"/api/v1/work-items/{step['item']['id']}/accept", headers=auth('chen'), json={
        "operation_id": operation(), "expected_version": step["item"]["version"]}), 409, "PIPELINE_CONTEXT_REQUIRED")
    assert_error(item_command(api, step, started["pipeline"], 'accept', 'xu'), 403)
    success(item_command(api, step, started["pipeline"], 'accept', 'chen'))
    view = read_pipeline(api, started)
    assert view["steps"][0]["item"]["owner_team_id"] == 'team-clearing'
    success(item_command(api, view["steps"][0], view["pipeline"], 'start', 'chen'))
    view = read_pipeline(api, view)
    assert_error(submit_step(api, view["steps"][0], view["pipeline"], 'chen', 'document'), 422, 'REQUIRED_ARTIFACT_MISSING')
    first = success(submit_step(api, view["steps"][0], view["pipeline"], 'chen', 'report'))
    view = read_pipeline(api, view)
    old_step = view["steps"][0]
    success(review_step(api, old_step, view["pipeline"], first, 'request_changes', reason='补充测试'))
    view = read_pipeline(api, view)
    assert view["steps"][0]["attempt"]["ordinal"] == 2
    assert len(view["steps"][0]["attempts"]) == 2
    assert_error(submit_step(api, old_step, view["pipeline"], 'chen', 'report'), 409)
    second = success(submit_step(api, view["steps"][0], view["pipeline"], 'chen', 'report'))
    view = read_pipeline(api, view)
    assert_error(review_step(api, view["steps"][0], view["pipeline"], first), 409)
    success(review_step(api, view["steps"][0], view["pipeline"], second))
    view = read_pipeline(api, view)
    assert view["steps"][0]["state"] == 'completed'
    assert view["steps"][1]["state"] == 'awaiting_accept'
    assert view["steps"][1]["attempt"]["input_snapshot"]["upstream_deliveries"][0]["delivery_id"] == second["id"]
    success(item_command(api, view["steps"][1], view["pipeline"], 'accept', 'xu'))
    view = read_pipeline(api, view)
    success(item_command(api, view["steps"][1], view["pipeline"], 'start', 'xu'))
    view = read_pipeline(api, view)
    last = success(submit_step(api, view["steps"][1], view["pipeline"], 'xu', 'document'))
    view = read_pipeline(api, view)
    success(review_step(api, view["steps"][1], view["pipeline"], last))
    view = read_pipeline(api, view)
    assert view["pipeline"]["status"] == 'completed'
    detail = success(api.get(f"/api/v1/work-items/{view['steps'][0]['item']['id']}", headers=auth()))
    assert len(detail["deliveries"]) == 2 and len(detail["reviews"]) == 2


def test_template_validation_and_independent_review(api):
    bad = definition()
    bad["steps"][0]["team_role"] = "missing"
    draft = success(api.post('/api/v1/workflow-templates', headers=auth(), json={
        "operation_id": operation(), "name": "非法模板", "definition": bad}))
    assert not success(api.post(f"/api/v1/workflow-templates/{draft['id']}/validate", headers=auth()))["valid"]
    assert_error(api.post(f"/api/v1/workflow-templates/{draft['id']}/publish", headers=auth(), json={
        "operation_id": operation(), "expected_revision": draft["draft_revision"]}), 422, 'INVALID_WORKFLOW')
    _, version = published(api)
    view = new_pipeline(api, version, role_bindings={"implementation": "team-trading", "testing": "team-qa", "reviewer": "u-lin"})
    view = success(control(api, view, 'start'))
    assert_error(item_command(api, view["steps"][0], view["pipeline"], 'accept', 'lin'), 422, 'INDEPENDENT_REVIEW_REQUIRED')


def test_decline_reassign_and_pause(api):
    _, version = published(api)
    view = success(control(api, new_pipeline(api, version), 'start'))
    success(item_command(api, view["steps"][0], view["pipeline"], 'decline', 'chen', reason='请换团队'))
    view = read_pipeline(api, view)
    assert view["steps"][0]["state"] == 'declined'
    reassigned = success(api.post(f"/api/v1/pipelines/{view['pipeline']['id']}/steps/implement/reassign", headers=auth(), json={
        "operation_id": operation(), "expected_version": view["pipeline"]["version"], "target_team_id": "team-qa", "reason": "质量组接续"}))
    assert reassigned["steps"][0]["item"]["owner_team_id"] == 'team-trading'
    success(item_command(api, reassigned["steps"][0], reassigned["pipeline"], 'accept', 'xu'))
    view = read_pipeline(api, reassigned)
    view = success(control(api, view, 'pause'))
    assert_error(item_command(api, view["steps"][0], view["pipeline"], 'start', 'xu'), 409, 'PIPELINE_PAUSED')
    view = success(control(api, view, 'resume'))
    assert success(item_command(api, view["steps"][0], view["pipeline"], 'start', 'xu'))["status"] == 'active'


def test_paused_flow_does_not_activate_next_step_until_resume(api):
    _, version = published(api)
    view = success(control(api, new_pipeline(api, version), 'start'))
    success(item_command(api, view['steps'][0], view['pipeline'], 'accept', 'chen'))
    view = read_pipeline(api, view)
    success(item_command(api, view['steps'][0], view['pipeline'], 'start', 'chen'))
    view = read_pipeline(api, view)
    delivery = success(submit_step(api, view['steps'][0], view['pipeline'], 'chen', 'report'))
    view = read_pipeline(api, view)
    view = success(control(api, view, 'pause'))
    success(review_step(api, view['steps'][0], view['pipeline'], delivery))
    view = read_pipeline(api, view)
    assert view['pipeline']['status'] == 'paused'
    assert view['steps'][0]['state'] == 'completed' and view['steps'][1]['item'] is None
    view = success(control(api, view, 'resume'))
    assert view['steps'][1]['state'] == 'awaiting_accept'


def test_old_run_is_evidence_only_and_cannot_be_reused_in_new_attempt(api):
    _, version = published(api)
    view = success(control(api, new_pipeline(api, version), 'start'))
    success(item_command(api, view['steps'][0], view['pipeline'], 'accept', 'chen'))
    view = read_pipeline(api, view)
    step = view['steps'][0]
    run = success(api.post(f"/api/v1/work-items/{step['item']['id']}/runs", headers=auth('chen'), json={
        'operation_id': operation(), 'expected_version': step['item']['version'], 'client_instance_id': 'test-machine',
        'harness': 'test', 'workspace_ref': 'test', **item_context(step, view['pipeline'])}))
    assert run['pipeline_attempt_id'] == step['attempt']['id']
    success(api.post(f"/api/v1/runs/{run['id']}/events", headers=auth('chen'), json={
        'operation_id': operation(), 'client_instance_id': 'test-machine', 'sequence': 1, 'status': 'succeeded'}))
    view = read_pipeline(api, view)
    assert view['steps'][0]['state'] == 'working' and view['steps'][1]['item'] is None
    delivery = success(submit_step(api, view['steps'][0], view['pipeline'], 'chen', 'report'))
    view = read_pipeline(api, view)
    success(review_step(api, view['steps'][0], view['pipeline'], delivery, 'request_changes', reason='补充结果'))
    view = read_pipeline(api, view)
    step = view['steps'][0]
    response = api.post(f"/api/v1/work-items/{step['item']['id']}/deliveries", headers=auth('chen'), json={
        'operation_id': operation(), 'expected_version': step['item']['version'], 'spec_revision': step['item']['spec_revision'],
        'summary': '新轮结果', 'artifacts': [{'label': '报告', 'url': 'https://example.com/r', 'kind': 'report'}],
        'run_ids': [run['id']], **item_context(step, view['pipeline'])})
    assert_error(response, 409, 'STALE_PIPELINE_ATTEMPT')


def test_cancel_pipeline_requests_stop_and_late_result_cannot_resume(api):
    _, version = published(api)
    view = success(control(api, new_pipeline(api, version), 'start'))
    success(item_command(api, view['steps'][0], view['pipeline'], 'accept', 'chen'))
    view = read_pipeline(api, view)
    step = view['steps'][0]
    run = success(api.post(f"/api/v1/work-items/{step['item']['id']}/runs", headers=auth('chen'), json={
        'operation_id': operation(), 'expected_version': step['item']['version'], 'client_instance_id': 'test-machine',
        'harness': 'test', 'workspace_ref': 'test', **item_context(step, view['pipeline'])}))
    assert_error(control(api, view, 'cancel'), 409, 'VERSION_CONFLICT')
    view = read_pipeline(api, view)
    view = success(control(api, view, 'cancel'))
    assert view['pipeline']['status'] == 'cancelled' and view['steps'][0]['item']['status'] == 'cancelled'
    assert success(api.get(f"/api/v1/runs/{run['id']}", headers=auth()))['status'] == 'cancel_requested'
    success(api.post(f"/api/v1/runs/{run['id']}/events", headers=auth('chen'), json={
        'operation_id': operation(), 'client_instance_id': 'test-machine', 'sequence': 1, 'status': 'succeeded'}))
    view = read_pipeline(api, view)
    assert view['pipeline']['status'] == 'cancelled' and view['steps'][1]['item'] is None


def test_pending_team_can_bind_pipeline_board_and_terminal_context_remains_valid(api):
    _, version = published(api)
    view = success(control(api, new_pipeline(api, version), 'start'))
    step = view['steps'][0]
    body = {'operation_id': operation(), 'client_instance_id': 'board-test', 'harness': 'dsh-todo-kanban',
            'workspace_ref': 'example-workspace', 'local_todo_id': 'tb-20261114-0001',
            **item_context(step, view['pipeline'])}
    assert_error(api.post(f"/api/v1/work-items/{step['item']['id']}/bindings", headers=auth('xu'), json=body), 403, 'FORBIDDEN')
    bound = success(api.post(f"/api/v1/work-items/{step['item']['id']}/bindings", headers=auth('chen'), json=body))
    assert bound['local_todo_id'] == 'tb-20261114-0001'
    view = success(control(api, view, 'cancel'))
    stale = {**body, 'operation_id': operation()}
    assert_error(api.post(f"/api/v1/work-items/{step['item']['id']}/bindings", headers=auth(), json=stale), 409, 'PIPELINE_CONTEXT_REQUIRED')
    current = {**stale, 'operation_id': operation(), **item_context(view['steps'][0], view['pipeline'])}
    assert success(api.post(f"/api/v1/work-items/{step['item']['id']}/bindings", headers=auth(), json=current))['local_todo_id'] == body['local_todo_id']


def test_schema_v1_upgrade_preserves_data_and_backup(tmp_path):
    data_dir = tmp_path / 'legacy'
    data_dir.mkdir()
    (data_dir / 'artifacts').mkdir()
    (data_dir / 'artifacts' / 'legacy-artifact').write_bytes(b'legacy evidence')
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    conn.executescript((Path(__file__).parent / 'fixtures' / 'teamhub-v1-schema.sql').read_text(encoding='utf-8'))
    conn.execute('INSERT INTO schema_versions(version) VALUES (1)')
    conn.execute('INSERT INTO teams(id,name) VALUES (?,?)', ('old-team', '旧团队'))
    conn.execute('INSERT INTO users(id,name,team_id,role,token_hash,active) VALUES (?,?,?,?,?,?)',
                 ('old-user', '旧成员', 'old-team', 'admin', hashlib.sha256(b'old-token').hexdigest(), 1))
    conn.execute('INSERT INTO projects(id,name,description) VALUES (?,?,?)', ('old-project', '旧项目', '保留'))
    conn.execute('INSERT INTO artifacts(id,label,content_type,size,uploaded_by,created_at) VALUES (?,?,?,?,?,?)',
                 ('legacy-artifact', '旧附件', 'text/plain', 15, 'old-user', '2026-01-01T00:00:00Z'))
    conn.execute('''INSERT INTO work_items(id,number,title,description,project_id,requesting_team_id,requester_id,owner_team_id,
        pending_target_team_id,assignee_id,reviewer_id,status,priority,acceptance_spec,version,spec_revision,assignment_generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        ('old-item', 'TH-1001', '旧事项', '旧描述', 'old-project', 'old-team', 'old-user', 'old-team', None,
         'old-user', 'old-user', 'active', 'normal', json.dumps(['旧条件']), 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'))
    conn.commit()
    conn.close()
    archive = tmp_path / 'before-upgrade.zip'
    backup(data_dir, archive)
    with TestClient(create_app(data_dir)) as client:
        old_headers = {'Authorization': 'Bearer old-token'}
        detail = success(client.get('/api/v1/work-items/old-item', headers=old_headers))
        assert detail['item']['title'] == '旧事项' and detail['pipeline_context'] is None
        assert client.get('/api/v1/artifacts/legacy-artifact', headers=old_headers).content == b'legacy evidence'
        delivery = success(client.post('/api/v1/work-items/old-item/deliveries', headers=old_headers, json={
            'operation_id': operation(), 'expected_version': detail['item']['version'], 'spec_revision': 1,
            'summary': '旧事项继续交付', 'artifacts': [{'label': '旧附件', 'url': 'artifact://legacy-artifact'}]}))
        detail = success(client.get('/api/v1/work-items/old-item', headers=old_headers))
        reviewed = success(client.post(f"/api/v1/deliveries/{delivery['id']}/reviews", headers=old_headers, json={
            'operation_id': operation(), 'expected_version': detail['item']['version'], 'decision': 'approve'}))
        assert reviewed['status'] == 'done'
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    assert conn.execute('SELECT version FROM schema_versions').fetchall() == [(2,)]
    assert conn.execute('SELECT sha256 FROM artifacts WHERE id = ?', ('legacy-artifact',)).fetchone()[0] is None
    conn.close()
    restored = tmp_path / 'restore'
    with zipfile.ZipFile(archive) as source:
        source.extractall(restored)
    with TestClient(create_app(restored)) as client:
        assert success(client.get('/api/v1/work-items/old-item', headers={'Authorization': 'Bearer old-token'}))['item']['status'] == 'active'


def test_failed_migration_rolls_back_schema_changes(tmp_path):
    data_dir = tmp_path / 'broken-legacy'
    data_dir.mkdir()
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    conn.executescript((Path(__file__).parent / 'fixtures' / 'teamhub-v1-schema.sql').read_text(encoding='utf-8'))
    conn.execute('INSERT INTO schema_versions(version) VALUES (1)')
    conn.execute('DROP TABLE runs')
    conn.commit()
    conn.close()
    with pytest.raises(SQLAlchemyError):
        create_app(data_dir)
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    assert conn.execute('SELECT version FROM schema_versions').fetchall() == [(1,)]
    assert 'pipeline_attempt_id' not in {column[1] for column in conn.execute('PRAGMA table_info(deliveries)')}
    assert not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='pipelines'").fetchall()
    conn.close()


def test_future_schema_is_rejected_before_tables_are_created(tmp_path):
    data_dir = tmp_path / 'future'
    data_dir.mkdir()
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    conn.execute('CREATE TABLE schema_versions(version INTEGER PRIMARY KEY)')
    conn.execute('INSERT INTO schema_versions VALUES (999)')
    conn.commit()
    conn.close()
    try:
        create_app(data_dir)
    except RuntimeError as error:
        assert 'Unsupported database schema' in str(error)
    else:
        raise AssertionError('Future schema unexpectedly accepted')
    conn = sqlite3.connect(data_dir / 'teamhub.db')
    assert conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [('schema_versions',)]
    conn.close()
