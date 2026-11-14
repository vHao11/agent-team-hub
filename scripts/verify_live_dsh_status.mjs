/** 在现有 DSH 新会话中调用只读状态工具；不打印本机认证地址或令牌。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const playwright = process.env.TEAMHUB_PLAYWRIGHT_ENTRY;
const chrome = process.env.TEAMHUB_CHROME;
const pipelineId = process.env.TEAMHUB_LIVE_PIPELINE_ID;
if (!playwright || !chrome) throw new Error('缺少本机浏览器测试依赖');
if (pipelineId && !/^pipe_[a-z0-9]+$/.test(pipelineId)) throw new Error('无效的流水线 ID');
const { chromium } = await import(pathToFileURL(playwright));
const latest = JSON.parse(fs.readFileSync(process.env.DSH_LATEST_FILE, 'utf8'));
const match = fs.readFileSync(latest.stdout, 'utf8').match(/^dsh web:\s+(https?:\/\/\S+)/m);
if (!match) throw new Error('未找到 DSH 本机认证入口');
const url = new URL(match[1]);
if (url.hostname !== '127.0.0.1' || url.port !== '3080') throw new Error('DSH 入口不是预期的本机地址');
const browser = await chromium.launch({ headless: true, executablePath: chrome });
let page, elevated = false;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('[role="dialog"]').first();
    if (!await dialog.isVisible().catch(() => false)) break;
    const dismiss = dialog.getByRole('button', { name: /^(知道了|继续|关闭)$/ }).first();
    if (await dismiss.count()) await dismiss.click();
    else {
      const close = dialog.locator('button[aria-label="关闭"]').first();
      if (await close.count()) await close.click(); else { await page.keyboard.press('Escape'); break; }
    }
    await page.waitForTimeout(200);
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  if (process.env.TEAMHUB_TEST_ELEVATED !== '1') {
    const mode = await page.getByRole('button', { name: /访问模式，当前/ }).getAttribute('aria-label');
    if (!mode?.includes('工作区内修改')) throw new Error('新测试会话不是默认权限模式');
  } else {
    // 仅针对隔离测试会话，结束时恢复默认权限。
    await page.getByRole('button', { name: /访问模式，当前/ }).click();
    await page.getByRole('menuitem', { name: '完全权限', exact: true }).click();
    await page.locator('[role="presentation"] input[type="checkbox"]').last().check();
    await page.getByRole('button', { name: '启用完全权限', exact: true }).click();
    elevated = true;
  }
  const editor = page.getByRole('textbox', { name: /描述你想要构建的内容/ });
  const success = pipelineId ? 'TEAMHUB_LINK_OK' : 'TEAMHUB_CHECK_OK';
  const failure = pipelineId ? 'TEAMHUB_LINK_FAIL' : 'TEAMHUB_CHECK_FAIL';
  const prompt = pipelineId
    ? `请仅调用一次 teamhub_pipeline_link 工具，参数为 ${JSON.stringify({ pipeline_id: pipelineId, workspace_ref: process.env.TEAMHUB_LIVE_WORKSPACE_REF || process.cwd() })}。这是系统验收测试流程；不要调用其他工具、操作桌面、派单或修改业务状态。如果工具结果 synced=true 且 cards 非空，只回复 ${success}；否则只回复 ${failure}。`
    : `请仅调用一次 teamhub_status 工具进行只读集成验收，不要调用其他工具、操作桌面或修改数据。如果工具返回 dsh-todo-kanban 适配器 available=true，只回复 ${success}；否则只回复 ${failure}。`;
  await editor.fill(prompt);
  await page.getByRole('button', { name: '发送消息' }).click();
  const deadline = Date.now() + 60000;
  let outcome = 'timeout';
  while (Date.now() < deadline) {
    const content = await page.locator('body').innerText();
    // 用户输入同时包含两个标记；只接受回答里出现的额外标记。
    if (content.split(success).length > 2) { outcome = 'ok'; break; }
    if (content.split(failure).length > 2) { outcome = 'fail'; break; }
    await page.waitForTimeout(500);
  }
  const status = await page.evaluate(() => ({ waitingPermission: /允许|授权|确认执行/.test(document.querySelector('[role="dialog"]')?.innerText ?? '') }));
  console.log(JSON.stringify({ result: outcome, ...status }));
  if (outcome !== 'ok') process.exitCode = 1;
} finally {
  if (page && elevated) {
    try {
      const mode = page.getByRole('button', { name: /访问模式，当前/ });
      await mode.click();
      await page.getByRole('menuitem', { name: '工作区内修改', exact: true }).click();
      if (!(await mode.getAttribute('aria-label'))?.includes('工作区内修改')) throw new Error('权限模式未恢复');
    } catch {
      console.error('未能恢复测试会话的默认权限，请检查该会话。');
      process.exitCode = 1;
    }
  }
  await browser.close();
}
