import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRuntimeCapabilities, verifyRuntimeCapabilities } from '../src/runtime-capabilities.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-pinned-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pin = { capability_id: 'cap-1', release_id: 'release-1', version: '1.0.0' };
  const capability = { id: 'cap-1', kind: 'skill', slug: 'example' };
  const release = { id: 'release-1', capability_id: 'cap-1', version: '1.0.0',
    manifest: { kind: 'skill', entry: 'SKILL.md' }, files: { 'SKILL.md': '---\nname: example\n---\n固定版本', 'references/example.md': '版本一' } };
  const calls = [];
  const client = { async getCapability(id) { calls.push(['capability', id]); return structuredClone(capability); },
    async getRelease(id, version) { calls.push(['release', id, version]); return structuredClone(release); } };
  return { dir, pin, capability, release, calls, client };
}

test('fixed releases are installed per dispatch and verified on repeat', async t => {
  const f = await fixture(t);
  const installed = await prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].release_id, 'release-1');
  assert.match(await fs.readFile(path.join(installed[0].directory, 'SKILL.md'), 'utf8'), /固定版本/);
  assert.deepEqual(f.calls.find(call => call[0] === 'release'), ['release', 'cap-1', '1.0.0']);
  await verifyRuntimeCapabilities(f.dir, 'dispatch-1', [f.pin], installed);
  assert.deepEqual(await prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]), installed);
  const other = await prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-2', [f.pin]);
  assert.notEqual(other[0].directory, installed[0].directory);
});

test('tampered files, extra files, and mismatched release identity are rejected', async t => {
  const f = await fixture(t);
  const installed = await prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]);
  await fs.writeFile(path.join(installed[0].directory, 'unlisted.txt'), 'unexpected');
  await assert.rejects(verifyRuntimeCapabilities(f.dir, 'dispatch-1', [f.pin], installed), { code: 'CAPABILITY_INSTALL_FAILED' });
  await fs.unlink(path.join(installed[0].directory, 'unlisted.txt'));
  await assert.rejects(verifyRuntimeCapabilities(f.dir, 'dispatch-1', [f.pin], [{ ...installed[0], entry: 'unlisted.txt' }]), { code: 'CAPABILITY_INSTALL_FAILED' });
  await fs.writeFile(path.join(installed[0].directory, 'SKILL.md'), 'changed');
  await assert.rejects(verifyRuntimeCapabilities(f.dir, 'dispatch-1', [f.pin], installed), { code: 'CAPABILITY_INSTALL_FAILED' });
  await assert.rejects(prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]), { code: 'CAPABILITY_INSTALL_FAILED' });
  f.release.id = 'other-release';
  await assert.rejects(prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-2', [f.pin]), { code: 'CAPABILITY_INSTALL_FAILED' });
  await assert.rejects(fs.access(path.join(f.dir, '.teamhub-runs', 'dispatch-2')));
});

test('missing packages, duplicate pins and linked destinations cannot launch', async t => {
  const f = await fixture(t);
  f.release.files = {};
  await assert.rejects(prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]), { code: 'CAPABILITY_INSTALL_FAILED' });
  await assert.rejects(prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin, f.pin]), { code: 'CAPABILITY_INSTALL_FAILED' });
  f.release.files = { 'SKILL.md': 'fixed' };
  const outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dir, '.teamhub-runs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareRuntimeCapabilities(f.client, f.dir, 'dispatch-1', [f.pin]), { code: 'CAPABILITY_INSTALL_FAILED' });
  assert.deepEqual(await fs.readdir(outside), []);
});
