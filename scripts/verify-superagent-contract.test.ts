/** 对真实 Superagent 路由及领域引擎做隔离契约测试；执行器是不会启动模型的测试替身。 */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('Superagent adapter interoperates with the actual management routes and engine', async () => {
  const source = process.env.TEAMHUB_SUPERAGENT_SOURCE;
  const adapterEntry = process.env.TEAMHUB_SUPERAGENT_ADAPTER;
  if (!source || !adapterEntry) throw new Error('Missing source or adapter path');
  const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
  const [{ registerHttp }, { Engine, MemoryRepositories }, { SettingsSchema, settingsPolicy }, { ticketExecution }, adapterModule] = await Promise.all([
    load('src/app/http.ts'), load('src/core/index.ts'), load('src/policy.ts'), load('src/executor/dsh.ts'),
    import(pathToFileURL(adapterEntry).href),
  ]);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-real-superagent-'));
  const parsed = SettingsSchema.parse({ executor: { directory: workspace, directoryMode: 'fixed' } });
  const repo = new MemoryRepositories();
  const scope = { scope: () => ({ listened: true, observed: false }) };
  let clock = 0, executorStarts = 0;
  const engine = new Engine({ repo, scope, policy: () => settingsPolicy(parsed, scope),
    assessor: { request: () => {}, release: () => {} },
    executor: { start: () => { executorStarts++; }, deliver: () => {}, stop: () => {} },
    prepareTicket: (ticket: any, outcome: any) => ({ ...ticket, execution: ticketExecution(ticket, outcome, parsed, workspace, undefined, true) }),
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    now: () => new Date(Date.UTC(2026, 10, 14, 0, 0, clock++)).toISOString() });
  const store = Object.assign(repo, { settings: () => parsed,
    read: { subscribedThreads: () => [], firstTrigger: () => undefined, threadTriggers: () => [] } });
  const runtime = { ready: Promise.resolve(), store, engine, sources: { kind: () => undefined },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }), requestPass: () => {}, health: {}, machine: {}, configured: () => false };
  let handler: (req: any, res: any) => Promise<void>;
  const server = createServer((req, res) => {
    if (req.url === '/orchestrator/api/state' || req.url === '/orchestrator/api/settings') {
      const value = req.url.endsWith('/state') ? { setup: { problem: null }, health: { runtime: { state: 'ready' } }, paused: false }
        : { blocks: { executor: { value: parsed.executor } }, environment: { root: workspace } };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
    }
    void handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  registerHttp({ webServer: { host: '127.0.0.1', port, register: (route: any) => { handler = route.handler; return () => {}; } } }, runtime);
  try {
    const adapter = new adapterModule.DshSuperagentAdapter({ url: `http://127.0.0.1:${port}` });
    const input = { item_id: 'synthetic-item', run_id: 'synthetic-run', dispatch_id: 'synthetic-dispatch',
      workspace_ref: workspace, input_snapshot: { title: '合成任务', description: '仅验证接口', acceptance_spec: ['无外部副作用'] },
      capability_releases: [], spec_revision: 1, assignment_generation: 1 };
    expect((await adapter.probe()).available).toBe(true);
    const first = await adapter.start(input), retry = await adapter.start(input);
    expect(first.run_id).toBe(retry.run_id);
    expect(repo.tickets.list()).toHaveLength(1);
    expect(executorStarts).toBe(1); // 测试替身只记录调用，不启动模型或进程。
    const detail = await fetch(`http://127.0.0.1:${port}/orchestrator/api/tickets/${first.run_id}`,
      { headers: { 'X-Orchestrator-Request': '1' } });
    expect(detail.status, await detail.text()).toBe(200);
    expect((await adapter.getStatus(first)).status).toBe('queued');
    expect(await adapter.cancel(first)).toEqual({ requested: true, confirmed: false });
    expect((await adapter.getStatus(first)).status).toBe('unknown');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const tempRoot = await fs.realpath(os.tmpdir()), target = await fs.realpath(workspace);
    if (!target.startsWith(tempRoot + path.sep)) throw new Error('Temporary workspace is outside the expected root');
    await fs.rm(target, { recursive: true, force: true });
  }
}, 30000);
