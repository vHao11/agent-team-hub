import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HubError } from './index.mjs';
import { installRelease, validateRelativeFile } from './installer.mjs';

const component = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const error = message => new HubError('CAPABILITY_INSTALL_FAILED', message);

async function noLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw error('能力安装路径不能经过符号链接或目录联接。'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function workspacePath(workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw error('能力安装需要本机绝对工作区路径。');
  const actual = await fs.realpath(workspace).catch(() => { throw error('能力安装工作区不存在。'); });
  if (!(await fs.stat(actual)).isDirectory()) throw error('能力安装工作区不是目录。');
  return actual;
}

function descriptor(pin, capability, release, directory) {
  if (!component(pin?.capability_id) || !component(pin?.release_id) || typeof pin?.version !== 'string'
      || capability?.id !== pin.capability_id || release?.id !== pin.release_id
      || release?.capability_id !== pin.capability_id || release?.version !== pin.version
      || !release?.manifest || typeof release.manifest !== 'object' || Array.isArray(release.manifest)
      || (release.manifest.kind && release.manifest.kind !== capability.kind)) {
    throw error('固定能力版本与 Hub 返回的发布内容不一致。');
  }
  const entries = Object.entries(release.files || {});
  if (!entries.length || entries.length > 100) throw error('固定能力没有可自动安装的内置文件。');
  const files = entries.map(([name, content]) => {
    validateRelativeFile(name);
    if (typeof content !== 'string') throw error('能力文件必须为 UTF-8 文本。');
    return { path: name, sha256: sha(Buffer.from(content, 'utf8')) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const entry = release.manifest.entry;
  if (entry !== undefined && (typeof entry !== 'string' || !files.some(file => file.path === entry))) throw error('能力入口不在固定版本文件中。');
  return { capability_id: pin.capability_id, release_id: pin.release_id, version: pin.version,
    kind: capability.kind, slug: capability.slug, directory, entry: entry || null,
    manifest_sha256: sha(JSON.stringify(release.manifest)), files };
}

/** 在每次派发自己的工作区目录中安装固定发布，不覆盖已有版本或运行。 */
export async function prepareRuntimeCapabilities(client, workspace, dispatchId, pins) {
  if (!component(dispatchId) || !Array.isArray(pins)) throw error('无效的派发或固定能力列表。');
  if (!pins.length) return [];
  if (pins.length > 100 || pins.some(pin => !component(pin?.capability_id) || !component(pin?.release_id) || typeof pin.version !== 'string' || !pin.version)
      || new Set(pins.map(pin => pin.capability_id.toLowerCase())).size !== pins.length) throw error('固定能力无效、重复或数量过多。');
  const root = await workspacePath(workspace);
  const base = path.join(root, '.teamhub-runs', dispatchId, 'capabilities');
  await noLinks(base);
  const prepared = [];
  // 先核对全部版本，再开始写入；不会把 latest 当作固定版本。
  for (const pin of pins) {
    const [capability, release] = await Promise.all([client.getCapability(pin.capability_id), client.getRelease(pin.capability_id, pin.version)]);
    const directory = path.join(base, pin.capability_id);
    prepared.push({ release, installed: descriptor(pin, capability, release, directory) });
  }
  for (const value of prepared) await installRelease(value.release, value.installed.directory);
  const installed = prepared.map(value => value.installed);
  await verifyRuntimeCapabilities(root, dispatchId, pins, installed);
  return installed;
}

/** 在交给宿主之前核对安装位置、固定版本、文件内容及额外文件。 */
export async function verifyRuntimeCapabilities(workspace, dispatchId, pins, installed) {
  if (!Array.isArray(pins) || !Array.isArray(installed) || pins.length !== installed.length || !component(dispatchId)) throw error('缺少固定能力安装证明。');
  if (!pins.length) return;
  const root = await workspacePath(workspace);
  const base = path.join(root, '.teamhub-runs', dispatchId, 'capabilities');
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i], item = installed[i];
    if (!component(pin?.capability_id) || !component(pin?.release_id) || item?.capability_id !== pin.capability_id
        || item?.release_id !== pin.release_id || item?.version !== pin.version
        || path.resolve(item.directory || '') !== path.join(base, pin.capability_id)
        || !Array.isArray(item.files) || !item.files.length) throw error('固定能力安装证明与当前派发不匹配。');
    await noLinks(item.directory);
    const meta = JSON.parse(await fs.readFile(path.join(item.directory, '.teamhub-release.json'), 'utf8'));
    if (meta.release_id !== pin.release_id || meta.capability_id !== pin.capability_id || meta.version !== pin.version
        || sha(JSON.stringify(meta.manifest)) !== item.manifest_sha256
        || (meta.manifest.kind && meta.manifest.kind !== item.kind)
        || (meta.manifest.entry || null) !== item.entry) throw error('固定能力清单已变化。');
    const expected = new Map(item.files.map(file => [validateRelativeFile(file.path), file.sha256]));
    if (expected.size !== item.files.length || new Set([...expected.keys()].map(name => name.toLowerCase())).size !== expected.size
        || [...expected.values()].some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        || (item.entry && !expected.has(item.entry))) throw error('固定能力文件证明无效或重复。');
    const found = new Set();
    async function walk(dir, prefix = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw error('固定能力目录包含链接。');
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), name);
        else if (entry.isFile() && name === '.teamhub-release.json') continue;
        else if (entry.isFile() && expected.has(name)) {
          if (sha(await fs.readFile(path.join(dir, entry.name))) !== expected.get(name)) throw error('固定能力文件已变化。');
          found.add(name);
        } else throw error('固定能力目录包含未声明的文件。');
      }
    }
    await walk(item.directory);
    if (found.size !== expected.size) throw error('固定能力文件缺失。');
  }
}
