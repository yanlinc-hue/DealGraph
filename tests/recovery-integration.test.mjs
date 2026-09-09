import test from 'node:test';
import assert from 'node:assert/strict';
import { localProxyUrl, createLocalTransport } from '../server/local-transport.ts';
import { handleRequest } from '../server/worker.ts';
import { createRelationshipCloudClient } from '../src/dealgraph/relationships/cloud-client.ts';
import { DEFAULT_SELECTION, consentFor } from '../src/dealgraph/relationships/model-catalog.ts';
import { bookFromCase, addBook, emptyWorkbench, validateWorkbench } from '../src/dealgraph/workbench-state.ts';
import { encryptWorkbench, decryptWorkbench } from '../src/dealgraph/workbench-vault.ts';

const input = { schema: 'dealgraph.relationship-case.v1', title: '恢复契约测试', dataClass: 'synthetic', asOf: '2026-09-09', entities: [
  { id: 'a', name: '晴山资本', kind: 'organization' }, { id: 'b', name: '微光科技', kind: 'organization' },
], documents: [{ id: 'd', sourceId: 'chat-1', sourceKind: 'chat', title: '合成聊天', publishedAt: '2026-09-08', text: '晴山资本于2024年完成对微光科技的投资。' }] };
const fact = { sourceId: 'a', targetId: 'b', kind: 'investment', role: null, percentage: null, projectId: null, viaId: null, documentId: 'd', quote: input.documents[0].text, stance: 'affirmed', validFrom: null, validTo: '2024-12-31' };
const completion = facts => ({ status: 'completed', model: 'gpt-4o-2024-08-06', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ facts }) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
const limit = { limit: async () => ({ success: true }) };
function clientFor(facts) {
  return createRelationshipCloudClient(async (path, init) => handleRequest(new Request('https://dealgraph.example.com' + path, { ...init, headers: { ...init.headers, Origin: 'https://dealgraph.example.com', 'CF-Connecting-IP': '127.0.0.1' } }), { APP_ORIGIN: "https://dealgraph.example.com", API_LIMIT: limit, GLOBAL_LIMIT: limit }, async () => Response.json(completion(facts))));
}

test('local proxy accepts explicit loopback only; no credentials, redirects or arbitrary destinations', async () => {
  assert.equal(localProxyUrl(undefined), undefined);
  assert.equal(localProxyUrl('http://127.0.0.1:12334'), 'http://127.0.0.1:12334');
  for (const value of ['https://remote.example:443', 'http://user:pass@127.0.0.1:12', 'http://127.0.0.1:12/path', 'http://127.0.0.1:12?x=1', 'http://127.0.0.1:12#fragment', 'http://localhost:12']) assert.throws(() => localProxyUrl(value));
  const transport = createLocalTransport('');
  try {
    await assert.rejects(transport.outbound('https://untrusted.example/', { redirect: 'manual' }));
    await assert.rejects(transport.outbound('https://api.openai.com/v1/responses', { redirect: 'follow' }));
  } finally { await transport.close(); }
});

test('safe date recovery travels through Worker/client and encrypted workbench without losing issues', async () => {
  const client = clientFor([fact]);
  try {
    await client.configure('SYNTHETIC_TEST_KEY_ONLY_0000');
    const result = await client.analyze(input, consentFor(DEFAULT_SELECTION));
    assert.equal(result.analysis.relationships.length, 1);
    assert.equal(result.analysis.relationships[0].status, 'review');
    assert.ok(result.analysis.issues.some(issue => issue.kind === 'invalid_input'));
    const work = validateWorkbench(addBook(emptyWorkbench(), bookFromCase(input, 'recovery', result.analysis, 'model')));
    const encrypted = await encryptWorkbench(work, 'synthetic-testing-password-only');
    const restored = await decryptWorkbench(encrypted, 'synthetic-testing-password-only');
    assert.deepEqual(restored.books[0].analysis.issues, result.analysis.issues);
    assert.equal(JSON.stringify(restored).includes('2024-12-31'), false);
  } finally { client.clearLocalKey(); }
});

test('forged quote remains a staged validation failure; no key or raw text leaks in error', async () => {
  const client = clientFor([{ ...fact, quote: '不存在的伪造原文', validTo: null }]);
  try {
    await client.configure('SYNTHETIC_TEST_KEY_ONLY_0000');
    await assert.rejects(client.analyze(input, consentFor(DEFAULT_SELECTION)), error => error.code === 'RELATION_VALIDATION_FAILED' && !error.message.includes('伪造原文') && !error.message.includes('SYNTHETIC_TEST'));
  } finally { client.clearLocalKey(); }
});
