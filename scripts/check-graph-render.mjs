// Server-render only: no browser, DOM driver, screenshot, customer data or external network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const server = await createServer({ server: { middlewareMode: true, ws: false, watch: null }, appType: 'custom' });
try {
  const { default: Map } = await server.ssrLoadModule('/src/dealgraph/relationships/RelationshipMap.tsx');
  const { analyzeRelationshipCase } = await server.ssrLoadModule('/src/dealgraph/relationships/engine.ts');
  const sample = JSON.parse(readFileSync(new URL('../src/dealgraph/relationships/sample.json', import.meta.url), 'utf8'));
  const analysis = analyzeRelationshipCase(sample);
  const noop = () => {};
  const selectionLabels = html => [...html.matchAll(/role="button"[^>]*aria-label="([^"]+)"|aria-label="([^"]+)"[^>]*role="button"/g)].map(match => match[1] ?? match[2]).sort();
  for (const filter of ['all', 'employment', 'ownership', 'advisory', 'introduction', 'empty']) {
    const relationships = analysis.relationships.filter(item => item.status !== 'rejected' && (filter === 'all' || item.kind === filter));
    const props = { entities: analysis.entities, relationships, focusId: analysis.entities[0].id, selectedId: analysis.entities.at(-1).id, selectedRelationId: relationships[0]?.id ?? null, onSelect: noop, onSelectRelation: noop, onFocus: noop };
    const flat = renderToStaticMarkup(createElement(Map, { ...props, mode: '2d' }));
    const spatial = renderToStaticMarkup(createElement(Map, { ...props, mode: '3d' }));
    const labels = selectionLabels(flat);
    assert.equal(labels.length, props.entities.length + relationships.length);
    assert.deepEqual(selectionLabels(spatial), labels, filter + ': same selectable nodes and relationships in both dimensions');
    assert.match(spatial, /aria-label="3D拖动方式"/);
    assert.equal((flat.match(/marker-end=/g) ?? []).length, relationships.length);
    assert.equal((spatial.match(/marker-end=/g) ?? []).length, relationships.length);
    assert.ok(!spatial.includes('NaN')); assert.ok(!spatial.includes('Infinity'));
  }
  const { default: Workspace } = await server.ssrLoadModule('/src/dealgraph/RelationshipWorkspace.tsx');
  const workspace = renderToStaticMarkup(createElement(Workspace));
  assert.ok(workspace.includes('连接大模型')); assert.ok(!workspace.includes('GPT-4o 分析'));
  assert.ok(workspace.includes('aria-label="图谱维度"'));
  assert.ok(workspace.includes('导入微信聊天'));
  for (const requestedFocus of ['', 'nonexistent']) {
    const graph = renderToStaticMarkup(createElement(Workspace, { initialData: { input: sample, analysis, origin: 'rules' }, requestedFocus }));
    assert.ok((graph.match(/marker-end=/g) ?? []).length > 0, 'invalid requested focus must fall back to a valid center');
  }
  const snapshot = renderToStaticMarkup(createElement(Workspace, { initialData: { input: sample, analysis, origin: 'snapshot' } }));
  const recovered = renderToStaticMarkup(createElement(Workspace, { initialData: { input: sample, analysis: { ...analysis, issues: [{ id: 'recovered-1', kind: 'invalid_input', message: '日期已忽略：没有原文依据。' }] }, origin: 'model' } }));
  assert.ok(recovered.includes('当前图谱不代表完整提取'));
  assert.ok(recovered.includes('日期已忽略：没有原文依据。'));
  assert.ok(snapshot.includes('已恢复快照 · 本次未调用模型'));
  assert.ok(!snapshot.includes('大模型 分析'));
  const { default: Workbench, demoState } = await server.ssrLoadModule('/src/dealgraph/BankingWorkbench.tsx');
  const { emptyWorkbench } = await server.ssrLoadModule('/src/dealgraph/workbench-state.ts');
  for (const initialTab of ['today', 'clients', 'projects', 'graph']) {
    const html = renderToStaticMarkup(createElement(Workbench, { initialTab }));
    for (const label of ['工作台导航', '今日', '客户', '项目', '关系', '打开文件', '加密保存', '记一条']) assert.ok(html.includes(label));
    assert.ok(html.includes('[虚构示范]'));
    if (initialTab === 'graph') assert.ok((html.match(/marker-end=/g) ?? []).length > 0);
    const empty = renderToStaticMarkup(createElement(Workbench, { initialTab, initialState: emptyWorkbench() }));
    assert.ok(!empty.includes('宁川'));
  }
  const manyNotes = demoState();
  manyNotes.notes = Array.from({ length: 9 }, (_, i) => ({ id: `note-${i}`, bookId: 'demo', text: `未关联记录 ${i}`, at: '2026-09-09' }));
  assert.ok(renderToStaticMarkup(createElement(Workbench, { initialState: manyNotes })).includes('加载更多记录'));
  const forms = await server.ssrLoadModule('/src/dealgraph/WorkbenchForms.tsx');
  const book = demoState().books[0];
  const note = renderToStaticMarkup(createElement(forms.NoteForm, { book, onSave: noop, onClose: noop }));
  for (const label of ['关联客户', '关联项目', '商业记录', '下一步行动', '无手机推送']) assert.ok(note.includes(label));
  const vault = renderToStaticMarkup(createElement(forms.VaultForm, { mode: 'save', work: demoState(), revision: 0, onRestore: noop, onSaved: noop, onClose: noop }));
  assert.ok(vault.includes('type="password"')); assert.ok(vault.includes('密码丢失无法找回')); assert.ok(vault.includes('不含 API 密钥'));
  const { default: Wizard } = await server.ssrLoadModule('/src/dealgraph/relationships/WechatImportWizard.tsx');
  const wizard = renderToStaticMarkup(createElement(Wizard, { onClose: noop, onComplete: noop }));
  assert.ok(wizard.includes('聊天记录 JSON v1')); assert.ok(wizard.includes('试用虚构聊天'));
  assert.ok(wizard.includes('只梳理商业关系')); assert.ok(wizard.includes('aria-labelledby="wechat-title"'));
  console.log('SSR passed: 6-filter 2D/3D parity, valid initial focus, snapshot label, four workbench views + empty states, note/vault form semantics, raw-chat wizard. No browser or external calls.');
} finally { await server.close(); }
