"""流水线领域规则；事项、交付和审核仍由 Hub 持有。"""
from __future__ import annotations

import hashlib
import json

from sqlalchemy import func, select

from . import db as m
from .service import ACTIVE_RUNS, now, require, row, rows, uid


def step_dependencies(steps):
    """Resolve legacy serial definitions and explicit dependency lists."""
    result = {}
    for index, step in enumerate(steps):
        explicit = step.get("depends_on")
        result[step["key"]] = list(explicit) if explicit is not None else ([steps[index - 1]["key"]] if index else [])
    return result


def definition_errors(definition):
    errors = []
    roles = definition.get("roles", [])
    steps = definition.get("steps", [])
    role_keys = [role["key"] for role in roles]
    step_keys = [step["key"] for step in steps]
    if not roles:
        errors.append("至少定义一个团队角色和一个验收角色。")
    if not steps:
        errors.append("至少定义一个工作及验收步骤。")
    if len(role_keys) != len(set(role_keys)):
        errors.append("角色标识不能重复。")
    if len(step_keys) != len(set(step_keys)):
        errors.append("步骤标识不能重复。")
    kinds = {role["key"]: role["kind"] for role in roles}
    for step in steps:
        if kinds.get(step["team_role"]) != "team":
            errors.append(f"{step['name']}需要有效的团队角色。")
        if kinds.get(step["reviewer_role"]) != "reviewer":
            errors.append(f"{step['name']}需要有效的验收角色。")
        if len(set(step["required_artifact_kinds"])) != len(step["required_artifact_kinds"]):
            errors.append(f"{step['name']}的必需材料类型不能重复。")
        capabilities = step.get("capabilities") or []
        if len({choice["capability_id"] for choice in capabilities}) != len(capabilities):
            errors.append(f"{step['name']}的能力不能重复。")
    if len(step_keys) == len(set(step_keys)):
        dependencies = step_dependencies(steps)
        for key, parents in dependencies.items():
            if len(parents) != len(set(parents)):
                errors.append(f"步骤 {key} 的依赖不能重复。")
            if any(parent not in dependencies for parent in parents):
                errors.append(f"步骤 {key} 引用了不存在的依赖。")
            if key in parents:
                errors.append(f"步骤 {key} 不能依赖自身。")
        visiting, visited = set(), set()
        def visit(key):
            if key in visiting:
                return True
            if key in visited:
                return False
            visiting.add(key)
            cyclic = any(visit(parent) for parent in dependencies[key] if parent in dependencies)
            visiting.remove(key)
            visited.add(key)
            return cyclic
        if any(visit(key) for key in dependencies if key not in visited):
            errors.append("步骤依赖不能形成环。")
    return errors


class Workflows:
    def __init__(self, hub):
        self.hub = hub

    def template_access(self, actor, template):
        require(actor["role"] == "admin" or (actor["role"] == "lead" and actor["team_id"] == template["owner_team_id"]),
                "FORBIDDEN", "只有模板所属团队负责人或管理员可以修改模板。", 403)

    def pipeline_access(self, actor, pipeline):
        require(actor["id"] == pipeline["created_by"] or actor["role"] == "admin" or
                (actor["role"] == "lead" and actor["team_id"] == pipeline["requesting_team_id"]),
                "FORBIDDEN", "只有流程发起人、发起团队负责人或管理员可以管理流程。", 403)

    def template_view(self, connection, template):
        return {**template, "versions": rows(connection, select(m.workflow_versions).where(
            m.workflow_versions.c.template_id == template["id"]).order_by(m.workflow_versions.c.version.desc()))}

    def list_templates(self):
        with self.hub.db.read() as connection:
            templates = rows(connection, select(m.workflow_templates).order_by(m.workflow_templates.c.updated_at.desc()))
            return {"items": [self.template_view(connection, template) for template in templates]}

    def get_template(self, identifier):
        with self.hub.db.read() as connection:
            return self.template_view(connection, row(connection, m.workflow_templates, identifier))

    def create_template(self, actor, payload):
        def create(connection):
            require(actor["role"] in ("admin", "lead"), "FORBIDDEN", "只有团队负责人或管理员可以创建模板。", 403)
            value = dict(id=uid("wf"), name=payload["name"], description=payload.get("description", ""),
                         owner_team_id=actor["team_id"], created_by=actor["id"], draft=payload["definition"],
                         draft_revision=1, created_at=now(), updated_at=now())
            connection.execute(m.workflow_templates.insert().values(**value))
            self.hub.emit(connection, "workflow.draft_created", value["id"], actor, {"name": value["name"]})
            return self.template_view(connection, value)
        return self.hub.mutate(actor, "workflow-templates/create", payload, create)

    def update_template(self, actor, identifier, payload):
        def update(connection):
            template = row(connection, m.workflow_templates, identifier)
            self.template_access(actor, template)
            require(template["draft"] is not None, "DRAFT_REQUIRED", "请先从已发布版本复制草稿。", 409)
            require(template["draft_revision"] == payload["expected_revision"], "VERSION_CONFLICT", "模板草稿已变化。", 409)
            connection.execute(m.workflow_templates.update().where(m.workflow_templates.c.id == identifier).values(
                name=payload["name"], description=payload.get("description", ""), draft=payload["definition"],
                draft_revision=template["draft_revision"] + 1, updated_at=now()))
            self.hub.emit(connection, "workflow.draft_updated", identifier, actor, {})
            return self.template_view(connection, row(connection, m.workflow_templates, identifier))
        return self.hub.mutate(actor, f"workflow-templates/{identifier}/update", payload, update)

    def validate_template(self, identifier):
        with self.hub.db.read() as connection:
            template = row(connection, m.workflow_templates, identifier)
            require(template["draft"] is not None, "DRAFT_REQUIRED", "当前没有可校验的草稿。", 409)
            errors = definition_errors(template["draft"])
            for step in template["draft"]["steps"]:
                if step.get("capabilities"):
                    try:
                        self.hub.resolve_releases(connection, step["capabilities"])
                    except Exception as error:
                        if getattr(error, "code", None) not in ("NOT_FOUND", "RELEASE_NOT_FOUND"):
                            raise
                        errors.append(f"{step['name']}引用了不存在的能力版本。")
            return {"valid": not errors, "errors": errors, "draft_revision": template["draft_revision"]}

    def publish_template(self, actor, identifier, payload):
        def publish(connection):
            template = row(connection, m.workflow_templates, identifier)
            self.template_access(actor, template)
            require(template["draft"] is not None, "DRAFT_REQUIRED", "当前没有可发布的草稿。", 409)
            require(template["draft_revision"] == payload["expected_revision"], "VERSION_CONFLICT", "模板草稿已变化。", 409)
            errors = definition_errors(template["draft"])
            require(not errors, "INVALID_WORKFLOW", "；".join(errors), 422, {"errors": errors})
            for step in template["draft"]["steps"]:
                if step.get("capabilities"):
                    self.hub.resolve_releases(connection, step["capabilities"])
            definition = {"name": template["name"], "description": template["description"], **template["draft"]}
            digest = hashlib.sha256(json.dumps(definition, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            version = (connection.execute(select(func.max(m.workflow_versions.c.version)).where(
                m.workflow_versions.c.template_id == identifier)).scalar_one() or 0) + 1
            release = dict(id=uid("wfv"), template_id=identifier, version=version, definition=definition,
                           sha256=digest, published_by=actor["id"], created_at=now())
            connection.execute(m.workflow_versions.insert().values(**release))
            connection.execute(m.workflow_templates.update().where(m.workflow_templates.c.id == identifier).values(
                draft=None, draft_revision=template["draft_revision"] + 1, updated_at=now()))
            self.hub.emit(connection, "workflow.published", identifier, actor, {"version_id": release["id"], "version": version})
            return release
        return self.hub.mutate(actor, f"workflow-templates/{identifier}/publish", payload, publish)

    def clone_template(self, actor, identifier, payload):
        def clone(connection):
            template = row(connection, m.workflow_templates, identifier)
            self.template_access(actor, template)
            require(template["draft"] is None, "DRAFT_EXISTS", "已有草稿，请先编辑或发布。", 409)
            version = connection.execute(select(m.workflow_versions).where(
                m.workflow_versions.c.template_id == identifier).order_by(m.workflow_versions.c.version.desc()).limit(1)).mappings().first()
            require(version is not None, "VERSION_NOT_FOUND", "模板还没有已发布版本。", 404)
            definition = version["definition"]
            draft = {"roles": definition["roles"], "steps": definition["steps"]}
            connection.execute(m.workflow_templates.update().where(m.workflow_templates.c.id == identifier).values(
                name=definition["name"], description=definition["description"], draft=draft,
                draft_revision=template["draft_revision"] + 1, updated_at=now()))
            self.hub.emit(connection, "workflow.draft_cloned", identifier, actor, {"version_id": version["id"]})
            return self.template_view(connection, row(connection, m.workflow_templates, identifier))
        return self.hub.mutate(actor, f"workflow-templates/{identifier}/clone", payload, clone)

    def create_pipeline(self, actor, payload):
        def create(connection):
            row(connection, m.projects, payload["project_id"])
            version = row(connection, m.workflow_versions, payload["template_version_id"])
            definition = version["definition"]
            roles = {role["key"]: role for role in definition["roles"]}
            bindings = payload["role_bindings"]
            require(set(bindings) == set(roles), "INVALID_BINDINGS", "请为模板中的每个角色选择团队或验收人。", 422)
            for key, role in roles.items():
                target = row(connection, m.teams if role["kind"] == "team" else m.users, bindings[key])
                if role["kind"] == "reviewer":
                    require(target["active"], "INVALID_REVIEWER", "验收人已停用。", 422)
            steps = {step["key"]: step for step in definition["steps"]}
            assignees = payload.get("assignees", {})
            require(set(assignees).issubset(steps), "INVALID_ASSIGNEE", "指定的步骤不存在。", 422)
            for key, assignee_id in assignees.items():
                member = row(connection, m.users, assignee_id)
                step = steps[key]
                require(member["active"] and member["team_id"] == bindings[step["team_role"]],
                        "INVALID_ASSIGNEE", "指定处理人必须是承接团队的有效成员。", 422)
                require(member["id"] != bindings[step["reviewer_role"]], "INDEPENDENT_REVIEW_REQUIRED", "处理人与验收人必须是不同账号。", 422)
            value = dict(id=uid("pipe"), title=payload["title"], description=payload.get("description", ""),
                         project_id=payload["project_id"], template_version_id=version["id"],
                         requesting_team_id=actor["team_id"], created_by=actor["id"], role_bindings=bindings,
                         status="draft", version=1, generation=1, blocked_reason=None,
                         priority=payload.get("priority", "normal"), due_at=payload.get("due_at"), created_at=now(), updated_at=now())
            connection.execute(m.pipelines.insert().values(**value))
            for position, step in enumerate(definition["steps"]):
                pinned = self.hub.resolve_releases(connection, step["capabilities"]) if step.get("capabilities") is not None else None
                connection.execute(m.pipeline_steps.insert().values(
                    id=uid("step"), pipeline_id=value["id"], step_key=step["key"], position=position,
                    definition=step, target_team_id=bindings[step["team_role"]], reviewer_id=bindings[step["reviewer_role"]],
                    requested_assignee_id=assignees.get(step["key"]), capability_releases=pinned, current_attempt_id=None))
            self.hub.emit(connection, "pipeline.created", value["id"], actor, {"template_version_id": version["id"]})
            return self.pipeline_view(connection, actor, value)
        return self.hub.mutate(actor, "pipelines/create", payload, create)

    def list_pipelines(self, actor):
        with self.hub.db.read() as connection:
            items = rows(connection, select(m.pipelines).order_by(m.pipelines.c.updated_at.desc()))
            return {"items": [self.pipeline_view(connection, actor, item) for item in items]}

    def get_pipeline(self, actor, identifier):
        with self.hub.db.read() as connection:
            return self.pipeline_view(connection, actor, row(connection, m.pipelines, identifier))

    def pipeline_view(self, connection, actor, pipeline):
        steps = rows(connection, select(m.pipeline_steps).where(m.pipeline_steps.c.pipeline_id == pipeline["id"]).order_by(m.pipeline_steps.c.position))
        result = []
        for step in steps:
            attempts = rows(connection, select(m.pipeline_attempts).where(m.pipeline_attempts.c.step_id == step["id"]).order_by(m.pipeline_attempts.c.ordinal))
            attempt = next((a for a in attempts if a["id"] == step["current_attempt_id"]), None)
            item = row(connection, m.work_items, attempt["work_item_id"]) if attempt else None
            state = "waiting" if not item else {"open": "awaiting_accept", "accepted": "accepted", "active": "working",
                     "review": "awaiting_review", "done": "completed", "cancelled": "cancelled"}[item["status"]]
            if item and item["status"] == "open" and not item["pending_target_team_id"]:
                state = "declined"
            result.append({**step, "attempts": attempts, "attempt": attempt, "item": item, "state": state})
        manager = actor["id"] == pipeline["created_by"] or actor["role"] == "admin" or (
            actor["role"] == "lead" and actor["team_id"] == pipeline["requesting_team_id"])
        actions = []
        if manager:
            actions = {"draft": ["start", "cancel"], "active": ["pause", "cancel"],
                       "paused": ["resume", "cancel"], "completed": [], "cancelled": []}[pipeline["status"]]
        return {"pipeline": pipeline, "template_version": row(connection, m.workflow_versions, pipeline["template_version_id"]),
                "steps": result, "allowed_actions": actions,
                "can_rollback": manager and pipeline["status"] in ("active", "paused", "completed")}

    def activate_next(self, connection, pipeline, actor):
        if pipeline["status"] != "active":
            return
        steps = rows(connection, select(m.pipeline_steps).where(m.pipeline_steps.c.pipeline_id == pipeline["id"]).order_by(m.pipeline_steps.c.position))
        dependencies = step_dependencies([step["definition"] for step in steps])
        current_items = {}
        for step in steps:
            if step["current_attempt_id"]:
                attempt = row(connection, m.pipeline_attempts, step["current_attempt_id"])
                current_items[step["step_key"]] = row(connection, m.work_items, attempt["work_item_id"])
        blocked = []
        for step in steps:
            key = step["step_key"]
            if key in current_items:
                continue
            parents = dependencies[key]
            if any(parent not in current_items or current_items[parent]["status"] != "done" for parent in parents):
                continue
            reviewer = row(connection, m.users, step["reviewer_id"])
            if not reviewer["active"]:
                blocked.append(step["definition"]["name"])
                continue
            definition = step["definition"]
            pinned = step["capability_releases"]
            if pinned is None:
                toolset = connection.execute(select(m.toolsets).where(m.toolsets.c.team_id == step["target_team_id"])).mappings().first()
                pinned = self.hub.resolve_releases(connection, toolset["items"] if toolset else [])
                connection.execute(m.pipeline_steps.update().where(m.pipeline_steps.c.id == step["id"]).values(capability_releases=pinned))
            requester = {"id": pipeline["created_by"], "team_id": pipeline["requesting_team_id"]}
            description = "\n\n".join(part for part in (pipeline["description"], definition.get("description", "")) if part)
            item = self.hub.create_item_in_tx(connection, requester, {
                "title": f"{pipeline['title']} · {definition['name']}", "description": description,
                "project_id": pipeline["project_id"], "target_team_id": step["target_team_id"],
                "reviewer_id": step["reviewer_id"], "acceptance_spec": definition["acceptance_spec"],
                "priority": pipeline["priority"], "due_at": pipeline["due_at"]}, event_actor=actor)
            upstream = []
            for parent in parents:
                source = current_items[parent]
                if source["current_delivery_id"]:
                    delivery = row(connection, m.deliveries, source["current_delivery_id"])
                    upstream.append({"work_item_id": source["id"], "delivery_id": delivery["id"],
                                     "spec_revision": delivery["spec_revision"], "summary": delivery["summary"],
                                     "artifacts": delivery["artifacts"]})
            ordinal = (connection.execute(select(func.max(m.pipeline_attempts.c.ordinal)).where(
                m.pipeline_attempts.c.step_id == step["id"])).scalar_one() or 0) + 1
            attempt = dict(id=uid("attempt"), step_id=step["id"], ordinal=ordinal, work_item_id=item["id"],
                           input_snapshot={"upstream_deliveries": upstream}, created_at=now(), ended_at=None)
            connection.execute(m.pipeline_attempts.insert().values(**attempt))
            connection.execute(m.pipeline_steps.update().where(m.pipeline_steps.c.id == step["id"]).values(current_attempt_id=attempt["id"]))
            current_items[key] = item
            self.hub.emit(connection, "pipeline.step_activated", pipeline["id"], actor,
                          {"step_id": step["id"], "attempt_id": attempt["id"], "work_item_id": item["id"]})
        if len(current_items) == len(steps) and all(item["status"] == "done" for item in current_items.values()):
            connection.execute(m.pipelines.update().where(m.pipelines.c.id == pipeline["id"]).values(
                status="completed", blocked_reason=None, version=m.pipelines.c.version + 1, updated_at=now()))
            self.hub.emit(connection, "pipeline.completed", pipeline["id"], actor, {})
        else:
            reason = f"步骤验收人已停用：{'、'.join(blocked)}。" if blocked else None
            connection.execute(m.pipelines.update().where(m.pipelines.c.id == pipeline["id"]).values(
                blocked_reason=reason, updated_at=now()))

    def control(self, actor, identifier, action, payload):
        def apply(connection):
            pipeline = row(connection, m.pipelines, identifier)
            self.pipeline_access(actor, pipeline)
            require(pipeline["version"] == payload["expected_version"], "VERSION_CONFLICT", "流程已变化，请刷新。", 409)
            allowed = {"start": "draft", "pause": "active", "resume": "paused"}
            if action in allowed:
                require(pipeline["status"] == allowed[action], "INVALID_STATE", "流程当前不能执行此操作。", 409)
                status = "paused" if action == "pause" else "active"
                connection.execute(m.pipelines.update().where(m.pipelines.c.id == identifier).values(
                    status=status, version=pipeline["version"] + 1, updated_at=now()))
                current = row(connection, m.pipelines, identifier)
                self.hub.emit(connection, f"pipeline.{action}", identifier, actor, {})
                if status == "active":
                    self.activate_next(connection, current, actor)
            elif action == "cancel":
                require(pipeline["status"] in ("draft", "active", "paused"), "INVALID_STATE", "流程已经结束。", 409)
                steps = rows(connection, select(m.pipeline_steps).where(m.pipeline_steps.c.pipeline_id == identifier))
                for step in steps:
                    if not step["current_attempt_id"]:
                        continue
                    attempt = row(connection, m.pipeline_attempts, step["current_attempt_id"])
                    item = row(connection, m.work_items, attempt["work_item_id"])
                    if item["status"] not in ("done", "cancelled"):
                        self.hub.change_item(connection, item, status="cancelled", pending_target_team_id=None, next_action="流程已取消")
                        for run in rows(connection, select(m.runs).where(m.runs.c.work_item_id == item["id"], m.runs.c.status.in_(ACTIVE_RUNS))):
                            connection.execute(m.runs.update().where(m.runs.c.id == run["id"]).values(status="cancel_requested"))
                            self.hub.emit(connection, "run.cancel_requested", run["id"], actor, {"work_item_id": item["id"]})
                connection.execute(m.pipelines.update().where(m.pipelines.c.id == identifier).values(
                    status="cancelled", generation=pipeline["generation"] + 1, version=pipeline["version"] + 1, updated_at=now()))
                self.hub.emit(connection, "pipeline.cancel", identifier, actor, {})
            else:
                require(False, "UNKNOWN_ACTION", "不支持的流程操作。", 404)
            return self.pipeline_view(connection, actor, row(connection, m.pipelines, identifier))
        return self.hub.mutate(actor, f"pipelines/{identifier}/{action}", payload, apply)

    def rollback(self, actor, identifier, step_key, payload):
        """Invalidate a step and its descendants while preserving their evidence."""
        def apply(connection):
            pipeline = row(connection, m.pipelines, identifier)
            self.pipeline_access(actor, pipeline)
            require(pipeline["version"] == payload["expected_version"], "VERSION_CONFLICT", "流程已变化，请刷新。", 409)
            require(pipeline["status"] in ("active", "paused", "completed"), "INVALID_STATE", "当前流程无法回退。", 409)
            steps = rows(connection, select(m.pipeline_steps).where(m.pipeline_steps.c.pipeline_id == identifier).order_by(m.pipeline_steps.c.position))
            by_key = {step["step_key"]: step for step in steps}
            target = by_key.get(step_key)
            require(target is not None and target["current_attempt_id"], "STEP_NOT_ACTIVE", "只能回退已激活的步骤。", 409)
            dependencies = step_dependencies([step["definition"] for step in steps])
            affected = {step_key}
            while True:
                expanded = affected | {key for key, parents in dependencies.items() if affected.intersection(parents)}
                if expanded == affected:
                    break
                affected = expanded
            for key in affected:
                step = by_key[key]
                if not step["current_attempt_id"]:
                    continue
                attempt = row(connection, m.pipeline_attempts, step["current_attempt_id"])
                active = connection.execute(select(m.runs.c.id).where(
                    m.runs.c.work_item_id == attempt["work_item_id"], m.runs.c.status.in_(ACTIVE_RUNS))).first()
                require(not active, "RUN_NOT_FINISHED", "受回退影响的步骤仍有未确认结束的执行，请先确认停止或完成。", 409)
            invalidated = []
            for step in steps:
                if step["step_key"] not in affected or not step["current_attempt_id"]:
                    continue
                attempt = row(connection, m.pipeline_attempts, step["current_attempt_id"])
                item = row(connection, m.work_items, attempt["work_item_id"])
                connection.execute(m.pipeline_attempts.update().where(m.pipeline_attempts.c.id == attempt["id"]).values(ended_at=now()))
                if item["status"] not in ("done", "cancelled"):
                    self.hub.change_item(connection, item, status="cancelled", pending_target_team_id=None,
                                         next_action="流程回退，当前轮次已失效")
                connection.execute(m.pipeline_steps.update().where(m.pipeline_steps.c.id == step["id"]).values(current_attempt_id=None))
                invalidated.append({"step_key": step["step_key"], "attempt_id": attempt["id"], "work_item_id": item["id"]})
            status = "active" if pipeline["status"] == "completed" else pipeline["status"]
            connection.execute(m.pipelines.update().where(m.pipelines.c.id == identifier).values(
                status=status, generation=pipeline["generation"] + 1, version=pipeline["version"] + 1,
                blocked_reason=None, updated_at=now()))
            self.hub.emit(connection, "pipeline.rollback", identifier, actor,
                          {"step_key": step_key, "reason": payload["reason"], "invalidated": invalidated})
            if status == "active":
                self.activate_next(connection, row(connection, m.pipelines, identifier), actor)
            return self.pipeline_view(connection, actor, row(connection, m.pipelines, identifier))
        return self.hub.mutate(actor, f"pipelines/{identifier}/steps/{step_key}/rollback", payload, apply)

    def reassign(self, actor, identifier, step_key, payload):
        def apply(connection):
            pipeline = row(connection, m.pipelines, identifier)
            self.pipeline_access(actor, pipeline)
            require(pipeline["version"] == payload["expected_version"], "VERSION_CONFLICT", "流程已变化，请刷新。", 409)
            require(pipeline["status"] in ("active", "paused"), "INVALID_STATE", "当前流程无法重新指派。", 409)
            step = connection.execute(select(m.pipeline_steps).where(m.pipeline_steps.c.pipeline_id == identifier,
                m.pipeline_steps.c.step_key == step_key)).mappings().first()
            require(step is not None and step["current_attempt_id"], "STEP_NOT_ACTIVE", "该步骤尚未激活。", 409)
            attempt = row(connection, m.pipeline_attempts, step["current_attempt_id"])
            item = row(connection, m.work_items, attempt["work_item_id"])
            require(item["status"] == "open" and item["pending_target_team_id"] is None, "INVALID_STATE", "只能重新指派已拒收的请求。", 409)
            row(connection, m.teams, payload["target_team_id"])
            self.hub.change_item(connection, item, pending_target_team_id=payload["target_team_id"], next_action=payload["reason"],
                                 assignment_generation=item["assignment_generation"] + 1)
            # Explicit template pins remain fixed; otherwise resolve the new team's toolset.
            pinned = step["capability_releases"]
            if step["definition"].get("capabilities") is None:
                toolset = connection.execute(select(m.toolsets).where(m.toolsets.c.team_id == payload["target_team_id"])).mappings().first()
                pinned = self.hub.resolve_releases(connection, toolset["items"] if toolset else [])
            connection.execute(m.pipeline_steps.update().where(m.pipeline_steps.c.id == step["id"]).values(
                target_team_id=payload["target_team_id"], requested_assignee_id=None, capability_releases=pinned))
            connection.execute(m.pipelines.update().where(m.pipelines.c.id == identifier).values(version=pipeline["version"] + 1, updated_at=now()))
            self.hub.emit(connection, "pipeline.step_reassigned", identifier, actor, {"step_id": step["id"], "work_item_id": item["id"], "reason": payload["reason"]})
            return self.pipeline_view(connection, actor, row(connection, m.pipelines, identifier))
        return self.hub.mutate(actor, f"pipelines/{identifier}/steps/{step_key}/reassign", payload, apply)

    def context(self, connection, work_item_id):
        attempt = connection.execute(select(m.pipeline_attempts).where(m.pipeline_attempts.c.work_item_id == work_item_id)
                                     .order_by(m.pipeline_attempts.c.ordinal.desc()).limit(1)).mappings().first()
        if not attempt:
            return None
        attempt = dict(attempt)
        step = row(connection, m.pipeline_steps, attempt["step_id"])
        pipeline = row(connection, m.pipelines, step["pipeline_id"])
        return {"pipeline_id": pipeline["id"], "pipeline_status": pipeline["status"], "generation": pipeline["generation"],
                "step_id": step["id"], "step_key": step["step_key"], "attempt_id": attempt["id"], "ordinal": attempt["ordinal"],
                "current": step["current_attempt_id"] == attempt["id"], "required_artifact_kinds": step["definition"]["required_artifact_kinds"],
                "requested_assignee_id": step["requested_assignee_id"], "capability_releases": step["capability_releases"],
                "input_snapshot": attempt["input_snapshot"]}

    def guard(self, connection, item, payload, action):
        context = self.context(connection, item["id"])
        if context is None:
            return None
        permitted_statuses = ("active", "paused", "completed", "cancelled") if action == "bindings" else ("active", "paused")
        require(context["current"] and context["pipeline_status"] in permitted_statuses,
                "STALE_PIPELINE_ATTEMPT", "流程轮次已失效或流程已结束。", 409)
        require(payload.get("pipeline_attempt_id") == context["attempt_id"] and payload.get("pipeline_generation") == context["generation"],
                "PIPELINE_CONTEXT_REQUIRED", "请读取当前流程轮次后再操作。", 409, context)
        require(not (context["pipeline_status"] == "paused" and action in ("start", "runs")),
                "PIPELINE_PAUSED", "流程已暂停，不能开始新的处理或执行。", 409)
        require(action not in ("cancel", "dependencies"), "PIPELINE_CONTROL_REQUIRED", "请在流程中管理取消和步骤顺序。", 409)
        return context

    def new_attempt(self, connection, context, actor, reason):
        previous = row(connection, m.pipeline_attempts, context["attempt_id"])
        connection.execute(m.pipeline_attempts.update().where(m.pipeline_attempts.c.id == previous["id"]).values(ended_at=now()))
        attempt = dict(id=uid("attempt"), step_id=previous["step_id"], ordinal=previous["ordinal"] + 1,
                       work_item_id=previous["work_item_id"], input_snapshot=previous["input_snapshot"], created_at=now(), ended_at=None)
        connection.execute(m.pipeline_attempts.insert().values(**attempt))
        connection.execute(m.pipeline_steps.update().where(m.pipeline_steps.c.id == context["step_id"]).values(current_attempt_id=attempt["id"]))
        connection.execute(m.pipelines.update().where(m.pipelines.c.id == context["pipeline_id"]).values(
            version=m.pipelines.c.version + 1, updated_at=now()))
        self.hub.emit(connection, "pipeline.step_rework", context["pipeline_id"], actor,
                      {"step_id": context["step_id"], "attempt_id": attempt["id"], "work_item_id": previous["work_item_id"], "reason": reason})
        return attempt
