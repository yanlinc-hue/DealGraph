import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeRelations, addBook, addEntity, bookFromCase, emptyWorkbench, taskBucket, today, validateSnapshot, validateWorkbench } from '../src/dealgraph/workbench-state.ts';
import { decryptWorkbench, encryptWorkbench } from '../src/dealgraph/workbench-vault.ts';
import { finalizeCloudAnalysis, prepareCloudCase } from '../src/dealgraph/relationships/cloud-extraction.ts';

const sample = JSON.parse(readFileSync(new URL('../src/dealgraph/relationships/sample.json', import.meta.url), 'utf8'));
const secret = 'synthetic-vault-passphrase-only';
function fixture() {
  const w = addBook(emptyWorkbench(), bookFromCase({ ...sample, dataClass: 'user-provided' }, 'a'));
  w.notes = [{ id: 'note-a', bookId: 'a', entityId: 'person-zhou', projectId: 'project-b', text: 'PRIVATE_SYNTHETIC_NOTE_NOT_FOR_MODEL', at: '2026-09-09' }];
  w.tasks = [{ id: 'task-a', bookId: 'a', entityId: 'person-zhou', projectId: 'project-b', title: '确认清单', due: '2026-09-10', done: false }];
  w.projects = [{ bookId: 'a', projectId: 'project-b', stage: '接洽', brief: '金额待确认' }];
  w.outreach = [{ id: 'outreach-a', bookId: 'a', projectId: 'project-b', entityId: 'org-xinghai', stage: '已发材料', next: '等回复' }];
  return validateWorkbench(w);
}
test('complete personal workbench whitelist preserves records and excludes credentials', () => {
  const w = fixture(); w.apiKey = 'UNEXPECTED_KEY_FIELD'; w.books[0].input.apiKey = 'UNEXPECTED_KEY_FIELD'; w.books[0].analysis.apiKey = 'UNEXPECTED_KEY_FIELD';
  const clean = validateWorkbench(w);
  assert.equal(JSON.stringify(clean).includes('UNEXPECTED_KEY_FIELD'), false);
  assert.equal(clean.notes.length, 1); assert.equal(clean.outreach[0].stage, '已发材料');
  assert.equal(JSON.stringify(prepareCloudCase(clean.books[0].input)).includes('PRIVATE_SYNTHETIC_NOTE_NOT_FOR_MODEL'), false);
});
test('independent imports retain old tasks, model snapshot, and repeated IDs without auto-merge', () => {
  const a = fixture(), before = structuredClone(a.books[0]);
  const b = addBook(a, bookFromCase(sample, 'b'));
  assert.equal(b.books.length, 2); assert.equal(b.activeBookId, 'b'); assert.deepEqual(b.books[0], before);
  assert.equal(b.tasks[0].bookId, 'a'); assert.equal(b.books[0].input.entities[0].id, b.books[1].input.entities[0].id);
  assert.equal(b.books[0].input.documents[0].sourceId, b.books[1].input.documents[0].sourceId);
  assert.throws(() => addBook(b, b.books[0]));
  assert.equal(validateWorkbench(b).books.length, 2);
});
test('adding manual entities preserves analysis and does not infer business facts', () => {
  const a = fixture(), before = structuredClone(a.books[0].analysis.relationships);
  const b = addEntity(a, { id: 'new-person', name: '周宁', kind: 'person', category: '投资人' });
  assert.equal(b.books[0].input.entities.length, a.books[0].input.entities.length + 1);
  assert.deepEqual(b.books[0].analysis.relationships, before);
  assert.equal(activeRelations(b.books[0], 'new-person').length, 0);
  assert.deepEqual(b.tasks, a.tasks);
  assert.equal(validateWorkbench(b).books[0].input.dataClass, 'user-provided');
  const empty = addEntity(emptyWorkbench(), { id: 'first', name: '项目一', kind: 'project' }, 'book-first');
  assert.equal(empty.books[0].input.documents.length, 0); assert.equal(empty.books[0].analysis.relationships.length, 0);
});
test('due-date grouping, completion undo and local calendar dates are deterministic', () => {
  const t = fixture().tasks[0];
  assert.equal(taskBucket(t, '2026-09-09'), 'later'); assert.equal(taskBucket(t, '2026-09-10'), 'today'); assert.equal(taskBucket(t, '2026-09-11'), 'overdue');
  assert.equal(taskBucket({ ...t, due: '' }, '2026-09-11'), 'undated'); assert.equal(taskBucket({ ...t, done: true }, '2026-09-11'), 'done');
  assert.equal(today(new Date(2026, 8, 9, 1)), '2026-09-09');
});
test('real entries created from demo go into a separate book without relabeling synthetic relations', () => {
  const demo = addBook(emptyWorkbench(), bookFromCase(sample, 'demo'));
  const next = addEntity(demo, { id: 'new', name: '真实客户占位', kind: 'organization' }, 'real');
  assert.equal(next.books.length, 2); assert.equal(next.activeBookId, 'real');
  assert.equal(next.books[0].input.dataClass, 'synthetic'); assert.deepEqual(next.books[0], demo.books[0]);
  assert.equal(next.books[1].input.dataClass, 'user-provided'); assert.equal(next.books[1].analysis.relationships.length, 0);
});
test('reject dangling references, wrong kind, duplicate identities, impossible dates and future formats', () => {
  for (const mutate of [w => w.tasks[0].entityId = 'missing', w => w.tasks[0].projectId = 'person-zhou', w => w.notes[0].bookId = 'missing', w => w.tasks[0].due = '2026-02-30', w => w.tasks[0].done = 'yes', w => w.projects[0].stage = '自动成交', w => w.tasks.push(w.tasks[0]), w => w.outreach.push({ ...w.outreach[0], id: 'duplicate-pair' }), w => w.schema = 'v2']) {
    const w = fixture(); mutate(w); assert.throws(() => validateWorkbench(w));
  }
});
test('reject structural snapshot inventions and repair untrusted summary counts', () => {
  for (const mutate of [w => w.books[0].analysis.relationships[0].sourceId = 'missing', w => w.books[0].analysis.relationships[0].sourceId = 'org-ningchuan', w => w.books[0].analysis.relationships[0].evidenceIds = [], w => w.books[0].analysis.relationships[0].independentSources = 999, w => w.books[0].analysis.relationships[0].percentage = 18, w => { const r = w.books[0].analysis.relationships[0]; r.kind = 'introduction'; r.targetId = 'person-zhou'; r.viaId = undefined; }, w => w.books[0].analysis.evidence[0].quote = 'UNSUPPORTED QUOTE']) {
    const w = fixture(); mutate(w); assert.throws(() => validateWorkbench(w));
  }
  const w = fixture(); w.books[0].analysis.summary.supported = 999;
  assert.notEqual(validateWorkbench(w).books[0].analysis.summary.supported, 999);
});
test('model snapshots remain model results after validation, not rerun rule analysis', () => {
  const input = { schema: 'dealgraph.relationship-case.v1', dataClass: 'synthetic', title: '模型归档测试', asOf: '2026-09-09', entities: [{ id: 'p', name: '张明', kind: 'person' }, { id: 'o', name: '测试资本', kind: 'organization' }], documents: [{ id: 'd', title: '任职公告', sourceId: 's', sourceKind: 'announcement', publishedAt: '2026-09-01', text: '张明担任测试资本投资合伙人。' }] };
  const analysis = finalizeCloudAnalysis(input, [{ documentIds: ['d'], output: { facts: [{ documentId: 'd', sourceId: 'p', targetId: 'o', kind: 'employment', quote: '张明担任测试资本投资合伙人。', projectId: null, viaId: null, role: '投资合伙人', percentage: null, stance: 'affirmed', validFrom: null, validTo: null }] } }]);
  assert.deepEqual(validateSnapshot(analysis, input).relationships, analysis.relationships);
});
test('real WebCrypto roundtrip includes all collections, notes, statuses and hidden relations', async () => {
  const original = addBook(fixture(), bookFromCase(sample, 'b'));
  const ciphertext = await encryptWorkbench(original, secret), second = await encryptWorkbench(original, secret);
  assert.notEqual(ciphertext, second); assert.ok(!ciphertext.includes('周宁')); assert.ok(!ciphertext.includes(secret));
  assert.deepEqual(await decryptWorkbench(ciphertext, secret), validateWorkbench(original));
  const restored = await decryptWorkbench(ciphertext, secret); assert.equal(restored.books[0].analysis.relationships.filter(r => r.status === 'rejected').length, original.books[0].analysis.relationships.filter(r => r.status === 'rejected').length);
});
test('wrong password and tampered salt/IV/ciphertext fail without mutating current data', async () => {
  const original = fixture(), before = JSON.stringify(original), encrypted = await encryptWorkbench(original, secret);
  await assert.rejects(decryptWorkbench(encrypted, 'wrong-password-0000'));
  for (const field of ['salt', 'iv', 'ciphertext']) { const data = JSON.parse(encrypted); data[field] = (data[field][0] === 'A' ? 'B' : 'A') + data[field].slice(1); await assert.rejects(decryptWorkbench(JSON.stringify(data), secret)); }
  assert.equal(JSON.stringify(original), before);
});
test('reject unsupported parameters, noncanonical encoding, oversize input and weak password', async () => {
  const encrypted = JSON.parse(await encryptWorkbench(fixture(), secret));
  for (const override of [{ iterations: 1 }, { iterations: 999999999 }, { schema: 'v2' }, { cipher: 'AES-CBC' }, { salt: ' ' + encrypted.salt }, { iv: 'eA==' }]) await assert.rejects(decryptWorkbench(JSON.stringify({ ...encrypted, ...override }), secret));
  await assert.rejects(encryptWorkbench(fixture(), 'short'));
  await assert.rejects(decryptWorkbench('x'.repeat(16 * 1024 * 1024 + 1), secret));
});
test('multi-megabyte valid archive can be decrypted without regex stack overflow', async () => {
  let state = emptyWorkbench();
  for (let b = 0; b < 4; b++) state = addBook(state, bookFromCase({ schema: 'dealgraph.relationship-case.v1', dataClass: 'synthetic', title: '大文件往返测试', asOf: '2026-09-09', entities: [{ id: 'p', name: '虚构客户', kind: 'person' }], documents: Array.from({ length: 50 }, (_, i) => ({ id: `d-${i}`, title: '虚构空白材料', sourceKind: 'chat', sourceId: `s-${i}`, publishedAt: '2026-09-08', text: 'x'.repeat(40000) })) }, `book-${b}`));
  const ciphertext = await encryptWorkbench(state, secret);
  assert.ok(ciphertext.length > 10_000_000); assert.equal((await decryptWorkbench(ciphertext, secret)).books.length, 4);
});
