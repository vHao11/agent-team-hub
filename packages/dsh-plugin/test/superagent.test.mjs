import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshSuperagentAdapter } from '../lib/superagent-adapter.mjs';
import { prepareRuntimeCapabilities } from '../../client/src/runtime-capabilities.mjs';

test('Superagent adapter uses the management API and never treats stop acknowledgement as confirmation', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-superagent-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let posted, posts = 0, stops = 0, ticket = { stage: 'working', action: 'queued', directory: workspace };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['x-orchestrator-request'], '1');
    let body = ''; for await (const chunk of req) body += chunk;
    let result;
    if (req.url === '/orchestrator/api/state') result = { setup: { problem: null }, health: { runtime: { state: 'ready' } }, paused: false };
    else if (req.url === '/orchestrator/api/settings') result = { blocks: { executor: { value: { directoryMode: 'fixed', taskTypes: [] } } }, environment: { root: workspace } };
    else if (req.url === '/orchestrator/api/tasks') { posted = JSON.parse(body); posts++; result = { ticketId: 'ticket-1', ticket }; }
    else if (req.url?.startsWith('/orchestrator/api/decisions?')) {
      const trigger = createHash('sha256').update(JSON.stringify(['operator-task', posted.requestId, posted.title, posted.request, '', '', 'kanban-task'])).digest('hex').slice(0, 32);
      result = req.url.includes('offset=0') ? { items: [], next_offset: 100 }
        : { items: [{ triggerIds: [trigger], ticketId: 'ticket-1' }], next_offset: null };
    }
    else if (req.url === '/orchestrator/api/tickets/ticket-1/stop') { stops++; ticket = { stage: 'ended', ended: { by: 'human', outcome: 'stopped' } }; result = { stopped: true }; }
    else if (req.url === '/orchestrator/api/tickets/ticket-1') result = ticket;
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new DshSuperagentAdapter({ url: `http://127.0.0.1:${server.address().port}`, stateDir: path.join(workspace, 'bridge') });
  const input = { item_id: 'item-1', run_id: 'run-1', dispatch_id: 'dispatch-1', workspace_ref: workspace,
    input_snapshot: { title: '合成任务', description: '冻结说明', acceptance_spec: ['核对结果'] },
    capability_releases: [], spec_revision: 2, assignment_generation: 3 };
  assert.equal((await adapter.probe()).available, true);
  await assert.rejects(adapter.start({ ...input, capability_releases: [{ id: 'pinned' }] }), { code: 'ADAPTER_PRECONDITION_FAILED' });
  await assert.rejects(adapter.start({ ...input, workspace_ref: path.dirname(workspace) }), { code: 'ADAPTER_PRECONDITION_FAILED' });
  assert.equal(posts, 0);
  ticket = { stage: 'working', action: 'queued', directory: path.join(workspace, 'missing') };
  await assert.rejects(adapter.start(input), { code: 'SUPERAGENT_WORKSPACE_UNCERTAIN' });
  assert.equal(stops, 1);
  ticket = { stage: 'working', action: 'queued', directory: workspace };
  const handle = await adapter.start(input);
  assert.equal(handle.run_id, 'ticket-1'); assert.equal(handle.status, 'queued');
  assert.equal(posted.requestId, 'dispatch-1'); assert.match(posted.request, /冻结说明/);
  assert.equal((await adapter.probe()).canRecover, true);
  assert.equal((await adapter.findByDispatchId('dispatch-1')).run_id, 'ticket-1');
  assert.equal(posts, 2, '恢复只读取决策，不能再次派单');
  assert.equal((await adapter.getStatus(handle)).status, 'queued');
  assert.deepEqual(await adapter.cancel(handle), { requested: true, confirmed: false });
  assert.equal((await adapter.getStatus(handle)).status, 'unknown');
  ticket = { stage: 'ended', ended: { by: 'executor', outcome: 'completed' }, summary: '结果' };
  assert.equal((await adapter.getStatus(handle)).status, 'succeeded');
});

test('Superagent adapter refuses non-loopback and credential-bearing addresses', () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:3080/path', 'http://user:pass@127.0.0.1:3080']) {
    assert.throws(() => new DshSuperagentAdapter({ url }), { code: 'INVALID_SUPERAGENT_URL' });
  }
});

test('Superagent receives verified fixed entry content and refuses oversized snapshots before creating a ticket', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-superagent-pinned-'));
  assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let posts = 0, posted;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let result;
    if (req.url === '/orchestrator/api/settings') result = { blocks: { executor: { value: { directoryMode: 'fixed' } } }, environment: { root: workspace } };
    else if (req.url === '/orchestrator/api/tasks') { posts++; posted = JSON.parse(raw); result = { ticketId: 'pinned-ticket', ticket: { stage: 'working', directory: workspace } }; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new DshSuperagentAdapter({ url: `http://127.0.0.1:${server.address().port}` });
  const pin = { capability_id: 'cap-pinned', release_id: 'rel-pinned', version: '1.0.0' };
  let text = '固定入口内容';
  const client = { async getCapability() { return { id: pin.capability_id, kind: 'skill', slug: 'test' }; },
    async getRelease() { return { id: pin.release_id, capability_id: pin.capability_id, version: pin.version,
      manifest: { kind: 'skill', entry: 'SKILL.md' }, files: { 'SKILL.md': text } }; } };
  const installed = await prepareRuntimeCapabilities(client, workspace, 'dispatch-fixed', [pin]);
  const input = { item_id: 'item', run_id: 'run', dispatch_id: 'dispatch-fixed', workspace_ref: workspace,
    input_snapshot: { title: '固定技能' }, capability_releases: [pin], installed_capabilities: installed, spec_revision: 1, assignment_generation: 1 };
  await adapter.start(input);
  assert.match(posted.request, /固定入口内容/); assert.equal(posts, 1);
  text = 'A'.repeat(21000);
  const oversized = await prepareRuntimeCapabilities(client, workspace, 'dispatch-large', [pin]);
  await assert.rejects(adapter.start({ ...input, dispatch_id: 'dispatch-large', installed_capabilities: oversized }), { code: 'ADAPTER_PRECONDITION_FAILED' });
  assert.equal(posts, 1);
});
