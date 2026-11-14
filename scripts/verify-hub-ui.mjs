/** 在临时演示空间验证并行模板、创建和跨步骤回退的真实页面。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.TEAMHUB_TEST_PYTHON;
const entry = process.env.TEAMHUB_PLAYWRIGHT_ENTRY;
const chrome = process.env.TEAMHUB_CHROME;
if (!python || !entry || !chrome) throw new Error('需要指定隔离测试用 Python、Playwright 入口和 Chrome。');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-parallel-ui-'));
if (!(await fs.realpath(dir)).startsWith((await fs.realpath(os.tmpdir())) + path.sep)) throw new Error('演示空间不在系统临时目录。');
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const base = `http://127.0.0.1:${port}`;
const allowed = new Set(['path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir', 'lang']);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
const hub = spawn(python, ['-m', 'teamhub', 'serve', '--demo', '--host', '127.0.0.1', '--port', String(port), '--data-dir', path.join(dir, 'hub')], {
  cwd: root, env: { ...childEnv, PYTHONPATH: path.join(root, 'server'), PYTHONUTF8: '1' }, windowsHide: true, stdio: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (hub.exitCode !== null) throw new Error('隔离 Hub 启动失败。');
    try { if ((await fetch(`${base}/api/v1/health`)).ok) break; } catch { /* 等待服务。 */ }
    if (i === 99) throw new Error('隔离 Hub 健康检查超时。');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const { chromium } = await import(pathToFileURL(entry).href);
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/#workflows`);
  await page.getByRole('button', { name: '新建模板' }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('模板名称').fill('【系统测试】并行模板');
  await dialog.getByRole('button', { name: '添加步骤' }).click();
  await dialog.getByRole('button', { name: '添加步骤' }).click();
  const steps = dialog.locator('.workflow-step-editor');
  for (const [i, name] of ['分支 A', '分支 B', '汇合'].entries()) {
    await steps.nth(i).getByLabel('步骤名称').fill(name);
    await steps.nth(i).getByLabel('验收标准').fill(`验证 ${name}`);
  }
  await steps.nth(1).getByRole('checkbox', { name: '分支 A' }).uncheck();
  await steps.nth(2).getByRole('checkbox', { name: '分支 A' }).check();
  await steps.nth(2).getByRole('checkbox', { name: '分支 B' }).check();
  await page.screenshot({ path: path.join(dir, 'template-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: '保存草稿' }).click();
  const card = page.locator('.workflow-card').filter({ hasText: '【系统测试】并行模板' });
  await card.getByRole('button', { name: '发布版本' }).click();
  await card.getByText('已发布版本').click();
  await card.getByRole('button', { name: '按此创建流水线' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务名称').fill('【系统测试】并行流程');
  await dialog.getByLabel('承接团队（团队）').selectOption('team-clearing');
  await dialog.getByLabel('验收人（验收人）').selectOption('u-lin');
  await dialog.getByRole('button', { name: '创建流水线' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '启动流水线' }).click();
  await dialog.getByText('待接单').first().waitFor();
  const readPipelines = () => page.evaluate(async () => {
    const result = await fetch('/api/v1/pipelines', { headers: { Authorization: `Bearer ${sessionStorage.getItem('teamhub.session.v1')}` } });
    if (!result.ok) throw new Error('无法读取演示流水线。');
    return (await result.json()).items;
  });
  const before = (await readPipelines()).find(value => value.pipeline.title === '【系统测试】并行流程');
  assert.deepEqual(before.steps.map(step => step.state), ['awaiting_accept', 'awaiting_accept', 'waiting']);
  await dialog.getByRole('button', { name: '回退到此步骤' }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('回退原因').fill('合成回退验证');
  await dialog.getByRole('button', { name: '确认回退' }).click();
  await page.getByText('步骤已回退，受影响的历史材料已保留。').waitFor();
  const after = (await readPipelines()).find(value => value.pipeline.id === before.pipeline.id);
  assert.notEqual(after.steps[0].item.id, before.steps[0].item.id);
  assert.equal(after.steps[1].item.id, before.steps[1].item.id);
  assert.equal(after.pipeline.generation, before.pipeline.generation + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(dir, 'pipeline-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', parallel_template: true, pipeline_creation: true, rollback: true,
    independent_branch_preserved: true, browser_errors: errors.length, evidence: dir }));
} finally {
  await browser?.close();
  hub.kill();
}
