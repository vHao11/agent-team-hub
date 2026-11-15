const API_BASE = '/api/v1';
const TOKEN_KEY = 'teamhub.session.v1';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY) || '';
export const setToken = (token: string) => token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY);
export function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('当前浏览器不支持安全随机数，无法执行写入操作。');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}
export class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, message: string, code = 'request_failed', details?: unknown) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details;
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return `操作发生冲突，请查看最新内容后重试。${error.message}`;
  if (error instanceof ApiError && error.status === 401) return '登录凭证无效或已失效，请在连接设置中重新登录。';
  if (error instanceof ApiError && error.status === 403) return `当前身份没有执行此操作的权限。${error.message}`;
  return error instanceof Error ? error.message : '请求未完成，请稍后重试。';
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (getToken()) headers.set('Authorization', `Bearer ${getToken()}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(`${API_BASE}${path}`, { ...options, headers }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ApiError(0, '无法连接 Team Hub 服务，请确认后端服务正在运行。', 'network_error'); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.message || body?.detail || `请求失败（${response.status}）`, body?.error?.code, body?.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
const pendingMutations = new Map<string, string>();
export async function write<T>(path: string, body: Record<string, unknown>, method = 'POST') {
  const fingerprint = `${getToken()}:${method}:${path}:${JSON.stringify(body)}`;
  const id = pendingMutations.get(fingerprint) || operationId();
  pendingMutations.set(fingerprint, id);
  try {
    const value = await api<T>(path, { method, body: JSON.stringify({ operation_id: id, ...body }) });
    pendingMutations.delete(fingerprint);
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.status > 0 && error.status < 500) pendingMutations.delete(fingerprint);
    throw error;
  }
}
export async function downloadArtifact(url: string, label: string) {
  if (!url.startsWith('artifact://')) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('交付物链接仅支持 HTTP、HTTPS 或已上传附件。');
    window.open(parsed.href, '_blank', 'noopener,noreferrer'); return;
  }
  const response = await fetch(`${API_BASE}/artifacts/${encodeURIComponent(url.slice(11))}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!response.ok) throw new ApiError(response.status, '附件下载失败。');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = label; anchor.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}
