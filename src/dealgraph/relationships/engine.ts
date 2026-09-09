import type {
  AnalysisIssue, BusinessRelationship, EntityKind, RelationKind, RelationshipAnalysis,
  RelationshipCase, RelationshipDocument, RelationshipEntity, RelationshipEvidence,
  RelationStatus, SourceKind,
} from './types.ts';
import { commercialRelationAllowed } from './commercial-scope.ts';

export const RELATION_LABELS: Record<RelationKind, string> = {
  employment: '任职', decision_authority: '决策权', ownership: '持股', investment: '投资',
  advisory: '顾问', lending: '借贷', acquisition: '收购', subsidiary: '子公司',
  project_role: '项目角色', introduction: '已引荐', cooperation: '合作',
};

const ENTITY_KINDS: EntityKind[] = ['person', 'organization', 'project'];
const SOURCE_KINDS: SourceKind[] = ['registry', 'signed_agreement', 'announcement', 'meeting_notes', 'email', 'chat', 'rumor'];
const PRIMARY = new Set<SourceKind>(['registry', 'signed_agreement', 'announcement']);
const SECONDARY = new Set<SourceKind>(['meeting_notes', 'email']);
const MAX_ENTITIES = 1000;
const MAX_DOCUMENTS = 1000;
const MAX_TOTAL_TEXT = 2_000_000;
const MARKER = /\uE000(\d+)\uE001/g;

function fail(message: string): never { throw new Error(`关系文件无法分析：${message}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} 应为对象。`);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || [...value].some(character => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xE000 || code === 0xE001;
  })) fail(`${field} 为空、过长或包含不支持的字符。`);
  return value.trim();
}
function date(value: unknown, field: string): string {
  const result = string(value, field, 32);
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/.test(result)) fail(`${field} 请使用 YYYY-MM-DD 或带时区的 ISO 日期。`);
  const stamp = Date.parse(result);
  const day = result.slice(0, 10);
  if (!Number.isFinite(stamp) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fail(`${field} 不是有效日期。`);
  return result;
}
function time(value: string, endOfDay = false): number { return Date.parse(value.length === 10 ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value); }

export function validateRelationshipCase(input: unknown): RelationshipCase {
  const data = object(input, '文件');
  if (data.schema !== 'dealgraph.relationship-case.v1') fail('不支持的格式版本。');
  if (data.dataClass !== 'synthetic' && data.dataClass !== 'user-provided') fail('请标明 synthetic 或 user-provided 数据类型。');
  const title = string(data.title, '标题');
  const asOf = date(data.asOf, '分析时点');
  if (!Array.isArray(data.entities) || data.entities.length > MAX_ENTITIES || data.entities.length === 0) fail(`请提供 1–${MAX_ENTITIES} 个已知节点。`);
  const ids = new Set<string>();
  const entities = data.entities.map((raw, index): RelationshipEntity => {
    const item = object(raw, `节点 ${index + 1}`);
    const id = string(item.id, '节点 ID', 100);
    if (ids.has(id)) fail('节点 ID 重复。');
    ids.add(id);
    const name = string(item.name, '节点名称', 100);
    if (!ENTITY_KINDS.includes(item.kind as EntityKind)) fail('节点类型应为 person、organization 或 project。');
    let aliases: string[] | undefined;
    if (item.aliases !== undefined) {
      if (!Array.isArray(item.aliases) || item.aliases.length > 30) fail('每个节点最多支持 30 个别名。');
      aliases = [...new Set(item.aliases.map(alias => string(alias, '节点别名', 100)))];
    }
    return { id, name, kind: item.kind as EntityKind, ...(aliases ? { aliases } : {}), ...(item.category !== undefined ? { category: string(item.category, '节点分类', 80) } : {}) };
  });
  if (!Array.isArray(data.documents) || data.documents.length > MAX_DOCUMENTS) fail(`最多支持 ${MAX_DOCUMENTS} 份本地文本。`);
  const documentIds = new Set<string>();
  let total = 0;
  const documents = data.documents.map((raw, index): RelationshipDocument => {
    const item = object(raw, `文本 ${index + 1}`);
    const id = string(item.id, '文本 ID', 100);
    if (documentIds.has(id)) fail('文本 ID 重复。');
    documentIds.add(id);
    if (!SOURCE_KINDS.includes(item.sourceKind as SourceKind)) fail('文本来源类型不受支持。');
    const text = string(item.text, '文本内容', 50_000);
    total += text.length;
    if (total > MAX_TOTAL_TEXT) fail('文本总量超过 200 万字符，请拆分文件。');
    const result: RelationshipDocument = { id, title: string(item.title, '文本标题'), sourceId: string(item.sourceId, '来源 ID', 100), sourceKind: item.sourceKind as SourceKind, publishedAt: date(item.publishedAt, '文本日期'), text };
    if (item.validFrom !== undefined) result.validFrom = date(item.validFrom, '生效日期');
    if (item.validTo !== undefined) result.validTo = date(item.validTo, '失效日期');
    if (result.validFrom && result.validTo && time(result.validFrom) > time(result.validTo, true)) fail('文本生效日期晚于失效日期。');
    if (item.projectId !== undefined) {
      const projectId = string(item.projectId, '项目 ID', 100);
      if (!entities.some(entity => entity.id === projectId && entity.kind === 'project')) fail('文本项目 ID 必须引用已知项目节点。');
      result.projectId = projectId;
    }
    return result;
  });
  if (data.interactions !== undefined) {
    if (!Array.isArray(data.interactions) || data.interactions.length > 10_000) fail('互动记录格式错误或超过 1 万条。');
    for (const raw of data.interactions) {
      const item = object(raw, '互动记录');
      if (!ids.has(string(item.sourceId, '互动起点', 100)) || !ids.has(string(item.targetId, '互动终点', 100))) fail('互动节点不在节点表中。');
      if (!Number.isSafeInteger(item.count) || (item.count as number) < 0) fail('互动次数必须为非负整数。');
      date(item.lastAt, '互动日期');
    }
  }
  return { schema: 'dealgraph.relationship-case.v1', dataClass: data.dataClass, title, asOf, entities, documents };
}

interface Mention { entity?: RelationshipEntity; text: string; ambiguous: boolean }
interface Candidate {
  kind: RelationKind; source: RelationshipEntity; target: RelationshipEntity; via?: RelationshipEntity;
  role?: string; percentage?: number; start: number; end: number; text: string; scope?: string;
}
interface Rule {
  kind: RelationKind; pattern: RegExp; reverse?: boolean; via?: string; role?: string;
}
const E = (name: string) => `(?<${name}>\uE000\\d+\uE001)`;
const A = E('a'); const B = E('b'); const C = E('c');
// Only explicit grammatical modifiers are accepted between known identities and predicates.
const M = '(?:\\s*(?:已经|目前|现任|曾经|曾|此前|原来|原|并未|没有|尚未|从未|不再|并非|不是|并不|未曾|未|不|拟|计划|准备|将会|将|可能|或许|据称|据传|预计|考虑|已|正在|正|正式|实际|直接|间接|仍|也|确认|明确|并|还|刚|\\b(?:has|have|had|is|are|was|were|not|never|no longer|formerly|currently|reportedly|allegedly|will|would|may|might|plans? to|planned to|proposes? to|intends? to|already|actually|also|officially|been|being)\\b)){0,10}\\s*';
const ROLE_NAMES = ['董事长兼总经理', '董事长办公室秘书', '董事长办公室主任', '董事会秘书', '董事长秘书', '董事长助理', '董事总经理', '董事长', '副董事长', '执行董事', '独立董事', '董事', '首席执行官', '首席财务官', '首席投资官', '总裁', '副总裁', '总经理', '副总经理', '财务总监', '投资总监', '合伙人', '管理合伙人', '执行合伙人', '创始人兼CEO', '联合创始人', '创始人', '法定代表人', '法人代表', '并购负责人', '融资负责人', '投资负责人', '负责人', '员工', '经理', 'CEO', 'CFO', 'CIO', 'COO', 'CTO', 'chairman', 'chairwoman', 'chair', 'chief executive officer', 'chief financial officer', 'managing director', 'managing partner', 'partner', 'founder', 'co-founder', 'director', 'president', 'employee'];
const ROLE = `(?<role>${ROLE_NAMES.sort((left, right) => right.length - left.length).join('|')})(?![A-Za-z]|办公室|秘书|助理|候选|总经理)`;
const PERCENT = '(?<pct>\\d{1,3}(?:\\.\\d{1,4})?)\\s*[%％]';
const rule = (kind: RelationKind, expression: string, extras: Omit<Rule, 'kind' | 'pattern'> = {}): Rule => ({ kind, pattern: new RegExp(expression, 'giu'), ...extras });

const RULES: Rule[] = [
  rule('employment', `${A}${M}(?:担任|出任|任职于|就职于|受雇于|任|供职于|在)\\s*${B}\\s*(?:的)?\\s*${ROLE}`),
  rule('employment', `${A}${M}(?:是|系|为)\\s*${B}\\s*(?:的)?\\s*${ROLE}`),
  rule('employment', `${A}${M}(?:任职于|就职于|受雇于|供职于|入职|加入)\\s*${B}`, { role: '任职' }),
  rule('employment', `${A}${M}(?:任命|聘任|聘请|聘用|雇佣)\\s*${B}\\s*(?:为|担任|出任)\\s*${ROLE}`, { reverse: true }),
  rule('employment', `${A}\\s*(?:的)?\\s*${ROLE}\\s*(?:是|为|由)\\s*${B}(?:担任)?`, { reverse: true }),
  rule('employment', `${A}\\s*(?:由|聘请|聘任)\\s*${B}${M}(?:担任|出任)\\s*${ROLE}`, { reverse: true }),
  rule('employment', `${A}${M}(?:serves? as|works? as|became|appointed as|the)\\s*(?:the\\s+)?${ROLE}\\s+(?:of|at|for)\\s+${B}`),
  rule('employment', `${A}${M}${ROLE}\\s+(?:of|at|for)\\s+${B}`),
  rule('employment', `${A}${M}(?:works? for|employed by|joined)\\s+${B}`, { role: '任职' }),
  rule('employment', `${A}${M}(?:appointed|employs?|hired)\\s+${B}\\s+(?:as\\s+)?(?:its\\s+)?${ROLE}`, { reverse: true }),

  rule('decision_authority', `${A}${M}(?:对|在|拥有|负责|掌握)\\s*${B}\\s*(?:的)?\\s*(?:项目|融资|交易|投资|收购|事项|预算)?\\s*(?:拥有|具有|享有|掌握|负责|行使)?\\s*(?<role>最终审批权|最终决策权|一票否决权|否决权|最终审批|最终决策|投资决策权|签字权|审批权|决策权|批准权)`),
  rule('decision_authority', `${A}${M}(?:是|担任|为)\\s*${B}\\s*(?:的)?\\s*(?<role>最终决策人|最终审批人|最终决策者|唯一审批人|授权签字人)`),
  rule('decision_authority', `${A}\\s*(?:的)?\\s*(?<role>最终审批权|最终决策权|一票否决权|否决权|签字权|审批权|决策权)\\s*(?:归|属于|由)\\s*${B}`, { reverse: true }),
  rule('decision_authority', `${A}\\s*(?:的)?\\s*(?:(?:本轮|本次|此次|该轮)?(?:融资|项目|交易|并购|收购|投资|预算|事项|方案))?\\s*(?:最终|最后|终审)(?:由|归|交由|需由)\\s*${B}\\s*(?:负责)?(?:审批|批准)`, { reverse: true, role: '最终审批权' }),
  rule('decision_authority', `${A}\\s*(?:的)?\\s*(?:(?:本轮|本次|此次|该轮)?(?:融资|项目|交易|并购|收购|投资|预算|事项|方案))?\\s*(?:最终|最后)(?:由|归|交由|需由)\\s*${B}\\s*(?:负责)?(?:决定|决策|拍板)`, { reverse: true, role: '最终决策权' }),
  rule('decision_authority', `${A}\\s*(?:的)?\\s*(?:(?:本轮|本次|此次|该轮)?(?:融资|项目|交易|并购|收购|投资|预算|事项|方案))?\\s*(?:由|交由|需由)\\s*${B}\\s*(?:负责)?(?<role>最终审批|最终决策|最终批准|最后拍板)`, { reverse: true }),
  rule('decision_authority', `${A}\\s*(?:的)?\\s*(?<role>最终审批人|最终决策人|最终决策者|唯一审批人|授权签字人)\\s*(?:是|为|系)\\s*${B}`, { reverse: true }),
  rule('decision_authority', `${A}${M}(?:holds?|has|exercises?)\\s+(?<role>final approval authority|final decision authority|veto power|signing authority)\\s+(?:for|over|at|in)\\s+${B}`),
  rule('decision_authority', `(?<role>Final approval authority|Final decision authority|Veto power)\\s+(?:for|over|at)\\s+${A}\\s+(?:rests with|held by|belongs to)\\s+${B}`, { reverse: true }),

  rule('ownership', `${A}${M}(?:持有|持股|拥有)\\s*${B}\\s*(?:的)?\\s*${PERCENT}\\s*(?:的)?\\s*(?:股权|股份|权益)?`),
  rule('ownership', `${A}${M}(?:持有|拥有)\\s*${PERCENT}\\s*(?:的)?\\s*${B}\\s*(?:股权|股份|权益)`),
  rule('ownership', `${A}${M}(?:持有|拥有)\\s*${B}\\s*(?:的)?\\s*(?:股权|股份|权益)`),
  rule('ownership', `${A}${M}(?:是|系|为)\\s*${B}\\s*(?:的)?\\s*(?<role>控股股东|实际控制人|第一大股东|大股东|股东)`),
  rule('ownership', `${A}\\s*(?:的)?\\s*(?<role>控股股东|实际控制人|第一大股东|大股东|股东)\\s*(?:是|为|系)\\s*${B}`, { reverse: true }),
  rule('ownership', `${A}\\s*(?:的)?\\s*${PERCENT}\\s*(?:的)?\\s*(?:股权|股份|权益)${M}(?:由|被)\\s*${B}\\s*(?:持有|拥有)`, { reverse: true }),
  rule('ownership', `${A}${M}(?:由|被)\\s*${B}\\s*(?:持股|持有|拥有)\\s*${PERCENT}`, { reverse: true }),
  rule('ownership', `${A}${M}(?:owns?|holds?)\\s+${PERCENT}\\s+(?:of\\s+)?(?:the\\s+)?(?:equity|shares?|stake)?\\s*(?:in|of)?\\s*${B}`),
  rule('ownership', `${A}${M}(?:owns?|holds?)\\s+(?:a\\s+)?(?<role>controlling stake|majority stake|minority stake|shares?|equity)\\s+(?:in|of)\\s+${B}`),
  rule('ownership', `${A}${M}(?:a |the )?(?<role>shareholder|controlling shareholder|beneficial owner)\\s+(?:in|of)\\s+${B}`),
  rule('ownership', `${PERCENT}\\s+(?:of\\s+)?${A}\\s*(?:is|was)?\\s*owned by\\s+${B}`, { reverse: true }),

  rule('investment', `${A}${M}(?:投资|领投|跟投|增资|出资投资|战略投资|参投)\\s*(?:了)?\\s*${B}`),
  rule('investment', `${A}${M}(?:向|对)\\s*${B}\\s*(?:进行|完成|追加|提供)?\\s*(?:了)?\\s*(?:战略)?(?:股权)?(?:投资|增资)`),
  rule('investment', `${A}${M}(?:获得|获|接受|收到)\\s*${B}\\s*(?:的)?\\s*(?:领投|跟投|投资|增资)`, { reverse: true }),
  rule('investment', `${A}${M}(?:invests?|invested|investing)\\s+(?:in|into)\\s+${B}`),
  rule('investment', `${A}${M}(?:received|receives|secured)\\s+(?:an?\\s+)?(?:equity\\s+)?investment\\s+from\\s+${B}`, { reverse: true }),
  rule('investment', `${A}${M}(?:led|co-led)\\s+${B}(?:'s|’s)?\\s+(?:Series [A-Z]\\s+)?(?:funding|financing|investment)\\s+round`),

  rule('advisory', `${A}${M}(?:为|向)\\s*${B}\\s*(?:提供|担任|出任|承担)\\s*(?:独家)?(?<role>财务顾问|融资顾问|并购顾问|法律顾问|战略顾问|FA|financial advis(?:o|e)r|legal counsel)(?:服务)?`),
  rule('advisory', `${A}${M}(?:担任|出任|是|作为|为)\\s*${B}\\s*(?:的)?\\s*(?:独家)?(?<role>财务顾问|融资顾问|并购顾问|法律顾问|战略顾问|FA)`),
  rule('advisory', `${A}${M}(?:聘请|聘任|委任|委托)\\s*${B}\\s*(?:担任|出任|作为|为)\\s*(?:其)?(?:独家)?(?<role>财务顾问|融资顾问|并购顾问|法律顾问|战略顾问|FA)`, { reverse: true }),
  rule('advisory', `${A}\\s*(?:的)?\\s*(?:独家)?(?<role>财务顾问|融资顾问|并购顾问|法律顾问|战略顾问)\\s*(?:是|为|由)\\s*${B}`, { reverse: true }),
  rule('advisory', `${A}${M}(?:serves? as|acts? as|appointed as|the|an?)\\s*(?:the\\s+)?(?:exclusive\\s+)?(?<role>financial advis(?:o|e)r|legal counsel|strategic advis(?:o|e)r|M&A advis(?:o|e)r)\\s+(?:to|for|of)\\s+${B}`),
  rule('advisory', `${A}${M}(?:advises|advised|advising)\\s+${B}`, { role: '顾问' }),
  rule('advisory', `${A}${M}(?:retained|appointed|engaged)\\s+${B}\\s+(?:as\\s+)?(?:its\\s+)?(?:exclusive\\s+)?(?<role>financial advis(?:o|e)r|legal counsel|strategic advis(?:o|e)r)`, { reverse: true }),

  rule('lending', `${A}${M}(?:向|为)\\s*${B}\\s*(?:提供|发放|授予|出借)\\s*(?:了)?\\s*(?:人民币)?\\s*(?:[\\d.,]+\\s*(?:亿元|万元|元|万美元|亿美元))?\\s*(?<role>贷款|借款|授信|信贷|融资贷款)`),
  rule('lending', `${A}${M}(?:贷款给|借款给|放贷给|借出资金给)\\s*${B}`, { role: '贷款' }),
  rule('lending', `${A}${M}(?:向|从)\\s*${B}\\s*(?:借款|取得贷款|获得贷款|获得授信)`, { reverse: true, role: '贷款' }),
  rule('lending', `${A}${M}(?:获得|获|取得|接受)\\s*${B}\\s*(?:提供|发放)?\\s*(?:的)?\\s*(?<role>贷款|授信|信贷)`, { reverse: true }),
  rule('lending', `${A}${M}(?:lends?|lent|loans?|loaned)\\s+(?:[\\d.,]+\\s*(?:USD|dollars?|million|billion)\\s+)?(?:to\\s+)?${B}`, { role: '贷款' }),
  rule('lending', `${A}${M}(?:provided|provides|extended)\\s+(?:a\\s+)?(?<role>loan|credit facility|credit line)\\s+to\\s+${B}`),
  rule('lending', `${A}${M}(?:borrowed|borrows)\\s+(?:funds?\\s+)?from\\s+${B}`, { reverse: true, role: '贷款' }),

  rule('acquisition', `${A}${M}(?:收购|并购|兼并|完成收购)\\s*(?:了)?\\s*${B}(?:\\s*的?\\s*${PERCENT}\\s*(?:股权|股份))?`),
  rule('acquisition', `${A}${M}(?:完成对|完成了对)\\s*${B}\\s*(?:的)?\\s*(?:收购|并购|兼并)`),
  rule('acquisition', `${A}${M}(?:被|由)\\s*${B}\\s*(?:完成)?(?:收购|并购|兼并)`, { reverse: true }),
  rule('acquisition', `${A}${M}(?:acquires?|acquired|purchased|buys?|bought|completed the acquisition of)\\s+${B}`),
  rule('acquisition', `${A}${M}(?:acquired|purchased|bought)\\s+by\\s+${B}`, { reverse: true }),

  rule('subsidiary', `${A}${M}(?:是|系|为|属于)\\s*${B}\\s*(?:的)?\\s*(?<role>全资子公司|控股子公司|子公司)`),
  rule('subsidiary', `${A}\\s*(?:的)?\\s*(?<role>全资子公司|控股子公司|子公司)\\s*(?:是|为|包括)\\s*${B}`, { reverse: true }),
  rule('subsidiary', `${A}\\s*旗下\\s*(?:的)?\\s*(?<role>全资子公司|控股子公司|子公司)\\s*(?:是|为|包括)?\\s*${B}`, { reverse: true }),
  rule('subsidiary', `${A}${M}(?:a\\s+)?(?<role>wholly[- ]owned subsidiary|controlled subsidiary|subsidiary)\\s+of\\s+${B}`),
  rule('subsidiary', `${A}(?:'s|’s)\\s+(?<role>wholly[- ]owned subsidiary|subsidiary)\\s*(?:is\\s+)?${B}`, { reverse: true }),

  rule('project_role', `${A}${M}(?:担任|出任|负责|是|为)\\s*${B}\\s*(?:的)?\\s*(?<role>项目负责人|项目经理|项目发起人|项目牵头人|交易负责人|融资负责人|项目顾问|牵头行|联席牵头行|承销商|保荐人|主承销商|联席主承销商|财务顾问|法律顾问|负责人|发起人|买方代表|卖方代表|买方|卖方|投资人)`),
  rule('project_role', `${A}\\s*(?:的)?\\s*(?<role>项目负责人|项目经理|项目发起人|项目牵头人|交易负责人|融资负责人|牵头行|承销商|保荐人|主承销商|负责人|发起人|买方|卖方)\\s*(?:是|为|由)\\s*${B}`, { reverse: true }),
  rule('project_role', `${A}\\s*(?:由|委任|委派)\\s*${B}${M}(?:担任|出任|负责)\\s*(?<role>项目负责人|项目经理|项目发起人|项目牵头人|交易负责人|融资负责人|牵头行|联席牵头行|承销商|保荐人|主承销商|联席主承销商|财务顾问|法律顾问|负责人|发起人|买方代表|卖方代表|买方|卖方)`, { reverse: true }),
  rule('project_role', `${A}${M}(?:leads?|led|manages?|managed)\\s+${B}`, { role: '项目负责人' }),
  rule('project_role', `${A}${M}(?:serves? as|acts? as|the|a)\\s*(?:the\\s+)?(?<role>project lead|project manager|project sponsor|lead underwriter|underwriter|buyer|seller)\\s+(?:of|for|on)\\s+${B}`),

  rule('introduction', `${A}${M}(?:将|把)\\s*${B}${M}(?:引荐|介绍)\\s*(?:给|至)\\s*${C}`, { via: 'a' }),
  rule('introduction', `${A}${M}(?:向|给)\\s*${B}${M}(?:引荐|介绍)\\s*(?:了)?\\s*${C}`, { via: 'a', reverse: true }),
  rule('introduction', `${A}${M}(?:introduced|introduces|introducing)\\s+${B}\\s+to\\s+${C}`, { via: 'a' }),
  rule('introduction', `${A}${M}(?:经|通过|由)\\s*${B}\\s*(?:引荐|介绍)(?:给|至)\\s*${C}`, { via: 'b' }),
  rule('introduction', `${A}${M}introduced\\s+to\\s+${B}\\s+by\\s+${C}`, { via: 'c' }),
  rule('introduction', `(?:在|经|通过)?\\s*${A}\\s*(?:的)?\\s*(?:引荐|介绍|牵线)\\s*(?:下|后)?\\s*[，,]?\\s*${B}${M}(?:与|和|同)\\s*${C}${M}(?:建立(?:了)?联系|取得(?:了)?联系|相识|认识|见面)`, { via: 'a' }),
  rule('introduction', `${A}${M}(?:经|通过)\\s*${B}\\s*(?:的)?(?:引荐|介绍|牵线)\\s*(?:后)?(?:认识了|结识了)\\s*${C}`, { via: 'b' }),
  rule('introduction', `(?:Through|Following)\\s+${A}(?:'s|’s)\\s+introduction\\s*,?\\s*${B}${M}(?:connected with|met)\\s+${C}`, { via: 'a' }),

  rule('cooperation', `${A}${M}(?:与|和|同)\\s*${B}${M}(?:签署|签订|达成|建立)\\s*(?:了)?\\s*(?<role>战略合作协议|合作协议|战略合作|合作关系|业务合作|联合开发协议)`),
  rule('cooperation', `${A}${M}(?:与|和|同)\\s*${B}${M}(?:合作开发|联合开发|共同开发|合作承接|联合承接)`, { role: '合作开发' }),
  rule('cooperation', `${A}${M}(?:是|为)\\s*${B}\\s*(?:的)?\\s*(?<role>战略合作伙伴|合作伙伴)`),
  rule('cooperation', `${A}${M}(?:signed|entered into|established)\\s+(?:a\\s+)?(?<role>strategic cooperation agreement|cooperation agreement|partnership|joint venture)\\s+with\\s+${B}`),
  rule('cooperation', `${A}${M}(?:partners?|partnered|collaborates?|collaborated)\\s+with\\s+${B}`, { role: '合作' }),
];

function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]+/gu, ''); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function legalKinds(kind: RelationKind, a: EntityKind, b: EntityKind): boolean {
  if (kind === 'employment') return a === 'person' && b === 'organization';
  if (kind === 'decision_authority') return a === 'person' && (b === 'organization' || b === 'project');
  if (kind === 'subsidiary') return a === 'organization' && b === 'organization';
  if (kind === 'project_role') return a !== 'project' && b === 'project';
  if (kind === 'ownership') return a !== 'project' && b === 'organization';
  if (kind === 'investment' || kind === 'advisory' || kind === 'acquisition') return a !== 'project' && b !== 'person';
  if (kind === 'lending') return a !== 'project' && b !== 'project';
  if (kind === 'introduction') return a === 'person' && b === 'person';
  return a !== 'project' && b !== 'project';
}

function resolveMentions(text: string, entities: RelationshipEntity[]): { text: string; mentions: Mention[] } {
  const registry = new Map<string, RelationshipEntity[]>();
  for (const entity of entities) for (const alias of [entity.name, ...(entity.aliases ?? [])]) {
    const key = alias.toLocaleLowerCase('en-US');
    const owners = registry.get(key) ?? [];
    if (!owners.some(owner => owner.id === entity.id)) owners.push(entity);
    registry.set(key, owners);
  }
  const aliases = [...registry.keys()].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const pattern = new RegExp(aliases.map(escapeRegExp).join('|'), 'giu');
  const mentions: Mention[] = [];
  let marked = text.replace(pattern, (matched: string, offset: number) => {
    // English names cannot be taken from the middle of another word.
    if (/^[A-Za-z\d_]/u.test(matched) && /[A-Za-z\d_]/.test(text[offset - 1] ?? '')) return matched;
    if (/[A-Za-z\d_]$/.test(matched) && /[A-Za-z\d_]/.test(text[offset + matched.length] ?? '')) return matched;
    const owners = registry.get(matched.toLocaleLowerCase('en-US')) ?? [];
    const mention: Mention = { text: matched, ambiguous: owners.length !== 1, ...(owners.length === 1 ? { entity: owners[0] } : {}) };
    const index = mentions.push(mention) - 1;
    return `\uE000${index}\uE001`;
  });
  // A first-person pronoun is resolved only inside this speaker's explicit colon-led statement.
  // Original pronoun text is preserved in the mention table, so evidence remains an exact excerpt.
  const statement = /(\uE000\d+\uE001\s*(?:公告称|公告表示|声明称|声明|明确表示|表示|确认|强调|澄清|回应)(?:道)?\s*[：:]\s*[“"']?)([^。；;\n：:”」』]{1,1500})/gu;
  marked = marked.replace(statement, (whole: string, heading: string, body: string) => {
    const token = heading.match(/\uE000\d+\uE001/u)?.[0];
    const speaker = entityFrom(token, mentions);
    if (!speaker || speaker.kind === 'project') return whole;
    const firstPerson = speaker.kind === 'organization' ? /本机构|本公司|本集团|我司|本基金/gu : /本人|(?<![\p{L}])我(?!们)/gu;
    return heading + body.replace(firstPerson, original => {
      const index = mentions.push({ entity: speaker, text: original, ambiguous: false }) - 1;
      return `\uE000${index}\uE001`;
    });
  });
  return { text: marked, mentions };
}

function recover(text: string, mentions: Mention[]): string { return text.replace(MARKER, (_, index: string) => mentions[Number(index)]?.text ?? '未知节点'); }
function entityFrom(token: string | undefined, mentions: Mention[]): RelationshipEntity | undefined {
  if (!token) return undefined;
  return mentions[Number(token.slice(1, -1))]?.entity;
}
function candidates(clause: string, mentions: Mention[]): Candidate[] {
  const result: Candidate[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of clause.matchAll(rule.pattern)) {
      const groups = match.groups!;
      let source = entityFrom(groups.a, mentions);
      let target = entityFrom(groups.b, mentions);
      let via: RelationshipEntity | undefined;
      if (rule.via) {
        via = entityFrom(groups[rule.via], mentions);
        if (rule.via === 'a') { source = entityFrom(rule.reverse ? groups.c : groups.b, mentions); target = entityFrom(rule.reverse ? groups.b : groups.c, mentions); }
        if (rule.via === 'b') { source = entityFrom(groups.a, mentions); target = entityFrom(groups.c, mentions); }
        if (!via || via.kind !== 'person') continue;
      } else if (rule.reverse) [source, target] = [target, source];
      if (!source || !target || source.id === target.id || !legalKinds(rule.kind, source.kind, target.kind)) continue;
      if (via && (via.id === source.id || via.id === target.id)) continue;
      const percentage = groups.pct !== undefined ? Number(groups.pct) : undefined;
      if (percentage !== undefined && (percentage < 0 || percentage > 100)) continue;
      const role = (groups.role ?? rule.role)?.trim();
      const start = match.index!;
      const end = start + match[0].length;
      if (rule.kind === 'introduction' && /^\s*(?:的)?(?:产品|业务|方案|材料|简历|资料|项目|履历|经历|情况|背景|演讲|文章|报告)/u.test(clause.slice(end))) continue;
      const key = `${rule.kind}|${source.id}|${target.id}|${via?.id ?? ''}|${role ?? ''}|${percentage ?? ''}|${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ kind: rule.kind, source, target, via, role, percentage, start, end, text: match[0] });
    }
  }
  // Favor a qualified assertion when a generic alternative matches the same clause.
  return result.filter(candidate => !result.some(other => {
    if (candidate === other || candidate.source.id !== other.source.id || candidate.target.id !== other.target.id || candidate.via?.id !== other.via?.id || candidate.start < other.start || candidate.end > other.end) return false;
    if (candidate.kind === 'advisory' && other.kind === 'project_role' && candidate.target.kind === 'project') return true;
    return candidate.kind === other.kind && ((candidate.percentage === undefined && other.percentage !== undefined) || (!candidate.role && other.role));
  }));
}

const NEGATED = /(?:并非|不是|不属于|并未|没有|尚未|从未|未曾|未能|未(?!来)|不(?!再)|否认|不存在|无(?:持股|股权|任职|投资|顾问|合作|借贷|收购)关系|\b(?:not|never|no)\b|denies?|denied|didn't|isn't|hasn't|wasn't)/iu;
const PROSPECTIVE = /(?:拟|计划|准备|将(?:会|要|于|在|成为|担任|投资|收购|提供|任命)|希望|预计|考虑|意向|洽谈|争取|尚待|待(?:审批|批准|签署|交割)|(?:尚未|未)(?:完成|交割|生效|签署)|如果|假如|若|假设|一旦|能否|是否|吗|请问|请让|建议|\b(?:will|would|may|might|plans?|planned|intends?|proposes?|considering|if|unless|should|potential|proposed|pending|please)\b|[?？])/iu;
const HEARSAY = /(?:传闻|据传|听说|据说|据称|网传|未经证实|尚未证实|未能确认|无法确认|没有证据|不排除|可能|或许|似乎|猜测|坊间|\b(?:rumou?r|reportedly|allegedly|apparently|unconfirmed|possibly|perhaps|unverified)\b)/iu;
const HISTORICAL = /(?:曾(?:经|任|是|为|担任)?|前任|原(?:任|董事长|董事|CEO|CFO|总经理|总裁|负责人)|此前|已离任|已经离任|不再|卸任|辞任|离职|\b(?:formerly|former|previously|ex-|no longer|resigned)\b)/iu;

function stanceFor(candidate: Candidate, clause: string, document: RelationshipDocument, asOf: string): { stance: RelationshipEvidence['stance']; reason: string } {
  // Context stops at comma-separated neighboring claims; explicit sentence-level conditions are retained.
  const before = clause.slice(0, candidate.start);
  const after = clause.slice(candidate.end);
  const prefix = before.slice(Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1);
  const tails = after.split(/[，,]/u);
  let suffix = tails[0];
  for (const tail of tails.slice(1)) {
    // Carry an adjacent qualification of this assertion, but not a new named pair's claim.
    if (/\uE000\d+\uE001/u.test(tail)) break;
    if (!/(?:该|此|这|上述|交易|投资|收购|任命|消息|关系|双方|合作|交割|生效|尚待|尚未|未经|待审批|待批准|尚需|\b(?:this|that|transaction|deal|agreement|approval|closing|pending|unconfirmed)\b)/iu.test(tail)) break;
    suffix += `，${tail}`;
  }
  const context = `${prefix}${candidate.text}${suffix}`;
  const conditionalPrefix = before.match(/(?:如果|假如|假设|若|一旦|\bif\b|\bunless\b)[\s\S]*$/iu)?.[0] ?? '';
  const futureMention = [...context.matchAll(/\b(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/gu)].some(match => {
    const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    return Number.isFinite(time(day)) && time(day) > time(asOf, true);
  });
  if (document.validFrom && time(document.validFrom) > time(asOf, true)) return { stance: 'uncertain', reason: '文本已发布但关系生效日期尚未到达。' };
  if (document.sourceKind === 'rumor' || HEARSAY.test(context) || HEARSAY.test(before.slice(0, 30))) return { stance: 'uncertain', reason: '传闻或未证实措辞，仅保留待确认关系。' };
  if (PROSPECTIVE.test(context) || conditionalPrefix || futureMention || /^\s*(?:does|did|do|is|are|was|were|has|have|can|could|should|would)\b/iu.test(prefix)) return { stance: 'uncertain', reason: '计划、条件、疑问或尚未完成的表述。' };
  if ((document.validTo && time(document.validTo, true) < time(asOf, true)) || HISTORICAL.test(context)) return { stance: 'historical', reason: '文本已失效或明确描述过去关系。' };
  if (candidate.kind === 'ownership' && candidate.percentage === 0) return { stance: 'negated', reason: '明确为零持股，不能认定持股关系。' };
  if (NEGATED.test(context)) return { stance: 'negated', reason: '文本明确否定该关系。' };
  if (candidate.kind === 'introduction' && !/(?:已|已经|完成|介绍了|引荐了|认识了|结识了|建立了联系|取得了联系|\b(?:introduced|connected|met)\b)/iu.test(context)) return { stance: 'uncertain', reason: '引荐措辞未明确已经完成。' };
  return { stance: 'affirmed', reason: '已知双方身份与明确关系谓词出现在同一语句。' };
}

interface Claim { candidate: Candidate; evidence: RelationshipEvidence; sourceFingerprint: string }
function relationKey(candidate: Candidate, projectId?: string): string {
  return JSON.stringify([candidate.kind, candidate.source.id, candidate.target.id, projectId ?? '', candidate.via?.id ?? '']);
}
function independent(claims: Claim[]): number {
  const parents = claims.map((_, index) => index);
  function find(index: number): number { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; }
  const sources = new Map<string, number>();
  const copies = new Map<string, number>();
  const documents = new Map<string, number>();
  claims.forEach((claim, index) => {
    for (const [map, key] of [[sources, claim.evidence.sourceId], [copies, normalize(claim.evidence.quote)], [documents, claim.sourceFingerprint]] as const) {
      const earlier = map.get(key);
      if (earlier !== undefined) parents[find(index)] = find(earlier);
      else map.set(key, index);
    }
  });
  return new Set(claims.map((_, index) => find(index))).size;
}

function aggregate(key: string, claims: Claim[], index: number): BusinessRelationship {
  const affirmed = claims.filter(claim => claim.evidence.stance === 'affirmed');
  const negated = claims.filter(claim => claim.evidence.stance === 'negated');
  const historical = claims.filter(claim => claim.evidence.stance === 'historical');
  const uncertain = claims.filter(claim => claim.evidence.stance === 'uncertain');
  const documentary = affirmed.filter(claim => PRIMARY.has(claim.evidence.sourceKind) || SECONDARY.has(claim.evidence.sourceKind));
  const count = independent(affirmed);
  const primary = documentary.some(claim => PRIMARY.has(claim.evidence.sourceKind));
  const percentages = [...new Set(affirmed.map(claim => claim.candidate.percentage).filter((value): value is number => value !== undefined))];
  const qualifiedRoles = [...new Set(affirmed.map(claim => claim.candidate.role).filter((value): value is string => !!value && value !== '任职' && value !== '顾问'))];
  let status: RelationStatus;
  let rationale: string;
  if ((affirmed.length && negated.length) || percentages.length > 1) {
    status = 'conflicted'; rationale = percentages.length > 1 ? '当前材料出现不同持股比例，请勿当成已确定关系。' : '当前材料同时包含肯定与否定的表述。';
  } else if (affirmed.length && (primary || independent(documentary) >= 2)) {
    status = 'supported'; rationale = primary ? '明确表述来自文件所标注的正式来源；来源分类由导入文件提供。' : '至少两组未发现复制的独立来源支持同一明确关系。';
  } else if (affirmed.length || uncertain.length) {
    status = 'review'; rationale = '来源或表述不足以支持确定关系。';
  } else if (negated.length) {
    status = 'rejected'; rationale = '当前只有明确否定的关系表述。';
  } else {
    status = 'historical'; rationale = '当前只有历史或失效的关系材料。';
  }
  const best = (affirmed.find(claim => PRIMARY.has(claim.evidence.sourceKind)) ?? affirmed[0] ?? historical[0] ?? claims[0]).candidate;
  const scope = (JSON.parse(key) as string[])[3];
  const roles = qualifiedRoles.length ? qualifiedRoles : [...new Set(claims.map(claim => claim.candidate.role).filter((value): value is string => !!value))];
  const role = roles.length ? roles.join(' / ') : undefined;
  const percentage = percentages.length === 1 ? percentages[0] : undefined;
  return {
    id: `relation-${index + 1}`, sourceId: best.source.id, targetId: best.target.id, kind: best.kind,
    label: percentage !== undefined ? `${RELATION_LABELS[best.kind]} ${percentage}%` : role && role !== RELATION_LABELS[best.kind] ? `${RELATION_LABELS[best.kind]} · ${role}` : RELATION_LABELS[best.kind],
    status, confidence: status === 'supported' ? (primary && independent(documentary) >= 2 ? 'high' : 'medium') : 'low',
    evidenceIds: [...new Set(claims.map(claim => claim.evidence.id))], independentSources: count,
    rationale, ...(scope ? { projectId: scope } : {}), ...(best.via ? { viaId: best.via.id } : {}),
    ...(role ? { role } : {}), ...(percentage !== undefined ? { percentage } : {}),
  };
}

export function analyzeRelationshipCase(input: unknown): RelationshipAnalysis {
  const data = validateRelationshipCase(input);
  const issues: AnalysisIssue[] = [];
  const evidence: RelationshipEvidence[] = [];
  const grouped = new Map<string, Claim[]>();
  const sourceIds = new Set<string>();
  const copiedTexts = new Set<string>();
  const issue = (kind: AnalysisIssue['kind'], message: string, documentId?: string, quote?: string) => issues.push({ id: `issue-${issues.length + 1}`, kind, message, ...(documentId ? { documentId } : {}), ...(quote ? { quote: quote.slice(0, 300) } : {}) });
  for (const document of data.documents) {
    if (time(document.publishedAt) > time(data.asOf, true)) {
      issue('future_source', '文本发布日期晚于分析时点，未用于推断。', document.id); continue;
    }
    if (document.validFrom && time(document.validFrom) > time(data.asOf, true)) issue('future_source', '文本已经发布但尚未生效，仅保留待生效关系。', document.id);
    const fingerprint = normalize(document.text);
    if (sourceIds.has(document.sourceId) || copiedTexts.has(fingerprint)) issue('duplicate_source', '同一来源或复制文本不会增加独立来源数量。', document.id);
    sourceIds.add(document.sourceId); copiedTexts.add(fingerprint);
    const marked = resolveMentions(document.text, data.entities);
    const ambiguous = [...new Set(marked.mentions.filter(mention => mention.ambiguous).map(mention => mention.text))];
    if (ambiguous.length) issue('ambiguous_identity', `存在重名或多义别名，相关节点未被自动合并：${ambiguous.slice(0, 8).join('、')}`, document.id);
    let extracted = 0;
    for (const clause of marked.text.split(/(?<=[。！？!?；;\n])|(?<!\d)\.(?!\d)/u)) {
      if (!clause.trim()) continue;
      for (const candidate of candidates(clause, marked.mentions)) {
        if (!commercialRelationAllowed(candidate.kind, recover(clause, marked.mentions), data, candidate.source.id, candidate.target.id, document.projectId)) continue;
        if (evidence.length >= 20_000) fail('识别出的关系表述超过 2 万条，请按客户或项目拆分文件。');
        const stance = stanceFor(candidate, clause, document, data.asOf);
        const item: RelationshipEvidence = {
          id: `evidence-${evidence.length + 1}`, documentId: document.id, documentTitle: document.title,
          sourceId: document.sourceId, sourceKind: document.sourceKind, publishedAt: document.publishedAt,
          quote: recover(clause.trim(), marked.mentions).slice(0, 1000), ...stance,
        };
        evidence.push(item); extracted += 1;
        const key = relationKey(candidate, document.projectId ?? (candidate.kind === 'project_role' ? candidate.target.id : undefined));
        const claims = grouped.get(key) ?? [];
        claims.push({ candidate, evidence: item, sourceFingerprint: fingerprint }); grouped.set(key, claims);
      }
    }
    if (!extracted && marked.mentions.filter(mention => mention.entity).length >= 2) issue('unsupported_language', '未发现可安全归属双方的明确业务谓词；共同出现或互动频率不生成关系。', document.id);
  }
  const relationships = [...grouped].map(([key, claims], index) => aggregate(key, claims, index));
  return {
    schema: 'dealgraph.relationship-analysis.v1', title: data.title, dataClass: data.dataClass, asOf: data.asOf,
    entities: data.entities, relationships, evidence, issues,
    summary: {
      supported: relationships.filter(relation => relation.status === 'supported').length,
      review: relationships.filter(relation => relation.status === 'review').length,
      conflicted: relationships.filter(relation => relation.status === 'conflicted').length,
      historical: relationships.filter(relation => relation.status === 'historical').length,
      rejected: relationships.filter(relation => relation.status === 'rejected').length,
      documents: data.documents.length,
      evidenceCoverage: relationships.length ? relationships.filter(relation => relation.evidenceIds.length > 0).length / relationships.length : 0,
    },
  };
}
