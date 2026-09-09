import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../server/worker.ts';
import { createRelationshipCloudClient } from '../src/dealgraph/relationships/cloud-client.ts';
import { DEFAULT_SELECTION, consentFor } from '../src/dealgraph/relationships/model-catalog.ts';

const origin = 'https://dealgraph.example.com';
const keyA = 'sk-AAAAAAAAAAAAAAAAAAAA';
const keyB = 'sk-BBBBBBBBBBBBBBBBBBBB';
const env = { APP_ORIGIN: "https://dealgraph.example.com", API_LIMIT: { limit: async () => ({ success: true }) }, GLOBAL_LIMIT: { limit: async () => ({ success: true }) } };
const caseFile = { schema: 'dealgraph.relationship-case.v1', dataClass: 'synthetic', title: 'Synthetic deployment test', asOf: '2026-09-01', entities: [
  { id: 'p', name: '林舟', kind: 'person' }, { id: 'o', name: '宁川科技', kind: 'organization' },
], documents: [{ id: 'd', sourceId: 's', title: '任命', sourceKind: 'announcement', publishedAt: '2026-08-01', text: '宁川科技任命林舟担任首席财务官。' }] };
const modelBody = () => ({ status: 'completed', model: 'gpt-4o-2024-08-06', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ facts: [{ sourceId: 'p', targetId: 'o', kind: 'employment', role: '首席财务官', percentage: null, projectId: null, viaId: null, documentId: 'd', quote: caseFile.documents[0].text, stance: 'affirmed', validFrom: null, validTo: null }] }) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
function req(path, body = {}, headers = {}, method = 'POST') { return new Request(origin + '/api/relationships/' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3', 'CF-Connecting-IP': '192.0.2.1', ...headers }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) }); }
const analysisRequest = (key = keyA) => req('analyze', { case: caseFile, consentVersion: 'openai-upload-v1' }, { Authorization: 'Bearer ' + key });
const noNetwork = async () => { throw new Error('Unexpected outbound'); };

test('status does not use a key or call OpenAI', async () => {
  const r = await handleRequest(req('status', {}, {}, 'GET'), env, noNetwork);
  assert.equal(r.status, 200); assert.equal((await r.json()).mode, 'stateless-byok');
  assert.equal(r.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('access-control-allow-origin'), null);
});
for (const [name, mutate, status] of [
  ['foreign origin', r => r.headers.set('origin', 'https://evil.example'), 403],
  ['missing origin', r => r.headers.delete('origin'), 403],
  ['cross site', r => r.headers.set('sec-fetch-site', 'cross-site'), 403],
  ['missing client header', r => r.headers.delete('x-dealgraph-client'), 403],
  ['forwarded host', r => r.headers.set('x-forwarded-host', 'dealgraph.example.com'), 403],
  ['wrong key', r => r.headers.set('authorization', 'Bearer invalid'), 401],
  ['missing key', r => r.headers.delete('authorization'), 401],
  ['wrong content type', r => r.headers.set('content-type', 'text/plain'), 415],
  ['oversize content', r => r.headers.set('content-length', '9999999'), 413],
]) test(name + ' is rejected before network', async () => { const r = analysisRequest(); mutate(r); assert.equal((await handleRequest(r, env, noNetwork)).status, status); });

test('removed configure and OPTIONS never expose shared state', async () => {
  assert.equal((await handleRequest(req('configure', { apiKey: keyA }), env, noNetwork)).status, 404);
  assert.equal((await handleRequest(req('analyze', {}, {}, 'OPTIONS'), env, noNetwork)).status, 405);
});
test('missing or exhausted platform limiter fails closed', async () => {
  assert.equal((await handleRequest(analysisRequest(), { APP_ORIGIN: origin }, noNetwork)).status, 503);
  assert.equal((await handleRequest(analysisRequest(), { ...env, API_LIMIT: { limit: async () => ({ success: false }) } }, noNetwork)).status, 429);
});
test('two concurrent users send only their own keys', async () => {
  const seen = [];
  const outbound = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'manual');
    seen.push(init.headers.Authorization);
    const body = JSON.parse(init.body); assert.equal(body.model, 'gpt-4o'); assert.equal(body.store, false); assert.deepEqual(body.tools, []);
    assert.equal(body.text.format.strict, true);
    return Response.json(modelBody());
  };
  for (const r of await Promise.all([handleRequest(analysisRequest(keyA), env, outbound), handleRequest(analysisRequest(keyB), env, outbound)])) {
    assert.equal(r.status, 200); const data = await r.json(); assert.equal(data.analysis.relationships.length, 1); assert.equal(data.usage.totalTokens, 15);
    assert.equal(JSON.stringify(data).includes('sk-'), false);
  }
  assert.deepEqual(seen.sort(), ['Bearer ' + keyA, 'Bearer ' + keyB]);
});
test('errors are sanitized and never retried', async () => {
  let calls = 0;
  const r = await handleRequest(analysisRequest(), env, async () => { calls++; return Response.json({ error: { code: 'insufficient_quota', message: keyA + caseFile.documents[0].text } }, { status: 429 }); });
  assert.equal(r.status, 429); const text = await r.text(); assert.match(text, /OPENAI_QUOTA/); assert.ok(!text.includes(keyA)); assert.ok(!text.includes(caseFile.documents[0].text)); assert.equal(calls, 1);
});
test('diagnosis sends neither key nor materials and makes no model call', async () => {
  const r = await handleRequest(req('diagnose'), env, async (url, init) => { assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(init.body, undefined); assert.equal(init.headers, undefined); return new Response('', { status: 401 }); });
  assert.equal((await r.json()).reachable, true);
  assert.equal((await handleRequest(req('diagnose', {}, { Authorization: 'Bearer ' + keyA }), env, noNetwork)).status, 400);
});
test('static assets strip credentials and install security headers', async () => {
  const r = await handleRequest(new Request(origin + '/', { headers: { Cookie: 'secret', Authorization: 'Bearer ' + keyA } }), { ...env, ASSETS: { fetch: async request => {
    assert.equal(request.headers.get('authorization'), null); assert.equal(request.headers.get('cookie'), null); return new Response('HTML', { headers: { 'content-type': 'text/html', 'set-cookie': 'bad', 'access-control-allow-origin': '*' } });
  } } }, noNetwork);
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('access-control-allow-origin'), null); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(await r.text(), 'HTML');
});
test('BYOK configure stays local; upload excludes future and unknown fields; key expires', async () => {
  const seen = []; let now = 1000;
  const client = createRelationshipCloudClient(async (url, init) => {
    seen.push({ url, init });
    const request = new Request(origin + url, { ...init, headers: { ...init.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.2' } });
    return handleRequest(request, env, async () => Response.json(modelBody()));
  }, () => now);
  try {
    await client.configure(keyA); assert.equal(seen.length, 0); assert.equal((await client.status()).configured, true);
    const input = { ...caseFile, secretExtra: 'not-for-server', interactions: [{ sourceId: 'p', targetId: 'o', count: 3, lastAt: '2026-08-01', text: 'not-for-server' }], documents: [...caseFile.documents, { ...caseFile.documents[0], id: 'future', publishedAt: '2027-01-01', text: 'FUTURE_SECRET' }] };
    const result = await client.analyze(input, consentFor(DEFAULT_SELECTION)); assert.equal(result.excludedFutureDocuments, 1); assert.equal(result.documentsSent, 1);
    const sent = seen.at(-1); assert.equal(sent.init.credentials, 'omit'); assert.ok(!sent.init.body.includes('FUTURE_SECRET')); assert.ok(!sent.init.body.includes('not-for-server')); assert.equal(sent.init.headers.Authorization, 'Bearer ' + keyA);
    now += 30 * 60_000; await assert.rejects(client.analyze(caseFile, consentFor(DEFAULT_SELECTION)), { code: 'KEY_REQUIRED' });
    await client.configure(keyB); client.clearLocalKey(); await assert.rejects(client.analyze(caseFile, consentFor(DEFAULT_SELECTION)), { code: 'KEY_REQUIRED' });
  } finally { client.clearLocalKey(); }
});
