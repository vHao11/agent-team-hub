/** 用真实 DSH 页面核验已取消的验收卡片；不输出凭据或其他看板内容。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.TEAMHUB_PLAYWRIGHT_ENTRY));
const latest = JSON.parse(fs.readFileSync(process.env.DSH_LATEST_FILE, 'utf8'));
const url = new URL(fs.readFileSync(latest.stdout, 'utf8').match(/^dsh web:\s+(https?:\/\/\S+)/m)[1]);
if (url.hostname !== '127.0.0.1' || url.port !== '3080') throw new Error('DSH 地址不符合预期');
const record = JSON.parse(fs.readFileSync(process.env.TEAMHUB_VALIDATION_RECORD, 'utf8'));
if (!record.sync_verified || record.final_status !== 'cancelled' || !record.title.startsWith('【系统验收测试】')) throw new Error('验收记录不完整');
const screenshot = path.join(path.dirname(process.env.TEAMHUB_VALIDATION_RECORD), 'live-validation-card.png');
if (fs.existsSync(screenshot)) throw new Error('验收截图已存在，未覆盖');
const browser = await chromium.launch({ headless: true, executablePath: process.env.TEAMHUB_CHROME });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', () => errors.push('pageerror'));
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('[role="dialog"]').first();
    if (!await dialog.isVisible().catch(() => false)) break;
    const dismiss = dialog.getByRole('button', { name: /^(知道了|继续|关闭)$/ }).first();
    if (await dismiss.count()) await dismiss.click();
    else { const close = dialog.locator('button[aria-label="关闭"]').first(); if (await close.count()) await close.click(); else break; }
  }
  await page.getByText('待办看板', { exact: true }).first().click();
  await page.locator('.tk-overview').waitFor({ timeout: 25000 });
  // 用户的悬浮挂件可能遮住末列；用键盘访问保留现有挂件设置。
  await page.locator('.tk-tile[data-status="dropped"]').first().focus();
  await page.keyboard.press('Enter');
  const card = page.locator('.tk-card').filter({ hasText: record.title });
  await card.first().waitFor();
  assert.equal(await card.count(), 1);
  assert.equal(await card.first().getByText('Hub：已取消', { exact: true }).count(), 1);
  assert.equal(await card.first().getByRole('button', { name: '派单', exact: true }).count(), 0);
  assert.equal(await card.first().getByRole('button', { name: '删除', exact: true }).count(), 0);
  await card.first().scrollIntoViewIfNeeded();
  await card.first().screenshot({ path: screenshot });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await card.first().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', cancelled_card_visible: true, responsive: true, screenshot }));
} finally { await browser.close(); }
