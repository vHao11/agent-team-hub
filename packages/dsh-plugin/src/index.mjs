import { readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HubClient } from './client/index.mjs';
import { LocalBridge, adapters } from './client/bridge.mjs';
import { DshKanbanAdapter, PipelineBoardSync } from './client/board-sync.mjs';
import { registerStdioAdapters } from './client/stdio-adapter.mjs';
import { DshSuperagentAdapter } from './superagent-adapter.mjs';
import { createToolDefinitions } from './tools.mjs';
import { createBoardActions } from './board-actions.mjs';
import { AutoDispatcher } from './client/auto-dispatch.mjs';

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
  boardAdapter: Schema.string().default('dsh-todo-kanban'),
  adapterConfigFile: Schema.string().default(''),
  superagentUrl: Schema.string().default(''),
  superagentTaskType: Schema.string().default(''),
});

export function apply(ctx, config = {}) {
  const token = process.env[config.tokenEnv || 'TEAMHUB_TOKEN'] ||
    (config.tokenFile ? readFileSync(config.tokenFile, 'utf8').trim() : undefined);
  const client = new HubClient({ url: config.serverUrl || process.env.TEAMHUB_URL || 'http://127.0.0.1:8765',
    token, timeout: config.timeoutMs || 20000 });
  const bridge = new LocalBridge(client, { registry: adapters,
    ...(config.stateDir ? { stateDir: config.stateDir } : {}),
    ...(config.clientInstanceId ? { instanceId: config.clientInstanceId } : {}) });
  const defaultBoard = config.boardAdapter || 'dsh-todo-kanban';
  const syncs = new Map();
  const boardSyncFor = (name = defaultBoard) => {
    const selected = name || defaultBoard;
    if (!syncs.has(selected)) syncs.set(selected, new PipelineBoardSync(client, bridge, { adapter: selected }));
    return syncs.get(selected);
  };
  const sync = boardSyncFor();
  const autoDispatch = new AutoDispatcher(client, bridge);
  if (typeof ctx.provide === 'function') ctx.provide('teamHubActions', createBoardActions(client, sync));
  if (typeof ctx.get === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => adapters.registerBoard('dsh-todo-kanban', new DshKanbanAdapter(() => ctx.get('todoKanbanHub'))),
      'team-hub: todo-kanban adapter');
    if (config.adapterConfigFile) ctx.effect(() => registerStdioAdapters(config.adapterConfigFile, adapters),
      'team-hub: external adapters');
    if (config.superagentUrl) ctx.effect(() => adapters.registerExecutor('dsh-superagent', new DshSuperagentAdapter({
      url: config.superagentUrl, taskType: config.superagentTaskType || '', stateDir: bridge.stateDir, timeout: config.timeoutMs || 20000,
    })), 'team-hub: Superagent adapter');
    ctx.effect(() => {
      const tick = () => {
        for (const name of new Set([defaultBoard, ...adapters.boards.keys()])) {
          const selected = boardSyncFor(name);
          void selected.syncAll().catch(error => {
            selected.lastResult = { state: 'offline', error: error.code || 'SYNC_FAILED', message: error.message };
            void adapters.boards.get(name)?.setSyncStatus?.('offline').catch(() => {});
          });
        }
        void autoDispatch.tick().catch(error => {
          autoDispatch.lastResult = { state: 'degraded', error: error.code || 'AUTOMATION_FAILED', message: error.message };
        });
      };
      void tick();
      const seconds = Math.max(5, Math.min(600, Number(config.boardSyncSeconds) || 15));
      const timer = setInterval(tick, seconds * 1000);
      return () => clearInterval(timer);
    }, 'team-hub: pipeline board sync');
  }
  for (const tool of createToolDefinitions(defineTool, client, bridge, adapters, sync, boardSyncFor, autoDispatch)) ctx.tools.register(tool);
}
