import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../server/worker.ts';
import { createRelationshipCloudClient } from '../src/dealgraph/relationships/cloud-client.ts';

const origin = 'https://dealgraph.example.com';
test('HTML disables CDN analytics injection without relaxing CSP or forwarding credentials', async () => {
  const response = await handleRequest(new Request(origin + '/guide.html', { headers: { Authorization: 'Bearer NOT_A_REAL_KEY', Cookie: 'private=synthetic' } }), { APP_ORIGIN: origin, ASSETS: { fetch: async request => {
    assert.equal(request.headers.get('authorization'), null); assert.equal(request.headers.get('cookie'), null);
    return new Response('<html lang="zh-CN"><body>虚构示范</body></html>', { headers: { 'Content-Type': 'text/html' } });
  } } });
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
  assert.match(await response.text(), /虚构示范/);
});
for (const endpoint of ['discover', 'analyze']) for (const contract of [null, 'obsolete-v1']) {
  test(`${endpoint}: stale contract ${contract} is rejected before quota, body or paid upstream`, async () => {
    const headers = { Origin: origin, 'X-DealGraph-Client': 'byok-v1' };
    if (contract) headers['X-DealGraph-Contract'] = contract;
    const reject = async () => { assert.fail('Stale clients must not call quota or upstream'); };
    const response = await handleRequest(new Request(`${origin}/api/relationships/${endpoint}`, { method: 'POST', headers, body: 'not-json' }), { APP_ORIGIN: "https://dealgraph.example.com", API_LIMIT: { limit: reject }, GLOBAL_LIMIT: { limit: reject } }, reject);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'VERSION_MISMATCH');
  });
}
test('status advertises the current contract and only permits same-origin demo media', async () => {
  const response = await handleRequest(new Request(`${origin}/api/relationships/status`), { APP_ORIGIN: origin });
  assert.equal((await response.json()).contract, 'commercial-relations-v3');
  assert.match(response.headers.get('content-security-policy'), /media-src 'self';/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self';/);
});
test('new client stops on old server status before any paid operation', async () => {
  const client = createRelationshipCloudClient(async () => Response.json({ mode: 'stateless-byok', capabilities: 'multi-model-v2', discovery: true }));
  await assert.rejects(client.status(), error => error.code === 'VERSION_MISMATCH');
});
test('current browser request carries its contract without keys on status or diagnosis', async () => {
  const client = createRelationshipCloudClient(async (_, init) => {
    assert.equal(init.headers['X-DealGraph-Contract'], 'commercial-relations-v3');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json({ provider: 'openai', model: 'gpt-4o', reachable: true, route: 'direct', code: 'NETWORK_OK', elapsedMs: 1, httpStatus: 401 });
  });
  assert.equal((await client.diagnose()).reachable, true);
});
