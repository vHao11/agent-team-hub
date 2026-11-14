import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AdapterRegistry, LocalBridge } from '../src/bridge.mjs';
import { PipelineBoardSync } from '../src/board-sync.mjs';

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-board-sync-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let actor = { id: 'requester', team_id: 'team-a' };
  const item = { id: 'work-1', title: 'First step', status: 'open', version: 1, updated_at: '2026-11-14T00:00:00Z',
    requester_id: 'requester', reviewer_id: 'reviewer', owner_team_id: 'team-a', pending_target_team_id: 'team-b', assignee_id: null };
  const view = { pipeline: { id: 'pipe-1', generation: 1, version: 2, status: 'active' },
    steps: [{ step_key: 'first', item, attempt: { id: 'attempt-1' } }] };
  const cards = new Map(), bindings = [], calls = { creates: 0, binds: 0 };
  let loseBindResponse = false, offline = false;
  const client = {
    base: 'http://hub.test/api/v1', async bootstrap() { return { me: actor }; },
    async getPipeline() { if (offline) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); return structuredClone(view); },
    async getItem(id) { return { item: structuredClone(view.steps.find(step => step.item.id === id).item),
      pipeline_context: { pipeline_id: 'pipe-1', attempt_id: view.steps.find(step => step.item.id === id).attempt.id, generation: view.pipeline.generation },
      bindings: structuredClone(bindings.filter(value => value.work_item_id === id)) }; },
    async bindItem(id, data) {
      calls.binds++; bindings.push({ ...data, user_id: actor.id, work_item_id: id });
      if (loseBindResponse) { loseBindResponse = false; throw Object.assign(new Error('response lost'), { code: 'NETWORK_ERROR' }); }
      return bindings.at(-1);
    },
  };
  const health = [];
  const adapter = { async probe() { return { available: true }; },
    async ensureLinkedCard({ snapshot, draftId }) {
      let card = cards.get(snapshot.externalRef);
      if (!card) { card = { local_todo_id: draftId || `draft-${cards.size + 1}` }; calls.creates++; }
      cards.set(snapshot.externalRef, { ...card, snapshot }); return card;
    }, async detachPipeline() { return { detached: cards.size }; }, async setSyncStatus(state) { health.push(state); } };
  const registry = new AdapterRegistry(); registry.registerBoard('dsh-todo-kanban', adapter);
  const bridge = new LocalBridge(client, { registry, stateDir, instanceId: 'machine-1' });
  return { stateDir, client, view, item, cards, bindings, calls, health, sync: new PipelineBoardSync(client, bridge),
    loseResponse() { loseBindResponse = true; }, setActor(value) { actor = value; }, setOffline(value) { offline = value; } };
}

test('lost binding response recovers without duplicate cards and later activated steps are synced', async t => {
  const f = await fixture(t); f.loseResponse();
  const first = await f.sync.subscribe('pipe-1', '/workspace');
  assert.equal(first.synced, false); assert.equal(f.calls.creates, 1); assert.equal(f.calls.binds, 1);
  assert.equal((await f.sync.syncAll())[0].synced, true);
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.binds, 1);
  f.item.status = 'done'; f.item.version = 4; f.item.pending_target_team_id = null;
  f.view.pipeline.version = 6;
  f.view.steps.push({ step_key: 'test', attempt: { id: 'attempt-2' }, item: { ...f.item, id: 'work-2', title: 'Second step', status: 'open',
    version: 1, pending_target_team_id: 'team-c' } });
  assert.equal((await f.sync.syncAll())[0].cards.length, 2);
  assert.equal(f.calls.creates, 2); assert.equal(f.cards.get('http://hub.test/api/v1:work-1').snapshot.status, 'done');
  const persisted = await fs.readFile(path.join(f.stateDir, 'pipeline-board', (await fs.readdir(path.join(f.stateDir, 'pipeline-board')))[0]), 'utf8');
  assert.ok(!persisted.includes('token')); assert.match(persisted, /work-2/);
});

test('an unavailable Hub leaves the last board state intact and reports recovery', async t => {
  const f = await fixture(t);
  await f.sync.subscribe('pipe-1', '/workspace');
  f.setOffline(true);
  assert.equal((await f.sync.syncAll())[0].synced, false);
  assert.equal(f.health.at(-1), 'degraded');
  assert.equal(f.cards.get('http://hub.test/api/v1:work-1').snapshot.status, 'open');
  f.setOffline(false); f.item.status = 'active'; f.item.version = 3; f.view.pipeline.version = 4;
  assert.equal((await f.sync.syncAll())[0].synced, true);
  assert.equal(f.health.at(-1), 'synced');
  assert.equal(f.cards.get('http://hub.test/api/v1:work-1').snapshot.status, 'active');
});

test('subscriptions are scoped to the current Hub identity and can be removed without deleting cards', async t => {
  const f = await fixture(t);
  assert.equal((await f.sync.subscribe('pipe-1', '/workspace')).synced, true);
  f.setActor({ id: 'other-member', team_id: 'team-c' });
  assert.deepEqual(await f.sync.syncAll(), []);
  assert.equal((await f.sync.unsubscribe('pipe-1')).removed, false);
  f.setActor({ id: 'requester', team_id: 'team-a' });
  assert.deepEqual(await f.sync.unsubscribe('pipe-1'), { pipeline_id: 'pipe-1', removed: true, detached: 1 });
  assert.equal(f.cards.size, 1);
});

test('unlinking one identity retains the board association while another identity is subscribed', async t => {
  const f = await fixture(t);
  assert.equal((await f.sync.subscribe('pipe-1', '/workspace')).synced, true);
  f.setActor({ id: 'receiver', team_id: 'team-b' });
  assert.equal((await f.sync.subscribe('pipe-1', '/workspace')).synced, true);
  f.setActor({ id: 'requester', team_id: 'team-a' });
  assert.deepEqual(await f.sync.unsubscribe('pipe-1'),
    { pipeline_id: 'pipe-1', removed: true, detached: 0, retained_for_other_subscribers: true });
  f.setActor({ id: 'receiver', team_id: 'team-b' });
  assert.deepEqual(await f.sync.unsubscribe('pipe-1'), { pipeline_id: 'pipe-1', removed: true, detached: 1 });
});

test('two different board adapters keep independent subscriptions for the same pipeline', async t => {
  const f = await fixture(t);
  const cards = new Map();
  const other = { async probe() { return { available: true, protocol_version: 1 }; },
    async ensureLinkedCard({ snapshot, workspace_ref }) {
      assert.equal(workspace_ref, '/workspace');
      cards.set(snapshot.externalRef, snapshot);
      return { local_todo_id: 'second-board-card' };
    } };
  const registry = f.sync.bridge.registry;
  registry.registerBoard('other-board', other);
  const sync = new PipelineBoardSync(f.client, f.sync.bridge, { adapter: 'other-board' });
  assert.equal((await f.sync.subscribe('pipe-1', '/workspace')).synced, true);
  assert.equal((await sync.subscribe('pipe-1', '/workspace')).synced, true);
  assert.equal((await fs.readdir(path.join(f.stateDir, 'pipeline-board'))).filter(name => name.endsWith('.json')).length, 2);
  assert.equal((await f.sync.syncAll())[0].cards[0].local_todo_id, 'draft-1');
  assert.equal((await sync.syncAll())[0].cards[0].local_todo_id, 'second-board-card');
  assert.equal((await sync.unsubscribe('pipe-1')).retained_external_links, true);
  assert.equal((await f.sync.syncAll())[0].synced, true);
});

test('concurrent processes cannot unlink while a board sync is in progress', async t => {
  const f = await fixture(t);
  await f.sync.subscribe('pipe-1', '/workspace');
  const other = new PipelineBoardSync(f.client, f.sync.bridge);
  const adapter = f.sync.bridge.registry.boards.get('dsh-todo-kanban');
  const original = adapter.ensureLinkedCard;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  adapter.ensureLinkedCard = async input => { entered(); await resume; return original(input); };
  const syncing = f.sync.syncAll();
  await waiting;
  await assert.rejects(other.unsubscribe('pipe-1'), { code: 'BOARD_SYNC_BUSY' });
  release();
  assert.equal((await syncing)[0].synced, true);
  assert.equal((await other.unsubscribe('pipe-1')).removed, true);
});

test('lock recovery refuses a live owner and can remove a verified dead process lock', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.sync.lockFile), { recursive: true });
  await fs.writeFile(f.sync.lockFile, JSON.stringify({ pid: process.pid, nonce: 'active' }));
  await assert.rejects(f.sync.releaseStaleLock(), { code: 'BOARD_SYNC_BUSY' });
  assert.equal(JSON.parse(await fs.readFile(f.sync.lockFile, 'utf8')).nonce, 'active');
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  await fs.writeFile(f.sync.lockFile, JSON.stringify({ pid: child.pid, nonce: 'exited' }));
  assert.deepEqual(await f.sync.releaseStaleLock(), { released: true });
  assert.equal((await f.sync.subscribe('pipe-1', '/workspace')).synced, true);
});

test('legacy DSH subscription files continue to reconcile without migration', async t => {
  const f = await fixture(t);
  const directory = path.join(f.stateDir, 'pipeline-board');
  await fs.mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify([f.client.base, 'requester', 'pipe-1'])).digest('hex');
  await fs.writeFile(path.join(directory, key + '.json'), JSON.stringify({ schema_version: 1, base: f.client.base,
    actor_id: 'requester', pipeline_id: 'pipe-1', workspace_ref: '/workspace', adapter: 'dsh-todo-kanban', linked: {}, preferred: {} }));
  const result = await f.sync.syncAll();
  assert.equal(result[0].synced, true);
  assert.equal(result[0].cards[0].local_todo_id, 'draft-1');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, key + '.json'), 'utf8')).linked['work-1'], 'draft-1');
});
