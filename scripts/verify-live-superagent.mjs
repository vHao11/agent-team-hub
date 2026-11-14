/** 仅对隔离演示 Hub 和显式指定的真实本机 Superagent 运行验收任务。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HubClient } from '../packages/client/src/index.mjs';
import { AdapterRegistry, LocalBridge } from '../packages/client/src/bridge.mjs';
import { AutoDispatcher } from '../packages/client/src/auto-dispatch.mjs';
import { DshSuperagentAdapter } from '../packages/dsh-plugin/lib/superagent-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_SUPERAGENT !== '1') throw new Error('必须显式启用真实 Superagent 验收。');
const hubUrl = process.env.TEAMHUB_ISOLATED_URL;
const superagentUrl = process.env.TEAMHUB_SUPERAGENT_URL;
const stateDir = process.env.TEAMHUB_ISOLATED_STATE;
if (!hubUrl || !superagentUrl || !stateDir || new URL(hubUrl).hostname !== '127.0.0.1' || new URL(superagentUrl).hostname !== '127.0.0.1') throw new Error('需要隔离 Hub 和本机回环 Superagent。');
const health = await fetch(`${hubUrl}/api/v1/health`).then(response => response.json());
if (health.demo_mode !== true) throw new Error('仅允许使用隔离演示 Hub。');
const headers = { 'X-Orchestrator-Request': '1' };
const hostState = await fetch(`${superagentUrl}/orchestrator/api/state`, { headers }).then(response => response.json());
if (hostState.health?.runtime?.state !== 'ready' || hostState.paused || hostState.setup?.problem || hostState.load?.running || hostState.load?.queued) throw new Error('本机 Superagent 尚未空闲或就绪。');
const settings = await fetch(`${superagentUrl}/orchestrator/api/settings`, { headers }).then(response => response.json());
const type = settings.blocks?.executor?.value?.taskTypes?.find(value => value.readOnly === true && value.directoryMode === 'fixed' && value.engine === 'dsh');
if (!type?.id || !type.directory) throw new Error('没有可用的只读固定目录 DSH 任务类型。');

const requester = new HubClient({ url: hubUrl, token: 'demo-lin' });
const implementer = new HubClient({ url: hubUrl, token: 'demo-chen' });
const tester = new HubClient({ url: hubUrl, token: 'demo-xu' });
const registry = new AdapterRegistry();
let launchRequests = 0;
const loseFirstLaunchResponse = async (url, options) => {
  const response = await fetch(url, options);
  if (options.method === 'POST' && String(url).endsWith('/tasks')) {
    launchRequests++;
    if (launchRequests === 1 && response.ok) { await response.arrayBuffer(); throw new Error('模拟启动响应丢失'); }
  }
  return response;
};
registry.registerExecutor('dsh-superagent', new DshSuperagentAdapter({ url: superagentUrl, taskType: type.id,
  stateDir, fetchImpl: loseFirstLaunchResponse }));
const bridge = new LocalBridge(implementer, { registry, stateDir, instanceId: 'live-validation-instance' });
const auto = new AutoDispatcher(implementer, bridge);
const op = () => `live-validation-${randomUUID()}`;
const marker = `PINNED_${randomUUID().replaceAll('-', '').toUpperCase()}`;
const capability = await requester.createCapability({ slug: `superagent-validation-${randomUUID()}`, name: '【系统测试】固定能力',
  description: '隔离环境中的固定版本技能', kind: 'skill', tags: ['验证'] });
const publish = (version, text) => requester.publishRelease(capability.id, { version,
  manifest: { schema_version: 1, kind: 'skill', entry: 'SKILL.md', version },
  files: { 'SKILL.md': `---\nname: validation\ndescription: 读取固定版本的验证标识\n---\n\n${text}\n` } });
const fixed = await publish('1.0.0', `请在报告中原样写出这个标识：${marker}`);
await publish('2.0.0', '这是较新的版本，但此流程不应使用它。');
const definition = {
  roles: [{ key: 'dev', label: '实施组', kind: 'team' }, { key: 'qa', label: '验证组', kind: 'team' },
    { key: 'review', label: '验收人', kind: 'reviewer' }],
  steps: [{ key: 'agent', name: '只读模型验证', team_role: 'dev', reviewer_role: 'review', depends_on: [],
    capabilities: [{ capability_id: capability.id, version: '1.0.0' }],
    acceptance_spec: ['报告包含固定技能中的标识'], required_artifact_kinds: ['document'] },
  { key: 'parallel', name: '并行人工验证', team_role: 'qa', reviewer_role: 'review', depends_on: [], capabilities: [],
    acceptance_spec: ['提交合成验证记录'], required_artifact_kinds: ['document'] },
  { key: 'join', name: '汇合验证', team_role: 'qa', reviewer_role: 'review', depends_on: ['agent', 'parallel'], capabilities: [],
    acceptance_spec: ['汇合两个分支的结果'], required_artifact_kinds: ['document'] }],
};
const template = await requester.request('POST', '/workflow-templates', { operation_id: op(), name: '【系统测试】并行跨组模板', definition });
const release = await requester.request('POST', `/workflow-templates/${template.id}/publish`, { operation_id: op(), expected_revision: template.draft_revision });
let view = await requester.request('POST', '/pipelines', { operation_id: op(), title: '【系统测试】真实 Superagent 接入',
  description: '这是一条隔离验收任务。请阅读 capability_entries 中固定技能的入口内容，将其中的标识原样写入报告，并使用工单报告工具提交 ready 状态。不要修改、删除或发送文件和外部信息。',
  project_id: 'proj-interface', template_version_id: release.id,
  role_bindings: { dev: 'team-clearing', qa: 'team-qa', review: 'u-lin' }, assignees: { agent: 'u-chen', parallel: 'u-xu', join: 'u-xu' } });
const pipeline = view.pipeline.id;
view = await requester.request('POST', `/pipelines/${pipeline}/start`, { operation_id: op(), expected_version: view.pipeline.version });
assert.equal(view.steps[0].state, 'awaiting_accept'); assert.equal(view.steps[1].state, 'awaiting_accept');
await auto.enable({ pipeline_id: pipeline, adapter: 'dsh-superagent', workspace_ref: type.directory, auto_accept: true });
const firstTick = await auto.tick();
const uncertain = firstTick[0]?.steps?.find(value => value.step === 'agent' && value.error === 'LAUNCH_UNCERTAIN');
if (!uncertain?.dispatch_id) throw new Error(`真实执行未产生预期的响应丢失状态：${JSON.stringify(firstTick)}`);
const dispatchId = uncertain.dispatch_id;
console.log(JSON.stringify({ event: 'live_superagent_response_lost', dispatch_id: dispatchId }));

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
await refresh();
await completeHuman(1, tester, '隔离演示身份完成并行验证');
assert.equal(view.steps[2].state, 'waiting', '汇合必须等待真实执行分支。');
let lastStatus = '';
let run;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  await auto.tick();
  const detail = await implementer.getItem(view.steps[0].item.id);
  run = detail.runs.find(value => value.dispatch_id === dispatchId);
  if (run?.status !== lastStatus) { lastStatus = run?.status || 'unknown'; console.log(JSON.stringify({ event: 'live_superagent_status', status: lastStatus })); }
  if (['succeeded', 'failed', 'cancelled'].includes(run?.status)) break;
  await new Promise(resolve => setTimeout(resolve, 3000));
}
if (run?.status !== 'succeeded') throw new Error(`真实 Superagent 未确认成功：${run?.status || 'unknown'}；派发 ${dispatchId}`);
assert.equal(launchRequests, 1, '响应丢失后的恢复不能重复派单。');
assert.ok(run.external_run_id, '真实工单句柄必须存在');
assert.equal(run.capability_releases[0]?.release_id, fixed.id);
assert.equal(run.capability_releases[0]?.version, '1.0.0');
assert.ok(String(run.result_summary || '').includes(marker), '真实模型必须读取固定技能后报告其独有标识。');
assert.match(await fs.readFile(path.join(type.directory, '.teamhub-runs', dispatchId, 'capabilities', capability.id, 'SKILL.md'), 'utf8'), new RegExp(marker));
const item = await implementer.getItem(view.steps[0].item.id);
const evidence = await implementer.uploadArtifact(new Blob([run.result_summary || '真实 Superagent 执行已确认完成。'], { type: 'text/plain' }), 'superagent-result.txt');
const delivery = await implementer.submitDelivery(item.item.id, { operation_id: op(), expected_version: item.item.version,
  spec_revision: item.item.spec_revision, summary: run.result_summary || '真实执行已完成', run_ids: [run.id],
  artifacts: [{ label: '真实执行结果', url: evidence.url, kind: 'document' }], ...context(view.steps[0]) });
await refresh();
await requester.reviewDelivery(delivery.id, { operation_id: op(), expected_version: view.steps[0].item.version, decision: 'approve', ...context(view.steps[0]) });
await refresh();
assert.equal(view.steps[2].state, 'awaiting_accept');
assert.equal(view.steps[2].attempt.input_snapshot.upstream_deliveries.length, 2);
await completeHuman(2, tester, '已核对两个分支的交付');
assert.equal(view.pipeline.status, 'completed');
console.log(JSON.stringify({ event: 'live_superagent_workflow_passed', pipeline_status: view.pipeline.status,
  actual_ticket_created: true, real_model_run_succeeded: true, parallel_join: true, teams: 2, demo_members: 3,
  fixed_version_installed_and_read: true, newer_version_ignored: true,
  lost_response_recovered_without_redispatch: true, marker_present_in_result: true, ticket_id: run.external_run_id }));
