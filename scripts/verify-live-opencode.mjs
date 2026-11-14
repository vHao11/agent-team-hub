/** 在隔离演示 Hub、临时工作区和真实 OpenCode 上验证固定版本与跨组流转。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HubClient } from '../packages/client/src/index.mjs';
import { AdapterRegistry, LocalBridge } from '../packages/client/src/bridge.mjs';
import { AutoDispatcher } from '../packages/client/src/auto-dispatch.mjs';
import { StdioExecutionAdapter } from '../packages/client/src/stdio-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_CLI !== '1') throw new Error('必须显式启用真实 CLI 验收。');
const hubUrl = process.env.TEAMHUB_ISOLATED_URL, binary = process.env.TEAMHUB_OPENCODE_BINARY;
if (!hubUrl || new URL(hubUrl).hostname !== '127.0.0.1' || !path.isAbsolute(binary || '')) throw new Error('需要隔离 Hub 和本机 OpenCode 程序。');
const health = await fetch(`${hubUrl}/api/v1/health`).then(response => response.json());
if (health.demo_mode !== true) throw new Error('仅允许使用隔离演示 Hub。');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-live-opencode-'));
const resolved = await fs.realpath(root), temp = await fs.realpath(os.tmpdir());
if (!resolved.startsWith(temp + path.sep)) throw new Error('隔离工作区不在系统临时目录内。');
const workspace = path.join(root, 'workspace'), state = path.join(root, 'bridge'), jobs = path.join(root, 'jobs');
await fs.mkdir(workspace);
const requester = new HubClient({ url: hubUrl, token: 'demo-lin' });
const implementer = new HubClient({ url: hubUrl, token: 'demo-chen' });
const tester = new HubClient({ url: hubUrl, token: 'demo-xu' });
const registry = new AdapterRegistry();
const program = fileURLToPath(new URL('../packages/client/src/cli-executor.mjs', import.meta.url));
registry.registerExecutor('local-opencode', new StdioExecutionAdapter({ name: 'local-opencode', kind: 'executor', command: process.execPath,
  args: [program, 'local-opencode', 'opencode', binary, workspace, jobs, 'read-only'], cwd: root,
  env: ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'], timeout_ms: 20000 }));
const bridge = new LocalBridge(implementer, { registry, stateDir: state, instanceId: 'opencode-validation' });
const auto = new AutoDispatcher(implementer, bridge);
const op = () => `opencode-validation-${randomUUID()}`;
const marker = `PINNED_${randomUUID().replaceAll('-', '').toUpperCase()}`;
const capability = await requester.createCapability({ slug: `validation-${randomUUID()}`, name: '【系统测试】固定能力',
  description: '隔离环境中的固定版本技能', kind: 'skill', tags: ['验证'] });
const publish = (version, body) => requester.publishRelease(capability.id, { version,
  manifest: { schema_version: 1, kind: 'skill', entry: 'SKILL.md', version },
  files: { 'SKILL.md': `---\nname: fixed-validation\ndescription: 读取固定版本的验证标识\n---\n\n${body}\n` } });
const pinned = await publish('1.0.0', `请在最终答复中原样写出这个标识：${marker}`);
await publish('2.0.0', '这是较新的版本，但此流程不应使用它。');
const definition = {
  roles: [{ key: 'dev', label: '实施组', kind: 'team' }, { key: 'qa', label: '验证组', kind: 'team' },
    { key: 'review', label: '验收人', kind: 'reviewer' }],
  steps: [{ key: 'agent', name: '固定技能验证', team_role: 'dev', reviewer_role: 'review', depends_on: [],
    capabilities: [{ capability_id: capability.id, version: '1.0.0' }], acceptance_spec: ['读取固定版本技能并提交标识'], required_artifact_kinds: ['document'] },
  { key: 'parallel', name: '并行人工验证', team_role: 'qa', reviewer_role: 'review', depends_on: [], capabilities: [],
    acceptance_spec: ['提交合成验证记录'], required_artifact_kinds: ['document'] },
  { key: 'join', name: '跨组汇合', team_role: 'qa', reviewer_role: 'review', depends_on: ['agent', 'parallel'], capabilities: [],
    acceptance_spec: ['核对两个分支'], required_artifact_kinds: ['document'] }],
};
const template = await requester.request('POST', '/workflow-templates', { operation_id: op(), name: '【系统测试】OpenCode 跨组模板', definition });
const version = await requester.request('POST', `/workflow-templates/${template.id}/publish`, { operation_id: op(), expected_revision: template.draft_revision });
let view = await requester.request('POST', '/pipelines', { operation_id: op(), title: '【系统测试】OpenCode 固定技能',
  description: `请使用 skill 工具加载技能 ID ${capability.id}，根据该技能的内容原样回复其中的标识。不要使用 shell，不要更改文件。`,
  project_id: 'proj-interface', template_version_id: version.id,
  role_bindings: { dev: 'team-clearing', qa: 'team-qa', review: 'u-lin' }, assignees: { agent: 'u-chen', parallel: 'u-xu', join: 'u-xu' } });
const pipeline = view.pipeline.id;
view = await requester.request('POST', `/pipelines/${pipeline}/start`, { operation_id: op(), expected_version: view.pipeline.version });
await auto.enable({ pipeline_id: pipeline, adapter: 'local-opencode', workspace_ref: workspace, auto_accept: true });
const first = await auto.tick();
const launch = first[0]?.steps?.find(value => value.step === 'agent' && value.action === 'started');
if (!launch) throw new Error(`自动派发未启动：${JSON.stringify(first)}`);
const refresh = async () => { view = await requester.getPipeline(pipeline); return view; };
const context = step => ({ pipeline_attempt_id: step.attempt.id, pipeline_generation: view.pipeline.generation });
async function completeHuman(index, client, text) {
  let step = view.steps[index];
  await client.command(step.item.id, 'accept', { operation_id: op(), expected_version: step.item.version, ...context(step) });
  await refresh(); step = view.steps[index];
  await client.command(step.item.id, 'start', { operation_id: op(), expected_version: step.item.version, ...context(step) });
  await refresh(); step = view.steps[index];
  const artifact = await client.uploadArtifact(new Blob([text], { type: 'text/plain' }), 'validation.txt');
  const delivery = await client.submitDelivery(step.item.id, { operation_id: op(), expected_version: step.item.version,
    spec_revision: step.item.spec_revision, summary: text, artifacts: [{ label: '验收记录', url: artifact.url, kind: 'document' }], ...context(step) });
  await refresh(); step = view.steps[index];
  await requester.reviewDelivery(delivery.id, { operation_id: op(), expected_version: step.item.version, decision: 'approve', ...context(step) });
  await refresh();
}
await refresh(); await completeHuman(1, tester, '隔离演示身份完成并行验证');
assert.equal(view.steps[2].state, 'waiting');
let run, previous = '';
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  await auto.tick();
  const detail = await implementer.getItem(view.steps[0].item.id);
  run = detail.runs.find(value => value.dispatch_id === launch.dispatch_id);
  if (run?.status !== previous) { previous = run?.status || 'unknown'; console.log(JSON.stringify({ event: 'live_opencode_status', status: previous })); }
  if (['succeeded', 'failed', 'cancelled'].includes(run?.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (run?.status !== 'succeeded') throw new Error(`真实 OpenCode 未确认成功：${run?.status || 'unknown'}`);
assert.equal(run.capability_releases[0]?.release_id, pinned.id);
assert.equal(run.capability_releases[0]?.version, '1.0.0');
assert.ok(run.result_summary?.includes(marker), '真实模型必须读取固定技能后报告其独有标识。');
const installedFile = path.join(workspace, '.teamhub-runs', run.dispatch_id, 'capabilities', capability.id, 'SKILL.md');
assert.match(await fs.readFile(installedFile, 'utf8'), new RegExp(marker));
let item = await implementer.getItem(view.steps[0].item.id);
const evidence = await implementer.uploadArtifact(new Blob([run.result_summary], { type: 'text/plain' }), 'opencode-result.txt');
const delivery = await implementer.submitDelivery(item.item.id, { operation_id: op(), expected_version: item.item.version,
  spec_revision: item.item.spec_revision, summary: run.result_summary, run_ids: [run.id],
  artifacts: [{ label: '真实执行结果', url: evidence.url, kind: 'document' }], ...context(view.steps[0]) });
await refresh();
await requester.reviewDelivery(delivery.id, { operation_id: op(), expected_version: view.steps[0].item.version, decision: 'approve', ...context(view.steps[0]) });
await refresh(); assert.equal(view.steps[2].state, 'awaiting_accept');
assert.equal(view.steps[2].attempt.input_snapshot.upstream_deliveries.length, 2);
await completeHuman(2, tester, '已核对两个分支的交付');
assert.equal(view.pipeline.status, 'completed');
console.log(JSON.stringify({ event: 'live_opencode_workflow_passed', real_model: true, pinned_version: '1.0.0', newer_version_ignored: true,
  fixed_skill_read: true, parallel_join: true, teams: 2, pipeline_status: view.pipeline.status, evidence_dir: root }));
