/** Called by verify-dsh-host.py inside its temporary, isolated environment. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.join(process.env.DSH_SMOKE_RUNTIME_DIR, 'package.json'));
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')));
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-launch-environment')));

const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]);
const runtime = await runProfile({
  environment, profile: 'web', patchFiles: [],
  args: ['--host', '127.0.0.1', '--port', process.env.DSH_SMOKE_PORT, '--no-open'],
});
try {
  const names = runtime.ctx.tools.definitions().map(tool => tool.name).filter(name => name.startsWith('teamhub_'));
  assert.equal(names.length, 22);
  assert.equal(new Set(names).size, 22);
  const status = JSON.parse(await runtime.ctx.tools.get('teamhub_status').execute({}));
  assert.equal(status.context.me.id, 'u-lin');
  assert.ok(status.client_instance_id);
  assert.equal(status.adapters.boards.length, 1);
  assert.equal(status.adapters.boards[0].name, 'dsh-todo-kanban');
  assert.equal(status.adapters.boards[0].available, false);
  assert.deepEqual(status.adapters.executors, []);
  assert.equal(Object.hasOwn(status, 'host_validation'), false);
  const catalog = JSON.parse(await runtime.ctx.tools.get('teamhub_catalog_search').execute({ kind: 'script' }));
  assert.equal(catalog.items.length, 1);
  console.log('TEAMHUB_HOST_SMOKE=' + JSON.stringify({
    boot: 'passed', registered_tools: names.length,
    status_identity: status.context.me.id, catalog_scripts: catalog.items.length,
    adapter_boards: status.adapters.boards.length, adapter_executors: status.adapters.executors.length,
    model_calls: 0,
  }));
} finally {
  await runtime.shutdown.shutdown(0);
}
