import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdapterRegistry, LocalBridge } from '../src/bridge.mjs';

async function fixture(t, adapter) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-bridge-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let current = { id: 'run-1', dispatch_id: 'dispatch-1', sequence: 0, status: 'queued', spec_revision: 2,
    assignment_generation: 3, input_snapshot: { title: 'Frozen task', description: 'Frozen scope', acceptance_spec: ['Check API compatibility'], spec_revision: 2 },
    capability_releases: [{ release_id: 'release-1', capability_id: 'cap-1', version: '0.1.0' }] };
  const initial = structuredClone(current), calls = [];
  const client = { base: 'http://hub/api/v1',
    async createRun(id, data) { calls.push({ type: 'create', data }); return structuredClone(initial); },
    async getRun() { return structuredClone(current); },
    async reportRun(id, data) { calls.push({ type: 'report', data }); assert.ok(data.sequence > current.sequence); current = { ...current, ...data }; return structuredClone(current); },
    async cancelRun() { current.status = 'cancel_requested'; return structuredClone(current); },
  };
  const registry = new AdapterRegistry(); if (adapter) registry.registerExecutor('test-runtime', adapter);
  const bridge = new LocalBridge(client, { registry, stateDir: dir, instanceId: 'instance-1' });
  const input = { adapter: 'test-runtime', expected_version: 2, workspace_ref: '/work/project', operation_id: 'dispatch-request-1' };
  return { dir, calls, bridge, registry, client, input };
}

test('unavailable executor cannot allocate a shared run or start anything', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.start('work-1', f.input), { code: 'ADAPTER_UNAVAILABLE' }); assert.deepEqual(f.calls, []);
});

test('a repeated launch receipt starts the external runtime once and preserves pinned releases', async t => {
  let starts = 0, releases, dispatch;
  const f = await fixture(t, { async probe() { return { available: true }; }, async start(input) { starts++; releases = input.capability_releases; dispatch = input; return { session_id: 'real-session' }; }, async getStatus() { return { status: 'succeeded', summary: 'Verified result' }; } });
  const first = await f.bridge.start('work-1', f.input), second = await f.bridge.start('work-1', f.input);
  assert.equal(starts, 1); assert.equal(first.run.status, 'running'); assert.equal(second.run.external_session_id, 'real-session');
  assert.equal(releases[0].version, '0.1.0');
  assert.equal(dispatch.input_snapshot.title, 'Frozen task'); assert.equal(dispatch.spec_revision, 2); assert.equal(dispatch.assignment_generation, 3);
  const reconciled = await f.bridge.reconcile('dispatch-1'); assert.equal(reconciled.run.status, 'succeeded');
  assert.equal(f.calls.filter(x => x.type === 'report').at(-1).data.status, 'succeeded');
  assert.ok(f.calls.every(x => x.type === 'create' || x.type === 'report'));
});

test('uncertain external launch is kept unknown and never restarted automatically', async t => {
  let starts = 0;
  const f = await fixture(t, { async probe() { return { available: true }; }, async start() { starts++; throw new Error('Lost response after launch'); }, async getStatus() { throw new Error('not called'); } });
  await assert.rejects(f.bridge.start('work-1', f.input), { code: 'LAUNCH_UNCERTAIN' });
  assert.equal((await f.client.getRun()).status, 'unknown');
  const replay = await f.bridge.start('work-1', f.input); assert.equal(starts, 1); assert.equal(replay.requires_reconciliation, true);
  const reconciliation = await f.bridge.reconcile('dispatch-1'); assert.equal(reconciliation.requires_reconciliation, true); assert.equal(starts, 1);
});

test('crash recovery queries a known dispatch and requires confirmed cancellation', async t => {
  let confirmed = false;
  const f = await fixture(t, { async probe() { return { available: true }; }, async start() { throw new Error('process crashed'); },
    async findByDispatchId(id) { assert.equal(id, 'dispatch-1'); return { session_id: 'recovered-session' }; },
    async getStatus() { return { status: 'running' }; }, async cancel() { return { requested: true, confirmed }; } });
  await assert.rejects(f.bridge.start('work-1', f.input));
  await f.bridge.reconcile('dispatch-1');
  const requested = await f.bridge.cancel('dispatch-1', 'cancel-1'); assert.equal(requested.confirmed, false); assert.equal(requested.run.status, 'cancel_requested');
  confirmed = true;
  const stopped = await f.bridge.cancel('dispatch-1', 'cancel-2'); assert.equal(stopped.run.status, 'cancelled');
});

test('board binding uses the host stable card id and a shared external reference', async t => {
  const f = await fixture(t); let externalRef, binding;
  f.client.getItem = async () => ({ item: { id: 'work-1', title: 'Interface change' } });
  f.client.bindItem = async (id, data) => (binding = { id, ...data });
  f.registry.registerBoard('my-board', { async probe() { return { available: true }; }, async ensureLinkedCard(input) { externalRef = input.external_ref; return { local_todo_id: 'persistent-card-8' }; } });
  await f.bridge.linkBoard('work-1', { adapter: 'my-board', workspace_ref: '/work/project', operation_id: 'bind-1' });
  assert.equal(externalRef, 'http://hub/api/v1:work-1'); assert.equal(binding.local_todo_id, 'persistent-card-8'); assert.equal(binding.client_instance_id, 'instance-1');
});
