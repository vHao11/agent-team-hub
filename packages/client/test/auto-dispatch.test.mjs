import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoDispatcher } from '../src/auto-dispatch.mjs';

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-auto-'));
  assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const actor = { id: 'worker-1', team_id: 'team-1' };
  const item = { id: 'item-1', status: 'open', pending_target_team_id: 'team-1', assignee_id: null, version: 1 };
  const context = { current: true, pipeline_id: 'pipe-1', attempt_id: 'attempt-1', generation: 1, requested_assignee_id: actor.id };
  const view = { pipeline: { status: 'active' }, steps: [{ step_key: 'build', item, attempt: { id: context.attempt_id } }] };
  const runs = [], calls = { start: 0, accept: 0, reconcile: 0, cancel: 0 };
  let loseStart = false;
  const client = { base: 'http://hub.test/api/v1', async bootstrap() { return { me: actor }; },
    async getPipeline() { return structuredClone(view); },
    async getItem() { return { item: structuredClone(item), pipeline_context: structuredClone(context), runs: structuredClone(runs) }; },
    async command(id, action, data) {
      assert.equal(id, item.id); assert.equal(action, 'accept'); assert.equal(data.pipeline_attempt_id, context.attempt_id);
      calls.accept++; item.status = 'accepted'; item.assignee_id = actor.id; item.pending_target_team_id = null; item.version++;
    } };
  const bridge = { stateDir, registry: { executors: new Map() }, async instance() { return 'machine-1'; },
    async requireAdapter() { return {}; },
    async start(id, data) {
      calls.start++; assert.equal(id, item.id); assert.equal(data.pipeline_attempt_id, context.attempt_id);
      const run = { id: 'run-1', dispatch_id: 'dispatch-1', requested_by: actor.id, client_instance_id: 'machine-1',
        pipeline_attempt_id: context.attempt_id, status: loseStart ? 'unknown' : 'running' };
      runs.push(run); if (loseStart) throw Object.assign(new Error('response lost'), { code: 'LAUNCH_UNCERTAIN' });
      return { run };
    },
    async reconcile() { calls.reconcile++; },
    async cancel() { calls.cancel++; return { confirmed: false }; } };
  return { actor, item, context, view, runs, calls, client, bridge, auto: new AutoDispatcher(client, bridge),
    loseStart() { loseStart = true; } };
}

test('auto execution accepts only the designated member and starts once across ticks and restarts', async t => {
  const f = await fixture(t);
  await f.auto.enable({ pipeline_id: 'pipe-1', adapter: 'executor', workspace_ref: '/workspace', auto_accept: true });
  await f.auto.tick(); await f.auto.tick();
  assert.equal(f.calls.accept, 1); assert.equal(f.calls.start, 1); assert.equal(f.calls.reconcile, 1);
  f.runs[0].status = 'succeeded';
  const restarted = new AutoDispatcher(f.client, f.bridge);
  await restarted.tick();
  assert.equal(f.calls.start, 1);
  assert.equal((await restarted.disable('pipe-1')).removed, true);
});

test('unknown launch is not replayed and cancellation is sent at most once', async t => {
  const f = await fixture(t); f.loseStart();
  await f.auto.enable({ pipeline_id: 'pipe-1', adapter: 'executor', workspace_ref: '/workspace', auto_accept: true });
  assert.equal((await f.auto.tick())[0].ok, false);
  await f.auto.tick();
  assert.equal(f.calls.start, 1);
  f.runs[0].status = 'cancel_requested';
  await f.auto.tick();
  await new AutoDispatcher(f.client, f.bridge).tick();
  assert.equal(f.calls.cancel, 1);
});

test('unassigned or paused steps do not launch', async t => {
  const f = await fixture(t);
  f.context.requested_assignee_id = 'another-member';
  await f.auto.enable({ pipeline_id: 'pipe-1', adapter: 'executor', workspace_ref: '/workspace', auto_accept: true });
  await f.auto.tick();
  assert.equal(f.calls.accept, 0); assert.equal(f.calls.start, 0);
  f.item.status = 'accepted'; f.item.assignee_id = f.actor.id; f.item.pending_target_team_id = null; f.view.pipeline.status = 'paused';
  await f.auto.tick();
  assert.equal(f.calls.start, 0);
});
