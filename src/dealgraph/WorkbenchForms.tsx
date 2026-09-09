import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { RelationshipEntity } from './relationships/types';
import { MAX_VAULT_BYTES, newId, OUTREACH, STAGES, today } from './workbench-state';
import type { Book, Note, Outreach, ProjectPlan, Task, Workbench } from './workbench-state';
import { decryptWorkbench, encryptWorkbench } from './workbench-vault';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="bw-dialog" aria-labelledby="bw-dialog-title" onCancel={onClose}><div className="bw-dialog-heading"><h2 id="bw-dialog-title">{title}</h2><button type="button" className="bw-icon-button" aria-label="关闭窗口" onClick={onClose}>×</button></div>{children}</dialog>;
}
function Footer({ error, busy = false, label = '记入工作台', onClose }: { error: string; busy?: boolean; label?: string; onClose: () => void }) {
  return <>{error && <p className="bw-form-error" role="alert">{error}</p>}<div className="bw-form-actions"><button type="button" className="bw-button" onClick={onClose}>取消</button><button type="submit" className="bw-button bw-primary" disabled={busy}>{label}</button></div></>;
}
export function NoteForm({ book, entityId = '', projectId = '', onSave, onClose }: { book: Book; entityId?: string; projectId?: string; onSave: (note: Note | null, task: Task | null) => void; onClose: () => void }) {
  const [entity, setEntity] = useState(entityId), [project, setProject] = useState(projectId);
  const [text, setText] = useState(''), [next, setNext] = useState(''), [due, setDue] = useState(''), [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault(); if (!text.trim() && !next.trim()) { setError('记录内容或下一步至少填写一项。'); return; }
    const ref = { bookId: book.id, ...(entity ? { entityId: entity } : {}), ...(project ? { projectId: project } : {}) };
    try { onSave(text.trim() ? { ...ref, id: newId(), text: text.trim(), at: today() } : null, next.trim() ? { ...ref, id: newId(), title: next.trim(), due, done: false } : null); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : '记录未完成，输入已保留。'); }
  }
  return <Modal title="记一条商业跟进" onClose={onClose}><form onSubmit={submit}><p className="bw-help">记录业务需求、约定和下一步；不会自动上传给模型。</p><div className="bw-form-grid"><label>关联客户<select value={entity} onChange={e => setEntity(e.target.value)}><option value="">不指定</option>{book.input.entities.filter(e => e.kind !== 'project').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>关联项目<select value={project} onChange={e => setProject(e.target.value)}><option value="">不指定</option>{book.input.entities.filter(e => e.kind === 'project').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label></div><label>商业记录<textarea maxLength={10_000} rows={5} value={text} onChange={e => setText(e.target.value)} placeholder="客户需求、沟通要点、待确认事项。不要粘贴无关私聊。" /></label><label>下一步行动<input maxLength={500} value={next} onChange={e => setNext(e.target.value)} placeholder="例如：周五前向客户确认材料清单" /></label><label>到期日（可选，无手机推送）<input type="date" value={due} disabled={!next.trim()} onChange={e => setDue(e.target.value)} /></label><Footer error={error} onClose={onClose} /></form></Modal>;
}
export function EntityForm({ kind: initialKind, onSave, onClose }: { kind: RelationshipEntity['kind']; onSave: (entity: RelationshipEntity) => void; onClose: () => void }) {
  const [name, setName] = useState(''), [category, setCategory] = useState(''), [kind, setKind] = useState(initialKind), [error, setError] = useState('');
  function submit(e: FormEvent) { e.preventDefault(); try { onSave({ id: newId(), name: name.trim(), kind, ...(category.trim() ? { category: category.trim() } : {}) }); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '添加未完成。'); } }
  return <Modal title="添加客户 / 联系人 / 项目" onClose={onClose}><form onSubmit={submit}><label>名称<input required autoFocus maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label><div className="bw-form-grid"><label>类型<select value={kind} onChange={e => setKind(e.target.value as RelationshipEntity['kind'])}><option value="person">人物</option><option value="organization">机构 / 客户公司</option><option value="project">项目</option></select></label><label>分类 / 备注<input maxLength={80} value={category} onChange={e => setCategory(e.target.value)} placeholder="例如：潜在买方 / 医疗行业" /></label></div><p className="bw-help">添加到当前资料集，不自动合并同名对象。分类不会自动生成任职或交易关系。</p><Footer error={error} label="添加" onClose={onClose} /></form></Modal>;
}
export function ProjectForm({ plan, onSave, onClose }: { plan: ProjectPlan; onSave: (plan: ProjectPlan) => void; onClose: () => void }) {
  const [stage, setStage] = useState(plan.stage), [brief, setBrief] = useState(plan.brief), [error, setError] = useState('');
  return <Modal title="编辑项目概况" onClose={onClose}><form onSubmit={e => { e.preventDefault(); try { onSave({ ...plan, stage, brief: brief.trim() }); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '更新未完成。'); } }}><label>项目阶段<select value={stage} onChange={e => setStage(e.target.value as ProjectPlan['stage'])}>{STAGES.map(s => <option key={s}>{s}</option>)}</select></label><label>需求与目标<textarea maxLength={4000} rows={5} value={brief} onChange={e => setBrief(e.target.value)} placeholder="行业、融资 / 并购需求、金额、地区、时间表。未知信息标明待确认。" /></label><p className="bw-help">由你确认的管理状态，不代表已签约或完成交易；不会自动发送给模型。</p><Footer error={error} label="更新项目" onClose={onClose} /></form></Modal>;
}
export function OutreachForm({ book, item, onSave, onClose }: { book: Book; item: Outreach; onSave: (item: Outreach) => void; onClose: () => void }) {
  const [entityId, setEntity] = useState(item.entityId), [stage, setStage] = useState(item.stage), [next, setNext] = useState(item.next), [error, setError] = useState('');
  return <Modal title="项目参与方跟进" onClose={onClose}><form onSubmit={e => { e.preventDefault(); try { onSave({ ...item, id: item.id || newId(), entityId, stage, next: next.trim() }); onClose(); } catch (err) { setError(err instanceof Error ? err.message : '更新未完成。'); } }}><label>跟进对象<select required value={entityId} disabled={!!item.id} onChange={e => setEntity(e.target.value)}><option value="">选择客户 / 联系人 / 机构</option>{book.input.entities.filter(e => e.kind !== 'project').map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><label>接洽状态<select value={stage} onChange={e => setStage(e.target.value as Outreach['stage'])}>{OUTREACH.map(s => <option key={s}>{s}</option>)}</select></label><label>跟进事项 / 拒绝原因<textarea maxLength={1000} rows={4} value={next} onChange={e => setNext(e.target.value)} /></label><p className="bw-help">不自动发送消息或生成投资关系。需要到期日时，另记“下一步行动”。</p><Footer error={error} label="更新跟进" onClose={onClose} /></form></Modal>;
}
export function VaultForm({ mode, work, revision, onRestore, onSaved, onClose }: { mode: 'save' | 'restore'; work: Workbench; revision: number; onRestore: (work: Workbench, expectedRevision: number) => void; onSaved: (revision: number) => void; onClose: () => void }) {
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [fileText, setFileText] = useState(''), [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [downloadRevision, setDownloadRevision] = useState<number | null>(null);
  const operation = useRef(0), currentRevision = useRef(revision); currentRevision.current = revision;
  useEffect(() => () => { operation.current += 1; }, []);
  async function select(file?: File) {
    if (!file) return;
    const token = ++operation.current; setFileText(''); setFileName(''); setError(''); setBusy(false);
    if (file.size > MAX_VAULT_BYTES) { setError('请选择 16 MB 以内的加密工作台文件。'); return; }
    setBusy(true);
    try { const text = await file.text(); if (token === operation.current) { setFileText(text); setFileName(file.name); } }
    catch { if (token === operation.current) setError('文件读取失败。'); }
    finally { if (token === operation.current) setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (mode === 'save' && password !== repeat) { setError('两次密码不一致。'); return; }
    if (mode === 'restore' && !fileText) { setError('请选择加密文件。'); return; }
    const token = ++operation.current, capturedRevision = revision, secret = password;
    setPassword(''); setRepeat(''); setBusy(true); setError('');
    try {
      if (mode === 'save') {
        const ciphertext = await encryptWorkbench(work, secret);
        if (token !== operation.current) return;
        if (capturedRevision !== currentRevision.current) { setError('资料刚刚发生变化，请重新保存最新版本。'); return; }
        const url = URL.createObjectURL(new Blob([ciphertext], { type: 'application/octet-stream' }));
        const a = document.createElement('a'); a.href = url; a.download = `DealGraph-${today()}.dgvault`; document.body.appendChild(a); a.click(); a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000); setDownloadRevision(capturedRevision);
      } else {
        const restored = await decryptWorkbench(fileText, secret);
        if (token !== operation.current) return;
        if (capturedRevision !== currentRevision.current) { setError('当前资料刚刚发生变化，请先保存后再恢复。'); return; }
        if (!window.confirm('打开文件将替换当前整个工作台。未保存内容会丢失，确定继续？')) return;
        onRestore(restored, capturedRevision); onClose();
      }
    } catch (err) { if (token === operation.current) setError(err instanceof Error ? err.message : '操作未完成，当前资料保留。'); }
    finally { if (token === operation.current) setBusy(false); }
  }
  return <Modal title={mode === 'save' ? '保存加密工作台' : '打开加密工作台'} onClose={onClose}><form onSubmit={e => { void submit(e); }}>
    {mode === 'save' ? <><p>保存全部 {work.books.length} 个资料集、客户、项目、个人记录、待办和完整关系快照，包括导入的分析原文。不含 API 密钥或模型上传授权。</p><p className="bw-security-note">在浏览器内加密，不上传。密码丢失无法找回。打开后的资料仍可能被同设备用户或浏览器插件读取，请使用可信设备。</p></> : <><p>选择之前保存的 .dgvault 文件，在当前浏览器解密，不上传。恢复前会再次确认替换。</p><label>加密工作台文件<input type="file" accept=".dgvault,application/octet-stream" onChange={e => { void select(e.target.files?.[0]); e.target.value = ''; }} /></label>{fileName && <p className="bw-help">已选择：{fileName}</p>}</>}
    {downloadRevision === null ? <><label>{mode === 'save' ? '保存密码（至少 12 个字符）' : '文件保存密码'}<input type="password" autoComplete={mode === 'save' ? 'new-password' : 'off'} minLength={12} maxLength={256} required value={password} disabled={busy} onChange={e => setPassword(e.target.value)} /></label>{mode === 'save' && <label>再次输入密码<input type="password" autoComplete="new-password" minLength={12} maxLength={256} required value={repeat} disabled={busy} onChange={e => setRepeat(e.target.value)} /></label>}<Footer error={error} busy={busy || mode === 'restore' && !fileText} label={busy ? '正在处理…' : mode === 'save' ? '加密并下载' : '解密并打开'} onClose={onClose} /></> : <div role="status"><p>已请求浏览器下载。请在“下载”或手机“文件”中找到 .dgvault 文件，确认后再关闭页面。</p><button type="button" className="bw-button bw-primary" onClick={() => { if (currentRevision.current === downloadRevision) { onSaved(downloadRevision); onClose(); } else { setDownloadRevision(null); setError('资料已经变化，请重新保存最新版本。'); } }}>我已找到保存文件</button></div>}
  </form></Modal>;
}
