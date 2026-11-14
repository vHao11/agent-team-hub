export type Status = 'open' | 'accepted' | 'active' | 'review' | 'done' | 'cancelled';
export type Priority = 'normal' | 'high' | 'urgent';
export type View = 'all' | 'mine' | 'requested' | 'review' | 'inbox';
export type Page = 'ledger' | 'mine' | 'inbox' | 'capabilities' | 'toolsets' | 'connections' | 'workflows' | 'pipelines';
export interface User { id: string; name: string; team_id: string; role: string }
export interface Team { id: string; name: string }
export interface Project { id: string; name: string }
export interface Identity { id: string; name: string; team_id: string; token: string }
export interface Bootstrap { me: User; teams: Team[]; users: User[]; projects: Project[]; demo_mode: boolean }
export interface WorkItem {
  id: string; number: string; title: string; description: string; project_id: string;
  requesting_team_id: string; owner_team_id: string; pending_target_team_id: string | null;
  assignee_id: string | null; reviewer_id: string; status: Status; priority: Priority;
  due_at: string | null; acceptance_spec: string[]; blocked_reason: string | null;
  waiting_on: string | null; next_action: string | null; version: number; spec_revision: number;
  current_delivery_id: string | null; created_at: string; updated_at: string;
}
export interface ItemList { items: WorkItem[]; total: number; limit: number; offset: number }
export interface Artifact { id?: string; label: string; url: string; kind?: string; size?: number; content_type?: string }
export interface Progress { id: string; summary: string; author_id?: string; actor_id?: string; blocked_reason?: string | null; waiting_on?: string | null; next_action?: string | null; created_at: string }
export interface Delivery { id: string; work_item_id: string; sequence: number; spec_revision: number; summary: string; artifacts: Artifact[]; run_ids: string[]; submitted_by: string; created_at: string }
export interface Review { id: string; delivery_id: string; decision: 'approve' | 'request_changes'; reason: string | null; reviewer_id?: string; actor_id?: string; created_at: string }
export type RunStatus = 'queued' | 'starting' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
export interface Run { id: string; dispatch_id: string; work_item_id: string; client_instance_id: string; harness: string; workspace_ref: string; requested_by: string; status: RunStatus; external_session_id: string | null; external_run_id: string | null; capability_releases: { capability_id: string; version: string }[]; result_summary: string | null; created_at: string; last_seen_at: string; sequence: number }
export interface Binding { id: string; client_instance_id: string; harness: string; workspace_ref: string; local_todo_id?: string | null; session_id?: string | null }
export interface HubEvent { id: number; type: string; entity_id: string; actor_id: string; payload: Record<string, unknown>; created_at: string }
export interface PipelineContext { pipeline_id: string; pipeline_status: string; generation: number; step_id: string; step_key: string; attempt_id: string; ordinal: number; current: boolean; required_artifact_kinds: string[]; requested_assignee_id: string | null; capability_releases: ToolsetItem[] | null; input_snapshot: { upstream_deliveries: { delivery_id: string; work_item_id: string; summary: string; artifacts: Artifact[] }[] } }
export interface ItemDetail { item: WorkItem; progress: Progress[]; deliveries: Delivery[]; reviews: Review[]; runs: Run[]; bindings: Binding[]; events: HubEvent[]; dependencies: WorkItem[]; allowed_actions: string[]; pipeline_context: PipelineContext | null }
export interface WorkflowRole { key: string; label: string; kind: 'team' | 'reviewer' }
export interface WorkflowStepDefinition { key: string; name: string; description: string; team_role: string; reviewer_role: string; acceptance_spec: string[]; required_artifact_kinds: string[]; capabilities?: ToolsetItem[] | null; depends_on?: string[] | null }
export interface WorkflowDefinition { roles: WorkflowRole[]; steps: WorkflowStepDefinition[] }
export interface WorkflowVersion { id: string; template_id: string; version: number; definition: WorkflowDefinition & { name: string; description: string }; sha256: string; created_at: string }
export interface WorkflowTemplate { id: string; name: string; description: string; owner_team_id: string; draft: WorkflowDefinition | null; draft_revision: number; versions: WorkflowVersion[] }
export interface Pipeline { id: string; title: string; description: string; project_id: string; template_version_id: string; requesting_team_id: string; created_by: string; role_bindings: Record<string, string>; status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled'; version: number; generation: number; blocked_reason: string | null; priority: Priority; due_at: string | null; created_at: string; updated_at: string }
export interface PipelineAttempt { id: string; ordinal: number; work_item_id: string; input_snapshot: PipelineContext['input_snapshot']; created_at: string; ended_at: string | null }
export interface PipelineStepView { id: string; step_key: string; position: number; definition: WorkflowStepDefinition; target_team_id: string; reviewer_id: string; requested_assignee_id: string | null; capability_releases: ToolsetItem[] | null; attempt: PipelineAttempt | null; attempts: PipelineAttempt[]; item: WorkItem | null; state: string }
export interface PipelineView { pipeline: Pipeline; template_version: WorkflowVersion; steps: PipelineStepView[]; allowed_actions: string[]; can_rollback: boolean }
export type CapabilityKind = 'skill' | 'script' | 'mcp' | 'plugin' | 'workflow' | 'app';
export interface Capability { id: string; slug: string; name: string; description: string; kind: CapabilityKind; owner_team_id: string; tags: string[]; latest_version: string | null; releases?: Release[] }
export interface Release { id: string; capability_id: string; version: string; manifest: Record<string, unknown>; files: Record<string, string>; created_at: string }
export interface ToolsetItem { capability_id: string; version: string }
export interface Toolset { team_id: string; version: number; items: ToolsetItem[] }
