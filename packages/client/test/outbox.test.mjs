import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queueOperation, listOutbox, replayOutbox, clientInstanceId } from '../src/state.mjs';
import { HubError } from '../src/index.mjs';

test('offline progress keeps operation/version, is scoped to identity, and retains conflicts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-outbox-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const entry = { base: 'https://hub/api/v1', actorId: 'user-1', method: 'POST', apiPath: '/work-items/w1/progress', body: { operation_id: 'progress-1', expected_version: 2, summary: 'Working' } };
  await queueOperation(entry, dir);
  const client = { base: entry.base, token: 'private-token', async bootstrap() { return { me: { id: 'user-2' } }; }, async request() { throw new Error('not called'); } };
  assert.equal((await replayOutbox(client, dir))[0].skipped, true);
  client.bootstrap = async () => ({ me: { id: 'user-1' } });
  client.request = async (method, apiPath, body) => { assert.equal(body.expected_version, 2); assert.equal(body.operation_id, 'progress-1'); throw new HubError('VERSION_CONFLICT', 'Read current version'); };
  assert.equal((await replayOutbox(client, dir))[0].error.code, 'VERSION_CONFLICT');
  const queue = await listOutbox(dir); assert.equal(queue.length, 1); assert.ok(!JSON.stringify(queue).includes(client.token));
  client.request = async () => ({ version: 3 });
  assert.equal((await replayOutbox(client, dir))[0].delivered, true); assert.equal((await listOutbox(dir)).length, 0);
  assert.equal(await clientInstanceId(dir), await clientInstanceId(dir));
});

test('concurrent first clients get one stable nonempty machine identity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-instance-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const identities = await Promise.all(Array.from({ length: 12 }, () => clientInstanceId(dir)));
  assert.equal(new Set(identities).size, 1); assert.match(identities[0], /^[a-f0-9-]{36}$/);
  await assert.rejects(queueOperation({ base: 'http://hub/api/v1', actorId: 'u1', method: 'POST', apiPath: '/work-items/w1/runs', body: { operation_id: 'bad-start' } }, dir), { code: 'QUEUE_UNSUPPORTED' });
});
