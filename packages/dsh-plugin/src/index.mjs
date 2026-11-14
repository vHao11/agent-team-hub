import { readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HubClient } from './client/index.mjs';
import { LocalBridge, adapters } from './client/bridge.mjs';
import { DshKanbanAdapter, PipelineBoardSync } from './client/board-sync.mjs';
import { createToolDefinitions } from './tools.mjs';

export const name = 'team-hub';
export const inject = ['tools'];
export const Config = Schema.object({
  serverUrl: Schema.string().default(''),
  tokenEnv: Schema.string().default('TEAMHUB_TOKEN'),
  tokenFile: Schema.string().default(''),
  stateDir: Schema.string().default(''),
  clientInstanceId: Schema.string().default(''),
  timeoutMs: Schema.number().default(20000),
  boardSyncSeconds: Schema.number().default(15),
});

export function apply(ctx, config = {}) {
  const token = process.env[config.tokenEnv || 'TEAMHUB_TOKEN'] ||
    (config.tokenFile ? readFileSync(config.tokenFile, 'utf8').trim() : undefined);
  const client = new HubClient({ url: config.serverUrl || process.env.TEAMHUB_URL || 'http://127.0.0.1:8765',
    token, timeout: config.timeoutMs || 20000 });
  const bridge = new LocalBridge(client, { registry: adapters,
    ...(config.stateDir ? { stateDir: config.stateDir } : {}),
    ...(config.clientInstanceId ? { instanceId: config.clientInstanceId } : {}) });
  const sync = new PipelineBoardSync(client, bridge);
  if (typeof ctx.get === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => adapters.registerBoard('dsh-todo-kanban', new DshKanbanAdapter(() => ctx.get('todoKanbanHub'))),
      'team-hub: todo-kanban adapter');
    ctx.effect(() => {
      const tick = () => sync.syncAll().catch(error => {
        sync.lastResult = { state: 'offline', error: error.code || 'SYNC_FAILED', message: error.message };
        void adapters.boards.get('dsh-todo-kanban')?.setSyncStatus?.('offline').catch(() => {});
      });
      void tick();
      const seconds = Math.max(5, Math.min(600, Number(config.boardSyncSeconds) || 15));
      const timer = setInterval(tick, seconds * 1000);
      return () => clearInterval(timer);
    }, 'team-hub: pipeline board sync');
  }
  for (const tool of createToolDefinitions(defineTool, client, bridge, adapters, sync)) ctx.tools.register(tool);
}
