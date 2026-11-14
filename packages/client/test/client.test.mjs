import test from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, HubError } from '../src/index.mjs';

test('HTTP bridge preserves actor authorization and stable operation id without automatic retries', async () => {
  const requests = [];
  const client = new HubClient({ url: 'https://hub.example/api/v1/', token: 'private-token', fetchImpl: async (url, init) => {
    requests.push({ url: String(url), ...init });
    return new Response(JSON.stringify({ id: 'work-1', version: 2 }), { status: 200 });
  } });
  await client.command('work-1', 'accept', { operation_id: 'claim-1', expected_version: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://hub.example/api/v1/work-items/work-1/accept');
  assert.equal(requests[0].headers.Authorization, 'Bearer private-token');
  assert.equal(requests[0].redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].body), { operation_id: 'claim-1', expected_version: 1 });
});

test('version conflicts retain actionable code and operation id', async () => {
  const client = new HubClient({ token: 'x', fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'Read the latest version.', details: { current_version: 3 } } }), { status: 409 }) });
  await assert.rejects(client.command('w1', 'progress', { operation_id: 'progress-1', expected_version: 1, summary: 'Done checking' }), error => {
    assert.equal(error.status, 409); assert.equal(error.operationId, 'progress-1');
    assert.equal(error.code, 'VERSION_CONFLICT'); assert.equal(error.details.current_version, 3); return true;
  });
});

test('missing token prevents network IO and connection errors never expose token', async () => {
  let called = false;
  const missing = new HubClient({ fetchImpl: async () => { called = true; } });
  await assert.rejects(missing.bootstrap(), { code: 'TOKEN_REQUIRED' }); assert.equal(called, false);
  const client = new HubClient({ token: 'secret-value', fetchImpl: async () => { throw new Error('secret-value'); } });
  await assert.rejects(client.createItem({ operation_id: 'known-op' }), error => {
    assert.equal(error.operationId, 'known-op'); assert.ok(!JSON.stringify(error.toJSON()).includes('secret-value')); return true;
  });
});

test('untrusted URL and unsupported business commands are rejected', () => {
  assert.throws(() => new HubClient({ url: 'https://user:secret@example.org' }), HubError);
  assert.throws(() => new HubClient().command('w1', 'done', {}), { code: 'UNKNOWN_COMMAND' });
});
