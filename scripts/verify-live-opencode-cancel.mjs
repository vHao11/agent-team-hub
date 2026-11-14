/** 用临时目录验证真实 OpenCode 子进程的取消确认。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioExecutionAdapter } from '../packages/client/src/stdio-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_CLI !== '1' || process.platform !== 'win32') throw new Error('必须显式启用 Windows 真实 CLI 验收。');
const binary = process.env.TEAMHUB_OPENCODE_BINARY;
if (!path.isAbsolute(binary || '')) throw new Error('必须指定 OpenCode 绝对路径。');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-live-opencode-stop-'));
const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
const adapter = new StdioExecutionAdapter({ name: 'opencode-stop', kind: 'executor', command: process.execPath,
  args: [fileURLToPath(new URL('../packages/client/src/cli-executor.mjs', import.meta.url)), 'opencode-stop', 'opencode', binary,
    workspace, path.join(root, 'jobs'), 'read-only'], cwd: root,
  env: ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'], timeout_ms: 20000 });
assert.equal((await adapter.probe()).available, true);
const id = `cancel-${randomUUID()}`;
const handle = await adapter.start({ item_id: 'synthetic', run_id: 'synthetic', dispatch_id: id, workspace_ref: workspace,
  input_snapshot: { title: '取消确认测试', description: '请详细解释一百个不同的算法概念，每个概念使用一段完整的说明。不要读取或修改文件。' },
  capability_releases: [], spec_revision: 1, assignment_generation: 1 });
let state, deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  state = await adapter.getStatus(handle);
  if (state.status === 'running') break;
  if (['failed', 'succeeded', 'unknown'].includes(state.status)) throw new Error(`测试未进入运行：${state.status}`);
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(state?.status, 'running');
await new Promise(resolve => setTimeout(resolve, 1000));
const requested = await adapter.cancel(handle);
assert.deepEqual(requested, { requested: true, confirmed: false });
deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  state = await adapter.getStatus(handle);
  if (['cancelled', 'failed', 'succeeded', 'unknown'].includes(state.status)) break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
assert.equal(state?.status, 'cancelled');
const evidence = JSON.parse(await fs.readFile(path.join(root, 'jobs', id, 'windows-job-result.json'), 'utf8'));
assert.equal(evidence.cancel_confirmed, true);
assert.deepEqual(await adapter.cancel(handle), { requested: false, confirmed: true });
console.log(JSON.stringify({ event: 'live_opencode_cancel_passed', real_binary: true, process_group_stopped: true, evidence_dir: root }));
