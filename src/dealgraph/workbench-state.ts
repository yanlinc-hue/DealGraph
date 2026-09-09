import { analyzeRelationshipCase, RELATION_LABELS, validateRelationshipCase } from './relationships/engine.ts';
import type { BusinessRelationship, RelationshipAnalysis, RelationshipCase, RelationshipEntity, RelationshipEvidence } from './relationships/types.ts';

export const STAGES = ['未设置', '接洽', '签约准备', '执行中', '交割中', '已完成', '暂停'] as const;
export const OUTREACH = ['未联系', '已联系', '已发材料', 'NDA', '有兴趣', '尽调', '已拒绝'] as const;
export type Book = { id: string; input: RelationshipCase; analysis: RelationshipAnalysis; origin: 'rules' | 'model' | 'snapshot' };
export type Note = { id: string; bookId: string; entityId?: string; projectId?: string; text: string; at: string };
export type Task = { id: string; bookId: string; entityId?: string; projectId?: string; title: string; due: string; done: boolean };
export type ProjectPlan = { bookId: string; projectId: string; stage: typeof STAGES[number]; brief: string };
export type Outreach = { id: string; bookId: string; projectId: string; entityId: string; stage: typeof OUTREACH[number]; next: string };
export type Workbench = { schema: 'dealgraph.workbench.v1'; books: Book[]; activeBookId: string; notes: Note[]; tasks: Task[]; projects: ProjectPlan[]; outreach: Outreach[] };
export const MAX_VAULT_BYTES = 16 * 1024 * 1024;
export const newId = (): string => crypto.randomUUID();
export function today(now = new Date()): string { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function emptyWorkbench(): Workbench { return { schema: 'dealgraph.workbench.v1', books: [], activeBookId: '', notes: [], tasks: [], projects: [], outreach: [] }; }
export function bookFromCase(input: unknown, id = newId(), analysis?: RelationshipAnalysis, origin: Book['origin'] = 'rules'): Book {
  const clean = validateRelationshipCase(input);
  return { id, input: clean, analysis: analysis ?? analyzeRelationshipCase(clean), origin };
}
export function addBook(state: Workbench, book: Book): Workbench {
  if (state.books.length >= 20 || state.books.some(item => item.id === book.id)) throw new Error('最多保留 20 个资料集，或资料集编号重复。请另存新的工作台。');
  // Separate material sets deliberately: same-name identities and source counts never auto-merge.
  return { ...state, books: [...state.books, book], activeBookId: book.id };
}
export function addEntity(state: Workbench, entity: RelationshipEntity, id = newId()): Workbench {
  const book = state.books.find(item => item.id === state.activeBookId);
  if (!book || book.input.dataClass === 'synthetic') return addBook(state, bookFromCase({ schema: 'dealgraph.relationship-case.v1', dataClass: 'user-provided', title: '我的客户资料', asOf: today(), entities: [entity], documents: [] }, id));
  const input = validateRelationshipCase({ ...book.input, dataClass: 'user-provided', entities: [...book.input.entities, entity] });
  const next = { ...book, input, analysis: { ...book.analysis, dataClass: input.dataClass, entities: input.entities } };
  return { ...state, books: state.books.map(item => item.id === book.id ? next : item) };
}
export function activeRelations(book: Book, entityId: string): BusinessRelationship[] {
  return book.analysis.relationships.filter(r => r.status !== 'rejected' && [r.sourceId, r.targetId, r.viaId].includes(entityId));
}
export function taskBucket(task: Task, date: string): 'done' | 'overdue' | 'today' | 'later' | 'undated' {
  return task.done ? 'done' : !task.due ? 'undated' : task.due < date ? 'overdue' : task.due === date ? 'today' : 'later';
}

function fail(): never { throw new Error('工作台文件内容不完整、格式不支持或超过限制；当前资料未更改。'); }
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Record<string, unknown>; }
function str(v: unknown, max = 160, blank = false): string { if (typeof v !== 'string' || v.length > max || (!blank && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(); return v; }
function arr(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) fail(); return v; }
function choose<T extends string>(v: unknown, options: readonly T[]): T { if (!options.includes(v as T)) fail(); return v as T; }
function integer(v: unknown, max: number): number { if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) fail(); return v as number; }
export function validDay(v: unknown, blank = false): string {
  if (v === '' && blank) return '';
  const s = str(v, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) fail(); return s;
}
function distinct<T>(items: T[], id: (v: T) => string): T[] { if (new Set(items.map(id)).size !== items.length) fail(); return items; }
function optional(v: Record<string, unknown>, field: string, max = 160): Record<string, string> { return v[field] === undefined ? {} : { [field]: str(v[field], max) }; }

/** Deep whitelist for local snapshots. Restoring is not verification of a model or of the underlying claims. */
export function validateSnapshot(raw: unknown, input: RelationshipCase): RelationshipAnalysis {
  const a = obj(raw);
  if (a.schema !== 'dealgraph.relationship-analysis.v1' || a.title !== input.title || a.asOf !== input.asOf || a.dataClass !== input.dataClass) fail();
  const snapshotEntities = validateRelationshipCase({ ...input, entities: a.entities }).entities;
  if (JSON.stringify(snapshotEntities) !== JSON.stringify(input.entities)) fail();
  const entities = new Map(input.entities.map(e => [e.id, e]));
  const docs = new Map(input.documents.map(d => [d.id, d]));
  const evidence = distinct(arr(a.evidence, 20_000).map(rawItem => {
    const e = obj(rawItem); const doc = docs.get(str(e.documentId, 100)); if (!doc) fail();
    const quote = str(e.quote, 50_000); if (!doc.text.includes(quote) || e.documentTitle !== doc.title || e.sourceId !== doc.sourceId || e.sourceKind !== doc.sourceKind || e.publishedAt !== doc.publishedAt) fail();
    return { id: str(e.id, 160), documentId: doc.id, documentTitle: doc.title, sourceId: doc.sourceId, sourceKind: doc.sourceKind, publishedAt: doc.publishedAt, quote, stance: choose(e.stance, ['affirmed', 'negated', 'uncertain', 'historical'] as const), reason: str(e.reason, 2000, true) } satisfies RelationshipEvidence;
  }), e => e.id);
  const evidenceIds = new Set(evidence.map(e => e.id));
  const evidenceMap = new Map(evidence.map(e => [e.id, e]));
  const relationships = distinct(arr(a.relationships, 20_000).map(rawItem => {
    const r = obj(rawItem); const sourceId = str(r.sourceId, 100), targetId = str(r.targetId, 100);
    if (!entities.has(sourceId) || !entities.has(targetId) || sourceId === targetId) fail();
    const kind = choose(r.kind, Object.keys(RELATION_LABELS) as BusinessRelationship['kind'][]);
    const sourceKind = entities.get(sourceId)!.kind, targetKind = entities.get(targetId)!.kind;
    const validKinds = kind === 'employment' ? sourceKind === 'person' && targetKind === 'organization'
      : kind === 'decision_authority' ? sourceKind === 'person' && targetKind !== 'person'
      : kind === 'subsidiary' ? sourceKind === 'organization' && targetKind === 'organization'
      : kind === 'project_role' ? sourceKind !== 'project' && targetKind === 'project'
      : kind === 'ownership' || kind === 'acquisition' ? sourceKind !== 'project' && targetKind === 'organization'
      : kind === 'investment' || kind === 'advisory' ? sourceKind !== 'project' && targetKind !== 'person'
      : kind === 'introduction' ? sourceKind === 'person' && targetKind === 'person' && r.viaId !== undefined
      : sourceKind !== 'project' && targetKind !== 'project';
    if (!validKinds) fail();
    if (r.projectId !== undefined && entities.get(str(r.projectId, 100))?.kind !== 'project') fail();
    if (r.viaId !== undefined && (kind !== 'introduction' || entities.get(str(r.viaId, 100))?.kind !== 'person' || r.viaId === sourceId || r.viaId === targetId)) fail();
    if (r.percentage !== undefined && (!['ownership', 'acquisition'].includes(kind) || typeof r.percentage !== 'number' || !Number.isFinite(r.percentage) || r.percentage < 0 || r.percentage > 100)) fail();
    const ids = arr(r.evidenceIds, 20_000).map(id => { const s = str(id, 160); if (!evidenceIds.has(s)) fail(); return s; });
    const referenced = ids.map(id => evidenceMap.get(id)!);
    if (!ids.length || integer(r.independentSources, 1000) > new Set(referenced.map(e => e.sourceId)).size) fail();
    if (r.status === 'supported' && !referenced.some(e => e.stance === 'affirmed')) fail();
    if (r.status === 'rejected' && !referenced.some(e => e.stance === 'negated')) fail();
    return { id: str(r.id, 160), sourceId, targetId, kind, label: str(r.label, 100_000), status: choose(r.status, ['supported', 'review', 'conflicted', 'historical', 'rejected'] as const), confidence: choose(r.confidence, ['high', 'medium', 'low'] as const), evidenceIds: [...new Set(ids)], independentSources: integer(r.independentSources, 1000), rationale: str(r.rationale, 4000, true), ...optional(r, 'projectId', 100), ...optional(r, 'viaId', 100), ...optional(r, 'role', 100_000), ...(r.percentage !== undefined ? { percentage: r.percentage as number } : {}) } satisfies BusinessRelationship;
  }), r => r.id);
  const issues = distinct(arr(a.issues, 20_000).map(rawItem => {
    const i = obj(rawItem); if (i.documentId !== undefined && !docs.has(str(i.documentId, 100))) fail();
    return { id: str(i.id, 160), kind: choose(i.kind, ['ambiguous_identity', 'unsupported_language', 'future_source', 'duplicate_source', 'invalid_input', 'insufficient_evidence'] as const), message: str(i.message, 4000), ...optional(i, 'documentId', 100), ...optional(i, 'quote', 50_000) };
  }), i => i.id);
  const counts = { supported: 0, review: 0, conflicted: 0, historical: 0, rejected: 0 };
  relationships.forEach(r => { counts[r.status] += 1; });
  return { schema: 'dealgraph.relationship-analysis.v1', title: input.title, asOf: input.asOf, dataClass: input.dataClass, entities: input.entities, relationships, evidence, issues, summary: { ...counts, documents: input.documents.length, evidenceCoverage: relationships.length ? relationships.filter(r => r.evidenceIds.length).length / relationships.length : 0 } };
}
export function validateWorkbench(raw: unknown): Workbench {
  const w = obj(raw); if (w.schema !== 'dealgraph.workbench.v1') fail();
  const books = distinct(arr(w.books, 20).map(rawBook => {
    const b = obj(rawBook); const input = validateRelationshipCase(b.input);
    return { id: str(b.id, 100), input, analysis: validateSnapshot(b.analysis, input), origin: choose(b.origin, ['rules', 'model', 'snapshot'] as const) };
  }), b => b.id);
  const bookMap = new Map(books.map(b => [b.id, b]));
  const activeBookId = str(w.activeBookId, 100, true); if (books.length ? !bookMap.has(activeBookId) : activeBookId !== '') fail();
  const ref = (r: Record<string, unknown>, projectRequired = false, entityRequired = false) => {
    const bookId = str(r.bookId, 100); const b = bookMap.get(bookId); if (!b) fail();
    if (projectRequired && r.projectId === undefined || entityRequired && r.entityId === undefined) fail();
    if (r.projectId !== undefined && !b.input.entities.some(e => e.id === r.projectId && e.kind === 'project')) fail();
    if (r.entityId !== undefined && !b.input.entities.some(e => e.id === r.entityId && e.kind !== 'project')) fail();
    return { bookId, ...optional(r, 'entityId', 100), ...optional(r, 'projectId', 100) };
  };
  const notes = distinct(arr(w.notes, 5000).map(rawNote => { const n = obj(rawNote); return { ...ref(n), id: str(n.id, 100), text: str(n.text, 10_000), at: validDay(n.at) }; }), n => n.id);
  const tasks = distinct(arr(w.tasks, 5000).map(rawTask => { const t = obj(rawTask); if (typeof t.done !== 'boolean') fail(); return { ...ref(t), id: str(t.id, 100), title: str(t.title, 500), due: validDay(t.due, true), done: t.done }; }), t => t.id);
  const projects = distinct(arr(w.projects, 1000).map(rawProject => { const p = obj(rawProject); return { ...ref(p, true), projectId: str(p.projectId, 100), stage: choose(p.stage, STAGES), brief: str(p.brief, 4000, true) }; }), p => `${p.bookId}/${p.projectId}`);
  const outreach = distinct(arr(w.outreach, 5000).map(rawItem => { const o = obj(rawItem); return { ...ref(o, true, true), id: str(o.id, 100), projectId: str(o.projectId, 100), entityId: str(o.entityId, 100), stage: choose(o.stage, OUTREACH), next: str(o.next, 1000, true) }; }), o => o.id);
  distinct(outreach, o => `${o.bookId}/${o.projectId}/${o.entityId}`);
  const result: Workbench = { schema: 'dealgraph.workbench.v1', books, activeBookId, notes, tasks, projects, outreach };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 10 * 1024 * 1024) throw new Error('工作台超过 10 MB，未加入本次内容。请先保存现有工作台，再新建工作台导入。');
  return result;
}
