"""向不同宿主公开的稳定接入能力描述。"""


def integration_contract():
    return {
        'contract': 'agent-team-hub',
        'version': 1,
        'http_api': '/api/v1',
        'business_transports': ['http', 'mcp-stdio', 'cli', 'dsh-tools'],
        'local_adapter_protocol': {
            'name': 'agent-team-hub-adapter',
            'version': 1,
            'transport': 'json-rpc-2.0-stdio-single-request',
            'kinds': ['board', 'executor'],
            'board_methods': ['adapter.describe', 'board.upsert', 'board.detach_pipeline'],
            'executor_methods': ['adapter.describe', 'execution.start', 'execution.status', 'execution.find', 'execution.cancel'],
        },
        'run_statuses': ['queued', 'starting', 'running', 'waiting_input', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown'],
        'semantics': {
            'business_completion_requires_review': True,
            'external_execution_requires_explicit_start': True,
            'cancellation_requires_confirmation': True,
            'unknown_execution_blocks_duplicate_start': True,
            'board_sync_direction': 'hub-to-board',
        },
    }
