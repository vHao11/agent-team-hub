/** 在隔离的真实 DSH、看板和 Hub 中验证跨组流程；不调用模型。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { HubClient } from '../packages/client/src/index.mjs';

const require = createRequire(path.join(process.env.DSH_SMOKE_RUNTIME_DIR, 'package.json'));
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')));
const dshRequire = createRequire(path.join(process.env.DSH_SMOKE_RUNTIME_DIR, 'node_modules/@deepseek-ai/dsh/package.json'));
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')));
const { chromium } = await import(pathToFileURL(process.env.TEAMHUB_PLAYWRIGHT_ENTRY));
const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]);
const runtime = await runProfile({ environment, profile: 'web', patchFiles: [],
  args: ['--host', '127.0.0.1', '--port', process.env.DSH_SMOKE_PORT, '--no-open'] });
const baseUrl = `http://127.0.0.1:${process.env.DSH_SMOKE_PORT}`;
const lin = new HubClient({ url: process.env.TEAMHUB_URL, token: 'demo-lin' });
const chen = new HubClient({ url: process.env.TEAMHUB_URL, token: 'demo-chen' });
const xu = new HubClient({ url: process.env.TEAMHUB_URL, token: 'demo-xu' });
const op = () => `dsh-board-${randomUUID()}`;
const errors = [];
const definitions = {
  roles: [{ key: 'build', label: '实施组', kind: 'team' }, { key: 'test', label: '验证组', kind: 'team' },
    { key: 'review', label: '验收人', kind: 'reviewer' }],
  steps: [{ key: 'build', name: '实施', team_role: 'build', reviewer_role: 'review', acceptance_spec: ['提交说明'], required_artifact_kinds: ['document'] },
    { key: 'test', name: '验证', team_role: 'test', reviewer_role: 'review', acceptance_spec: ['提交报告'], required_artifact_kinds: ['document'] }],
};
let browser, page;
let unregisterExternal, unregisterExecutor;
try {
  assert.equal(runtime.ctx.get('todoKanbanHub')?.apiVersion, 1, '看板 Cordis 服务未加载');
  assert.equal(runtime.ctx.get('teamHubActions')?.apiVersion, 1, 'Hub 看板操作服务未加载');
  const clientDir = path.join(process.env.DSH_HOME, 'profiles/web/node_modules/dsh-team-hub/lib/client');
  const { adapters } = await import(pathToFileURL(path.join(clientDir, 'bridge.mjs')));
  const { registerStdioAdapters } = await import(pathToFileURL(path.join(clientDir, 'stdio-adapter.mjs')));
  unregisterExternal = registerStdioAdapters(process.env.TEAMHUB_EXTERNAL_ADAPTER_CONFIG, adapters);
  const status = JSON.parse(await runtime.ctx.tools.get('teamhub_status').execute({}));
  assert.equal(status.adapters.boards.find(value => value.name === 'dsh-todo-kanban')?.available, true);
  assert.equal(status.adapters.boards.find(value => value.name === 'portable-board')?.available, true);
  const template = await lin.request('POST', '/workflow-templates', { operation_id: op(), name: '隔离测试模板', definition: definitions });
  const version = await lin.request('POST', `/workflow-templates/${template.id}/publish`, { operation_id: op(), expected_revision: template.draft_revision });
  let view = await lin.request('POST', '/pipelines', { operation_id: op(), title: '隔离跨组流水线', project_id: 'proj-interface',
    template_version_id: version.id, role_bindings: { build: 'team-clearing', test: 'team-qa', review: 'u-lin' } });
  const pipelineId = view.pipeline.id;
  view = await lin.request('POST', `/pipelines/${pipelineId}/start`, { operation_id: op(), expected_version: view.pipeline.version });
  const link = runtime.ctx.tools.get('teamhub_pipeline_link');
  const sync = runtime.ctx.tools.get('teamhub_pipeline_sync');
  const linked = JSON.parse(await link.execute({ pipeline_id: pipelineId, workspace_ref: 'isolated-workspace' }));
  assert.equal(linked.synced, true, JSON.stringify(linked));
  const firstId = linked.cards[0].local_todo_id;
  const repeated = JSON.parse(await link.execute({ pipeline_id: pipelineId, workspace_ref: 'isolated-workspace' }));
  assert.equal(repeated.cards[0].local_todo_id, firstId);
  const external = JSON.parse(await link.execute({ pipeline_id: pipelineId, workspace_ref: 'isolated-workspace', adapter: 'portable-board' }));
  assert.equal(external.synced, true, JSON.stringify(external));

  browser = await chromium.launch({ headless: true, executablePath: process.env.TEAMHUB_CHROME });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  const login = runtime.ctx.get('connection').authenticatedUrl(baseUrl + '/');
  await page.goto(login, { waitUntil: 'domcontentloaded' });
  const board = async () => page.evaluate(async () => {
    const response = await fetch('/todo-kanban/api/board', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`board HTTP ${response.status}`);
    return response.json();
  });
  const cardIn = async (column, id) => (await board()).columns[column].find(card => card.id === id);
  const boardAction = async (card, action, extra = {}) => {
    const response = await page.request.post(`${baseUrl}/todo-kanban/api/drafts/${encodeURIComponent(card.id)}/hub-action`, {
      data: { action, operation_id: op(), snapshot: { itemId: card.hub.itemId, attemptId: card.hub.attemptId,
        generation: card.hub.generation, itemVersion: card.hub.itemVersion }, ...extra },
    });
    return { status: response.status(), body: await response.json() };
  };
  assert.equal((await cardIn('todo', firstId)).hub.status, 'open');
  const forbidden = await boardAction(await cardIn('todo', firstId), 'accept');
  assert.equal(forbidden.status, 403, '看板操作必须受 Hub 身份权限约束');
  await runtime.ctx.get('todoKanbanHub').setSyncStatus('offline');
  assert.equal((await board()).hubSync.state, 'offline');
  await sync.execute({});
  assert.equal((await board()).hubSync.state, 'synced');

  const context = step => ({ pipeline_attempt_id: step.attempt.id, pipeline_generation: view.pipeline.generation });
  const refresh = async () => { view = await lin.getPipeline(pipelineId); };
  const command = async (client, step, action) => client.command(step.item.id, action, {
    operation_id: op(), expected_version: step.item.version, ...context(step),
  });
  await command(chen, view.steps[0], 'accept'); await refresh();
  await command(chen, view.steps[0], 'start'); await refresh();
  // 不手动同步，验证宿主定时器自行把处理中状态投影到看板。
  const deadline = Date.now() + 20000;
  while (!(await cardIn('doing', firstId)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal((await cardIn('doing', firstId))?.hub.status, 'active', '自动状态同步未完成');
  async function deliver(client, step, label) {
    return client.submitDelivery(step.item.id, { operation_id: op(), expected_version: step.item.version,
      spec_revision: step.item.spec_revision, summary: label, artifacts: [{ label: '说明', url: 'https://example.com/evidence', kind: 'document' }], ...context(step) });
  }
  let delivery = await deliver(chen, view.steps[0], '第一版'); await refresh();
  await sync.execute({}); assert.equal((await cardIn('person', firstId)).hub.status, 'review');
  const previewContinue = page.getByRole('button', { name: '继续', exact: true });
  if (await previewContinue.isVisible().catch(() => false)) await previewContinue.click();
  for (let attempt = 0; attempt < 3 && await page.locator('[role="dialog"]').count(); attempt++) {
    const close = page.locator('[role="dialog"] button[aria-label="关闭"]').first();
    if (await close.count()) await close.click(); else await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  await page.getByText('待办看板', { exact: true }).first().click();
  await page.locator('.tk-overview').waitFor({ timeout: 25000 });
  await page.locator('.tk-tile[data-status="person"]').first().click();
  const reviewCard = page.locator('.tk-card').filter({ hasText: '隔离跨组流水线' }).first();
  await reviewCard.getByRole('button', { name: '退回修改', exact: true }).click();
  const reviewDialog = page.getByRole('dialog', { name: '退回修改' });
  await reviewDialog.getByText('提交说明', { exact: true }).waitFor();
  await reviewDialog.locator('textarea').fill('补充说明');
  await reviewDialog.getByRole('button', { name: '确认退回修改' }).click();
  await reviewDialog.waitFor({ state: 'detached' });
  await refresh(); await sync.execute({});
  assert.equal((await cardIn('doing', firstId)).hub.attemptId, view.steps[0].attempt.id);
  delivery = await deliver(chen, view.steps[0], '补充后'); await refresh();
  await sync.execute({});
  const approved = await boardAction(await cardIn('person', firstId), 'approve');
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await refresh();
  await sync.execute({ adapter: 'portable-board' });
  let externalBoard = JSON.parse(await fs.readFile(process.env.TEAMHUB_EXTERNAL_BOARD_STATE, 'utf8'));
  assert.deepEqual(externalBoard.cards.map(card => card.hub.status), ['done', 'open']);
  const afterApprove = JSON.parse(await sync.execute({}));
  const secondId = afterApprove.find(value => value.pipeline_id === pipelineId).cards.find(value => value.work_item_id === view.steps[1].item.id).local_todo_id;
  assert.equal((await cardIn('done', firstId)).hub.status, 'done');
  assert.equal((await cardIn('todo', secondId)).hub.status, 'open');
  await command(xu, view.steps[1], 'accept'); await refresh();
  await command(xu, view.steps[1], 'start'); await refresh();
  delivery = await deliver(xu, view.steps[1], '验证结果'); await refresh();
  await lin.reviewDelivery(delivery.id, { operation_id: op(), expected_version: view.steps[1].item.version,
    decision: 'approve', ...context(view.steps[1]) });
  await refresh(); await sync.execute({});
  await sync.execute({ adapter: 'portable-board' });
  externalBoard = JSON.parse(await fs.readFile(process.env.TEAMHUB_EXTERNAL_BOARD_STATE, 'utf8'));
  assert.equal(externalBoard.cards.length, 2);
  assert.ok(externalBoard.cards.every(card => card.hub.status === 'done'));
  assert.equal(view.pipeline.status, 'completed');
  assert.equal((await cardIn('done', secondId)).hub.status, 'done');
  const boardSnapshot = await board();
  const cards = Object.values(boardSnapshot.columns).flat().filter(card => card.hub?.pipelineId === pipelineId);
  assert.equal(cards.length, 2); assert.equal(new Set(cards.map(card => card.id)).size, 2);
  assert.ok((await lin.getItem(view.steps[0].item.id)).bindings.some(binding => binding.local_todo_id === firstId));
  assert.ok((await lin.getItem(view.steps[1].item.id)).bindings.some(binding => binding.local_todo_id === secondId));

  // 真实 DSH 页面：类别切换后可看到 Hub 状态，不显示该草稿的派单或删除按钮。
  await page.locator('.tk-tile[data-status="done"]').first().click();
  const visible = page.locator('.tk-card').filter({ hasText: '隔离跨组流水线' });
  await visible.first().waitFor();
  assert.equal(await visible.count(), 2);
  assert.equal(await visible.first().getByText('Hub：已验收').count(), 1);
  assert.equal(await visible.first().getByRole('button', { name: '派单', exact: true }).count(), 0);
  assert.equal(await visible.first().getByRole('button', { name: '删除', exact: true }).count(), 0);
  await visible.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(process.env.TEAMHUB_EVIDENCE_DIR, 'dsh-board-desktop.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await visible.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(process.env.TEAMHUB_EVIDENCE_DIR, 'dsh-board-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);

  // 已完成流程跨步骤回退后，旧卡片保留为历史，新轮次得到独立卡片。
  view = await lin.rollbackPipeline(pipelineId, 'build', { operation_id: op(), expected_version: view.pipeline.version, reason: '合成回退验证' });
  assert.equal(view.pipeline.status, 'active');
  const afterRollback = JSON.parse(await sync.execute({}));
  const newCardId = afterRollback.find(value => value.pipeline_id === pipelineId).cards
    .find(value => value.work_item_id === view.steps[0].item.id).local_todo_id;
  assert.notEqual(newCardId, firstId);
  assert.equal((await cardIn('dropped', firstId)).hub.superseded, true);
  assert.equal((await cardIn('dropped', secondId)).hub.superseded, true);
  assert.equal((await cardIn('todo', newCardId)).hub.attemptId, view.steps[0].attempt.id);
  const historicalAction = await boardAction(await cardIn('dropped', firstId), 'accept');
  assert.notEqual(historicalAction.status, 200, '历史轮次不能继续执行业务操作');

  // 在真实 DSH 插件容器中验证工具与调度器的连接；执行器为隔离替身，不调用模型。
  let launches = 0;
  unregisterExecutor = adapters.registerExecutor('isolated-executor', {
    async probe() { return { available: true, protocol_version: 1, kind: 'executor', canRecover: true }; },
    async start() { launches++; return { run_id: 'synthetic-host-run', status: 'running' }; },
    async getStatus() { return { status: 'succeeded', summary: '隔离执行结果' }; },
    async findByDispatchId() { return { run_id: 'synthetic-host-run' }; },
  });
  let automated = await lin.request('POST', '/pipelines', { operation_id: op(), title: '隔离自动派发验证', project_id: 'proj-interface',
    template_version_id: version.id, role_bindings: { build: 'team-trading', test: 'team-qa', review: 'u-xu' }, assignees: { build: 'u-lin' } });
  automated = await lin.request('POST', `/pipelines/${automated.pipeline.id}/start`, { operation_id: op(), expected_version: automated.pipeline.version });
  const automation = runtime.ctx.tools.get('teamhub_pipeline_automation');
  await automation.execute({ action: 'tick' });
  assert.equal(launches, 0, '没有启用自动派发时不能启动执行器');
  await automation.execute({ action: 'enable', pipeline_id: automated.pipeline.id, adapter: 'isolated-executor',
    workspace_ref: 'isolated-workspace', auto_accept: true });
  await automation.execute({ action: 'tick' });
  await automation.execute({ action: 'tick' });
  const automaticItem = await lin.getItem(automated.steps[0].item.id);
  assert.equal(launches, 1, '已启用流程每轮只应启动一次');
  assert.equal(automaticItem.runs.length, 1);
  assert.equal(automaticItem.runs[0].status, 'succeeded');
  assert.notEqual(automaticItem.item.status, 'done', '执行成功不能自动验收');
  await automation.execute({ action: 'disable', pipeline_id: automated.pipeline.id });
  console.log('TEAMHUB_DSH_BOARD=' + JSON.stringify({ status: 'passed', adapter: 'todoKanbanHub', external_adapter: 'portable-board', teams: 2, members: 3,
    cards: cards.length, automatic_sync: true, board_to_hub_review: true, wrong_actor_rejected: true, rework: true, duplicate_link: false,
    pipeline_status_before_rollback: 'completed', rollback_old_cards_superseded: true, new_attempt_linked: true, native_automation_tool: true,
    dsh_viewports: ['1440x900', '390x844'], browser_errors: errors.length }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(process.env.TEAMHUB_EVIDENCE_DIR, 'dsh-board-failure.png') }).catch(() => {});
  throw error;
} finally {
  unregisterExecutor?.();
  unregisterExternal?.();
  if (browser) await browser.close();
  await runtime.shutdown.shutdown(0);
}
