"""机器可读协议与跨语言示例使用相同的 v1 消息。"""
import json
from pathlib import Path
import subprocess
import sys

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / 'packages/client/schemas'


def load(name):
    value = json.loads((SCHEMAS / name).read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(value)
    return value


def test_config_and_description_schemas_match_the_reference_adapter(tmp_path):
    config = load('adapter-config-v1.schema.json')
    description = load('adapter-description-v1.schema.json')
    wire = load('adapter-wire-v1.schema.json')
    example = json.loads((ROOT / 'examples/adapters/stdio-board.example.json').read_text(encoding='utf-8'))
    Draft202012Validator(config).validate(example)
    request = {'jsonrpc': '2.0', 'id': 'probe-1', 'method': 'adapter.describe', 'params': {}}
    Draft202012Validator(wire).validate(request)
    output = subprocess.run([sys.executable, str(ROOT / 'examples/adapters/local-json-board.py'),
                             str(tmp_path / 'board.json'), 'local-json-board'],
                            input=json.dumps(request).encode('utf-8') + b'\n', capture_output=True, check=True)
    response = json.loads(output.stdout)
    Draft202012Validator(wire).validate(response)
    Draft202012Validator(description).validate(response['result'])
    assert response['id'] == request['id'] and response['result']['capabilities']['pipeline_sync'] is True

    bad = {**response, 'error': {'code': -32603, 'message': 'bad'}}
    assert list(Draft202012Validator(wire).iter_errors(bad))
    unsupported = {**response['result'], 'protocol_version': 2}
    assert list(Draft202012Validator(description).iter_errors(unsupported))


def test_wire_schema_requires_a_stable_execution_handle():
    wire = load('adapter-wire-v1.schema.json')
    validator = Draft202012Validator(wire)
    request = {'jsonrpc': '2.0', 'id': '1', 'method': 'execution.cancel', 'params': {'handle': {}}}
    assert list(validator.iter_errors(request))
    request['params']['handle']['run_id'] = 'external-run-1'
    validator.validate(request)


def test_installed_capability_requires_version_identity_and_file_hashes():
    validator = Draft202012Validator(load('adapter-wire-v1.schema.json'))
    capability = {'capability_id': 'cap-1', 'release_id': 'rel-1', 'version': '1.0.0', 'kind': 'skill',
                  'slug': 'example', 'directory': '/workspace/.teamhub-runs/dispatch/capabilities/cap-1',
                  'entry': 'SKILL.md', 'manifest_sha256': 'a' * 64, 'files': [{'path': 'SKILL.md', 'sha256': 'b' * 64}]}
    params = {'item_id': 'item', 'run_id': 'run', 'dispatch_id': 'dispatch', 'workspace_ref': '/workspace',
              'input_snapshot': {}, 'capability_releases': [], 'installed_capabilities': [capability],
              'spec_revision': 1, 'assignment_generation': 1}
    request = {'jsonrpc': '2.0', 'id': '1', 'method': 'execution.start', 'params': params}
    validator.validate(request)
    capability['files'][0]['sha256'] = 'invalid'
    assert list(validator.iter_errors(request))
