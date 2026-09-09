// Run through npm run test:workerd after bundling this repository's Worker.
// There is no real outbound network: outboundService always returns synthetic data.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseWechatExportFiles, defaultImportOptions, prepareWechatImport } from '../src/dealgraph/relationships/wechat-import.ts';
const requireWrangler = createRequire(import.meta.resolve('wrangler/package.json'));
const { Miniflare, Response: MockResponse } = await import(requireWrangler.resolve('miniflare'));
const bundle = fileURLToPath(new URL('../.wrangler/test-bundle/worker.js', import.meta.url));
let calls = 0;
let modelCalls = 0;
let cancelMode = false;
let modelStarted;
const mf = new Miniflare({ modules: true, scriptPath: bundle, modulesRoot: dirname(bundle),
  bindings: { APP_ORIGIN: 'https://dealgraph.example.com' },
  compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], cf: false,
  ratelimits: { API_LIMIT: { simple: { limit: 100, period: 60 } }, GLOBAL_LIMIT: { simple: { limit: 100, period: 60 } } },
  outboundService: async request => {
    calls++;
    if (new URL(request.url).pathname.endsWith('/models')) { assert.equal(request.headers.get('authorization'), null); return new MockResponse('', { status: 401 }); }
    assert.match(new URL(request.url).pathname, /\/(responses|chat\/completions)$/);
    const input = await request.json();
    const content = JSON.stringify(input.text?.format?.name === 'business_entity_discovery' ? { candidates: [] } : { facts: [] });
    modelCalls++; modelStarted?.();
    if (cancelMode) await new Promise(resolve => setTimeout(resolve, 300));
    return MockResponse.json(new URL(request.url).pathname.endsWith('/responses')
      ? { status: 'completed', model: input.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      : { model: input.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"facts":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  },
});
try {
  const status = await mf.dispatchFetch('https://dealgraph.example.com/api/relationships/status');
  assert.equal(status.status, 200); assert.equal((await status.json()).mode, 'stateless-byok');
  const diagnosis = await mf.dispatchFetch('https://dealgraph.example.com/api/relationships/diagnose', { method: 'POST',
    headers: { Origin: 'https://dealgraph.example.com', 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3', 'CF-Connecting-IP': '192.0.2.1' }, body: '{}' });
  const result = await diagnosis.json();
  assert.equal(diagnosis.status, 200); assert.equal(result.reachable, true, JSON.stringify({ result, calls }));
  const sample = JSON.parse(readFileSync(new URL('../src/dealgraph/relationships/sample.json', import.meta.url), 'utf8'));
  const analysisInit = { method: 'POST', headers: { Origin: 'https://dealgraph.example.com', 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3', 'CF-Connecting-IP': '192.0.2.1', Authorization: 'Bearer sk-SYNTHETIC_TEST_ONLY_0000' }, body: JSON.stringify({ case: sample, consentVersion: 'openai-upload-v1' }) };
  const analysis = await mf.dispatchFetch('https://dealgraph.example.com/api/relationships/analyze', analysisInit);
  const data = await analysis.json(); assert.equal(analysis.status, 200, JSON.stringify(data)); assert.ok(data.documentsSent > 0); assert.ok(modelCalls > 0);
  for (const [provider, model] of [['openai', 'gpt-4o-mini'], ['deepseek', 'deepseek-v4-flash'], ['deepseek', 'deepseek-v4-pro'], ['qwen', 'qwen-plus'], ['qwen', 'qwen-flash'], ['kimi', 'kimi-k2.6']]) {
    const response = await mf.dispatchFetch('https://dealgraph.example.com/api/relationships/analyze', { ...analysisInit, body: JSON.stringify({ case: sample, provider, model, consentVersion: `model-upload-v2:${provider}:${model}` }) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.provider, provider); assert.equal(result.model, model); assert.ok(result.documentsSent > 0);
  }
  const archive = parseWechatExportFiles([JSON.parse(readFileSync(new URL('../src/dealgraph/relationships/wechat-demo.json', import.meta.url), 'utf8'))]);
  const options = { ...defaultImportOptions(archive, Date.parse('2026-09-09T12:00:00+08:00')), synthetic: true };
  const preview = prepareWechatImport(archive, options);
  const discovery = await mf.dispatchFetch('https://dealgraph.example.com/api/relationships/discover', { ...analysisInit, body: JSON.stringify({ case: preview.input, provider: 'openai', model: 'gpt-4o', consentVersion: 'model-upload-v2:openai:gpt-4o:business-discovery-v1' }) });
  const discovered = await discovery.json();
  assert.equal(discovery.status, 200, JSON.stringify(discovered)); assert.deepEqual(discovered.discovery.candidates, []); assert.equal(discovered.documentsSent, preview.input.documents.length);
  const baseline = modelCalls; cancelMode = true;
  const entered = new Promise(resolve => { modelStarted = resolve; });
  const controller = new AbortController();
  const cancelled = mf.dispatchFetch('https://dealgraph.example.com/api/relationships/analyze', { ...analysisInit, signal: controller.signal });
  const outcome = cancelled.catch(error => error);
  await entered; controller.abort(); await outcome;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(modelCalls, baseline + 1, 'Cancellation must not start a second paid batch');
  console.log('Workerd status + diagnosis + all 7 model pipelines + raw-chat discovery + cancellation passed; zero external calls.');
} finally { await mf.dispose(); }
