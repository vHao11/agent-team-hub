import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { apply, createStatusHandler, hubBaseUrl } from '../src/index.mjs';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('地址仅支持无凭据的 HTTP(S) Hub 地址', () => {
  assert.equal(hubBaseUrl('http://127.0.0.1:8765/api/v1/'), 'http://127.0.0.1:8765');
  assert.equal(hubBaseUrl('https://hub.example/base/'), 'https://hub.example/base');
  for (const url of ['file:///tmp/a', 'https://user:secret@hub.example/', 'https://hub.example/?token=secret', 'https://hub.example/#secret']) {
    assert.throws(() => hubBaseUrl(url));
  }
});

test('状态接口遵循 DSH 鉴权，只返回页面地址和健康状态', async t => {
  let healthCalls = 0;
  const hub = await serve((_req, res) => {
    healthCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  t.after(() => hub.server.close());
  const connection = { requestRejection: req => req.headers.cookie === 'session=valid' ? undefined : 401 };
  const panel = await serve(createStatusHandler({ connection, serverUrl: `${hub.url}/api/v1`, webUrl: 'https://hub.example/' }));
  t.after(() => panel.server.close());

  let response = await fetch(`${panel.url}/team-hub-web/status`);
  assert.equal(response.status, 401);
  assert.equal(healthCalls, 0);
  response = await fetch(`${panel.url}/team-hub-web/status`, { headers: { Cookie: 'session=valid' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { available: true, url: 'https://hub.example/' });
  assert.equal(healthCalls, 1);
  response = await fetch(`${panel.url}/team-hub-web/status`, { method: 'POST', headers: { Cookie: 'session=valid' } });
  assert.equal(response.status, 405);
  assert.equal(healthCalls, 1);
});

test('错误配置和服务不可用不会泄露地址或访问令牌', async t => {
  const connection = { requestRejection: () => undefined };
  for (const [serverUrl, webUrl, reason] of [
    ['http://user:secret@example.test', '', 'invalid_url'],
    ['http://127.0.0.1:1', 'http://user:secret@example.test', 'invalid_url'],
    ['http://127.0.0.1:1', '', 'unreachable'],
  ]) {
    const panel = await serve(createStatusHandler({ connection, serverUrl, webUrl, timeoutMs: 500 }));
    t.after(() => panel.server.close());
    const response = await fetch(`${panel.url}/team-hub-web/status`);
    assert.deepEqual(await response.json(), { available: false, reason });
  }
});

test('宿主路由随插件生命周期注册与注销', () => {
  const routes = [], disposers = [];
  apply({ connection: { requestRejection: () => undefined }, webServer: { register(route) {
    routes.push(route);
    return () => routes.splice(routes.indexOf(route), 1);
  } }, effect(callback) { disposers.push(callback()); } }, { serverUrl: 'http://127.0.0.1:8765' });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/team-hub-web');
  disposers.forEach(dispose => dispose());
  assert.equal(routes.length, 0);
});

test('客户端注册匹配的 DSH 侧栏入口和主面板', async () => {
  const script = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  let module;
  vm.runInNewContext(script, { window: { __ModuleLoader__: { load: descriptor => { module = descriptor.factory(() => ({})); } } } });
  const entries = [];
  module.apply({ slots: { inject(_name, callback) { callback(); }, register(meta, component) { entries.push({ meta, component }); } } });
  assert.equal(entries[0].meta.key, 'team-hub-web');
  assert.equal(entries[1].meta.id, 'team-hub-web');
  assert.equal(entries[1].meta.label(), '团队协作台');
  assert.equal(typeof entries[0].component, 'function');
});
