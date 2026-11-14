from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import signal
import socket

import pytest
from dotenv import dotenv_values

spec = spec_from_file_location('install_support', Path(__file__).parents[1] / 'scripts/install_support.py')
support = module_from_spec(spec)
spec.loader.exec_module(support)


def test_dotenv_update_preserves_other_bindings_and_is_idempotent(tmp_path):
    path = tmp_path / '.env'
    initial = b'# private settings\r\nOTHER="line one\r\nTEAMHUB_TOKEN=inside another value\r\nline three"\r\nexport TEAMHUB_TOKEN=old\r\nTEAMHUB_TOKEN=duplicate\r\nUNCHANGED=x # keep\r\n'
    path.write_bytes(initial)
    result = support.update_environment(path, {'TEAMHUB_URL': 'http://127.0.0.1:8765', 'TEAMHUB_TOKEN': 'new#token"with\\quotes'})
    assert Path(result['backup']).read_bytes() == initial
    current = path.read_bytes()
    assert b'OTHER="line one\r\nTEAMHUB_TOKEN=inside another value\r\nline three"' in current
    assert b'UNCHANGED=x # keep\r\n' in current
    parsed = dotenv_values(path, interpolate=False)
    assert parsed['TEAMHUB_TOKEN'] == 'new#token"with\\quotes'
    assert parsed['TEAMHUB_URL'] == 'http://127.0.0.1:8765'
    assert support.update_environment(path, {'TEAMHUB_URL': parsed['TEAMHUB_URL'], 'TEAMHUB_TOKEN': parsed['TEAMHUB_TOKEN']})['changed'] is False


def test_invalid_dotenv_is_not_overwritten(tmp_path):
    path = tmp_path / '.env'
    original = b'OTHER="unterminated\n'
    path.write_bytes(original)
    with pytest.raises(RuntimeError):
        support.update_environment(path, {'TEAMHUB_TOKEN': 'value'})
    assert path.read_bytes() == original


def test_formal_install_reuses_identity_without_exposing_token(tmp_path, monkeypatch):
    monkeypatch.delenv('TEAMHUB_INSTALL_TOKEN', raising=False)
    monkeypatch.delenv('TEAMHUB_TOKEN', raising=False)
    first = support.prepare(tmp_path, 8765, False)
    credentials = json.loads((tmp_path / 'install-connection.json').read_text())
    assert credentials['token'] not in json.dumps(first)
    second = support.prepare(tmp_path, 8765, False)
    assert second['user_id'] == first['user_id']
    assert json.loads((tmp_path / 'install-connection.json').read_text())['token'] == credentials['token']
    (tmp_path / 'install-connection.json').unlink()
    with pytest.raises(RuntimeError, match='already exists'):
        support.prepare(tmp_path, 8765, False)
    monkeypatch.setenv('TEAMHUB_INSTALL_TOKEN', credentials['token'])
    assert support.prepare(tmp_path, 8765, False)['user_id'] == first['user_id']


def test_mode_mismatch_and_invalid_credential_do_not_reset_workspace(tmp_path, monkeypatch):
    result = support.prepare(tmp_path, 8765, False)
    monkeypatch.setenv('TEAMHUB_INSTALL_TOKEN', 'invalid-token')
    with pytest.raises(RuntimeError, match='does not match'):
        support.prepare(tmp_path, 8765, False)
    with pytest.raises(RuntimeError):
        support.prepare(tmp_path, 8765, True)
    monkeypatch.delenv('TEAMHUB_INSTALL_TOKEN')
    assert support.prepare(tmp_path, 8765, False)['user_id'] == result['user_id']


def test_installer_starts_reuses_and_authenticates_real_hub_before_env_write(tmp_path, monkeypatch):
    monkeypatch.delenv('TEAMHUB_INSTALL_TOKEN', raising=False)
    monkeypatch.delenv('TEAMHUB_TOKEN', raising=False)
    with socket.socket() as available:
        available.bind(('127.0.0.1', 0))
        port = available.getsockname()[1]
    workspace = tmp_path / '协作 空间'
    support.prepare(workspace, port, False)
    started = support.start_service(workspace, port)
    try:
        assert started['service'] == 'started'
        assert support.start_service(workspace, port)['service'] == 'reused'
        dsh_home = tmp_path / 'dsh'
        dsh_home.mkdir()
        env = dsh_home / '.env'
        env.write_text('KEEP_EXISTING=unchanged\n', encoding='utf-8')
        assert support.configure(workspace, dsh_home)['changed']
        values = dotenv_values(env)
        assert values['KEEP_EXISTING'] == 'unchanged'
        assert values['TEAMHUB_URL'] == f'http://127.0.0.1:{port}'
        connection_file = workspace / 'install-connection.json'
        connection = json.loads(connection_file.read_text(encoding='utf-8'))
        assert values['TEAMHUB_TOKEN'] == connection['token']
        existing = env.read_bytes()
        connection['token'] = 'invalid'
        connection_file.write_text(json.dumps(connection))
        with pytest.raises(RuntimeError, match='verification failed'):
            support.configure(workspace, dsh_home)
        assert env.read_bytes() == existing
    finally:
        try:
            os.kill(started['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
