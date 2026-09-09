import type { ModelSelection } from '../src/dealgraph/relationships/model-catalog.ts';
import type { buildExtractionRequest } from '../src/dealgraph/relationships/cloud-extraction.ts';
import { completedOutput, fail, record } from './response-contract.ts';

// Fixed official endpoints only. No caller-supplied URL, proxy, fallback provider or redirects.
export const ENDPOINTS = {
  openai: { analyze: 'https://api.openai.com/v1/responses', diagnose: 'https://api.openai.com/v1/models' },
  deepseek: { analyze: 'https://api.deepseek.com/chat/completions', diagnose: 'https://api.deepseek.com/models' },
  qwen: { analyze: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', diagnose: 'https://dashscope.aliyuncs.com/api/v1/models' },
  kimi: { analyze: 'https://api.moonshot.cn/v1/chat/completions', diagnose: 'https://api.moonshot.cn/v1/models' },
} as const;

export function modelRequest(selection: ModelSelection, prompt: ReturnType<typeof buildExtractionRequest> & { schemaName?: string; emptyResult?: object }) {
  if (selection.provider === 'openai') return { model: selection.model, store: false, temperature: 0, max_output_tokens: 8192, stream: false, background: false, tools: [], tool_choice: 'none', instructions: prompt.instructions, input: prompt.input, text: { format: { type: 'json_schema', name: prompt.schemaName ?? 'relationship_extraction', strict: true, schema: prompt.schema } } };
  const parameters = selection.provider === 'qwen' ? { enable_thinking: false, temperature: 0.1, max_tokens: 8192 }
    : selection.provider === 'kimi' ? { thinking: { type: 'disabled' }, max_completion_tokens: 8192 }
      : { thinking: { type: 'disabled' }, temperature: 0, max_tokens: 8192 };
  return { model: selection.model, ...parameters, stream: false, response_format: { type: 'json_object' }, messages: [
    { role: 'system', content: `${prompt.instructions}\nReturn only a JSON object. No markdown or commentary. Follow this JSON Schema exactly (all fields required):\n${JSON.stringify(prompt.schema)}\nIf nothing qualifies, return ${JSON.stringify(prompt.emptyResult ?? { facts: [] })}.` },
    { role: 'user', content: prompt.input },
  ] };
}

export function parseModelOutput(value: unknown, selection: ModelSelection) {
  if (selection.provider === 'openai') return completedOutput(value, selection.model);
  if (!record(value) || value.model !== selection.model || !Array.isArray(value.choices) || value.choices.length !== 1 || value.error) fail(502, 'INVALID_RESPONSE', '模型返回格式或模型标识不正确。');
  const choice = value.choices[0];
  if (!record(choice) || choice.finish_reason !== 'stop') fail(502, 'MODEL_INCOMPLETE', '模型结果不完整，本次图谱未更新。');
  const message = choice.message;
  if (!record(message) || message.role !== 'assistant' || typeof message.content !== 'string' || !message.content.trim() || message.tool_calls || message.function_call || message.refusal) fail(502, 'INVALID_RESPONSE', '模型未返回完整的关系结果。');
  const usage = value.usage;
  if (!record(usage) || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(field => Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0) || (usage.completion_tokens as number) > 8192 || usage.total_tokens !== (usage.prompt_tokens as number) + (usage.completion_tokens as number)) fail(502, 'INVALID_RESPONSE', '模型用量信息不完整。');
  let output: unknown;
  try { output = JSON.parse(message.content); } catch { fail(502, 'INVALID_RESPONSE', '模型返回的 JSON 不完整。'); }
  return { output, usage: { inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number, totalTokens: usage.total_tokens as number } };
}
