export const name = 'team-hub-web';
export const inject = ['webServer', 'connection'];

/** 配置中的地址只用于定位页面和健康检查，绝不接受 URL 内的凭据。 */
export function hubBaseUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('invalid Hub URL');
  }
  return parsed.toString().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/** 使用 DSH 连接鉴权；健康检查不使用也不返回 Hub 访问令牌。 */
export function createStatusHandler({ connection, serverUrl, webUrl, fetchImpl = fetch, timeoutMs = 4000 }) {
  return async (req, res) => {
    const rejection = connection.requestRejection(req);
    if (rejection !== undefined) return reply(res, rejection, { error: '请先登录 DSH。' });
    const requestUrl = new URL(req.url || '/', 'http://dsh.invalid');
    if (requestUrl.pathname !== '/team-hub-web/status') return reply(res, 404, { error: '页面接口不存在。' });
    if (req.method !== 'GET') return reply(res, 405, { error: '请求方法不支持。' });

    let apiBase, pageBase;
    try {
      apiBase = hubBaseUrl(serverUrl);
      pageBase = hubBaseUrl(webUrl || serverUrl);
    } catch {
      return reply(res, 200, { available: false, reason: 'invalid_url' });
    }
    try {
      const response = await fetchImpl(`${apiBase}/api/v1/health`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok || (await response.json())?.status !== 'ok') throw new Error('invalid health response');
    } catch {
      return reply(res, 200, { available: false, reason: 'unreachable' });
    }
    return reply(res, 200, { available: true, url: `${pageBase}/` });
  };
}

export function apply(ctx, config = {}) {
  const serverUrl = config.serverUrl || process.env.TEAMHUB_URL || 'http://127.0.0.1:8765';
  const webUrl = config.webUrl || process.env.TEAMHUB_WEB_URL || serverUrl;
  const handler = createStatusHandler({ connection: ctx.connection, serverUrl, webUrl });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/team-hub-web', handler }),
    'team-hub-web: page status');
}
