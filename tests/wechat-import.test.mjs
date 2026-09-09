import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWechatExportFiles, defaultImportOptions, prepareWechatImport, prepareDiscoveryInput, caseFromConfirmedNodes, mergeConfirmedNodes, WECHAT_LIMITS } from '../src/dealgraph/relationships/wechat-import.ts';
import { buildDiscoveryRequest, finalizeDiscovery, discoveryConsentFor } from '../src/dealgraph/relationships/entity-discovery.ts';
import { commercialRelationAllowed, businessNodeAllowed } from '../src/dealgraph/relationships/commercial-scope.ts';
import { finalizeCloudAnalysis, prepareCloudCase, buildExtractionRequest } from '../src/dealgraph/relationships/cloud-extraction.ts';
import { analyzeRelationshipCase } from '../src/dealgraph/relationships/engine.ts';
import { createRelationshipCloudClient, CloudRunGate } from '../src/dealgraph/relationships/cloud-client.ts';
import { DEFAULT_SELECTION, MODEL_PROVIDERS, consentFor } from '../src/dealgraph/relationships/model-catalog.ts';
import { ENDPOINTS } from '../server/model-adapters.ts';
import { handleRequest } from '../server/worker.ts';

const demo = JSON.parse(readFileSync(new URL('../src/dealgraph/relationships/wechat-demo.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-09-09T00:00:00Z');
const archive = parseWechatExportFiles([demo]);
const options = defaultImportOptions(archive, now);
const preview = prepareWechatImport(archive, options);
const input = preview.input;
const origin = 'https://dealgraph.example.com';
const key = 'SYNTHETIC_TEST_KEY_ONLY_0000';
const env = { APP_ORIGIN: "https://dealgraph.example.com", API_LIMIT: { limit: async () => ({ success: true }) }, GLOBAL_LIMIT: { limit: async () => ({ success: true }) } };
const noNetwork = async () => assert.fail('Unexpected outbound network');
function message(text, ts = Date.parse('2026-09-08T10:00:00+08:00') / 1000, typeId = 1) { return { ts, time: new Date(ts * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '), from_id: 'wxid_sender_only', from: '林岚', type: '文本', type_id: typeId, text }; }
function raw(messages) { return { wxid: 'wxid_private_chat', name: 'LOCAL_ONLY_CHAT_TITLE', format_version: 1, messages }; }
function completion(selection, output) { return selection.provider === 'openai' ? { status: 'completed', model: selection.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } : { model: selection.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }; }
function request(selection, extra = {}, endpoint = 'discover') { return new Request(`${origin}/api/relationships/${endpoint}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3', 'CF-Connecting-IP': '192.0.2.5', Authorization: `Bearer ${key}` }, body: JSON.stringify({ ...selection, case: input, consentVersion: discoveryConsentFor(selection), ...extra }) }); }
const known = [
  ['lin', '林岚', 'person'], ['zhou', '周宁', 'person'], ['chen', '陈曦', 'person'], ['shen', '沈卓', 'person'], ['ye', '叶蓁', 'person'],
  ['child', '林小满', 'person'], ['n', '宁川科技', 'organization'], ['bank', '远航银行', 'organization'], ['capital', '启源投资', 'organization'],
  ['law', '澄明律所', 'organization'], ['jiang', '江澜设备', 'organization'], ['x', '星海资本', 'organization'], ['chip', '宁芯电子', 'organization'], ['yun', '云杉产业', 'organization'], ['project', '宁川B轮融资', 'project'],
].map(([id, name, kind]) => ({ id, name, kind }));
function caseFor(text, projectId) { return { schema: 'dealgraph.relationship-case.v1', dataClass: 'synthetic', title: '全虚构', asOf: '2026-09-09', entities: known, documents: [{ id: 'd', sourceId: 's', title: '聊天', publishedAt: '2026-09-08', sourceKind: 'chat', ...(projectId ? { projectId } : {}), text }] }; }
function fact(quote, overrides = {}) { return { sourceId: 'zhou', targetId: 'chen', kind: 'introduction', role: null, percentage: null, projectId: null, viaId: 'shen', documentId: 'd', quote, stance: 'affirmed', validFrom: null, validTo: null, ...overrides }; }
function analysisFor(text, facts) { const c = caseFor(text); return finalizeCloudAnalysis(c, [{ documentIds: ['d'], output: { facts } }]); }

test('raw chat import preserves text, excludes media/future and keeps one source', () => {
  assert.equal(archive.messages.length, 21); assert.equal(preview.textCount, 18); assert.equal(preview.mediaCount, 2); assert.equal(preview.excludedCount, 1);
  assert.equal(new Set(input.documents.map(d => d.sourceId)).size, 1);
  assert.match(input.documents[0].text, /百分之十八/);
  assert.ok(!JSON.stringify(input).includes('顾言正式出任'));
  assert.equal(input.asOf, '2026-09-09T23:59:59+08:00');
  for (const id of archive.privateIds) assert.ok(!JSON.stringify(input).includes(id));
  assert.ok(!JSON.stringify(input).includes(demo.name));
  assert.ok(!JSON.stringify(input).includes('13800138000')); assert.ok(!JSON.stringify(input).includes('demo.person@example.test'));
});

test('scope/private terms/edits produce exactly previewed allowlisted upload', () => {
  const a = parseWechatExportFiles([raw([message('林岚担任宁川科技董事长。邮箱私密 TEST_PRIVATE_TEXT wxid_private_chat 13800138000'), message('UNSELECTED_TOKEN'), message('FUTURE_UNIQUE_PERSON', Date.parse('2026-09-10T00:00:00+08:00') / 1000), message('MEDIA_SECRET', undefined, 3)])]);
  const opt = { ...defaultImportOptions(a, now), excluded: [a.messages[1].id], privateTerms: ['TEST_PRIVATE_TEXT'], edits: { [a.messages[0].id]: '林岚担任宁川科技董事长。TEST_PRIVATE_TEXT wxid_private_chat 13800138000' } };
  const selected = prepareWechatImport(a, opt); const serialized = JSON.stringify(buildDiscoveryRequest(selected.input, selected.input.documents));
  for (const secret of ['UNSELECTED_TOKEN', 'FUTURE_UNIQUE_PERSON', 'MEDIA_SECRET', 'TEST_PRIVATE_TEXT', 'wxid_private_chat', 'wxid_sender_only', 'LOCAL_ONLY_CHAT_TITLE', '13800138000']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(selected.textCount, 1); assert.match(serialized, /董事长/);
  assert.equal(new Date(selected.input.documents[0].publishedAt).getTime(), a.messages[0].ts * 1000);
});

test('reject malformed timestamps/versions/types/unknown fields before model work', () => {
  for (const mutate of [v => v.format_version = 2, v => v.messages = {}, v => v.extra = 'PRIVATE', v => v.messages[0].ts *= 1000, v => v.messages[0].time = '2026-09-08 00:00:00', v => v.messages[0].type_id = '1', v => v.messages[0].text = null, v => v.messages[0].extra = 'PRIVATE']) {
    const v = raw([message('林岚担任宁川科技董事长。')]); mutate(v); assert.throws(() => parseWechatExportFiles([v]));
  }
  assert.throws(() => parseWechatExportFiles([])); assert.throws(() => parseWechatExportFiles(Array(11).fill(raw([]))));
  assert.throws(() => parseWechatExportFiles([raw(Array(WECHAT_LIMITS.messages + 1).fill(message('x')))]));
  const poison = raw([message('ok')]); poison.messages[0].text = '\u0000'; assert.throws(() => parseWechatExportFiles([poison]));
});

test('China midnight boundary and no selected text fail safely', () => {
  const a = parseWechatExportFiles([raw([message('林岚担任宁川科技董事长。', Date.parse('2026-09-08T23:59:59+08:00') / 1000), message('OUTSIDE', Date.parse('2026-09-09T00:00:00+08:00') / 1000)])]);
  const opt = { ...defaultImportOptions(a, now), end: '2026-09-08' };
  assert.equal(prepareWechatImport(a, opt).textCount, 1);
  assert.throws(() => prepareWechatImport(a, { ...opt, chatIds: [] }));
  assert.throws(() => prepareWechatImport(a, { ...opt, start: '2026-02-30' }));
});

test('whole-message chunks preserve late denials and fail instead of truncating', () => {
  const a = parseWechatExportFiles([raw(Array.from({ length: 3 }, (_, i) => message('林岚担任宁川科技董事长。' + '字'.repeat(6000) + '但这条消息是误传' + i)))]);
  const p = prepareWechatImport(a, defaultImportOptions(a, now)); assert.equal(p.input.documents.length, 3);
  assert.equal(p.input.documents.filter(d => d.text.includes('但这条消息是误传')).length, 3);
  const huge = parseWechatExportFiles([raw([message('x'.repeat(10_000) + '不成立')])]);
  assert.throws(() => prepareWechatImport(huge, defaultImportOptions(huge, now)), /不会截断/);
  const over = parseWechatExportFiles([raw(Array(8).fill(message('字'.repeat(9000))))]);
  assert.throws(() => prepareWechatImport(over, defaultImportOptions(over, now)), /6 万/);
});

test('discovery rejects fabricated names, changed documents, wrong shape and missing batches', () => {
  const candidate = { name: '林岚', kind: 'person', documentId: input.documents[0].id, quote: '林岚现在是宁川科技的董事长' };
  const result = finalizeDiscovery(input, [{ documentIds: input.documents.map(d => d.id), output: { candidates: [candidate] } }]);
  assert.equal(result.candidates[0].name, '林岚'); assert.equal(result.candidates[0].id, 'candidate-1');
  for (const patch of [{ name: '不存在的人' }, { kind: 'friend' }, { documentId: 'unseen' }, { quote: '伪造内容林岚' }, { aliases: ['SECRET'] }]) assert.throws(() => finalizeDiscovery(input, [{ documentIds: input.documents.map(d => d.id), output: { candidates: [{ ...candidate, ...patch }] } }]));
  assert.throws(() => finalizeDiscovery(input, []));
  assert.throws(() => buildDiscoveryRequest(input, [{ ...input.documents[0], text: 'changed' }]));
  assert.throws(() => prepareDiscoveryInput({ ...input, entities: [] }));
});

test('business discovery ignores named children from daily chat, preserves ambiguous spelling', () => {
  const a = parseWechatExportFiles([raw([message('林岚担任宁川科技董事长。林小满刚上小学。王伟担任宁川科技融资负责人，身份还没分清。')])]);
  const p = prepareWechatImport(a, defaultImportOptions(a, now)); const id = p.input.documents[0].id;
  const result = finalizeDiscovery(p.input, [{ documentIds: [id], output: { candidates: [
    { name: '林小满', kind: 'person', documentId: id, quote: '林岚担任宁川科技董事长。林小满刚上小学。' },
    { name: '王伟', kind: 'person', documentId: id, quote: '王伟担任宁川科技融资负责人，身份还没分清。' },
  ] } }]);
  assert.equal(result.ignoredNonBusiness, 1); assert.deepEqual(result.candidates.map(n => n.name), ['王伟']);
  assert.ok(!JSON.stringify(result).includes('王伟（星海）'));
});

test('same spelling in different identity assertions remains separate until explicit user merge', () => {
  const first = '王伟担任甲公司总经理。', second = '另一位王伟担任乙公司董事长。';
  const a = parseWechatExportFiles([raw([message(first + second)])]); const p = prepareWechatImport(a, defaultImportOptions(a, now)); const id = p.input.documents[0].id;
  const result = finalizeDiscovery(p.input, [{ documentIds: [id], output: { candidates: [first, second].map(quote => ({ name: '王伟', kind: 'person', documentId: id, quote })) } }]);
  assert.equal(result.candidates.length, 2); assert.notEqual(result.candidates[0].id, result.candidates[1].id); assert.notEqual(result.candidates[0].context, result.candidates[1].context);
  assert.equal(mergeConfirmedNodes(result.candidates, result.candidates[0].id, result.candidates[1].id).length, 1);
});

test('a company next to a child is not the child business role; an explicit job still qualifies', () => {
  const sentences = ['宁川科技董事长林岚的女儿林小满今天要去上小学。', '林小满今天去宁川科技门口等妈妈下班。', '林小满担任宁川科技研发总监。'];
  for (let i = 0; i < sentences.length; i++) {
    const a = parseWechatExportFiles([raw([message(sentences[i])])]); const p = prepareWechatImport(a, defaultImportOptions(a, now)); const id = p.input.documents[0].id;
    const result = finalizeDiscovery(p.input, [{ documentIds: [id], output: { candidates: [{ name: '林小满', kind: 'person', documentId: id, quote: sentences[i] }] } }]);
    assert.equal(result.candidates.length, i === 2 ? 1 : 0, sentences[i]);
  }
});

test('repeated exports from the same chat never manufacture independent sources', () => {
  const a = parseWechatExportFiles([raw([message('林岚担任宁川科技董事长。')]), raw([message('周宁担任宁川科技首席财务官。')])]);
  assert.equal(a.chats.length, 1); assert.equal(new Set(a.messages.map(m => m.id)).size, 2);
  assert.equal(new Set(prepareWechatImport(a, defaultImportOptions(a, now)).input.documents.map(d => d.sourceId)).size, 1);
});

test('confirmed names are independent from privacy text; merge is explicit and type-safe', () => {
  const c = caseFromConfirmedNodes(input, known.slice(0, 2)); assert.equal(c.entities.length, 2); assert.deepEqual(c.documents, input.documents);
  assert.throws(() => caseFromConfirmedNodes(input, []));
  const merged = mergeConfirmedNodes([{ id: 'a', name: '林岚', kind: 'person' }, { id: 'b', name: '林总', kind: 'person' }], 'b', 'a');
  assert.equal(merged.length, 1); assert.deepEqual(merged[0].aliases, ['林总']);
  assert.throws(() => mergeConfirmedNodes(known, 'lin', 'n'));
});

for (const provider of MODEL_PROVIDERS) test(`${provider.id}: discover uses same fixed endpoint, scoped consent and no automatic relation call`, async () => {
  const selection = { provider: provider.id, model: provider.models[0].id }; let calls = 0;
  const response = await handleRequest(request(selection), env, async (url, init) => {
    calls++; assert.equal(url, ENDPOINTS[provider.id].analyze); assert.equal(init.redirect, 'manual');
    const body = JSON.parse(init.body); const serialized = JSON.stringify(body);
    assert.match(serialized, /BUSINESS RELATIONS ONLY/); assert.ok(!serialized.includes('validation-only'));
    if (provider.id === 'openai') assert.equal(body.text.format.name, 'business_entity_discovery');
    else { assert.ok(body.messages[0].content.includes('"candidates":[]')); assert.ok(!body.messages[0].content.includes('"facts":[]')); }
    return Response.json(completion(selection, { candidates: [] }));
  });
  assert.equal(response.status, 200); const result = await response.json(); assert.deepEqual(result.discovery.candidates, []); assert.equal(calls, preview.batches);
  assert.equal(result.analysis, undefined);
  assert.equal((await handleRequest(request(selection, { consentVersion: consentFor(selection) }), env, noNetwork)).status, 400);
  assert.equal((await handleRequest(request(selection, { baseURL: 'https://evil.example' }), env, noNetwork)).status, 400);
});

test('discovery client rejects wrong purpose, needs key and cancels abort-ignoring late responses', async () => {
  let release; const sent = [];
  const client = createRelationshipCloudClient(async (url, init) => {
    sent.push({ url, init }); await new Promise(resolve => { release = resolve; });
    const request = new Request(origin + url, { ...init, signal: undefined, headers: { ...init.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.5' } });
    return handleRequest(request, env, async () => Response.json(completion(DEFAULT_SELECTION, { candidates: [] })));
  });
  try {
    await assert.rejects(client.discover(input, consentFor(DEFAULT_SELECTION)), { code: 'CONSENT_REQUIRED' });
    await assert.rejects(client.discover(input, discoveryConsentFor(DEFAULT_SELECTION)), { code: 'KEY_REQUIRED' }); assert.equal(sent.length, 0);
    await client.configure(key); const pending = client.discover(input, discoveryConsentFor(DEFAULT_SELECTION)); const outcome = pending.catch(error => error);
    client.selectModel({ provider: 'openai', model: 'gpt-4o-mini' }); assert.equal(sent[0].init.signal.aborted, true); release(); assert.equal((await outcome).name, 'AbortError');
  } finally { client.clearLocalKey(); }
  const gate = new CloudRunGate(); const first = gate.begin(); gate.cancel(); const second = gate.begin(); assert.equal(gate.isCurrent(first), false); assert.equal(gate.isCurrent(second), true); gate.cancel();
});

test('full client → worker discovery → human confirmation → analysis contract (mock, no network)', async () => {
  const text = '林岚担任宁川科技董事长。周宁担任宁川科技首席财务官。';
  const a = parseWechatExportFiles([raw([message(text)])]); const p = prepareWechatImport(a, defaultImportOptions(a, now));
  let discovered = 0, analyzed = 0;
  const client = createRelationshipCloudClient(async (url, init) => {
    const req = new Request(origin + url, { ...init, headers: { ...init.headers, Origin: origin, 'CF-Connecting-IP': '192.0.2.5' } });
    return handleRequest(req, env, async (_url, upstream) => {
      const body = JSON.parse(upstream.body);
      if (url.endsWith('/discover')) {
        discovered++; assert.equal(body.text.format.name, 'business_entity_discovery');
        return Response.json(completion(DEFAULT_SELECTION, { candidates: [
          { name: '林岚', kind: 'person', documentId: p.input.documents[0].id, quote: '林岚担任宁川科技董事长。' },
          { name: '宁川科技', kind: 'organization', documentId: p.input.documents[0].id, quote: '林岚担任宁川科技董事长。' },
          { name: '周宁', kind: 'person', documentId: p.input.documents[0].id, quote: '周宁担任宁川科技首席财务官。' },
        ] }));
      }
      analyzed++; assert.equal(body.text.format.name, 'relationship_extraction');
      const sent = JSON.parse(body.input); assert.equal(sent.entities.length, 2); assert.ok(!sent.entities.some(node => node.name === '周宁'));
      return Response.json(completion(DEFAULT_SELECTION, { facts: [fact('林岚担任宁川科技董事长。', { sourceId: 'candidate-1', targetId: 'candidate-2', viaId: null, kind: 'employment', role: '董事长', documentId: p.input.documents[0].id })] }));
    });
  });
  try {
    await client.configure(key); const result = await client.discover(p.input, discoveryConsentFor(DEFAULT_SELECTION));
    assert.equal(result.discovery.candidates.length, 3); assert.equal(discovered, 1); assert.equal(analyzed, 0);
    const c = caseFromConfirmedNodes(p.input, result.discovery.candidates.slice(0, 2));
    await assert.rejects(client.analyze(c, discoveryConsentFor(DEFAULT_SELECTION)), { code: 'CONSENT_REQUIRED' }); assert.equal(analyzed, 0);
    const final = await client.analyze(c, consentFor(DEFAULT_SELECTION)); assert.equal(analyzed, 1); assert.equal(final.analysis.relationships.length, 1); assert.equal(final.analysis.relationships[0].status, 'review');
  } finally { client.clearLocalKey(); }
});

test('second batch failure aborts discovery and never returns a partial success or retries', async () => {
  const a = parseWechatExportFiles([raw(Array(3).fill(message('林岚担任宁川科技董事长。' + '字'.repeat(7000))))]); const p = prepareWechatImport(a, defaultImportOptions(a, now)); let calls = 0;
  const response = await handleRequest(request(DEFAULT_SELECTION, { case: p.input }), env, async () => ++calls === 1 ? Response.json(completion(DEFAULT_SELECTION, { candidates: [] })) : Response.json({ error: { code: 'insufficient_quota', message: 'PRIVATE ERROR' } }, { status: 429 }));
  assert.equal(response.status, 429); const result = await response.json(); assert.equal(result.discovery, undefined); assert.equal(calls, 2); assert.ok(!JSON.stringify(result).includes('PRIVATE ERROR'));
});

const socialCases = [
  ['沈卓昨天把周宁介绍给陈曦了，就是介绍两个朋友认识，一起吃火锅。', {}],
  ['沈卓在婚礼上把周宁介绍给陈曦。宁川B轮融资的材料我另外发你。', {}],
  ['周宁借给林岚200块吃饭，月底还。宁川科技的融资进度明天再说。', { kind: 'lending', sourceId: 'zhou', targetId: 'lin', viaId: null }],
  ['周宁和陈曦最近天天聊天，聊孩子上学、周末露营，也都在宁川科技客户群里。', { kind: 'cooperation', viaId: null }],
  ['陈曦给周宁介绍了宁川B轮融资的项目材料，还发了一份PPT。', {}],
];
for (const [text, patch] of socialCases) test('daily chat cannot become a business edge: ' + text.slice(0, 20), () => {
  const analysis = analysisFor(text, [fact(text, patch)]); assert.equal(analysis.relationships.length, 0);
  assert.equal(analyzeRelationshipCase(caseFor(text)).relationships.length, 0);
});

test('business introductions and corporate loans survive nearby meals and private talk', () => {
  const intro = '为推进宁川B轮融资，沈卓已经把周宁介绍给陈曦，双方已就投资条款开了会。谈完大家一起吃了饭。';
  assert.equal(analysisFor(intro, [fact(intro, { projectId: 'project' })]).relationships.length, 1);
  const loan = '陈曦借给宁川科技500万元用于生产周转，钱已经打到公司账户了。';
  assert.ok(commercialRelationAllowed('lending', loan, caseFor(loan), 'chen', 'n'));
  const bank = '远航银行已经向宁川科技发放贷款。林岚下午要陪孩子看病，我们改天吃饭。';
  const a = analysisFor(bank, [fact('远航银行已经向宁川科技发放贷款。', { kind: 'lending', sourceId: 'bank', targetId: 'n', viaId: null })]); assert.equal(a.relationships.length, 1);
  const ownership = '启源投资目前持有宁川科技18%股权。周宁和陈曦今晚AA吃饭，各出一半。';
  const o = analysisFor(ownership, [fact('启源投资目前持有宁川科技18%股权。', { kind: 'ownership', sourceId: 'capital', targetId: 'n', viaId: null, percentage: 18 })]); assert.equal(o.relationships[0].percentage, 18);
});

test('project metadata does not rescue social introduction and personal loans stay excluded', () => {
  const social = '沈卓已把周宁介绍给陈曦，大家一起吃饭。';
  const c = caseFor(social, 'project');
  assert.equal(finalizeCloudAnalysis(c, [{ documentIds: ['d'], output: { facts: [fact(social, { projectId: 'project' })] } }]).relationships.length, 0);
  const loan = '林岚向陈曦提供个人贷款，用于装修自家住房。';
  assert.equal(analysisFor(loan, [fact(loan, { kind: 'lending', sourceId: 'lin', targetId: 'chen', viaId: null })]).relationships.length, 0);
  assert.equal(commercialRelationAllowed('lending', '林岚向陈曦提供贷款。', caseFor(loan), 'lin', 'chen'), false);
});

test('an explicitly mentioned project retains business meaning after name neutralization', () => {
  const intro = '沈卓已为宁川B轮融资把周宁介绍给陈曦。';
  assert.equal(analysisFor(intro, [fact(intro, { projectId: 'project' })]).relationships.length, 1);
  const role = '周宁负责宁川B轮融资。';
  assert.equal(analysisFor(role, [fact(role, { kind: 'project_role', sourceId: 'zhou', targetId: 'project', projectId: 'project', viaId: null })]).relationships.length, 1);
  const unrelated = '沈卓在婚礼上把周宁介绍给陈曦。宁川B轮融资明天再说。';
  assert.equal(analysisFor(unrelated, [fact(unrelated, { projectId: 'project' })]).relationships.length, 0);
  for (const ending of ['大家一起聊篮球。', '纯粹交个朋友，不涉及业务。']) {
    const party = '沈卓在宁川B轮融资的聚餐中已把周宁介绍给陈曦认识了，' + ending;
    assert.equal(analysisFor(party, [fact(party, { projectId: 'project' })]).relationships.length, 0);
    assert.equal(commercialRelationAllowed('introduction', party, caseFor(party), 'zhou', 'chen', 'project'), false);
  }
  const scoped = '宁川B轮融资这边，沈卓已经把周宁介绍给陈曦了。';
  assert.equal(analysisFor(scoped, [fact(scoped, { projectId: 'project' })]).relationships.length, 1);
});

test('discovery keeps business counterparties in natural loan, subsidiary and investment syntax', () => {
  for (const [name, quote] of [
    ['远航银行', '宁川科技已经拿到远航银行发放的贷款'],
    ['江澜设备', '江澜设备现在是云杉产业的子公司'],
    ['启源投资', '启源投资投资宁川科技'],
    ['宁川科技', '启源投资投资宁川科技'],
  ]) assert.equal(businessNodeAllowed(name, quote), true);
  assert.equal(businessNodeAllowed('启源投资', '启源投资今晚没空'), false);
});

test('strict generation schema prevents percentage on investment without relaxing local validation', () => {
  const text = '启源投资投资宁川科技，并持有宁川科技18%股权。';
  const c = prepareCloudCase(caseFor(text)), variants = buildExtractionRequest(c.caseFile, c.batches[0]).schema.properties.facts.items.anyOf;
  const investment = variants.find(v => v.properties.kind.enum.includes('investment'));
  assert.equal(investment.properties.percentage.type, 'null');
  assert.equal(investment.properties.viaId.type, 'null');
  const ownership = variants.find(v => v.properties.kind.enum.includes('ownership'));
  assert.deepEqual(ownership.properties.percentage.type, ['number', 'null']);
  const introduction = variants.find(v => v.properties.kind.enum.includes('introduction'));
  assert.equal(introduction.properties.viaId.type, 'string');
  assert.throws(() => analysisFor(text, [fact(text, { kind: 'investment', sourceId: 'capital', targetId: 'n', viaId: null, percentage: 18 })]));
});

test('colloquial denial no longer becomes positive review; neighboring rumor/history remain separate', () => {
  const denied = '澄明律所从来没给江澜设备提供财务顾问服务，别给他们挂顾问。';
  const rumor = '听说星海资本投资宁芯电子，这个还没确认。';
  const history = '叶蓁早已离职，不再担任宁川科技总经理了。';
  for (const stance of ['affirmed', 'negated', 'uncertain']) {
    const a = analysisFor(denied + rumor + history, [fact(denied, { kind: 'advisory', sourceId: 'law', targetId: 'jiang', viaId: null, stance }), fact(rumor, { kind: 'investment', sourceId: 'x', targetId: 'chip', viaId: null, stance: 'uncertain' }), fact(history, { kind: 'employment', sourceId: 'ye', targetId: 'n', viaId: null, role: '总经理', stance: 'historical' })]);
    assert.deepEqual(a.relationships.map(r => r.status), ['rejected', 'review', 'historical']);
  }
  const double = '澄明律所不是没给江澜设备提供财务顾问服务。';
  assert.equal(analysisFor(double, [fact(double, { kind: 'advisory', sourceId: 'law', targetId: 'jiang', viaId: null, stance: 'negated' })]).relationships[0].status, 'review');
});
