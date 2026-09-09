import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionRequest, finalizeCloudAnalysis, prepareCloudCase } from '../src/dealgraph/relationships/cloud-extraction.ts';

const entities = [
  { id: 'person', name: '罗锦', kind: 'person' },
  { id: 'introducer', name: '裴岚', kind: 'person' },
  { id: 'recipient', name: '苏衡', kind: 'person' },
  { id: 'company', name: '衡石科技', kind: 'organization' },
  { id: 'child', name: '渡川设备', kind: 'organization' },
  { id: 'investor', name: '泽谷资本', kind: 'organization' },
  { id: 'project', name: '衡石融资项目', kind: 'project' },
];
const employment = '罗锦担任衡石科技董事长。';
function fixture(text = employment, documentPatch = {}) {
  return { schema: 'dealgraph.relationship-case.v1', title: '全虚构字段恢复测试', dataClass: 'synthetic', asOf: '2026-09-09', entities: structuredClone(entities), documents: [{ id: 'd', sourceId: 'chat-source', title: '虚构材料', sourceKind: 'chat', publishedAt: '2026-09-08', text, ...documentPatch }] };
}
function fact(quote = employment, patch = {}) {
  return { sourceId: 'person', targetId: 'company', kind: 'employment', role: '董事长', percentage: null, projectId: null, viaId: null, documentId: 'd', quote, stance: 'affirmed', validFrom: null, validTo: null, ...patch };
}
function run(input, facts) { return finalizeCloudAnalysis(input, [{ documentIds: ['d'], output: { facts } }]); }
function only(result) { assert.equal(result.relationships.length, 1); return result.relationships[0]; }

test('unsupported year-end expiry is removed without treating completed investment as expired', () => {
  const quote = '泽谷资本已于2023年完成对衡石科技的投资，和另一轮意向不是一回事。';
  const input = fixture(quote, { sourceKind: 'announcement' });
  const raw = fact(quote, { sourceId: 'investor', kind: 'investment', role: null, stance: 'historical', validTo: '2023-12-31' });
  const before = JSON.stringify({ input, raw });
  const result = run(input, [raw]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'affirmed');
  assert.equal(result.issues.filter(i => i.kind === 'invalid_input').length, 2);
  assert.equal(JSON.stringify({ input, raw }), before);
  assert.ok(result.issues.every(i => !i.message.includes('泽谷') && !i.message.includes('2023')));
});

test('completed past investment without fabricated dates is provisional, not an expired state', () => {
  const quote = '泽谷资本已经完成了对衡石科技的投资。';
  const result = run(fixture(quote, { sourceKind: 'announcement' }), [fact(quote, { sourceId: 'investor', kind: 'investment', role: null, stance: 'historical' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'affirmed');
  assert.ok(result.issues.some(i => i.message.startsWith('状态已调整')));
});

test('relative event date is discarded while a completed business introduction remains available', () => {
  const quote = '为推进衡石融资项目，裴岚昨天已将罗锦介绍给苏衡，双方完成了首次融资沟通。';
  const result = run(fixture(quote), [fact(quote, { kind: 'introduction', targetId: 'recipient', viaId: 'introducer', projectId: 'project', role: null, validFrom: '2026-09-07' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'affirmed');
  assert.ok(result.issues.some(i => i.message.startsWith('日期已忽略')));
});

test('discarding fabricated validity never makes explicit denial affirmative', () => {
  const quote = '泽谷资本没有投资衡石科技。';
  const result = run(fixture(quote), [fact(quote, { sourceId: 'investor', kind: 'investment', role: null, stance: 'negated', validTo: '2022-12-31' })]);
  assert.equal(only(result).status, 'rejected');
  assert.equal(result.evidence[0].stance, 'negated');
});

test('discarding fabricated date cannot make pending investment completed', () => {
  const quote = '泽谷资本计划投资衡石科技，尚待投委会审批。';
  const result = run(fixture(quote), [fact(quote, { sourceId: 'investor', kind: 'investment', role: null, validFrom: '2027-01-01' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'uncertain');
});

test('real textual expiry remains historical even when a different model end date is removed', () => {
  const quote = '罗锦担任衡石科技董事长，任期截至2025年6月30日。';
  const result = run(fixture(quote), [fact(quote, { validTo: '2028-12-31' })]);
  assert.equal(only(result).status, 'historical');
});

test('current employment cannot retain a historical label derived from an invented expiry', () => {
  const quote = '罗锦现任衡石科技董事长。';
  const result = run(fixture(quote), [fact(quote, { stance: 'historical', validTo: '2025-12-31' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'uncertain');
});

test('real document expiry is not erased by optional field recovery', () => {
  const result = run(fixture(employment, { validTo: '2025-09-01' }), [fact(employment, { validTo: '2025-12-31' })]);
  assert.equal(only(result).status, 'historical');
});

test('past explicit termination is not universally promoted to an active investment', () => {
  const quote = '泽谷资本曾完成对衡石科技的投资，但已终止该投资安排。';
  const result = run(fixture(quote), [fact(quote, { sourceId: 'investor', kind: 'investment', role: null, stance: 'historical' })]);
  assert.notEqual(only(result).status, 'supported');
  assert.notEqual(result.evidence[0].stance, 'affirmed');
});

test('generic denial of universal authority does not negate a named mandate', () => {
  const quote = '在衡石融资项目中，罗锦拥有衡石科技最终审批权，并非所有财务经理都有这个权限。';
  const result = run(fixture(quote), [fact(quote, { kind: 'decision_authority', role: '最终审批权', projectId: 'project' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(result.evidence[0].stance, 'affirmed');
});

test('English universal qualification does not negate named authority', () => {
  const quote = '罗锦 has final approval authority over 衡石科技 corporate financing, not every manager has this authority.';
  const result = run(fixture(quote), [fact(quote, { kind: 'decision_authority', role: 'final approval authority' })]);
  assert.equal(result.evidence[0].stance, 'affirmed');
});

test('a following pronoun denial is not lost after skipping a universal qualification', () => {
  const quote = '罗锦拥有衡石科技最终审批权，不是每个经理都有这个权限，他其实也没有这个权限。';
  const result = run(fixture(quote), [fact(quote, { kind: 'decision_authority', role: '最终审批权' })]);
  assert.equal(only(result).status, 'rejected');
});

test('same-claim unconfirmed and pending qualifiers still apply', () => {
  for (const suffix of ['但这个消息尚未证实。', '该权限尚待董事会批准。']) {
    const quote = `罗锦拥有衡石科技最终审批权，${suffix}`;
    const result = run(fixture(quote), [fact(quote, { kind: 'decision_authority', role: '最终审批权' })]);
    assert.equal(result.evidence[0].stance, 'uncertain');
  }
});

test('correct child-to-parent direction is retained and reversed fact is visibly isolated', () => {
  const quote = '渡川设备是衡石科技的全资子公司。';
  const correct = fact(quote, { sourceId: 'child', targetId: 'company', kind: 'subsidiary', role: null });
  const wrong = { ...correct, sourceId: 'company', targetId: 'child' };
  const result = run(fixture(`${quote}\n${employment}`), [wrong, fact()]);
  assert.equal(only(result).kind, 'employment');
  assert.ok(result.issues.some(i => i.message.startsWith('关系已隔离')));
  assert.equal(only(run(fixture(quote), [correct])).sourceId, 'child');
});

test('isolated reversed denial cannot leave its affirmative counterpart visible in either input order', () => {
  const positive = '渡川设备是衡石科技的子公司。';
  const denial = '渡川设备不是衡石科技的子公司。';
  const input = fixture(`${positive}\n${denial}`);
  const good = fact(positive, { sourceId: 'child', kind: 'subsidiary', role: null });
  const bad = fact(denial, { sourceId: 'company', targetId: 'child', kind: 'subsidiary', role: null, stance: 'negated' });
  for (const facts of [[good, bad], [bad, good]]) {
    const result = run(input, facts);
    assert.equal(result.relationships.length, 0);
    assert.ok(result.issues.some(i => i.message.startsWith('关系暂缓显示')));
  }
});

test('recovering a date on a denial still participates in conflict aggregation', () => {
  const denial = '罗锦没有担任衡石科技董事长。';
  const result = run(fixture(`${employment}\n${denial}`), [fact(), fact(denial, { stance: 'negated', validTo: '2024-12-31' })]);
  assert.equal(only(result).status, 'conflicted');
});

test('unsupported role recovery is reported and cannot become supported on its own', () => {
  const result = run(fixture(employment, { sourceKind: 'announcement' }), [fact(employment, { role: '首席技术官' })]);
  assert.equal(only(result).status, 'review');
  assert.equal(only(result).role, undefined);
  assert.ok(result.issues.some(i => i.message.startsWith('角色已忽略')));
});

test('schema, identity, references and malformed dates still fail closed', () => {
  for (const patch of [{ surprise: true }, { sourceId: 'unknown' }, { documentId: 'unknown' }, { quote: '罗锦投资了一家不存在于原文的公司。' }, { validTo: 'last year' }, { validFrom: '2026-13-01' }, { percentage: 42 }]) {
    assert.throws(() => run(fixture(), [fact(), fact(employment, patch)]));
  }
  assert.throws(() => finalizeCloudAnalysis(fixture(), []));
  assert.throws(() => finalizeCloudAnalysis(fixture(), [{ documentIds: ['d', 'd'], output: { facts: [fact()] } }]));
});

test('unsubstantiated percentage remains a hard failure rather than erasing a correction', () => {
  const quote = '泽谷资本持有衡石科技18%股权，不是28%。';
  assert.throws(() => run(fixture(quote), [fact(quote, { sourceId: 'investor', kind: 'ownership', role: null, percentage: 28 })]));
});

test('empty model output remains empty and prompt adds generic date and direction constraints', () => {
  assert.equal(run(fixture(), []).relationships.length, 0);
  const input = fixture();
  const prompt = buildExtractionRequest(input, prepareCloudCase(input).batches[0]);
  assert.match(prompt.instructions, /Never expand a bare year/);
  assert.match(prompt.instructions, /child is always sourceId/);
  assert.match(prompt.instructions, /past completed investment/);
});

test('completed investment diligence or a transaction proposal is not promoted to a completed deal', () => {
  for (const quote of ['泽谷资本已完成对衡石科技的投资尽调。', '泽谷资本已完成对衡石科技的投资方案。']) {
    const result = run(fixture(quote), [fact(quote, { sourceId: 'investor', kind: 'investment', role: null, stance: 'historical' })]);
    assert.ok(result.evidence.every(e => e.stance !== 'affirmed'));
  }
});
