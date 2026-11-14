/** 在明确标记的正式测试事项中，通过 DSH 实际工具派发 OpenCode 并取消该事项。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HubClient } from '../packages/client/src/index.mjs';
import { AdapterRegistry, LocalBridge } from '../packages/client/src/bridge.mjs';
import { registerStdioAdapters } from '../packages/client/src/stdio-adapter.mjs';

if (process.env.TEAMHUB_ALLOW_LIVE_DSH_OPENCODE !== '1') throw new Error('必须显式启用正式环境测试。');
const hubUrl = process.env.TEAMHUB_URL, tokenFile = process.env.TEAMHUB_TOKEN_FILE;
const configFile = process.env.TEAMHUB_ADAPTER_CONFIG_FILE, executor = process.env.TEAMHUB_EXPECT_EXECUTOR;
if (!hubUrl || new URL(hubUrl).hostname !== '127.0.0.1' || !tokenFile || !configFile || !executor) throw new Error('缺少本机测试配置。');
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const entry = config.adapters?.find(value => value.name === executor && value.kind === 'executor');
if (!entry || entry.args?.[2] !== 'opencode' || !path.isAbsolute(entry.args?.[4] || '')) throw new Error('执行器配置不符合预期。');
const client = new HubClient({ url: hubUrl, token: (await fs.readFile(tokenFile, 'utf8')).replace(/^\uFEFF/, '').trim() });
const health = await fetch(`${hubUrl}/api/v1/health`).then(response => response.json());
if (health.demo_mode !== false) throw new Error('此脚本只验证正式 Hub。');
const info = await client.bootstrap();
if (!info.me?.id || !info.me?.team_id || !info.projects?.[0]?.id) throw new Error('缺少可用的成员、团队或项目。');
const marker = `DSH_OPENCODE_${randomUUID().replaceAll('-', '').toUpperCase()}`;
let item = await client.createItem({ title: '【系统验收测试】DSH OpenCode 执行器',
  description: `这是一条只读系统测试。不要读取、修改文件或调用工具，只输出 ${marker}。`,
  project_id: info.projects[0].id, target_team_id: info.me.team_id, acceptance_spec: ['返回测试标识'] });
console.log(JSON.stringify({ event: 'live_dsh_opencode_test_created', item_id: item.id }));
let browser;
try {
  await client.command(item.id, 'accept', { expected_version: item.version, assignee_id: info.me.id });
  item = (await client.getItem(item.id)).item;
  const args = { work_item_id: item.id, operation_id: `dsh-opencode-${randomUUID()}`, expected_version: item.version,
    adapter: executor, workspace_ref: entry.args[4], capabilities_json: '[]' };
  const { chromium } = await import(pathToFileURL(process.env.TEAMHUB_PLAYWRIGHT_ENTRY));
  const latest = JSON.parse(await fs.readFile(process.env.DSH_LATEST_FILE, 'utf8'));
  const log = await fs.readFile(latest.stdout, 'utf8');
  const url = new URL(log.match(/^dsh web:\s+(https?:\/\/\S+)/m)?.[1] || '');
  if (url.hostname !== '127.0.0.1' || url.port !== '3080') throw new Error('DSH 地址不符合预期。');
  browser = await chromium.launch({ headless: true, executablePath: process.env.TEAMHUB_CHROME });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('[role="dialog"]').first();
    if (!await dialog.isVisible().catch(() => false)) break;
    const dismiss = dialog.getByRole('button', { name: /^(知道了|继续|关闭)$/ }).first();
    if (await dismiss.count()) await dismiss.click(); else { await page.keyboard.press('Escape'); break; }
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.getByRole('textbox', { name: /描述你想要构建的内容/ }).fill(
    `用户明确要求进行系统测试。请仅调用一次 teamhub_run_start，参数是 ${JSON.stringify(args)}。不要调用其他工具、修改其他数据或重复派发；工具成功后只回复 DSH_DISPATCH_SENT。`);
  await page.getByRole('button', { name: '发送消息' }).click();
  let run, detail; const deadline = Date.now() + 80000;
  while (Date.now() < deadline) {
    detail = await client.getItem(item.id);
    run = detail.runs?.find(value => value.harness === executor);
    if (run) break;
    await page.waitForTimeout(1000);
  }
  if (!run) throw new Error(`DSH 未创建测试 Run，事项 ${item.id} 需要核对。`);
  assert.equal(detail.runs.filter(value => value.harness === executor).length, 1);
  const registry = new AdapterRegistry();
  const dispose = registerStdioAdapters(configFile, registry);
  try {
    const bridge = new LocalBridge(client, { registry, stateDir: path.join(os.homedir(), '.agent-team-hub') });
    const finish = Date.now() + 80000;
    while (Date.now() < finish) {
      const result = await bridge.reconcile(run.dispatch_id); run = result.run;
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(run.status)) break;
      await page.waitForTimeout(1000);
    }
    if (run.status !== 'succeeded' || !run.result_summary?.includes(marker)) throw new Error(`真实 DSH 执行未成功：${run.status}；事项 ${item.id}。`);
  } finally { dispose(); }
  item = (await client.getItem(item.id)).item;
  await client.command(item.id, 'cancel', { expected_version: item.version, reason: '系统验收完成，关闭测试事项。' });
  assert.equal((await client.getItem(item.id)).item.status, 'cancelled');
  console.log(JSON.stringify({ event: 'live_dsh_opencode_passed', actual_dsh_tool: true, real_model: true, dispatch_count: 1,
    test_item_cancelled: true, item_id: item.id }));
} finally {
  if (browser) await browser.close();
  try {
    const detail = await client.getItem(item.id);
    if (detail.item.status !== 'cancelled') {
      if (detail.runs.some(value => !['succeeded', 'failed', 'cancelled'].includes(value.status))) {
        console.log(JSON.stringify({ event: 'live_dsh_opencode_cleanup_pending', item_id: item.id, reason: 'run_not_terminal' }));
      } else {
        await client.command(item.id, 'cancel', { expected_version: detail.item.version, reason: '系统验收结束，关闭测试事项。' });
      }
    }
  } catch { console.log(JSON.stringify({ event: 'live_dsh_opencode_cleanup_pending', item_id: item.id, reason: 'cannot_verify' })); }
}
