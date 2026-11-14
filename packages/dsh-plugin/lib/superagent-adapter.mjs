import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HubError } from './client/index.mjs';

/** 基于本机 Superagent 管理 HTTP 接口的可选适配器。 */
export class DshSuperagentAdapter {
  constructor({ url, taskType = '', stateDir = '', fetchImpl = fetch, timeout = 20000 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new HubError('INVALID_SUPERAGENT_URL', 'Superagent URL must be a loopback HTTP origin.'); }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password
        || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      throw new HubError('INVALID_SUPERAGENT_URL', 'Superagent URL must be a loopback HTTP origin.');
    }
    if (typeof taskType !== 'string' || taskType.length > 64) throw new HubError('INVALID_SUPERAGENT_TYPE', 'Invalid Superagent task type.');
    this.base = parsed.origin + '/orchestrator/api'; this.taskType = taskType.trim(); this.stateDir = stateDir; this.fetch = fetchImpl; this.timeout = timeout;
  }
  async request(method, route, body) {
    let response;
    try {
      response = await this.fetch(this.base + route, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeout),
        headers: { 'X-Orchestrator-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new HubError('SUPERAGENT_UNAVAILABLE', 'Cannot reach the local Superagent management API.'); }
    if (!response.ok) throw new HubError('SUPERAGENT_API_ERROR', `Superagent management API returned HTTP ${response.status}.`);
    try { return await response.json(); } catch { throw new HubError('SUPERAGENT_API_ERROR', 'Superagent returned invalid JSON.'); }
  }
  async probe() {
    try {
      const state = await this.request('GET', '/state');
      const ready = state?.health?.runtime?.state === 'ready' && !state?.setup?.problem;
      return { available: ready, protocol_version: 1, kind: 'executor', version: 'management-api',
        canCancel: true, canRecover: Boolean(this.stateDir), paused: state?.paused === true,
        ...(!ready ? { reason: 'Superagent runtime is not ready.' } : {}) };
    } catch { return { available: false, reason: 'Local Superagent management API is unavailable.' }; }
  }
  async sameDirectory(left, right) {
    if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
  lookupFile(dispatchId) {
    if (!this.stateDir || !/^[a-zA-Z0-9_-]{1,180}$/.test(dispatchId || '')) return null;
    return path.join(this.stateDir, 'superagent-lookup', `${dispatchId}.json`);
  }
  async rememberLookup(dispatchId, title, request, workspace) {
    const file = this.lookupFile(dispatchId);
    if (!file) return;
    // 与已核验的 Superagent operator-task 触发器键一致；未匹配时只保持未知，不重新建单。
    const trigger = createHash('sha256').update(JSON.stringify(['operator-task', dispatchId, title, request, '', this.taskType, 'kanban-task'])).digest('hex').slice(0, 32);
    const record = { base: this.base, task_type: this.taskType, trigger_id: trigger, workspace_ref: workspace };
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(file, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new HubError('DISPATCH_CONFLICT', '已有派发记录与当前请求不一致。');
    }
  }
  async findByDispatchId(dispatchId) {
    const file = this.lookupFile(dispatchId);
    if (!file) return null;
    let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (record.base !== this.base || record.task_type !== this.taskType || !/^[a-f0-9]{32}$/.test(record.trigger_id || '')) return null;
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.request('GET', `/decisions?kind=accept&offset=${offset}&limit=100`);
      if (!Array.isArray(data?.items)) throw new HubError('SUPERAGENT_API_ERROR', 'Superagent 决策列表无效。');
      const matches = data.items.filter(value => Array.isArray(value.triggerIds) && value.triggerIds.includes(record.trigger_id));
      if (matches.length > 1) throw new HubError('DISPATCH_CONFLICT', '派发对应多个决策，需要人工核对。');
      if (matches.length === 1) {
        const ticketId = matches[0].ticketId;
        if (typeof ticketId !== 'string' || !ticketId) return null;
        const ticket = await this.request('GET', `/tickets/${encodeURIComponent(ticketId)}`);
        if (!ticket?.directory || !(await this.sameDirectory(ticket.directory, record.workspace_ref))) {
          throw new HubError('SUPERAGENT_WORKSPACE_UNCERTAIN', '已找到工单，但无法确认其工作目录。');
        }
        return { run_id: ticketId, ...(ticket.sessionId ? { session_id: ticket.sessionId } : {}) };
      }
      if (data.next_offset == null) return null;
      if (!Number.isSafeInteger(data.next_offset) || data.next_offset <= offset) throw new HubError('SUPERAGENT_API_ERROR', 'Superagent 分页游标无效。');
      offset = data.next_offset;
    }
    return null;
  }
  async start(input) {
    const reject = message => { throw new HubError('ADAPTER_PRECONDITION_FAILED', message); };
    if (!input?.input_snapshot?.title || !input.dispatch_id || !input.workspace_ref) reject('Missing the frozen task snapshot, dispatch ID or workspace.');
    if (!Array.isArray(input.capability_releases) || input.capability_releases.length) {
      reject('Superagent management API cannot guarantee installation of the pinned capability versions.');
    }
    let settings, directory;
    try {
      settings = await this.request('GET', '/settings');
      const executor = settings?.blocks?.executor?.value;
      const type = this.taskType ? executor?.taskTypes?.find(value => value.id === this.taskType) : null;
      if (!executor || (this.taskType && !type)) reject('The configured Superagent task type does not exist.');
      const mode = type ? type.directoryMode : executor.directoryMode;
      directory = type ? type.directory : settings?.environment?.root;
      if (mode !== 'fixed' || typeof directory !== 'string' || !(await this.sameDirectory(directory, input.workspace_ref))) {
        reject('Superagent must use a fixed task directory matching the requested workspace.');
      }
    } catch (error) {
      if (error.code === 'ADAPTER_PRECONDITION_FAILED') throw error;
      reject('Cannot verify the Superagent task type and fixed workspace before launch.');
    }
    const snapshot = { ...input.input_snapshot, spec_revision: input.spec_revision,
      assignment_generation: input.assignment_generation, capability_releases: input.capability_releases };
    const request = '按以下 Agent Team Hub 固定快照执行。执行结果不代表业务验收；不要自行改变验收状态。\n' + JSON.stringify(snapshot);
    if (request.length > 20000) reject('The frozen task snapshot exceeds the Superagent request limit.');
    const title = Array.from(String(input.input_snapshot.title)).slice(0, 100).join('');
    await this.rememberLookup(input.dispatch_id, title, request, input.workspace_ref);
    const created = await this.request('POST', '/tasks', { title, request, requestId: input.dispatch_id,
      ...(this.taskType ? { taskType: this.taskType } : {}) });
    if (typeof created?.ticketId !== 'string' || !created.ticketId) throw new HubError('INVALID_ADAPTER_RESULT', 'Superagent did not return a stable ticket ID.');
    let matchesWorkspace = false;
    try { matchesWorkspace = Boolean(created.ticket?.directory) && await this.sameDirectory(created.ticket.directory, input.workspace_ref); }
    catch { /* 无法读取路径时也必须尝试停止。 */ }
    if (!matchesWorkspace) {
      try { await this.request('POST', `/tickets/${encodeURIComponent(created.ticketId)}/stop`); } catch { /* 保持未知并要求核实。 */ }
      throw new HubError('SUPERAGENT_WORKSPACE_UNCERTAIN', 'The created ticket workspace could not be confirmed; reconcile the existing ticket.');
    }
    const initial = created.ticket?.stage === 'working' && created.ticket?.action === 'queued' ? 'queued'
      : created.ticket?.stage === 'working' ? 'running' : 'starting';
    return { run_id: created.ticketId, ...(created.ticket?.sessionId ? { session_id: created.ticket.sessionId } : {}), status: initial };
  }
  async getStatus(handle) {
    if (!handle?.run_id) throw new HubError('INVALID_ADAPTER_RESULT', 'A Superagent ticket ID is required.');
    const ticket = await this.request('GET', `/tickets/${encodeURIComponent(handle.run_id)}`);
    let status = 'unknown';
    if (ticket?.stage === 'working') status = ticket.action === 'queued' ? 'queued' : 'running';
    else if (ticket?.stage === 'person' || ticket?.stage === 'idle') status = 'waiting_input';
    else if (ticket?.stage === 'ended' && ticket.ended?.by === 'executor' && ['completed', 'merged'].includes(ticket.ended?.outcome)) status = 'succeeded';
    return { status, ...(typeof ticket?.summary === 'string' ? { summary: ticket.summary } : {}) };
  }
  async cancel(handle) {
    if (!handle?.run_id) throw new HubError('INVALID_ADAPTER_RESULT', 'A Superagent ticket ID is required.');
    const result = await this.request('POST', `/tickets/${encodeURIComponent(handle.run_id)}/stop`);
    if (result?.stopped !== true) throw new HubError('INVALID_ADAPTER_RESULT', 'Superagent did not acknowledge the stop request.');
    // 该接口只确认工单停止请求，后台执行资源可能仍在退出。
    return { requested: true, confirmed: false };
  }
}
