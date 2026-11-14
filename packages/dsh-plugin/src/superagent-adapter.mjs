import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HubError } from './client/index.mjs';

/** 基于本机 Superagent 管理 HTTP 接口的可选适配器。 */
export class DshSuperagentAdapter {
  constructor({ url, taskType = '', fetchImpl = fetch, timeout = 20000 } = {}) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new HubError('INVALID_SUPERAGENT_URL', 'Superagent URL must be a loopback HTTP origin.'); }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password
        || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      throw new HubError('INVALID_SUPERAGENT_URL', 'Superagent URL must be a loopback HTTP origin.');
    }
    if (typeof taskType !== 'string' || taskType.length > 64) throw new HubError('INVALID_SUPERAGENT_TYPE', 'Invalid Superagent task type.');
    this.base = parsed.origin + '/orchestrator/api'; this.taskType = taskType.trim(); this.fetch = fetchImpl; this.timeout = timeout;
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
        canCancel: true, canRecover: false, paused: state?.paused === true,
        ...(!ready ? { reason: 'Superagent runtime is not ready.' } : {}) };
    } catch { return { available: false, reason: 'Local Superagent management API is unavailable.' }; }
  }
  async sameDirectory(left, right) {
    if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
