"""Real official MCP client -> stdio child -> authenticated HTTP stub contract tests."""
from __future__ import annotations

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from urllib.parse import parse_qs, urlsplit

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
from teamhub.mcp_server import build_server  # noqa: E402


def test_stdio_transport_to_authenticated_http():
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append({"method": "GET", "path": self.path, "auth": self.headers.get("Authorization")})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"items": [], "total": 0, "limit": 20, "offset": 0}).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            received.append({"method": "POST", "path": self.path, "auth": self.headers.get("Authorization"), "body": body})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"id": "w1", "version": 2, "status": "accepted"}).encode())

        def log_message(self, *_):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    env = {**os.environ, "PYTHONPATH": str(ROOT / "server"), "TEAMHUB_URL": f"http://127.0.0.1:{httpd.server_port}", "TEAMHUB_TOKEN": "test-only-token"}
    env.pop("TEAMHUB_CONNECTION_FILE", None)

    async def exercise():
        parameters = StdioServerParameters(command=sys.executable, args=["-m", "teamhub.mcp_server"], env=env)
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                tools = (await session.list_tools()).tools
                names = {tool.name for tool in tools}
                assert len(names) >= 47
                assert {"ledger_search", "ledger_accept", "ledger_submit", "ledger_review", "catalog_resolve",
                        "hub_bind_session", "hub_run_register", "hub_run_report", "catalog_publish_release",
                        "team_toolset_set", "artifact_upload_text", "artifact_read_text", "hub_run_cancel",
                        "workflow_template_create", "pipeline_create", "pipeline_step_submit", "pipeline_step_review"} <= names
                by_name = {tool.name: tool for tool in tools}
                assert by_name["artifact_upload_text"].annotations.idempotentHint is False
                assert by_name["artifact_read_text"].annotations.readOnlyHint is True
                result = await session.call_tool("ledger_search", {"view": "mine", "q": "interface"})
                assert result.isError is False
                result = await session.call_tool("ledger_accept", {"work_item_id": "w1", "operation_id": "mcp-claim-1", "expected_version": 1})
                assert result.isError is False
                result = await session.call_tool("hub_bind_session", {"work_item_id": "w1", "operation_id": "mcp-bind-1", "client_instance_id": "machine-1", "harness": "generic", "workspace_ref": "/work", "session_id": "known-session"})
                assert result.isError is False
                result = await session.call_tool("hub_run_report", {"run_id": "run-1", "operation_id": "mcp-report-1", "client_instance_id": "machine-1", "sequence": 1, "status": "running"})
                assert result.isError is False
                result = await session.call_tool("ledger_progress", {"work_item_id": "w1", "operation_id": "mcp-progress-1", "expected_version": 2, "summary": "Checking"})
                assert result.isError is False
                count = len(received)
                invalid = await session.call_tool("ledger_accept", {"work_item_id": "w1", "operation_id": "mcp-claim-2"})
                assert invalid.isError is True
                assert len(received) == count

    try:
        asyncio.run(exercise())
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)
    assert all(entry["auth"] == "Bearer test-only-token" for entry in received)
    query = parse_qs(urlsplit(received[0]["path"]).query)
    assert query == {"view": ["mine"], "q": ["interface"], "limit": ["20"], "offset": ["0"]}
    assert received[1]["body"] == {"operation_id": "mcp-claim-1", "expected_version": 1}
    assert received[2]["body"]["session_id"] == "known-session"
    assert "local_todo_id" not in received[2]["body"]
    assert "external_session_id" not in received[3]["body"]
    assert "summary" not in received[3]["body"]
    assert "blocked_reason" not in received[4]["body"]


def test_missing_token_fails_without_stdout_protocol_noise():
    env = {**os.environ, "PYTHONPATH": str(ROOT / "server")}
    env.pop("TEAMHUB_TOKEN", None)
    env.pop("TEAMHUB_CONNECTION_FILE", None)
    result = subprocess.run([sys.executable, "-m", "teamhub.mcp_server"], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert result.stdout == ""
    assert "TEAMHUB_TOKEN is required" in result.stderr


def test_mcp_rejects_embedded_url_credentials():
    try:
        build_server(url="https://name:secret@example.org")
    except ValueError as error:
        assert "secret" not in str(error)
    else:
        raise AssertionError("URL credentials were accepted")
