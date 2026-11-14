#!/usr/bin/env node
/** Codex/Claude 本机执行器：单次 stdio 调用加独立监督进程。 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [name, harness, binary, workspace, root, mode, prefixJson = '[]', workerFlag, workerId] = process.argv.slice(2);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const script = fileURLToPath(import.meta.url);
const configArgs = [name, harness, binary, workspace, root, mode, prefixJson];
const privateFile = { mode: 0o600 };
let prefix;
try { prefix = JSON.parse(prefixJson); } catch { prefix = null; }
if (!identifier(name) || !['codex', 'claude'].includes(harness) || !path.isAbsolute(binary || '')
    || !path.isAbsolute(workspace || '') || !path.isAbsolute(root || '') || !['read-only', 'workspace-write'].includes(mode)
    || !Array.isArray(prefix) || prefix.some(value => typeof value !== 'string' || value.includes('\0'))) {
  process.stderr.write('执行器配置无效。\n'); process.exit(2);
}

const jobDir = id => {
  if (!identifier(id)) throw new Error('invalid dispatch id');
  return path.join(root, id);
};
async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { ...privateFile, flag: 'wx' });
  await fs.rename(temporary, file);
}
async function loadState(id) { return JSON.parse(await fs.readFile(path.join(jobDir(id), 'state.json'), 'utf8')); }
async function publish(id, state) { await atomic(path.join(jobDir(id), 'state.json'), { ...state, updated_at: Date.now() }); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function supervisor(id) {
  const dir = jobDir(id);
  const job = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  let state = { dispatch_id: id, status: 'starting' };
  let child, spawned = false, stopped = false, ended = false, writing = false, size = 0, tooLarge = false;
  const chunks = [];
  const heartbeat = setInterval(async () => {
    if (writing || ended) return;
    writing = true;
    try {
      if (!stopped && await exists(path.join(dir, 'cancel.request'))) { stopped = true; child?.kill(); }
      await publish(id, state);
    } catch { /* 断电或权限异常时状态检查会显示未知。 */ }
    finally { writing = false; }
  }, 1000);
  const prompt = '请根据以下 Agent Team Hub 固定输入完成工作。执行结果仅作为证据，禁止自行通过业务验收。\n' + JSON.stringify(job.input_snapshot);
  const args = harness === 'codex'
    ? [...prefix, 'exec', '--json', '--sandbox', mode, '-C', workspace, '-']
    : [...prefix, '-p', '--output-format', 'json', '--permission-mode', mode === 'read-only' ? 'plan' : 'acceptEdits',
      '--permission-prompts', 'none', ...(mode === 'read-only' ? ['--tools', 'Read,Grep,Glob', '--strict-mcp-config'] : [])];
  try {
    if (await exists(path.join(dir, 'cancel.request'))) { state = { dispatch_id: id, status: 'cancelled' }; return; }
    child = spawn(binary, args, { cwd: workspace, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); child.stderr.resume();
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { tooLarge = true; child.kill(); }
      else chunks.push(chunk);
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    spawned = true;
    // 启动与取消请求可能并发；若计时器在子进程出现之前收到请求，
    // 必须在 spawn 后再次停止，不能让已经标记为停止的任务继续运行。
    if (stopped || await exists(path.join(dir, 'cancel.request'))) { stopped = true; child.kill(); }
    state = { dispatch_id: id, status: 'running' }; await publish(id, state);
    child.stdin.end(prompt);
    const code = await closed;
    const output = Buffer.concat(chunks).toString('utf8');
    let validSuccess = false, summary = '';
    if (!tooLarge && code === 0 && !stopped) {
      if (harness === 'claude') {
        try { const value = JSON.parse(output); validSuccess = value.is_error === false && typeof value.result === 'string'; summary = value.result || ''; } catch { /* 未识别结果保持未知。 */ }
      } else {
        let failure = false;
        for (const line of output.split('\n')) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'turn.completed') validSuccess = true;
            if (event.type === 'turn.failed' || event.type === 'error') failure = true;
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') summary = event.item.text;
          } catch { /* JSONL 其他输出不构成完成证据。 */ }
        }
        validSuccess = validSuccess && !failure;
      }
    }
    state = { dispatch_id: id, status: stopped || tooLarge ? 'unknown' : validSuccess ? 'succeeded' : code === 0 ? 'unknown' : 'failed',
      ...(validSuccess && summary ? { summary: summary.slice(0, 2000) } : {}) };
  } catch {
    if (spawned) child?.kill();
    state = { dispatch_id: id, status: spawned ? 'unknown' : 'failed', summary: spawned ? '执行状态待核实。' : '本机执行器无法启动。' };
  } finally {
    ended = true; clearInterval(heartbeat);
    while (writing) await new Promise(resolve => setTimeout(resolve, 10));
    await publish(id, state);
  }
}

async function handle(method, params) {
  if (method === 'adapter.describe') {
    const version = spawnSync(binary, [...prefix, '--version'], { cwd: workspace, encoding: 'utf8', timeout: 5000, windowsHide: true });
    return { protocol: 'agent-team-hub-adapter', protocol_version: 1, name, kind: 'executor', version: '1.0.0',
      available: version.status === 0, capabilities: { start: true, status: true, cancel: true, recover: true } };
  }
  if (method === 'execution.find') {
    const id = params.dispatch_id;
    if (!identifier(id) || !(await exists(path.join(jobDir(id), 'job.json')))) return null;
    return { run_id: id };
  }
  if (method === 'execution.status') {
    const state = await loadState(params.handle?.run_id);
    if (['starting', 'running'].includes(state.status) && Date.now() - state.updated_at > 5000) return { status: 'unknown' };
    return { status: state.status, ...(state.summary ? { summary: state.summary } : {}) };
  }
  if (method === 'execution.cancel') {
    const id = params.handle?.run_id; const state = await loadState(id);
    if (!['starting', 'running', 'unknown'].includes(state.status)) return { requested: false, confirmed: false };
    try { await fs.writeFile(path.join(jobDir(id), 'cancel.request'), 'requested', { ...privateFile, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { requested: true, confirmed: false };
  }
  if (method === 'execution.start') {
    if (!identifier(params.dispatch_id) || !params.input_snapshot?.title || !Array.isArray(params.capability_releases) || params.capability_releases.length) throw new Error('precondition');
    let allowed, requested;
    try { [allowed, requested] = await Promise.all([fs.realpath(workspace), fs.realpath(params.workspace_ref)]); }
    catch { throw new Error('precondition'); }
    if ((process.platform === 'win32' ? allowed.toLowerCase() : allowed) !== (process.platform === 'win32' ? requested.toLowerCase() : requested)) throw new Error('precondition');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const dir = jobDir(params.dispatch_id), fingerprint = hash(params);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
      if (previous.fingerprint !== fingerprint) throw new Error('dispatch conflict');
      return { run_id: params.dispatch_id, status: 'starting' };
    }
    await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ fingerprint, input_snapshot: params.input_snapshot }), { ...privateFile, flag: 'wx' });
    await publish(params.dispatch_id, { dispatch_id: params.dispatch_id, status: 'starting' });
    const child = spawn(process.execPath, [script, ...configArgs, '--worker', params.dispatch_id],
      { detached: true, windowsHide: true, stdio: 'ignore', cwd: workspace });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { run_id: params.dispatch_id, status: 'starting' };
  }
  throw new Error('unknown method');
}

if (workerFlag === '--worker' && identifier(workerId)) {
  await supervisor(workerId);
} else {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 2 * 1024 * 1024) process.exit(2); }
  let request;
  try {
    request = JSON.parse(raw);
    if (request.jsonrpc !== '2.0' || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid request');
    const result = await handle(request.method, request.params || {});
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: typeof request?.id === 'string' ? request.id : '',
      error: { code: -32000, message: error.message === 'precondition' ? 'adapter precondition failed' : 'adapter operation failed',
        ...(error.message === 'precondition' ? { data: { code: 'ADAPTER_PRECONDITION_FAILED' } } : {}) } }) + '\n');
  }
}
