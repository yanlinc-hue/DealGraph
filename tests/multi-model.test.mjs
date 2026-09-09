import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../server/worker.ts';
import { ENDPOINTS, parseModelOutput } from '../server/model-adapters.ts';
import { createRelationshipCloudClient } from '../src/dealgraph/relationships/cloud-client.ts';
import { MODEL_PROVIDERS, DEFAULT_SELECTION, consentFor, isModelSelection } from '../src/dealgraph/relationships/model-catalog.ts';
import { INITIAL_CAMERA, nodeDepth, orbitCamera, orbitPath, projectPoint } from '../src/dealgraph/relationships/graph-space.ts';

const origin = 'https://dealgraph.example.com';
const key = 'SYNTHETIC_TEST_KEY_0000';
const env = { APP_ORIGIN: "https://dealgraph.example.com", API_LIMIT: { limit: async () => ({ success: true }) }, GLOBAL_LIMIT: { limit: async () => ({ success: true }) } };
const sample = { schema: 'dealgraph.relationship-case.v1', dataClass: 'synthetic', title: 'Synthetic adapter test', asOf: '2026-09-01', entities: [{ id: 'p', name: '林舟', kind: 'person' }, { id: 'o', name: '宁川科技', kind: 'organization' }], documents: [{ id: 'd', sourceId: 's', title: '任命', sourceKind: 'announcement', publishedAt: '2026-08-01', text: '宁川科技任命林舟担任首席财务官。' }] };
const facts = { facts: [{ sourceId: 'p', targetId: 'o', kind: 'employment', role: '首席财务官', percentage: null, projectId: null, viaId: null, documentId: 'd', quote: sample.documents[0].text, stance: 'affirmed', validFrom: null, validTo: null }] };
function completion(selection) {
  return selection.provider === 'openai' ? { status: 'completed', model: selection.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(facts) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    : { model: selection.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(facts) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
function request(selection, extra = {}, endpoint = 'analyze') { return new Request(origin + '/api/relationships/' + endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3', 'CF-Connecting-IP': '192.0.2.3', ...(endpoint === 'analyze' ? { Authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify({ ...(endpoint === 'analyze' ? { case: sample, consentVersion: consentFor(selection) } : {}), ...selection, ...extra }) }); }
const noNetwork = async () => { assert.fail('Unexpected outbound request'); };

for (const provider of MODEL_PROVIDERS) for (const model of provider.models) test(`${provider.id}/${model.id}: complete synthetic extraction, fixed route and provider-specific parameters`, async () => {
  const selection = { provider: provider.id, model: model.id }; let calls = 0;
  const result = await handleRequest(request(selection), env, async (url, init) => {
    calls++; assert.equal(url, ENDPOINTS[selection.provider].analyze); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const body = JSON.parse(init.body); assert.equal(body.model, selection.model); assert.equal(body.stream, false); assert.ok(!init.body.includes(key));
    if (selection.provider === 'openai') { assert.equal(body.store, false); assert.equal(body.text.format.strict, true); assert.equal(body.max_output_tokens, 8192); }
    else { assert.equal(body.response_format.type, 'json_object'); assert.equal(body.messages.length, 2); assert.match(body.messages[0].content, /JSON Schema/); assert.equal(body.store, undefined); }
    if (selection.provider === 'kimi') { assert.equal(body.temperature, undefined); assert.equal(body.max_completion_tokens, 8192); assert.equal(body.thinking.type, 'disabled'); }
    if (selection.provider === 'qwen') { assert.equal(body.enable_thinking, false); assert.equal(body.temperature, 0.1); }
    if (selection.provider === 'deepseek') assert.equal(body.thinking.type, 'disabled');
    return Response.json(completion(selection));
  });
  assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.model, model.id); assert.equal(data.provider, provider.id); assert.equal(data.analysis.relationships.length, 1); assert.equal(data.usage.totalTokens, 15); assert.equal(calls, 1);
});

for (const provider of MODEL_PROVIDERS) test(`${provider.id}: diagnosis never sends a key or customer data`, async () => {
  const selection = { provider: provider.id, model: provider.models[0].id };
  const result = await handleRequest(request(selection, {}, 'diagnose'), env, async (url, init) => { assert.equal(url, ENDPOINTS[provider.id].diagnose); assert.equal(init.headers, undefined); assert.equal(init.body, undefined); return new Response('', { status: 401 }); });
  const data = await result.json(); assert.equal(data.provider, provider.id); assert.equal(data.model, selection.model); assert.equal(data.reachable, true);
});

test('unknown provider, cross-provider model, wrong consent and arbitrary endpoint fail before network', async () => {
  const selection = { provider: 'deepseek', model: 'deepseek-v4-flash' };
  for (const extra of [{ provider: 'http://localhost' }, { model: 'gpt-4o' }, { endpoint: 'https://evil.example' }, { baseURL: 'https://evil.example' }, { consentVersion: consentFor(DEFAULT_SELECTION) }, { consentVersion: 'openai-upload-v1' }]) {
    const result = await handleRequest(request(selection, extra), env, noNetwork); assert.equal(result.status, 400);
  }
  assert.equal(isModelSelection({ provider: 'openai', model: 'gpt-4o-mini-unverified' }), false);
});

test('redirects are never followed or treated as successful diagnosis', async () => {
  const selection = { provider: 'kimi', model: 'kimi-k2.6' }; let calls = 0;
  const outbound = async (_, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }); };
  assert.equal((await handleRequest(request(selection), env, outbound)).status, 502);
  assert.equal((await (await handleRequest(request(selection, {}, 'diagnose'), env, outbound)).json()).reachable, false); assert.equal(calls, 2);
});

for (const [name, mutate] of [
  ['length truncation', value => { value.choices[0].finish_reason = 'length'; }],
  ['multiple choices', value => { value.choices.push(value.choices[0]); }],
  ['wrong model', value => { value.model = 'kimi-k2.6-unverified'; }],
  ['tool call', value => { value.choices[0].message.tool_calls = [{}]; }],
  ['refusal', value => { value.choices[0].message.refusal = 'refused'; }],
  ['broken JSON', value => { value.choices[0].message.content = '{"facts":['; }],
  ['bad usage', value => { value.usage.total_tokens = 999; }],
  ['too many output tokens', value => { value.usage.completion_tokens = 9000; value.usage.total_tokens = 9010; }],
]) test('chat response rejects ' + name, () => { const selection = { provider: 'kimi', model: 'kimi-k2.6' }; const body = completion(selection); mutate(body); assert.throws(() => parseModelOutput(body, selection)); });

test('JSON mode does not bypass documentary validation', async () => {
  const selection = { provider: 'qwen', model: 'qwen-plus' }; const body = completion(selection);
  body.choices[0].message.content = JSON.stringify({ facts: [{ ...facts.facts[0], sourceId: 'fabricated' }] });
  const result = await handleRequest(request(selection), env, async () => Response.json(body));
  assert.equal(result.status, 502); assert.equal((await result.json()).error.code, 'RELATION_VALIDATION_FAILED');
});

test('switching service or model clears the key, binds consent, and isolates late results', async () => {
  const sent = []; let release; let hold = false;
  const client = createRelationshipCloudClient(async (url, init) => {
    sent.push({ url, init }); const body = init.body ? JSON.parse(init.body) : {};
    const realRequest = new Request(origin + url, { ...init, signal: undefined, headers: { ...init.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.3' } });
    if (hold && url.endsWith('analyze')) await new Promise(resolve => { release = resolve; });
    return handleRequest(realRequest, env, async () => Response.json(completion(body)));
  });
  const selection = { provider: 'kimi', model: 'kimi-k2.6' };
  try {
    await client.configure(key); client.selectModel(selection);
    assert.equal((await client.status()).configured, false);
    await assert.rejects(client.analyze(sample, consentFor(DEFAULT_SELECTION)), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(client.analyze(sample, consentFor(selection)), { code: 'KEY_REQUIRED' });
    await client.configure(key); hold = true;
    const pending = client.analyze(sample, consentFor(selection)); const outcome = pending.catch(error => error);
    const inflight = sent.at(-1); client.selectModel(DEFAULT_SELECTION); assert.equal(inflight.init.signal.aborted, true);
    release(); assert.equal((await outcome).name, 'AbortError');
    assert.equal((await client.status()).configured, false);
    await client.configure(key); client.selectModel({ provider: 'openai', model: 'gpt-4o-mini' });
    assert.equal((await client.status()).configured, false);
  } finally { client.clearLocalKey(); }
});

test('3D geometry is stable, perspective-aware and bounded; focus stays at centre', () => {
  assert.equal(nodeDepth('focus', 'focus'), 0); assert.equal(nodeDepth('p', 'focus'), nodeDepth('p', 'focus')); assert.notEqual(nodeDepth('p', 'focus'), nodeDepth('o', 'focus'));
  const centre = projectPoint({ x: 0, y: 0, z: 0 }, INITIAL_CAMERA); assert.deepEqual(centre, { x: 560, y: 390, z: 0, scale: 1 });
  const point = { x: 100, y: 200, z: nodeDepth('p', 'focus') };
  const rotated = orbitCamera(INITIAL_CAMERA, 200, 80); assert.notDeepEqual(projectPoint(point, rotated), projectPoint(point, INITIAL_CAMERA));
  assert.equal(orbitCamera(INITIAL_CAMERA, 0, 99999).pitch, 1.25); assert.equal(orbitCamera(INITIAL_CAMERA, 0, -99999).pitch, -1.25);
  assert.ok(projectPoint({ x: 0, y: 0, z: 200 }, { yaw: 0, pitch: 0 }).scale > projectPoint({ x: 0, y: 0, z: -200 }, { yaw: 0, pitch: 0 }).scale);
  assert.ok(!orbitPath(rotated, 455, 'vertical').includes('NaN')); assert.equal(orbitPath(rotated, 455, 'horizontal').split('L').length, 81);
});
