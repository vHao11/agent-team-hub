import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HubError, operationId } from './index.mjs';
import { clientInstanceId, defaultStateDir, safeKey, writeJsonAtomic } from './state.mjs';
import { prepareRuntimeCapabilities } from './runtime-capabilities.mjs';

function derivedOperationId(original, suffix) {
  const combined = `${original}-${suffix}`;
  return combined.length <= 200 ? combined : `local-${suffix}-${createHash('sha256').update(String(original)).digest('hex')}`;
}

/** Registry is owned by this project, not an undocumented DSH host API. */
export class AdapterRegistry {
  constructor() { this.boards = new Map(); this.executors = new Map(); }
  registerBoard(name, adapter) { return this.register(this.boards, name, adapter, ['probe', 'ensureLinkedCard']); }
  registerExecutor(name, adapter) { return this.register(this.executors, name, adapter, ['probe', 'start', 'getStatus']); }
  register(map, name, adapter, methods) {
    if (!name || methods.some(method => typeof adapter?.[method] !== 'function')) throw new HubError('INVALID_ADAPTER', `Adapter ${name} is missing required methods.`);
    if (map.has(name)) throw new HubError('ADAPTER_EXISTS', `Adapter ${name} is already registered.`);
    map.set(name, adapter); return () => { if (map.get(name) === adapter) map.delete(name); };
  }
  async probe() {
    const inspect = async (map, kind) => Promise.all([...map].map(async ([name, adapter]) => {
      try {
        const result = await adapter.probe();
        if (!result || typeof result.available !== 'boolean' || (result.protocol_version !== undefined && result.protocol_version !== 1)
            || (result.kind !== undefined && result.kind !== kind)) throw new HubError('UNSUPPORTED_ADAPTER_VERSION', 'Adapter description is invalid or incompatible.');
        return { ...result, name };
      }
      catch (error) { return { name, available: false, reason: error.message }; }
    }));
    return { boards: await inspect(this.boards, 'board'), executors: await inspect(this.executors, 'executor') };
  }
}

/** Third-party integration plugins register known public host methods here. */
export const adapters = new AdapterRegistry();

export class LocalBridge {
  constructor(client, { registry = adapters, stateDir = defaultStateDir(), instanceId } = {}) {
    this.client = client; this.registry = registry; this.stateDir = stateDir; this.instanceId = instanceId;
  }
  async instance() { return this.instanceId || await clientInstanceId(this.stateDir); }
  async requireAdapter(map, name) {
    const adapter = map.get(name);
    if (!adapter) throw new HubError('ADAPTER_UNAVAILABLE', `No ${name} adapter is registered. Use explicit session binding, or connect the real host adapter first.`, { details: { status: 'unsupported', adapter: name } });
    const capabilities = await adapter.probe();
    if (!capabilities || typeof capabilities.available !== 'boolean') throw new HubError('INVALID_ADAPTER_RESULT', 'Adapter probe must report whether it is available.');
    if (capabilities.protocol_version !== undefined && capabilities.protocol_version !== 1) throw new HubError('UNSUPPORTED_ADAPTER_VERSION', 'Adapter protocol version is not supported.');
    const kind = map === this.registry.boards ? 'board' : 'executor';
    if (capabilities.kind !== undefined && capabilities.kind !== kind) throw new HubError('INVALID_ADAPTER_RESULT', 'Adapter kind does not match its registration.');
    if (!capabilities.available) throw new HubError('ADAPTER_UNAVAILABLE', capabilities.reason || `${name} is unavailable.`, { details: { status: 'unsupported', adapter: name } });
    return adapter;
  }
  async linkBoard(itemId, { adapter: name, workspace_ref, operation_id = operationId() }) {
    const adapter = await this.requireAdapter(this.registry.boards, name);
    const capabilities = await adapter.probe();
    if (capabilities.canLinkItem === false) throw new HubError('BOARD_ITEM_UNSUPPORTED', 'This adapter only supports pipeline items.');
    const { item, pipeline_context: context } = await this.client.getItem(itemId); const instance = await this.instance();
    const result = await adapter.ensureLinkedCard({ external_ref: `${this.client.base}:${item.id}`, item, workspace_ref });
    if (!result?.local_todo_id) throw new HubError('INVALID_ADAPTER_RESULT', 'Board adapter did not return a stable card id.');
    return this.client.bindItem(item.id, { operation_id, client_instance_id: instance, harness: name,
      workspace_ref, local_todo_id: String(result.local_todo_id), session_id: result.session_id ?? null,
      ...(context ? { pipeline_attempt_id: context.attempt_id, pipeline_generation: context.generation } : {}) });
  }
  async start(itemId, { adapter: name, expected_version, workspace_ref, capabilities, pipeline_attempt_id, pipeline_generation, operation_id = operationId() }) {
    const adapter = await this.requireAdapter(this.registry.executors, name);
    const adapterCapabilities = await adapter.probe();
    const instance = await this.instance();
    const run = await this.client.createRun(itemId, { operation_id, expected_version, client_instance_id: instance,
      harness: name, workspace_ref, ...(capabilities ? { capabilities } : {}),
      ...(pipeline_attempt_id ? { pipeline_attempt_id } : {}), ...(pipeline_generation ? { pipeline_generation } : {}) });
    const directory = path.join(this.stateDir, 'dispatches'); await fs.mkdir(directory, { recursive: true });
    const recordFile = path.join(directory, safeKey(run.dispatch_id) + '.json');
    const reservation = { dispatch_id: run.dispatch_id, run_id: run.id, item_id: itemId, base: this.client.base,
      client_instance_id: instance, actor_id: run.requested_by ?? null, adapter: name, phase: 'reserved', sequence: run.sequence || 0, created_at: new Date().toISOString() };
    try { await fs.writeFile(recordFile, JSON.stringify(reservation), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(recordFile, 'utf8'));
      if (previous.base !== this.client.base || previous.run_id !== run.id || previous.item_id !== itemId || previous.adapter !== name
          || previous.client_instance_id !== instance || (previous.actor_id && previous.actor_id !== run.requested_by)) {
        throw new HubError('DISPATCH_CONFLICT', 'Existing dispatch reservation belongs to a different context.');
      }
      return { run: await this.client.getRun(run.id), launch_replayed: false,
        requires_reconciliation: !previous.handle, handle: previous.handle ?? null };
    }
    let hostStartAttempted = false;
    try {
      let installed;
      if (adapterCapabilities.canInstallCapabilities === true) {
        try { installed = await prepareRuntimeCapabilities(this.client, workspace_ref, run.dispatch_id, run.capability_releases); }
        catch (error) { throw new HubError('ADAPTER_PRECONDITION_FAILED', `固定能力安装未完成：${error.message}`); }
        await writeJsonAtomic(recordFile, { ...reservation, phase: 'prepared', installed_capabilities: installed });
        const latest = await this.client.getRun(run.id);
        if (latest.status === 'cancel_requested') {
          const cancelled = await this.client.reportRun(run.id, { operation_id: derivedOperationId(operation_id, 'cancelled-before-start'),
            client_instance_id: instance, sequence: latest.sequence + 1, status: 'cancelled', summary: 'Execution was cancelled before the host started.' });
          await writeJsonAtomic(recordFile, { ...reservation, phase: 'cancelled-before-start', installed_capabilities: installed, sequence: cancelled.sequence });
          return { run: cancelled, launch_replayed: false, cancelled_before_start: true };
        }
      }
      hostStartAttempted = true;
      const handle = await adapter.start({ item_id: itemId, dispatch_id: run.dispatch_id, run_id: run.id,
        workspace_ref, capability_releases: run.capability_releases,
        input_snapshot: run.input_snapshot, spec_revision: run.spec_revision,
        assignment_generation: run.assignment_generation, ...(installed ? { installed_capabilities: installed } : {}) });
      if (!handle || (!handle.session_id && !handle.run_id)) throw new HubError('INVALID_ADAPTER_RESULT', 'Execution adapter returned no stable session or run id.');
      const initialStatus = handle.status ?? 'starting';
      if (!['queued', 'starting', 'running', 'waiting_input'].includes(initialStatus)) throw new HubError('INVALID_ADAPTER_RESULT', 'Execution adapter returned an invalid initial status.');
      await writeJsonAtomic(recordFile, { ...reservation, phase: 'launched', handle, ...(installed ? { installed_capabilities: installed } : {}) });
      const report = await this.client.reportRun(run.id, { operation_id: derivedOperationId(operation_id, 'started'), client_instance_id: instance,
        sequence: reservation.sequence + 1, status: initialStatus, external_session_id: handle.session_id ?? null,
        external_run_id: handle.run_id ?? null, summary: 'Execution adapter returned a local execution handle.' });
      await writeJsonAtomic(recordFile, { ...reservation, phase: 'launched', handle, sequence: report.sequence, ...(installed ? { installed_capabilities: installed } : {}) });
      return { run: report, handle, launch_replayed: false };
    } catch (error) {
      if (error.code === 'ADAPTER_PRECONDITION_FAILED' || !hostStartAttempted) {
        try {
          await this.client.reportRun(run.id, { operation_id: derivedOperationId(operation_id, 'not-started'), client_instance_id: instance,
            sequence: reservation.sequence + 1, status: 'failed', summary: 'Execution adapter rejected the request before host launch.' });
        } catch { /* 未能回报时保留本机预留，不能推测共享状态。 */ }
        throw new HubError('ADAPTER_PRECONDITION_FAILED', error.message,
          { details: { run_id: run.id, dispatch_id: run.dispatch_id }, operationId: operation_id });
      }
      // start may have succeeded externally before its response was lost: keep reservation, never replay.
      try {
        await this.client.reportRun(run.id, { operation_id: derivedOperationId(operation_id, 'uncertain'), client_instance_id: instance,
          sequence: reservation.sequence + 1, status: 'unknown', summary: 'Local launch outcome is uncertain. Reconcile the existing session before retrying.' });
      } catch { /* Pending state remains visible in the durable local reservation. */ }
      throw new HubError('LAUNCH_UNCERTAIN', 'Launch outcome is uncertain; the request is preserved and will not be started again automatically.',
        { details: { run_id: run.id, dispatch_id: run.dispatch_id, adapter_error: error.code || error.name }, operationId: operation_id });
    }
  }
  async reconcile(dispatchId) {
    const recordFile = path.join(this.stateDir, 'dispatches', safeKey(dispatchId) + '.json');
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    if (record.base !== this.client.base) throw new HubError('WRONG_SERVER', 'Dispatch belongs to a different Hub.');
    await this.requireDispatchOwner(record);
    const adapter = await this.requireAdapter(this.registry.executors, record.adapter);
    let handle = record.handle;
    if (!handle && typeof adapter.findByDispatchId === 'function') handle = await adapter.findByDispatchId(dispatchId);
    if (!handle) return { run: await this.client.getRun(record.run_id), requires_reconciliation: true, reason: 'No confirmed runtime handle. No new run was started.' };
    if (typeof handle !== 'object' || (!handle.session_id && !handle.run_id)) throw new HubError('INVALID_ADAPTER_RESULT', 'Recovered execution has no stable handle.');
    const state = await adapter.getStatus(handle);
    const allowed = ['queued', 'starting', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'unknown'];
    if (!allowed.includes(state?.status)) throw new HubError('INVALID_ADAPTER_RESULT', 'Adapter returned an unsupported runtime status.');
    const current = await this.client.getRun(record.run_id);
    const result = await this.client.reportRun(record.run_id, { operation_id: operationId(), client_instance_id: record.client_instance_id,
      sequence: current.sequence + 1, status: state.status, summary: state.summary || '',
      external_session_id: handle.session_id ?? null, external_run_id: handle.run_id ?? null });
    await writeJsonAtomic(recordFile, { ...record, phase: 'launched', handle, sequence: result.sequence });
    return { run: result, requires_reconciliation: false };
  }
  async cancel(dispatchId, requestId = operationId()) {
    const recordFile = path.join(this.stateDir, 'dispatches', safeKey(dispatchId) + '.json');
    const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    if (record.base !== this.client.base) throw new HubError('WRONG_SERVER', 'Dispatch belongs to a different Hub.');
    await this.requireDispatchOwner(record);
    const adapter = await this.requireAdapter(this.registry.executors, record.adapter);
    const capabilities = await adapter.probe();
    if (typeof adapter.cancel !== 'function' || capabilities.canCancel === false) throw new HubError('CANCEL_UNSUPPORTED', 'The adapter cannot cancel this execution. Stop it in the actual host and reconcile its status.');
    let current = await this.client.cancelRun(record.run_id, { operation_id: requestId });
    if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      return { run: current, requested: false, confirmed: current.status === 'cancelled' };
    }
    let handle = record.handle;
    if (!handle && typeof adapter.findByDispatchId === 'function') handle = await adapter.findByDispatchId(dispatchId);
    if (!handle) return { run: current, requires_reconciliation: true, confirmed: false };
    if (typeof handle !== 'object' || (!handle.session_id && !handle.run_id)) throw new HubError('INVALID_ADAPTER_RESULT', 'Recovered execution has no stable handle.');
    const outcome = await adapter.cancel(handle);
    if (outcome?.confirmed === true) {
      current = await this.client.getRun(record.run_id);
      current = await this.client.reportRun(record.run_id, { operation_id: derivedOperationId(requestId, 'confirmed'),
        client_instance_id: record.client_instance_id, sequence: current.sequence + 1, status: 'cancelled',
        summary: 'Execution adapter confirmed the local run has stopped.' });
    }
    return { run: current, requested: outcome?.requested === true, confirmed: outcome?.confirmed === true };
  }
  async requireDispatchOwner(record) {
    const [current, context] = await Promise.all([this.client.getRun(record.run_id), this.client.bootstrap()]);
    if (!current || !context?.me?.id || current.requested_by !== context.me.id
        || current.client_instance_id !== record.client_instance_id || current.dispatch_id !== record.dispatch_id
        || (record.actor_id && record.actor_id !== context.me.id)) {
      throw new HubError('DISPATCH_IDENTITY_MISMATCH', 'This local dispatch belongs to a different member or client instance.');
    }
  }
}
