from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
LongText = Annotated[str, StringConstraints(max_length=50000)]
Criterion = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=3000)]
Criteria = Annotated[list[Criterion], Field(min_length=1, max_length=100)]
Kind = Literal['skill', 'script', 'mcp', 'plugin', 'workflow', 'app']
RunStatus = Literal['queued', 'starting', 'running', 'waiting_input', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown']


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Mutation(Input):
    operation_id: Annotated[str, StringConstraints(min_length=4, max_length=200)]
    pipeline_attempt_id: Identifier | None = None
    pipeline_generation: int | None = Field(default=None, ge=1)


class Versioned(Mutation):
    expected_version: int = Field(ge=1)


class CreateItem(Mutation):
    title: ShortText
    description: LongText = ''
    project_id: Identifier
    target_team_id: Identifier
    reviewer_id: Identifier | None = None
    priority: Literal['normal', 'high', 'urgent'] = 'normal'
    due_at: str | None = None
    acceptance_spec: Criteria

    @field_validator('due_at')
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value


class Accept(Versioned):
    assignee_id: Identifier | None = None


class Reason(Versioned):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]


class Transfer(Reason):
    target_team_id: Identifier


class Progress(Versioned):
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]
    blocked_reason: LongText | None = None
    waiting_on: Annotated[str, StringConstraints(max_length=500)] | None = None
    next_action: LongText | None = None


class Spec(Reason):
    description: LongText = ''
    acceptance_spec: Criteria


class Dependency(Versioned):
    depends_on_id: Identifier


class ArtifactLink(Input):
    label: ShortText
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]
    kind: str = 'document'


class Delivery(Versioned):
    spec_revision: int = Field(ge=1)
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50000)]
    artifacts: list[ArtifactLink] = Field(min_length=1, max_length=100)
    run_ids: list[Identifier] = Field(default_factory=list, max_length=100)


class Review(Versioned):
    decision: Literal['approve', 'request_changes']
    reason: LongText = ''


class Binding(Mutation):
    client_instance_id: Identifier
    harness: Identifier
    workspace_ref: ShortText
    local_todo_id: Identifier | None = None
    session_id: Identifier | None = None


class CapabilityChoice(Input):
    capability_id: Identifier
    version: Identifier


class CreateRun(Versioned):
    client_instance_id: Identifier
    harness: Identifier
    workspace_ref: ShortText
    capabilities: list[CapabilityChoice] | None = Field(default=None, max_length=100)
    external_session_id: Identifier | None = None


class RunEvent(Mutation):
    client_instance_id: Identifier
    sequence: int = Field(ge=1)
    status: RunStatus
    summary: LongText = ''
    external_session_id: Identifier | None = None
    external_run_id: Identifier | None = None


class Capability(Mutation):
    slug: Annotated[str, StringConstraints(min_length=1, max_length=160, pattern=r'^[a-z0-9][a-z0-9._/-]*$')]
    name: ShortText
    description: LongText = ''
    kind: Kind
    tags: list[ShortText] = Field(default_factory=list, max_length=30)


class Release(Mutation):
    version: Identifier
    manifest: dict[str, Any]
    files: dict[str, str] = Field(default_factory=dict)


class Toolset(Mutation):
    expected_version: int = Field(ge=0)
    items: list[CapabilityChoice] = Field(max_length=100)


class Team(Mutation):
    name: ShortText


class User(Team):
    team_id: Identifier
    role: Literal['member', 'lead', 'admin'] = 'member'


class WorkflowRole(Input):
    key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')]
    label: ShortText
    kind: Literal['team', 'reviewer']


class WorkflowStep(Input):
    key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')]
    name: ShortText
    description: LongText = ''
    team_role: Identifier
    reviewer_role: Identifier
    acceptance_spec: Criteria
    required_artifact_kinds: list[ShortText] = Field(min_length=1, max_length=20)
    capabilities: list[CapabilityChoice] | None = Field(default=None, max_length=100)
    # Missing/null preserves the original serial order; [] is an independent root.
    depends_on: list[Identifier] | None = Field(default=None, max_length=30)


class WorkflowDefinition(Input):
    roles: list[WorkflowRole] = Field(max_length=40)
    steps: list[WorkflowStep] = Field(max_length=30)


class WorkflowCreate(Mutation):
    name: ShortText
    description: LongText = ''
    definition: WorkflowDefinition


class WorkflowUpdate(WorkflowCreate):
    expected_revision: int = Field(ge=1)


class WorkflowPublish(Mutation):
    expected_revision: int = Field(ge=1)


class PipelineCreate(Mutation):
    title: ShortText
    description: LongText = ''
    project_id: Identifier
    template_version_id: Identifier
    role_bindings: dict[str, Identifier] = Field(max_length=40)
    assignees: dict[str, Identifier] = Field(default_factory=dict, max_length=30)
    priority: Literal['normal', 'high', 'urgent'] = 'normal'
    due_at: str | None = None

    @field_validator('due_at')
    @classmethod
    def valid_date(cls, value):
        if value is not None:
            datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value


class PipelineReassign(Versioned):
    target_team_id: Identifier
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]


class PipelineRollback(Versioned):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]


COMMANDS = {
    'accept': Accept, 'decline': Reason, 'start': Versioned, 'cancel': Reason,
    'transfer-requests': Transfer, 'accept-transfer': Accept, 'progress': Progress,
    'spec': Spec, 'dependencies': Dependency,
}
