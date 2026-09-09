import type { RelationshipAnalysis, RelationshipCase } from './types';
import { validateRelationshipCase } from './engine.ts';
import { DEFAULT_SELECTION, consentFor, isModelSelection, validApiKey } from './model-catalog.ts';
import type { ModelSelection } from './model-catalog.ts';
import { prepareDiscoveryInput } from './wechat-import.ts';
import type { DiscoveryInput } from './wechat-import.ts';
import { discoveryConsentFor, finalizeDiscovery } from './entity-discovery.ts';
import type { DiscoveryResult } from './entity-discovery.ts';

export { UPLOAD_CONSENT_VERSION } from './model-catalog.ts';
const API_BASE = '/api/relationships';
export interface CloudStatus extends ModelSelection { configured: boolean; discovery?: boolean }
export interface CloudUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface CloudResult extends ModelSelection { analysis: RelationshipAnalysis; usage: CloudUsage; documentsSent: number; excludedFutureDocuments: number }
export interface CloudDiscoveryResult extends ModelSelection { discovery: DiscoveryResult; usage: CloudUsage; documentsSent: number }
export interface CloudConnectionDiagnosis {
  reachable: boolean;
  route: 'direct' | 'system-proxy' | 'unavailable';
  code: 'NETWORK_OK' | 'NETWORK_CONNECT' | 'NETWORK_PROXY' | 'NETWORK_TLS' | 'DIAGNOSIS_TIMEOUT';
  elapsedMs: number;
  httpStatus?: number;
  message: string;
}
export class CloudClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'CloudClientError'; this.code = code; }
}
const ERROR_MESSAGES: Record<string, string> = {
  VERSION_MISMATCH: '页面与服务版本不同。请先加密保存资料，再刷新页面；本次未调用模型。',
  KEY_REQUIRED: '请先临时配置所选服务商的 API 密钥。', KEY_INVALID: '密钥格式不正确，请重新输入新的 API 密钥。',
  MODEL_SELECTION_INVALID: '请选择列表中的服务商和模型。', MODEL_INCOMPLETE: '模型结果不完整，本次图谱未更新。',
  BUSY: '已有分析正在进行，请完成或取消后重试。', CONSENT_REQUIRED: '请确认本次上传后再开始分析。',
  INVALID_CASE: '当前关系数据格式不符合分析要求。', RATE_LIMITED: '请求过于频繁，请稍后重试。',
  OPENAI_AUTH: 'OpenAI 未接受此密钥，请检查密钥权限与账户配置。', OPENAI_RATE_LIMIT: 'OpenAI 请求速率受限，请稍后重试。',
  OPENAI_UNAVAILABLE: 'OpenAI 暂时不可用，请稍后重试。', OPENAI_REFUSED: '模型未完成本次关系分析。',
  OPENAI_INCOMPLETE: '模型结果不完整，本次图谱未更新。', INVALID_RESPONSE: '返回结果未通过完整性检查，本次图谱未更新。',
  DISCOVERY_VALIDATION_FAILED: '模型已返回，但节点引用或材料范围未通过校验；名单未更新。这不是密钥连接错误。',
  RELATION_VALIDATION_FAILED: '模型已返回，但关系引用、身份或材料完整性未通过校验；图谱未更新。这不是密钥连接错误。',
  ANALYSIS_TIMEOUT: '模型分析超时，本次图谱未更新。', CANCELLED: '已取消本次分析。',
  REQUEST_TOO_LARGE: '当前数据超过云分析大小限制，请缩小数据范围。', ACCESS_DENIED: '请求来源校验失败，请从当前部署的 DealGraph 页面重新打开。',
  NO_ELIGIBLE_DOCUMENTS: '分析时点内没有可发送的材料，请调整材料或分析日期。',
  NETWORK_CONNECT: '网站服务器暂时无法连接所选服务商，请稍后重试。',
  NETWORK_PROXY: '无法连接本机代理，请确认代理已启动。',
  NETWORK_TLS: '无法建立安全连接，请检查代理与网络的证书配置。',
  DIAGNOSIS_TIMEOUT: '连接检测超时，请检查代理或网络后重试。',
  OPENAI_PERMISSION: 'OpenAI 拒绝访问，请检查 API 账户权限与访问限制。',
  OPENAI_QUOTA: 'OpenAI API 额度不足或已达账户上限，请检查 API 账单。',
  OPENAI_LIMIT: 'OpenAI 返回访问限制，请检查 API 额度与速率设置。',
  OPENAI_REQUEST_INVALID: 'OpenAI 未接受当前请求，请检查资料规模或请求配置。',
  OPENAI_MODEL_UNAVAILABLE: '当前请求无法使用所选模型，请检查账户的模型权限。',
};
for (const [code, message] of Object.entries(ERROR_MESSAGES)) if (code.startsWith('OPENAI_')) ERROR_MESSAGES[code.replace('OPENAI_', 'MODEL_')] = message.replaceAll('OpenAI', '模型服务商');
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function invalidResponse(): never { throw new CloudClientError('INVALID_RESPONSE', ERROR_MESSAGES.INVALID_RESPONSE); }
function timestamp(value: string, endOfDay = false): number { return Date.parse(value.length === 10 ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value); }
function validateAnalysis(value: unknown, input: RelationshipCase): RelationshipAnalysis {
  if (!object(value) || value.schema !== 'dealgraph.relationship-analysis.v1' || value.title !== input.title || value.asOf !== input.asOf || value.dataClass !== input.dataClass || !Array.isArray(value.entities) || !Array.isArray(value.relationships) || !Array.isArray(value.evidence) || !Array.isArray(value.issues) || !object(value.summary) || value.entities.length > 1000 || value.relationships.length > 20000) return invalidResponse();
  const inputIds = new Map(input.entities.map((entity) => [entity.id, entity]));
  const ids = new Set<string>();
  for (const entity of value.entities) {
    if (!object(entity) || typeof entity.id !== 'string' || typeof entity.name !== 'string' || !['person', 'organization', 'project'].includes(String(entity.kind)) || ids.has(entity.id)) return invalidResponse();
    const original = inputIds.get(entity.id);
    if (!original || entity.name !== original.name || entity.kind !== original.kind || (entity.category !== undefined && typeof entity.category !== 'string') || (entity.aliases !== undefined && (!Array.isArray(entity.aliases) || !entity.aliases.every((alias) => typeof alias === 'string')))) return invalidResponse();
    ids.add(entity.id);
  }
  const relationIds = new Set<string>();
  const statusCounts: Record<string, number> = { supported: 0, review: 0, conflicted: 0, historical: 0, rejected: 0 };
  for (const relation of value.relationships) {
    if (!object(relation) || typeof relation.id !== 'string' || relationIds.has(relation.id) || typeof relation.sourceId !== 'string' || typeof relation.targetId !== 'string' || !ids.has(relation.sourceId) || !ids.has(relation.targetId) || typeof relation.label !== 'string' || !['employment', 'decision_authority', 'ownership', 'investment', 'advisory', 'lending', 'acquisition', 'subsidiary', 'project_role', 'introduction', 'cooperation'].includes(String(relation.kind)) || !['supported', 'review', 'conflicted', 'historical', 'rejected'].includes(String(relation.status)) || !['high', 'medium', 'low'].includes(String(relation.confidence))) return invalidResponse();
    if ((relation.projectId !== undefined && (typeof relation.projectId !== 'string' || !ids.has(relation.projectId))) || (relation.viaId !== undefined && (typeof relation.viaId !== 'string' || !ids.has(relation.viaId))) || (relation.role !== undefined && typeof relation.role !== 'string') || (relation.percentage !== undefined && (typeof relation.percentage !== 'number' || !Number.isFinite(relation.percentage) || relation.percentage < 0 || relation.percentage > 100))) return invalidResponse();
    relationIds.add(relation.id);
    statusCounts[String(relation.status)] += 1;
  }
  for (const key of ['supported', 'review', 'conflicted', 'historical', 'rejected', 'documents']) if (!nonnegative(value.summary[key])) return invalidResponse();
  const summary = value.summary;
  if (summary.documents !== input.documents.length || Object.entries(statusCounts).some(([status, count]) => summary[status] !== count)) return invalidResponse();
  return value as unknown as RelationshipAnalysis;
}

/** BYOK: no shared server key or cookie. Key lives only in this page closure. */
export function createRelationshipCloudClient(fetcher: typeof fetch = (...args) => fetch(...args), now = Date.now) {
  let pageKey = '';
  let expiresAt = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let selection: ModelSelection = { ...DEFAULT_SELECTION };
  let generation = 0;
  const requests = new Set<AbortController>();
  function clearLocalKey() { pageKey = ''; expiresAt = 0; clearTimeout(expiryTimer); }
  function currentKey() { if (now() >= expiresAt) clearLocalKey(); return pageKey; }
  async function request(path: '/status' | '/configure' | '/analyze' | '/discover' | '/diagnose', method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const requestGeneration = generation;
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const needsKey = path === '/analyze' || path === '/discover';
    const key = needsKey ? currentKey() : '';
    if (needsKey && !key) throw new CloudClientError('KEY_REQUIRED', ERROR_MESSAGES.KEY_REQUIRED);
    requests.add(controller);
    try {
    let response: Response;
    try {
      response = await fetcher(`${API_BASE}${path}`, { method, mode: 'same-origin', credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-DealGraph-Client': 'byok-v1', 'X-DealGraph-Contract': 'commercial-relations-v3' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new DOMException('Cancelled', 'AbortError');
      throw new CloudClientError('NETWORK', '无法连接网站分析服务，请检查网络后重试。');
    }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    let payload: unknown;
    try { payload = await response.json(); } catch { return invalidResponse(); }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!response.ok) {
      const code = object(payload) && object(payload.error) && typeof payload.error.code === 'string' ? payload.error.code : '';
      const known = Object.hasOwn(ERROR_MESSAGES, code);
      throw new CloudClientError(known ? code : 'REQUEST_FAILED', known ? ERROR_MESSAGES[code] : '本次请求未完成，请稍后重试。');
    }
    if (requestGeneration !== generation) throw new DOMException('Cancelled', 'AbortError');
    return payload;
    } finally { requests.delete(controller); }
  }
  return {
    clearLocalKey,
    selectModel(next: ModelSelection) {
      if (!isModelSelection(next)) throw new CloudClientError('MODEL_SELECTION_INVALID', ERROR_MESSAGES.MODEL_SELECTION_INVALID);
      if (selection.provider === next.provider && selection.model === next.model) return;
      generation++; requests.forEach(controller => controller.abort()); requests.clear(); clearLocalKey();
      selection = { provider: next.provider, model: next.model };
    },
    async status(signal?: AbortSignal): Promise<CloudStatus> {
      const value = await request('/status', 'GET', undefined, signal);
      if (!object(value) || value.mode !== 'stateless-byok' || value.capabilities !== 'multi-model-v2') return invalidResponse();
      if (value.contract !== 'commercial-relations-v3') throw new CloudClientError('VERSION_MISMATCH', ERROR_MESSAGES.VERSION_MISMATCH);
      return { configured: !!currentKey(), ...selection, discovery: value.discovery === true };
    },
    async configure(apiKey: string, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!validApiKey(apiKey.trim())) throw new CloudClientError('KEY_INVALID', ERROR_MESSAGES.KEY_INVALID);
      clearLocalKey(); pageKey = apiKey.trim(); expiresAt = now() + 30 * 60_000;
      expiryTimer = setTimeout(clearLocalKey, 30 * 60_000);
    },
    async clearConfiguration(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      clearLocalKey();
    },
    async diagnose(signal?: AbortSignal): Promise<CloudConnectionDiagnosis> {
      const selected = { ...selection };
      const value = await request('/diagnose', 'POST', selected, signal);
      if (!object(value) || value.provider !== selected.provider || value.model !== selected.model) return invalidResponse();
      if (!object(value) || typeof value.reachable !== 'boolean' || !['direct', 'system-proxy', 'unavailable'].includes(String(value.route)) || !['NETWORK_OK', 'NETWORK_CONNECT', 'NETWORK_PROXY', 'NETWORK_TLS', 'DIAGNOSIS_TIMEOUT'].includes(String(value.code)) || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || (value.httpStatus !== undefined && (!nonnegative(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) || value.reachable !== (value.code === 'NETWORK_OK') || (value.reachable && value.route === 'unavailable')) return invalidResponse();
      return { reachable: value.reachable, route: value.route as CloudConnectionDiagnosis['route'], code: value.code as CloudConnectionDiagnosis['code'], elapsedMs: value.elapsedMs, ...(value.httpStatus !== undefined ? { httpStatus: value.httpStatus as number } : {}), message: value.reachable ? '连接已建立；尚未验证密钥或模型调用。' : ERROR_MESSAGES[String(value.code)] };
    },
    async analyze(input: RelationshipCase, consentVersion: string, signal?: AbortSignal): Promise<CloudResult> {
      const selected = { ...selection };
      if (consentVersion !== consentFor(selected)) throw new CloudClientError('CONSENT_REQUIRED', ERROR_MESSAGES.CONSENT_REQUIRED);
      const cutoff = timestamp(input.asOf, true);
      if (!Number.isFinite(cutoff) || input.documents.some((document) => !Number.isFinite(timestamp(document.publishedAt)))) return invalidResponse();
      const expectedFutureDocuments = input.documents.filter((document) => timestamp(document.publishedAt) > cutoff).length;
      const upload = validateRelationshipCase(input);
      upload.documents = upload.documents.filter(document => timestamp(document.publishedAt) <= cutoff);
      if (!upload.documents.length) throw new CloudClientError('NO_ELIGIBLE_DOCUMENTS', ERROR_MESSAGES.NO_ELIGIBLE_DOCUMENTS);
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) throw new CloudClientError('ACCESS_DENIED', '当前页面被旧离线缓存控制，请在无痕窗口重新打开后再输入密钥。');
      const value = await request('/analyze', 'POST', { case: upload, consentVersion, ...selected }, signal);
      if (!object(value) || value.provider !== selected.provider || value.model !== selected.model || !object(value.usage) || !nonnegative(value.usage.inputTokens) || !nonnegative(value.usage.outputTokens) || !nonnegative(value.usage.totalTokens) || value.usage.totalTokens !== value.usage.inputTokens + value.usage.outputTokens || !nonnegative(value.documentsSent) || value.documentsSent === 0 || value.documentsSent !== upload.documents.length || value.excludedFutureDocuments !== 0) return invalidResponse();
      return { analysis: validateAnalysis(value.analysis, upload), ...selected, usage: { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, totalTokens: value.usage.totalTokens }, documentsSent: value.documentsSent, excludedFutureDocuments: expectedFutureDocuments };
    },
    async discover(input: DiscoveryInput, consentVersion: string, signal?: AbortSignal): Promise<CloudDiscoveryResult> {
      const selected = { ...selection };
      if (consentVersion !== discoveryConsentFor(selected)) throw new CloudClientError('CONSENT_REQUIRED', ERROR_MESSAGES.CONSENT_REQUIRED);
      const upload = prepareDiscoveryInput(input).input;
      if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) throw new CloudClientError('ACCESS_DENIED', '请在无痕窗口重新打开后再输入密钥。');
      const value = await request('/discover', 'POST', { case: upload, consentVersion, ...selected }, signal);
      if (!object(value) || value.provider !== selected.provider || value.model !== selected.model || !object(value.usage) || !nonnegative(value.usage.inputTokens) || !nonnegative(value.usage.outputTokens) || !nonnegative(value.usage.totalTokens) || value.usage.totalTokens !== value.usage.inputTokens + value.usage.outputTokens || value.documentsSent !== upload.documents.length || value.excludedFutureDocuments !== 0 || !Array.isArray(value.batches)) return invalidResponse();
      let discovery: DiscoveryResult;
      try { discovery = finalizeDiscovery(upload, value.batches); } catch { return invalidResponse(); }
      if (JSON.stringify(discovery) !== JSON.stringify(value.discovery)) return invalidResponse();
      return { discovery, ...selected, usage: { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens, totalTokens: value.usage.totalTokens }, documentsSent: value.documentsSent };
    },
  };
}

export interface CloudRunTicket { readonly generation: number; readonly signal: AbortSignal }
/** Cancelling/replacing a case invalidates late responses, even from an abort-ignoring transport. */
export class CloudRunGate {
  private generation = 0;
  private controller: AbortController | null = null;
  begin(): CloudRunTicket {
    if (this.controller) throw new CloudClientError('BUSY', ERROR_MESSAGES.BUSY);
    this.controller = new AbortController();
    return { generation: ++this.generation, signal: this.controller.signal };
  }
  isCurrent(ticket: CloudRunTicket): boolean { return ticket.generation === this.generation && this.controller?.signal === ticket.signal && !ticket.signal.aborted; }
  finish(ticket: CloudRunTicket): boolean { if (!this.isCurrent(ticket)) return false; this.controller = null; return true; }
  cancel(): void { this.generation += 1; this.controller?.abort(); this.controller = null; }
}
