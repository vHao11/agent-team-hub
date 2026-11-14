import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HubError } from './index.mjs';
import { writeJsonAtomic } from './state.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

/** One profile identity owns its subscriptions; credentials are never written to disk. */
export class PipelineBoardSync {
  constructor(client, bridge, { adapter = 'dsh-todo-kanban', stateDir = bridge.stateDir } = {}) {
    this.client = client; this.bridge = bridge; this.adapter = adapter; this.stateDir = stateDir;
    this.queue = Promise.resolve(); this.lastResult = null;
  }
  get directory() { return path.join(this.stateDir, 'pipeline-board'); }
  get lockFile() { return path.join(this.directory, 'locks', hash(JSON.stringify([this.client.base, this.adapter])) + '.lock'); }
  async identity() { return (await this.client.bootstrap()).me; }
  filename(actorId, pipelineId) {
    // 沿用旧 DSH 文件名，其他看板独立保存订阅，避免覆盖同一流程的关联。
    const key = [this.client.base, actorId, pipelineId];
    if (this.adapter !== 'dsh-todo-kanban') key.push(this.adapter);
    return path.join(this.directory, hash(JSON.stringify(key)) + '.json');
  }
  async adapterService() {
    const adapter = await this.bridge.requireAdapter(this.bridge.registry.boards, this.adapter);
    if ((await adapter.probe()).canSync === false) throw new HubError('BOARD_SYNC_UNSUPPORTED', 'This adapter does not support pipeline synchronization.');
    return adapter;
  }
  exclusive(fn) {
    const result = this.queue.then(fn);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async withLock(fn) {
    const target = this.lockFile;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const owner = { pid: process.pid, nonce: randomUUID() };
    let handle;
    try { handle = await fs.open(target, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new HubError('BOARD_SYNC_BUSY', 'Another process owns this board synchronization lock.');
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.close(); handle = null;
      return await fn();
    } finally {
      if (handle) await handle.close();
      const current = await fs.readFile(target, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.pid === owner.pid && current?.nonce === owner.nonce) await fs.unlink(target);
    }
  }
  async releaseStaleLock() {
    const target = this.lockFile, recovery = target + '.recovery';
    await fs.mkdir(path.dirname(target), { recursive: true });
    let guard;
    try { guard = await fs.open(recovery, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new HubError('BOARD_SYNC_BUSY', 'Another process is checking the synchronization lock.');
      throw error;
    }
    try {
      let metadata;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new HubError('INVALID_BOARD_LOCK', 'Board lock is not a regular file.');
        metadata = JSON.parse(await fs.readFile(target, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return { released: false };
        if (error instanceof SyntaxError) throw new HubError('INVALID_BOARD_LOCK', 'Board lock has no verifiable owner; inspect it manually.');
        throw error;
      }
      if (!Number.isSafeInteger(metadata?.pid) || metadata.pid < 1 || typeof metadata.nonce !== 'string' || !metadata.nonce) {
        throw new HubError('INVALID_BOARD_LOCK', 'Board lock has no verifiable owner; inspect it manually.');
      }
      try { process.kill(metadata.pid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw new HubError('BOARD_SYNC_BUSY', 'Cannot verify that the lock owner has exited.');
        const current = JSON.parse(await fs.readFile(target, 'utf8'));
        if (current.pid !== metadata.pid || current.nonce !== metadata.nonce) throw new HubError('BOARD_SYNC_BUSY', 'Board lock changed during recovery.');
        await fs.unlink(target);
        return { released: true };
      }
      throw new HubError('BOARD_SYNC_BUSY', 'The process owning this board lock is still running.');
    } finally { await guard.close(); await fs.unlink(recovery); }
  }
  subscribe(pipelineId, workspaceRef, { workItemId, draftId } = {}) {
    return this.exclusive(() => this.withLock(async () => {
    if (!pipelineId || !workspaceRef || Boolean(workItemId) !== Boolean(draftId)) {
      throw new HubError('INVALID_SUBSCRIPTION', 'A pipeline, workspace and (when binding an existing draft) both item and draft IDs are required.');
    }
    const actor = await this.identity();
    await this.adapterService();
    const view = await this.client.getPipeline(pipelineId);
    if (workItemId && !view.steps.some(step => step.item?.id === workItemId)) throw new HubError('ITEM_NOT_IN_PIPELINE', 'The selected work item does not belong to this pipeline.');
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.filename(actor.id, pipelineId);
    const initial = { schema_version: 1, base: this.client.base, actor_id: actor.id, pipeline_id: pipelineId,
      workspace_ref: workspaceRef, adapter: this.adapter, linked: {}, preferred: workItemId ? { [workItemId]: draftId } : {} };
    try { await fs.writeFile(file, JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      if (existing.workspace_ref !== workspaceRef || (workItemId && existing.preferred?.[workItemId] !== draftId)) {
        throw new HubError('SUBSCRIPTION_CONFLICT', 'This pipeline is already linked with different local settings. Unlink it first.');
      }
    }
    const results = await this.syncAllUnlocked();
    return results.find(result => result.pipeline_id === pipelineId) ?? { pipeline_id: pipelineId, synced: false };
    }));
  }
  async records(actor) {
    let names;
    try { names = await fs.readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
      const file = path.join(this.directory, name);
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      if (entry.schema_version === 1 && entry.base === this.client.base && entry.actor_id === actor.id && entry.adapter === this.adapter) result.push({ file, entry });
    }
    return result;
  }
  snapshot(view, step, item) {
    return { schemaVersion: 1, externalRef: `${this.client.base}:${item.id}`, itemId: item.id,
      pipelineId: view.pipeline.id, stepKey: step.step_key, attemptId: step.attempt.id,
      generation: view.pipeline.generation, pipelineVersion: view.pipeline.version, itemVersion: item.version,
      status: item.status, pipelineStatus: view.pipeline.status, title: item.title,
      specRevision: item.spec_revision, currentDeliveryId: item.current_delivery_id ?? null,
      ownerTeamId: item.owner_team_id, pendingTargetTeamId: item.pending_target_team_id ?? null,
      assigneeId: item.assignee_id ?? null, reviewerId: item.reviewer_id, sourceUpdatedAt: item.updated_at };
  }
  async syncOne(adapter, actor, file, entry) {
    const view = await this.client.getPipeline(entry.pipeline_id);
    const instance = await this.bridge.instance();
    const synced = [];
    // 回退可能为同一步创建新事项；旧卡片仍保留，但须明确标记历史轮次。
    const currentIds = new Set(view.steps.map(step => step.item?.id).filter(Boolean));
    for (const [oldId, cardId] of Object.entries(entry.linked || {})) {
      if (currentIds.has(oldId)) continue;
      const oldStep = view.steps.find(step => step.attempts?.some(attempt => attempt.work_item_id === oldId));
      if (!oldStep) continue;
      const oldAttempt = oldStep.attempts.filter(attempt => attempt.work_item_id === oldId).at(-1);
      const detail = await this.client.getItem(oldId);
      const historical = this.snapshot(view, { ...oldStep, attempt: oldAttempt }, detail.item);
      await adapter.ensureLinkedCard({ snapshot: { ...historical, superseded: true }, external_ref: historical.externalRef,
        item: detail.item, workspace_ref: entry.workspace_ref, draftId: cardId });
    }
    for (const step of view.steps) {
      if (!step.item || !step.attempt) continue;
      const item = step.item;
      const relevant = entry.linked?.[item.id] || actor.id === item.requester_id || actor.id === item.reviewer_id
        || (actor.id === item.assignee_id && actor.team_id === item.owner_team_id)
        || actor.team_id === item.pending_target_team_id;
      if (!relevant) continue;
      const snapshot = this.snapshot(view, step, item);
      const card = await adapter.ensureLinkedCard({ snapshot, external_ref: snapshot.externalRef,
        item, workspace_ref: entry.workspace_ref,
        ...(entry.preferred?.[item.id] ? { draftId: entry.preferred[item.id] } : {}) });
      if (!card?.local_todo_id) throw new HubError('INVALID_ADAPTER_RESULT', 'Board did not return a stable draft ID.');
      const detail = await this.client.getItem(item.id);
      const binding = detail.bindings?.find(value => value.user_id === actor.id && value.harness === this.adapter
        && value.client_instance_id === instance && value.local_todo_id === card.local_todo_id && value.workspace_ref === entry.workspace_ref);
      if (!binding) {
        const context = detail.pipeline_context;
        if (!context || context.pipeline_id !== view.pipeline.id) throw new HubError('PIPELINE_CONTEXT_MISSING', 'The work item no longer has the expected pipeline context.');
        const operation_id = 'board-bind-' + hash(JSON.stringify([this.client.base, actor.id, instance, item.id,
          card.local_todo_id, entry.workspace_ref, context.attempt_id, context.generation])).slice(0, 48);
        await this.client.bindItem(item.id, { operation_id, client_instance_id: instance, harness: this.adapter,
          workspace_ref: entry.workspace_ref, local_todo_id: card.local_todo_id,
          pipeline_attempt_id: context.attempt_id, pipeline_generation: context.generation });
      }
      entry.linked ??= {};
      if (entry.linked[item.id] !== card.local_todo_id) {
        entry.linked[item.id] = card.local_todo_id;
        await writeJsonAtomic(file, entry);
      }
      synced.push({ work_item_id: item.id, local_todo_id: card.local_todo_id, status: item.status });
    }
    return { pipeline_id: entry.pipeline_id, pipeline_status: view.pipeline.status, synced: true, cards: synced };
  }
  syncAll() {
    return this.exclusive(() => this.withLock(() => this.syncAllUnlocked()));
  }
  async syncAllUnlocked() {
      const actor = await this.identity();
      const records = await this.records(actor);
      if (!records.length) {
        this.lastResult = { state: 'idle', subscriptions: 0 };
        await this.bridge.registry.boards.get(this.adapter)?.setSyncStatus?.('idle');
        return [];
      }
      const adapter = await this.adapterService();
      const results = [];
      for (const { file, entry } of records) {
        try { results.push(await this.syncOne(adapter, actor, file, entry)); }
        catch (error) { results.push({ pipeline_id: entry.pipeline_id, synced: false, error: error.code || 'SYNC_FAILED', message: error.message }); }
      }
      this.lastResult = { state: results.every(value => value.synced) ? 'synced' : 'degraded',
        subscriptions: results.length, checked_at: new Date().toISOString(), results };
      await adapter.setSyncStatus?.(this.lastResult.state);
      return results;
  }
  async unsubscribe(pipelineId) {
    return this.exclusive(() => this.withLock(async () => {
      const actor = await this.identity();
      const file = this.filename(actor.id, pipelineId);
      let record;
      try { record = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { pipeline_id: pipelineId, removed: false }; throw error; }
      if (record.base !== this.client.base || record.actor_id !== actor.id || record.pipeline_id !== pipelineId || record.adapter !== this.adapter) throw new HubError('SUBSCRIPTION_CONFLICT', 'Subscription identity does not match.');
      // A second identity sharing this state directory may still need the same card.
      for (const name of (await fs.readdir(this.directory)).filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const otherFile = path.join(this.directory, name);
        if (otherFile === file) continue;
        const other = JSON.parse(await fs.readFile(otherFile, 'utf8'));
        if (other.schema_version === 1 && other.base === record.base && other.pipeline_id === pipelineId && other.adapter === this.adapter) {
          await fs.unlink(file);
          return { pipeline_id: pipelineId, removed: true, detached: 0, retained_for_other_subscribers: true };
        }
      }
      const adapter = await this.adapterService();
      if (typeof adapter.detachPipeline !== 'function' || (await adapter.probe()).canDetach === false) {
        await fs.unlink(file);
        return { pipeline_id: pipelineId, removed: true, detached: 0, retained_external_links: true };
      }
      const detached = await adapter.detachPipeline({ pipelineId, hubBase: this.client.base });
      await fs.unlink(file);
      return { pipeline_id: pipelineId, removed: true, detached: detached.detached };
    }));
  }
}

/** Resolve the optional in-process Cordis service each time, including after plugin reload. */
export class DshKanbanAdapter {
  constructor(resolveService) { this.resolveService = resolveService; }
  service() {
    const service = this.resolveService();
    if (!service || service.apiVersion !== 1 || typeof service.ensureLinkedCard !== 'function') {
      throw new HubError('ADAPTER_UNAVAILABLE', 'dsh-todo-kanban Hub service is unavailable or needs an update.');
    }
    return service;
  }
  async probe() { try { this.service(); return { available: true, protocol_version: 1, kind: 'board', version: '1', canSync: true, canLinkItem: false, canDetach: true }; } catch (error) { return { available: false, reason: error.message }; } }
  async ensureLinkedCard(input) {
    if (!input?.snapshot) throw new HubError('PIPELINE_LINK_REQUIRED', 'Use teamhub_pipeline_link for a pipeline work item.');
    return this.service().ensureLinkedCard(input);
  }
  async detachPipeline(input) { return this.service().detachPipeline(input); }
  async setSyncStatus(state) { return this.service().setSyncStatus(state); }
}
