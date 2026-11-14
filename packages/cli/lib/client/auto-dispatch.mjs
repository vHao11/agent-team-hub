import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HubError } from './index.mjs';
import { PipelineBoardSync } from './board-sync.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'cancelled']);

/** 本机按成员和流程显式启用的执行调度；不替代 Hub 的业务状态。 */
export class AutoDispatcher {
  constructor(client, bridge) {
    this.client = client; this.bridge = bridge; this.directory = path.join(bridge.stateDir, 'auto-dispatch');
    this.lock = new PipelineBoardSync(client, bridge, { adapter: 'auto-execution' });
    this.lastResult = { state: 'idle', policies: 0 };
  }
  exclusive(fn) { return this.lock.exclusive(() => this.lock.withLock(fn)); }
  file(actor, pipeline) { return path.join(this.directory, digest([this.client.base, actor, pipeline]) + '.json'); }
  async records(actor) {
    let names;
    try { names = await fs.readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
      const policy = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
      if (policy.schema_version === 1 && policy.base === this.client.base && policy.actor_id === actor.id) records.push(policy);
    }
    return records;
  }
  enable({ pipeline_id, adapter, workspace_ref, auto_accept = false }) {
    return this.exclusive(async () => {
      if (!pipeline_id || !adapter || !workspace_ref || typeof auto_accept !== 'boolean') throw new HubError('INVALID_AUTOMATION', '流程、执行器和工作区均为必填项。');
      const actor = (await this.client.bootstrap()).me;
      await this.client.getPipeline(pipeline_id);
      await this.bridge.requireAdapter(this.bridge.registry.executors, adapter);
      const file = this.file(actor.id, pipeline_id);
      await fs.mkdir(this.directory, { recursive: true });
      const value = { schema_version: 1, base: this.client.base, actor_id: actor.id, pipeline_id,
        adapter, workspace_ref, auto_accept, created_at: new Date().toISOString() };
      try { await fs.writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = JSON.parse(await fs.readFile(file, 'utf8'));
        if (existing.adapter !== adapter || existing.workspace_ref !== workspace_ref || existing.auto_accept !== auto_accept) {
          throw new HubError('AUTOMATION_CONFLICT', '流程已有不同的本机自动执行设置，请先关闭。');
        }
        return existing;
      }
      return value;
    });
  }
  disable(pipelineId) {
    return this.exclusive(async () => {
      if (!pipelineId || typeof pipelineId !== 'string') throw new HubError('INVALID_AUTOMATION', '关闭自动执行时需要流程 ID。');
      const actor = (await this.client.bootstrap()).me;
      try { await fs.unlink(this.file(actor.id, pipelineId)); return { pipeline_id: pipelineId, removed: true }; }
      catch (error) { if (error.code === 'ENOENT') return { pipeline_id: pipelineId, removed: false }; throw error; }
    });
  }
  async tick() {
    return this.exclusive(async () => {
      const actor = (await this.client.bootstrap()).me;
      const instance = await this.bridge.instance();
      const records = await this.records(actor);
      const results = [];
      for (const policy of records) {
        try { results.push(await this.runPolicy(actor, instance, policy)); }
        catch (error) { results.push({ pipeline_id: policy.pipeline_id, ok: false, error: error.code || 'AUTOMATION_FAILED', message: error.message }); }
      }
      this.lastResult = { state: results.every(result => result.ok) ? (records.length ? 'running' : 'idle') : 'degraded',
        policies: records.length, checked_at: new Date().toISOString(), results };
      return results;
    });
  }
  async runPolicy(actor, instance, policy) {
    const view = await this.client.getPipeline(policy.pipeline_id);
    const results = [];
    for (const step of view.steps) {
      if (!step.item || !step.attempt) continue;
      let detail = await this.client.getItem(step.item.id);
      let item = detail.item;
      let context = detail.pipeline_context;
      if (!context?.current || context.attempt_id !== step.attempt.id || context.pipeline_id !== policy.pipeline_id) continue;
      if (view.pipeline.status === 'active' && policy.auto_accept && item.status === 'open'
          && item.pending_target_team_id === actor.team_id && context.requested_assignee_id === actor.id) {
        await this.client.command(item.id, 'accept', { operation_id: `auto-accept-${digest([policy.pipeline_id, context.attempt_id, actor.id])}`,
          expected_version: item.version, pipeline_attempt_id: context.attempt_id, pipeline_generation: context.generation });
        detail = await this.client.getItem(item.id); item = detail.item; context = detail.pipeline_context;
        if (!context?.current || context.attempt_id !== step.attempt.id || context.pipeline_id !== policy.pipeline_id) continue;
      }
      const currentRuns = (detail.runs || []).filter(run => run.pipeline_attempt_id === context.attempt_id);
      for (const run of currentRuns.filter(value => value.requested_by === actor.id && value.client_instance_id === instance && !terminal.has(value.status))) {
        if (run.status === 'cancel_requested') {
          // 先留下持久预留；重启后不重复发送可能已到达宿主的停止请求。
          const markerDir = path.join(this.directory, 'cancelled');
          await fs.mkdir(markerDir, { recursive: true });
          const marker = path.join(markerDir, digest([this.client.base, run.dispatch_id]) + '.json');
          let claimed = false;
          try { await fs.writeFile(marker, JSON.stringify({ dispatch_id: run.dispatch_id }), { flag: 'wx', mode: 0o600 }); claimed = true; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          if (claimed) {
            try { await this.bridge.cancel(run.dispatch_id, `auto-cancel-${digest([run.dispatch_id])}`); }
            catch (error) { results.push({ step: step.step_key, action: 'cancel_uncertain', error: error.code || 'CANCEL_FAILED' }); }
          }
        }
        try { await this.bridge.reconcile(run.dispatch_id); results.push({ step: step.step_key, action: 'reconciled' }); }
        catch (error) { results.push({ step: step.step_key, action: 'reconcile_pending', error: error.code || 'RECONCILE_FAILED' }); }
      }
      if (view.pipeline.status !== 'active' || item.assignee_id !== actor.id || !['accepted', 'active'].includes(item.status)
          || item.pending_target_team_id || currentRuns.length) continue;
      const operation_id = `auto-run-${digest([policy.pipeline_id, context.attempt_id, actor.id])}`;
      try {
        const launched = await this.bridge.start(item.id, { adapter: policy.adapter, workspace_ref: policy.workspace_ref,
          expected_version: item.version, pipeline_attempt_id: context.attempt_id, pipeline_generation: context.generation, operation_id });
        results.push({ step: step.step_key, action: 'started', dispatch_id: launched.run.dispatch_id });
      } catch (error) { results.push({ step: step.step_key, action: 'start_pending', error: error.code || 'START_FAILED',
        ...(error.details?.dispatch_id ? { dispatch_id: error.details.dispatch_id } : {}) }); }
    }
    return { pipeline_id: policy.pipeline_id, ok: results.every(value => !value.error), steps: results };
  }
}
