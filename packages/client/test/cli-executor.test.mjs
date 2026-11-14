import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioExecutionAdapter } from '../src/stdio-adapter.mjs';
import { prepareRuntimeCapabilities } from '../src/runtime-capabilities.mjs';

const program = fileURLToPath(new URL('../src/cli-executor.mjs', import.meta.url));
const fake = fileURLToPath(new URL('./fixtures/fake-cli-harness.mjs', import.meta.url));

async function fixture(t, harness) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-cli-executor-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const jobs = path.join(dir, 'jobs'), marker = path.join(dir, 'starts.txt');
  const adapter = new StdioExecutionAdapter({ name: `${harness}-test`, kind: 'executor', command: process.execPath,
    args: [program, `${harness}-test`, harness, process.execPath, dir, jobs, 'read-only', JSON.stringify([fake, marker])],
    cwd: dir, env: ['FAKE_HARNESS_DELAY', 'FAKE_HARNESS_CHILD_MARKER'], timeout_ms: 10000 });
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

for (const harness of ['codex', 'claude', 'opencode']) {
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
    if (harness === 'opencode') {
      const profile = JSON.parse(await fs.readFile(f.marker + '.config', 'utf8'));
      assert.equal(profile.mode, 'primary');
      assert.ok(profile.permissions.some(rule => rule.action === '*' && rule.effect === 'deny'));
      assert.ok(profile.permissions.some(rule => rule.action === 'external_directory' && rule.effect === 'deny'));
      assert.ok(!profile.permissions.some(rule => ['shell', 'edit', 'subagent'].includes(rule.action) && rule.effect === 'allow'));
    }
    await assert.rejects(f.adapter.start({ ...input, dispatch_id: 'dispatch-2', capability_releases: [{ version: '1' }] }), { code: 'ADAPTER_PRECONDITION_FAILED' });
    await assert.rejects(f.adapter.start({ ...input, dispatch_id: 'dispatch-3', workspace_ref: os.tmpdir() }), { code: 'ADAPTER_PRECONDITION_FAILED' });
  });
}

test('OpenCode discovers only the pinned skill ID from its dispatch-specific directory', async t => {
  const f = await fixture(t, 'opencode'); await f.adapter.probe();
  const pin = { capability_id: 'cap-fixed', release_id: 'rel-fixed', version: '1.0.0' };
  const client = { async getCapability() { return { id: pin.capability_id, kind: 'skill', slug: 'fixed' }; },
    async getRelease() { return { id: pin.release_id, capability_id: pin.capability_id, version: pin.version,
      manifest: { kind: 'skill', entry: 'SKILL.md' }, files: { 'SKILL.md': '---\nname: fixed\ndescription: test\n---\nfixed' } }; } };
  const installed = await prepareRuntimeCapabilities(client, f.dir, 'dispatch-fixed', [pin]);
  const handle = await f.adapter.start({ item_id: 'wi-fixed', run_id: 'run-fixed', dispatch_id: 'dispatch-fixed', workspace_ref: f.dir,
    input_snapshot: { title: '固定技能' }, capability_releases: [pin], installed_capabilities: installed, spec_revision: 1, assignment_generation: 1 });
  assert.equal((await waitFor(f.adapter, handle, ['succeeded', 'failed', 'unknown'])).status, 'succeeded');
  const profile = JSON.parse(await fs.readFile(f.marker + '.config', 'utf8'));
  assert.deepEqual(profile.skillSources, [path.dirname(installed[0].directory)]);
  assert.ok(profile.permissions.some(rule => rule.action === 'skill' && rule.resource === pin.capability_id && rule.effect === 'allow'));
  assert.ok(!profile.permissions.some(rule => rule.action === 'skill' && rule.resource === '*' && rule.effect === 'allow'));
});

test('OpenCode can use an explicit local provider configuration without exposing its contents', async t => {
  const f = await fixture(t, 'opencode');
  const configFile = path.join(f.dir, 'provider.json'); await fs.writeFile(configFile, '{}');
  f.adapter.options.args.push(JSON.stringify({ opencode_config: configFile }));
  await f.adapter.probe();
  const input = { item_id: 'wi-config', run_id: 'run-config', dispatch_id: 'dispatch-config', workspace_ref: f.dir,
    input_snapshot: { title: '配置测试' }, capability_releases: [], spec_revision: 1, assignment_generation: 1 };
  const handle = await f.adapter.start(input);
  assert.equal((await waitFor(f.adapter, handle, ['succeeded', 'failed', 'unknown'])).status, 'succeeded');
  assert.equal(JSON.parse(await fs.readFile(f.marker + '.config', 'utf8')).configFile, configFile);
  await fs.unlink(configFile);
  await assert.rejects(f.adapter.start({ ...input, dispatch_id: 'dispatch-missing-config' }), { code: 'ADAPTER_PRECONDITION_FAILED' });
});

test('cancel remains pending until the supervisor can verify the process tree', async t => {
  const previous = process.env.FAKE_HARNESS_DELAY; process.env.FAKE_HARNESS_DELAY = '1';
  t.after(() => { if (previous === undefined) delete process.env.FAKE_HARNESS_DELAY; else process.env.FAKE_HARNESS_DELAY = previous; });
  const f = await fixture(t, 'codex'); await f.adapter.probe();
  const handle = await f.adapter.start({ item_id: 'wi-2', run_id: 'run-2', dispatch_id: 'dispatch-2', workspace_ref: f.dir,
    input_snapshot: { title: '测试' }, capability_releases: [], spec_revision: 1, assignment_generation: 1 });
  await waitFor(f.adapter, handle, ['running']);
  assert.deepEqual(await f.adapter.cancel(handle), { requested: true, confirmed: false });
  const expected = process.platform === 'win32' ? 'cancelled' : 'unknown';
  assert.equal((await waitFor(f.adapter, handle, [expected])).status, expected);
  if (expected === 'cancelled') assert.deepEqual(await f.adapter.cancel(handle), { requested: false, confirmed: true });
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

test('Windows confirms cancellation only after a spawned descendant is stopped', { skip: process.platform !== 'win32' }, async t => {
  const previousDelay = process.env.FAKE_HARNESS_DELAY, previousMarker = process.env.FAKE_HARNESS_CHILD_MARKER;
  process.env.FAKE_HARNESS_DELAY = '1';
  t.after(() => {
    if (previousDelay === undefined) delete process.env.FAKE_HARNESS_DELAY; else process.env.FAKE_HARNESS_DELAY = previousDelay;
    if (previousMarker === undefined) delete process.env.FAKE_HARNESS_CHILD_MARKER; else process.env.FAKE_HARNESS_CHILD_MARKER = previousMarker;
  });
  const f = await fixture(t, 'codex'); process.env.FAKE_HARNESS_CHILD_MARKER = path.join(f.dir, 'descendant-finished');
  await f.adapter.probe();
  const handle = await f.adapter.start({ item_id: 'wi-child', run_id: 'run-child', dispatch_id: 'dispatch-child', workspace_ref: f.dir,
    input_snapshot: { title: '测试' }, capability_releases: [], spec_revision: 1, assignment_generation: 1 });
  await waitFor(f.adapter, handle, ['running']);
  const deadline = Date.now() + 5000;
  while (!(await fs.stat(f.marker).catch(() => null)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await fs.access(f.marker);
  assert.deepEqual(await f.adapter.cancel(handle), { requested: true, confirmed: false });
  assert.equal((await waitFor(f.adapter, handle, ['cancelled'])).status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 3500));
  await assert.rejects(fs.access(process.env.FAKE_HARNESS_CHILD_MARKER));
});
