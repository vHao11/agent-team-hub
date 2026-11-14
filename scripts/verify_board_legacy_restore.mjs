/** 只在临时副本验证旧投影字段恢复及现有 Hub 卡片保留。 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const plugin = process.env.TEAMHUB_KANBAN_DIR;
const backup = process.env.TEAMHUB_BACKUP_DIR;
const board = process.env.TEAMHUB_BOARD_DIR;
if (!plugin || !backup || !board) throw new Error('缺少路径');
const { BoardStore } = await import(pathToFileURL(path.join(plugin, 'src/store.js')));
const { createHubBoardService } = await import(pathToFileURL(path.join(plugin, 'src/hub-link.js')));
const original = JSON.parse(await fs.readFile(path.join(backup, 'todo-kanban/board.json'), 'utf8'));
const current = JSON.parse(await fs.readFile(path.join(board, 'board.json'), 'utf8'));
const value = original.settings?.projection?.includeIdle;
if (typeof value !== 'boolean' || current.settings?.projection?.includeIdle !== undefined) throw new Error('旧值或当前字段状态与预期不符');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-board-restore-'));
try {
  current.settings.projection.includeIdle = value;
  await fs.writeFile(path.join(temporary, 'board.json'), JSON.stringify(current, null, 2));
  const store = new BoardStore({ stateDir: temporary }); await store.init();
  const linked = store.data.drafts.filter(draft => draft.hub).map(draft => draft.id);
  assert.ok(linked.length > 0);
  assert.deepEqual(store.data.settings, original.settings);
  const service = createHubBoardService(store);
  await service.setSyncStatus('degraded'); await service.setSyncStatus('synced');
  const restored = new BoardStore({ stateDir: temporary }); await restored.init();
  assert.equal(restored.data.settings.projection.includeIdle, value);
  assert.deepEqual(restored.data.settings, original.settings);
  assert.deepEqual(restored.data.drafts.filter(draft => draft.hub).map(draft => draft.id), linked);
  console.log(JSON.stringify({ result: 'passed', legacy_value_preserved: true, linked_cards_preserved: linked.length }));
} finally {
  const parent = await fs.realpath(os.tmpdir()), target = await fs.realpath(temporary);
  if (!target.startsWith(parent + path.sep)) throw new Error('临时目录不在预期位置');
  await fs.rm(target, { recursive: true, force: true });
}
