import { Buffer } from 'node:buffer';
import { matchesModel } from '../src/dealgraph/relationships/model-catalog.ts';
const MAX_RESPONSE_BYTES=2_097_152;
const MAX_OUTPUT_TOKENS=8192;
const MODEL='gpt-4o';
type Usage={inputTokens:number;outputTokens:number;totalTokens:number};
class ApiFailure extends Error {
  status: number;
  code: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  constructor(status: number, code: string, message: string, upstreamStatus?: number, upstreamCode?: string) { super(message); this.status = status; this.code = code; this.upstreamStatus = upstreamStatus; this.upstreamCode = upstreamCode; }
}
function fail(status: number, code: string, message: string): never { throw new ApiFailure(status, code, message); }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function limitedResponse(response: Response, signal: AbortSignal, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
    await response.body?.cancel();
    fail(502, 'INVALID_RESPONSE', '模型响应超过大小限制，未载入结果。');
  }
  if (!response.body) fail(502, 'INVALID_RESPONSE', '模型没有返回可读取的结果。');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); fail(502, 'INVALID_RESPONSE', '模型响应超过大小限制，未载入结果。'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail(502, 'INVALID_RESPONSE', '模型返回格式不完整，未载入结果。'); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

const QUOTA_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_hard_limit_reached', 'billing_not_active']);
const RATE_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'slow_down']);
const SAFE_UPSTREAM_CODES = new Set([...QUOTA_CODES, ...RATE_CODES, 'invalid_api_key', 'authentication_error', 'permission_error', 'insufficient_permissions', 'unsupported_country_region_territory', 'model_not_found', 'invalid_request_error', 'invalid_value', 'unsupported_parameter', 'context_length_exceeded', 'server_error', 'service_unavailable_error', 'server_is_overloaded']);

async function upstreamFailure(response: Response, signal: AbortSignal, otherProvider = false): Promise<ApiFailure> {
  let upstreamCode: string | undefined;
  // Only code/type from a bounded JSON error envelope may leave this function.
  // Never forward OpenAI's message, param, request IDs, headers, or arbitrary text.
  try {
    const body = await limitedResponse(response, AbortSignal.any([signal, AbortSignal.timeout(1500)]), 16_384);
    if (record(body) && record(body.error)) {
      const candidates = [body.error.code, body.error.type];
      upstreamCode = candidates.find((value): value is string => typeof value === 'string' && SAFE_UPSTREAM_CODES.has(value));
    }
  } catch { /* An unreadable error body does not erase the known HTTP status. */ }
  const status = response.status;
  const make = (localStatus: number, code: string, message: string) => new ApiFailure(localStatus, otherProvider ? code.replace('OPENAI_', 'MODEL_') : code, message.replaceAll('OpenAI', '模型服务商').replace('GPT-4o', '所选模型'), status, upstreamCode);
  if (status === 402) return make(402, 'OPENAI_QUOTA', '模型服务商余额不足，请检查账户余额。');
  if (status === 401) return make(401, 'OPENAI_AUTH', 'OpenAI 未接受当前密钥或身份权限，请检查配置。');
  if (status === 403) return make(403, 'OPENAI_PERMISSION', 'OpenAI 拒绝访问，请检查账户、模型及地区访问权限。');
  if (status === 429) {
    if (upstreamCode && QUOTA_CODES.has(upstreamCode)) return make(429, 'OPENAI_QUOTA', 'OpenAI 余额或调用额度受限，请检查账户余额与使用限额。');
    if (upstreamCode && RATE_CODES.has(upstreamCode)) return make(429, 'OPENAI_RATE_LIMIT', 'OpenAI 请求速率受限，请稍后手动重试。');
    return make(429, 'OPENAI_LIMIT', 'OpenAI 调用受限，请检查账户额度和请求速率。');
  }
  if (status === 400) return make(400, 'OPENAI_REQUEST_INVALID', 'OpenAI 拒绝了请求参数，请检查模型与请求格式。');
  if (status === 404) return make(404, 'OPENAI_MODEL_UNAVAILABLE', 'OpenAI 模型或接口资源不可用，请检查 GPT-4o 访问权限。');
  return make(502, 'OPENAI_UNAVAILABLE', 'OpenAI 服务未完成请求，请稍后手动重试。');
}

function completedOutput(value: unknown, model = MODEL): { output: unknown; usage: Usage } {
  if (!record(value)) fail(502, 'INVALID_RESPONSE', '模型返回格式不正确。');
  if (value.status !== 'completed' || value.incomplete_details || value.error) fail(502, 'OPENAI_INCOMPLETE', '模型未完成全部分析，未载入部分结果。');
  if (!matchesModel(value.model, model)) fail(502, 'INVALID_RESPONSE', '返回模型与所选模型不一致。');
  if (!Array.isArray(value.output) || value.output.length === 0) fail(502, 'INVALID_RESPONSE', '模型没有返回分析结果。');
  const texts: string[] = [];
  for (const item of value.output) {
    if (record(item) && Array.isArray(item.content) && item.content.some(content => record(content) && content.type === 'refusal')) fail(422, 'OPENAI_REFUSED', '模型拒绝处理本次材料，未载入结果。');
    if (!record(item) || item.type !== 'message' || item.role !== 'assistant' || (item.status !== undefined && item.status !== 'completed') || !Array.isArray(item.content)) fail(502, 'INVALID_RESPONSE', '模型返回了不支持的结果类型。');
    for (const content of item.content) {
      if (record(content) && content.type === 'refusal') fail(422, 'OPENAI_REFUSED', '模型拒绝处理本次材料，未载入结果。');
      if (!record(content) || content.type !== 'output_text' || typeof content.text !== 'string') fail(502, 'INVALID_RESPONSE', '模型返回了不支持的结果类型。');
      texts.push(content.text);
    }
  }
  if (texts.length !== 1 || !texts[0].trim()) fail(502, 'INVALID_RESPONSE', '模型没有返回完整的结构化结果。');
  const u = value.usage;
  if (!record(u) || !['input_tokens', 'output_tokens', 'total_tokens'].every(field => Number.isSafeInteger(u[field]) && (u[field] as number) >= 0) || (u.output_tokens as number) > MAX_OUTPUT_TOKENS || u.total_tokens !== (u.input_tokens as number) + (u.output_tokens as number)) fail(502, 'INVALID_RESPONSE', '模型用量信息不完整，未载入结果。');
  let output: unknown;
  try { output = JSON.parse(texts[0]); } catch { fail(502, 'INVALID_RESPONSE', '模型返回格式不完整，未载入结果。'); }
  return { output, usage: { inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number, totalTokens: u.total_tokens as number } };
}


export { ApiFailure, fail, record, limitedResponse, upstreamFailure, completedOutput };
