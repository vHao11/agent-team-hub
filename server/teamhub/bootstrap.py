from __future__ import annotations

import secrets
import json
from datetime import datetime, timedelta, timezone
from importlib import resources

from sqlalchemy import func, select

from . import db as m
from .service import Hub, now, token_hash

DEMO_IDENTITIES = [
    {"id": "u-lin", "name": "林澈", "team_id": "team-trading", "token": "demo-lin"},
    {"id": "u-chen", "name": "陈悦", "team_id": "team-clearing", "token": "demo-chen"},
    {"id": "u-xu", "name": "许安", "team_id": "team-qa", "token": "demo-xu"},
]


def sample_package(name):
    """Read the same embedded sample files in source checkouts and installed wheels."""
    folder = resources.files('teamhub').joinpath('sample_content', name)
    files = {}

    def collect(directory, prefix=''):
        for entry in directory.iterdir():
            # pip compiles .py resources during installation. Bytecode is runtime
            # cache, not a publishable UTF-8 capability file.
            if entry.name == '__pycache__' or entry.name.endswith(('.pyc', '.pyo')):
                continue
            relative = prefix + entry.name
            if entry.is_dir():
                collect(entry, relative + '/')
            else:
                files[relative] = entry.read_text(encoding='utf-8')

    collect(folder)
    return json.loads(files['manifest.json']), files


def ensure_mode(database, demo):
    mode = "demo" if demo else "standard"
    with database.write() as connection:
        stored = connection.execute(select(m.settings).where(m.settings.c.key == "mode")).mappings().first()
        if stored and stored["value"] != mode:
            raise RuntimeError("数据目录的演示/正式模式不匹配。请使用独立目录，禁止把演示身份带入正式空间。")
        if not stored:
            connection.execute(m.settings.insert().values(key="mode", value=mode))


def initialize_workspace(database, *, name="管理员", team_name="我的团队"):
    ensure_mode(database, False)
    token = secrets.token_urlsafe(36)
    with database.write() as connection:
        if connection.execute(select(func.count()).select_from(m.users)).scalar_one():
            raise RuntimeError("此工作空间已经初始化；不会覆盖现有身份或令牌。")
        connection.execute(m.teams.insert().values(id="team-main", name=team_name))
        connection.execute(m.users.insert().values(id="user-admin", name=name, team_id="team-main", role="admin", active=True, token_hash=token_hash(token)))
        connection.execute(m.projects.insert().values(id="proj-main", name="团队协作", description="共享事项与能力复用"))
    return {"user_id": "user-admin", "name": name, "team_id": "team-main", "token": token}


def seed_demo(hub: Hub):
    database = hub.db
    ensure_mode(database, True)
    with database.write() as connection:
        if connection.execute(select(m.settings).where(m.settings.c.key == "demo_seed_v1")).first():
            return
        seed_started = connection.execute(select(m.settings.c.value).where(m.settings.c.key == "demo_seed_started_at")).scalar_one_or_none()
        if not seed_started:
            seed_started = datetime.now(timezone.utc).isoformat()
            connection.execute(m.settings.insert().values(key="demo_seed_started_at", value=seed_started))
        if connection.execute(select(func.count()).select_from(m.users)).scalar_one():
            # A previous interrupted seed may be resumed via the operation receipts below.
            pass
        else:
            connection.execute(m.teams.insert(), [
                {"id": "team-trading", "name": "交易研发组"},
                {"id": "team-clearing", "name": "清算研发组"},
                {"id": "team-qa", "name": "质量保障组"},
            ])
            connection.execute(m.users.insert(), [
                {**{k: v for k, v in value.items() if k != "token"}, "role": "admin" if value["id"] == "u-lin" else "member",
                 "active": True, "token_hash": token_hash(value["token"])}
                for value in DEMO_IDENTITIES
            ])
            connection.execute(m.projects.insert().values(id="proj-interface", name="交易接口协同", description="演示项目：交易、清算与质量保障团队的接口交付"))
    lin, chen, xu = [hub.actor(value["token"]) for value in DEMO_IDENTITIES]
    skill = hub.create_capability(lin, {
        "operation_id": "seed-cap-skill", "slug": "trading/interface-review", "name": "接口变更影响分析",
        "description": "按字段、调用链和验收条件整理变更范围，产出可交付的影响分析报告。",
        "kind": "skill", "tags": ["接口分析", "团队模板", "通用 Skill"],
    })
    skill_manifest, skill_files = sample_package('interface-review')
    hub.publish_release(lin, skill["id"], {
        "operation_id": "seed-release-skill", "version": skill_manifest['version'],
        "manifest": skill_manifest, "files": skill_files,
    })
    script = hub.create_capability(chen, {
        "operation_id": "seed-cap-script", "slug": "clearing/log-summary", "name": "联调日志摘要",
        "description": "读取本机 JSONL 日志，统计 ERROR、WARN、INFO 和事件，输出 JSON 摘要；不会修改源日志。",
        "kind": "script", "tags": ["联调", "Python", "只读"],
    })
    script_manifest, script_files = sample_package('log-summary')
    hub.publish_release(chen, script["id"], {
        "operation_id": "seed-release-script", "version": script_manifest['version'],
        "manifest": script_manifest, "files": script_files,
    })
    workflow = hub.create_capability(lin, {
        "operation_id": "seed-cap-workflow", "slug": "team/interface-delivery", "name": "接口交付协作模板",
        "description": "整理影响分析、适配、测试与联调的团队交付清单。首版作为可下载的流程说明。",
        "kind": "workflow", "tags": ["跨组协作", "交付验收"],
    })
    hub.publish_release(lin, workflow["id"], {
        "operation_id": "seed-release-workflow", "version": "0.1.0",
        "manifest": {"schema_version": 1, "version": "0.1.0", "kind": "workflow", "entry": "workflow.md",
                     "execution_mode": "manual", "description": "流程说明；未启用自动编排"},
        "files": {"workflow.md": "# 接口交付\n\n1. 交易组提交影响分析。\n2. 清算组完成调用与回报适配。\n3. 质量保障组补齐回归用例。\n4. 请求方验收交付物。\n\n各阶段用明确验收后的依赖连接，具体任务需显式创建。\n"},
    })
    for team in ("team-trading", "team-clearing", "team-qa"):
        hub.set_toolset(lin, team, {"operation_id": f"seed-toolset-{team}", "expected_version": 0,
                                    "items": [{"capability_id": skill["id"], "version": skill_manifest['version']}, {"capability_id": script["id"], "version": script_manifest['version']}]})
    descriptions = [
        ("核对新交易接口的清算回报字段", "对齐新增字段、枚举与默认值，形成跨组确认清单。", "open", "high", 2),
        ("补齐撤单回报的幂等处理", "覆盖重复回报与网络重试，补充实现说明和回归测试。", "active", "urgent", 1),
        ("交付接口兼容性测试报告", "验证旧版本调用方的兼容行为，并整理测试证据。", "review", "normal", 3),
        ("统一联调日志的关联标识", "约定请求、回报与任务编号的关联字段。", "done", "normal", -1),
        ("确认批量交收的异常码映射", "等待异常码说明后完成映射和测试建议。", "blocked", "high", 1),
        ("准备新接口的回归用例集", "针对新增字段与异常分支整理可复用用例。", "accepted", "normal", 5),
    ]
    for index, (title, description, stage, priority, days) in enumerate(descriptions):
        assignee = xu if index == 5 else chen
        value = hub.create_item(lin, {
            "operation_id": f"seed-item-{index}", "title": title, "description": description,
            "project_id": "proj-interface", "target_team_id": assignee["team_id"], "reviewer_id": lin["id"],
            "priority": priority, "due_at": (datetime.fromisoformat(seed_started) + timedelta(days=days)).isoformat(),
            "acceptance_spec": ["提交双方可访问的说明或代码链接", "覆盖正常、异常和重复输入场景", "列出遗留问题和后续负责人"],
        })
        if stage != "open":
            value = hub.command(assignee, value["id"], "accept", {"operation_id": f"seed-accept-{index}", "expected_version": value["version"]})
        if stage in ("active", "review", "done", "blocked"):
            value = hub.command(assignee, value["id"], "start", {"operation_id": f"seed-start-{index}", "expected_version": value["version"]})
        if stage == "blocked":
            value = hub.command(assignee, value["id"], "progress", {
                "operation_id": f"seed-progress-{index}", "expected_version": value["version"],
                "summary": "已经完成现有映射核对，新增异常码需要交易组确认。", "blocked_reason": "缺少新增异常码定义",
                "waiting_on": "交易研发组", "next_action": "补充接口说明后继续适配",
            })
        if stage in ("review", "done"):
            artifact_id = f"demo-report-{index}"
            path = database.data_dir / "artifacts" / artifact_id
            content = f"# {title}\n\n演示交付材料。已记录目标、测试覆盖与后续事项；这不是实际生产验收报告。\n".encode()
            path.write_bytes(content)
            with database.write() as connection:
                if not connection.execute(select(m.artifacts).where(m.artifacts.c.id == artifact_id)).first():
                    connection.execute(m.artifacts.insert().values(
                        id=artifact_id, label="演示交付报告.md", content_type="text/markdown", size=len(content), uploaded_by=assignee["id"], created_at=now()))
            delivery = hub.submit(assignee, value["id"], {
                "operation_id": f"seed-submit-{index}", "expected_version": value["version"], "spec_revision": value["spec_revision"],
                "summary": "交付说明和测试覆盖已经整理，请请求方验收。", "artifacts": [{"label": "演示交付报告", "url": f"artifact://{artifact_id}", "kind": "document"}],
            })
            if stage == "done":
                hub.review(lin, delivery["id"], {"operation_id": f"seed-review-{index}", "expected_version": value["version"] + 1, "decision": "approve", "reason": "演示验收通过"})
    with database.write() as connection:
        if not connection.execute(select(m.settings).where(m.settings.c.key == "demo_seed_v1")).first():
            connection.execute(m.settings.insert().values(key="demo_seed_v1", value=True))
