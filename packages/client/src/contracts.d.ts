export type RunStatus = 'queued'|'starting'|'running'|'waiting_input'|'succeeded'|'failed'|'cancel_requested'|'cancelled'|'unknown';
export interface AdapterCapabilities { available: boolean; reason?: string; version?: string; canCancel?: boolean; canRecover?: boolean; }
export interface BoardAdapter {
  probe(): Promise<AdapterCapabilities>;
  ensureLinkedCard(input: {external_ref:string;item:Record<string,unknown>;workspace_ref:string}): Promise<{local_todo_id:string;session_id?:string}>;
  updateSharedFields?(input: {local_todo_id:string;fields:Record<string,unknown>;event_id:number}): Promise<void>;
}
export interface RunHandle { session_id?:string; run_id?:string; }
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
  getStatus(handle: RunHandle): Promise<{status:RunStatus;summary?:string}>;
  cancel?(handle: RunHandle): Promise<{requested:boolean;confirmed:boolean}>;
  findByDispatchId?(dispatchId:string): Promise<RunHandle|null>;
}
