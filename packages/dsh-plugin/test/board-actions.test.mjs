import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardActions } from '../lib/board-actions.mjs';

const snapshot = { externalRef: 'http://hub.test/api/v1:wi-1', itemId: 'wi-1', pipelineId: 'p1',
  attemptId: 'a1', itemVersion: 3, generation: 2, specRevision: 4, currentDeliveryId: 'd1' };

test('board actions forward exact versions and delivery identity to Hub', async () => {
  const calls = [];
  const client = { base: 'http://hub.test/api/v1',
    async command(id, action, data) { calls.push({ id, action, data }); return { id }; },
    async submitDelivery(id, data) { calls.push({ id, action: 'submit', data }); return { id }; },
    async reviewDelivery(id, data) { calls.push({ id, action: 'review', data }); return { id }; } };
  const actions = createBoardActions(client, { async syncAll() { return [{ synced: true }]; } });
  await actions.execute(snapshot, { operation_id: 'operation-1', action: 'accept' });
  await actions.execute(snapshot, { operation_id: 'operation-2', action: 'submit', summary: '交付', artifacts: [{ label: '报告', url: 'https://example.test/r', kind: 'report' }] });
  await actions.execute(snapshot, { operation_id: 'operation-3', action: 'approve' });
  assert.equal(calls[0].data.expected_version, 3);
  assert.equal(calls[0].data.pipeline_attempt_id, 'a1');
  assert.equal(calls[1].data.spec_revision, 4);
  assert.equal(calls[2].id, 'd1');
  assert.equal(calls[2].data.decision, 'approve');
  await assert.rejects(actions.execute({ ...snapshot, superseded: true }, { operation_id: 'operation-4', action: 'accept' }), { code: 'INVALID_BOARD_SNAPSHOT' });
});

test('successful Hub mutation remains successful if board synchronization fails', async () => {
  const client = { base: 'http://hub.test/api/v1', async command() { return { status: 'accepted' }; } };
  const actions = createBoardActions(client, { async syncAll() { throw new Error('offline'); } });
  const result = await actions.execute(snapshot, { operation_id: 'operation-5', action: 'accept' });
  assert.equal(result.result.status, 'accepted');
  assert.equal(result.synchronization, 'pending');
});

test('board detail rejects stale item versions and exposes current authorized actions', async () => {
  const detail = { item: { version: 3 }, pipeline_context: { current: true, attempt_id: 'a1', generation: 2 },
    allowed_actions: ['accept'], deliveries: [] };
  const actions = createBoardActions({ base: 'http://hub.test/api/v1', async getItem() { return detail; } }, {});
  assert.deepEqual((await actions.inspect(snapshot)).allowed_actions, ['accept']);
  detail.item.version = 4;
  await assert.rejects(actions.inspect(snapshot), { code: 'STALE_BOARD_SNAPSHOT' });
});
