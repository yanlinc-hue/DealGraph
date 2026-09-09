import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { analyzeRelationshipCase, RELATION_LABELS, validateRelationshipCase } from './relationships/engine';
import RelationshipMap from './relationships/RelationshipMap';
import sample from './relationships/sample.json';
import type { BusinessRelationship, RelationKind, RelationshipAnalysis, RelationshipCase, RelationshipEntity } from './relationships/types';
import { CloudClientError, CloudRunGate, createRelationshipCloudClient } from './relationships/cloud-client';
import { DEFAULT_SELECTION, MODEL_PROVIDERS, consentFor, providerInfo } from './relationships/model-catalog';
import type { ModelSelection, ProviderId } from './relationships/model-catalog';
import type { CloudConnectionDiagnosis, CloudResult, CloudStatus } from './relationships/cloud-client';
import './relationships/workspace.css';
import './relationships/model-view.css';
import WechatImportWizard from './relationships/WechatImportWizard';

const FILTERS: { id: string; label: string; kinds?: RelationKind[] }[] = [
  { id: 'all', label: '全部关系' },
  { id: 'leadership', label: '任职与决策', kinds: ['employment', 'decision_authority'] },
  { id: 'capital', label: '股权与资本', kinds: ['ownership', 'investment', 'lending', 'acquisition', 'subsidiary'] },
  { id: 'project', label: '项目合作', kinds: ['advisory', 'project_role', 'cooperation'] },
  { id: 'introduction', label: '引荐', kinds: ['introduction'] },
];
const KIND_LABELS = { person: '个人', organization: '机构', project: '项目' };
const STATUS_LABELS = { supported: '有明确记录', review: '待确认', conflicted: '存在分歧', historical: '历史关系', rejected: '不显示' };
const IMPORT_LIMIT = 2 * 1024 * 1024;
const CANVAS_NODE_LIMIT = 120;
const CANVAS_EDGE_LIMIT = 200;
function initialFocus(analysis: RelationshipAnalysis) { return analysis.entities.find((entity) => entity.id === 'org-ningchuan')?.id ?? analysis.entities.find((entity) => entity.kind === 'organization')?.id ?? analysis.entities[0]?.id ?? ''; }
function entityMark(entity: RelationshipEntity | undefined) { return entity?.kind === 'person' ? entity.name.slice(-2) : entity?.kind === 'project' ? '◇' : '▥'; }
function relationText(relation: BusinessRelationship) { return `${relation.label || RELATION_LABELS[relation.kind]}${relation.percentage !== undefined && !relation.label.includes('%') ? ` ${relation.percentage}%` : ''}`; }
function relationParticipants(relation: BusinessRelationship) { return [relation.sourceId, relation.targetId, ...(relation.kind === 'introduction' && relation.viaId ? [relation.viaId] : [])]; }

interface WorkspaceProps {
  initialData?: { input: RelationshipCase; analysis: RelationshipAnalysis; origin: 'rules' | 'model' | 'snapshot' };
  onImport?: (input: RelationshipCase, analysis: RelationshipAnalysis, origin: 'rules' | 'model') => void;
  onAnalysis?: (analysis: RelationshipAnalysis) => void;
  requestedFocus?: string;
}
export default function RelationshipWorkspace({ initialData, onImport, onAnalysis, requestedFocus }: WorkspaceProps = {}) {
  const [wechatOpen, setWechatOpen] = useState(false);
  const [rawCase, setRawCase] = useState<RelationshipCase>(() => initialData?.input ?? validateRelationshipCase(sample));
  const [analysis, setAnalysis] = useState<RelationshipAnalysis>(() => initialData?.analysis ?? analyzeRelationshipCase(sample));
  const [focusId, setFocusId] = useState(() => {
    const initial = initialData?.analysis ?? analyzeRelationshipCase(sample);
    return requestedFocus && initial.entities.some(e => e.id === requestedFocus) ? requestedFocus : initialFocus(initial);
  });
  const [selectedId, setSelectedId] = useState(focusId);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [filterId, setFilterId] = useState('all');
  const [query, setQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showUncertain, setShowUncertain] = useState(true);
  const [networkMode, setNetworkMode] = useState<'client' | 'all'>('client');
  const [mapMode, setMapMode] = useState<'2d' | '3d'>('2d');
  const [modelSelection, setModelSelection] = useState<ModelSelection>(DEFAULT_SELECTION);
  const provider = providerInfo(modelSelection.provider);
  const [importState, setImportState] = useState('');
  const [importing, setImporting] = useState(false);
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState('');
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  const [cloudServiceError, setCloudServiceError] = useState('');
  const [cloudStatusLoading, setCloudStatusLoading] = useState(false);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [cloudPhase, setCloudPhase] = useState<'idle' | 'running' | 'success' | 'failed' | 'cancelled'>('idle');
  const [resultOrigin, setResultOrigin] = useState<'rules' | 'model' | 'snapshot'>(() => initialData?.origin ?? 'rules');
  const [cloudResultMeta, setCloudResultMeta] = useState<Omit<CloudResult, 'analysis'> | null>(null);
  const [cloudError, setCloudError] = useState('');
  const [cloudConsent, setCloudConsent] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyNote, setKeyNote] = useState('');
  const [connectionDiagnosis, setConnectionDiagnosis] = useState<CloudConnectionDiagnosis | null>(null);
  const [diagnosisPhase, setDiagnosisPhase] = useState<'idle' | 'running' | 'finished' | 'failed' | 'cancelled'>('idle');
  const [diagnosisError, setDiagnosisError] = useState('');
  const cloudClient = useMemo(() => createRelationshipCloudClient(), []);
  const cloudRuns = useMemo(() => new CloudRunGate(), []);
  const diagnosisRuns = useMemo(() => new CloudRunGate(), []);
  const statusRequest = useRef(0);
  const statusAbort = useRef<AbortController | null>(null);
  const keyAbort = useRef<AbortController | null>(null);
  const fileRequest = useRef(0);
  const importRef = useRef<HTMLInputElement>(null);
  const exportDialogRef = useRef<HTMLDialogElement>(null);
  const cloudDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (requestedFocus && analysis.entities.some(e => e.id === requestedFocus)) { setFocusId(requestedFocus); setSelectedId(requestedFocus); setSelectedRelationId(null); }
  }, [requestedFocus]);
  const refreshCloudStatus = useCallback(async () => {
    const requestId = ++statusRequest.current;
    statusAbort.current?.abort();
    const controller = new AbortController();
    statusAbort.current = controller;
    setCloudStatusLoading(true);
    try {
      const next = await cloudClient.status(controller.signal);
      if (requestId !== statusRequest.current) return;
      setCloudStatus(next);
      setCloudServiceError('');
    } catch (error) {
      if (requestId !== statusRequest.current || controller.signal.aborted) return;
      setCloudStatus(null);
      setCloudServiceError(error instanceof CloudClientError ? error.message : '网站分析服务暂不可用。');
    } finally { if (requestId === statusRequest.current) setCloudStatusLoading(false); }
  }, [cloudClient]);
  useEffect(() => {
    void refreshCloudStatus();
    return () => { statusRequest.current += 1; statusAbort.current?.abort(); keyAbort.current?.abort(); cloudRuns.cancel(); diagnosisRuns.cancel(); };
  }, [refreshCloudStatus, cloudRuns, diagnosisRuns]);
  useEffect(() => {
    const clearKey = () => {
      statusRequest.current += 1; statusAbort.current?.abort(); keyAbort.current?.abort();
      cloudClient.clearLocalKey(); setApiKeyDraft(''); setCloudStatus(null); setCloudConsent(false);
      cloudRuns.cancel(); diagnosisRuns.cancel(); setCloudPhase('idle'); setDiagnosisPhase('idle'); setKeyBusy(false);
      setCloudStatusLoading(false); setKeyNote('页面已重新进入，请重新配置密钥。');
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) { clearKey(); void refreshCloudStatus(); } };
    window.addEventListener('pagehide', clearKey);
    window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('pagehide', clearKey); window.removeEventListener('pageshow', restore); cloudClient.clearLocalKey(); };
  }, [cloudClient, cloudRuns, diagnosisRuns, refreshCloudStatus]);
  useEffect(() => {
    if (exportJson !== null && !exportDialogRef.current?.open) exportDialogRef.current?.showModal();
  }, [exportJson]);
  useEffect(() => {
    if (cloudDialogOpen && !cloudDialogRef.current?.open) cloudDialogRef.current?.showModal();
  }, [cloudDialogOpen]);
  const entityMap = useMemo(() => new Map(analysis.entities.map((entity) => [entity.id, entity])), [analysis]);
  const focus = entityMap.get(focusId);
  const selected = entityMap.get(selectedId) ?? focus;
  const kindFilter = FILTERS.find((filter) => filter.id === filterId)?.kinds;
  const currentRelations = useMemo(() => analysis.relationships.filter((relation) => relation.status !== 'rejected' && (showHistory || relation.status !== 'historical') && (showUncertain || (relation.status !== 'review' && relation.status !== 'conflicted'))), [analysis, showHistory, showUncertain]);
  const eligibleRelations = useMemo(() => currentRelations.filter((relation) => !kindFilter || kindFilter.includes(relation.kind)), [currentRelations, kindFilter]);
  const clientIds = useMemo(() => {
    const ids = new Set([focusId]);
    for (let depth = 0; depth < 2; depth += 1) {
      const current = new Set(ids);
      for (const relation of currentRelations) {
        const participants = relationParticipants(relation);
        if (participants.some((id) => current.has(id))) participants.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }, [currentRelations, focusId]);
  const relationshipCandidates = useMemo(() => eligibleRelations.filter((relation) => networkMode === 'all' || (clientIds.has(relation.sourceId) && clientIds.has(relation.targetId))), [eligibleRelations, clientIds, networkMode]);
  const canvas = useMemo(() => {
    const ids = new Set([focusId, selectedId]);
    const relations: BusinessRelationship[] = [];
    const priority = (relation: BusinessRelationship) => relation.id === selectedRelationId ? -10 : relationParticipants(relation).includes(selectedId) ? -5 : relationParticipants(relation).includes(focusId) ? -3 : relation.status === 'supported' ? 0 : 1;
    for (const relation of [...relationshipCandidates].sort((a, b) => priority(a) - priority(b))) {
      if (relations.length >= CANVAS_EDGE_LIMIT) break;
      const required = new Set([relation.sourceId, relation.targetId, ...(relation.projectId ? [relation.projectId] : []), ...(relation.viaId ? [relation.viaId] : [])]);
      const added = [...required].filter((id) => !ids.has(id));
      if (ids.size + added.length > CANVAS_NODE_LIMIT) continue;
      added.forEach((id) => ids.add(id));
      relations.push(relation);
    }
    return { ids, relations, truncated: relations.length < relationshipCandidates.length };
  }, [focusId, selectedId, selectedRelationId, relationshipCandidates]);
  const visibleRelations = canvas.relations;
  const visibleIds = canvas.ids;
  const visibleEntities = useMemo(() => analysis.entities.filter((entity) => visibleIds.has(entity.id)), [analysis, visibleIds]);
  const layoutRelations = useMemo(() => {
    const included = new Set(visibleRelations.map((relation) => relation.id));
    return [...visibleRelations, ...currentRelations.filter((relation) => !included.has(relation.id) && visibleIds.has(relation.sourceId) && visibleIds.has(relation.targetId)).slice(0, 400 - visibleRelations.length)];
  }, [visibleRelations, visibleIds, currentRelations]);
  const connections = useMemo(() => eligibleRelations.filter((relation) => relationParticipants(relation).includes(selectedId)).sort((a, b) => (a.status === 'supported' ? 0 : 1) - (b.status === 'supported' ? 0 : 1) || a.kind.localeCompare(b.kind)), [eligibleRelations, selectedId]);
  const connectedNodeCount = useMemo(() => new Set(connections.flatMap(relationParticipants).filter((id) => id !== selectedId)).size, [connections, selectedId]);
  const selectedRelation = visibleRelations.find((relation) => relation.id === selectedRelationId);
  const searchResults = query.trim() ? analysis.entities.filter((entity) => `${entity.name} ${entity.category ?? ''} ${(entity.aliases ?? []).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 8) : [];
  const counts = { person: visibleEntities.filter((entity) => entity.kind === 'person').length, organization: visibleEntities.filter((entity) => entity.kind === 'organization').length, project: visibleEntities.filter((entity) => entity.kind === 'project').length };
  const analysisLabel = resultOrigin === 'snapshot' ? '已恢复快照 · 本次未调用模型' : resultOrigin === 'model' ? `${cloudResultMeta?.model ?? '大模型'} 分析` : '规则预览 · 未调用大模型';
  const reviewIssues = analysis.issues.filter(issue => ['invalid_input', 'insufficient_evidence', 'ambiguous_identity', 'unsupported_language'].includes(issue.kind));
  const selectNode = (id: string) => { setSelectedId(id); setSelectedRelationId(null); };
  const selectRelation = (id: string) => { if (!visibleRelations.some((relation) => relation.id === id)) setNetworkMode('all'); setSelectedRelationId(id); };
  const focusNode = (id: string) => { setFocusId(id); setSelectedId(id); setSelectedRelationId(null); setQuery(''); };
  const replaceCase = (next: RelationshipAnalysis, input: RelationshipCase, origin: 'rules' | 'model' = 'rules') => {
    if (onImport) { onImport(input, next, origin); return; }
    resetConnectionDiagnosis();
    cloudRuns.cancel(); fileRequest.current += 1; setImporting(false); setRawCase(input); setCloudPhase('idle'); setResultOrigin('rules'); setCloudResultMeta(null); setCloudError(''); setCloudConsent(false); setApiKeyDraft(''); setCloudDialogOpen(false);
    setAnalysis(next); const nextFocus = initialFocus(next); setFocusId(nextFocus); setSelectedId(nextFocus); setSelectedRelationId(null); setFilterId('all'); setQuery(''); setNetworkMode('client'); setShowHistory(false); setShowUncertain(true);
  };
  const cancelCloudAnalysis = () => {
    cloudRuns.cancel();
    if (cloudPhase === 'running') { setCloudPhase('cancelled'); setCloudError('已取消本次分析；已发送并处理的部分仍可能产生 API 费用。'); }
    setCloudConsent(false);
  };
  const resetConnectionDiagnosis = () => { diagnosisRuns.cancel(); setConnectionDiagnosis(null); setDiagnosisError(''); setDiagnosisPhase('idle'); };
  const changeModel = (next: ModelSelection) => {
    cloudRuns.cancel(); resetConnectionDiagnosis();
    statusRequest.current += 1; statusAbort.current?.abort(); keyAbort.current?.abort();
    cloudClient.selectModel(next); setModelSelection(next); setApiKeyDraft(''); setCloudConsent(false); setCloudStatus(null);
    setCloudPhase('idle'); setCloudError(''); setKeyNote('已切换模型，旧密钥已清除；请配置对应服务商的密钥并重新确认。');
    void refreshCloudStatus();
  };
  const cancelConnectionDiagnosis = () => { diagnosisRuns.cancel(); setConnectionDiagnosis(null); setDiagnosisError(''); setDiagnosisPhase('cancelled'); };
  const runConnectionDiagnosis = async () => {
    if (diagnosisPhase === 'running' || cloudPhase === 'running' || keyBusy || keyAbort.current || cloudStatusLoading || !cloudStatus) return;
    let ticket;
    try { ticket = diagnosisRuns.begin(); } catch { return; }
    setDiagnosisPhase('running'); setConnectionDiagnosis(null); setDiagnosisError('');
    try {
      const result = await cloudClient.diagnose(ticket.signal);
      if (!diagnosisRuns.isCurrent(ticket)) return;
      setConnectionDiagnosis(result); setDiagnosisPhase(result.reachable ? 'finished' : 'failed');
    } catch (error) {
      if (!diagnosisRuns.isCurrent(ticket)) return;
      setDiagnosisPhase('failed'); setDiagnosisError(error instanceof CloudClientError ? error.message : '连接检测未完成，请稍后重试。');
    } finally { diagnosisRuns.finish(ticket); }
  };
  const closeCloudDialog = () => { cancelCloudAnalysis(); resetConnectionDiagnosis(); setApiKeyDraft(''); setCloudDialogOpen(false); };
  const openCloudDialog = () => { resetConnectionDiagnosis(); setApiKeyDraft(''); setKeyNote(''); setCloudConsent(false); setCloudDialogOpen(true); void refreshCloudStatus(); };
  const configureCloudKey = async (remove = false) => {
    if (keyBusy || keyAbort.current || cloudPhase === 'running' || diagnosisPhase === 'running' || cloudStatusLoading || !cloudStatus) return;
    const key = apiKeyDraft.trim();
    setApiKeyDraft('');
    if (!remove && !key) { setKeyNote('请在密码框中输入新 API 密钥。'); return; }
    setKeyBusy(true); setKeyNote('');
    const controller = new AbortController(); keyAbort.current = controller;
    try {
      if (remove) await cloudClient.clearConfiguration(controller.signal); else await cloudClient.configure(key, controller.signal);
      statusRequest.current += 1;
      setCloudStatus((current) => current ? { ...current, configured: !remove } : null);
      setKeyNote(remove ? '已从当前页面移除密钥。' : '已临时配置，尚未验证；不会自动上传数据。');
    } catch (error) {
      if (!controller.signal.aborted) setKeyNote(error instanceof CloudClientError ? error.message : '密钥配置未完成。');
    } finally {
      // Reconcile the page-only key state before enabling another action.
      if (!controller.signal.aborted) await refreshCloudStatus();
      setKeyBusy(false); keyAbort.current = null;
    }
  };
  const runCloudAnalysis = async () => {
    if (!cloudConsent || !cloudStatus?.configured || apiKeyDraft.trim() || keyBusy || cloudStatusLoading || cloudPhase === 'running' || diagnosisPhase === 'running') return;
    diagnosisRuns.cancel();
    let ticket;
    try { ticket = cloudRuns.begin(); } catch { return; }
    setCloudPhase('running'); setCloudError(''); setCloudConsent(false);
    try {
      const result = await cloudClient.analyze(rawCase, consentFor(modelSelection), ticket.signal);
      if (!cloudRuns.isCurrent(ticket)) return;
      onAnalysis?.(result.analysis);
      setAnalysis(result.analysis); setResultOrigin('model'); setCloudPhase('success');
      const { analysis: _resultAnalysis, ...metadata } = result;
      void _resultAnalysis;
      setCloudResultMeta(metadata); setSelectedRelationId(null); setCloudDialogOpen(false); setApiKeyDraft('');
      if (!result.analysis.entities.some((entity) => entity.id === focusId)) setFocusId(initialFocus(result.analysis));
      if (!result.analysis.entities.some((entity) => entity.id === selectedId)) setSelectedId(initialFocus(result.analysis));
    } catch (error) {
      if (!cloudRuns.isCurrent(ticket)) return;
      setCloudPhase('failed');
      setCloudError(error instanceof CloudClientError ? error.message : '模型分析未完成，本次图谱未更新。');
    } finally { cloudRuns.finish(ticket); }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > IMPORT_LIMIT) { setImportState('文件过大，请选择小于 2 MB 的关系数据 JSON。'); return; }
    const requestId = ++fileRequest.current;
    cancelCloudAnalysis();
    resetConnectionDiagnosis();
    setImporting(true);
    setImportState('');
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (requestId !== fileRequest.current) return;
      const input = validateRelationshipCase(parsed);
      const next = analyzeRelationshipCase(input);
      replaceCase(next, input);
      setImportState(`已载入 ${next.entities.length} 个节点，当前为规则预览；未上传至模型服务商。`);
    } catch (error) {
      if (requestId === fileRequest.current) setImportState(error instanceof SyntaxError ? '文件不是有效的 JSON，请检查文件格式。' : error instanceof Error ? error.message.slice(0, 200) : '无法读取此文件，请检查关系数据格式。');
    } finally { if (requestId === fileRequest.current) setImporting(false); }
  };
  const exportGraph = () => {
    const output = { schema: 'dealgraph.relationship-map.v1', title: analysis.title, dataClass: analysis.dataClass, asOf: analysis.asOf, entities: visibleEntities.map(({ id, name, kind, category }) => ({ id, name, kind, category })), relationships: visibleRelations.map(({ id, sourceId, targetId, kind, label, status, projectId, viaId, role, percentage }) => ({ id, sourceId, targetId, kind, label, status, projectId, viaId, role, percentage })) };
    setExportJson(JSON.stringify(output, null, 2));
    setExportNote('');
  };
  const saveExport = () => {
    if (exportJson === null) return;
    const url = URL.createObjectURL(new Blob([exportJson], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'dealgraph-relationship-map.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setExportNote('已请求浏览器保存。如未出现下载，请使用“复制 JSON”。');
  };
  const copyExport = async () => {
    if (exportJson === null) return;
    try {
      await navigator.clipboard.writeText(exportJson);
      setExportNote('已复制当前图谱 JSON。');
    } catch {
      setExportNote('浏览器暂不支持自动复制，请选中文本框内容后手动复制。');
    }
  };
  return <div className="rw-app">
    <aside className="rw-rail" aria-label="工作区"><a className="rw-monogram" href="#" aria-label="DealGraph 首页">D<span>·</span></a><div className="rw-rail-rule" /><button className="rw-rail-active" title="客户关系" aria-label="客户关系"><svg viewBox="0 0 24 24"><path d="M 8 7 L 16 7 M 7 8 L 12 17 M 17 8 L 12 17" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="19" r="3" /></svg></button><div className="rw-rail-bottom"><span>IB</span></div></aside>
    <div className="rw-workspace">
      <header className="rw-header"><div className="rw-brand">DealGraph <span>商业关系洞察</span></div><div className="rw-header-right"><span className="rw-local"><i />{analysisLabel} · {analysis.dataClass === 'synthetic' ? '演示数据' : '导入数据'}</span><button className="rw-button rw-button-quiet" onClick={() => { replaceCase(analyzeRelationshipCase(sample), validateRelationshipCase(sample)); setImportState('已恢复规则演示，未调用大模型。'); }}>重置演示</button><button className="rw-button rw-cloud-button" disabled={cloudPhase === 'running'} onClick={openCloudDialog}>{cloudPhase === 'running' ? '大模型分析中…' : '连接大模型'}</button><button className="rw-button rw-button-primary" onClick={() => { cancelCloudAnalysis(); setWechatOpen(true); }}>导入微信聊天</button><button className="rw-button" disabled={importing} onClick={() => importRef.current?.click()}><span>＋</span>{importing ? '正在分析' : '导入关系数据'}</button><input ref={importRef} type="file" accept=".json,application/json" onChange={(event) => { void importFile(event); }} hidden /></div></header>
      <main className="rw-main">
        <div className="rw-titlebar"><div><div className="rw-eyebrow">客户关系 <span>/</span> 精品投行客户工作台</div><h1>看清客户背后的关系</h1><p>连接关键人物、资本与项目，找到关系网络中的着力点。</p></div><div className="rw-search-wrap"><label className="rw-search"><svg viewBox="0 0 20 20"><circle cx="8" cy="8" r="5.5" /><path d="m12 12 5 5" /></svg><input aria-label="搜索客户、人物或项目" placeholder="搜索客户、人物或项目" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button onClick={() => setQuery('')} aria-label="清空搜索">×</button>}</label>{query.trim() && <div className="rw-search-results">{searchResults.length ? searchResults.map((entity) => <button key={entity.id} onClick={() => { selectNode(entity.id); if (!visibleIds.has(entity.id)) setNetworkMode('all'); setQuery(''); }}><span className={`rw-mini-mark ${entity.kind}`}>{entityMark(entity)}</span><span>{entity.name}<small>{entity.category ?? KIND_LABELS[entity.kind]}</small></span><span className="rw-search-arrow">↗</span></button>) : <p>没有匹配的节点</p>}</div>}</div></div>
        <div className={`rw-analysis-mode rw-analysis-mode-${cloudPhase}`} role="status"><span><i />{cloudPhase === 'running' ? `${modelSelection.model} 分析中` : cloudPhase === 'failed' || cloudPhase === 'cancelled' ? `模型分析未完成 · ${resultOrigin === 'rules' ? '保留规则预览' : resultOrigin === 'snapshot' ? '保留已恢复快照' : '保留上次模型结果'}` : analysisLabel}</span>{cloudResultMeta && cloudPhase === 'success' && <small>输入 {cloudResultMeta.usage.inputTokens.toLocaleString()} · 输出 {cloudResultMeta.usage.outputTokens.toLocaleString()} tokens · {cloudResultMeta.documentsSent} 篇文本{cloudResultMeta.excludedFutureDocuments > 0 ? ` · 已排除 ${cloudResultMeta.excludedFutureDocuments} 篇未来文本` : ''}</small>}{cloudPhase === 'running' && <button onClick={cancelCloudAnalysis}>取消分析</button>}{cloudError && <small>{cloudError}</small>}</div>
        {importState && <div className="rw-message" role="status"><span>{importState}</span><button onClick={() => setImportState('')} aria-label="关闭提示">×</button></div>}
        {reviewIssues.length > 0 && <div className="rw-message" role="status"><details><summary>本次有 {reviewIssues.length} 项需复核；部分字段已清空或关系未纳入，当前图谱不代表完整提取</summary><ul>{[...new Set(reviewIssues.map(issue => issue.message))].slice(0, 8).map(message => <li key={message}>{message}</li>)}</ul></details></div>}
        <section className="rw-canvas-card" aria-label="客户关系工作区">
          <div className="rw-canvas-toolbar"><div className="rw-client-select"><span>当前客户</span><select aria-label="选择图谱中心客户" value={focusId} onChange={(event) => focusNode(event.target.value)}>{analysis.entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></div><div className="rw-network-toggle"><button className={networkMode === 'client' ? 'is-active' : ''} onClick={() => setNetworkMode('client')}>客户关系</button><button className={networkMode === 'all' ? 'is-active' : ''} onClick={() => setNetworkMode('all')}>完整网络</button></div><div className="rw-view-toggle" role="group" aria-label="图谱维度"><button aria-pressed={mapMode === '2d'} onClick={() => setMapMode('2d')}>2D</button><button aria-pressed={mapMode === '3d'} onClick={() => setMapMode('3d')}>3D</button></div><button className="rw-export" onClick={exportGraph} title="导出当前可见节点与关系，不含原文">导出图谱 <span>↗</span></button></div>
          <div className="rw-graph-layout"><div className="rw-graph-column"><div className="rw-graph-top"><div className="rw-filter-tabs" role="group" aria-label="关系类型筛选">{FILTERS.map((filter) => <button key={filter.id} className={filterId === filter.id ? 'is-active' : ''} onClick={() => { setFilterId(filter.id); setSelectedRelationId(null); }}>{filter.label}</button>)}</div><div className="rw-graph-count"><span>{visibleEntities.length} 节点</span><i />{visibleRelations.length} 关系</div></div>
            <div className="rw-map-heading"><div><span className="rw-map-eyebrow">商业关系图谱</span><h2>{focus?.name ?? '客户'}<span>的关系网络</span></h2></div><div className="rw-count-chips"><span>{counts.person} 位人物</span><span>{counts.organization} 家机构</span><span>{counts.project} 个项目</span></div></div>
            <RelationshipMap key={focusId} mode={mapMode} entities={visibleEntities} relationships={visibleRelations} layoutEntities={visibleEntities} layoutRelationships={layoutRelations} focusId={focusId} selectedId={selectedId} selectedRelationId={selectedRelationId} onSelect={selectNode} onSelectRelation={selectRelation} onFocus={focusNode} />
            {canvas.truncated && <div className="rw-limit-note">当前显示 {visibleRelations.length} 条关系，优先所选节点。切换客户或筛选可查看更多。</div>}
            {visibleRelations.length === 0 && <div className="rw-empty-map"><strong>当前筛选下没有关系</strong><span>选择其他关系类型，或切换至完整网络。</span><button className="rw-button" onClick={() => { setFilterId('all'); setNetworkMode('all'); }}>查看完整网络</button></div>}
          </div>
          <aside className="rw-detail" aria-label="节点与关系详情">
            {selectedRelation ? <><div className="rw-detail-eyebrow">关系详情<button aria-label="返回节点关系" onClick={() => setSelectedRelationId(null)}>×</button></div><div className={`rw-status rw-status-${selectedRelation.status}`}><i />{STATUS_LABELS[selectedRelation.status]}</div><div className="rw-relation-vertical"><button onClick={() => selectNode(selectedRelation.sourceId)}><span className={`rw-mini-mark ${entityMap.get(selectedRelation.sourceId)?.kind}`}>{entityMark(entityMap.get(selectedRelation.sourceId))}</span>{entityMap.get(selectedRelation.sourceId)?.name}</button><div><span>↓</span><strong>{relationText(selectedRelation)}</strong></div><button onClick={() => selectNode(selectedRelation.targetId)}><span className={`rw-mini-mark ${entityMap.get(selectedRelation.targetId)?.kind}`}>{entityMark(entityMap.get(selectedRelation.targetId))}</span>{entityMap.get(selectedRelation.targetId)?.name}</button></div><div className="rw-detail-facts"><div><span>关系类别</span><strong>{RELATION_LABELS[selectedRelation.kind]}</strong></div>{selectedRelation.role && <div><span>具体角色</span><strong>{selectedRelation.role}</strong></div>}{selectedRelation.projectId && <div><span>关联项目</span><button onClick={() => { selectNode(selectedRelation.projectId!); setNetworkMode('all'); }}>{entityMap.get(selectedRelation.projectId)?.name ?? '项目'}</button></div>}{selectedRelation.viaId && <div><span>引荐人</span><button onClick={() => { selectNode(selectedRelation.viaId!); setNetworkMode('all'); }}>{entityMap.get(selectedRelation.viaId)?.name ?? '引荐人'}</button></div>}</div></> : selected ? <><div className="rw-detail-eyebrow">节点概览<span>{KIND_LABELS[selected.kind]}</span></div><div className={`rw-detail-avatar ${selected.kind}`}>{entityMark(selected)}</div><h2 className="rw-detail-name">{selected.name}</h2><p className="rw-detail-category">{selected.category ?? KIND_LABELS[selected.kind]}</p>{selectedId !== focusId && <button className="rw-focus-button" onClick={() => focusNode(selectedId)}>以此为中心查看 <span>↗</span></button>}<div className="rw-detail-stats"><div><strong>{connectedNodeCount}</strong><span>关联节点</span></div><div><strong>{connections.length}</strong><span>业务关系</span></div></div><div className="rw-connections-heading"><h3>关系一览</h3><span>{connections.length}</span></div><div className="rw-connection-list">{connections.length ? connections.slice(0, 100).map((relation) => {
              const outgoing = relation.sourceId === selectedId;
              const isIntroducer = relation.kind === 'introduction' && relation.viaId === selectedId;
              const other = entityMap.get(outgoing ? relation.targetId : relation.sourceId);
              return <button key={relation.id} className="rw-connection" onClick={() => selectRelation(relation.id)}><span className={`rw-mini-mark ${other?.kind}`}>{isIntroducer ? '↗' : entityMark(other)}</span><span className="rw-connection-copy"><strong>{isIntroducer ? `${entityMap.get(relation.sourceId)?.name ?? '未知节点'} → ${entityMap.get(relation.targetId)?.name ?? '未知节点'}` : other?.name ?? '未知节点'}</strong><span className="rw-connection-predicate">{isIntroducer ? '牵线引荐' : outgoing ? <><em>→</em> {relationText(relation)}</> : <><em>←</em> {relationText(relation)}</>}</span>{relation.projectId && <small>{entityMap.get(relation.projectId)?.name}</small>}</span>{relation.status !== 'supported' && <span className={`rw-small-status rw-status-${relation.status}`}>{relation.status === 'conflicted' ? '分歧' : relation.status === 'historical' ? '历史' : '待确认'}</span>}<span className="rw-connection-chevron">›</span></button>;
            }) : <div className="rw-empty-list">当前筛选下暂无关系</div>}{connections.length > 100 && <div className="rw-empty-list">显示前 100 条关系，按关系类型筛选可进一步查看。</div>}</div></> : <div className="rw-empty-list">点击节点查看关系</div>}
            <div className="rw-detail-footer"><label><input type="checkbox" checked={showUncertain} onChange={(event) => setShowUncertain(event.target.checked)} />显示待确认关系</label><label><input type="checkbox" checked={showHistory} onChange={(event) => setShowHistory(event.target.checked)} />显示历史关系</label><span>关系截至 {analysis.asOf.slice(0, 10)}</span></div>
          </aside></div>
        </section><footer className="rw-page-footer"><span><span className="rw-gold-dot" />{analysis.title}</span><span>单击查看关系 · 双击节点切换中心 · {mapMode === '3d' ? '拖动旋转 / 可切平移' : '拖动平移'}</span></footer>
      </main>
    </div>
    {cloudDialogOpen && <dialog ref={cloudDialogRef} className="rw-export-dialog rw-cloud-dialog" aria-labelledby="rw-cloud-title" onCancel={closeCloudDialog}>
      <div className="rw-export-dialog-heading"><div><span>大模型连接 · {provider.name}</span><h2 id="rw-cloud-title">连接大模型</h2></div><button aria-label="关闭大模型连接" onClick={closeCloudDialog}>×</button></div>
      <div className="rw-model-selectors"><label>模型服务商<select aria-label="选择模型服务商" value={modelSelection.provider} disabled={keyBusy} onChange={(event) => { const id = event.target.value as ProviderId; changeModel({ provider: id, model: providerInfo(id).models[0].id }); }}>{MODEL_PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.name} · {item.region}</option>)}</select></label><label>分析模型<select aria-label="选择分析模型" value={modelSelection.model} disabled={keyBusy} onChange={(event) => changeModel({ ...modelSelection, model: event.target.value })}>{provider.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      <p>本次将把当前 <strong>{rawCase.entities.length} 个节点名录</strong>与 <strong>{rawCase.documents.length} 篇文本</strong>中的适用内容经网站服务器发送至 <strong>{provider.name}</strong>。未来日期文本和沟通频率数据在浏览器中排除；网站不保存材料或结果。请求经 Cloudflare 中转，选择国内模型不代表全链路仅在境内处理。</p>
      <p className="rw-cloud-disclosure">调用会产生 {provider.name} API 费用。{provider.note}<a href={provider.privacyUrl} target="_blank" rel="noreferrer">数据说明 ↗</a></p>
      <div className={`rw-cloud-network rw-cloud-network-${diagnosisPhase}`}><div className="rw-cloud-network-heading"><div><strong>{provider.name} 连接</strong><span role="status">{diagnosisPhase === 'running' ? '正在检测连接…' : diagnosisPhase === 'cancelled' ? '检测已取消' : connectionDiagnosis ? `${{ direct: '服务器直连', 'system-proxy': '本机代理', unavailable: '连接方式未就绪' }[connectionDiagnosis.route]} · ${connectionDiagnosis.reachable ? '已连通' : '未连通'}` : diagnosisPhase === 'failed' ? '检测未完成' : '尚未检测'}</span></div>{diagnosisPhase === 'running' ? <button className="rw-button" onClick={cancelConnectionDiagnosis}>取消检测</button> : <button className="rw-button" disabled={cloudPhase === 'running' || keyBusy || cloudStatusLoading || !cloudStatus} onClick={() => { void runConnectionDiagnosis(); }}>检测连接</button>}</div><p>仅检测网络，不发送密钥或客户材料、不调用模型、不计费。连通不代表密钥有效或分析完成。</p>{(diagnosisError || (connectionDiagnosis && !connectionDiagnosis.reachable)) && <div className="rw-cloud-note" role="status">{diagnosisError || connectionDiagnosis?.message}</div>}</div>
      <div className="rw-cloud-key"><div className="rw-cloud-key-heading"><label htmlFor="rw-api-key">{provider.name} API 密钥</label><span>{keyBusy ? '正在处理页面配置…' : cloudStatusLoading ? '正在连接网站服务…' : cloudStatus?.configured ? '已临时配置，尚未验证' : '尚未配置'}</span></div><input id="rw-api-key" aria-label={`新的 ${provider.name} API 密钥`} type="password" value={apiKeyDraft} onChange={(event) => setApiKeyDraft(event.target.value)} placeholder={cloudStatus?.configured ? '如需更换，在此输入新密钥' : '在此输入新 API 密钥'} autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={512} disabled={keyBusy || cloudPhase === 'running' || diagnosisPhase === 'running'} /><p>使用你自己的密钥：仅暂存当前页面，30 分钟或离开页面后清除；运行时经 HTTPS 交给网站服务器完成本次调用，不保存到服务器。浏览器插件仍可能读取页面，请使用可信设备。清除不等于撤销密钥；若曾贴进聊天，请先撤销旧密钥。</p><div className="rw-cloud-key-actions"><button className="rw-button" disabled={!apiKeyDraft.trim() || keyBusy || cloudStatusLoading || !cloudStatus || cloudPhase === 'running' || diagnosisPhase === 'running'} onClick={() => { void configureCloudKey(); }}>{keyBusy ? '处理中…' : '临时配置密钥'}</button>{cloudStatus?.configured && <button className="rw-button rw-button-quiet" disabled={keyBusy || cloudPhase === 'running' || diagnosisPhase === 'running'} onClick={() => { void configureCloudKey(true); }}>移除临时密钥</button>}{cloudServiceError && <button className="rw-button rw-button-quiet" disabled={cloudStatusLoading} onClick={() => { void refreshCloudStatus(); }}>重新连接</button>}</div>{(keyNote || cloudServiceError) && <div className="rw-cloud-note" role="status">{keyNote || cloudServiceError}</div>}</div>
      <label className="rw-cloud-consent"><input type="checkbox" checked={cloudConsent} disabled={cloudPhase === 'running'} onChange={(event) => setCloudConsent(event.target.checked)} /><span>我同意仅本次经网站服务器将适用名录和文本发送至 {provider.name}（{modelSelection.model}），并承担自己密钥的 API 费用。</span></label>
      <div className="rw-cloud-dialog-footer"><span role="status">{cloudPhase === 'running' ? '所选大模型正在分析，完成后自动更新图谱。取消后已处理部分仍可能计费。' : cloudError || '导入和配置密钥均不会自动上传文本。'}</span>{cloudPhase === 'running' ? <button className="rw-button" onClick={cancelCloudAnalysis}>取消分析</button> : <button className="rw-button rw-cloud-button" disabled={!cloudConsent || !cloudStatus?.configured || !!apiKeyDraft.trim() || keyBusy || cloudStatusLoading || diagnosisPhase === 'running'} onClick={() => { void runCloudAnalysis(); }}>确认并开始分析</button>}</div>
    </dialog>}
    {wechatOpen && <WechatImportWizard onClose={() => setWechatOpen(false)} onComplete={(input, result) => {
      replaceCase(result.analysis, input, 'model'); setResultOrigin('model');
      const { analysis: _analysis, ...metadata } = result; void _analysis;
      setCloudResultMeta(metadata); setWechatOpen(false); setNetworkMode('all');
      setImportState('已完成微信商业关系分析；只显示商业关系，聊天表述仍需核实。');
    }} />}
    {exportJson !== null && <dialog ref={exportDialogRef} className="rw-export-dialog" aria-labelledby="rw-export-title" aria-describedby="rw-export-description" onCancel={() => setExportJson(null)}>
      <div className="rw-export-dialog-heading"><div><span>商业关系图谱</span><h2 id="rw-export-title">导出当前图谱</h2></div><button aria-label="关闭导出" onClick={() => setExportJson(null)}>×</button></div>
      <p id="rw-export-description">仅包含当前可见节点与关系的明文展示文件，不是完整备份。要下次恢复工作台，请使用顶部“加密保存”。本文件包含姓名，请妥善保存。</p>
      <textarea aria-label="当前图谱 JSON" value={exportJson} readOnly spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
      <div className="rw-export-dialog-actions"><span role="status">{exportNote || '可保存为文件，也可复制文本。'}</span><button className="rw-button" onClick={() => { void copyExport(); }}>复制 JSON</button><button className="rw-button rw-button-primary" onClick={saveExport}>保存 JSON</button></div>
    </dialog>}
  </div>;
}
