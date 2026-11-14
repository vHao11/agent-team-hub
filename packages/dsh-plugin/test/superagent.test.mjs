import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshSuperagentAdapter } from '../lib/superagent-adapter.mjs';

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
    else if (req.url === '/orchestrator/api/tickets/ticket-1/stop') { stops++; ticket = { stage: 'ended', ended: { by: 'human', outcome: 'stopped' } }; result = { stopped: true }; }
    else if (req.url === '/orchestrator/api/tickets/ticket-1') result = ticket;
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new DshSuperagentAdapter({ url: `http://127.0.0.1:${server.address().port}` });
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
