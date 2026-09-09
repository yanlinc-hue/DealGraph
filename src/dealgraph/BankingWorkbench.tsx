import { useEffect, useRef, useState } from 'react';
import RelationshipWorkspace from './RelationshipWorkspace';
import WechatImportWizard from './relationships/WechatImportWizard';
import sample from './relationships/sample.json';
import type { RelationshipAnalysis, RelationshipCase, RelationshipEntity } from './relationships/types';
import { activeRelations, addBook, addEntity, bookFromCase, emptyWorkbench, newId, taskBucket, today, validateWorkbench } from './workbench-state';
import type { Outreach, ProjectPlan, Task, Workbench } from './workbench-state';
import { EntityForm, NoteForm, OutreachForm, ProjectForm, VaultForm } from './WorkbenchForms';
import './workbench.css';
import './workbench-layout.css';

const TABS = [['today', '今日'], ['clients', '客户'], ['projects', '项目'], ['graph', '关系']] as const;
type Tab = typeof TABS[number][0];
type Form = { kind: 'note'; bookId: string; entityId?: string; projectId?: string } | { kind: 'entity'; entityKind: RelationshipEntity['kind'] } | { kind: 'project'; plan: ProjectPlan } | { kind: 'outreach'; item: Outreach } | { kind: 'save' | 'restore' } | null;
const STATUS = { supported: '明确记录', review: '待确认', conflicted: '有分歧', historical: '历史', rejected: '不采用' };
export function demoState(): Workbench {
  const state = addBook(emptyWorkbench(), bookFromCase(sample, 'demo'));
  state.tasks = [
    { id: 'demo-task-1', bookId: 'demo', entityId: 'person-zhou', projectId: 'project-b', title: '向周宁确认融资材料清单', due: today(), done: false },
    { id: 'demo-task-2', bookId: 'demo', entityId: 'person-gu', projectId: 'project-mna', title: '确认买方团队下一轮沟通安排', due: '', done: false },
  ];
  state.notes = [{ id: 'demo-note', bookId: 'demo', entityId: 'person-zhou', projectId: 'project-b', text: '示范记录：先确认材料口径，再安排投资方沟通。具体融资需求仍待客户确认。', at: today() }];
  state.projects = [{ bookId: 'demo', projectId: 'project-b', stage: '接洽', brief: '示范项目：融资方案与时间表待确认。' }];
  state.outreach = [{ id: 'demo-outreach', bookId: 'demo', entityId: 'org-xinghai', projectId: 'project-b', stage: '已发材料', next: '示范跟进：确认投资偏好与项目是否匹配。' }];
  return state;
}
export default function BankingWorkbench({ initialState, initialTab = 'today' }: { initialState?: Workbench; initialTab?: Tab } = {}) {
  const [work, setWork] = useState<Workbench>(() => initialState ?? demoState());
  const workRef = useRef(work), revision = useRef(0);
  const [dirty, setDirty] = useState(false), [tab, setTab] = useState<Tab>(initialTab);
  const [noteLimit, setNoteLimit] = useState(8);
  const [query, setQuery] = useState(''), [clientKind, setClientKind] = useState('all'), [selectedId, setSelectedId] = useState('');
  const [graphFocus, setGraphFocus] = useState(''), [graphVisited, setGraphVisited] = useState(initialTab === 'graph'), [graphEpoch, setGraphEpoch] = useState(0);
  const [message, setMessage] = useState(''), [form, setForm] = useState<Form>(null), [wechatOpen, setWechatOpen] = useState(false), [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), fileOperation = useRef(0);
  const active = work.books.find(b => b.id === work.activeBookId);
  const selected = active?.input.entities.find(e => e.id === selectedId);
  const clients = active?.analysis.entities.filter(e => e.kind !== 'project') ?? [];
  const projects = active?.analysis.entities.filter(e => e.kind === 'project') ?? [];
  const entityMap = new Map(active?.analysis.entities.map(e => [e.id, e]) ?? []);
  const pending = work.tasks.filter(t => !t.done), day = today();

  function commit(next: Workbench) {
    const clean = validateWorkbench(next); workRef.current = clean; revision.current += 1; setWork(clean); setDirty(true);
  }
  function safeCommit(next: Workbench) { try { commit(next); } catch (error) { setMessage(error instanceof Error ? error.message : '修改未完成。'); } }
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const clear = () => { fileOperation.current += 1; setForm(null); setWechatOpen(false); setImporting(false); };
    window.addEventListener('pagehide', clear); return () => { fileOperation.current += 1; window.removeEventListener('pagehide', clear); };
  }, []);
  function go(next: Tab) { setTab(next); setSelectedId(''); if (next === 'graph') setGraphVisited(true); }
  function switchBook(id: string) {
    if (!workRef.current.books.some(b => b.id === id)) return;
    const next = { ...workRef.current, activeBookId: id }; workRef.current = next; setWork(next);
    setSelectedId(''); setQuery(''); setGraphFocus('');
  }
  function showEntity(bookId: string, id: string) {
    switchBook(bookId); const e = workRef.current.books.find(b => b.id === bookId)?.input.entities.find(item => item.id === id);
    setTab(e?.kind === 'project' ? 'projects' : 'clients'); setSelectedId(id);
  }
  function showGraph(id = '') { setGraphFocus(id); setGraphVisited(true); setTab('graph'); }
  function openNote(bookId = work.activeBookId, entityId?: string, projectId?: string) {
    if (!bookId) { setMessage('先新建客户或项目，再记录跟进。'); setForm({ kind: 'entity', entityKind: 'person' }); return; }
    setForm({ kind: 'note', bookId, entityId, projectId });
  }
  function createEntity(entityKind: RelationshipEntity['kind'] = 'person') { setForm({ kind: 'entity', entityKind }); }
  function importBook(input: RelationshipCase, analysis?: RelationshipAnalysis, origin: 'rules' | 'model' = 'rules') {
    commit(addBook(workRef.current, bookFromCase(input, newId(), analysis, origin)));
    setWechatOpen(false); setSelectedId(''); setGraphFocus(''); setQuery(''); setTab('clients');
    setMessage('已新增独立资料集，旧客户与跟进保留。同名对象不自动合并，可在上方切换资料集。');
  }
  async function importCase(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setMessage('请选择 2 MB 以内的关系资料 JSON。'); return; }
    const token = ++fileOperation.current; setImporting(true);
    try { const input = JSON.parse(await file.text()); if (token === fileOperation.current) importBook(input); }
    catch (error) { if (token === fileOperation.current) setMessage(error instanceof SyntaxError ? '文件格式不正确。加密文件请用“打开文件”，微信导出请用“导入聊天”。' : error instanceof Error ? error.message : '导入未完成，原资料保留。'); }
    finally { if (token === fileOperation.current) setImporting(false); }
  }
  function recordAnalysis(id: string, analysis: RelationshipAnalysis) {
    const current = workRef.current; commit({ ...current, books: current.books.map(b => b.id === id ? { ...b, analysis, origin: 'model' } : b) });
  }
  function clearWorkbench() {
    if (!window.confirm('将清空当前页面，开始空白工作台。请先保存需要保留的资料；已有加密文件不会被删除。')) return;
    fileOperation.current += 1; setImporting(false); setForm(null); setWechatOpen(false); commit(emptyWorkbench()); setDirty(false); setGraphEpoch(e => e + 1); setGraphVisited(false); setSelectedId(''); setQuery(''); setTab('today'); setMessage('空白工作台已就绪。新建客户或项目，也可以导入已有材料。');
  }
  const nameFor = (bookId: string, entityId?: string) => work.books.find(b => b.id === bookId)?.input.entities.find(e => e.id === entityId)?.name;
  const tasksFor = (e: RelationshipEntity) => work.tasks.filter(t => t.bookId === work.activeBookId && (e.kind === 'project' ? t.projectId === e.id : t.entityId === e.id));
  const notesFor = (e: RelationshipEntity) => work.notes.filter(n => n.bookId === work.activeBookId && (e.kind === 'project' ? n.projectId === e.id : n.entityId === e.id));
  const planFor = (id: string): ProjectPlan => work.projects.find(p => p.bookId === work.activeBookId && p.projectId === id) ?? { bookId: work.activeBookId, projectId: id, stage: '未设置', brief: '' };
  const matches = (e: RelationshipEntity) => `${e.name} ${e.category ?? ''} ${(e.aliases ?? []).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const listing = (tab === 'clients' ? clients.filter(e => clientKind === 'all' || e.kind === clientKind) : projects).filter(matches);
  const selectedRelations = active && selected ? selected.kind === 'project' ? active.analysis.relationships.filter(r => r.status !== 'rejected' && (r.projectId === selected.id || r.sourceId === selected.id || r.targetId === selected.id)) : activeRelations(active, selected.id) : [];
  const taskRows = (tasks: Task[]) => tasks.map(task => <div className="bw-task" key={task.id}><label><input aria-label={`${task.done ? '撤销完成' : '完成'}：${task.title}`} type="checkbox" checked={task.done} onChange={() => safeCommit({ ...workRef.current, tasks: workRef.current.tasks.map(t => t.id === task.id ? { ...t, done: !t.done } : t) })} /><span><strong className={task.done ? 'bw-done' : ''}>{task.title}</strong><small>{[nameFor(task.bookId, task.entityId), nameFor(task.bookId, task.projectId)].filter(Boolean).join(' · ') || work.books.find(b => b.id === task.bookId)?.input.title}</small></span></label><div className="bw-task-actions"><input className={taskBucket(task, day) === 'overdue' ? 'bw-overdue' : ''} aria-label={`${task.title}的到期日`} type="date" value={task.due} onChange={e => safeCommit({ ...workRef.current, tasks: workRef.current.tasks.map(t => t.id === task.id ? { ...t, due: e.target.value } : t) })} />{(task.entityId || task.projectId) && <button onClick={() => showEntity(task.bookId, task.entityId || task.projectId!)}>查看 ↗</button>}</div></div>);

  return <div className="bw-app">
    <aside className="bw-sidebar"><a className="bw-brand" href="#" onClick={e => { e.preventDefault(); go('today'); }}>D<span>·</span> <strong>DealGraph</strong></a><p>个人客户工作台</p><nav aria-label="工作台导航">{TABS.map(([id, label], i) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}><span>0{i + 1}</span>{label}</button>)}</nav><div className="bw-side-note">客户与项目优先<br />只梳理商业关系<br /><a href="/guide.html" target="_blank" rel="noopener noreferrer">使用指南与演示 ↗</a></div></aside>
    <div className="bw-body"><header className="bw-header"><div className="bw-header-context"><span>精品投行 / {TABS.find(([id]) => id === tab)?.[1]}</span><span className={`bw-pill ${dirty ? 'bw-unsaved' : ''}`}>{dirty ? '有未保存修改' : work.books.length ? '个人文件工作台' : '空白工作台'}</span></div><div className="bw-actions"><button className="bw-button" onClick={() => setForm({ kind: 'restore' })}>打开文件</button><button className="bw-button" disabled={!work.books.length} onClick={() => setForm({ kind: 'save' })}>加密保存</button><button className="bw-button bw-primary" onClick={() => openNote()}>＋ 记一条</button></div></header>
      <div className="bw-storage-bar"><span>资料只在当前页面，刷新或关闭会丢失未保存内容。用加密文件保存，下次打开恢复。</span><button onClick={clearWorkbench}>新建空白工作台</button></div>
      {message && <div className="bw-message" role="status"><span>{message}</span><button className="bw-icon-button" aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div>}
      <div className="bw-collection-bar"><label>当前资料集<select aria-label="当前资料集" value={work.activeBookId} disabled={!work.books.length} onChange={e => switchBook(e.target.value)}>{!work.books.length && <option value="">尚无资料</option>}{work.books.map(b => <option key={b.id} value={b.id}>{b.input.dataClass === 'synthetic' ? '[虚构示范] ' : ''}{b.input.title}</option>)}</select></label><div className="bw-actions"><button className="bw-text-button" disabled={work.books.length >= 20} onClick={() => setWechatOpen(true)}>导入聊天</button><button className="bw-text-button" disabled={importing || work.books.length >= 20} onClick={() => fileRef.current?.click()}>{importing ? '读取中…' : '导入关系资料'}</button><button className="bw-text-button" disabled={!active} onClick={() => showGraph()}>关系与大模型 ↗</button></div><input ref={fileRef} type="file" hidden accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void importCase(file); }} /></div>
      {tab !== 'graph' && <main className="bw-main"><div className="bw-page-title"><div><p className="bw-kicker">{tab === 'today' ? '今日跟进' : tab === 'clients' ? '客户与联系人' : '项目工作台'}</p><h1>{tab === 'today' ? '把下一步，放在眼前。' : tab === 'clients' ? '客户与联系人' : '推进每一个项目'}</h1><p>{tab === 'today' ? '全部资料集的待办，集中在这里。' : tab === 'clients' ? '会前看关系，会后记需求和约定。' : '阶段、参与方和下一步，以你的确认记录为准。'}</p></div>{tab !== 'today' && <button className="bw-button bw-primary" onClick={() => createEntity(tab === 'projects' ? 'project' : 'person')}>＋ {tab === 'projects' ? '新建项目' : '添加客户 / 联系人'}</button>}</div>
        {tab === 'today' && <><div className="bw-metrics"><div><span>待跟进</span><strong>{pending.length}</strong></div><div><span>今天到期</span><strong>{pending.filter(t => taskBucket(t, day) === 'today').length}</strong></div><div><span>已逾期</span><strong className="bw-overdue">{pending.filter(t => taskBucket(t, day) === 'overdue').length}</strong></div></div><div className="bw-today-grid"><section className="bw-panel"><div className="bw-section-heading"><h2>下一步行动</h2><button className="bw-text-button" onClick={() => openNote()}>新增行动 ＋</button></div>{!pending.length ? <div className="bw-empty"><strong>没有待跟进事项</strong><p>记下下一次沟通要完成的事。</p><button className="bw-button" onClick={() => openNote()}>记下下一步</button></div> : ['overdue', 'today', 'later', 'undated'].map(bucket => { const tasks = pending.filter(t => taskBucket(t, day) === bucket).sort((a, b) => a.due.localeCompare(b.due)); return tasks.length ? <div key={bucket}><h3 className="bw-group-title">{{ overdue: '已逾期', today: '今天', later: '之后', undated: '未定日期' }[bucket]}</h3>{taskRows(tasks)}</div> : null; })}{work.tasks.some(t => t.done) && <details className="bw-completed"><summary>已完成 · 可撤销 ({work.tasks.filter(t => t.done).length})</summary>{taskRows(work.tasks.filter(t => t.done))}</details>}</section><aside className="bw-today-side"><section className="bw-panel"><div className="bw-section-heading"><h2>当前项目</h2><button className="bw-text-button" onClick={() => go('projects')}>全部 ↗</button></div>{projects.length ? projects.slice(0, 5).map(p => <button className="bw-project-link" key={p.id} onClick={() => { setTab('projects'); setSelectedId(p.id); }}><span>{p.name}<small>{planFor(p.id).stage}</small></span><span>›</span></button>) : <div className="bw-empty"><p>建立项目，再整理参与方和计划。</p><button className="bw-button" onClick={() => createEntity('project')}>新建项目</button></div>}</section><section className="bw-panel bw-tip"><span className="bw-kicker">会前一分钟</span><h2>先看人，再看关系</h2><p>查任职、项目角色、已有引荐，以及上次约定的下一步。</p><button className="bw-text-button" onClick={() => go('clients')}>打开客户卡 ↗</button></section></aside></div>
          {!!work.notes.length && <section className="bw-panel bw-recent"><div className="bw-section-heading"><h2>最近记录</h2><span>包含未关联客户的记录</span></div>{[...work.notes].reverse().slice(0, noteLimit).map(n => <article className="bw-note" key={n.id}><time>{n.at}</time><p>{n.text}</p>{(n.entityId || n.projectId) && <button className="bw-text-button" onClick={() => showEntity(n.bookId, n.entityId || n.projectId!)}>{nameFor(n.bookId, n.entityId || n.projectId)} ↗</button>}</article>)}{work.notes.length > noteLimit && <button className="bw-text-button" onClick={() => setNoteLimit(n => n + 20)}>加载更多记录（共 {work.notes.length} 条）</button>}</section>}
        </>}
        {(tab === 'clients' || tab === 'projects') && <>
          {!selected && <><div className="bw-list-toolbar"><input aria-label="搜索客户或项目" placeholder="搜索名称、分类或别名" value={query} onChange={e => setQuery(e.target.value)} />{tab === 'clients' && <select aria-label="联系人类型" value={clientKind} onChange={e => setClientKind(e.target.value)}><option value="all">人物与机构</option><option value="person">人物</option><option value="organization">机构</option></select>}</div><div className="bw-card-grid">{listing.map(e => <button className="bw-panel bw-client-card" key={e.id} onClick={() => setSelectedId(e.id)}><div className="bw-card-heading"><span className={`bw-avatar bw-avatar-${e.kind}`}>{e.kind === 'person' ? e.name.slice(-2) : e.kind === 'project' ? '项' : '企'}</span><span className="bw-pill">{e.kind === 'person' ? '人物' : e.kind === 'project' ? planFor(e.id).stage : '机构'}</span></div><h2>{e.name}</h2><p>{e.category || '分类未记录'}</p><div className="bw-card-next"><span>下一步</span><strong>{tasksFor(e).find(t => !t.done)?.title || '尚未设置'}</strong></div><span className="bw-card-arrow">打开档案 ↗</span></button>)}</div>{!listing.length && <div className="bw-empty bw-panel"><strong>{query ? '没有找到匹配结果' : tab === 'clients' ? '还没有客户或联系人' : '还没有项目'}</strong><p>{query ? '试试名称、分类或别名。' : '手动添加，或导入已有商业材料。无需连接模型即可使用。'}</p><button className="bw-button" onClick={() => query ? setQuery('') : createEntity(tab === 'clients' ? 'person' : 'project')}>{query ? '清空搜索' : '立即添加'}</button></div>}</>}
          {selected && active && <><button className="bw-text-button bw-back" onClick={() => setSelectedId('')}>← 返回{tab === 'projects' ? '项目' : '客户'}列表</button><div className="bw-detail-head"><span className={`bw-avatar bw-avatar-${selected.kind}`}>{selected.kind === 'person' ? selected.name.slice(-2) : selected.kind === 'project' ? '项' : '企'}</span><div><h2>{selected.name}</h2><p>{selected.category ?? '分类未记录'}{selected.aliases?.length ? ` · ${selected.aliases.join(' / ')}` : ''}</p></div><div className="bw-actions"><button className="bw-button bw-primary" onClick={() => openNote(active.id, selected.kind === 'project' ? undefined : selected.id, selected.kind === 'project' ? selected.id : undefined)}>记一笔 / 下一步</button><button className="bw-button" onClick={() => showGraph(selected.id)}>查看关系图</button></div></div><div className="bw-detail-grid"><div>
            {selected.kind === 'project' && <section className="bw-panel"><div className="bw-section-heading"><h2>项目概况</h2><button className="bw-text-button" onClick={() => setForm({ kind: 'project', plan: planFor(selected.id) })}>编辑</button></div><span className="bw-pill">{planFor(selected.id).stage}</span><p className="bw-preserve">{planFor(selected.id).brief || '记录客户目标、融资 / 并购需求、时间表及尚待确认的事项。'}</p><p className="bw-help">员工填写的项目管理状态，不代表已签约或完成交易。</p></section>}
            <section className="bw-panel"><div className="bw-section-heading"><h2>下一步与约定</h2><span>{tasksFor(selected).filter(t => !t.done).length} 项待办</span></div>{tasksFor(selected).length ? taskRows(tasksFor(selected)) : <p>还没有约定下一步。会后记一条，避免遗漏。</p>}</section>
            {selected.kind === 'project' && <section className="bw-panel"><div className="bw-section-heading"><h2>项目跟进名单</h2><button className="bw-text-button" disabled={!clients.length} onClick={() => setForm({ kind: 'outreach', item: { id: '', bookId: active.id, projectId: selected.id, entityId: '', stage: '未联系', next: '' } })}>添加参与方 ＋</button></div><p className="bw-help">人工维护接洽状态；有兴趣不等于投资承诺，名单不会生成交易关系。</p>{work.outreach.filter(o => o.bookId === active.id && o.projectId === selected.id).map(o => <button className="bw-outreach" key={o.id} onClick={() => setForm({ kind: 'outreach', item: o })}><span><strong>{entityMap.get(o.entityId)?.name}</strong><small>{o.next || '待记录跟进事项'}</small></span><span className="bw-pill">{o.stage}</span></button>)}{!work.outreach.some(o => o.bookId === active.id && o.projectId === selected.id) && <p>{clients.length ? '还没有加入投资方、买方或专业服务方。' : '先添加客户或机构，再加入跟进名单。'}</p>}</section>}
            <section className="bw-panel"><div className="bw-section-heading"><h2>个人商业记录</h2><span>不自动发送给模型</span></div>{notesFor(selected).length ? [...notesFor(selected)].reverse().map(n => <article className="bw-note" key={n.id}><time>{n.at}</time><p>{n.text}</p>{n.projectId && selected.kind !== 'project' && <button className="bw-text-button" onClick={() => showEntity(active.id, n.projectId!)}>{entityMap.get(n.projectId)?.name} ↗</button>}</article>) : <p>记录需求、沟通要点和约定，不收集日常私聊。</p>}</section>
          </div><aside><section className="bw-panel"><div className="bw-section-heading"><h2>{selected.kind === 'project' ? '项目角色与关系' : '商业关系速览'}</h2></div><p className="bw-help">截至 {active.analysis.asOf.slice(0, 10)} · {active.origin === 'rules' ? '规则预览' : active.origin === 'snapshot' ? '已恢复快照' : '模型结果'}。不从头衔推断决策权。</p>{selectedRelations.map(r => <div className="bw-relation" key={r.id}><strong>{entityMap.get(r.sourceId)?.name} <span>→ {r.label} →</span> {entityMap.get(r.targetId)?.name}</strong>{r.viaId && <small>引荐人：{entityMap.get(r.viaId)?.name}</small>}{r.projectId && <small>项目：{entityMap.get(r.projectId)?.name}</small>}<span className={`bw-relation-status ${r.status !== 'supported' ? 'bw-caution' : ''}`}>{STATUS[r.status]}</span></div>)}{!selectedRelations.length && <p>暂无明确关系。导入商业材料后可分析，不把同群或频繁聊天视为业务关系。</p>}</section></aside></div></>}
        </>}
      </main>}
      {graphVisited && active && <div hidden={tab !== 'graph'} className="bw-graph-surface"><RelationshipWorkspace key={`${active.id}:${graphEpoch}`} initialData={active} onImport={importBook} onAnalysis={analysis => recordAnalysis(active.id, analysis)} requestedFocus={graphFocus} /></div>}
      {tab === 'graph' && !active && <main className="bw-main"><div className="bw-empty bw-panel"><h1>先建立客户资料</h1><p>新建客户或导入材料，再查看 2D / 3D 商业关系。</p><button className="bw-button" onClick={() => createEntity()}>添加客户</button></div></main>}
    </div>
    {wechatOpen && <WechatImportWizard onClose={() => setWechatOpen(false)} onComplete={(input, result) => importBook(input, result.analysis, 'model')} />}
    {form?.kind === 'entity' && <EntityForm kind={form.entityKind} onClose={() => setForm(null)} onSave={entity => { commit(addEntity(workRef.current, entity)); setGraphEpoch(e => e + 1); setSelectedId(entity.id); setTab(entity.kind === 'project' ? 'projects' : 'clients'); }} />}
    {form?.kind === 'note' && <NoteForm book={work.books.find(b => b.id === form.bookId)!} entityId={form.entityId} projectId={form.projectId} onClose={() => setForm(null)} onSave={(note, task) => { commit({ ...workRef.current, notes: note ? [...workRef.current.notes, note] : workRef.current.notes, tasks: task ? [...workRef.current.tasks, task] : workRef.current.tasks }); setMessage('已记入当前工作台，未上传。请及时加密保存；到期日不会触发手机推送。'); }} />}
    {form?.kind === 'project' && <ProjectForm plan={form.plan} onClose={() => setForm(null)} onSave={plan => commit({ ...workRef.current, projects: [...workRef.current.projects.filter(p => !(p.bookId === plan.bookId && p.projectId === plan.projectId)), plan] })} />}
    {form?.kind === 'outreach' && <OutreachForm book={work.books.find(b => b.id === form.item.bookId)!} item={form.item} onClose={() => setForm(null)} onSave={item => { if (workRef.current.outreach.some(o => o.id !== item.id && o.bookId === item.bookId && o.projectId === item.projectId && o.entityId === item.entityId)) throw new Error('该对象已在本项目名单中，请编辑已有记录。'); commit({ ...workRef.current, outreach: [...workRef.current.outreach.filter(o => o.id !== item.id), item] }); }} />}
    {(form?.kind === 'save' || form?.kind === 'restore') && <VaultForm mode={form.kind} work={work} revision={revision.current} onClose={() => setForm(null)} onSaved={rev => { if (rev === revision.current) { setDirty(false); setMessage('已确认文件保存。再次修改后，需要重新加密保存。'); } }} onRestore={(restored, expected) => {
      if (expected !== revision.current) throw new Error('资料已变化，请先保存再恢复。');
      fileOperation.current += 1; setImporting(false); commit({ ...restored, books: restored.books.map(b => ({ ...b, origin: 'snapshot' })) }); setDirty(false); setGraphEpoch(e => e + 1); setGraphVisited(false); setSelectedId(''); setTab('today'); setQuery(''); setMessage('工作台已恢复，未调用模型。显示的是保存时的关系快照，不代表关系现在仍然有效。');
    }} />}
  </div>;
}
