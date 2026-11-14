import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHarnessSkill, skillNameFromSlug, validateInstallTarget } from '../src/harnesses.mjs';

const capability = { id: 'cap-review', slug: 'trading/interface-review', kind: 'skill' };
const skill = '---\nname: trading-interface-review\ndescription: 评估接口变更并生成报告。\n---\n\n# 接口检查\n\n读取 references/report.md。\n';
const release = (content = skill) => ({
  id: 'release-review-1', capability_id: capability.id, version: '0.1.0',
  manifest: { kind: 'skill', entry: 'SKILL.md', version: '0.1.0' },
  files: { 'SKILL.md': content, 'references/report.md': '# 报告模板\n' },
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-harness-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, '研发项目 with spaces');
  await fs.mkdir(workspace);
  return { directory, workspace };
}

test('each host receives unchanged Skill content in its project discovery directory', async t => {
  const { workspace } = await fixture(t);
  for (const [harness, hostDirectory] of Object.entries({ 'claude-code': '.claude', codex: '.agents', opencode: '.opencode' })) {
    const installed = await installHarnessSkill(capability, release(), { harness, workspace });
    const expected = path.join(workspace, hostDirectory, 'skills', 'trading-interface-review');
    assert.equal(installed.directory, expected);
    assert.equal(installed.skill_name, 'trading-interface-review');
    assert.equal(installed.harness, harness);
    assert.equal(await fs.readFile(path.join(expected, 'SKILL.md'), 'utf8'), skill);
    assert.equal(await fs.readFile(path.join(expected, 'references/report.md'), 'utf8'), '# 报告模板\n');
    const metadata = JSON.parse(await fs.readFile(path.join(expected, '.teamhub-release.json'), 'utf8'));
    assert.equal(metadata.release_id, 'release-review-1');
  }
});

test('repeat installs preserve files and other versions or colliding slugs cannot replace them', async t => {
  const { workspace } = await fixture(t);
  const options = { harness: 'codex', workspace: path.relative(process.cwd(), workspace) };
  const first = await installHarnessSkill(capability, release(), options);
  const reportPath = path.join(first.directory, 'references/report.md');
  await fs.writeFile(reportPath, '# 本地补充\n');
  assert.equal((await installHarnessSkill(capability, release(), options)).already_installed, true);
  await assert.rejects(installHarnessSkill(capability, { ...release(), id: 'release-review-2', version: '0.2.0' }, options), { code: 'DESTINATION_EXISTS' });
  const collision = { ...capability, id: 'cap-other', slug: 'trading-interface/review' };
  await assert.rejects(installHarnessSkill(collision, { ...release(), id: 'release-other', capability_id: collision.id }, options), { code: 'DESTINATION_EXISTS' });
  assert.equal(await fs.readFile(reportPath, 'utf8'), '# 本地补充\n');
  assert.equal(await fs.readFile(path.join(first.directory, 'SKILL.md'), 'utf8'), skill);
});

test('host installation rejects invalid or mismatched Skill metadata before writing', async t => {
  const { workspace } = await fixture(t);
  const options = { harness: 'opencode', workspace };
  for (const content of [
    undefined,
    '# Missing frontmatter',
    '---\nname: trading-interface-review\n---\n# Missing description',
    '---\nname: trading-interface-review\ndescription: []\n---\n# Wrong type',
    '---\nname: trading-interface-review\ndescription: ""\n---\n# Empty description',
    '---\nname: trading-interface-review\nname: trading-interface-review\ndescription: Duplicate\n---\n# Duplicate',
    '---\nname: trading-interface-review\ndescription: content\n---\n',
  ]) {
    const value = release();
    if (content === undefined) delete value.files['SKILL.md'];
    else value.files['SKILL.md'] = content;
    await assert.rejects(installHarnessSkill(capability, value, options), { code: 'INVALID_SKILL_FILE' });
  }
  await assert.rejects(installHarnessSkill(capability, release(skill.replace('name: trading-interface-review', 'name: interface-review')), options), { code: 'SKILL_NAME_MISMATCH' });
  await assert.rejects(installHarnessSkill(capability, { ...release(), manifest: { kind: 'skill', entry: 'readme.md' } }, options), { code: 'INVALID_SKILL_FILE' });
  await assert.rejects(installHarnessSkill({ ...capability, kind: 'script' }, release(), options), { code: 'HARNESS_INSTALL_KIND' });
  await assert.rejects(fs.access(path.join(workspace, '.opencode')));
});

test('portable quoted and block frontmatter is accepted without rewriting', async t => {
  const { workspace } = await fixture(t);
  const variants = [
    '---\nname: "trading-interface-review" # comment\ndescription: "检查: 接口影响"\n---\n\n# Review\n',
    "---\nname: 'trading-interface-review'\ndescription: 'It''s an interface review'\n---\n\n# Review\n",
    '---\r\nname: trading-interface-review\r\ndescription: >-\r\n  检查接口变更，\r\n  生成影响报告。\r\n---\r\n\r\n# Review\r\n',
  ];
  for (const [index, content] of variants.entries()) {
    const project = path.join(workspace, String(index));
    await fs.mkdir(project);
    const installed = await installHarnessSkill(capability, release(content), { harness: 'codex', workspace: project });
    assert.equal(await fs.readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'), content);
  }
});

test('target options, invalid slugs and missing workspace fail without creating a project', async t => {
  const { directory, workspace } = await fixture(t);
  assert.equal(validateInstallTarget({ directory: workspace }), 'directory');
  assert.throws(() => validateInstallTarget({ directory: workspace, harness: 'codex', workspace }), { code: 'INSTALL_TARGET_CONFLICT' });
  assert.throws(() => validateInstallTarget({ harness: 'unknown', workspace }), { code: 'UNSUPPORTED_HARNESS' });
  assert.throws(() => validateInstallTarget({ workspace }), { code: 'UNSUPPORTED_HARNESS' });
  assert.throws(() => validateInstallTarget({ harness: 'codex' }), { code: 'ARGUMENT_REQUIRED' });
  for (const slug of ['', '../escape', '/review', 'review/', 'a//review', 'UpperCase', 'a_name', 'a.name', 'a--name', 'con', 'a'.repeat(65)]) {
    assert.throws(() => skillNameFromSlug(slug), { code: 'INVALID_SKILL_SLUG' });
  }
  assert.equal(skillNameFromSlug('trading/interface-review'), 'trading-interface-review');
  const missing = path.join(directory, 'does-not-exist');
  await assert.rejects(installHarnessSkill(capability, release(), { harness: 'codex', workspace: missing }), { code: 'WORKSPACE_NOT_FOUND' });
  await assert.rejects(fs.access(missing));
  const file = path.join(directory, 'not-a-directory');
  await fs.writeFile(file, 'content');
  await assert.rejects(installHarnessSkill(capability, release(), { harness: 'codex', workspace: file }), { code: 'WORKSPACE_NOT_DIRECTORY' });
});

test('the source and packaged example Skills stay identical and install with their catalog slug', async t => {
  const { workspace } = await fixture(t);
  const example = await fs.readFile(new URL('../../../examples/capabilities/interface-review/SKILL.md', import.meta.url), 'utf8');
  const packaged = await fs.readFile(new URL('../../../server/teamhub/sample_content/interface-review/SKILL.md', import.meta.url), 'utf8');
  assert.equal(example, packaged);
  const installed = await installHarnessSkill(capability, release(example), { harness: 'claude-code', workspace });
  assert.equal(await fs.readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'), example);
});
