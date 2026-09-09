// No sockets, external network, real key, or model call: Node streams + a manual clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { localRelationshipApi } from '../server/local-preview.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  status = 0;
  body = '';
  headers = {};
  writes = 0;
  endings = 0;
  writeHead(status, headers) { assert.equal(this.headersSent, false); this.status = status; this.headers = headers; this.headersSent = true; this.writes++; }
  end(body = '', callback) { assert.equal(this.writableEnded, false); this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body); this.writableEnded = true; this.endings++; this.emit('finish'); callback?.(); this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
function harness(handle, { route = 'direct', timeoutMs = 7 } = {}) {
  let middleware, scheduled, transportClosed = 0, forwarded = 0;
  const httpServer = new EventEmitter();
  const plugin = localRelationshipApi({
    timeoutMs,
    handle,
    createTransport: () => ({ route, outbound: async () => assert.fail('No outbound call is permitted'), close: async () => { transportClosed++; } }),
    scheduleTimeout: (callback, milliseconds) => { assert.equal(scheduled, undefined); scheduled = { callback, milliseconds, cancelled: false }; return () => { scheduled.cancelled = true; }; },
  });
  plugin.configureServer({ config: { server: { port: 5173 } }, httpServer, middlewares: { use(fn) { middleware = fn; } } });
  const start = ({ url = '/api/relationships/discover', method = 'POST', headers = {}, body = '{}', incomplete = false, remote = '127.0.0.1' } = {}) => {
    const req = new PassThrough();
    req.url = url; req.method = method; req.complete = false; req.socket = { remoteAddress: remote };
    req.headers = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', 'x-dealgraph-client': 'byok-v1', ...headers };
    req.on('end', () => { req.complete = true; });
    const res = new FakeResponse();
    const done = middleware(req, res, () => { forwarded++; });
    if (incomplete) req.write(body); else req.end(body);
    return { req, res, done };
  };
  return {
    start,
    fire: () => { assert.ok(scheduled && !scheduled.cancelled); scheduled.callback(); },
    scheduled: () => scheduled,
    forwarded: () => forwarded,
    close: async () => { httpServer.emit('close'); await tick(); return transportClosed; },
  };
}

test('successful response ends once and cancels the local timer', async () => {
  let captured;
  const h = harness(async request => { captured = request; return Response.json({ ok: true }); });
  const { res, done } = h.start(); await done;
  assert.equal(captured.url, 'https://dealgraph.example.com/api/relationships/discover');
  assert.equal(captured.headers.get('authorization'), null);
  assert.equal(await captured.text(), '{}');
  assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.endings, 1); assert.equal(h.scheduled().cancelled, true);
  assert.equal(await h.close(), 1);
});

test('timeout sends 504 and settles middleware even when the handler ignores abort forever', async () => {
  let signal;
  const h = harness(async request => { signal = request.signal; return new Promise(() => {}); });
  const { res, done } = h.start(); await tick(); h.fire(); await done;
  assert.equal(signal.aborted, true);
  assert.equal(res.status, 504); assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error.code, 'ANALYSIS_TIMEOUT');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.writes, 1); assert.equal(res.endings, 1);
  assert.equal(h.scheduled().cancelled, true);
});

test('a late ignored-abort success cannot overwrite or append to the timeout error', async () => {
  const late = deferred();
  const h = harness(async () => late.promise);
  const { res, done } = h.start(); await tick(); h.fire(); await done;
  const timeoutBody = res.body;
  late.resolve(Response.json({ result: 'SYNTHETIC_LATE_RESULT_MUST_NOT_APPEAR' })); await tick();
  assert.equal(res.status, 504); assert.equal(res.body, timeoutBody);
  assert.equal(res.writes, 1); assert.equal(res.endings, 1);
  assert.ok(!res.body.includes('SYNTHETIC_LATE_RESULT'));
});

test('a late handler rejection is consumed without a second write', async () => {
  const late = deferred();
  const h = harness(async () => late.promise);
  const { res, done } = h.start(); await tick(); h.fire(); await done;
  late.reject(new Error('SYNTHETIC_INTERNAL_DETAILS')); await tick();
  assert.equal(res.endings, 1); assert.ok(!res.body.includes('INTERNAL_DETAILS'));
});

test('an unfinished upload times out before the handler and flushes an error before destroying the request', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return Response.json({ ok: true }); });
  const { req, res, done } = h.start({ incomplete: true, body: '{"unfinished":' });
  let destroyedAfterFlush = false;
  const destroy = req.destroy.bind(req);
  req.destroy = (...args) => { destroyedAfterFlush = res.writableEnded && res.status === 504; return destroy(...args); };
  await tick(); h.fire(); await done;
  assert.equal(calls, 0); assert.equal(destroyedAfterFlush, true); assert.equal(req.destroyed, true);
  assert.equal(res.status, 504); assert.equal(JSON.parse(res.body).error.code, 'ANALYSIS_TIMEOUT');
  assert.equal(h.scheduled().cancelled, true);
});

test('client disconnect cancels work without trying to write to the closed response', async () => {
  let signal;
  const h = harness(async request => { signal = request.signal; return new Promise(() => {}); });
  const { res, done } = h.start(); await tick(); res.destroy(); await done;
  assert.equal(signal.aborted, true); assert.equal(res.endings, 0); assert.equal(res.writes, 0);
  assert.equal(h.scheduled().cancelled, true);
});

test('aborted incoming requests also cancel work without a fabricated timeout response', async () => {
  let signal;
  const h = harness(async request => { signal = request.signal; return new Promise(() => {}); });
  const { req, res, done } = h.start(); await tick(); req.emit('aborted'); await done;
  assert.equal(signal.aborted, true); assert.equal(res.writes, 0); assert.equal(res.endings, 0);
});

test('timeout during response-body reading does not commit success headers', async () => {
  let body;
  const stream = new ReadableStream({ start(controller) { body = controller; } });
  const h = harness(async () => new Response(stream));
  const { res, done } = h.start(); await tick(); h.fire(); await done;
  assert.equal(res.status, 504); assert.equal(res.endings, 1);
  body.enqueue(new TextEncoder().encode('{"late":true}')); body.close(); await tick();
  assert.equal(res.status, 504); assert.equal(res.endings, 1); assert.ok(!res.body.includes('late'));
});

test('worker staged errors survive the bridge unchanged', async () => {
  const h = harness(async () => Response.json({ error: { code: 'DISCOVERY_VALIDATION_FAILED', message: '模型已返回，但名单未更新。' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } }));
  const { res, done } = h.start(); await done;
  assert.equal(res.status, 502); assert.equal(JSON.parse(res.body).error.code, 'DISCOVERY_VALIDATION_FAILED');
  assert.equal(h.scheduled().cancelled, true);
});

test('successful diagnosis keeps the explicitly configured local transport route', async () => {
  const h = harness(async () => Response.json({ reachable: true, route: 'direct', code: 'NETWORK_OK' }), { route: 'system-proxy' });
  const { res, done } = h.start({ url: '/api/relationships/diagnose' }); await done;
  assert.equal(res.status, 200); assert.equal(JSON.parse(res.body).route, 'system-proxy');
});

test('source checks still reject non-loopback, wrong-host, forwarded and cross-origin requests', async () => {
  for (const patch of [
    { remote: '192.0.2.10' }, { headers: { host: 'evil.test:5173' } },
    { headers: { origin: 'https://evil.test' } }, { headers: { forwarded: 'for=127.0.0.1' } },
    { headers: { 'x-forwarded-host': '127.0.0.1:5173' } }, { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) {
    const h = harness(async () => assert.fail('Rejected source must not reach the handler'));
    const { req, res, done } = h.start(patch); await done;
    assert.equal(res.status, 403); assert.equal(JSON.parse(res.body).error.code, 'ACCESS_DENIED');
    assert.equal(h.scheduled(), undefined); req.destroy();
  }
});

test('non-API paths pass through and timeout injection is bounded', async () => {
  const h = harness(async () => assert.fail('Static content must not reach the API handler'));
  const { req, done } = h.start({ url: '/', method: 'GET' }); await done;
  assert.equal(h.forwarded(), 1); assert.equal(h.scheduled(), undefined); req.destroy();
  for (const timeoutMs of [0, -1, 300001, Infinity, NaN, 1.5]) assert.throws(() => localRelationshipApi({ timeoutMs }));
});
