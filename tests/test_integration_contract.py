from conftest import auth, success


def test_integration_contract_is_authenticated_and_versioned(api):
    assert api.get('/api/v1/integration/contract').status_code in (401, 403)
    result = success(api.get('/api/v1/integration/contract', headers=auth()))
    assert result['contract'] == 'agent-team-hub'
    assert result['version'] == 1
    assert result['local_adapter_protocol']['version'] == 1
    assert set(result['local_adapter_protocol']['kinds']) == {'board', 'executor'}
    assert result['semantics']['business_completion_requires_review'] is True
    assert result['semantics']['board_sync_direction'] == 'bidirectional-explicit-commands'
    assert result['semantics']['workflow_dependencies'] == 'directed-acyclic-graph'
    assert result['semantics']['rollback_invalidates_descendants'] is True
    assert result['semantics']['automatic_dispatch_requires_per_pipeline_opt_in'] is True
