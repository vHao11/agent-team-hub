/** 隔离 Hub 和真实 Superagent：验证后台进程停止确认及跨组汇合。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HubClient } from '../packages/client/src/index.mjs';
import { AdapterRegistry, LocalBridge } from '../packages/client/src/bridge.mjs';
import { AutoDispatcher } from '../packages/client/src/auto-dispatch.mjs';
import { DshSuperagentAdapter } from '../packages/dsh-plugin/lib/superagent-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_SUPERAGENT_STOP !== '1') throw new Error('必须显式启用真实停止验收。');
const hubUrl = process.env.TEAMHUB_ISOLATED_URL, hostUrl = process.env.TEAMHUB_SUPERAGENT_URL, stateDir = process.env.TEAMHUB_ISOLATED_STATE;
if (!hubUrl || !hostUrl || !stateDir || new URL(hubUrl).hostname !== '127.0.0.1' || new URL(hostUrl).hostname !== '127.0.0.1') throw new Error('需要隔离 Hub 和本机 Superagent。');
if (!(await fetch(`${hubUrl}/api/v1/health`).then(response => response.json())).demo_mode) throw new Error('仅允许使用隔离演示 Hub。');
const headers = { 'X-Orchestrator-Request': '1' };
const hostState = await fetch(`${hostUrl}/orchestrator/api/state`, { headers }).then(response => response.json());
if (hostState.health?.runtime?.state !== 'ready' || hostState.load?.running || hostState.load?.queued) throw new Error('Superagent 尚未空闲或就绪。');
const settings = await fetch(`${hostUrl}/orchestrator/api/settings`, { headers }).then(response => response.json());
const type = settings.blocks?.executor?.value?.taskTypes?.find(value => value.id === process.env.TEAMHUB_STOP_TASK_TYPE && value.directoryMode === 'fixed' && value.engine === 'dsh');
if (!type?.directory) throw new Error('没有匹配的 DSH 固定目录任务类型。');
const workspace = await fs.realpath(type.directory), temp = await fs.realpath(os.tmpdir());
if (!workspace.startsWith(temp + path.sep)) throw new Error('测试工作区必须位于临时目录。');
const earlyParent = process.env.TEAMHUB_STOP_PARENT_EXITS_EARLY === '1';
const prefix = `teamhub-stop-${randomUUID()}`, started = path.join(workspace, `${prefix}-started`), pidFile = path.join(workspace, `${prefix}-pid`);
const parentPidFile = path.join(workspace, `${prefix}-parent-pid`);
const finished = path.join(workspace, `${prefix}-unexpected`), childScript = path.join(workspace, `${prefix}-child.mjs`), workerScript = path.join(workspace, `${prefix}-worker.ps1`);
await fs.writeFile(childScript, `import {writeFileSync} from 'node:fs'; setTimeout(() => writeFileSync(process.argv[2], 'finished'), ${earlyParent ? 20000 : 45000});\n`, { flag: 'wx' });
const quote = value => `'${value.replaceAll("'", "''")}'`;
const script = `$child = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @(${quote(childScript)}, ${quote(finished)}) -WindowStyle Hidden -PassThru\n` +
  `[IO.File]::WriteAllText(${quote(pidFile)}, [string]$child.Id)\n[IO.File]::WriteAllText(${quote(parentPidFile)}, [string]$PID)\n` +
  `[IO.File]::WriteAllText(${quote(started)}, 'started')\nStart-Sleep -Seconds ${earlyParent ? 1 : 50}\n`;
await fs.writeFile(workerScript, script, { flag: 'wx' });
const requester = new HubClient({ url: hubUrl, token: 'demo-lin' }), implementer = new HubClient({ url: hubUrl, token: 'demo-chen' }), tester = new HubClient({ url: hubUrl, token: 'demo-xu' });
const registry = new AdapterRegistry();
registry.registerExecutor('dsh-superagent', new DshSuperagentAdapter({ url: hostUrl, taskType: type.id, stateDir }));
const bridge = new LocalBridge(implementer, { registry, stateDir, instanceId: 'stop-validation-instance' }), auto = new AutoDispatcher(implementer, bridge);
const op = () => `stop-validation-${randomUUID()}`;
const definition = { roles: [{ key: 'dev', label: '实施组', kind: 'team' }, { key: 'qa', label: '验证组', kind: 'team' }, { key: 'review', label: '验收人', kind: 'reviewer' }],
  steps: [{ key: 'agent', name: '后台停止验证', team_role: 'dev', reviewer_role: 'review', depends_on: [], capabilities: [], acceptance_spec: ['确认后台工作已停止'], required_artifact_kinds: ['document'] },
    { key: 'parallel', name: '并行验证', team_role: 'qa', reviewer_role: 'review', depends_on: [], capabilities: [], acceptance_spec: ['完成独立验证'], required_artifact_kinds: ['document'] },
    { key: 'join', name: '跨组汇合', team_role: 'qa', reviewer_role: 'review', depends_on: ['agent', 'parallel'], capabilities: [], acceptance_spec: ['核对两组交付'], required_artifact_kinds: ['document'] }] };
const template = await requester.request('POST', '/workflow-templates', { operation_id: op(), name: '【系统测试】停止确认模板', definition });
const version = await requester.request('POST', `/workflow-templates/${template.id}/publish`, { operation_id: op(), expected_revision: template.draft_revision });
let view = await requester.request('POST', '/pipelines', { operation_id: op(), title: '【系统测试】真实后台停止',
  description: `这是隔离目录的停止验收。只调用 pwsh 工具执行命令 ${quote(workerScript)}，设置 run_in_background=true。该脚本只会在临时目录创建测试文件；启动后等待进一步指令，不要报告完成或自行停止，不要操作其他路径。`,
  project_id: 'proj-interface', template_version_id: version.id, role_bindings: { dev: 'team-clearing', qa: 'team-qa', review: 'u-lin' },
  assignees: { agent: 'u-chen', parallel: 'u-xu', join: 'u-xu' } });
const pipeline = view.pipeline.id;
view = await requester.request('POST', `/pipelines/${pipeline}/start`, { operation_id: op(), expected_version: view.pipeline.version });
await auto.enable({ pipeline_id: pipeline, adapter: 'dsh-superagent', workspace_ref: workspace, auto_accept: true });
const first = await auto.tick();
const launch = first[0]?.steps?.find(value => value.step === 'agent' && value.action === 'started');
if (!launch) throw new Error(`真实派发失败：${JSON.stringify(first)}`);
let stopConfirmed = false;
try {
console.log(JSON.stringify({ event: 'stop_validation_dispatched', dispatch_id: launch.dispatch_id }));
const refresh = async () => { view = await requester.getPipeline(pipeline); return view; };
const context = step => ({ pipeline_attempt_id: step.attempt.id, pipeline_generation: view.pipeline.generation });
async function completeHuman(index, client, text, alreadyAccepted = false) {
  let step = view.steps[index];
  if (!alreadyAccepted) {
    await client.command(step.item.id, 'accept', { operation_id: op(), expected_version: step.item.version, ...context(step) });
    await refresh(); step = view.steps[index];
    await client.command(step.item.id, 'start', { operation_id: op(), expected_version: step.item.version, ...context(step) });
    await refresh(); step = view.steps[index];
  }
  const artifact = await client.uploadArtifact(new Blob([text], { type: 'text/plain' }), 'stop-validation.txt');
  const delivery = await client.submitDelivery(step.item.id, { operation_id: op(), expected_version: step.item.version,
    spec_revision: step.item.spec_revision, summary: text, artifacts: [{ label: '验证证据', url: artifact.url, kind: 'document' }], ...context(step) });
  await refresh(); step = view.steps[index];
  await requester.reviewDelivery(delivery.id, { operation_id: op(), expected_version: step.item.version, decision: 'approve', ...context(step) });
  await refresh();
}
await refresh(); await completeHuman(1, tester, '验证组完成独立检查');
assert.equal(view.steps[2].state, 'waiting');
let run, prior = '', deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  await auto.tick();
  const detail = await implementer.getItem(view.steps[0].item.id);
  run = detail.runs.find(value => value.dispatch_id === launch.dispatch_id);
  if (run?.status !== prior) { prior = run?.status || 'unknown'; console.log(JSON.stringify({ event: 'stop_validation_run', status: prior })); }
  if (await fs.access(started).then(() => true, () => false)) break;
  if (['failed', 'succeeded', 'cancelled'].includes(run?.status)) throw new Error(`后台任务未启动：${run.status}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
await fs.access(started);
const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('后台子进程标识无效。');
const processAlive = target => { try { process.kill(target, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const alive = () => processAlive(pid);
assert.equal(alive(), true, '必须先证明真实后台子进程在运行。');
if (earlyParent) {
  const parent = Number((await fs.readFile(parentPidFile, 'utf8')).trim());
  if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error('后台主进程标识无效。');
  const parentDeadline = Date.now() + 12000;
  while (processAlive(parent) && Date.now() < parentDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(processAlive(parent), false, '必须先证明主进程已经退出。');
  // 等待主进程结果收束，留下仍在运行的真实后代进程。
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(alive(), true, '主进程退出后子进程仍应运行。');
}
const cancelled = await bridge.cancel(launch.dispatch_id, op());
const aliveAfterCancel = alive();
if (cancelled.confirmed) assert.equal(aliveAfterCancel, false, '确认停止时后台子进程仍在运行。');
deadline = Date.now() + 45000;
while (Date.now() < deadline) {
  const result = await bridge.reconcile(launch.dispatch_id); run = result.run;
  if (run.status === 'cancelled') { assert.equal(alive(), false, '确认停止时后台子进程仍在运行。'); break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(run.status, 'cancelled', 'Hub 未收到宿主停止证明。');
stopConfirmed = true;
await new Promise(resolve => setTimeout(resolve, 1000));
assert.equal(alive(), false);
if (!earlyParent) await assert.rejects(fs.access(finished));
await refresh(); await completeHuman(0, implementer, '已确认真实后台工作退出', true);
assert.equal(view.steps[2].state, 'awaiting_accept');
assert.equal(view.steps[2].attempt.input_snapshot.upstream_deliveries.length, 2);
await completeHuman(2, tester, '已核对两组结果');
assert.equal(view.pipeline.status, 'completed');
console.log(JSON.stringify({ event: 'live_superagent_stop_workflow_passed', real_dsh: true, real_background_child: true,
  parent_exited_first: earlyParent, child_survived_stop_request: aliveAfterCancel, child_exited_before_confirmation: true,
  cross_team_join: true, pipeline_status: view.pipeline.status }));
} finally {
  // 验收中断时只停止本次派发，避免遗留测试任务。
  if (!stopConfirmed) await bridge.cancel(launch.dispatch_id, op()).catch(() => {});
}
