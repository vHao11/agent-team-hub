import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { HubError } from './index.mjs';

export function defaultStateDir() { return process.env.TEAMHUB_STATE_DIR || path.join(os.homedir(), '.agent-team-hub'); }
export function safeKey(value) {
  if (!/^[a-zA-Z0-9_-]{1,180}$/.test(value)) throw new HubError('INVALID_ID', 'Expected a stable identifier, not a file path.');
  return value;
}
export async function clientInstanceId(stateDir = defaultStateDir()) {
  await fs.mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, 'instance-id');
  // Publish a fully written file atomically. Concurrent first callers never read an empty ID.
  const temporary = target + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, randomUUID(), { flag: 'wx', mode: 0o600 });
  try { await fs.link(temporary, target); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await fs.unlink(temporary); }
  return (await fs.readFile(target, 'utf8')).trim();
}
export async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, target);
}
export async function queueOperation({ base, actorId, method, apiPath, body }, stateDir = defaultStateDir()) {
  if (method !== 'POST' || !/^\/work-items\/[^/]+\/progress$/.test(apiPath)) throw new HubError('QUEUE_UNSUPPORTED', 'Only progress updates can be queued.');
  if (!body.operation_id) throw new HubError('OPERATION_REQUIRED', 'Queued writes need an operation_id.');
  const target = path.join(stateDir, 'outbox', safeKey(body.operation_id) + '.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const entry = { schema_version: 1, base, actor_id: actorId, method, path: apiPath, body, created_at: new Date().toISOString() };
  // No credentials in persistent queues.
  await fs.writeFile(target, JSON.stringify(entry, null, 2), { flag: 'wx', mode: 0o600 });
  return { queued: true, operation_id: body.operation_id, path: target };
}
export async function listOutbox(stateDir = defaultStateDir()) {
  const folder = path.join(stateDir, 'outbox');
  let names;
  try { names = await fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(folder, name);
    entries.push({ ...JSON.parse(await fs.readFile(file, 'utf8')), file });
  }
  return entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function replayOutbox(client, stateDir = defaultStateDir()) {
  const { me } = await client.bootstrap();
  const results = [];
  for (const entry of await listOutbox(stateDir)) {
    if (entry.method !== 'POST' || !/^\/work-items\/[^/]+\/progress$/.test(entry.path)) {
      results.push({ operation_id: entry.body.operation_id, skipped: true, reason: 'unsupported_queued_action' }); continue;
    }
    if (entry.base !== client.base || entry.actor_id !== me.id) {
      results.push({ operation_id: entry.body.operation_id, skipped: true, reason: 'different_server_or_actor' }); continue;
    }
    try {
      const result = await client.request(entry.method, entry.path, entry.body);
      await fs.unlink(entry.file);
      results.push({ operation_id: entry.body.operation_id, delivered: true, result });
    } catch (error) {
      results.push({ operation_id: entry.body.operation_id, delivered: false, error: error.toJSON?.().error ?? { message: error.message } });
      // Maintain ordering and retain conflicting operations for explicit resolution.
      break;
    }
  }
  return results;
}
