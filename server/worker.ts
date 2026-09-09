import { prepareCloudCase, buildExtractionRequest, finalizeCloudAnalysis } from '../src/dealgraph/relationships/cloud-extraction.ts';
import { ApiFailure, fail, record, limitedResponse, upstreamFailure } from './response-contract.ts';
import { DEFAULT_SELECTION, MODEL_PROVIDERS, consentFor, isModelSelection, validApiKey } from '../src/dealgraph/relationships/model-catalog.ts';
import { ENDPOINTS, modelRequest, parseModelOutput } from './model-adapters.ts';
import { prepareDiscoveryInput } from '../src/dealgraph/relationships/wechat-import.ts';
import { buildDiscoveryRequest, discoveryConsentFor, finalizeDiscovery } from '../src/dealgraph/relationships/entity-discovery.ts';

const API = '/api/relationships';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; media-src 'self'; base-uri 'self'; form-action 'none'";
type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
export type Env = { APP_ORIGIN?: string; ASSETS?: { fetch(request: Request): Promise<Response> }; API_LIMIT: Limiter; GLOBAL_LIMIT: Limiter };
let concurrent = 0;

function configuredOrigin(env: Env): string {
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || origin.username || origin.password) throw new Error('Invalid origin');
    return origin.origin;
  } catch { return fail(503, 'SERVICE_UNAVAILABLE', '部署来源配置未就绪，请联系部署者配置 APP_ORIGIN。'); }
}

function headers() {
  return new Headers({ 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()' });
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: headers() }); }
function checkSource(request: Request, mutation: boolean, allowedOrigin: string) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (url.origin !== allowedOrigin || url.search || request.headers.has('forwarded') || request.headers.has('x-forwarded-host')) fail(403, 'ACCESS_DENIED', '请求来源未通过校验。');
  if (site !== null && site !== 'same-origin' && site !== 'none') fail(403, 'ACCESS_DENIED', '不允许跨站请求。');
  if ((mutation || origin !== null) && origin !== allowedOrigin) fail(403, 'ACCESS_DENIED', '请从当前部署的 DealGraph 页面操作。');
  if (mutation && request.headers.get('x-dealgraph-client') !== 'byok-v1') fail(403, 'ACCESS_DENIED', '请求格式未通过校验。');
}
async function bodyJson(request: Request, limit: number, signal: AbortSignal) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity')) fail(415, 'INVALID_REQUEST', '只接受未压缩 JSON。');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail(413, 'REQUEST_TOO_LARGE', '提交内容过大。');
  let value: unknown;
  try { value = await limitedResponse(new Response(request.body, { headers: length === null ? {} : { 'content-length': length } }), signal, limit); }
  catch { if (signal.aborted) fail(408, 'REQUEST_TIMEOUT', '提交超时。'); fail(400, 'INVALID_REQUEST', '提交内容过大或格式不正确。'); }
  if (!record(value)) fail(400, 'INVALID_REQUEST', '提交格式不正确。');
  return value;
}

/** No key, customer document, result, session or cookie is retained between requests. */
export async function handleRequest(request: Request, env: Env, outbound: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<Response> {
  const path = new URL(request.url).pathname;
  let counted = false;
  let totalSignal: AbortSignal | undefined;
  try {
    const allowedOrigin = configuredOrigin(env);
    const url = new URL(request.url);
    if (url.protocol === 'http:' && url.host === new URL(allowedOrigin).host && ['GET', 'HEAD'].includes(request.method)) { url.protocol = 'https:'; return Response.redirect(url.toString(), 308); }
    if (url.origin !== allowedOrigin) fail(403, 'ACCESS_DENIED', '域名校验失败。');
    if (!path.startsWith(API)) {
      if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', '请求方式不支持。');
      if (!env.ASSETS) fail(503, 'SERVICE_UNAVAILABLE', '静态资源绑定未就绪。');
      // The app and API are deployed together; never forward credentials to assets.
      const assetHeaders = new Headers({ Accept: request.headers.get('accept') ?? '*/*' });
      const range = request.headers.get('range');
      if (range && /^bytes=(?:\d+-\d*|-\d+)$/.test(range)) assetHeaders.set('Range', range);
      const upstream = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: assetHeaders, redirect: 'manual', signal: request.signal }));
      const secure = new Headers(upstream.headers);
      const policy = headers();
      for (const name of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'strict-transport-security', 'permissions-policy']) secure.set(name, policy.get(name)!);
      secure.delete('set-cookie'); secure.delete('access-control-allow-origin');
      // Prevent the CDN from injecting analytics or rewriting this privacy-sensitive UI.
      if (path === '/' || path.endsWith('.html') || /text\/html/i.test(secure.get('content-type') ?? '')) secure.set('Cache-Control', 'no-store, no-transform');
      return new Response(upstream.body, { status: upstream.status, headers: secure });
    }
    checkSource(request, request.method !== 'GET', allowedOrigin);
    if (path === `${API}/status` && request.method === 'GET') return json({ configured: false, ...DEFAULT_SELECTION, providers: MODEL_PROVIDERS.map(({ id, models }) => ({ id, models: models.map(model => model.id) })), mode: 'stateless-byok', capabilities: 'multi-model-v2', discovery: true, contract: 'commercial-relations-v3', version: '2026-09-09.5' });
    if (![`${API}/analyze`, `${API}/diagnose`, `${API}/discover`].includes(path)) fail(404, 'NOT_FOUND', '接口不存在。');
    if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '请求方式不支持。');
    if (path !== `${API}/diagnose` && request.headers.get('x-dealgraph-contract') !== 'commercial-relations-v3') fail(409, 'VERSION_MISMATCH', '页面版本已更新，请先加密保存资料，再刷新页面重试；尚未调用模型。');
    if (!env.API_LIMIT || !env.GLOBAL_LIMIT) fail(503, 'SERVICE_UNAVAILABLE', '服务限流配置未就绪。');
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip) fail(403, 'ACCESS_DENIED', '来源校验未通过。');
    if (!(await env.API_LIMIT.limit({ key: ip })).success || !(await env.GLOBAL_LIMIT.limit({ key: 'all-api' })).success) fail(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。');
    if (concurrent >= 4) fail(429, 'RATE_LIMITED', '服务繁忙，请稍后重试。');
    concurrent++; counted = true;
    const diagnosis = path === `${API}/diagnose`;
    totalSignal = AbortSignal.any([request.signal, AbortSignal.timeout(diagnosis ? 12_000 : 300_000)]);
    const input = await bodyJson(request, diagnosis ? 128 : 1_048_576, AbortSignal.any([totalSignal, AbortSignal.timeout(10_000)]));
    // Old cached pages may call only the original OpenAI route, never another provider.
    const legacy = input.provider === undefined && input.model === undefined;
    const selection = legacy ? DEFAULT_SELECTION : { provider: input.provider, model: input.model };
    if (!isModelSelection(selection)) fail(400, 'MODEL_SELECTION_INVALID', '请选择列表中的服务商和模型。');
    const endpoints = ENDPOINTS[selection.provider];
    if (diagnosis) {
      if (request.headers.has('authorization') || Object.keys(input).some(key => !['provider', 'model'].includes(key))) fail(400, 'INVALID_REQUEST', '检测连接不接受密钥或材料。');
      const started = Date.now();
      try {
        const response = await outbound(endpoints.diagnose, { method: 'GET', redirect: 'manual', signal: totalSignal });
        await response.body?.cancel();
        const reachable = response.status >= 200 && response.status < 300 || [401, 403].includes(response.status);
        return json({ ...selection, reachable, route: 'direct', code: reachable ? 'NETWORK_OK' : 'NETWORK_CONNECT', elapsedMs: Date.now() - started, httpStatus: response.status });
      } catch { return json({ ...selection, reachable: false, route: 'direct', code: totalSignal.aborted ? 'DIAGNOSIS_TIMEOUT' : 'NETWORK_CONNECT', elapsedMs: Date.now() - started }); }
    }
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || !validApiKey(authorization.slice(7))) fail(401, 'KEY_REQUIRED', '请在当前页面配置自己的模型服务商密钥。');
    const discovering = path === `${API}/discover`;
    if (!(input.consentVersion === (discovering ? discoveryConsentFor(selection) : consentFor(selection)) || !discovering && legacy && input.consentVersion === 'openai-upload-v1')) fail(400, 'CONSENT_REQUIRED', '请重新确认所选服务商、模型及本次任务的上传。');
    if (Object.keys(input).some(key => !['case', 'consentVersion', 'provider', 'model'].includes(key))) fail(400, 'INVALID_REQUEST', '不接受额外配置。');
    let discovery: ReturnType<typeof prepareDiscoveryInput> | undefined;
    let prepared: ReturnType<typeof prepareCloudCase> | undefined;
    try { if (discovering) discovery = prepareDiscoveryInput(input.case); else prepared = prepareCloudCase(input.case); } catch { fail(400, 'INVALID_CASE', '材料格式或规模不符合要求。'); }
    const batches = discovery?.batches ?? prepared!.batches;
    if (!batches.length) fail(422, 'NO_ELIGIBLE_DOCUMENTS', '没有适用文本。');
    if (prepared && prepared.excludedFutureDocuments !== 0) fail(400, 'INVALID_CASE', '未来文本应在浏览器中排除。');
    const outputs: Parameters<typeof finalizeCloudAnalysis>[1] = [];
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const batch of batches) {
      if (totalSignal.aborted) fail(504, 'ANALYSIS_TIMEOUT', '分析已取消或超时。');
      const prompt = discovery ? buildDiscoveryRequest(discovery.input, batch) : buildExtractionRequest(prepared!.caseFile, batch);
      const signal = AbortSignal.any([totalSignal, AbortSignal.timeout(120_000)]);
      let response: Response;
      try {
        // Workers only implement manual/follow. Never follow redirects with a user's key.
        response = await outbound(endpoints.analyze, { method: 'POST', redirect: 'manual', signal,
          headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify(modelRequest(selection, prompt)),
        });
      } catch { fail(signal.aborted ? 504 : 502, signal.aborted ? 'ANALYSIS_TIMEOUT' : 'NETWORK_CONNECT', '本次模型请求未完成。'); }
      if (!response.ok) throw await upstreamFailure(response, signal, selection.provider !== 'openai');
      const output = parseModelOutput(await limitedResponse(response, signal), selection);
      if (signal.aborted) fail(504, 'ANALYSIS_TIMEOUT', '模型响应超时。');
      outputs.push({ documentIds: batch.map(document => document.id), output: output.output });
      usage.inputTokens += output.usage.inputTokens; usage.outputTokens += output.usage.outputTokens; usage.totalTokens += output.usage.totalTokens;
    }
    if (totalSignal.aborted) fail(504, 'ANALYSIS_TIMEOUT', '分析已取消或超时。');
    if (discovery) {
      let result;
      try { result = finalizeDiscovery(discovery.input, outputs); } catch { fail(502, 'DISCOVERY_VALIDATION_FAILED', '模型已返回，但节点引用或材料范围未通过校验；名单未更新。'); }
      return json({ discovery: result, batches: outputs, ...selection, usage, documentsSent: discovery.input.documents.length, excludedFutureDocuments: 0 });
    }
    let analysis: ReturnType<typeof finalizeCloudAnalysis>;
    try { analysis = finalizeCloudAnalysis(prepared!.caseFile, outputs); } catch { fail(502, 'RELATION_VALIDATION_FAILED', '模型已返回，但关系引用、身份或材料完整性未通过校验；图谱未更新。'); }
    return json({ analysis, ...selection, usage, documentsSent: prepared!.documentsSent, excludedFutureDocuments: 0 });
  } catch (error) {
    const safe = error instanceof ApiFailure ? error : new ApiFailure(500, 'INTERNAL_ERROR', '本次请求未能完成。');
    return json({ error: { code: safe.code, message: safe.message } }, safe.status);
  } finally { if (counted) concurrent--; }
}

export default { fetch(request: Request, env: Env) { return handleRequest(request, env); } };
