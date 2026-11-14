"""MCP stdio bridge. Tools invoke the same authenticated HTTP API as the Web UI.

Run: TEAMHUB_URL=... TEAMHUB_TOKEN=... python -m teamhub.mcp_server
Or: python -m teamhub.mcp_server --connection-file /absolute/private-connection.json
This module never opens the Hub database or logs credentials to stdout.
"""
from __future__ import annotations

import argparse
import os
from typing import Any, Literal
from urllib.parse import quote

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from .connection import load_connection
from .schemas import CapabilityChoice

MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024


def build_server(url: str | None = None, token: str | None = None,
                 connection_file: str | None = None) -> FastMCP:
    base, secret = load_connection(url=url, token=token, connection_file=connection_file)
    server = FastMCP("Agent Team Hub", instructions=(
        "共享跨组台账与能力目录。先读取事项版本，再使用明确授权的业务命令。"
        "运行成功不等于验收通过。网络结果不确定时，重用同一个 operation_id。"
        "这个 MCP 服务可独立于 DSH 使用，提供协作、交付验收与共享能力发布。"
        "Run 登记只记录调用方执行，不启动任何宿主；取消请求需实际执行方确认。"), log_level="WARNING")

    async def request(method: str, path: str, body: dict | None = None, params: dict | None = None,
                      files: dict | None = None, text_artifact: bool = False) -> Any:
        if not secret:
            raise ValueError("TEAMHUB_TOKEN is required; configure a personal access token in the MCP environment.")
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=False,
                                         trust_env=os.getenv("TEAMHUB_TRUST_ENV", "0") == "1") as client:
                content = {"files": files} if files is not None else {"json": body}
                async with client.stream(method, base + "/api/v1" + path,
                        headers={"Authorization": "Bearer " + secret}, params=params, **content) as response:
                    if text_artifact and response.is_success:
                        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                        if not (content_type.startswith("text/") or content_type == "application/json" or content_type.endswith("+json")):
                            raise ValueError("This artifact is not declared as text or JSON; download binary files through the HTTP API or Web UI")
                        data_bytes = bytearray()
                        async for chunk in response.aiter_bytes():
                            data_bytes.extend(chunk)
                            if len(data_bytes) > MAX_TEXT_ARTIFACT_BYTES:
                                raise ValueError("MCP text artifacts must be at most 2 MiB of UTF-8")
                        try:
                            text = data_bytes.decode("utf-8-sig")
                        except UnicodeDecodeError as exc:
                            raise ValueError("Artifact content is not valid UTF-8 text") from exc
                        return {"content": text, "content_type": content_type, "size": len(data_bytes)}
                    await response.aread()
        except httpx.HTTPError as exc:
            op = body.get("operation_id") if body else None
            retry = f"; preserve operation_id={op} before retrying" if op else ""
            raise ValueError(f"Hub connection failed ({type(exc).__name__}){retry}.") from exc
        try:
            data = response.json()
        except ValueError as exc:
            raise ValueError(f"Hub returned a non-JSON response, status={response.status_code}") from exc
        if not response.is_success:
            error = data.get("error", {})
            raise ValueError(f"{error.get('code', response.status_code)}: {error.get('message', 'Hub request failed')}")
        return data

    def command(operation_id: str, expected_version: int | None = None, **data: Any) -> dict:
        if not operation_id.strip():
            raise ValueError("operation_id must be a stable non-empty request identifier")
        return {"operation_id": operation_id, **({"expected_version": expected_version} if expected_version is not None else {}), **data}

    readonly = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
    writes = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True)
    uploads = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)

    @server.tool(annotations=readonly)
    async def ledger_search(view: str = "all", status: str | None = None, q: str | None = None, limit: int = 20, offset: int = 0) -> dict:
        """查找当前成员可见的事项；view 可为 all、mine、requested、review、inbox。"""
        return await request("GET", "/work-items", params={k: v for k, v in {
            "view": view, "status": status, "q": q, "limit": limit, "offset": offset}.items() if v is not None})

    @server.tool(annotations=readonly)
    async def ledger_get(work_item_id: str) -> dict:
        """读取目标、当前版本、验收条件、交付和运行记录。"""
        return await request("GET", "/work-items/" + quote(work_item_id, safe=""))

    @server.tool(annotations=writes)
    async def ledger_create(operation_id: str, title: str, project_id: str, target_team_id: str,
                            acceptance_spec: list[str], description: str = "", reviewer_id: str | None = None,
                            priority: Literal["normal", "high", "urgent"] | None = None, due_at: str | None = None) -> dict:
        """根据用户明确请求建立跨组事项，操作 ID 在重试时保持不变。"""
        body = command(operation_id, title=title, project_id=project_id, target_team_id=target_team_id,
                       acceptance_spec=acceptance_spec, description=description)
        if reviewer_id:
            body["reviewer_id"] = reviewer_id
        if due_at is not None:
            body["due_at"] = due_at
        if priority is not None:
            body["priority"] = priority
        return await request("POST", "/work-items", body)

    @server.tool(annotations=writes)
    async def ledger_accept(work_item_id: str, operation_id: str, expected_version: int, assignee_id: str | None = None) -> dict:
        """代表当前成员所在组接单；接单不启动 Agent。"""
        body = command(operation_id, expected_version)
        if assignee_id:
            body["assignee_id"] = assignee_id
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/accept", body)

    @server.tool(annotations=writes)
    async def ledger_start(work_item_id: str, operation_id: str, expected_version: int) -> dict:
        """登记人工开始处理；不会启动本机进程。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/start", command(operation_id, expected_version))

    @server.tool(annotations=writes)
    async def ledger_decline(work_item_id: str, operation_id: str, expected_version: int, reason: str) -> dict:
        """由待接收团队拒绝尚未接单的请求，必须说明原因。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/decline",
            command(operation_id, expected_version, reason=reason))

    @server.tool(annotations=writes)
    async def ledger_cancel(work_item_id: str, operation_id: str, expected_version: int, reason: str) -> dict:
        """取消业务事项并请求停止未结束的 Run；不会终止宿主进程，停止仍需执行方确认。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/cancel",
            command(operation_id, expected_version, reason=reason))

    @server.tool(annotations=writes)
    async def ledger_transfer(work_item_id: str, operation_id: str, expected_version: int,
                              target_team_id: str, reason: str) -> dict:
        """负责人向另一团队请求转交；对方接受之前，原团队继续负责。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/transfer-requests",
            command(operation_id, expected_version, target_team_id=target_team_id, reason=reason))

    @server.tool(annotations=writes)
    async def ledger_accept_transfer(work_item_id: str, operation_id: str, expected_version: int,
                                     assignee_id: str | None = None) -> dict:
        """待接收团队接受转交；已有执行未确认结束时不能接受。"""
        body = command(operation_id, expected_version)
        if assignee_id is not None:
            body["assignee_id"] = assignee_id
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/accept-transfer", body)

    @server.tool(annotations=writes)
    async def ledger_update_spec(work_item_id: str, operation_id: str, expected_version: int,
                                 acceptance_spec: list[str], reason: str, description: str | None = None) -> dict:
        """请求方调整验收条件并增加范围版本；旧待验收交付失效。省略 description 保留原说明。"""
        body = command(operation_id, expected_version, acceptance_spec=acceptance_spec, reason=reason)
        if description is not None:
            body["description"] = description
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/spec", body)

    @server.tool(annotations=writes)
    async def ledger_add_dependency(work_item_id: str, operation_id: str, expected_version: int,
                                     depends_on_id: str) -> dict:
        """开工前添加前置事项；拒绝循环，前置事项验收通过后才能开工。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/dependencies",
            command(operation_id, expected_version, depends_on_id=depends_on_id))

    @server.tool(annotations=writes)
    async def ledger_progress(work_item_id: str, operation_id: str, expected_version: int, summary: str,
                              blocked_reason: str | None = None, waiting_on: str | None = None, next_action: str | None = None) -> dict:
        """追加进度或卡点，不把进展描述解释成验收通过。"""
        optional = {k: v for k, v in {"blocked_reason": blocked_reason, "waiting_on": waiting_on,
                                     "next_action": next_action}.items() if v is not None}
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/progress",
            command(operation_id, expected_version, summary=summary, **optional))

    @server.tool(annotations=writes)
    async def ledger_submit(work_item_id: str, operation_id: str, expected_version: int, spec_revision: int,
                            summary: str, artifacts: list[dict[str, str]], run_ids: list[str] | None = None) -> dict:
        """提交具体交付版本，等待指定验收人处理。artifacts 含 label 和共享可读 url。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/deliveries",
            command(operation_id, expected_version, spec_revision=spec_revision, summary=summary, artifacts=artifacts, run_ids=run_ids or []))

    @server.tool(annotations=writes)
    async def ledger_review(delivery_id: str, operation_id: str, expected_version: int,
                             decision: Literal["approve", "request_changes"], reason: str = "") -> dict:
        """由具名验收人明确批准当前交付或要求修改；expected_version 是事项当前版本，退回必须附原因。"""
        return await request("POST", f"/deliveries/{quote(delivery_id, safe='')}/reviews",
            command(operation_id, expected_version, decision=decision, reason=reason))

    @server.tool(annotations=uploads)
    async def artifact_upload_text(filename: str, content: str,
                                    content_type: Literal["text/plain", "text/markdown", "text/csv", "application/json"] = "text/plain") -> dict:
        """上传传入的 UTF-8 文本报告（最大 2 MiB），返回可提交的 artifact:// URL；不读取本机路径。重复调用会创建新附件。"""
        if not filename.strip() or len(filename) > 500 or any(character in filename for character in ("/", "\\", "\0", "\r", "\n")):
            raise ValueError("filename must be a non-empty filename without directory separators, at most 500 characters")
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_TEXT_ARTIFACT_BYTES:
            raise ValueError("MCP text artifacts must be at most 2 MiB of UTF-8; use the CLI for larger or binary files")
        return await request("POST", "/artifacts", files={"file": (filename, encoded, content_type)})

    @server.tool(annotations=readonly)
    async def artifact_read_text(artifact_id: str) -> dict:
        """通过鉴权 HTTP 读取已上传的文本/JSON交付材料（最大 2 MiB、UTF-8），便于验收；参数是 artifact ID，不是本机路径。"""
        result = await request("GET", "/artifacts/" + quote(artifact_id, safe=""), text_artifact=True)
        return {"artifact_id": artifact_id, **result}

    @server.tool(annotations=readonly)
    async def catalog_search(q: str = "", kind: str | None = None) -> dict:
        """搜索能力目录；安装与执行方式取决于具体类型和兼容声明。"""
        return await request("GET", "/capabilities", params={"q": q, **({"kind": kind} if kind else {})})

    @server.tool(annotations=readonly)
    async def catalog_resolve(capability_id: str, version: str) -> dict:
        """读取固定发布版本及其清单、文本文件；不会安装或执行代码。"""
        return await request("GET", f"/capabilities/{quote(capability_id, safe='')}/releases/{quote(version, safe='')}")

    @server.tool(annotations=readonly)
    async def catalog_get(capability_id: str) -> dict:
        """读取共享能力详情及已发布版本，选择明确版本后再解析内容。"""
        return await request("GET", "/capabilities/" + quote(capability_id, safe=""))

    @server.tool(annotations=writes)
    async def catalog_publish(operation_id: str, slug: str, name: str,
                                kind: Literal["skill", "script", "mcp", "plugin", "workflow", "app"],
                                description: str = "", tags: list[str] | None = None) -> dict:
        """为当前团队创建共享能力目录条目；发布可用内容需另调用 catalog_publish_release。"""
        return await request("POST", "/capabilities",
            command(operation_id, slug=slug, name=name, kind=kind, description=description, tags=tags or []))

    @server.tool(annotations=writes)
    async def catalog_publish_release(capability_id: str, operation_id: str, version: str,
                                        manifest: dict[str, Any], files: dict[str, str] | None = None) -> dict:
        """发布不可覆盖的固定版本；files 为相对路径到 UTF-8 文本，合计最多 2 MiB / 100 文件。发布不执行代码。"""
        return await request("POST", f"/capabilities/{quote(capability_id, safe='')}/releases",
            command(operation_id, version=version, manifest=manifest, files=files or {}))

    @server.tool(annotations=readonly)
    async def team_toolset_get(team_id: str) -> dict:
        """读取团队推荐能力集及版本号，每项固定 capability_id 和 version。"""
        return await request("GET", "/team-toolsets/" + quote(team_id, safe=""))

    @server.tool(annotations=writes)
    async def team_toolset_set(team_id: str, operation_id: str, expected_version: int,
                                items: list[CapabilityChoice]) -> dict:
        """组长更新本组、管理员更新指定团队的固定版本工具集；items 含 capability_id/version。首次版本为 0；不改变已有 Run 快照。"""
        return await request("PUT", "/team-toolsets/" + quote(team_id, safe=""),
            command(operation_id, expected_version, items=[item.model_dump() for item in items]))

    @server.tool(annotations=readonly)
    async def hub_context() -> dict:
        """获取当前成员、组与项目 ID，以便正确填写协作命令。"""
        return await request("GET", "/bootstrap")

    @server.tool(annotations=readonly)
    async def hub_integration_contract() -> dict:
        """读取 Hub 支持的业务传输、适配器协议版本和执行语义；不代表某个本机适配器已安装。"""
        return await request("GET", "/integration/contract")

    @server.tool(annotations=readonly)
    async def hub_events(after: int = 0, limit: int = 100) -> dict:
        """按游标读取工作空间事件（最多 500 条）；事件回放不会启动任何执行。"""
        return await request("GET", "/events", params={"after": after, "limit": limit})

    @server.tool(annotations=writes)
    async def hub_bind_session(work_item_id: str, operation_id: str, client_instance_id: str, harness: str,
                               workspace_ref: str, session_id: str | None = None, local_todo_id: str | None = None) -> dict:
        """绑定已知真实本机会话或卡片 ID；不会创建会话、启动 Agent 或推断当前会话。"""
        optional = {k: v for k, v in {"session_id": session_id, "local_todo_id": local_todo_id}.items() if v is not None}
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/bindings", command(operation_id,
            client_instance_id=client_instance_id, harness=harness, workspace_ref=workspace_ref, **optional))

    @server.tool(annotations=writes)
    async def hub_run_register(work_item_id: str, operation_id: str, expected_version: int, client_instance_id: str,
                               harness: str, workspace_ref: str, external_session_id: str | None = None,
                               capabilities: list[dict[str, str]] | None = None) -> dict:
        """为调用方负责的执行登记运行。不会启动本机程序。capabilities 为固定 capability_id/version，省略时解析组工具集。"""
        body = command(operation_id, expected_version, client_instance_id=client_instance_id,
            harness=harness, workspace_ref=workspace_ref, external_session_id=external_session_id)
        if capabilities is not None:
            body["capabilities"] = capabilities
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/runs", body)

    @server.tool(annotations=readonly)
    async def hub_run_get(run_id: str) -> dict:
        """读取已有执行状态与固定工具版本，不启动新的执行。"""
        return await request("GET", "/runs/" + quote(run_id, safe=""))

    @server.tool(annotations=writes)
    async def hub_run_cancel(run_id: str, operation_id: str) -> dict:
        """向登记的执行发出取消请求；cancel_requested 不代表已停止，需实际执行方确认后回报 cancelled。"""
        return await request("POST", f"/runs/{quote(run_id, safe='')}/cancel", command(operation_id))

    @server.tool(annotations=writes)
    async def hub_run_report(run_id: str, operation_id: str, client_instance_id: str, sequence: int, status: str,
                             summary: str | None = None, external_session_id: str | None = None, external_run_id: str | None = None) -> dict:
        """回传经过核实的运行状态；sequence 必须递增。succeeded 不会把共享事项改为 done。"""
        optional = {k: v for k, v in {"summary": summary, "external_session_id": external_session_id,
                                     "external_run_id": external_run_id}.items() if v is not None}
        return await request("POST", f"/runs/{quote(run_id, safe='')}/events", command(operation_id,
            client_instance_id=client_instance_id, sequence=sequence, status=status, **optional))

    @server.tool(annotations=readonly)
    async def workflow_template_list() -> dict:
        """列出流程模板、草稿和不可变发布版本。"""
        return await request("GET", "/workflow-templates")

    @server.tool(annotations=readonly)
    async def workflow_template_get(template_id: str) -> dict:
        """读取模板草稿和已发布版本。"""
        return await request("GET", "/workflow-templates/" + quote(template_id, safe=""))

    @server.tool(annotations=writes)
    async def workflow_template_create(operation_id: str, name: str, definition: dict[str, Any], description: str = "") -> dict:
        """创建模板草稿；definition 含 roles 和串行 steps。"""
        return await request("POST", "/workflow-templates", command(operation_id, name=name, description=description, definition=definition))

    @server.tool(annotations=writes)
    async def workflow_template_update(template_id: str, operation_id: str, expected_revision: int, name: str,
                                       definition: dict[str, Any], description: str = "") -> dict:
        """按草稿修订号保存模板定义。"""
        return await request("PUT", "/workflow-templates/" + quote(template_id, safe=""),
                             command(operation_id, expected_revision=expected_revision, name=name, description=description, definition=definition))

    @server.tool(annotations=readonly)
    async def workflow_template_validate(template_id: str) -> dict:
        """校验草稿角色、步骤、材料与能力引用，不发布模板。"""
        return await request("POST", f"/workflow-templates/{quote(template_id, safe='')}/validate")

    @server.tool(annotations=writes)
    async def workflow_template_publish(template_id: str, operation_id: str, expected_revision: int) -> dict:
        """发布不可变模板版本；现有流程继续使用原版本。"""
        return await request("POST", f"/workflow-templates/{quote(template_id, safe='')}/publish",
                             command(operation_id, expected_revision=expected_revision))

    @server.tool(annotations=writes)
    async def workflow_template_clone(template_id: str, operation_id: str) -> dict:
        """从最新发布版本复制新草稿。"""
        return await request("POST", f"/workflow-templates/{quote(template_id, safe='')}/clone", command(operation_id))

    @server.tool(annotations=readonly)
    async def pipeline_list() -> dict:
        """列出流程实例及各步骤状态。"""
        return await request("GET", "/pipelines")

    @server.tool(annotations=readonly)
    async def pipeline_get(pipeline_id: str) -> dict:
        """读取流程版本、步骤、当前轮次和关联事项。"""
        return await request("GET", "/pipelines/" + quote(pipeline_id, safe=""))

    @server.tool(annotations=writes)
    async def pipeline_create(operation_id: str, title: str, project_id: str, template_version_id: str,
                              role_bindings: dict[str, str], description: str = "",
                              assignees: dict[str, str] | None = None, priority: Literal['normal', 'high', 'urgent'] = 'normal',
                              due_at: str | None = None) -> dict:
        """按固定模板版本创建流程草稿；角色分别绑定团队或验收账号，不自动开始执行。"""
        return await request("POST", "/pipelines", command(operation_id, title=title, project_id=project_id,
            template_version_id=template_version_id, role_bindings=role_bindings, description=description,
            assignees=assignees or {}, priority=priority, due_at=due_at))

    @server.tool(annotations=writes)
    async def pipeline_control(pipeline_id: str, operation_id: str, expected_version: int,
                               action: Literal['start', 'pause', 'resume', 'cancel']) -> dict:
        """明确启动、暂停、恢复或取消流程；启动只创建协作事项，不启动 Agent。"""
        return await request("POST", f"/pipelines/{quote(pipeline_id, safe='')}/{action}", command(operation_id, expected_version))

    @server.tool(annotations=writes)
    async def pipeline_reassign(pipeline_id: str, step_key: str, operation_id: str, expected_version: int,
                                target_team_id: str, reason: str) -> dict:
        """流程发起人重新指派已拒收的步骤；责任仍在接收前的团队。"""
        return await request("POST", f"/pipelines/{quote(pipeline_id, safe='')}/steps/{quote(step_key, safe='')}/reassign",
                             command(operation_id, expected_version, target_team_id=target_team_id, reason=reason))

    @server.tool(annotations=writes)
    async def pipeline_step_command(work_item_id: str, operation_id: str, expected_version: int,
                                    pipeline_attempt_id: str, pipeline_generation: int,
                                    action: Literal['accept', 'decline', 'start', 'progress', 'spec', 'transfer-requests', 'accept-transfer'],
                                    data: dict[str, Any] | None = None) -> dict:
        """对当前流程步骤接单、开工、更新或转交；必须携带从事项详情读取的当前轮次。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/{action}", command(operation_id,
            expected_version, **(data or {}), pipeline_attempt_id=pipeline_attempt_id, pipeline_generation=pipeline_generation))

    @server.tool(annotations=writes)
    async def pipeline_step_submit(work_item_id: str, operation_id: str, expected_version: int, spec_revision: int,
                                   pipeline_attempt_id: str, pipeline_generation: int, summary: str,
                                   artifacts: list[dict[str, str]], run_ids: list[str] | None = None) -> dict:
        """提交当前步骤轮次的具体材料；服务端校验必需类型和关联运行。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/deliveries", command(operation_id,
            expected_version, spec_revision=spec_revision, summary=summary, artifacts=artifacts, run_ids=run_ids or [],
            pipeline_attempt_id=pipeline_attempt_id, pipeline_generation=pipeline_generation))

    @server.tool(annotations=writes)
    async def pipeline_step_review(delivery_id: str, operation_id: str, expected_version: int,
                                   pipeline_attempt_id: str, pipeline_generation: int,
                                   decision: Literal['approve', 'request_changes'], reason: str = '') -> dict:
        """由指定验收账号审核当前步骤的交付；调用方须确保符合人的确认要求。"""
        return await request("POST", f"/deliveries/{quote(delivery_id, safe='')}/reviews", command(operation_id,
            expected_version, decision=decision, reason=reason, pipeline_attempt_id=pipeline_attempt_id, pipeline_generation=pipeline_generation))

    @server.tool(annotations=writes)
    async def pipeline_step_run_register(work_item_id: str, operation_id: str, expected_version: int,
                                         pipeline_attempt_id: str, pipeline_generation: int, client_instance_id: str,
                                         harness: str, workspace_ref: str, external_session_id: str | None = None) -> dict:
        """登记当前步骤的现有执行，不启动程序；能力版本采用步骤固定值。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/runs", command(operation_id,
            expected_version, pipeline_attempt_id=pipeline_attempt_id, pipeline_generation=pipeline_generation,
            client_instance_id=client_instance_id, harness=harness, workspace_ref=workspace_ref, external_session_id=external_session_id))

    @server.tool(annotations=writes)
    async def pipeline_step_bind_session(work_item_id: str, operation_id: str, pipeline_attempt_id: str,
                                         pipeline_generation: int, client_instance_id: str, harness: str,
                                         workspace_ref: str, session_id: str | None = None, local_todo_id: str | None = None) -> dict:
        """把已存在的本地会话或卡片关联到当前流程步骤。"""
        return await request("POST", f"/work-items/{quote(work_item_id, safe='')}/bindings", command(operation_id,
            pipeline_attempt_id=pipeline_attempt_id, pipeline_generation=pipeline_generation, client_instance_id=client_instance_id,
            harness=harness, workspace_ref=workspace_ref, session_id=session_id, local_todo_id=local_todo_id))

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent Team Hub MCP stdio server")
    parser.add_argument("--connection-file", help="Private JSON containing the Hub URL and personal token")
    arguments = parser.parse_args()
    try:
        _, secret = load_connection(connection_file=arguments.connection_file)
        if not secret:
            raise ValueError("TEAMHUB_TOKEN is required. Configure it in the MCP environment or a private connection file.")
        server = build_server(connection_file=arguments.connection_file)
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from None
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
