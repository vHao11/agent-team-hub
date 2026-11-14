import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cli = fileURLToPath(new URL('../bin/teamhub.mjs', import.meta.url));
function run(args, env = {}) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, TEAMHUB_TOKEN: '', ...env } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
}); }

test('CLI missing-token errors are machine readable', async () => {
  const result = await run(['whoami']); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'TOKEN_REQUIRED');
});

test('CLI sends an explicit versioned command over HTTP and emits JSON', async t => {
  let request;
  const server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk;
    request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'work-1', version: 3, status: 'accepted' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await run(['items', 'accept', 'work-1', '--version', '2', '--operation-id', 'cli-claim-1'], { TEAMHUB_URL: `http://127.0.0.1:${server.address().port}`, TEAMHUB_TOKEN: 'test-only' });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'accepted');
  assert.equal(request.url, '/api/v1/work-items/work-1/accept'); assert.equal(request.authorization, 'Bearer test-only');
  assert.deepEqual(request.body, { operation_id: 'cli-claim-1', expected_version: 2 });
});

test('CLI refuses offline starts before sending a request', async () => {
  const result = await run(['items', 'start', 'work-1', '--version', '2', '--queue', '--actor-id', 'user-1']);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, 'QUEUE_UNSUPPORTED');
});

test('CLI installs a pinned Skill into the selected host and preserves repeat installs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-cli-skill-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, '中文 workspace');
  await fs.mkdir(workspace);
  const skill = '---\nname: trading-interface-review\ndescription: Review interface changes.\n---\n\n# Review\n';
  const capability = { id: 'cap-review', slug: 'trading/interface-review', kind: 'skill' };
  const release = { id: 'rel-review', capability_id: capability.id, version: '0.1.0', manifest: { kind: 'skill', entry: 'SKILL.md' }, files: { 'SKILL.md': skill } };
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const body = req.url === '/api/v1/capabilities/cap-review/releases/0.1.0' ? release : req.url === '/api/v1/capabilities/cap-review' ? capability : null;
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const environment = { TEAMHUB_URL: `http://127.0.0.1:${server.address().port}`, TEAMHUB_TOKEN: 'test-only' };
  const args = ['tools', 'install', capability.id, '--version', '0.1.0', '--harness', 'codex', '--workspace', workspace];
  const first = await run(args, environment);
  assert.equal(first.code, 0, first.stderr);
  const installed = JSON.parse(first.stdout);
  assert.equal(installed.directory, path.join(workspace, '.agents', 'skills', 'trading-interface-review'));
  assert.equal(await fs.readFile(path.join(installed.directory, 'SKILL.md'), 'utf8'), skill);
  const again = await run(args, environment);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).already_installed, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.authorization === 'Bearer test-only'));
});

test('CLI validates host installation arguments before making HTTP requests', async () => {
  for (const [options, code] of [
    [['--directory', 'manual', '--harness', 'codex', '--workspace', '.'], 'INSTALL_TARGET_CONFLICT'],
    [['--harness', 'unknown', '--workspace', '.'], 'UNSUPPORTED_HARNESS'],
    [['--harness', 'codex'], 'ARGUMENT_REQUIRED'],
    [['--workspace', '.'], 'UNSUPPORTED_HARNESS'],
  ]) {
    const result = await run(['tools', 'install', 'cap-review', '--version', '0.1.0', ...options]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, code);
  }
});

test('CLI uploads text artifacts with readable MIME types and leaves unknown files binary', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-cli-uploads-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const types = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const multipart = Buffer.concat(chunks).toString('utf8');
    types.push(/\r\nContent-Type: ([^\r\n]+)/i.exec(multipart)?.[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'artifact-test', url: 'artifact://artifact-test' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const environment = { TEAMHUB_URL: `http://127.0.0.1:${server.address().port}`, TEAMHUB_TOKEN: 'test-only' };
  const cases = [
    ['report.md', 'text/markdown'], ['notes.txt', 'text/plain'], ['run.log', 'text/plain'],
    ['report.JSON', 'application/json'], ['rows.csv', 'text/csv'], ['config.yaml', 'text/plain'],
    ['config.yml', 'text/plain'], ['config.toml', 'text/plain'], ['binary.bin', 'application/octet-stream'],
  ];
  for (const [filename] of cases) {
    const file = path.join(root, filename);
    await fs.writeFile(file, filename.endsWith('.bin') ? Buffer.from([0, 255, 1]) : 'UTF-8 文本\n');
    const result = await run(['artifacts', 'upload', file], environment);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).url, 'artifact://artifact-test');
  }
  assert.deepEqual(types, cases.map(([, type]) => type));
});
