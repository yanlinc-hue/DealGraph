export type ProviderId = 'openai' | 'deepseek' | 'qwen' | 'kimi';
export interface ModelSelection { provider: ProviderId; model: string }
export const DEFAULT_SELECTION: ModelSelection = { provider: 'openai', model: 'gpt-4o' };
export const UPLOAD_CONSENT_VERSION = 'model-upload-v2';
export const MODEL_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', region: '海外', models: [{ id: 'gpt-4o', name: 'GPT-4o（默认）' }, { id: 'gpt-4o-mini', name: 'GPT-4o mini' }], note: '使用 OpenAI API 密钥。请求设置 store: false，但不等于零保留，仍适用服务商的数据政策。', privacyUrl: 'https://developers.openai.com/api/docs/guides/your-data' },
  { id: 'deepseek', name: 'DeepSeek', region: '国内', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }], note: '使用 DeepSeek 开放平台密钥。以非思考模式提取关系，数据处理和保留以服务商政策为准。', privacyUrl: 'https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html' },
  { id: 'qwen', name: '通义千问', region: '国内', models: [{ id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen-flash', name: 'Qwen Flash' }], note: '仅支持阿里云百炼北京地域密钥，不自动切换地域。数据处理和保留以服务商政策为准。', privacyUrl: 'https://help.aliyun.com/zh/model-studio/privacy-notice' },
  { id: 'kimi', name: 'Kimi', region: '国内', models: [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }], note: '使用 Moonshot 中国站开放平台密钥。以非思考模式提取关系，数据处理和保留以服务商政策为准。', privacyUrl: 'https://www.kimi.ai/zh-hans/help/kimi-api/api-data-security' },
] as const;
export function providerInfo(id: ProviderId) { return MODEL_PROVIDERS.find(provider => provider.id === id)!; }
export function isModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== 'object') return false;
  const { provider, model } = value as Record<string, unknown>;
  return MODEL_PROVIDERS.some(item => item.id === provider && item.models.some(entry => entry.id === model));
}
export function validApiKey(key: string) { return /^[A-Za-z0-9_-]{16,512}$/.test(key); }
export function consentFor(selection: ModelSelection) { return `${UPLOAD_CONSENT_VERSION}:${selection.provider}:${selection.model}`; }
export function matchesModel(actual: unknown, expected: string) {
  return typeof actual === 'string' && (actual === expected || (actual.startsWith(`${expected}-`) && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1))));
}
