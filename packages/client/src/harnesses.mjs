import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HubError } from './index.mjs';
import { installRelease, validateRelativeFile } from './installer.mjs';

// Project-level discovery locations documented by each host:
// https://code.claude.com/docs/en/skills
// https://learn.chatgpt.com/docs/build-skills
// https://opencode.ai/docs/skills/
const SKILL_ROOTS = Object.freeze({
  'claude-code': ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
  opencode: ['.opencode', 'skills'],
});
const SIMPLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateInstallTarget({ directory, harness, workspace } = {}) {
  if (harness !== undefined || workspace !== undefined) {
    if (directory !== undefined) throw new HubError('INSTALL_TARGET_CONFLICT', 'Use either --directory or --harness with --workspace, not both.');
    if (typeof harness !== 'string' || !Object.hasOwn(SKILL_ROOTS, harness)) {
      throw new HubError('UNSUPPORTED_HARNESS', 'Supported Skill installation targets: claude-code, codex, opencode.');
    }
    if (typeof workspace !== 'string' || !workspace.trim()) throw new HubError('ARGUMENT_REQUIRED', '--workspace must name an existing project directory.');
    return 'harness';
  }
  if (typeof directory !== 'string' || !directory.trim()) throw new HubError('ARGUMENT_REQUIRED', 'Supply --directory, or --harness with --workspace.');
  return 'directory';
}

export function skillNameFromSlug(slug) {
  if (typeof slug !== 'string' || !slug.split('/').every(part => SIMPLE_NAME.test(part))) {
    throw new HubError('INVALID_SKILL_SLUG', 'Automatic Skill installation requires a slug of lowercase letters, digits and single hyphens, optionally separated by namespace slashes.');
  }
  const name = slug.replaceAll('/', '-');
  if (name.length > 64) throw new HubError('INVALID_SKILL_SLUG', 'The Skill directory name derived from the slug must be at most 64 characters.');
  try { validateRelativeFile(name); }
  catch { throw new HubError('INVALID_SKILL_SLUG', 'The Skill slug resolves to a reserved filesystem name.'); }
  return name;
}

function scalar(value, field) {
  const invalid = () => { throw new HubError('INVALID_SKILL_FILE', `SKILL.md ${field} must be a non-empty YAML string; use a plain or quoted value.`); };
  const raw = value.trim();
  let result;
  if (raw.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(raw);
    if (!match) return invalid();
    try { result = JSON.parse(match[1]); } catch { return invalid(); }
  } else if (raw.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(raw);
    if (!match) return invalid();
    result = match[1].replaceAll("''", "'");
  } else {
    result = raw.replace(/\s+#.*$/, '').trim();
    if (/^[\[\]{}&*!>|]/.test(result) || /:\s/.test(result) || /^(?:null|true|false|~|[-+]?\d+(?:\.\d*)?)$/i.test(result)) return invalid();
  }
  if (typeof result !== 'string' || !result.trim()) return invalid();
  return result;
}

function requiredFrontmatter(content, expectedName) {
  if (typeof content !== 'string') throw new HubError('INVALID_SKILL_FILE', 'The release must include a UTF-8 SKILL.md file at its root.');
  const source = content.replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match || !source.slice(match[0].length).trim()) {
    throw new HubError('INVALID_SKILL_FILE', 'SKILL.md needs YAML frontmatter followed by Markdown instructions.');
  }
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):[ \t]*(.*)$/.exec(lines[index]);
    if (!field) continue;
    const [, key, value] = field;
    if (Object.hasOwn(fields, key)) throw new HubError('INVALID_SKILL_FILE', `SKILL.md has duplicate ${key} fields.`);
    if (key === 'description' && /^[>|][+-]?(?:\s+#.*)?$/.test(value)) {
      const block = [];
      for (let next = index + 1; next < lines.length && (/^[ \t]/.test(lines[next]) || !lines[next].trim()); next++) block.push(lines[next].trim());
      fields[key] = block.join(' ').trim();
      if (!fields[key]) throw new HubError('INVALID_SKILL_FILE', 'SKILL.md description cannot be empty.');
    } else fields[key] = scalar(value, key);
  }
  if (!fields.name || !fields.description) throw new HubError('INVALID_SKILL_FILE', 'SKILL.md must have top-level name and description strings in its frontmatter.');
  if (!SIMPLE_NAME.test(fields.name) || fields.name.length > 64) throw new HubError('INVALID_SKILL_FILE', 'SKILL.md name must use lowercase letters, digits and single hyphens, at most 64 characters.');
  if (fields.description.length > 1024) throw new HubError('INVALID_SKILL_FILE', 'SKILL.md description must be at most 1024 characters.');
  if (fields.name !== expectedName) {
    throw new HubError('SKILL_NAME_MISMATCH', `SKILL.md name is '${fields.name}', but slug-derived directory is '${expectedName}'. Publish a matching Skill name in a new release, or use --directory for manual installation.`);
  }
}

export async function installHarnessSkill(capability, release, options) {
  if (validateInstallTarget(options) !== 'harness') throw new HubError('ARGUMENT_REQUIRED', 'A harness and existing workspace are required.');
  if (capability?.kind !== 'skill' || release?.manifest?.kind !== 'skill') {
    throw new HubError('HARNESS_INSTALL_KIND', '--harness chooses a Skill discovery directory only. Install scripts and other package types with --directory.');
  }
  if (!capability.id || release.capability_id !== capability.id) throw new HubError('INVALID_RELEASE', 'Capability and release IDs do not match.');
  if (release.manifest.entry !== 'SKILL.md') throw new HubError('INVALID_SKILL_FILE', 'A portable Skill manifest must use entry: SKILL.md.');
  const name = skillNameFromSlug(capability.slug);
  requiredFrontmatter(release.files?.['SKILL.md'], name);
  const workspace = path.resolve(options.workspace);
  let workspaceStat;
  try { workspaceStat = await fs.stat(workspace); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HubError('WORKSPACE_NOT_FOUND', '--workspace must point to an existing project directory; no project directory was created.');
    throw error;
  }
  if (!workspaceStat.isDirectory()) throw new HubError('WORKSPACE_NOT_DIRECTORY', '--workspace must point to a directory.');
  const directory = path.join(workspace, ...SKILL_ROOTS[options.harness], name);
  const result = await installRelease(release, directory);
  return { ...result, harness: options.harness, workspace, skill_name: name };
}
