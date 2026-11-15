from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

import pytest

from teamhub.connection import load_connection, validate_url
from teamhub.harness_config import render_config


def test_connection_file_keeps_identity_and_endpoint_together(tmp_path, monkeypatch):
    filename = tmp_path / "中文 项目" / "connection.json"
    filename.parent.mkdir()
    filename.write_text('\ufeff' + json.dumps({"url": "http://127.0.0.1:9876/api/v1/", "token": "file-personal-token"}), encoding="utf-8")
    monkeypatch.setenv("TEAMHUB_URL", "https://stale.example.invalid")
    monkeypatch.setenv("TEAMHUB_TOKEN", "old-identity")
    monkeypatch.setenv("TEAMHUB_CONNECTION_FILE", str(filename))
    assert load_connection() == ("http://127.0.0.1:9876", "file-personal-token")
    filename.write_text('{"token":"private-secret", "url":', encoding="utf-8")
    with pytest.raises(ValueError) as caught:
        load_connection()
    assert "private-secret" not in str(caught.value)
    assert "connection file" in str(caught.value)


@pytest.mark.parametrize("harness", ["claude-code", "codex", "opencode", "opencode-v1", "generic"])
def test_host_configuration_with_connection_file_is_parseable_and_token_free(harness, monkeypatch):
    monkeypatch.setenv("TEAMHUB_TOKEN", "must-not-appear-in-generated-files")
    executable = r"D:\团队 项目\hub\.venv\Scripts\python.exe"
    filename = r"D:\团队 项目\hub\.teamhub\install-connection.json"
    rendered = render_config(harness, python=executable, connection_file=filename)
    assert "must-not-appear" not in rendered
    parsed = tomllib.loads(rendered) if harness == "codex" else json.loads(rendered)
    if harness == "codex":
        server = parsed["mcp_servers"]["agent-team-hub"]
    elif harness == "opencode":
        server = parsed["mcp"]["servers"]["agent-team-hub"]
    elif harness == "opencode-v1":
        server = parsed["mcp"]["agent-team-hub"]
    else:
        server = parsed["mcpServers"]["agent-team-hub"]
    argv = server["command"] if isinstance(server["command"], list) else [server["command"], *server["args"]]
    assert argv == [executable, "-m", "teamhub.mcp_server", "--connection-file", filename]


def test_environment_configs_use_host_syntax_and_do_not_capture_secrets(monkeypatch):
    monkeypatch.setenv("TEAMHUB_TOKEN", "must-not-appear-in-generated-files")
    claude = json.loads(render_config("claude-code"))["mcpServers"]["agent-team-hub"]
    codex = tomllib.loads(render_config("codex"))["mcp_servers"]["agent-team-hub"]
    opencode = json.loads(render_config("opencode"))["mcp"]["servers"]["agent-team-hub"]
    assert claude["env"]["TEAMHUB_TOKEN"] == "${TEAMHUB_TOKEN}"
    assert codex["env_vars"] == ["TEAMHUB_TOKEN"]
    assert opencode["environment"]["TEAMHUB_TOKEN"] == "{env:TEAMHUB_TOKEN}"
    for target in ("claude-code", "codex", "opencode"):
        assert "must-not-appear" not in render_config(target)
    with pytest.raises(ValueError, match="connection-file"):
        render_config("generic")


@pytest.mark.parametrize("harness", ["claude-code", "codex", "opencode", "opencode-v1", "generic"])
def test_host_configuration_passes_explicit_ca_with_connection_file(harness):
    ca = r"D:\团队 项目\trust\company-ca.pem"
    rendered = render_config(harness, python=r"D:\hub\python.exe",
                             connection_file=r"D:\hub\connection.json", ca_file=ca)
    parsed = tomllib.loads(rendered) if harness == "codex" else json.loads(rendered)
    if harness == "codex":
        env = parsed["mcp_servers"]["agent-team-hub"]["env"]
    elif harness == "opencode":
        env = parsed["mcp"]["servers"]["agent-team-hub"]["environment"]
    elif harness == "opencode-v1":
        env = parsed["mcp"]["agent-team-hub"]["environment"]
    else:
        env = parsed["mcpServers"]["agent-team-hub"]["env"]
    assert env == {"TEAMHUB_CA_FILE": ca}


def test_config_output_refuses_to_replace_an_existing_host_file(tmp_path):
    destination = tmp_path / ".mcp.json"
    existing = '{"mcpServers":{"existing":{"command":"unchanged"}}}'
    destination.write_text(existing, encoding="utf-8")
    result = subprocess.run([sys.executable, "-m", "teamhub.harness_config", "--harness", "claude-code",
                             "--output", str(destination)], capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert result.stdout == ""
    assert destination.read_text(encoding="utf-8") == existing


@pytest.mark.parametrize("value", ["https://user:secret@example.org", "file:///tmp/db", "http://localhost:bad", "http://localhost?q=token", "http://local host"])
def test_invalid_url_never_echoes_credentials(value):
    with pytest.raises(ValueError) as caught:
        validate_url(value)
    assert "secret" not in str(caught.value)
