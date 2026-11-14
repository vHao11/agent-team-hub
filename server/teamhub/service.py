from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath
from urllib.parse import urlparse

from sqlalchemy import and_, func, or_, select

from . import db as m


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, details=None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


def require(condition, code, message, status=400, details=None):
    if not condition:
        raise DomainError(code, message, status, details)


def row(connection, table, identifier, column="id"):
    result = connection.execute(select(table).where(table.c[column] == identifier)).mappings().first()
    if result is None:
        raise DomainError("NOT_FOUND", f"找不到记录：{identifier}", 404)
    return dict(result)


def rows(connection, statement):
    return [dict(value) for value in connection.execute(statement).mappings()]


def public_user(value):
    return {key: value[key] for key in ("id", "name", "team_id", "role")}


ACTIVE_RUNS = ("queued", "starting", "running", "waiting_input", "cancel_requested", "unknown")
TERMINAL_RUNS = ("succeeded", "failed", "cancelled")
RUN_STATES = (*ACTIVE_RUNS, *TERMINAL_RUNS)


class Hub:
    def __init__(self, database: m.Database, demo=False):
        self.db, self.demo = database, demo
        from .workflow_service import Workflows
        self.workflows = Workflows(self)

    def actor(self, token):
        require(bool(token), "UNAUTHORIZED", "请先登录工作空间。", 401)
        with self.db.read() as connection:
            found = connection.execute(select(m.users).where(
                m.users.c.token_hash == token_hash(token), m.users.c.active.is_(True)
            )).mappings().first()
        require(found is not None, "UNAUTHORIZED", "连接令牌无效或已停用。", 401)
        return public_user(dict(found))

    def bootstrap(self, actor):
        with self.db.read() as connection:
            return {
                "me": actor, "teams": rows(connection, select(m.teams)),
                "users": [public_user(x) for x in rows(connection, select(m.users))],
                "projects": rows(connection, select(m.projects)), "demo_mode": self.demo,
            }

    def emit(self, connection, kind, entity_id, actor, payload=None):
        connection.execute(m.events.insert().values(
            type=kind, entity_id=entity_id, actor_id=actor["id"], payload=payload or {}, created_at=now()
        ))

    def mutate(self, actor, scope, payload, callback):
        operation = payload.get("operation_id")
        require(isinstance(operation, str) and 4 <= len(operation) <= 200, "OPERATION_ID_REQUIRED", "操作需要稳定的 operation_id。")
        fingerprint = hashlib.sha256(json.dumps(
            {"scope": scope, "payload": payload}, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()).hexdigest()
        with self.db.write() as connection:
            previous = connection.execute(select(m.operation_receipts).where(
                m.operation_receipts.c.actor_id == actor["id"], m.operation_receipts.c.operation_id == operation
            )).mappings().first()
            if previous:
                require(previous["fingerprint"] == fingerprint, "IDEMPOTENCY_CONFLICT", "同一个操作编号不能用于不同内容。", 409)
                return previous["response"]
            result = callback(connection)
            connection.execute(m.operation_receipts.insert().values(
                actor_id=actor["id"], operation_id=operation, fingerprint=fingerprint, response=result, created_at=now()
            ))
            return result

    def check_version(self, item, payload):
        require(payload.get("expected_version") == item["version"], "VERSION_CONFLICT",
                "事项已被更新，请刷新后再操作。", 409, {"current_version": item["version"]})

    def change_item(self, connection, item, **changes):
        changes.update(version=item["version"] + 1, updated_at=now())
        result = connection.execute(m.work_items.update().where(
            m.work_items.c.id == item["id"], m.work_items.c.version == item["version"]
        ).values(**changes))
        require(result.rowcount == 1, "VERSION_CONFLICT", "事项已变化，请刷新。", 409)
        return row(connection, m.work_items, item["id"])

    def assigned(self, actor, item):
        return item["assignee_id"] == actor["id"] and actor["team_id"] == item["owner_team_id"]

    def requester(self, actor, item):
        return actor["id"] in (item["requester_id"], item["reviewer_id"])

    def require_assigned(self, actor, item):
        require(self.assigned(actor, item), "FORBIDDEN", "此操作由当前事项负责人执行。", 403)

    def require_open_dependencies(self, connection, item):
        prerequisites = rows(connection, select(m.work_items).join(
            m.dependencies, m.dependencies.c.depends_on_id == m.work_items.c.id
        ).where(m.dependencies.c.work_item_id == item["id"], m.work_items.c.status != "done"))
        require(not prerequisites, "DEPENDENCY_BLOCKED", "前置交付尚未验收完成。", 409,
                {"items": [{"id": x["id"], "number": x["number"], "title": x["title"]} for x in prerequisites]})

    def list_items(self, actor, *, q="", status="", team_id="", view="all", limit=50, offset=0):
        conditions = []
        if q:
            conditions.append(or_(m.work_items.c.title.contains(q, autoescape=True), m.work_items.c.number.contains(q, autoescape=True)))
        if status:
            conditions.append(m.work_items.c.status == status)
        if team_id:
            conditions.append(or_(m.work_items.c.owner_team_id == team_id, m.work_items.c.pending_target_team_id == team_id))
        if view == "mine":
            conditions.append(m.work_items.c.assignee_id == actor["id"])
        elif view == "requested":
            conditions.append(m.work_items.c.requester_id == actor["id"])
        elif view == "review":
            conditions.extend([m.work_items.c.reviewer_id == actor["id"], m.work_items.c.status == "review"])
        elif view == "inbox":
            conditions.append(m.work_items.c.pending_target_team_id == actor["team_id"])
        with self.db.read() as connection:
            statement = select(m.work_items).where(*conditions).order_by(m.work_items.c.updated_at.desc(), m.work_items.c.number.desc())
            return {"items": rows(connection, statement.limit(limit).offset(offset)),
                    "total": connection.execute(select(func.count()).select_from(m.work_items).where(*conditions)).scalar_one(),
                    "limit": limit, "offset": offset}

    def allowed_actions(self, actor, item):
        actions = []
        if item["status"] == "open" and item["pending_target_team_id"] == actor["team_id"]:
            actions.extend(["accept", "decline"])
        if item["status"] in ("accepted", "active") and item["pending_target_team_id"] == actor["team_id"]:
            actions.append("accept-transfer")
        if self.assigned(actor, item):
            if item["status"] == "accepted":
                actions.append("start")
            if item["status"] in ("active", "review"):
                actions.extend(["submit", "deliveries"])
            if item["status"] in ("accepted", "active"):
                actions.append("transfer-requests")
                if not item["pending_target_team_id"]:
                    actions.extend(["run", "runs"])
        if actor["team_id"] == item["owner_team_id"] or self.requester(actor, item):
            if item["status"] not in ("done", "cancelled"):
                actions.append("progress")
        if actor["id"] == item["reviewer_id"] and item["status"] == "review":
            actions.extend(["approve", "request_changes", "reviews"])
        if self.requester(actor, item) or self.assigned(actor, item):
            actions.extend(["bind", "bindings"])
            if item["status"] not in ("done", "cancelled"):
                actions.append("cancel")
            if item["status"] in ("open", "accepted"):
                actions.append("dependencies")
        if self.requester(actor, item) and item["status"] not in ("done", "cancelled"):
            actions.append("spec")
        return actions

    def detail(self, actor, identifier):
        with self.db.read() as connection:
            item = row(connection, m.work_items, identifier)
            deliveries = rows(connection, select(m.deliveries).where(m.deliveries.c.work_item_id == identifier).order_by(m.deliveries.c.sequence.desc()))
            context = self.workflows.context(connection, identifier)
            actions = self.allowed_actions(actor, item)
            if context:
                actions = [action for action in actions if action not in ("cancel", "dependencies")]
                if context["pipeline_status"] == "paused":
                    actions = [action for action in actions if action not in ("start", "run", "runs")]
                if not context["current"] or context["pipeline_status"] not in ("active", "paused"):
                    actions = []
            return {
                "item": item, "allowed_actions": actions, "pipeline_context": context,
                "progress": rows(connection, select(m.progress).where(m.progress.c.work_item_id == identifier).order_by(m.progress.c.created_at.desc())),
                "deliveries": deliveries,
                "reviews": rows(connection, select(m.reviews).join(m.deliveries).where(m.deliveries.c.work_item_id == identifier).order_by(m.reviews.c.created_at.desc())),
                "runs": rows(connection, select(m.runs).where(m.runs.c.work_item_id == identifier).order_by(m.runs.c.created_at.desc())),
                "bindings": rows(connection, select(m.bindings).where(m.bindings.c.work_item_id == identifier, m.bindings.c.user_id == actor["id"])),
                "events": rows(connection, select(m.events).where(or_(
                    m.events.c.entity_id == identifier, m.events.c.payload["work_item_id"].as_string() == identifier
                )).order_by(m.events.c.id.desc()).limit(100)),
                "dependencies": rows(connection, select(m.work_items).join(m.dependencies, m.dependencies.c.depends_on_id == m.work_items.c.id).where(m.dependencies.c.work_item_id == identifier)),
            }

    def create_item(self, actor, payload):
        def create(connection):
            return self.create_item_in_tx(connection, actor, payload)
        return self.mutate(actor, "work-items/create", payload, create)

    def create_item_in_tx(self, connection, requester, payload, event_actor=None):
        row(connection, m.projects, payload["project_id"])
        row(connection, m.teams, payload["target_team_id"])
        reviewer = payload.get("reviewer_id") or requester["id"]
        row(connection, m.users, reviewer)
        counter = connection.execute(select(func.count()).select_from(m.work_items)).scalar_one()
        value = dict(
            id=uid("wi"), number=f"TH-{1001 + counter}", title=payload["title"].strip(),
            description=payload.get("description", ""), project_id=payload["project_id"],
            requesting_team_id=requester["team_id"], requester_id=requester["id"],
            owner_team_id=requester["team_id"], pending_target_team_id=payload["target_team_id"],
            assignee_id=None, reviewer_id=reviewer, status="open", priority=payload.get("priority", "normal"),
            due_at=payload.get("due_at"), acceptance_spec=payload["acceptance_spec"],
            blocked_reason=None, waiting_on=None, next_action=None, version=1, spec_revision=1,
            current_delivery_id=None, assignment_generation=1, created_at=now(), updated_at=now(),
        )
        connection.execute(m.work_items.insert().values(**value))
        self.emit(connection, "work_item.created", value["id"], event_actor or requester, {"title": value["title"], "number": value["number"]})
        return value

    def command(self, actor, identifier, action, payload):
        def apply(connection):
            item = row(connection, m.work_items, identifier)
            self.check_version(item, payload)
            context = self.workflows.guard(connection, item, payload, action)
            require(item["status"] not in ("done", "cancelled"), "INVALID_STATE", "此事项已经结束。", 409)
            changes = {}
            if action in ("accept", "accept-transfer"):
                valid = item["status"] == "open" if action == "accept" else item["status"] in ("accepted", "active")
                require(valid and item["pending_target_team_id"], "INVALID_STATE", "当前没有可接收的请求。", 409)
                require(item["pending_target_team_id"] == actor["team_id"], "FORBIDDEN", "只有待接收团队可以接单。", 403)
                owner = row(connection, m.users, payload.get("assignee_id") or actor["id"])
                require(owner["team_id"] == actor["team_id"] and owner["active"], "INVALID_ASSIGNEE", "负责人必须属于承接团队。")
                if context:
                    require(owner["id"] != item["reviewer_id"], "INDEPENDENT_REVIEW_REQUIRED", "处理人与验收人必须是不同账号。", 422)
                    require(action == "accept-transfer" or not context["requested_assignee_id"] or owner["id"] == context["requested_assignee_id"],
                            "INVALID_ASSIGNEE", "此步骤已指定处理人，请选择指定成员。", 422)
                if action == "accept-transfer":
                    active = connection.execute(select(m.runs.c.id).where(m.runs.c.work_item_id == identifier, m.runs.c.status.in_(ACTIVE_RUNS))).first()
                    require(not active, "ACTIVE_RUN_EXISTS", "请先确认原执行已停止，再接受转交。", 409)
                changes = dict(owner_team_id=actor["team_id"], pending_target_team_id=None, assignee_id=owner["id"],
                               status="accepted", assignment_generation=item["assignment_generation"] + 1)
            elif action == "decline":
                require(item["status"] == "open" and item["pending_target_team_id"] == actor["team_id"], "FORBIDDEN", "只能拒绝发给本组的待接单请求。", 403)
                require(bool(payload.get("reason", "").strip()), "REASON_REQUIRED", "请填写拒绝原因。")
                changes = {"pending_target_team_id": None, "next_action": payload["reason"]}
            elif action == "start":
                self.require_assigned(actor, item)
                require(item["status"] == "accepted", "INVALID_STATE", "只能开始已接单事项。", 409)
                self.require_open_dependencies(connection, item)
                changes = {"status": "active"}
            elif action == "cancel":
                require(self.requester(actor, item) or self.assigned(actor, item), "FORBIDDEN", "只有请求方或负责人可以取消。", 403)
                require(bool(payload.get("reason", "").strip()), "REASON_REQUIRED", "请填写取消原因。")
                changes = {"status": "cancelled", "pending_target_team_id": None, "next_action": payload["reason"]}
                active_runs = rows(connection, select(m.runs).where(m.runs.c.work_item_id == identifier, m.runs.c.status.in_(ACTIVE_RUNS)))
                for active_run in active_runs:
                    connection.execute(m.runs.update().where(m.runs.c.id == active_run["id"]).values(status="cancel_requested"))
                    self.emit(connection, "run.cancel_requested", active_run["id"], actor, {"work_item_id": identifier})
            elif action == "transfer-requests":
                self.require_assigned(actor, item)
                require(item["status"] in ("accepted", "active"), "INVALID_STATE", "待验收事项请先处理验收。", 409)
                target = row(connection, m.teams, payload["target_team_id"])
                require(target["id"] != item["owner_team_id"], "INVALID_TARGET", "请选择其他承接组。")
                require(bool(payload.get("reason", "").strip()), "REASON_REQUIRED", "请填写转交原因。")
                changes = {"pending_target_team_id": target["id"], "next_action": payload["reason"]}
            elif action == "progress":
                require(actor["team_id"] == item["owner_team_id"] or self.requester(actor, item), "FORBIDDEN", "当前成员不能更新此事项进展。", 403)
                require(bool(payload.get("summary", "").strip()), "SUMMARY_REQUIRED", "请填写进展摘要。")
                connection.execute(m.progress.insert().values(
                    id=uid("pr"), work_item_id=identifier, summary=payload["summary"],
                    blocked_reason=payload.get("blocked_reason"), waiting_on=payload.get("waiting_on"),
                    next_action=payload.get("next_action"), author_id=actor["id"], created_at=now()
                ))
                changes = {key: payload[key] or None for key in ("blocked_reason", "waiting_on", "next_action") if key in payload}
            elif action == "spec":
                require(self.requester(actor, item), "FORBIDDEN", "交付范围由请求方调整。", 403)
                require(bool(payload.get("acceptance_spec")), "ACCEPTANCE_REQUIRED", "至少需要一条验收条件。")
                require(bool(payload.get("reason", "").strip()), "REASON_REQUIRED", "请说明变更原因。")
                changes = {"acceptance_spec": payload["acceptance_spec"], "spec_revision": item["spec_revision"] + 1, "current_delivery_id": None}
                if "description" in payload:
                    changes["description"] = payload["description"]
                if item["status"] == "review":
                    changes["status"] = "active"
            elif action == "dependencies":
                require(self.requester(actor, item) or self.assigned(actor, item), "FORBIDDEN", "只有请求方或负责人可以维护依赖。", 403)
                require(item["status"] in ("open", "accepted"), "INVALID_STATE", "开工后不追加阻塞依赖，请通过新协作事项约定。", 409)
                target = payload["depends_on_id"]
                row(connection, m.work_items, target)
                require(target != identifier, "DEPENDENCY_CYCLE", "事项不能依赖自己。", 409)
                graph = {}
                for dep in rows(connection, select(m.dependencies)):
                    graph.setdefault(dep["work_item_id"], []).append(dep["depends_on_id"])
                frontier, visited = [target], set()
                while frontier:
                    current = frontier.pop()
                    require(current != identifier, "DEPENDENCY_CYCLE", "依赖关系会形成循环。", 409)
                    if current not in visited:
                        visited.add(current)
                        frontier.extend(graph.get(current, []))
                existing = connection.execute(select(m.dependencies).where(
                    m.dependencies.c.work_item_id == identifier, m.dependencies.c.depends_on_id == target)).first()
                if not existing:
                    connection.execute(m.dependencies.insert().values(work_item_id=identifier, depends_on_id=target))
            else:
                raise DomainError("UNKNOWN_ACTION", "不支持的事项操作。", 404)
            updated = self.change_item(connection, item, **changes)
            self.emit(connection, f"work_item.{action.replace('-', '_')}", identifier, actor,
                      {"version": updated["version"], "summary": payload.get("summary") or payload.get("reason") or ""})
            if context:
                if action == "spec":
                    self.workflows.new_attempt(connection, context, actor, payload["reason"])
                else:
                    connection.execute(m.pipelines.update().where(m.pipelines.c.id == context["pipeline_id"]).values(
                        version=m.pipelines.c.version + 1, updated_at=now()))
            return updated
        return self.mutate(actor, f"work-items/{identifier}/{action}", payload, apply)

    def submit(self, actor, identifier, payload):
        def apply(connection):
            item = row(connection, m.work_items, identifier)
            self.require_assigned(actor, item)
            self.check_version(item, payload)
            context = self.workflows.guard(connection, item, payload, "deliveries")
            require(item["status"] in ("active", "review"), "INVALID_STATE", "开始处理后才能提交交付。", 409)
            require(payload["spec_revision"] == item["spec_revision"], "SPEC_REVISION_CONFLICT", "验收条件已更新，请按当前范围重新提交。", 409)
            require(bool(payload["artifacts"]), "ARTIFACT_REQUIRED", "请至少附上一份双方可读的交付材料。")
            if context:
                supplied = {artifact.get("kind", "document") for artifact in payload["artifacts"]}
                missing = [kind for kind in context["required_artifact_kinds"] if kind not in supplied]
                require(not missing, "REQUIRED_ARTIFACT_MISSING", "缺少步骤要求的材料类型。", 422, {"missing": missing})
            for artifact in payload["artifacts"]:
                url = artifact["url"]
                parsed = urlparse(url)
                if parsed.scheme == "artifact":
                    row(connection, m.artifacts, parsed.netloc)
                else:
                    require(parsed.scheme in ("http", "https") and bool(parsed.netloc),
                            "INVALID_ARTIFACT", "交付材料需要 HTTP 链接或已上传附件，本机路径不可共享。")
            for run_id in payload.get("run_ids", []):
                linked_run = row(connection, m.runs, run_id)
                require(linked_run["work_item_id"] == identifier, "INVALID_RUN", "执行记录不属于此事项。")
                if context:
                    require(linked_run["pipeline_attempt_id"] == context["attempt_id"], "STALE_PIPELINE_ATTEMPT", "执行记录不属于当前流程轮次。", 409)
            active = connection.execute(select(m.runs.c.id).where(
                m.runs.c.work_item_id == identifier, m.runs.c.status.in_(ACTIVE_RUNS)
            )).first()
            require(not active, "RUN_NOT_FINISHED", "请先确认关联执行的结果或停止状态，再提交交付。", 409)
            sequence = connection.execute(select(func.count()).select_from(m.deliveries).where(m.deliveries.c.work_item_id == identifier)).scalar_one() + 1
            value = dict(
                id=uid("del"), work_item_id=identifier, sequence=sequence,
                spec_revision=item["spec_revision"], summary=payload["summary"],
                artifacts=payload["artifacts"], run_ids=payload.get("run_ids", []), submitted_by=actor["id"], created_at=now(),
                pipeline_attempt_id=context["attempt_id"] if context else None,
            )
            connection.execute(m.deliveries.insert().values(**value))
            self.change_item(connection, item, status="review", current_delivery_id=value["id"],
                             blocked_reason=None, waiting_on=None, next_action="等待请求方验收")
            self.emit(connection, "delivery.submitted", value["id"], actor, {"work_item_id": identifier, "sequence": sequence, "summary": value["summary"]})
            if context:
                connection.execute(m.pipelines.update().where(m.pipelines.c.id == context["pipeline_id"]).values(
                    version=m.pipelines.c.version + 1, updated_at=now()))
            return value
        return self.mutate(actor, f"work-items/{identifier}/deliveries", payload, apply)

    def review(self, actor, delivery_id, payload):
        def apply(connection):
            delivery = row(connection, m.deliveries, delivery_id)
            item = row(connection, m.work_items, delivery["work_item_id"])
            require(actor["id"] == item["reviewer_id"], "FORBIDDEN", "只有此事项指定的验收人可以验收。", 403)
            self.check_version(item, payload)
            context = self.workflows.guard(connection, item, payload, "review")
            if context:
                require(item["assignee_id"] != actor["id"], "INDEPENDENT_REVIEW_REQUIRED", "验收人与处理人必须是不同账号。", 422)
                require(delivery["pipeline_attempt_id"] == context["attempt_id"], "STALE_PIPELINE_ATTEMPT", "交付不属于当前流程轮次。", 409)
            require(item["status"] == "review" and item["current_delivery_id"] == delivery_id,
                    "STALE_DELIVERY", "此交付已经不是当前待验收版本。", 409)
            require(delivery["spec_revision"] == item["spec_revision"], "SPEC_REVISION_CONFLICT", "此交付不对应当前验收条件。", 409)
            decision = payload["decision"]
            require(decision in ("approve", "request_changes"), "INVALID_DECISION", "无效的验收决定。")
            if decision == "request_changes":
                require(bool(payload.get("reason", "").strip()), "REASON_REQUIRED", "请说明需要补充或修改的内容。")
            value = dict(id=uid("rev"), delivery_id=delivery_id, decision=decision, reason=payload.get("reason", ""),
                         reviewer_id=actor["id"], created_at=now())
            connection.execute(m.reviews.insert().values(**value))
            result = self.change_item(connection, item, status="done" if decision == "approve" else "active",
                                      next_action=None if decision == "approve" else payload["reason"])
            self.emit(connection, f"delivery.{decision}", delivery_id, actor,
                      {"work_item_id": item["id"], "reason": value["reason"], "sequence": delivery["sequence"]})
            if context:
                if decision == "request_changes":
                    self.workflows.new_attempt(connection, context, actor, value["reason"])
                else:
                    connection.execute(m.pipelines.update().where(m.pipelines.c.id == context["pipeline_id"]).values(
                        version=m.pipelines.c.version + 1, updated_at=now()))
                    self.workflows.activate_next(connection, row(connection, m.pipelines, context["pipeline_id"]), actor)
            return result
        return self.mutate(actor, f"deliveries/{delivery_id}/reviews", payload, apply)

    def bind(self, actor, identifier, payload):
        def apply(connection):
            item = row(connection, m.work_items, identifier)
            context = self.workflows.context(connection, item["id"])
            pending_pipeline_team = bool(context and item["pending_target_team_id"] == actor["team_id"])
            require(self.assigned(actor, item) or self.requester(actor, item) or pending_pipeline_team,
                    "FORBIDDEN", "只有负责人、请求方或待接收团队可以关联本地工作。", 403)
            self.workflows.guard(connection, item, payload, "bindings")
            found = connection.execute(select(m.bindings).where(
                m.bindings.c.work_item_id == identifier, m.bindings.c.user_id == actor["id"],
                m.bindings.c.client_instance_id == payload["client_instance_id"], m.bindings.c.harness == payload["harness"]
            )).mappings().first()
            values = {key: payload[key] for key in ("client_instance_id", "harness", "workspace_ref", "local_todo_id", "session_id") if key in payload}
            values["updated_at"] = now()
            if found:
                connection.execute(m.bindings.update().where(m.bindings.c.id == found["id"]).values(**values))
                identifier_binding = found["id"]
            else:
                identifier_binding = uid("binding")
                connection.execute(m.bindings.insert().values(
                    id=identifier_binding, work_item_id=identifier, user_id=actor["id"], created_at=now(), **values
                ))
            self.emit(connection, "binding.linked", identifier_binding, actor, {"work_item_id": identifier})
            return row(connection, m.bindings, identifier_binding)
        return self.mutate(actor, f"work-items/{identifier}/bindings", payload, apply)

    def resolve_releases(self, connection, choices):
        resolved = []
        for choice in choices:
            capability = row(connection, m.capabilities, choice["capability_id"])
            release = connection.execute(select(m.releases).where(
                m.releases.c.capability_id == capability["id"], m.releases.c.version == choice["version"]
            )).mappings().first()
            require(release is not None, "RELEASE_NOT_FOUND", "找不到指定能力版本。", 404)
            resolved.append({"release_id": release["id"], "capability_id": capability["id"],
                             "version": release["version"], "name": capability["name"]})
        return resolved

    def create_run(self, actor, identifier, payload):
        def apply(connection):
            item = row(connection, m.work_items, identifier)
            self.require_assigned(actor, item)
            self.check_version(item, payload)
            context = self.workflows.guard(connection, item, payload, "runs")
            require(item["status"] in ("accepted", "active"), "INVALID_STATE", "当前事项不能启动新执行。", 409)
            require(not item["pending_target_team_id"], "TRANSFER_PENDING", "存在待接收转交，请先处理交接。", 409)
            self.require_open_dependencies(connection, item)
            existing = connection.execute(select(m.runs.c.id).where(m.runs.c.work_item_id == identifier, m.runs.c.status.in_(ACTIVE_RUNS))).first()
            require(not existing, "ACTIVE_RUN_EXISTS", "已有未确认结束的执行，请先核对当前执行。", 409)
            choices = payload.get("capabilities")
            if context:
                pinned = context["capability_releases"] or []
                if choices is not None:
                    selected = self.resolve_releases(connection, choices)
                    require(selected == pinned, "CAPABILITY_VERSION_CONFLICT", "运行必须使用步骤固定的能力版本。", 409)
            elif choices is None:
                toolset = connection.execute(select(m.toolsets).where(m.toolsets.c.team_id == item["owner_team_id"])).mappings().first()
                choices = toolset["items"] if toolset else []
                pinned = self.resolve_releases(connection, choices)
            else:
                pinned = self.resolve_releases(connection, choices)
            value = dict(
                id=uid("run"), dispatch_id=uid("dispatch"), work_item_id=identifier,
                client_instance_id=payload["client_instance_id"], harness=payload["harness"], workspace_ref=payload["workspace_ref"],
                requested_by=actor["id"], status="queued", external_session_id=payload.get("external_session_id"),
                external_run_id=None, capability_releases=pinned, result_summary="", spec_revision=item["spec_revision"],
                assignment_generation=item["assignment_generation"], input_snapshot={
                    "title": item["title"], "description": item["description"], "acceptance_spec": item["acceptance_spec"],
                    "spec_revision": item["spec_revision"], "capability_releases": pinned,
                    **({"pipeline_attempt_id": context["attempt_id"], "pipeline_generation": context["generation"],
                        "upstream_deliveries": context["input_snapshot"]["upstream_deliveries"]} if context else {}),
                }, sequence=0, created_at=now(), last_seen_at=now(),
                pipeline_attempt_id=context["attempt_id"] if context else None,
            )
            connection.execute(m.runs.insert().values(**value))
            if item["status"] == "accepted":
                self.change_item(connection, item, status="active")
            if context:
                connection.execute(m.pipelines.update().where(m.pipelines.c.id == context["pipeline_id"]).values(
                    version=m.pipelines.c.version + 1, updated_at=now()))
            self.emit(connection, "run.queued", value["id"], actor, {"work_item_id": identifier, "dispatch_id": value["dispatch_id"]})
            return value
        return self.mutate(actor, f"work-items/{identifier}/runs", payload, apply)

    def get_run(self, identifier):
        with self.db.read() as connection:
            return row(connection, m.runs, identifier)

    def run_event(self, actor, identifier, payload):
        def apply(connection):
            value = row(connection, m.runs, identifier)
            require(value["requested_by"] == actor["id"], "FORBIDDEN", "只有执行登记人可以回报运行状态。", 403)
            require(value["client_instance_id"] == payload["client_instance_id"], "INSTANCE_MISMATCH", "回报来自不同客户端实例。", 403)
            require(payload["status"] in RUN_STATES, "INVALID_STATUS", "无效运行状态。")
            if payload["sequence"] <= value["sequence"]:
                return value
            if value["status"] in TERMINAL_RUNS:
                require(payload["status"] == value["status"], "RUN_TERMINAL", "执行已经结束，不能重新进入运行状态。", 409)
                return value
            next_status = payload["status"]
            # Late heartbeat must not erase a cancellation request.
            if value["status"] == "cancel_requested" and next_status not in TERMINAL_RUNS:
                next_status = "cancel_requested"
            changes = dict(status=next_status, sequence=payload["sequence"], last_seen_at=now())
            for key in ("external_session_id", "external_run_id"):
                if key in payload:
                    changes[key] = payload[key]
            if "summary" in payload:
                changes["result_summary"] = payload["summary"]
            connection.execute(m.runs.update().where(m.runs.c.id == identifier).values(**changes))
            self.emit(connection, f"run.{next_status}", identifier, actor,
                      {"work_item_id": value["work_item_id"], "sequence": payload["sequence"], "summary": changes.get("result_summary", "")})
            # Execution reports are evidence only. Never mutate work_items here.
            return row(connection, m.runs, identifier)
        return self.mutate(actor, f"runs/{identifier}/events", payload, apply)

    def cancel_run(self, actor, identifier, payload):
        def apply(connection):
            value = row(connection, m.runs, identifier)
            item = row(connection, m.work_items, value["work_item_id"])
            require(value["requested_by"] == actor["id"] or self.requester(actor, item), "FORBIDDEN", "当前成员不能停止该执行。", 403)
            if value["status"] not in TERMINAL_RUNS:
                connection.execute(m.runs.update().where(m.runs.c.id == identifier).values(status="cancel_requested"))
                self.emit(connection, "run.cancel_requested", identifier, actor, {"work_item_id": value["work_item_id"]})
            return row(connection, m.runs, identifier)
        return self.mutate(actor, f"runs/{identifier}/cancel", payload, apply)

    def mark_stale_runs(self, stale_seconds=120):
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.db.write() as connection:
            old = rows(connection, select(m.runs).where(m.runs.c.status.in_(("starting", "running")), m.runs.c.last_seen_at < cutoff))
            for value in old:
                connection.execute(m.runs.update().where(m.runs.c.id == value["id"]).values(status="unknown"))
                self.emit(connection, "run.unknown", value["id"], {"id": "system"}, {"work_item_id": value["work_item_id"], "reason": "heartbeat_timeout"})
        return len(old)

    def event_feed(self, after=0, limit=100):
        with self.db.read() as connection:
            found = rows(connection, select(m.events).where(m.events.c.id > after).order_by(m.events.c.id).limit(limit + 1))
            selected = found[:limit]
            return {"events": selected, "next_cursor": selected[-1]["id"] if selected else after, "has_more": len(found) > limit}

    def list_capabilities(self, q="", kind=""):
        conditions = []
        if q:
            conditions.append(or_(m.capabilities.c.name.contains(q, autoescape=True), m.capabilities.c.description.contains(q, autoescape=True)))
        if kind:
            conditions.append(m.capabilities.c.kind == kind)
        with self.db.read() as connection:
            items = rows(connection, select(m.capabilities).where(*conditions).order_by(m.capabilities.c.created_at.desc()))
            return {"items": items, "total": len(items)}

    def capability(self, identifier):
        with self.db.read() as connection:
            value = row(connection, m.capabilities, identifier)
            value["releases"] = rows(connection, select(m.releases).where(m.releases.c.capability_id == identifier).order_by(m.releases.c.created_at.desc()))
            return value

    def release(self, identifier, version):
        with self.db.read() as connection:
            value = connection.execute(select(m.releases).where(
                m.releases.c.capability_id == identifier, m.releases.c.version == version)).mappings().first()
            require(value is not None, "NOT_FOUND", "找不到该能力版本。", 404)
            return dict(value)

    def create_capability(self, actor, payload):
        def create(connection):
            duplicate = connection.execute(select(m.capabilities.c.id).where(m.capabilities.c.slug == payload["slug"])).first()
            require(not duplicate, "SLUG_EXISTS", "此能力标识已存在。", 409)
            value = dict(id=uid("cap"), slug=payload["slug"], name=payload["name"], description=payload.get("description", ""),
                         kind=payload["kind"], owner_team_id=actor["team_id"], tags=payload.get("tags", []), latest_version=None, created_at=now())
            connection.execute(m.capabilities.insert().values(**value))
            self.emit(connection, "capability.created", value["id"], actor, {"name": value["name"]})
            return value
        return self.mutate(actor, "capabilities/create", payload, create)

    def publish_release(self, actor, identifier, payload):
        def create(connection):
            capability = row(connection, m.capabilities, identifier)
            require(actor["team_id"] == capability["owner_team_id"] or actor["role"] == "admin",
                    "FORBIDDEN", "只有维护团队可以发布能力版本。", 403)
            version = payload["version"]
            require(bool(re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version)), "INVALID_VERSION", "请使用语义化版本，例如 1.0.0。")
            existing = connection.execute(select(m.releases.c.id).where(m.releases.c.capability_id == identifier, m.releases.c.version == version)).first()
            require(not existing, "RELEASE_IMMUTABLE", "已发布版本不能覆盖，请发布新版本。", 409)
            files = payload.get("files", {})
            require(len(files) <= 100, "PACKAGE_TOO_LARGE", "单个能力包最多包含 100 个文本文件。")
            require(sum(len(content.encode("utf-8")) for content in files.values()) <= 2 * 1024 * 1024,
                    "PACKAGE_TOO_LARGE", "首版内置能力包最多 2 MiB。")
            for path, content in files.items():
                normalized = PurePosixPath(path)
                require(path and not normalized.is_absolute() and ".." not in normalized.parts
                        and "\\" not in path and ":" not in path and path == str(normalized),
                        "INVALID_PACKAGE_PATH", "能力包文件必须使用安全的相对路径。")
            manifest = payload["manifest"]
            if "version" in manifest:
                require(manifest["version"] == version, "MANIFEST_MISMATCH", "清单版本与发布版本不一致。")
            if "kind" in manifest:
                require(manifest["kind"] == capability["kind"], "MANIFEST_MISMATCH", "清单类型与目录类型不一致。")
            entry = manifest.get("entry")
            if files and isinstance(entry, str):
                require(entry in files, "ENTRY_NOT_FOUND", "能力包内找不到声明的入口。")
            value = dict(id=uid("release"), capability_id=identifier, version=version, manifest=manifest, files=files, created_at=now())
            connection.execute(m.releases.insert().values(**value))
            connection.execute(m.capabilities.update().where(m.capabilities.c.id == identifier).values(latest_version=version))
            self.emit(connection, "capability.published", identifier, actor, {"version": version, "release_id": value["id"]})
            return value
        return self.mutate(actor, f"capabilities/{identifier}/releases", payload, create)

    def toolset(self, team_id):
        with self.db.read() as connection:
            row(connection, m.teams, team_id)
            found = connection.execute(select(m.toolsets).where(m.toolsets.c.team_id == team_id)).mappings().first()
            return dict(found) if found else {"team_id": team_id, "version": 0, "items": []}

    def set_toolset(self, actor, team_id, payload):
        def apply(connection):
            row(connection, m.teams, team_id)
            require(actor["role"] == "admin" or (actor["team_id"] == team_id and actor["role"] == "lead"),
                    "FORBIDDEN", "团队推荐工具集由组长或管理员维护。", 403)
            found = connection.execute(select(m.toolsets).where(m.toolsets.c.team_id == team_id)).mappings().first()
            version = found["version"] if found else 0
            require(version == payload["expected_version"], "VERSION_CONFLICT", "团队工具集已更新，请刷新。", 409, {"current_version": version})
            self.resolve_releases(connection, payload["items"])
            identifiers = [x["capability_id"] for x in payload["items"]]
            require(len(set(identifiers)) == len(identifiers), "DUPLICATE_CAPABILITY", "同一工具集中每个能力只能选择一个版本。")
            value = {"team_id": team_id, "version": version + 1, "items": payload["items"]}
            if found:
                connection.execute(m.toolsets.update().where(m.toolsets.c.team_id == team_id).values(**value))
            else:
                connection.execute(m.toolsets.insert().values(**value))
            self.emit(connection, "toolset.updated", team_id, actor, {"version": value["version"]})
            return value
        return self.mutate(actor, f"team-toolsets/{team_id}", payload, apply)

    def create_team(self, actor, payload):
        def apply(connection):
            require(actor["role"] == "admin", "FORBIDDEN", "只有管理员可以创建团队。", 403)
            value = {"id": uid("team"), "name": payload["name"]}
            connection.execute(m.teams.insert().values(**value))
            self.emit(connection, "team.created", value["id"], actor, {"name": value["name"]})
            return value
        return self.mutate(actor, "teams/create", payload, apply)

    def create_user(self, actor, payload):
        def apply(connection):
            require(actor["role"] == "admin", "FORBIDDEN", "只有管理员可以添加成员。", 403)
            row(connection, m.teams, payload["team_id"])
            token = secrets.token_urlsafe(36)
            value = dict(id=uid("user"), name=payload["name"], team_id=payload["team_id"], role=payload.get("role", "member"), active=True, token_hash=token_hash(token))
            connection.execute(m.users.insert().values(**value))
            self.emit(connection, "member.created", value["id"], actor, {"name": value["name"], "team_id": value["team_id"]})
            return {"user": public_user(value), "token": token}
        return self.mutate(actor, "users/create", payload, apply)
