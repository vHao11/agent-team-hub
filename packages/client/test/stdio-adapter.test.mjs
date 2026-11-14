import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterRegistry, LocalBridge } from '../src/bridge.mjs';
import { registerStdioAdapters } from '../src/stdio-adapter.mjs';

const worker = fileURLToPath(new URL('./fixtures/adapter-worker.mjs', import.meta.url));
async function setup(t, mode = 'good', extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-adapter-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'adapters.json');
  const entry = { name: 'test-board', kind: 'board', command: process.execPath, args: [worker, mode], timeout_ms: 500, ...extra };
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, adapters: [entry] }));
  return { dir, file, registry: new AdapterRegistry() };
}

test('explicit local subprocess negotiates capabilities without receiving the Hub token', async t => {
  const f = await setup(t);
  const previous = process.env.TEAMHUB_TOKEN;
  process.env.TEAMHUB_TOKEN = 'synthetic-secret';
  t.after(() => { if (previous === undefined) delete process.env.TEAMHUB_TOKEN; else process.env.TEAMHUB_TOKEN = previous; });
  const dispose = registerStdioAdapters(f.file, f.registry);
  const value = await f.registry.probe();
  assert.equal(value.boards[0].available, true);
  assert.equal(value.boards[0].protocol_version, 1);
  assert.equal(value.boards[0].canSync, true);
  assert.equal(value.boards[0].canDetach, false);
  dispose();
  assert.deepEqual(await f.registry.probe(), { boards: [], executors: [] });
});

test('incompatible or malformed adapter responses fail closed', async t => {
  for (const mode of ['bad-version', 'bad-json', 'wrong-id', 'timeout']) {
    const f = await setup(t, mode, { timeout_ms: 200 });
    registerStdioAdapters(f.file, f.registry);
    const result = await f.registry.probe();
    assert.equal(result.boards[0].available, false, mode);
    const bridge = new LocalBridge({}, { registry: f.registry, stateDir: f.dir });
    await assert.rejects(bridge.requireAdapter(f.registry.boards, 'test-board'));
  }
});

test('adapter configuration cannot forward a Team Hub credential', async t => {
  const f = await setup(t, 'good', { env: ['TEAMHUB_TOKEN'] });
  assert.throws(() => registerStdioAdapters(f.file, f.registry), { code: 'INVALID_ADAPTER_CONFIG' });
  assert.deepEqual(await f.registry.probe(), { boards: [], executors: [] });
});
