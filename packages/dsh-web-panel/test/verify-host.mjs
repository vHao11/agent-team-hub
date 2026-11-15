/** 使用临时 profile、演示 Hub 和真实 DSH 浏览器验证页面，不使用模型或正式数据。 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtimeDir = process.env.DSH_TEST_RUNTIME;
const python = process.env.TEAMHUB_TEST_PYTHON;
const playwright = process.env.TEAMHUB_PLAYWRIGHT_ENTRY;
const chrome = process.env.TEAMHUB_CHROME;
const evidence = process.env.TEAMHUB_EVIDENCE_DIR;
const standard = process.env.TEAMHUB_TEST_STANDARD === '1';
if (![runtimeDir, python, playwright, chrome, evidence].every(Boolean)) throw new Error('缺少隔离测试所需的 DSH、Python、Playwright、Chrome 或证据目录。');

const tmp = await mkdtemp(path.join(os.tmpdir(), 'teamhub-dsh-web-panel-'));
const tempRoot = await realpath(os.tmpdir());
const resolvedTmp = await realpath(tmp);
const relativeTmp = path.relative(tempRoot, resolvedTmp);
if (!relativeTmp || relativeTmp.startsWith('..') || path.isAbsolute(relativeTmp)) throw new Error('隔离目录不在系统临时目录。');
await mkdir(evidence, { recursive: true });
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); });
});
const hubPort = await port();
let dshPort = await port();
while (hubPort === dshPort) dshPort = await port();
const allow = new Set(['path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'lang', 'no_proxy']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allow.has(key.toLowerCase())));
Object.assign(env, { DSH_HOME: path.join(tmp, 'dsh-home'), DSH_AGENTS_HOME: path.join(tmp, 'agents'),
  DSH_TELEMETRY_DISABLED: '1', TEAMHUB_URL: `http://127.0.0.1:${hubPort}`, PYTHONPATH: path.join(root, 'server'), PYTHONUTF8: '1' });
env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH || env.Path || ''}`;
process.env = env;
const dsh = path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (result.status !== 0) throw new Error(`隔离安装失败：${String(result.stderr || result.stdout).slice(-3000)}`);
}
run([npm, 'pack', '--ignore-scripts', '--pack-destination', tmp], path.join(root, 'packages/dsh-web-panel'));
run([dsh, 'plugin', '--profile', 'web', 'add', path.join(tmp, 'dsh-team-hub-web-0.1.0.tgz')], tmp);

let testToken;
if (standard) {
  const init = spawnSync(python, ['-m', 'teamhub', 'init', '--data-dir', path.join(tmp, 'data')],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (init.status !== 0) throw new Error('隔离正式工作空间初始化失败。');
  testToken = JSON.parse(init.stdout.slice(init.stdout.indexOf('{'))).token;
}

const hub = spawn(python, ['-m', 'teamhub', 'serve', ...(standard ? [] : ['--demo']), '--data-dir', path.join(tmp, 'data'), '--port', String(hubPort)],
  { cwd: root, env, windowsHide: true, stdio: 'ignore' });
let runtime, browser, page;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${env.TEAMHUB_URL}/api/v1/health`)).ok) break; } catch { /* 等待服务启动。 */ }
    if (hub.exitCode !== null || attempt === 99) throw new Error('隔离 Hub 未能启动。');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const require = createRequire(path.join(runtimeDir, 'package.json'));
  const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')));
  const dshRequire = createRequire(path.join(runtimeDir, 'node_modules/@deepseek-ai/dsh/package.json'));
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-launch-environment')));
  const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]);
  const originalLog = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith('dsh web: http')) originalLog(...args); };
  try {
    runtime = await runProfile({ environment, profile: 'web', patchFiles: [], args: ['--host', '127.0.0.1', '--port', String(dshPort), '--no-open'] });
  } finally { console.log = originalLog; }
  const base = `http://127.0.0.1:${dshPort}`;
  assert.equal((await fetch(`${base}/team-hub-web/status`)).status, 401);
  const { chromium } = await import(pathToFileURL(playwright));
  browser = await chromium.launch({ headless: true, executablePath: chrome });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !(standard && message.location().url.endsWith('/api/v1/demo'))) errors.push(message.text());
  });
  await page.goto(runtime.ctx.get('connection').authenticatedUrl(base + '/'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('[role="dialog"]').first();
    if (!await dialog.isVisible().catch(() => false)) break;
    const dismiss = dialog.getByRole('button', { name: /^(知道了|继续|关闭)$/ }).first();
    if (await dismiss.count()) await dismiss.click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  await page.getByRole('button', { name: '团队协作台', exact: true }).first().click({ timeout: 30000 });
  const frame = page.frameLocator('iframe[title="Agent Team Hub 工作空间"]');
  if (standard) {
    await frame.getByPlaceholder('粘贴管理员提供的访问令牌').fill(testToken);
    await frame.getByRole('button', { name: '连接身份' }).click();
    await frame.getByRole('button', { name: '管理当前身份' }).waitFor();
  }
  await frame.getByRole('button', { name: '流水线任务' }).waitFor({ timeout: 30000 });
  await frame.getByRole('button', { name: '流水线任务' }).click();
  await frame.getByText('流水线任务', { exact: true }).first().waitFor();
  assert.equal(await page.locator('iframe[title="Agent Team Hub 工作空间"]').count(), 1);
  const suffix = standard ? '-standard' : '';
  await page.screenshot({ path: path.join(evidence, `dsh-team-hub-desktop${suffix}.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const mobileToggle = page.locator('[data-sidebar-toggle]:visible');
  if (await mobileToggle.count()) await mobileToggle.first().click();
  await frame.getByRole('button', { name: '创建流水线' }).first().waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(evidence, `dsh-team-hub-mobile${suffix}.png`) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  hub.kill();
  await new Promise(resolve => hub.once('exit', resolve));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '插件', exact: true }).first().click();
  await page.getByRole('button', { name: '团队协作台', exact: true }).first().click({ timeout: 30000 });
  await page.getByText('无法连接 Hub 服务', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '重新连接' }).click();
  await page.getByText('无法连接 Hub 服务', { exact: false }).waitFor();
  await page.screenshot({ path: path.join(evidence, `dsh-team-hub-offline${suffix}.png`) });
  assert.deepEqual(errors, []);
  console.log('TEAMHUB_WEB_PANEL=' + JSON.stringify({ result: 'passed', dsh_version: '0.2.2-rc.1', viewports: ['1440x900', '390x844'],
    authenticated_status: true, sidebar_panel: true, iframe_navigation: true, standard_login: standard, offline_retry: true, browser_errors: errors.length, evidence }));
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(evidence, 'dsh-team-hub-failure.png') }).catch(() => {});
    const dialogs = await page.locator('[role="dialog"], [role="presentation"]').allTextContents().catch(() => []);
    console.error('隔离页面遮罩：', JSON.stringify(dialogs.map(text => text.slice(0, 500))));
  }
  throw error;
} finally {
  if (page && !page.isClosed()) await page.close().catch(() => {});
  if (browser) await browser.close();
  if (runtime) await runtime.shutdown.shutdown(0);
  if (hub.exitCode === null && hub.signalCode === null) {
    hub.kill();
    await new Promise(resolve => hub.once('exit', resolve));
  }
  await rm(resolvedTmp, { recursive: true, force: true });
}
