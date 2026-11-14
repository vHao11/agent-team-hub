import { randomUUID } from 'node:crypto';

export class HubError extends Error {
  constructor(code, message, { status = 0, details, operationId } = {}) {
    super(message); this.name = 'HubError'; this.code = code;
    this.status = status; this.details = details; this.operationId = operationId;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.operationId ? { operation_id: this.operationId } : {}) } };
  }
}

export function operationId() { return randomUUID(); }
export function segment(value) { return encodeURIComponent(String(value)); }

export class HubClient {
  constructor({ url = 'http://127.0.0.1:8765', token, fetchImpl = fetch, timeout = 20000 } = {}) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new HubError('INVALID_URL', 'Hub URL must be an HTTP(S) origin or API base without credentials, query or fragment.');
    }
    this.base = parsed.toString().replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
    this.token = token; this.fetch = fetchImpl; this.timeout = timeout;
  }
  async request(method, path, data, { query, signal, form } = {}) {
    if (!this.token) throw new HubError('TOKEN_REQUIRED', 'Set TEAMHUB_TOKEN to your personal access token.');
    if (!path.startsWith('/') || path.startsWith('//')) throw new HubError('INVALID_PATH', 'Use an API-relative path.');
    const target = new URL(this.base + path);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.fetch(target, { method, headers, body: form ?? (data === undefined ? undefined : JSON.stringify(data)),
        redirect: 'error', signal: signal ?? AbortSignal.timeout(this.timeout) });
    } catch (error) {
      throw new HubError('NETWORK_ERROR', `Cannot reach Agent Team Hub (${error.name || 'network failure'}). Retry with the same operation_id after checking the request outcome.`, { operationId: data?.operation_id });
    }
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; }
    catch { throw new HubError('INVALID_RESPONSE', 'Hub returned a non-JSON response.', { status: response.status, operationId: data?.operation_id }); }
    if (!response.ok) {
      const error = result?.error ?? {};
      throw new HubError(error.code || `HTTP_${response.status}`, error.message || `Hub request failed (${response.status}).`,
        { status: response.status, details: error.details ?? result?.detail, operationId: data?.operation_id });
    }
    return result;
  }
  bootstrap() { return this.request('GET', '/bootstrap'); }
  integrationContract() { return this.request('GET', '/integration/contract'); }
  listItems(query = {}) { return this.request('GET', '/work-items', undefined, { query }); }
  getItem(id) { return this.request('GET', `/work-items/${segment(id)}`); }
  getPipeline(id) { return this.request('GET', `/pipelines/${segment(id)}`); }
  listPipelines() { return this.request('GET', '/pipelines'); }
  rollbackPipeline(id, step, data) { return this.request('POST', `/pipelines/${segment(id)}/steps/${segment(step)}/rollback`, { operation_id: operationId(), ...data }); }
  createItem(data) { return this.request('POST', '/work-items', { operation_id: operationId(), ...data }); }
  command(id, action, data) {
    const allowed = ['accept', 'decline', 'start', 'cancel', 'transfer-requests', 'accept-transfer', 'progress', 'spec', 'dependencies'];
    if (!allowed.includes(action)) throw new HubError('UNKNOWN_COMMAND', `Unsupported item command: ${action}`);
    return this.request('POST', `/work-items/${segment(id)}/${action}`, { operation_id: operationId(), ...data });
  }
  submitDelivery(id, data) { return this.request('POST', `/work-items/${segment(id)}/deliveries`, { operation_id: operationId(), ...data }); }
  reviewDelivery(id, data) { return this.request('POST', `/deliveries/${segment(id)}/reviews`, { operation_id: operationId(), ...data }); }
  uploadArtifact(blob, name = 'attachment') {
    const form = new FormData(); form.append('file', blob, name);
    return this.request('POST', '/artifacts', undefined, { form });
  }
  bindItem(id, data) { return this.request('POST', `/work-items/${segment(id)}/bindings`, { operation_id: operationId(), ...data }); }
  createRun(id, data) { return this.request('POST', `/work-items/${segment(id)}/runs`, { operation_id: operationId(), ...data }); }
  getRun(id) { return this.request('GET', `/runs/${segment(id)}`); }
  reportRun(id, data) { return this.request('POST', `/runs/${segment(id)}/events`, { operation_id: operationId(), ...data }); }
  cancelRun(id, data = {}) { return this.request('POST', `/runs/${segment(id)}/cancel`, { operation_id: operationId(), ...data }); }
  events(after = 0, limit = 100) { return this.request('GET', '/events', undefined, { query: { after, limit } }); }
  listCapabilities(query = {}) { return this.request('GET', '/capabilities', undefined, { query }); }
  getCapability(id) { return this.request('GET', `/capabilities/${segment(id)}`); }
  getRelease(id, version) { return this.request('GET', `/capabilities/${segment(id)}/releases/${segment(version)}`); }
  createCapability(data) { return this.request('POST', '/capabilities', { operation_id: operationId(), ...data }); }
  publishRelease(id, data) { return this.request('POST', `/capabilities/${segment(id)}/releases`, { operation_id: operationId(), ...data }); }
  getToolset(id) { return this.request('GET', `/team-toolsets/${segment(id)}`); }
  setToolset(id, data) { return this.request('PUT', `/team-toolsets/${segment(id)}`, { operation_id: operationId(), ...data }); }
}
