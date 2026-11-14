#!/usr/bin/env node
/** Codex、Claude Code、OpenCode 本机执行器：单次 stdio 调用加独立监督进程。 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeCapabilities } from './runtime-capabilities.mjs';

const argv = process.argv.slice(2);
const [name, harness, binary, workspace, root, mode, prefixJson = '[]'] = argv;
const optionsJson = argv[7] === '--worker' ? '{}' : (argv[7] || '{}');
const workerFlag = argv[7] === '--worker' ? argv[7] : argv[8];
const workerId = argv[7] === '--worker' ? argv[8] : argv[9];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const script = fileURLToPath(import.meta.url);
const configArgs = [name, harness, binary, workspace, root, mode, prefixJson, optionsJson];
const privateFile = { mode: 0o600 };
let prefix, options;
try { prefix = JSON.parse(prefixJson); } catch { prefix = null; }
try { options = JSON.parse(optionsJson); } catch { options = null; }
if (!identifier(name) || !['codex', 'claude', 'opencode'].includes(harness) || !path.isAbsolute(binary || '')
    || !path.isAbsolute(workspace || '') || !path.isAbsolute(root || '') || !['read-only', 'workspace-write'].includes(mode)
    || !Array.isArray(prefix) || prefix.some(value => typeof value !== 'string' || value.includes('\0'))
    || !options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'opencode_config')
    || (options.opencode_config !== undefined && (harness !== 'opencode' || typeof options.opencode_config !== 'string'
      || !path.isAbsolute(options.opencode_config) || options.opencode_config.includes('\0')))) {
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

function openCodeConfig(installed = []) {
  let config = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config');
  }
  if (config.agents !== undefined && (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents))) throw new Error('invalid agents');
  if (config.skills !== undefined && !Array.isArray(config.skills)) throw new Error('invalid skills');
  const skills = installed.filter(item => item.kind === 'skill' && item.entry === 'SKILL.md');
  const allowed = ['read', 'glob', 'grep', ...(mode === 'workspace-write' ? ['edit'] : [])];
  return JSON.stringify({ ...config, ...(skills.length ? { skills: [...(config.skills || []), path.dirname(skills[0].directory)] } : {}),
    agents: { ...config.agents, 'teamhub-executor': {
    mode: 'primary', description: 'Agent Team Hub controlled local execution',
    permissions: [{ action: '*', resource: '*', effect: 'deny' },
      ...allowed.map(action => ({ action, resource: '*', effect: 'allow' })),
      ...skills.map(item => ({ action: 'skill', resource: item.capability_id, effect: 'allow' })),
      { action: 'external_directory', resource: '*', effect: 'deny' }],
  } } });
}

async function supervisor(id) {
  const dir = jobDir(id);
  const job = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
  let state = { dispatch_id: id, status: 'starting' };
  let child, spawned = false, stopped = false, ended = false, writing = false, size = 0, tooLarge = false;
  const chunks = [];
  const windowsJob = process.platform === 'win32';
  const stopProcess = () => {
    if (!child || windowsJob) return; // Windows 监督器自行处理取消，并核对整个 Job。
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  };
  const heartbeat = setInterval(async () => {
    if (writing || ended) return;
    writing = true;
    try {
      if (!stopped && await exists(path.join(dir, 'cancel.request'))) { stopped = true; stopProcess(); }
      await publish(id, state);
    } catch { /* 断电或权限异常时状态检查会显示未知。 */ }
    finally { writing = false; }
  }, 1000);
  const prompt = '请根据以下 Agent Team Hub 固定输入完成工作。执行结果仅作为证据，禁止自行通过业务验收。固定能力已安装在 installed_capabilities 的目录中，使用前读取其中的入口文件，不要替换为其他版本。\n' + JSON.stringify({ ...job.input_snapshot, installed_capabilities: job.installed_capabilities || [] });
  const args = harness === 'codex'
    ? [...prefix, 'exec', '--json', '--sandbox', mode, '-C', workspace, '-']
    : harness === 'opencode' ? [...prefix, 'run', '--standalone', '--format', 'json', '--agent', 'teamhub-executor', '--archived']
    : [...prefix, '-p', '--output-format', 'json', '--permission-mode', mode === 'read-only' ? 'plan' : 'acceptEdits',
      '--permission-prompts', 'none', ...(mode === 'read-only' ? ['--tools', 'Read,Grep,Glob', '--strict-mcp-config'] : [])];
  try {
    if (await exists(path.join(dir, 'cancel.request'))) { state = { dispatch_id: id, status: 'cancelled' }; return; }
    await verifyRuntimeCapabilities(workspace, id, job.capability_releases || [], job.installed_capabilities || []);
    if (harness === 'opencode') {
      if (options.opencode_config) process.env.OPENCODE_CONFIG = options.opencode_config;
      process.env.OPENCODE_CONFIG_CONTENT = openCodeConfig(job.installed_capabilities || []);
    }
    let command = binary, commandArgs = args;
    if (windowsJob) {
      const specification = path.join(dir, 'windows-job.json');
      await fs.writeFile(specification, JSON.stringify({ binary, args, cwd: workspace,
        cancel: path.join(dir, 'cancel.request'), result: path.join(dir, 'windows-job-result.json') }), { ...privateFile, flag: 'wx' });
      command = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./win-job.ps1', import.meta.url)), specification];
    }
    child = spawn(command, commandArgs, { cwd: workspace, shell: false, detached: !windowsJob, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (stopped || await exists(path.join(dir, 'cancel.request'))) { stopped = true; stopProcess(); }
    state = { dispatch_id: id, status: 'running' }; await publish(id, state);
    child.stdin.end(prompt);
    const code = await closed;
    // Windows Job 监督器可能先于心跳检查到取消并退出，不能仅依赖计时器。
    if (await exists(path.join(dir, 'cancel.request'))) stopped = true;
    const output = Buffer.concat(chunks).toString('utf8');
    let validSuccess = false, summary = '', knownFailure = '';
    if (!tooLarge && !stopped) {
      if (harness === 'claude') {
        try { const value = JSON.parse(output); validSuccess = code === 0 && value.is_error === false && typeof value.result === 'string'; summary = value.result || ''; } catch { /* 未识别结果保持未知。 */ }
      } else if (harness === 'opencode') {
        let failure = false;
        for (const line of output.split('\n')) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'error') {
              failure = true;
              knownFailure = event.error?.type === 'provider.auth' ? 'OpenCode 模型提供方认证失败，请检查宿主凭据。' : 'OpenCode 报告执行错误，请检查宿主配置。';
            }
            if (event.type === 'text' && typeof event.part?.text === 'string') summary += event.part.text;
            if (event.type === 'step_finish' && ['stop', 'end_turn'].includes(event.part?.reason)) validSuccess = true;
          } catch { /* 非协议输出不构成完成证据。 */ }
        }
        validSuccess = code === 0 && validSuccess && !failure;
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
        validSuccess = code === 0 && validSuccess && !failure;
      }
    }
    let cancelConfirmed = false;
    if (stopped && windowsJob) {
      try { cancelConfirmed = JSON.parse(await fs.readFile(path.join(dir, 'windows-job-result.json'), 'utf8')).cancel_confirmed === true; } catch { /* 没有证据时保持未知。 */ }
    }
    state = { dispatch_id: id, status: stopped ? (cancelConfirmed ? 'cancelled' : 'unknown') : tooLarge ? 'unknown' : validSuccess ? 'succeeded' : code === 0 && !knownFailure ? 'unknown' : 'failed',
      ...(validSuccess && summary ? { summary: summary.slice(0, 2000) } : knownFailure && !stopped ? { summary: knownFailure } : {}) };
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
      available: version.status === 0, capabilities: { start: true, status: true, cancel: true, recover: true, install_pinned: true } };
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
    if (!['starting', 'running', 'unknown'].includes(state.status)) return { requested: false, confirmed: state.status === 'cancelled' };
    try { await fs.writeFile(path.join(jobDir(id), 'cancel.request'), 'requested', { ...privateFile, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return { requested: true, confirmed: false };
  }
  if (method === 'execution.start') {
    if (!identifier(params.dispatch_id) || !params.input_snapshot?.title || !Array.isArray(params.capability_releases)) throw new Error('precondition');
    let allowed, requested;
    try { [allowed, requested] = await Promise.all([fs.realpath(workspace), fs.realpath(params.workspace_ref)]); }
    catch { throw new Error('precondition'); }
    if ((process.platform === 'win32' ? allowed.toLowerCase() : allowed) !== (process.platform === 'win32' ? requested.toLowerCase() : requested)) throw new Error('precondition');
    if (harness === 'opencode') {
      try { openCodeConfig(); } catch { throw new Error('precondition'); }
      if (options.opencode_config && !(await fs.stat(options.opencode_config).catch(() => null))?.isFile()) throw new Error('precondition');
      // OpenCode 将同一个 Git 工作树视为内部路径；写入模式必须从工作树根目录启动。
      if (mode === 'workspace-write') {
        const git = spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (git.status === 0) {
          let top; try { top = await fs.realpath(git.stdout.trim()); } catch { throw new Error('precondition'); }
          if ((process.platform === 'win32' ? top.toLowerCase() : top) !== (process.platform === 'win32' ? allowed.toLowerCase() : allowed)) throw new Error('precondition');
        } else if (git.status !== 128) throw new Error('precondition');
      }
    }
    try { await verifyRuntimeCapabilities(workspace, params.dispatch_id, params.capability_releases, params.installed_capabilities || []); }
    catch { throw new Error('precondition'); }
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const dir = jobDir(params.dispatch_id), fingerprint = hash(params);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
      if (previous.fingerprint !== fingerprint) throw new Error('dispatch conflict');
      return { run_id: params.dispatch_id, status: 'starting' };
    }
    await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify({ fingerprint, input_snapshot: params.input_snapshot,
      capability_releases: params.capability_releases, installed_capabilities: params.installed_capabilities || [] }), { ...privateFile, flag: 'wx' });
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
