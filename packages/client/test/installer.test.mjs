import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRelease, runInstalled, validateRelativeFile } from '../src/installer.mjs';

async function fixture(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-installer-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const release = files => ({ id: 'rel-1', capability_id: 'cap-1', version: '0.1.0', manifest: { kind: 'script', entry: 'main.mjs', runtime: 'node' }, files });

test('package path validation covers Windows and POSIX traversal and reserved paths', () => {
  for (const name of ['../escape', '/absolute', 'C:/secret', 'a\\b', 'a/../../b', 'x//y', 'NUL', 'a/con.txt', 'x.', '.teamhub-release.json']) assert.throws(() => validateRelativeFile(name), { code: 'INVALID_PACKAGE_PATH' });
  assert.equal(validateRelativeFile('references/example.md'), 'references/example.md');
});

test('install pins a release without executing scripts; explicit run uses argv without a shell', async t => {
  const root = await fixture(t); const target = path.join(root, 'v0.1.0');
  const script = `import {writeFileSync} from 'node:fs'; writeFileSync('executed.txt','yes'); console.log(JSON.stringify(process.argv.slice(2)));`;
  const first = await installRelease(release({ 'main.mjs': script }), target);
  assert.equal(first.version, '0.1.0'); await assert.rejects(fs.access(path.join(target, 'executed.txt')));
  assert.equal((await installRelease(release({ 'main.mjs': script }), target)).already_installed, true);
  const result = await runInstalled(target, ['$(not-executed)', 'space value']);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(JSON.parse(result.stdout), ['$(not-executed)', 'space value']);
  assert.equal(await fs.readFile(path.join(target, 'executed.txt'), 'utf8'), 'yes');
  await assert.rejects(installRelease({ ...release({ 'main.mjs': script }), id: 'rel-2', version: '0.2.0' }, target), { code: 'DESTINATION_EXISTS' });
});

test('malicious packages and symlink destinations do not write outside their target', async t => {
  const root = await fixture(t);
  await assert.rejects(installRelease(release({ '../escaped': 'bad' }), path.join(root, 'invalid')), { code: 'INVALID_PACKAGE_PATH' });
  await assert.rejects(fs.access(path.join(root, 'escaped')));
  await assert.rejects(installRelease(release({ 'Case': 'a', 'case': 'b' }), path.join(root, 'collision')), { code: 'INVALID_PACKAGE_PATH' });
  const real = path.join(root, 'real'); await fs.mkdir(real);
  // Directory junctions exercise the same boundary without Windows symlink privileges.
  await fs.symlink(real, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installRelease(release({ 'main.mjs': '' }), path.join(root, 'linked', 'package')), { code: 'SYMLINK_DESTINATION' });
});

test('skills are not executable and script failures remain failures', async t => {
  const root = await fixture(t);
  await installRelease({ ...release({ 'SKILL.md': '# Review' }), manifest: { kind: 'skill', entry: 'SKILL.md' } }, path.join(root, 'skill'));
  await assert.rejects(runInstalled(path.join(root, 'skill')), { code: 'NOT_EXECUTABLE_SCRIPT' });
  await installRelease(release({ 'main.mjs': 'process.stderr.write("failed"); process.exit(7);' }), path.join(root, 'script'));
  const result = await runInstalled(path.join(root, 'script')); assert.equal(result.status, 'failed'); assert.equal(result.exit_code, 7);
});
