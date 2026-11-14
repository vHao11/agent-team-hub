export type RunStatus = 'queued'|'starting'|'running'|'waiting_input'|'succeeded'|'failed'|'cancel_requested'|'cancelled'|'unknown';
export interface AdapterCapabilities { available: boolean; reason?: string; version?: string; protocol_version?: 1; kind?: 'board'|'executor'; canCancel?: boolean; canRecover?: boolean; canLinkItem?: boolean; canSync?: boolean; canDetach?: boolean; }
export interface BoardAdapter {
  probe(): Promise<AdapterCapabilities>;
  ensureLinkedCard(input: {external_ref:string;item:Record<string,unknown>;workspace_ref:string;snapshot?:PipelineBoardSnapshot;draftId?:string}): Promise<{local_todo_id:string;session_id?:string}>;
  detachPipeline?(input: {pipelineId:string;hubBase:string}): Promise<{detached:number}>;
  setSyncStatus?(state:'idle'|'synced'|'degraded'|'offline'): Promise<void>;
  updateSharedFields?(input: {local_todo_id:string;fields:Record<string,unknown>;event_id:number}): Promise<void>;
}
export interface PipelineBoardSnapshot {
  schemaVersion:1; externalRef:string; itemId:string; pipelineId:string; stepKey:string; attemptId:string;
  generation:number; pipelineVersion:number; itemVersion:number; status:string; pipelineStatus:string;
  title:string; ownerTeamId:string; pendingTargetTeamId:string|null; assigneeId:string|null;
  reviewerId:string; sourceUpdatedAt:string;
}
export interface RunHandle { session_id?:string; run_id?:string; status?:'queued'|'starting'|'running'|'waiting_input'; }
export interface InputSnapshot {
  title:string;
  description:string;
  acceptance_spec:string[];
  spec_revision:number;
  capability_releases:unknown[];
}
export interface ExecutionAdapter {
  probe(): Promise<AdapterCapabilities>;
  start(input: {item_id:string;dispatch_id:string;run_id:string;workspace_ref:string;capability_releases:unknown[];input_snapshot:InputSnapshot;spec_revision:number;assignment_generation:number}): Promise<RunHandle>;
  getStatus(handle: RunHandle): Promise<{status:Exclude<RunStatus,'cancel_requested'>;summary?:string}>;
  cancel?(handle: RunHandle): Promise<{requested:boolean;confirmed:boolean}>;
  findByDispatchId?(dispatchId:string): Promise<RunHandle|null>;
}
