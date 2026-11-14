import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioExecutionAdapter } from '../src/stdio-adapter.mjs';

const program = fileURLToPath(new URL('../src/cli-executor.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-cli-harness.mjs', import.meta.url));

async function fixture(t, harness) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-cli-executor-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jobs = path.join(dir, 'jobs'), marker = path.join(dir, 'starts.txt');
  const adapter = new StdioExecutionAdapter({ name: `${harness}-test`, kind: 'executor', command: process.execPath,
    args: [program, `${harness}-test`, harness, process.execPath, dir, jobs, 'read-only', JSON.stringify([fake, marker])],
    cwd: dir, env: ['FAKE_HARNESS_DELAY'], timeout_ms: 5000 });
  return { dir, jobs, marker, adapter };
}

async function waitFor(adapter, handle, expected) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await adapter.getStatus(handle);
    if (expected.includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('执行器状态超时');
}

for (const harness of ['codex', 'claude']) {
  test(`${harness} adapter starts once, persists results, and recovers by dispatch ID`, async t => {
    const f = await fixture(t, harness);
    assert.equal((await f.adapter.probe()).available, true);
    const input = { item_id: 'wi-1', run_id: 'run-1', dispatch_id: 'dispatch-1', workspace_ref: f.dir,
      input_snapshot: { title: '测试', description: '隔离任务', acceptance_spec: ['完成'] }, capability_releases: [], spec_revision: 1, assignment_generation: 1 };
    const handle = await f.adapter.start(input);
    assert.equal((await f.adapter.start(input)).run_id, handle.run_id);
    const state = await waitFor(f.adapter, handle, ['succeeded', 'failed', 'unknown']);
    assert.equal(state.status, 'succeeded'); assert.match(state.summary, /完成/);
    assert.equal((await f.adapter.findByDispatchId(input.dispatch_id)).run_id, handle.run_id);
    assert.equal((await fs.readFile(f.marker, 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(f.adapter.start({ ...input, dispatch_id: 'dispatch-2', capability_releases: [{ version: '1' }] }), { code: 'ADAPTER_PRECONDITION_FAILED' });
    await assert.rejects(f.adapter.start({ ...input, dispatch_id: 'dispatch-3', workspace_ref: os.tmpdir() }), { code: 'ADAPTER_PRECONDITION_FAILED' });
  });
}

test('cancel is a request and never claims a host process tree has stopped', async t => {
  const previous = process.env.FAKE_HARNESS_DELAY; process.env.FAKE_HARNESS_DELAY = '1';
  t.after(() => { if (previous === undefined) delete process.env.FAKE_HARNESS_DELAY; else process.env.FAKE_HARNESS_DELAY = previous; });
  const f = await fixture(t, 'codex'); await f.adapter.probe();
  const handle = await f.adapter.start({ item_id: 'wi-2', run_id: 'run-2', dispatch_id: 'dispatch-2', workspace_ref: f.dir,
    input_snapshot: { title: '测试' }, capability_releases: [], spec_revision: 1, assignment_generation: 1 });
  await waitFor(f.adapter, handle, ['running']);
  assert.deepEqual(await f.adapter.cancel(handle), { requested: true, confirmed: false });
  assert.equal((await waitFor(f.adapter, handle, ['unknown'])).status, 'unknown');
});

test('an immediate cancellation does not allow an early-starting harness to run to completion', async t => {
  const previous = process.env.FAKE_HARNESS_DELAY; process.env.FAKE_HARNESS_DELAY = '1';
  t.after(() => { if (previous === undefined) delete process.env.FAKE_HARNESS_DELAY; else process.env.FAKE_HARNESS_DELAY = previous; });
  const f = await fixture(t, 'codex'); await f.adapter.probe();
  const handle = await f.adapter.start({ item_id: 'wi-3', run_id: 'run-3', dispatch_id: 'dispatch-3', workspace_ref: f.dir,
    input_snapshot: { title: '测试' }, capability_releases: [], spec_revision: 1, assignment_generation: 1 });
  assert.deepEqual(await f.adapter.cancel(handle), { requested: true, confirmed: false });
  assert.ok(['unknown', 'cancelled'].includes((await waitFor(f.adapter, handle, ['unknown', 'cancelled'])).status));
});
