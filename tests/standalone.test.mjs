import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../server/worker.ts';

const origin = 'https://customer.example.org';
const noNetwork = async () => assert.fail('Static requests must not reach an external service');
for (const invalid of [undefined, '', 'http://customer.example.org', origin + '/', origin + '/app', origin + '?x=1', origin + '#x', 'https://user:pass@customer.example.org']) {
  test(`invalid APP_ORIGIN fails closed: ${invalid}`, async () => {
    const response = await handleRequest(new Request(origin + '/api/relationships/status'), { APP_ORIGIN: invalid }, noNetwork);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'SERVICE_UNAVAILABLE');
  });
}
test('custom origin is independent and rejects other hosts and cross-site clients', async () => {
  const env = { APP_ORIGIN: origin };
  assert.equal((await handleRequest(new Request(origin + '/api/relationships/status'), env, noNetwork)).status, 200);
  assert.equal((await handleRequest(new Request('https://different.example/api/relationships/status'), env, noNetwork)).status, 403);
  assert.equal((await handleRequest(new Request(origin + '/api/relationships/status', { headers: { Origin: 'https://different.example' } }), env, noNetwork)).status, 403);
  const redirect = await handleRequest(new Request(origin.replace('https:', 'http:') + '/guide.html'), env, noNetwork);
  assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), origin + '/guide.html');
});
test('missing assets fails closed without any network fallback', async () => {
  assert.equal((await handleRequest(new Request(origin + '/'), { APP_ORIGIN: origin }, noNetwork)).status, 503);
});
test('video range and HEAD are preserved but credentials and arbitrary headers are not', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await handleRequest(new Request(origin + '/demo/video.mp4', { method, headers: { Range: 'bytes=10-20', Cookie: 'private', Authorization: 'private', 'X-Arbitrary': 'private' } }), { APP_ORIGIN: origin, ASSETS: { fetch: async request => {
      assert.equal(request.method, method); assert.equal(request.headers.get('range'), 'bytes=10-20');
      for (const header of ['cookie', 'authorization', 'x-arbitrary']) assert.equal(request.headers.get(header), null);
      return new Response(method === 'HEAD' ? null : '12345678901', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 10-20/99' } });
    } } }, noNetwork);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 10-20/99');
    assert.equal(await response.text(), method === 'HEAD' ? '' : '12345678901');
  }
});
test('unknown API never falls through to static HTML', async () => {
  const response = await handleRequest(new Request(origin + '/api/relationships/missing'), { APP_ORIGIN: origin, ASSETS: { fetch: noNetwork } }, noNetwork);
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, 'NOT_FOUND');
});
