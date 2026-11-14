/** 使用指定的本机 CLI 和隔离仓库执行只读合成任务。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioExecutionAdapter } from '../packages/client/src/stdio-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_CLI !== '1') throw new Error('必须显式启用真实 CLI 验收。');
const targets = [
  ['codex', process.env.TEAMHUB_CODEX_BINARY],
  ['claude', process.env.TEAMHUB_CLAUDE_BINARY],
].filter(([, binary]) => Boolean(binary));
if (!targets.length) throw new Error('没有指定 CLI 程序。');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-live-cli-evidence-'));
const resolved = await fs.realpath(root), temp = await fs.realpath(os.tmpdir());
if (!resolved.startsWith(temp + path.sep)) throw new Error('隔离目录不在系统临时目录内。');
console.log(JSON.stringify({ event: 'evidence_dir', path: resolved }));
const program = fileURLToPath(new URL('../packages/client/src/cli-executor.mjs', import.meta.url));
let failures = 0;
for (const [harness, binary] of targets) {
  const workspace = path.join(root, harness), state = path.join(root, harness + '-jobs');
  await fs.mkdir(workspace);
  const init = spawnSync('git', ['init', '--quiet', workspace], { windowsHide: true, encoding: 'utf8' });
  if (init.status !== 0) throw new Error('无法创建隔离 Git 仓库。');
  const adapter = new StdioExecutionAdapter({ name: `${harness}-live`, kind: 'executor', command: process.execPath,
    args: [program, `${harness}-live`, harness, binary, workspace, state, 'read-only'], cwd: root,
    env: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'], timeout_ms: 10000 });
  const marker = `TEAMHUB_${harness.toUpperCase()}_VALIDATED`;
  let handle;
  try {
    assert.equal((await adapter.probe()).available, true);
    handle = await adapter.start({ item_id: `test-${harness}`, run_id: `run-${harness}`, dispatch_id: `dispatch-${harness}`,
      workspace_ref: workspace, input_snapshot: { title: '只读接入验证', description: `只输出 ${marker}。不要读取或修改任何文件，不要调用工具或访问网络。`,
        acceptance_spec: [`输出 ${marker}`] }, capability_releases: [], spec_revision: 1, assignment_generation: 1 });
    let status, previous = '';
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      status = await adapter.getStatus(handle);
      if (status.status !== previous) { previous = status.status; console.log(JSON.stringify({ event: 'harness_status', harness, status: previous })); }
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(status.status)) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!status || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(status.status)) {
      await adapter.cancel(handle);
      throw new Error('运行超时，已请求停止并保留待核实状态。');
    }
    if (status.status !== 'succeeded' || !status.summary?.includes(marker)) throw new Error(`实际执行结果未确认：${status.status}`);
    assert.equal((await adapter.findByDispatchId(`dispatch-${harness}`)).run_id, handle.run_id);
    console.log(JSON.stringify({ event: 'harness_passed', harness, marker_present: true, recoverable: true }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ event: 'harness_failed', harness, code: error.code || 'VALIDATION_FAILED', message: error.message }));
  }
}
if (failures) process.exitCode = 1;
