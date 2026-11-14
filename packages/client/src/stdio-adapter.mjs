import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HubError } from './index.mjs';

const PROTOCOL = 'agent-team-hub-adapter';
const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const BASE_ENV = new Set(['path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec', 'pathext', 'tmp', 'temp', 'lang', 'lc_all']);

function invalid(message) { throw new HubError('INVALID_ADAPTER_CONFIG', message); }

/** 只加载调用方明确选择的本机配置；配置本身不会启动程序。 */
export function registerStdioAdapters(filename, registry) {
  const absolute = path.resolve(filename);
  let raw, config;
  try { raw = readFileSync(absolute); } catch { return invalid('Cannot read the local adapter configuration.'); }
  if (raw.length > 65536) return invalid('Adapter configuration exceeds 64 KiB.');
  try { config = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { return invalid('Adapter configuration must be valid JSON.'); }
  if (!config || config.schema_version !== 1 || !Array.isArray(config.adapters) || config.adapters.length > 32) {
    return invalid('Expected adapter configuration schema_version 1 and at most 32 adapters.');
  }
  const registered = [];
  try {
    for (const entry of config.adapters) {
      if (!entry || !NAME.test(entry.name ?? '') || !['board', 'executor'].includes(entry.kind)
          || typeof entry.command !== 'string' || !entry.command.trim() || entry.command.includes('\0')
          || !Array.isArray(entry.args) || entry.args.length > 64
          || entry.args.some(value => typeof value !== 'string' || value.includes('\0'))
          || (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !entry.cwd.trim()))
          || (entry.env !== undefined && (!Array.isArray(entry.env) || entry.env.length > 64
            || entry.env.some(name => typeof name !== 'string' || !ENV_NAME.test(name) || /^TEAMHUB_/i.test(name))))
          || (entry.timeout_ms !== undefined && (!Number.isInteger(entry.timeout_ms) || entry.timeout_ms < 100 || entry.timeout_ms > 120000))) {
        return invalid('Invalid adapter name, kind, executable, arguments, environment or timeout.');
      }
      const options = { ...entry, cwd: entry.cwd ? path.resolve(path.dirname(absolute), entry.cwd) : path.dirname(absolute) };
      const adapter = entry.kind === 'board' ? new StdioBoardAdapter(options) : new StdioExecutionAdapter(options);
      registered.push(entry.kind === 'board' ? registry.registerBoard(entry.name, adapter) : registry.registerExecutor(entry.name, adapter));
    }
  } catch (error) { registered.reverse().forEach(dispose => dispose()); throw error; }
  return () => registered.reverse().forEach(dispose => dispose());
}

class StdioAdapter {
  constructor(options) { this.options = options; this.description = null; }
  environment() {
    const requested = new Set((this.options.env || []).map(value => value.toLowerCase()));
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if ((BASE_ENV.has(key.toLowerCase()) || requested.has(key.toLowerCase())) && !/^TEAMHUB_/i.test(key)) env[key] = value;
    }
    return env;
  }
  async call(method, params = {}) {
    const id = randomUUID();
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(request) > MAX_BYTES) throw new HubError('ADAPTER_REQUEST_TOO_LARGE', 'Adapter request exceeds 2 MiB.');
    return await new Promise((resolve, reject) => {
      let child, timer, settled = false, size = 0;
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      try {
        child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.environment(),
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { finish(new HubError('ADAPTER_PROCESS_ERROR', 'Could not start the configured adapter process.')); return; }
      timer = setTimeout(() => {
        child.kill(); finish(new HubError('ADAPTER_TIMEOUT', 'Adapter process did not respond within its timeout.'));
      }, this.options.timeout_ms ?? 20000);
      child.once('error', () => finish(new HubError('ADAPTER_PROCESS_ERROR', 'Could not start the configured adapter process.')));
      child.stdin.on('error', () => {});
      child.stderr.resume(); // 适配器 stderr 可能包含本机信息，不写入共享结果。
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { child.kill(); finish(new HubError('ADAPTER_RESPONSE_TOO_LARGE', 'Adapter response exceeds 2 MiB.')); }
        else chunks.push(chunk);
      });
      child.once('close', code => {
        if (settled) return;
        if (code !== 0) { finish(new HubError('ADAPTER_PROCESS_ERROR', 'Adapter process exited unsuccessfully.')); return; }
        let response;
        try { response = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()); }
        catch { finish(new HubError('INVALID_ADAPTER_RESULT', 'Adapter did not return one JSON-RPC response.')); return; }
        if (!response || response.jsonrpc !== '2.0' || response.id !== id
            || (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))) {
          finish(new HubError('INVALID_ADAPTER_RESULT', 'Adapter response envelope does not match the request.')); return;
        }
        if (Object.hasOwn(response, 'error')) {
          finish(new HubError('ADAPTER_REMOTE_ERROR', 'Adapter reported an error.')); return;
        }
        finish(null, response.result);
      });
      child.stdin.end(request);
    });
  }
  async probe() {
    const value = await this.call('adapter.describe');
    if (!value || value.protocol !== PROTOCOL || value.protocol_version !== 1 || value.name !== this.options.name
        || value.kind !== this.options.kind || typeof value.version !== 'string' || !value.version.trim()
        || typeof value.available !== 'boolean' || !value.capabilities || typeof value.capabilities !== 'object'
        || Array.isArray(value.capabilities)) {
      throw new HubError('UNSUPPORTED_ADAPTER_VERSION', 'Adapter description does not match protocol version 1 or its local configuration.');
    }
    const required = this.options.kind === 'board' ? ['item_link', 'pipeline_sync', 'detach_pipeline'] : ['start', 'status', 'cancel', 'recover'];
    if (required.some(key => typeof value.capabilities[key] !== 'boolean')) {
      throw new HubError('INVALID_ADAPTER_RESULT', 'Adapter description must declare all capability flags.');
    }
    if (this.options.kind === 'executor' && value.available && (!value.capabilities.start || !value.capabilities.status)) {
      throw new HubError('INVALID_ADAPTER_RESULT', 'An available executor must support start and status.');
    }
    this.description = value;
    const c = value.capabilities;
    return { available: value.available, protocol_version: 1, kind: value.kind, version: value.version,
      ...(value.available ? {} : { reason: 'Adapter reported unavailable.' }),
      ...(value.kind === 'board' ? { canLinkItem: c.item_link, canSync: c.pipeline_sync, canDetach: c.detach_pipeline }
        : { canCancel: c.cancel, canRecover: c.recover }) };
  }
  supports(name) { return this.description?.available === true && this.description.capabilities[name] === true; }
}

export class StdioBoardAdapter extends StdioAdapter {
  async ensureLinkedCard({ external_ref, item, workspace_ref, snapshot, draftId } = {}) {
    if (!this.supports(snapshot ? 'pipeline_sync' : 'item_link')) throw new HubError('BOARD_OPERATION_UNSUPPORTED', 'This board operation is not supported.');
    const result = await this.call('board.upsert', { external_ref, item, workspace_ref,
      ...(snapshot ? { snapshot } : {}), ...(draftId ? { preferred_local_todo_id: draftId } : {}) });
    if (!result || typeof result.local_todo_id !== 'string' || !result.local_todo_id.trim()) {
      throw new HubError('INVALID_ADAPTER_RESULT', 'Board adapter must return a stable local_todo_id.');
    }
    return result;
  }
  async detachPipeline({ pipelineId, hubBase }) {
    if (!this.supports('detach_pipeline')) throw new HubError('BOARD_DETACH_UNSUPPORTED', 'This board cannot detach pipeline links.');
    const result = await this.call('board.detach_pipeline', { pipeline_id: pipelineId, hub_base: hubBase });
    if (!Number.isSafeInteger(result?.detached) || result.detached < 0) throw new HubError('INVALID_ADAPTER_RESULT', 'Board adapter returned an invalid detached count.');
    return result;
  }
}

export class StdioExecutionAdapter extends StdioAdapter {
  async start(input) { return this.call('execution.start', input); }
  async getStatus(handle) { return this.call('execution.status', { handle }); }
  async cancel(handle) {
    if (!this.supports('cancel')) throw new HubError('CANCEL_UNSUPPORTED', 'This executor cannot request cancellation.');
    const result = await this.call('execution.cancel', { handle });
    if (typeof result?.requested !== 'boolean' || typeof result?.confirmed !== 'boolean') throw new HubError('INVALID_ADAPTER_RESULT', 'Executor must report requested and confirmed separately.');
    return result;
  }
  async findByDispatchId(dispatchId) {
    if (!this.supports('recover')) return null;
    return this.call('execution.find', { dispatch_id: dispatchId });
  }
}
