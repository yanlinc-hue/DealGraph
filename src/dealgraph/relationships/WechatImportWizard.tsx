import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { CloudClientError, CloudRunGate, createRelationshipCloudClient } from './cloud-client';
import type { CloudResult, CloudUsage } from './cloud-client';
import { DEFAULT_SELECTION, MODEL_PROVIDERS, consentFor, providerInfo } from './model-catalog';
import type { ModelSelection, ProviderId } from './model-catalog';
import { discoveryConsentFor } from './entity-discovery';
import { caseFromConfirmedNodes, chinaDay, defaultImportOptions, mergeConfirmedNodes, parseWechatExportFiles, prepareWechatImport, WECHAT_LIMITS } from './wechat-import';
import type { ChatArchive, ImportOptions, ImportPreview } from './wechat-import';
import type { RelationshipCase, RelationshipEntity } from './types';
import demo from './wechat-demo.json';
import './wechat-import.css';

type Step = 'prepare' | 'discover' | 'entities' | 'analyze';
const STEPS: { id: Step; title: string }[] = [{ id: 'prepare', title: '选材料' }, { id: 'discover', title: '发现商业节点' }, { id: 'entities', title: '确认名单' }, { id: 'analyze', title: '解析商业关系' }];
const KINDS = { person: '人物', organization: '机构', project: '项目' };
type Props = { onClose: () => void; onComplete: (input: RelationshipCase, result: CloudResult) => void };
const safeError = (error: unknown) => error instanceof CloudClientError ? error.message : error instanceof Error ? error.message.slice(0, 180) : '未能完成，请检查后重试。';

export default function WechatImportWizard({ onClose, onComplete }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), fileInput = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const client = useMemo(() => createRelationshipCloudClient(), []), gate = useMemo(() => new CloudRunGate(), []);
  const fileGeneration = useRef(0), statusGeneration = useRef(0), manualId = useRef(0);
  const [step, setStep] = useState<Step>('prepare');
  const [archive, setArchive] = useState<ChatArchive | null>(null), [options, setOptions] = useState<ImportOptions | null>(null);
  const [snapshot, setSnapshot] = useState<ImportPreview | null>(null), [confirmedCase, setConfirmedCase] = useState<RelationshipCase | null>(null);
  const [nodes, setNodes] = useState<RelationshipEntity[]>([]), [nodesConfirmed, setNodesConfirmed] = useState(false);
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({}), [nodeContexts, setNodeContexts] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<ModelSelection>(DEFAULT_SELECTION), [configured, setConfigured] = useState(false), [serviceReady, setServiceReady] = useState(false);
  const [key, setKey] = useState(''), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [discoveryUsage, setDiscoveryUsage] = useState<CloudUsage | null>(null);
  const [discoveryDiagnostics, setDiscoveryDiagnostics] = useState<import('./entity-discovery').DiscoveryDiagnostic[]>([]);
  const [completed, setCompleted] = useState<{ input: RelationshipCase; result: CloudResult } | null>(null);
  const [messagePage, setMessagePage] = useState(0), [mergeSource, setMergeSource] = useState(''), [mergeTarget, setMergeTarget] = useState('');
  const provider = providerInfo(selection.provider);
  const pendingImport = completed?.input === confirmedCase && completed.result.provider === selection.provider && completed.result.model === selection.model ? completed : null;
  const deliver = (input: RelationshipCase, result: CloudResult) => {
    // A capacity/validation failure must leave the dialog and paid result available.
    const element = dialog.current;
    onComplete(input, result);
    client.clearLocalKey(); setKey(''); setCompleted(null); element?.close();
  };
  const computed = useMemo(() => {
    if (!archive || !options) return { preview: null, error: '' };
    try { return { preview: prepareWechatImport(archive, options), error: '' }; } catch (error) { return { preview: null, error: safeError(error) }; }
  }, [archive, options]);
  const messages = useMemo(() => archive && options ? archive.messages.filter(message => options.chatIds.includes(message.chatId) && message.day >= options.start && message.day <= options.end && message.typeId === 1) : [], [archive, options]);
  const duplicates = useMemo(() => {
    const names = new Map<string, Set<string>>();
    for (const node of nodes) for (const name of [node.name, ...(node.aliases ?? [])].filter(Boolean)) { const ids = names.get(name) ?? new Set(); ids.add(node.id); names.set(name, ids); }
    return [...names].filter(([, ids]) => ids.size > 1).map(([name]) => name);
  }, [nodes]);
  const refreshStatus = async () => {
    const generation = ++statusGeneration.current;
    try {
      const status = await client.status(); if (generation !== statusGeneration.current) return;
      setServiceReady(status.discovery === true); setConfigured(status.configured);
      if (status.discovery) setError('');
      if (!status.discovery) setError('当前分析服务尚未更新到微信导入版；可先检查材料，暂不能调用节点发现。');
    } catch (error) { if (generation === statusGeneration.current) { setServiceReady(false); setError(safeError(error)); } }
  };
  useEffect(() => {
    dialog.current?.showModal();
    const leave = () => { fileGeneration.current++; statusGeneration.current++; gate.cancel(); client.clearLocalKey(); setKey(''); setConfigured(false); setConsent(false); setBusy(false); setReading(false); setArchive(null); setOptions(null); setSnapshot(null); setNodes([]); setDiscoveryDiagnostics([]); setAliasDrafts({}); setNodeContexts({}); setConfirmedCase(null); setCompleted(null); setStep('prepare'); };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); fileGeneration.current++; statusGeneration.current++; gate.cancel(); client.clearLocalKey(); };
  }, [client, gate]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  const cancel = () => { gate.cancel(); setBusy(false); setConsent(false); setNotice('已取消；已经发送的内容无法撤回，已处理部分仍可能计费。'); };
  const close = () => { fileGeneration.current++; statusGeneration.current++; gate.cancel(); client.clearLocalKey(); setKey(''); dialog.current?.close(); onClose(); };
  const editOptions = (patch: Partial<ImportOptions>) => { gate.cancel(); setOptions(current => current ? { ...current, ...patch } : current); setSnapshot(null); setNodes([]); setDiscoveryDiagnostics([]); setConfirmedCase(null); setCompleted(null); setNodesConfirmed(false); setConsent(false); setError(''); };
  const load = (values: unknown[], synthetic = false) => {
    const next = parseWechatExportFiles(values); const initial = defaultImportOptions(next); initial.synthetic = synthetic;
    gate.cancel(); setArchive(next); setOptions(initial); setSnapshot(null); setNodes([]); setDiscoveryDiagnostics([]); setAliasDrafts({}); setNodeContexts({}); setConfirmedCase(null); setCompleted(null); setNodesConfirmed(false); setConsent(false); setStep('prepare'); setMessagePage(0); setError(''); setDiscoveryUsage(null); setNotice('已在本机读取，没有上传聊天。');
  };
  const readFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = ''; if (!files.length) return;
    const generation = ++fileGeneration.current; gate.cancel(); setReading(true); setError('');
    try {
      if (files.length > WECHAT_LIMITS.files || files.reduce((sum, file) => sum + file.size, 0) > WECHAT_LIMITS.bytes) throw new Error('最多 10 个文件、合计 20 MB；请按会话分别导出。');
      const values = [];
      for (const file of files) { const text = await file.text(); if (generation !== fileGeneration.current) return; try { values.push(JSON.parse(text)); } catch { throw new Error('文件不是有效的 JSON。请使用 聊天记录 JSON 导出，不要选择微信备份目录。'); } }
      if (generation === fileGeneration.current) load(values);
    } catch (error) { if (generation === fileGeneration.current) setError(safeError(error)); }
    finally { if (generation === fileGeneration.current) setReading(false); }
  };
  const changeSelection = (next: ModelSelection) => {
    gate.cancel(); statusGeneration.current++; client.selectModel(next); setSelection(next); setKey(''); setConfigured(false); setConsent(false); setBusy(false); setError(''); setNodes([]); setDiscoveryDiagnostics([]); setConfirmedCase(null); setCompleted(null); setNodesConfirmed(false); setDiscoveryUsage(null); setStep('discover'); setNotice('已切换模型，密钥和旧候选已清除，请重新确认本次发现。'); void refreshStatus();
  };
  const configure = async () => {
    const draft = key; setKey(''); setError('');
    try { await client.configure(draft); setConfigured(true); setNotice('密钥仅暂存当前页面；尚未调用模型。'); } catch (error) { setError(safeError(error)); }
  };
  const backToMaterials = () => { gate.cancel(); setBusy(false); setConsent(false); setSnapshot(null); setNodes([]); setDiscoveryDiagnostics([]); setConfirmedCase(null); setCompleted(null); setNodesConfirmed(false); setDiscoveryUsage(null); setStep('prepare'); setError(''); setNotice('重新选择材料后，需要重新发现并确认名单。'); };
  const readyToDiscover = () => {
    if (!computed.preview) return;
    setSnapshot(structuredClone(computed.preview)); setNodes([]); setDiscoveryDiagnostics([]); setNodesConfirmed(false); setConsent(false); setStep('discover'); setError(''); setNotice('请检查预览后，单独授权本次节点发现。'); void refreshStatus();
  };
  const run = async () => {
    if (pendingImport) return;
    if (!snapshot || !consent || !configured || key.trim() || busy || !serviceReady || (step !== 'discover' && step !== 'analyze')) return;
    const purpose = step; let ticket;
    try { ticket = gate.begin(); } catch { return; }
    setBusy(true); setConsent(false); setError(''); setNotice('');
    try {
      if (purpose === 'discover') {
        const result = await client.discover(snapshot.input, discoveryConsentFor(selection), ticket.signal);
        if (!gate.isCurrent(ticket)) return;
        setNodes(result.discovery.candidates.map(({ id, name, kind }) => ({ id, name, kind }))); setNodesConfirmed(false); setDiscoveryUsage(result.usage); setStep('entities');
        setAliasDrafts({}); setNodeContexts(Object.fromEntries(result.discovery.candidates.map(node => [node.id, node.context])));
        setDiscoveryDiagnostics(result.discovery.diagnostics);
        const pending = result.discovery.diagnostics.filter(item => item.severity === 'review');
        const reviewNote = pending.length ? ` 另有 ${pending.length} 项未纳入名单（${[...new Set(pending.map(item => item.candidateName))].slice(0, 3).join('、')}）；请对照预览补充或更正后再确认，不能视为完整名单。` : '';
        setNotice((result.discovery.candidates.length ? `找到 ${result.discovery.candidates.length} 个商业候选节点。请确认身份；尚未解析关系。` : '未找到商业节点。可手动补充，或返回调整材料；没有生成关系。') + reviewNote);
      } else {
        if (!confirmedCase) throw new Error('请先确认节点名单。');
        const result = await client.analyze(confirmedCase, consentFor(selection), ticket.signal);
        if (!gate.isCurrent(ticket)) return;
        client.clearLocalKey(); setKey(''); setConfigured(false); setCompleted({ input: confirmedCase, result });
        deliver(confirmedCase, result);
      }
    } catch (error) { if (gate.isCurrent(ticket)) setError(safeError(error)); }
    finally { if (gate.finish(ticket)) setBusy(false); }
  };
  const confirmNodes = () => {
    if (!snapshot || !nodesConfirmed) return;
    try {
      const next = caseFromConfirmedNodes(snapshot.input, nodes);
      setConfirmedCase(next); setStep('analyze'); setConsent(false); setError(''); setNotice('名单已确认。关系分析是第二次上传，需要再次同意。'); void refreshStatus();
    } catch (error) { setError(safeError(error)); }
  };
  const updateNode = (id: string, patch: Partial<RelationshipEntity>) => { setNodes(current => current.map(node => node.id === id ? { ...node, ...patch } : node)); setNodesConfirmed(false); setConfirmedCase(null); setCompleted(null); setConsent(false); };
  const previewText = snapshot?.input.documents.map(doc => doc.text).join('\n── 下一分段 ──\n') ?? computed.preview?.input.documents.map(doc => doc.text).join('\n── 下一分段 ──\n') ?? '';

  return <dialog ref={dialog} className="rw-wechat-dialog" aria-labelledby="wechat-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="rw-wechat-heading"><div><span>商业关系 · 本地导入</span><h2 ref={heading} tabIndex={-1} id="wechat-title">导入微信聊天</h2></div><button className="rw-button" aria-label="关闭微信导入并清除草稿" onClick={close}>关闭</button></header>
    <ol className="rw-wechat-steps">{STEPS.map((item, i) => <li key={item.id} aria-current={step === item.id ? 'step' : undefined}><span>{i + 1}</span>{item.title}</li>)}</ol>
    <div className="rw-wechat-body">
      <p className="rw-wechat-scope">只梳理商业关系。吃饭、旅游、亲友、兴趣、同群和聊天频率不生成关系边。日常内容可能仍在所选文本中，请在上传前排除或编辑。</p>
      {step === 'prepare' && <>
        <div className="rw-wechat-file"><strong>聊天记录 JSON v1</strong><p>支持最多 10 个会话、20 MB、5 万条消息。先在浏览器读取，再选择本次分析范围；不连接微信、不修改微信程序，不接受迁移备份。</p><button className="rw-button rw-button-primary" disabled={reading} onClick={() => fileInput.current?.click()}>{reading ? '正在读取…' : archive ? '重新选择文件' : '选择聊天文件'}</button><button className="rw-button" disabled={reading} onClick={() => { fileGeneration.current++; load([demo], true); }}>试用虚构聊天</button><input ref={fileInput} type="file" accept=".json,application/json" multiple hidden onChange={event => { void readFiles(event); }} /></div>
        {archive && options && <>
          <fieldset><legend>选择会话与日期（北京时间）</legend><div className="rw-wechat-chat-list">{archive.chats.map(chat => <label key={chat.id}><input type="checkbox" checked={options.chatIds.includes(chat.id)} onChange={event => editOptions({ chatIds: event.target.checked ? [...options.chatIds, chat.id] : options.chatIds.filter(id => id !== chat.id) })} />{chat.label}</label>)}</div><div className="rw-wechat-fields"><label>开始日期<input type="date" value={options.start} max={options.end} onChange={event => { editOptions({ start: event.target.value }); setMessagePage(0); }} /></label><label>截止日期<input type="date" value={options.end} max={chinaDay(Date.now())} onChange={event => { editOptions({ end: event.target.value }); setMessagePage(0); }} /></label></div></fieldset>
          <fieldset><legend>上传前隐私检查</legend><label className="rw-wechat-check"><input type="checkbox" checked={options.maskContacts} onChange={event => editOptions({ maskContacts: event.target.checked })} />隐藏手机号、邮箱、长号码和常见密钥</label><p>微信原始标识始终移除。姓名、机构名和其他敏感文字仍可能保留；这是辅助处理，不是完全匿名。</p><label>另外隐藏这些内容（每行一项）<textarea rows={3} value={options.privateTerms.join('\n')} onChange={event => editOptions({ privateTerms: event.target.value.split('\n') })} placeholder="例如家庭住址、私人话题中的姓名" /></label><label className="rw-wechat-check"><input type="checkbox" checked={options.synthetic} onChange={event => editOptions({ synthetic: event.target.checked })} />此文件全部为虚构测试数据</label></fieldset>
          <details><summary>逐条排除或编辑消息 · 当前范围 {messages.length} 条文字</summary><p>下面显示本机原文。修改仅影响本次导入，不会改动原文件。去掉日常聊天可以减少上传内容和费用。</p>{messages.slice(messagePage * 20, (messagePage + 1) * 20).map(message => <div key={message.id} className="rw-wechat-message"><label><input type="checkbox" checked={!options.excluded.includes(message.id)} onChange={event => editOptions({ excluded: event.target.checked ? options.excluded.filter(id => id !== message.id) : [...options.excluded, message.id] })} />{message.sender} · {message.time}</label><textarea aria-label={`${message.time} 的消息内容`} rows={3} value={options.edits[message.id] ?? message.text} onChange={event => editOptions({ edits: { ...options.edits, [message.id]: event.target.value } })} /></div>)}<div className="rw-wechat-pagination"><button className="rw-button" disabled={messagePage === 0} onClick={() => setMessagePage(page => page - 1)}>上一页</button><span>第 {messagePage + 1} / {Math.max(1, Math.ceil(messages.length / 20))} 页</span><button className="rw-button" disabled={(messagePage + 1) * 20 >= messages.length} onClick={() => setMessagePage(page => page + 1)}>下一页</button></div></details>
          {computed.preview ? <p className="rw-wechat-summary">本次 {computed.preview.textCount} 条文字 · {computed.preview.characters.toLocaleString()} 字符 · 自动分为 {computed.preview.batches} 批。跳过 {computed.preview.mediaCount} 条媒体/空消息，范围外或手动排除 {computed.preview.excludedCount} 条。</p> : <p role="alert" className="rw-wechat-error">{computed.error}</p>}
        </>}
      </>}
      {pendingImport && step === 'analyze' && <div><p>模型已完成，加入工作台未成功。结果暂留当前窗口；重试只加入工作台，不再调用模型。关闭窗口会丢失此结果。</p><button className="rw-button rw-button-primary" disabled={busy} onClick={() => { try { setError(''); deliver(pendingImport.input, pendingImport.result); } catch (error) { setError(safeError(error)); } }}>重试加入工作台（不调用模型）</button></div>}
      {(step === 'discover' || step === 'analyze') && !pendingImport && <>
        <h3>{step === 'discover' ? '先找商业人物、机构和项目' : '使用已确认的名单解析商业关系'}</h3>
        <p>{step === 'discover' ? '模型只返回候选名单，你确认后才会分析关系。不会从亲友闲聊推断商业身份。' : `本次发送 ${confirmedCase?.entities.length ?? 0} 个已确认节点及同一份选定文本。只提取任职、决策、股权投资、企业融资、并购、顾问、项目合作和商务引荐。`}</p>
        <div className="rw-wechat-fields"><label>服务商<select value={selection.provider} disabled={busy} onChange={event => { const id = event.target.value as ProviderId; changeSelection({ provider: id, model: providerInfo(id).models[0].id }); }}>{MODEL_PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.name} · {item.region}</option>)}</select></label><label>模型<select value={selection.model} disabled={busy} onChange={event => changeSelection({ ...selection, model: event.target.value })}>{provider.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div>
        <label>自己的 {provider.name} API 密钥<input type="password" value={key} onChange={event => { setKey(event.target.value); setConsent(false); }} autoComplete="new-password" autoCapitalize="off" spellCheck={false} disabled={busy} maxLength={512} placeholder={configured ? '当前页面已临时配置；可输入新密钥替换' : '只填在这里，不要粘贴到聊天中'} /></label>
        <div className="rw-wechat-key-actions"><button className="rw-button" disabled={!key.trim() || busy} onClick={() => { void configure(); }}>临时配置密钥</button>{configured && <button className="rw-button" disabled={busy} onClick={() => { client.clearLocalKey(); setConfigured(false); setConsent(false); }}>移除密钥</button>}<button className="rw-button" disabled={busy} onClick={() => { void refreshStatus(); }}>检查网站服务</button></div>
        <p>密钥只暂存本页面，30 分钟、切换模型或关闭导入后清除。配置密钥、检查网站服务均不发送聊天，也不验证密钥额度。</p>
        <p className="rw-wechat-disclosure">本次 {snapshot?.textCount} 条文字、{snapshot?.characters.toLocaleString()} 字符，最多 {snapshot?.batches} 次模型请求。将经当前网站服务器发送至 <strong>{provider.name}</strong>，产生 API 费用；不自动重试。线上经过 Cloudflare，选择国内模型不代表全链路都在境内。{provider.note} <a href={provider.privacyUrl} target="_blank" rel="noreferrer">数据说明</a></p>
        {step === 'analyze' && <p>发现节点阶段已用 {discoveryUsage?.totalTokens ?? 0} tokens；本次关系分析另行计费。不能只凭聊天把关系视为已核实。</p>}
      </>}
      {step === 'entities' && <>
        <h3>确认商业节点 · {nodes.length} 个</h3><p>同名并不一定是同一个人。模型不能凭名字补出所属机构；发现的同字候选只是待确认名称。可补充别名、明确合并，或保留不同对象。日常人物请移除。</p>
        <p>删除节点只改变图谱名单，<strong>不会从待发送正文删除姓名</strong>。如需不上传，请返回材料页编辑或隐藏相应内容。</p>
        {duplicates.length > 0 && <p className="rw-wechat-warning">重名或共享别名：{duplicates.slice(0, 10).join('、')}。未明确区分的关系不会强行归属。</p>}
        <div className="rw-wechat-node-list">{nodes.map((node, index) => <div className="rw-wechat-node" key={node.id}><label>名称 {index + 1}<input value={node.name} maxLength={100} onChange={event => updateNode(node.id, { name: event.target.value })} /></label><label>类型<select value={node.kind} onChange={event => updateNode(node.id, { kind: event.target.value as RelationshipEntity['kind'] })}>{Object.entries(KINDS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label><label>原文别名（逗号分隔）<input value={aliasDrafts[node.id] ?? (node.aliases ?? []).join('，')} onChange={event => { const value = event.target.value; setAliasDrafts(current => ({ ...current, [node.id]: value })); updateNode(node.id, { aliases: value.split(/[,，]/u).map(value => value.trim()).filter(Boolean) }); }} /></label>{duplicates.includes(node.name) && nodeContexts[node.id] && <p className="rw-wechat-identity-context">用于区分同名：{nodeContexts[node.id]}</p>}<button className="rw-button" aria-label={`从商业名单移除 ${node.name || `节点 ${index + 1}`}`} onClick={() => { setNodes(current => current.filter(item => item.id !== node.id)); setNodesConfirmed(false); }}>移除</button></div>)}</div>
        <button className="rw-button" disabled={nodes.length >= 120} onClick={() => { setNodes(current => [...current, { id: `manual-${++manualId.current}`, name: '', kind: 'person' }]); setNodesConfirmed(false); }}>补充节点</button>
        {nodes.length > 1 && <details><summary>把两个候选明确合并为同一对象</summary><div className="rw-wechat-fields"><label>待合并节点<select value={mergeSource} onChange={event => setMergeSource(event.target.value)}><option value="">请选择</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {KINDS[node.kind]} · {node.id}</option>)}</select></label><label>保留的节点<select value={mergeTarget} onChange={event => setMergeTarget(event.target.value)}><option value="">请选择</option>{nodes.filter(node => node.id !== mergeSource).map(node => <option key={node.id} value={node.id}>{node.name} · {KINDS[node.kind]} · {node.id}</option>)}</select></label></div><button className="rw-button" disabled={!mergeSource || !mergeTarget} onClick={() => { try { setNodes(mergeConfirmedNodes(nodes, mergeSource, mergeTarget)); setAliasDrafts({}); setMergeSource(''); setMergeTarget(''); setNodesConfirmed(false); setError(''); } catch (error) { setError(safeError(error)); } }}>确认是同一个对象并合并</button></details>}
        <label className="rw-wechat-check"><input type="checkbox" checked={nodesConfirmed} onChange={event => setNodesConfirmed(event.target.checked)} />我已检查商业名单和重名情况；保留的名称及别名可用于本次关系分析。</label>
      </>}
      {previewText && <details className="rw-wechat-preview"><summary>查看实际待发送文本{step === 'prepare' ? '（随筛选和隐藏设置更新）' : '（已冻结，不含原始微信标识）'}</summary><p>请检查家庭、健康等不需要的内容。仅删除节点不会改变这份文本。</p><textarea aria-label="实际待发送聊天文本" readOnly value={previewText} spellCheck={false} rows={10} /></details>}
      {step === 'analyze' && <details><summary>查看实际待发送名单</summary><textarea aria-label="实际待发送节点名单" readOnly rows={6} value={JSON.stringify(confirmedCase?.entities, null, 2)} /></details>}
      {(step === 'entities' || step === 'analyze') && discoveryDiagnostics.length > 0 && <details><summary>名单检查提示（{discoveryDiagnostics.length} 项）</summary><p>以下仅说明名单处理结果。请核对被排除或待修正的名称，避免遗漏商业参与方。</p><ul>{discoveryDiagnostics.map(item => <li key={item.id}><strong>{item.candidateName}</strong>：{item.message}</li>)}</ul></details>}
      {error && <p className="rw-wechat-error" role="alert">{error}</p>}
      <p role="status" className="rw-wechat-notice">{busy ? `${step === 'discover' ? '正在发现商业节点' : '正在解析商业关系'}，所有批次完成后才显示结果。已处理部分仍可能计费。` : notice}</p>
    </div>
    <footer className="rw-wechat-footer">
      {step !== 'prepare' && <button className="rw-button" disabled={busy} onClick={backToMaterials}>返回修改材料</button>}
      {step === 'analyze' && <button className="rw-button" disabled={busy} onClick={() => { gate.cancel(); setStep('entities'); setConfirmedCase(null); setCompleted(null); setNodesConfirmed(false); setConsent(false); setError(''); setNotice('已保留候选名单；修改名单不需要再次付费发现节点。'); }}>返回修改名单</button>}
      {step === 'prepare' && <button className="rw-button rw-button-primary" disabled={!computed.preview || reading} onClick={readyToDiscover}>检查完毕，连接大模型</button>}
      {step === 'entities' && <button className="rw-button rw-button-primary" disabled={!nodes.length || !nodesConfirmed} onClick={confirmNodes}>确认名单，继续</button>}
      {(step === 'discover' || step === 'analyze') && !pendingImport && <>
        <label className="rw-wechat-check"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />我有权处理这些内容，同意本次向 {provider.name}（{selection.model}）发送{step === 'discover' ? '预览文本以发现商业节点' : '预览文本及确认名单以解析商业关系'}，并承担费用。</label>
        {busy ? <button className="rw-button" onClick={cancel}>取消本次调用</button> : <button className="rw-button rw-button-primary" disabled={!consent || !configured || !serviceReady || !!key.trim()} onClick={() => { void run(); }}>{step === 'discover' ? '发送并发现节点' : '发送并生成商业关系图'}</button>}
      </>}
    </footer>
  </dialog>;
}
