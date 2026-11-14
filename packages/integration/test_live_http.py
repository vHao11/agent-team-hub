"""CLI + official MCP stdio against a real, isolated FastAPI/SQLite service."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time

import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
from teamhub.app import create_app  # noqa: E402


def test_cli_mcp_delivery_and_fixed_tool_release(tmp_path):
    node = shutil.which("node")
    assert node, "Node is required for this integration test"
    app = create_app(tmp_path / "hub", demo=True)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert server.started, "Test HTTP server did not start"
    inherited = {key: value for key, value in os.environ.items() if not key.startswith("TEAMHUB_")}
    env = {**inherited, "TEAMHUB_URL": f"http://127.0.0.1:{port}", "TEAMHUB_STATE_DIR": str(tmp_path / "client"),
           "TEAMHUB_PYTHON": sys.executable, "PYTHONPATH": str(ROOT / "server")}

    def cli(token, *args, data=None):
        command = [node, str(ROOT / "packages/cli/bin/teamhub.mjs"), *args]
        if data is not None:
            command += ["--data", json.dumps(data, ensure_ascii=False)]
        result = subprocess.run(command, cwd=ROOT, env={**env, "TEAMHUB_TOKEN": token}, capture_output=True, text=True, encoding="utf-8", timeout=30)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    async def mcp_progress(item_id, expected_version, capability_id):
        parameters = StdioServerParameters(command=sys.executable, args=["-m", "teamhub.mcp_server"], env={**env, "TEAMHUB_TOKEN": "demo-chen"})
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                count = len((await session.list_tools()).tools)
                assert count >= 47
                progress = await session.call_tool("ledger_progress", {"work_item_id": item_id, "operation_id": "live-mcp-progress",
                    "expected_version": expected_version, "summary": "Official MCP stdio confirms script execution evidence."})
                assert not progress.isError, progress
                release = await session.call_tool("catalog_resolve", {"capability_id": capability_id, "version": "0.1.0"})
                assert not release.isError, release
                return count

    async def mcp_read_artifacts(attachments):
        # The reviewer's MCP process reads the assignee's CLI-uploaded bytes.
        parameters = StdioServerParameters(command=sys.executable, args=["-m", "teamhub.mcp_server"], env={**env, "TEAMHUB_TOKEN": "demo-lin"})
        async with stdio_client(parameters) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                for artifact, expected_text, expected_type in attachments:
                    assert artifact["content_type"] == expected_type
                    result = await session.call_tool("artifact_read_text", {"artifact_id": artifact["id"]})
                    assert not result.isError, result
                    payload = result.structuredContent
                    if payload is None:
                        payload = json.loads(next(block.text for block in result.content if block.type == "text"))
                    assert payload["content"] == expected_text
                    assert payload["content_type"] == expected_type
                    assert payload["size"] == len(expected_text.encode("utf-8"))

    try:
        assert cli("demo-lin", "whoami")["me"]["id"] == "u-lin"
        item = cli("demo-lin", "items", "create", "--operation-id", "live-create", data={
            "title": "CLI and MCP integration smoke", "project_id": "proj-interface", "target_team_id": "team-clearing",
            "acceptance_spec": ["Run pinned log summary and attach the result"],
        })
        item = cli("demo-chen", "items", "accept", item["id"], "--version", str(item["version"]), "--operation-id", "live-accept")
        run = cli("demo-chen", "runs", "register", item["id"], "--version", str(item["version"]), "--operation-id", "live-run", data={
            "harness": "integration-smoke", "workspace_ref": str(tmp_path), "external_session_id": "smoke-session",
        })
        assert run["input_snapshot"]["title"] == item["title"]
        assert all(release["version"] == "0.1.0" for release in run["capability_releases"])
        cli("demo-chen", "runs", "report", run["id"], "--operation-id", "live-running", data={"sequence": 1, "status": "running"})
        catalog = cli("demo-chen", "tools", "list")["items"]
        capability = next(value for value in catalog if value["slug"] == "clearing/log-summary")
        installed = tmp_path / "tools" / "log-summary" / "0.1.0"
        cli("demo-chen", "tools", "install", capability["id"], "--version", "0.1.0", "--directory", str(installed))
        script = cli("demo-chen", "tools", "run", str(installed), "--", "--file", str(installed / "sample.jsonl"))
        assert script["status"] == "succeeded"
        summary = json.loads(script["stdout"])
        assert summary["levels"] == {"ERROR": 1, "INFO": 2, "WARN": 1}
        cli("demo-chen", "runs", "report", run["id"], "--operation-id", "live-succeeded", data={
            "sequence": 2, "status": "succeeded", "summary": "Pinned script exit code 0; JSONL summary checked.",
        })
        detail = cli("demo-chen", "items", "get", item["id"])
        assert detail["item"]["status"] == "active", "Successful execution must not approve a work item"
        mcp_count = asyncio.run(mcp_progress(item["id"], detail["item"]["version"], capability["id"]))
        report = tmp_path / "report.JSON"
        report_text = json.dumps(summary)
        report.write_text(report_text, encoding="utf-8")
        artifact = cli("demo-chen", "artifacts", "upload", str(report))
        assert artifact["url"].startswith("artifact://")
        markdown = tmp_path / "验收说明.md"
        markdown_text = "# 日志检查报告\n\n已核验 INFO=2、WARN=1、ERROR=1。\n"
        markdown.write_text(markdown_text, encoding="utf-8", newline="")
        markdown_artifact = cli("demo-chen", "artifacts", "upload", str(markdown))
        asyncio.run(mcp_read_artifacts([
            (artifact, report_text, "application/json"),
            (markdown_artifact, markdown_text, "text/markdown"),
        ]))
        item = cli("demo-chen", "items", "get", item["id"])["item"]
        delivery = cli("demo-chen", "items", "submit", item["id"], "--version", str(item["version"]), "--operation-id", "live-delivery", data={
            "spec_revision": item["spec_revision"], "summary": "Checked JSONL aggregation with a pinned script.",
            "artifacts": [{"label": value["label"], "url": value["url"]} for value in (artifact, markdown_artifact)], "run_ids": [run["id"]],
        })
        review = cli("demo-lin", "items", "get", item["id"])["item"]
        assert review["status"] == "review"
        final = cli("demo-lin", "reviews", "approve", delivery["id"], "--version", str(review["version"]), "--operation-id", "live-approve")
        assert final["status"] == "done"
        print("LIVE_SMOKE_RESULT " + json.dumps({"status": "passed", "flow": "create/accept/register-run/install/run/report/MCP-progress/CLI-upload/MCP-read/submit/approve",
            "mcp_tools": mcp_count, "pinned_version": "0.1.0", "script_levels": summary["levels"],
            "work_item_status_after_run": "active", "work_item_status_after_review": final["status"]}))
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive(), "Test HTTP service did not shut down"
