import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createToolDefinitions } from '../lib/tools.mjs';
import { Config, apply, inject } from '../lib/index.mjs';
import { AdapterRegistry } from '../lib/client/bridge.mjs';

test('actual SDK accepts tool definitions and plugin registers the native tools', () => {
  const registered = [];
  apply({ tools: { register: tool => registered.push(tool) } }, Config({}));
  assert.deepEqual(inject, ['tools']); assert.equal(registered.length, 25);
  assert.equal(new Set(registered.map(tool => tool.name)).size, registered.length);
  assert.ok(registered.some(tool => tool.name === 'teamhub_run_start'));
  assert.ok(registered.some(tool => tool.name === 'teamhub_pipeline_link'));
});

test('tool command forwards exact business version and stable operation id', async () => {
  let body;
  const client = { async command(id, action, data) { body = { id, action, ...data }; return { version: 4 }; } };
  const definitions = createToolDefinitions(defineTool, client, {}, new AdapterRegistry());
  const tool = definitions.find(value => value.name === 'teamhub_ledger_progress');
  const result = await tool.execute({ work_item_id: 'work-1', operation_id: 'tool-progress-1', expected_version: 3, data_json: '{"summary":"Reviewing","expected_version":999}' });
  assert.equal(JSON.parse(result).version, 4); assert.equal(body.expected_version, 3); assert.equal(body.operation_id, 'tool-progress-1');
});

test('status honestly reports no host adapters and explicit session binding is retained', async () => {
  let binding;
  const client = { async bootstrap() { return { me: { id: 'member-1' } }; }, async bindItem(id, data) { binding = { id, ...data }; return binding; } };
  const definitions = createToolDefinitions(defineTool, client, { async instance() { return 'machine-1'; } }, new AdapterRegistry());
  const status = JSON.parse(await definitions.find(t => t.name === 'teamhub_status').execute({}));
  assert.deepEqual(status, { context: { me: { id: 'member-1' } }, client_instance_id: 'machine-1', adapters: { boards: [], executors: [] } });
  await definitions.find(t => t.name === 'teamhub_bind_session').execute({ work_item_id: 'w1', operation_id: 'bind-1', data_json: '{"harness":"dsh","workspace_ref":"D:/work","session_id":"actual-session-1"}' });
  assert.equal(binding.session_id, 'actual-session-1'); assert.equal(binding.client_instance_id, 'machine-1');
});

test('the existing local token-file configuration remains usable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-token-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'token.txt');
  await fs.writeFile(tokenFile, 'synthetic-token\n');
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.TEAMHUB_TEST_TOKEN;
  delete process.env.TEAMHUB_TEST_TOKEN;
  t.after(() => { globalThis.fetch = originalFetch; if (originalEnv === undefined) delete process.env.TEAMHUB_TEST_TOKEN; else process.env.TEAMHUB_TEST_TOKEN = originalEnv; });
  let authorization;
  globalThis.fetch = async (_url, options) => { authorization = options.headers.Authorization; return new Response(JSON.stringify({ me: { id: 'member-1' } }), { status: 200 }); };
  const registered = [];
  apply({ tools: { register: tool => registered.push(tool) } }, Config({ tokenEnv: 'TEAMHUB_TEST_TOKEN', tokenFile, stateDir: directory }));
  await registered.find(tool => tool.name === 'teamhub_status').execute({});
  assert.equal(authorization, 'Bearer synthetic-token');
});

test('pipeline tools select a registered board and execution forwards pipeline context', async () => {
  let selected, started;
  const board = { async subscribe(id, workspace, options) { return { id, workspace, options }; } };
  const bridge = { async start(id, data) { started = { id, ...data }; return started; } };
  const definitions = createToolDefinitions(defineTool, {}, bridge, new AdapterRegistry(), null,
    name => { selected = name; return board; });
  const linked = JSON.parse(await definitions.find(t => t.name === 'teamhub_pipeline_link').execute({
    pipeline_id: 'pipe-1', workspace_ref: '/work', adapter: 'portable-board' }));
  assert.equal(selected, 'portable-board'); assert.equal(linked.id, 'pipe-1');
  await definitions.find(t => t.name === 'teamhub_run_start').execute({ work_item_id: 'item-1', operation_id: 'run-op',
    expected_version: 2, adapter: 'portable-executor', workspace_ref: '/work', pipeline_attempt_id: 'attempt-1', pipeline_generation: 3 });
  assert.equal(started.pipeline_attempt_id, 'attempt-1'); assert.equal(started.pipeline_generation, 3);
});

test('DSH loads explicitly configured cross-language adapters and unregisters them on disposal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-dsh-adapter-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worker = fileURLToPath(new URL('../../client/test/fixtures/adapter-worker.mjs', import.meta.url));
  const configFile = path.join(directory, 'adapters.json');
  await fs.writeFile(configFile, JSON.stringify({ schema_version: 1, adapters: [{ name: 'test-board', kind: 'board',
    command: process.execPath, args: [worker, 'good'], timeout_ms: 2000 }] }));
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TEAMHUB_DSH_ADAPTER_TEST;
  process.env.TEAMHUB_DSH_ADAPTER_TEST = 'synthetic-test-token';
  globalThis.fetch = async () => new Response(JSON.stringify({ me: { id: 'member-1' } }), { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; if (originalToken === undefined) delete process.env.TEAMHUB_DSH_ADAPTER_TEST; else process.env.TEAMHUB_DSH_ADAPTER_TEST = originalToken; });
  const registered = [], disposers = [];
  apply({ tools: { register: tool => registered.push(tool) }, get: () => null,
    effect(fn) { disposers.push(fn()); } }, Config({ adapterConfigFile: configFile, stateDir: directory, tokenEnv: 'TEAMHUB_DSH_ADAPTER_TEST' }));
  try {
    const status = JSON.parse(await registered.find(tool => tool.name === 'teamhub_status').execute({}));
    assert.equal(status.adapters.boards.find(value => value.name === 'test-board')?.available, true);
    assert.equal(status.adapters.boards.find(value => value.name === 'dsh-todo-kanban')?.available, false);
  } finally { disposers.reverse().forEach(dispose => dispose?.()); }
});
