"""Generic MCP clients complete collaboration using only the public MCP tools.

These are official SDK clients, not tests of a particular agent harness or model.
The HTTP service, SQLite database, stdio subprocesses and attachment bytes are real.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import threading
import time

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import pytest
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
from teamhub.app import create_app  # noqa: E402


@pytest.fixture
def live_hub(tmp_path):
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
    assert server.started, "Test HTTP service did not start"
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive(), "Test HTTP service did not shut down"


@asynccontextmanager
async def mcp_session(base_url, token, connection_file=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith("TEAMHUB_")}
    env.update(PYTHONPATH=str(ROOT / "server"), TEAMHUB_URL=base_url, TEAMHUB_TOKEN=token)
    arguments = ["-m", "teamhub.mcp_server"]
    if connection_file is not None:
        connection_file.write_text(json.dumps({"url": base_url, "token": token}), encoding="utf-8")
        # The host can omit token inheritance entirely; the private file supplies it.
        env["TEAMHUB_URL"] = "http://127.0.0.1:1"
        env.pop("TEAMHUB_TOKEN", None)
        arguments += ["--connection-file", str(connection_file)]
    parameters = StdioServerParameters(command=sys.executable, args=arguments, env=env)
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            yield session


async def call(session, tool_name, **arguments):
    result = await session.call_tool(tool_name, arguments)
    assert not result.isError, result
    if result.structuredContent is not None:
        return result.structuredContent
    return json.loads(next(block.text for block in result.content if block.type == "text"))


async def error(session, tool_name, code, **arguments):
    result = await session.call_tool(tool_name, arguments)
    assert result.isError, result
    text = "\n".join(block.text for block in result.content if block.type == "text")
    assert code in text, text


def test_mcp_only_delivery_review_and_shared_toolset(live_hub, tmp_path):
    async def exercise():
        connection = tmp_path / "个人连接 with spaces.json"
        async with mcp_session(live_hub, "demo-lin", connection) as requester:
            async with mcp_session(live_hub, "demo-chen") as assignee:
                tools = (await requester.list_tools()).tools
                assert len(tools) >= 47
                assert (await call(requester, "hub_context"))["me"]["id"] == "u-lin"
                contract = await call(requester, "hub_integration_contract")
                assert contract["version"] == 1 and contract["local_adapter_protocol"]["version"] == 1
                capability = await call(assignee, "catalog_publish", operation_id="mcp-capability",
                    slug="clearing/mcp-checklist", name="MCP 测试交付清单", kind="skill", tags=["test"])
                release = await call(assignee, "catalog_publish_release", capability_id=capability["id"],
                    operation_id="mcp-release", version="1.0.0",
                    manifest={"kind": "skill", "version": "1.0.0", "entry": "SKILL.md"},
                    files={"SKILL.md": "# 测试清单\n\n读取验收条件，整理交付报告。\n"})
                detail = await call(requester, "catalog_get", capability_id=capability["id"])
                assert detail["releases"][0]["id"] == release["id"]
                toolset = await call(requester, "team_toolset_get", team_id="team-clearing")
                choices = [{"capability_id": capability["id"], "version": "1.0.0"}]
                await error(assignee, "team_toolset_set", "FORBIDDEN", team_id="team-clearing",
                    operation_id="mcp-toolset-denied", expected_version=toolset["version"], items=choices)
                await call(requester, "team_toolset_set", team_id="team-clearing", operation_id="mcp-toolset",
                    expected_version=toolset["version"], items=choices)
                create = dict(operation_id="mcp-create", title="MCP 独立协作闭环", project_id="proj-interface",
                    target_team_id="team-clearing", description="保留这份说明", acceptance_spec=["提交可读报告"],
                    priority="high", due_at="2026-12-31T18:00:00+08:00")
                item = await call(requester, "ledger_create", **create)
                assert (await call(requester, "ledger_create", **create))["id"] == item["id"]
                assert item["priority"] == "high" and item["due_at"] == create["due_at"]
                item = await call(requester, "ledger_update_spec", work_item_id=item["id"],
                    operation_id="mcp-spec", expected_version=item["version"],
                    acceptance_spec=["提交可读报告", "引用固定工具版本"], reason="补充版本证据")
                assert item["description"] == create["description"] and item["spec_revision"] == 2
                item = await call(assignee, "ledger_accept", work_item_id=item["id"],
                    operation_id="mcp-accept", expected_version=item["version"])
                await call(assignee, "hub_bind_session", work_item_id=item["id"], operation_id="mcp-bind",
                    client_instance_id="mcp-test-client", harness="sdk-integration-test",
                    workspace_ref=str(tmp_path), session_id="explicit-test-session")
                run = await call(assignee, "hub_run_register", work_item_id=item["id"], operation_id="mcp-run",
                    expected_version=item["version"], client_instance_id="mcp-test-client",
                    harness="sdk-integration-test", workspace_ref=str(tmp_path))
                assert run["capability_releases"][0]["release_id"] == release["id"]
                await call(assignee, "hub_run_report", run_id=run["id"], operation_id="mcp-running",
                    client_instance_id="mcp-test-client", sequence=1, status="running")
                resolved = await call(assignee, "catalog_resolve", capability_id=capability["id"], version="1.0.0")
                assert resolved["files"]["SKILL.md"] == release["files"]["SKILL.md"]
                await call(assignee, "hub_run_report", run_id=run["id"], operation_id="mcp-success",
                    client_instance_id="mcp-test-client", sequence=2, status="succeeded",
                    summary="MCP test retrieved and checked the fixed-version checklist")
                item = (await call(assignee, "ledger_get", work_item_id=item["id"]))["item"]
                assert item["status"] == "active", "Run success must not approve the business item"
                report = "# 交付报告\n\n已核对固定版本 1.0.0 的清单。\n"
                artifact = await call(assignee, "artifact_upload_text", filename="交付报告.md", content=report,
                    content_type="text/markdown")
                assert artifact["url"] == f"artifact://{artifact['id']}"
                delivery = await call(assignee, "ledger_submit", work_item_id=item["id"],
                    operation_id="mcp-delivery", expected_version=item["version"], spec_revision=item["spec_revision"],
                    summary="测试报告已提交", artifacts=[{"label": artifact["label"], "url": artifact["url"]}],
                    run_ids=[run["id"]])
                item = (await call(requester, "ledger_get", work_item_id=item["id"]))["item"]
                readback = await call(requester, "artifact_read_text", artifact_id=artifact["id"])
                assert readback["content"] == report and readback["size"] == len(report.encode())
                await error(assignee, "ledger_review", "FORBIDDEN", delivery_id=delivery["id"],
                    operation_id="mcp-review-denied", expected_version=item["version"], decision="approve")
                await error(requester, "ledger_review", "VERSION_CONFLICT", delivery_id=delivery["id"],
                    operation_id="mcp-review-stale", expected_version=item["version"] - 1, decision="approve")
                final = await call(requester, "ledger_review", delivery_id=delivery["id"],
                    operation_id="mcp-review", expected_version=item["version"], decision="approve",
                    reason="已通过 MCP 读取并核对交付报告")
                assert final["status"] == "done"
                events = await call(requester, "hub_events", after=0, limit=500)
                assert any(event["type"] == "delivery.approve" and event["entity_id"] == delivery["id"]
                           for event in events["events"])
                print("MCP_WORKFLOW_RESULT " + json.dumps({"status": "passed", "tools": len(tools),
                    "transport": "official-sdk/stdio/authenticated-http/sqlite", "harness_process_tested": False,
                    "run_success_item_state": "active", "reviewed_item_state": final["status"],
                    "attachment_utf8_bytes": readback["size"], "capability_version": release["version"]}))

    asyncio.run(exercise())


def test_mcp_transfer_dependency_and_confirmed_cancellation(live_hub, tmp_path):
    async def exercise():
        async with mcp_session(live_hub, "demo-lin") as requester:
            async with mcp_session(live_hub, "demo-chen") as assignee:
                async def create(suffix):
                    return await call(requester, "ledger_create", operation_id=f"mcp-create-{suffix}",
                        title=f"MCP route test {suffix}", project_id="proj-interface",
                        target_team_id="team-clearing", acceptance_spec=["验证真实状态"])

                prerequisite = await create("prerequisite")
                declined = await call(assignee, "ledger_decline", work_item_id=prerequisite["id"],
                    operation_id="mcp-decline", expected_version=prerequisite["version"], reason="测试拒收")
                assert declined["pending_target_team_id"] is None
                item = await create("transfer")
                item = await call(requester, "ledger_add_dependency", work_item_id=item["id"],
                    operation_id="mcp-dependency", expected_version=item["version"], depends_on_id=prerequisite["id"])
                item = await call(assignee, "ledger_accept", work_item_id=item["id"],
                    operation_id="mcp-transfer-accept", expected_version=item["version"])
                await error(assignee, "ledger_start", "DEPENDENCY_BLOCKED", work_item_id=item["id"],
                    operation_id="mcp-blocked-start", expected_version=item["version"])
                item = await call(assignee, "ledger_transfer", work_item_id=item["id"], operation_id="mcp-transfer",
                    expected_version=item["version"], target_team_id="team-trading", reason="请求方处理前置问题")
                assert item["owner_team_id"] == "team-clearing"
                item = await call(requester, "ledger_accept_transfer", work_item_id=item["id"],
                    operation_id="mcp-accept-transfer", expected_version=item["version"])
                assert item["owner_team_id"] == "team-trading" and item["assignee_id"] == "u-lin"
                item = await call(requester, "ledger_cancel", work_item_id=item["id"], operation_id="mcp-cancel-item",
                    expected_version=item["version"], reason="结束协议路线测试")
                assert item["status"] == "cancelled"

                running_item = await create("cancel-run")
                running_item = await call(assignee, "ledger_accept", work_item_id=running_item["id"],
                    operation_id="mcp-cancel-run-accept", expected_version=running_item["version"])
                run = await call(assignee, "hub_run_register", work_item_id=running_item["id"],
                    operation_id="mcp-register-cancel-run", expected_version=running_item["version"],
                    client_instance_id="cancel-test-client", harness="sdk-integration-test", workspace_ref=str(tmp_path))
                cancelled = await call(requester, "hub_run_cancel", run_id=run["id"], operation_id="mcp-request-cancel")
                assert cancelled["status"] == "cancel_requested"
                confirmed = await call(assignee, "hub_run_report", run_id=run["id"],
                    operation_id="mcp-confirm-cancel", client_instance_id="cancel-test-client", sequence=1,
                    status="cancelled", summary="No external process was started by this protocol test")
                assert confirmed["status"] == "cancelled"
                current = (await call(requester, "ledger_get", work_item_id=running_item["id"]))["item"]
                assert current["status"] == "active"

    asyncio.run(exercise())


def test_mcp_text_artifact_boundaries(live_hub):
    with httpx.Client(base_url=live_hub, headers={"Authorization": "Bearer demo-chen"}, trust_env=False) as http:
        binary = http.post("/api/v1/artifacts", files={"file": ("image.bin", b"\x00\xff", "application/octet-stream")}).json()
        invalid = http.post("/api/v1/artifacts", files={"file": ("invalid.txt", b"\xff\xfe", "text/plain")}).json()
        oversize = http.post("/api/v1/artifacts", files={"file": ("big.txt", b"x" * (2 * 1024 * 1024 + 1), "text/plain")}).json()

    async def exercise():
        async with mcp_session(live_hub, "demo-lin") as session:
            await error(session, "artifact_read_text", "not declared as text", artifact_id=binary["id"])
            await error(session, "artifact_read_text", "not valid UTF-8", artifact_id=invalid["id"])
            await error(session, "artifact_read_text", "at most 2 MiB", artifact_id=oversize["id"])
            await error(session, "artifact_upload_text", "without directory separators", filename="../report.md", content="test")
            # UTF-8 byte count, not character count, is the upload boundary.
            await error(session, "artifact_upload_text", "at most 2 MiB", filename="big.md", content="中" * 700000)

    asyncio.run(exercise())


def test_mcp_serial_pipeline_across_teams(live_hub):
    async def exercise():
        async with mcp_session(live_hub, 'demo-lin') as requester:
            async with mcp_session(live_hub, 'demo-chen') as implementer:
                async with mcp_session(live_hub, 'demo-xu') as tester:
                    definition = {
                        'roles': [{'key': 'dev', 'label': '开发组', 'kind': 'team'},
                                  {'key': 'qa', 'label': '测试组', 'kind': 'team'},
                                  {'key': 'reviewer', 'label': '验收人', 'kind': 'reviewer'}],
                        'steps': [{'key': 'develop', 'name': '开发', 'team_role': 'dev', 'reviewer_role': 'reviewer',
                                   'acceptance_spec': ['提交说明'], 'required_artifact_kinds': ['document']},
                                  {'key': 'verify', 'name': '验证', 'team_role': 'qa', 'reviewer_role': 'reviewer',
                                   'acceptance_spec': ['提交结果'], 'required_artifact_kinds': ['report']}],
                    }
                    draft = await call(requester, 'workflow_template_create', operation_id='mcp-flow-draft', name='MCP 流程模板', definition=definition)
                    assert (await call(requester, 'workflow_template_validate', template_id=draft['id']))['valid']
                    version = await call(requester, 'workflow_template_publish', template_id=draft['id'],
                                         operation_id='mcp-flow-publish', expected_revision=draft['draft_revision'])
                    view = await call(requester, 'pipeline_create', operation_id='mcp-pipeline-create', title='MCP 串行协作',
                                      project_id='proj-interface', template_version_id=version['id'],
                                      role_bindings={'dev': 'team-clearing', 'qa': 'team-qa', 'reviewer': 'u-lin'})
                    view = await call(requester, 'pipeline_control', pipeline_id=view['pipeline']['id'],
                                      operation_id='mcp-pipeline-start', expected_version=view['pipeline']['version'], action='start')
                    pipeline_id = view['pipeline']['id']
                    for index, member in enumerate((implementer, tester)):
                        step = view['steps'][index]
                        context = {'pipeline_attempt_id': step['attempt']['id'], 'pipeline_generation': view['pipeline']['generation']}
                        item = await call(member, 'pipeline_step_command', work_item_id=step['item']['id'],
                                          operation_id=f'mcp-flow-accept-{index}', expected_version=step['item']['version'],
                                          action='accept', **context)
                        item = await call(member, 'pipeline_step_command', work_item_id=item['id'],
                                          operation_id=f'mcp-flow-work-{index}', expected_version=item['version'], action='start', **context)
                        artifact = await call(member, 'artifact_upload_text', filename=f'report-{index}.txt', content='合成测试结果')
                        delivery = await call(member, 'pipeline_step_submit', work_item_id=item['id'],
                                              operation_id=f'mcp-flow-submit-{index}', expected_version=item['version'],
                                              spec_revision=item['spec_revision'], summary='已提交',
                                              artifacts=[{'label': '结果', 'url': artifact['url'],
                                                          'kind': 'document' if index == 0 else 'report'}], **context)
                        item = (await call(requester, 'ledger_get', work_item_id=item['id']))['item']
                        item = await call(requester, 'pipeline_step_review', delivery_id=delivery['id'],
                                          operation_id=f'mcp-flow-review-{index}', expected_version=item['version'],
                                          decision='approve', **context)
                        assert item['status'] == 'done'
                        view = await call(requester, 'pipeline_get', pipeline_id=pipeline_id)
                    assert view['pipeline']['status'] == 'completed'
                    assert view['steps'][1]['attempt']['input_snapshot']['upstream_deliveries'][0]['work_item_id'] == view['steps'][0]['item']['id']

    asyncio.run(exercise())


def test_cross_language_adapters_with_real_hub_and_cross_team_pipeline(live_hub, tmp_path):
    node = shutil.which('node')
    assert node, 'Node is required for the CLI integration test'
    board_path, executor_path = tmp_path / 'board.json', tmp_path / 'executor.json'
    config_path = tmp_path / 'adapters.json'
    config_path.write_text(json.dumps({'schema_version': 1, 'adapters': [
        {'name': 'portable-board', 'kind': 'board', 'command': sys.executable,
         'args': [str(ROOT / 'examples/adapters/local-json-board.py'), str(board_path), 'portable-board']},
        {'name': 'portable-executor', 'kind': 'executor', 'command': sys.executable,
         'args': [str(ROOT / 'tests/fixtures/stdio-executor.py'), str(executor_path), 'portable-executor', 'lose-first-response']},
    ]}), encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.startswith('TEAMHUB_')}
    env.update(TEAMHUB_URL=live_hub, TEAMHUB_STATE_DIR=str(tmp_path / 'bridge'))

    def cli(token, *args, data=None, expect_error=None):
        command = [node, str(ROOT / 'packages/cli/bin/teamhub.mjs'), *args,
                   '--adapter-config', str(config_path), '--instance', 'shared-test-device']
        if data is not None:
            command += ['--data', json.dumps(data)]
        result = subprocess.run(command, cwd=ROOT, env={**env, 'TEAMHUB_TOKEN': token},
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        if expect_error:
            assert result.returncode != 0
            error = json.loads(result.stderr)['error']
            assert error['code'] == expect_error, error
            return error
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    def board_cards():
        return json.loads(board_path.read_text(encoding='utf-8'))['cards']

    async def exercise():
        discovered = cli('demo-lin', 'adapters', 'list')
        assert discovered['boards'][0]['available'] and discovered['executors'][0]['available']
        async with mcp_session(live_hub, 'demo-lin') as requester:
            async with mcp_session(live_hub, 'demo-chen') as implementer:
                async with mcp_session(live_hub, 'demo-xu') as tester:
                    definition = {
                        'roles': [{'key': 'dev', 'label': '开发组', 'kind': 'team'},
                                  {'key': 'qa', 'label': '测试组', 'kind': 'team'},
                                  {'key': 'reviewer', 'label': '验收人', 'kind': 'reviewer'}],
                        'steps': [{'key': 'develop', 'name': '开发', 'team_role': 'dev', 'reviewer_role': 'reviewer',
                                   'acceptance_spec': ['提交说明'], 'required_artifact_kinds': ['document']},
                                  {'key': 'verify', 'name': '验证', 'team_role': 'qa', 'reviewer_role': 'reviewer',
                                   'acceptance_spec': ['提交结果'], 'required_artifact_kinds': ['report']}],
                    }
                    draft = await call(requester, 'workflow_template_create', operation_id='adapter-flow-template', name='通用适配器验证', definition=definition)
                    version = await call(requester, 'workflow_template_publish', template_id=draft['id'],
                                         operation_id='adapter-flow-publish', expected_revision=draft['draft_revision'])
                    view = await call(requester, 'pipeline_create', operation_id='adapter-flow-create', title='跨组适配器验证',
                                      project_id='proj-interface', template_version_id=version['id'],
                                      role_bindings={'dev': 'team-clearing', 'qa': 'team-qa', 'reviewer': 'u-lin'})
                    view = await call(requester, 'pipeline_control', pipeline_id=view['pipeline']['id'],
                                      operation_id='adapter-flow-start', expected_version=view['pipeline']['version'], action='start')
                    pipeline = view['pipeline']['id']
                    link_args = ('pipelines', 'link', pipeline, '--adapter', 'portable-board', '--workspace-ref', str(tmp_path))
                    first = cli('demo-lin', *link_args)
                    assert first['synced'] and len(first['cards']) == 1, first
                    assert cli('demo-lin', *link_args)['cards'][0]['local_todo_id'] == first['cards'][0]['local_todo_id']
                    assert len(board_cards()) == 1
                    board = json.loads(board_path.read_text(encoding='utf-8'))
                    board['cards'][0]['title'], board['cards'][0]['notes'] = '本地标题', '本地备注'
                    board_path.write_text(json.dumps(board, ensure_ascii=False), encoding='utf-8')
                    view = await call(requester, 'pipeline_control', pipeline_id=pipeline, operation_id='adapter-flow-pause',
                                      expected_version=view['pipeline']['version'], action='pause')
                    cli('demo-lin', 'pipelines', 'sync', '--adapter', 'portable-board')
                    assert board_cards()[0]['hub']['pipelineStatus'] == 'paused'
                    view = await call(requester, 'pipeline_control', pipeline_id=pipeline, operation_id='adapter-flow-resume',
                                      expected_version=view['pipeline']['version'], action='resume')
                    for index, member in enumerate((implementer, tester)):
                        step = view['steps'][index]
                        context = {'pipeline_attempt_id': step['attempt']['id'], 'pipeline_generation': view['pipeline']['generation']}
                        item = await call(member, 'pipeline_step_command', work_item_id=step['item']['id'],
                                          operation_id=f'adapter-accept-{index}', expected_version=step['item']['version'], action='accept', **context)
                        token = 'demo-chen' if index == 0 else 'demo-xu'
                        error = cli(token, 'runs', 'start', item['id'], '--adapter', 'portable-executor',
                                    '--workspace-ref', str(tmp_path), '--version', str(item['version']),
                                    '--operation-id', f'adapter-run-{index}', data=context, expect_error='LAUNCH_UNCERTAIN')
                        dispatch = error['details']['dispatch_id']
                        assert cli(token, 'runs', 'reconcile', dispatch)['run']['status'] == 'queued'
                        host = json.loads(executor_path.read_text(encoding='utf-8'))
                        assert host['starts'] == index + 1
                        assert host['runs'][dispatch]['input_snapshot']['pipeline_attempt_id'] == context['pipeline_attempt_id']
                        if index == 0:
                            cli('demo-lin', 'runs', 'cancel-execution', dispatch, expect_error='DISPATCH_IDENTITY_MISMATCH')
                            assert 'cancel_requested' not in host['runs'][dispatch]
                            host['runs'][dispatch]['status'] = 'succeeded'
                        else:
                            cancel = cli(token, 'runs', 'cancel-execution', dispatch, '--operation-id', 'adapter-cancel')
                            assert cancel['run']['status'] == 'cancel_requested' and not cancel['confirmed']
                            host = json.loads(executor_path.read_text(encoding='utf-8'))
                            host['runs'][dispatch]['status'] = 'cancelled'
                        executor_path.write_text(json.dumps(host), encoding='utf-8')
                        expected = 'succeeded' if index == 0 else 'cancelled'
                        assert cli(token, 'runs', 'reconcile', dispatch)['run']['status'] == expected
                        detail = await call(member, 'ledger_get', work_item_id=item['id'])
                        assert detail['item']['status'] == 'active'
                        artifact = await call(member, 'artifact_upload_text', filename=f'adapter-{index}.txt', content='模拟流程验收材料')
                        delivery = await call(member, 'pipeline_step_submit', work_item_id=item['id'],
                                              operation_id=f'adapter-submit-{index}', expected_version=detail['item']['version'],
                                              spec_revision=item['spec_revision'], summary='已提交',
                                              artifacts=[{'label': '结果', 'url': artifact['url'],
                                                          'kind': 'document' if index == 0 else 'report'}], **context)
                        detail = await call(requester, 'ledger_get', work_item_id=item['id'])
                        await call(requester, 'pipeline_step_review', delivery_id=delivery['id'],
                                   operation_id=f'adapter-review-{index}', expected_version=detail['item']['version'],
                                   decision='approve', **context)
                        view = await call(requester, 'pipeline_get', pipeline_id=pipeline)
                        cli('demo-lin', 'pipelines', 'sync', '--adapter', 'portable-board')
                    assert view['pipeline']['status'] == 'completed'
                    assert len(board_cards()) == 2 and all(card['hub']['status'] == 'done' for card in board_cards())
                    assert board_cards()[0]['title'] == '本地标题' and board_cards()[0]['notes'] == '本地备注'
                    unlinked = cli('demo-lin', 'pipelines', 'unlink', pipeline, '--adapter', 'portable-board')
                    assert unlinked['detached'] == 2
                    assert len(board_cards()) == 2 and all('hub' not in card for card in board_cards())

    asyncio.run(exercise())
