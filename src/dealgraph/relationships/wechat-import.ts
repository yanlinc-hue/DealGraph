import { validateRelationshipCase } from './engine.ts';
import { prepareCloudCase } from './cloud-extraction.ts';
import type { RelationshipCase, RelationshipDocument, RelationshipEntity } from './types.ts';

export const WECHAT_LIMITS = { files: 10, bytes: 20 * 1024 * 1024, messages: 50_000, messageText: 200_000, chunk: 10_000 } as const;
export interface ChatMessage { id: string; chatId: string; ts: number; day: string; time: string; sender: string; text: string; typeId: number }
export interface ChatArchive { chats: { id: string; label: string }[]; messages: ChatMessage[]; privateIds: string[] }
export interface ImportOptions { chatIds: string[]; start: string; end: string; excluded: string[]; maskContacts: boolean; privateTerms: string[]; edits: Record<string, string>; synthetic: boolean }
export interface DiscoveryInput { schema: 'dealgraph.discovery-input.v1'; title: string; asOf: string; dataClass: 'synthetic' | 'user-provided'; documents: RelationshipDocument[] }
export interface ImportPreview { input: DiscoveryInput; textCount: number; mediaCount: number; excludedCount: number; characters: number; batches: number }

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uE000\uE001]/u.test(value)) fail('聊天字段缺失、过长或包含不支持的字符。');
  return value;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail('不是支持的 聊天记录 JSON v1 格式。');
}
export function chinaDay(ts: number): string { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }
function validDay(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }

/** No filesystem, network, persistence or WeChat access. Raw identifiers never become document IDs. */
export function parseWechatExportFiles(files: unknown[]): ChatArchive {
  if (!files.length || files.length > WECHAT_LIMITS.files) fail('一次请选择 1–10 个 聊天记录 JSON 文件。');
  const chats: ChatArchive['chats'] = [], messages: ChatMessage[] = [];
  const privateIds = new Set<string>(), chatIds = new Map<string, string>();
  files.forEach((raw, fileIndex) => {
    if (!record(raw)) fail('文件不是支持的聊天 JSON。');
    keys(raw, ['wxid', 'name', 'format_version', 'messages']);
    if (raw.format_version !== 1 || !Array.isArray(raw.messages)) fail('目前支持 聊天记录 JSON v1；不支持微信迁移备份。');
    const wxid = string(raw.wxid, 200); if (!wxid) fail('缺少会话标识。'); privateIds.add(wxid);
    const label = string(raw.name, 200);
    if (!chatIds.has(wxid)) { const id = `chat-${chatIds.size + 1}`; chatIds.set(wxid, id); chats.push({ id, label: label || `会话 ${fileIndex + 1}` }); }
    const chatId = chatIds.get(wxid)!;
    if (raw.messages.length + messages.length > WECHAT_LIMITS.messages) fail('消息超过 5 万条，请按会话或时间分别导出。');
    const senders = new Map<string, string>();
    raw.messages.forEach((rawMessage, index) => {
      if (!record(rawMessage)) fail('消息格式不正确。');
      keys(rawMessage, ['ts', 'time', 'from_id', 'from', 'type', 'type_id', 'text']);
      const ts = rawMessage.ts;
      if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0 || ts > 32_503_680_000) fail('消息时间应为 Unix 秒，不是毫秒。');
      const expected = new Date(ts * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      if (string(rawMessage.time, 30) !== expected) fail('消息日期与时间戳不一致，请重新导出。');
      const senderId = string(rawMessage.from_id, 200), senderName = string(rawMessage.from, 200);
      if (senderId && senderId !== 'self') privateIds.add(senderId);
      if (!senders.has(senderId)) senders.set(senderId, `发言人 ${senders.size + 1}`);
      const sender = !senderName || senderName === senderId || senderName === '你' || senderId === 'self' ? senders.get(senderId)! : senderName;
      string(rawMessage.type, 80);
      if (!Number.isSafeInteger(rawMessage.type_id) || (rawMessage.type_id as number) < 0) fail('消息类型无效。');
      messages.push({ id: `${chatId}-f${fileIndex + 1}-m${index + 1}`, chatId, ts, day: expected.slice(0, 10), time: expected, sender, typeId: rawMessage.type_id as number, text: string(rawMessage.text, WECHAT_LIMITS.messageText) });
    });
  });
  return { chats, messages: messages.sort((a, b) => a.ts - b.ts), privateIds: [...privateIds] };
}

export function redactChatText(value: string, maskContacts: boolean, terms: string[], privateIds: string[] = []): string {
  return makeRedactor(maskContacts, terms, privateIds)(value);
}
function makeRedactor(maskContacts: boolean, terms: string[], privateIds: string[]) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ids = [...new Set(privateIds)].filter(Boolean).sort((a, b) => b.length - a.length);
  const idPattern = ids.length ? new RegExp(ids.map(escape).join('|'), 'gu') : null;
  const hiddenTerms = [...new Set(terms.map(term => term.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  return (value: string) => {
  let text = idPattern ? value.replace(idPattern, '[微信标识已隐藏]') : value;
  text = text.replace(/\bwxid_[a-z\d_-]+\b/giu, '[微信标识已隐藏]');
  if (maskContacts) text = text
    .replace(/\b(?:sk-[a-z\d_-]{12,})\b/giu, '[密钥已隐藏]')
    .replace(/[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+/giu, '[邮箱已隐藏]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, '[手机号已隐藏]')
    .replace(/(?<![a-z\d])\d{15,19}[xX]?(?![a-z\d])/gu, '[长号码已隐藏]');
  for (const term of hiddenTerms) text = text.split(term).join('[自定义内容已隐藏]');
  return text;
  };
}

export function defaultImportOptions(archive: ChatArchive, now = Date.now()): ImportOptions {
  const today = chinaDay(now), first = archive.messages[0]?.day ?? today;
  return { chatIds: archive.chats.map(chat => chat.id), start: first > today ? today : first, end: today, excluded: [], maskContacts: true, privateTerms: [], edits: {}, synthetic: false };
}

/** Build the exact upload preview, grouping consecutive selected messages without truncating. */
export function prepareWechatImport(archive: ChatArchive, options: ImportOptions): ImportPreview {
  if (!validDay(options.start) || !validDay(options.end) || options.start > options.end) fail('请选择有效的起止日期（北京时间）。');
  if (options.privateTerms.length > 100 || options.privateTerms.some(term => term.length > 200)) fail('自定义隐藏词最多 100 个，每个不超过 200 字符。');
  const included = new Set(options.chatIds), excluded = new Set(options.excluded);
  const selected = archive.messages.filter(message => included.has(message.chatId) && message.day >= options.start && message.day <= options.end && !excluded.has(message.id));
  const texts = selected.filter(message => message.typeId === 1 && (options.edits[message.id] ?? message.text).trim());
  if (!texts.length) fail('所选范围没有文字消息；图片、语音、文件和分享卡片暂不解析。');
  const documents: RelationshipDocument[] = [];
  const redact = makeRedactor(options.maskContacts, options.privateTerms, archive.privateIds);
  let totalCharacters = 0;
  for (const chat of archive.chats.filter(chat => included.has(chat.id))) {
    let content = '', lastTs = 0, part = 0;
    const flush = () => {
      if (!content) return;
      documents.push({ id: `${chat.id}-part-${++part}`, sourceId: chat.id, title: `聊天片段 ${documents.length + 1}`, sourceKind: 'chat', publishedAt: new Date(lastTs * 1000).toISOString(), text: content });
      content = '';
    };
    for (const message of texts.filter(message => message.chatId === chat.id)) {
      const edited = string(options.edits[message.id] ?? message.text, WECHAT_LIMITS.messageText);
      if (edited.length > WECHAT_LIMITS.chunk) fail('单条消息超过 1 万字符，请编辑或排除；不会截断。');
      const line = redact(`【${message.sender} · ${message.time}（UTC+8）】\n${edited}\n`);
      // Never split a single message away from a late denial or correction.
      if (line.length > WECHAT_LIMITS.chunk) fail('单条消息超过 1 万字符，请在预览中编辑或排除该消息；不会截断后半段。');
      totalCharacters += line.length;
      if (totalCharacters > 60_000) fail('本次文字超过 6 万字符，请缩小会话或日期范围；不会自动截断。');
      if (content.length + line.length > WECHAT_LIMITS.chunk) flush();
      content += line; lastTs = message.ts;
    }
    flush();
  }
  const input: DiscoveryInput = { schema: 'dealgraph.discovery-input.v1', title: '微信客户关系', asOf: `${options.end}T23:59:59+08:00`, dataClass: options.synthetic ? 'synthetic' : 'user-provided', documents };
  const prepared = prepareDiscoveryInput(input);
  return { input: prepared.input, textCount: texts.length, mediaCount: selected.length - texts.length, excludedCount: archive.messages.length - selected.length, characters: prepared.input.documents.reduce((sum, doc) => sum + doc.text.length, 0), batches: prepared.batches.length };
}

/** Independent document-only contract; discovery never invents a placeholder identity. */
export function prepareDiscoveryInput(value: unknown): { input: DiscoveryInput; batches: RelationshipDocument[][] } {
  if (!record(value)) fail('节点发现材料格式不正确。');
  keys(value, ['schema', 'title', 'asOf', 'dataClass', 'documents']);
  if (value.schema !== 'dealgraph.discovery-input.v1') fail('节点发现格式版本不支持。');
  const title = string(value.title, 160), asOf = string(value.asOf, 32);
  if (!title.trim() || !/^\d{4}-\d{2}-\d{2}T23:59:59\+08:00$/.test(asOf) || !validDay(asOf.slice(0, 10))) fail('请使用北京时间的分析截止日期。');
  if (value.dataClass !== 'synthetic' && value.dataClass !== 'user-provided') fail('缺少数据类型。');
  if (!Array.isArray(value.documents) || !value.documents.length || value.documents.length > 60) fail('每次请选择 1–60 个文本分段。');
  const ids = new Set<string>();
  const documents: RelationshipDocument[] = value.documents.map(raw => {
    if (!record(raw)) fail('聊天分段格式不正确。');
    keys(raw, ['id', 'sourceId', 'title', 'sourceKind', 'publishedAt', 'text']);
    const id = string(raw.id, 100), sourceId = string(raw.sourceId, 100), text = string(raw.text, 12_000).trim(), publishedAt = string(raw.publishedAt, 32), documentTitle = string(raw.title, 160);
    if (!id || !sourceId || !text.trim() || !documentTitle || ids.has(id) || raw.sourceKind !== 'chat') fail('聊天分段为空、重复或不是聊天来源。');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt)) || new Date(publishedAt).toISOString() !== publishedAt || Date.parse(publishedAt) > Date.parse(asOf)) fail('聊天时间无效或超出截止日期。');
    ids.add(id);
    return { id, sourceId, title: documentTitle, sourceKind: 'chat', publishedAt, text };
  });
  if (documents.reduce((sum, doc) => sum + doc.text.length, 0) > 60_000) fail('本次文字超过 6 万字符，请缩小会话或日期范围；不会自动截断。');
  const batches: RelationshipDocument[][] = []; let current: RelationshipDocument[] = [], size = 0;
  for (const doc of documents) {
    if (size + doc.text.length > 12_000 && current.length) { batches.push(current); current = []; size = 0; }
    current.push(doc); size += doc.text.length;
  }
  if (current.length) batches.push(current);
  if (batches.length > 6) fail('所选材料超过 6 批，请缩小范围；不会只分析前几批。');
  return { input: { schema: 'dealgraph.discovery-input.v1', title, asOf, dataClass: value.dataClass, documents }, batches };
}

export function caseFromConfirmedNodes(input: DiscoveryInput, entities: RelationshipEntity[]): RelationshipCase {
  const prepared = prepareDiscoveryInput(input);
  const caseFile = validateRelationshipCase({ ...prepared.input, schema: 'dealgraph.relationship-case.v1', entities });
  prepareCloudCase(caseFile);
  return caseFile;
}

export function mergeConfirmedNodes(nodes: RelationshipEntity[], sourceId: string, targetId: string): RelationshipEntity[] {
  const source = nodes.find(node => node.id === sourceId), target = nodes.find(node => node.id === targetId);
  if (!source || !target || sourceId === targetId || source.kind !== target.kind) fail('只能合并同一类型的两个节点。');
  const aliases = [...new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])].filter(name => name !== target.name);
  if (aliases.length > 30) fail('合并后的别名过多，请先整理。');
  return nodes.filter(node => node.id !== sourceId).map(node => node.id === targetId ? { ...node, aliases } : node);
}
