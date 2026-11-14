import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HubError } from './index.mjs';

const META = '.teamhub-release.json';
export function validateRelativeFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') || name.endsWith('/')) {
    throw new HubError('INVALID_PACKAGE_PATH', `Unsafe package path: ${name}`);
  }
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new HubError('INVALID_PACKAGE_PATH', `Unsafe package path: ${name}`);
  }
  if (name === META) throw new HubError('INVALID_PACKAGE_PATH', 'Package metadata path is reserved.');
  return name;
}

async function rejectSymlinkAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new HubError('SYMLINK_DESTINATION', 'Installation destination must not traverse a symbolic link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

export async function installRelease(release, destination) {
  if (!release?.id || !release.version || !release.capability_id || !release.manifest) throw new HubError('INVALID_RELEASE', 'Incomplete release.');
  const files = release.files;
  if (!files || !Object.keys(files).length) throw new HubError('INSTALL_UNSUPPORTED', 'This release has no embedded package files. Use its documented host-specific installation method.');
  const names = Object.keys(files); const seen = new Set(); let bytes = 0;
  for (const name of names) {
    validateRelativeFile(name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new HubError('INVALID_PACKAGE_PATH', 'Case-insensitive filename collision.');
    seen.add(key);
    if (typeof files[name] !== 'string') throw new HubError('INVALID_RELEASE', 'Package files must be UTF-8 text.');
    bytes += Buffer.byteLength(files[name]);
  }
  if (bytes > 10 * 1024 * 1024 || names.length > 1000) throw new HubError('PACKAGE_TOO_LARGE', 'Embedded package exceeds the 10 MiB / 1000 file limit.');
  const target = path.resolve(destination);
  await rejectSymlinkAncestors(target);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) throw new HubError('DESTINATION_EXISTS', 'Destination is not a directory.');
    const existing = JSON.parse(await fs.readFile(path.join(target, META), 'utf8'));
    if (existing.release_id === release.id) return { installed: true, already_installed: true, directory: target, release_id: release.id, version: release.version };
    throw new HubError('DESTINATION_EXISTS', 'Another release already occupies this directory. Install to a new version directory and switch when idle.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = target + '.install-' + randomUUID();
  await fs.mkdir(staging, { recursive: false });
  try {
    for (const name of names) {
      const file = path.join(staging, ...name.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, files[name], { flag: 'wx' });
    }
    const metadata = { schema_version: 1, release_id: release.id, capability_id: release.capability_id,
      version: release.version, manifest: release.manifest, installed_at: new Date().toISOString() };
    await fs.writeFile(path.join(staging, META), JSON.stringify(metadata, null, 2));
    await fs.rename(staging, target);
    return { installed: true, directory: target, release_id: release.id, version: release.version, files: names.length };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

export async function runInstalled(directory, args = [], { timeout = 120000 } = {}) {
  const root = path.resolve(directory);
  await rejectSymlinkAncestors(root);
  const metadata = JSON.parse(await fs.readFile(path.join(root, META), 'utf8'));
  const manifest = metadata.manifest;
  if (manifest.kind !== 'script') throw new HubError('NOT_EXECUTABLE_SCRIPT', 'Only a script capability can be run by this command. Skills are loaded by the harness.');
  const entry = validateRelativeFile(manifest.entry);
  const file = path.join(root, ...entry.split('/'));
  await rejectSymlinkAncestors(file);
  await fs.access(file);
  const runtime = manifest.runtime || (entry.endsWith('.py') ? 'python' : entry.endsWith('.js') || entry.endsWith('.mjs') ? 'node' : null);
  if (!['python', 'node'].includes(runtime)) throw new HubError('UNSUPPORTED_RUNTIME', 'Supported script runtimes: python, node.');
  const program = runtime === 'node' ? process.execPath : (process.env.TEAMHUB_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'));
  if (!args.every(value => typeof value === 'string')) throw new HubError('INVALID_ARGUMENT', 'Script arguments must be strings.');
  return await new Promise((resolve, reject) => {
    const child = spawn(program, [file, ...args], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const collect = (key, chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { child.kill(); return; }
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => { clearTimeout(timer); reject(new HubError('SCRIPT_START_FAILED', error.message)); });
    child.on('close', code => { clearTimeout(timer); resolve({ release_id: metadata.release_id, version: metadata.version,
      status: timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed', exit_code: code, stdout, stderr,
      ...(size > 4 * 1024 * 1024 ? { output_limit_exceeded: true } : {}) }); });
  });
}
