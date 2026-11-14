from __future__ import annotations

import copy

import pytest

from conftest import assert_error, auth, operation, success
from test_pipeline import control, definition, item_command, item_context, new_pipeline, read_pipeline, review_step, submit_step


def parallel_definition():
    value = definition()
    first, second = value["steps"]
    first["depends_on"] = []
    second["depends_on"] = []
    value["steps"].append({"key": "join", "name": "汇合验收", "team_role": "testing",
                           "reviewer_role": "reviewer", "acceptance_spec": ["汇总两个分支"],
                           "required_artifact_kinds": ["document"], "depends_on": ["implement", "test"]})
    return value


def publish(api, value):
    draft = success(api.post('/api/v1/workflow-templates', headers=auth(), json={
        "operation_id": operation(), "name": "并行流程", "definition": value}))
    validation = success(api.post(f"/api/v1/workflow-templates/{draft['id']}/validate", headers=auth()))
    assert validation["valid"], validation
    return success(api.post(f"/api/v1/workflow-templates/{draft['id']}/publish", headers=auth(), json={
        "operation_id": operation(), "expected_revision": draft["draft_revision"]}))


def complete_step(api, view, index, person, kind):
    success(item_command(api, view["steps"][index], view["pipeline"], 'accept', person))
    view = read_pipeline(api, view)
    success(item_command(api, view["steps"][index], view["pipeline"], 'start', person))
    view = read_pipeline(api, view)
    delivery = success(submit_step(api, view["steps"][index], view["pipeline"], person, kind))
    view = read_pipeline(api, view)
    success(review_step(api, view["steps"][index], view["pipeline"], delivery))
    return read_pipeline(api, view), delivery


@pytest.mark.parametrize('parents', [['missing'], ['implement'], ['test', 'test'], ['join']])
def test_invalid_dependency_graph_cannot_be_published(api, parents):
    value = parallel_definition()
    value['steps'][0]['depends_on'] = parents
    draft = success(api.post('/api/v1/workflow-templates', headers=auth(), json={
        'operation_id': operation(), 'name': '非法依赖', 'definition': value}))
    assert not success(api.post(f"/api/v1/workflow-templates/{draft['id']}/validate", headers=auth()))['valid']
    assert_error(api.post(f"/api/v1/workflow-templates/{draft['id']}/publish", headers=auth(), json={
        'operation_id': operation(), 'expected_revision': draft['draft_revision']}), 422, 'INVALID_WORKFLOW')


def test_parallel_join_and_cross_step_rollback_preserve_independent_branch(api):
    version = publish(api, parallel_definition())
    view = success(control(api, new_pipeline(api, version), 'start'))
    assert [step['state'] for step in view['steps']] == ['awaiting_accept', 'awaiting_accept', 'waiting']
    view, first = complete_step(api, view, 0, 'chen', 'report')
    assert view['steps'][2]['item'] is None
    view, second = complete_step(api, view, 1, 'xu', 'document')
    assert view['steps'][2]['state'] == 'awaiting_accept'
    sources = view['steps'][2]['attempt']['input_snapshot']['upstream_deliveries']
    assert {source['delivery_id'] for source in sources} == {first['id'], second['id']}
    view, _ = complete_step(api, view, 2, 'xu', 'document')
    assert view['pipeline']['status'] == 'completed'
    old = copy.deepcopy(view)
    operation_id = operation()
    body = {'operation_id': operation_id, 'expected_version': view['pipeline']['version'], 'reason': '补充实施'}
    path = f"/api/v1/pipelines/{view['pipeline']['id']}/steps/implement/rollback"
    assert_error(api.post(path, headers=auth('xu'), json=body), 403, 'FORBIDDEN')
    view = success(api.post(path, headers=auth(), json=body))
    assert success(api.post(path, headers=auth(), json=body)) == view
    assert view['pipeline']['status'] == 'active'
    assert view['pipeline']['generation'] == old['pipeline']['generation'] + 1
    assert view['steps'][0]['attempt']['ordinal'] == 2
    assert view['steps'][0]['item']['id'] != old['steps'][0]['item']['id']
    assert view['steps'][1]['item']['id'] == old['steps'][1]['item']['id']
    assert view['steps'][1]['state'] == 'completed'
    assert view['steps'][2]['item'] is None and len(view['steps'][2]['attempts']) == 1
    stale = success(api.get(f"/api/v1/work-items/{old['steps'][0]['item']['id']}", headers=auth()))
    assert not stale['pipeline_context']['current'] and not stale['allowed_actions']
    view, new_first = complete_step(api, view, 0, 'chen', 'report')
    assert view['steps'][2]['attempt']['ordinal'] == 2
    sources = view['steps'][2]['attempt']['input_snapshot']['upstream_deliveries']
    assert {source['delivery_id'] for source in sources} == {new_first['id'], second['id']}
    view, _ = complete_step(api, view, 2, 'xu', 'document')
    assert view['pipeline']['status'] == 'completed'


def test_rollback_rejects_live_execution_without_changing_flow(api):
    view = success(control(api, new_pipeline(api, publish(api, parallel_definition())), 'start'))
    success(item_command(api, view['steps'][0], view['pipeline'], 'accept', 'chen'))
    view = read_pipeline(api, view)
    step = view['steps'][0]
    success(api.post(f"/api/v1/work-items/{step['item']['id']}/runs", headers=auth('chen'), json={
        'operation_id': operation(), 'expected_version': step['item']['version'], 'client_instance_id': 'test-machine',
        'harness': 'test', 'workspace_ref': 'test', **item_context(step, view['pipeline'])}))
    view = read_pipeline(api, view)
    response = api.post(f"/api/v1/pipelines/{view['pipeline']['id']}/steps/implement/rollback", headers=auth(), json={
        'operation_id': operation(), 'expected_version': view['pipeline']['version'], 'reason': '回退'})
    assert_error(response, 409, 'RUN_NOT_FINISHED')
    assert read_pipeline(api, view) == view
