import { useMemo, useRef, useState } from 'react';
import type { BusinessRelationship, RelationshipEntity } from './types';
import { INITIAL_CAMERA, nodeDepth, orbitCamera, orbitPath, projectPoint } from './graph-space';
import type { Camera } from './graph-space';

interface Props {
  mode?: '2d' | '3d';
  entities: RelationshipEntity[];
  relationships: BusinessRelationship[];
  layoutEntities?: RelationshipEntity[];
  layoutRelationships?: BusinessRelationship[];
  focusId: string;
  selectedId: string;
  selectedRelationId: string | null;
  onSelect: (id: string) => void;
  onSelectRelation: (id: string) => void;
  onFocus: (id: string) => void;
}

interface Point { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }
const WIDTH = 1120;
const HEIGHT = 820;
function relationParticipants(relation: BusinessRelationship) { return [relation.sourceId, relation.targetId, ...(relation.kind === 'introduction' && relation.viaId ? [relation.viaId] : [])]; }

function graphLayout(entities: RelationshipEntity[], relationships: BusinessRelationship[], focusId: string) {
  const points = new Map<string, Point>();
  points.set(focusId, { x: WIDTH / 2, y: HEIGHT / 2 - 20 });
  const linked = new Set(relationships.flatMap((relation) => relationParticipants(relation).includes(focusId) ? relationParticipants(relation) : []));
  const other = entities.filter((entity) => entity.id !== focusId);
  const direct = other.filter((entity) => linked.has(entity.id));
  const peripheral = other.filter((entity) => !linked.has(entity.id));
  const kindRank = { person: 0, organization: 1, project: 2 };
  const ordered = (items: RelationshipEntity[]) => [...items].sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.id.localeCompare(b.id));
  const ring = (items: RelationshipEntity[], rx: number, ry: number, start: number) => {
    ordered(items).forEach((entity, index) => {
      const angle = start + (index / items.length) * Math.PI * 2;
      points.set(entity.id, { x: WIDTH / 2 + Math.cos(angle) * rx, y: HEIGHT / 2 - 20 + Math.sin(angle) * ry });
    });
  };
  if (peripheral.length === 0) ring(direct, 380, 280, -Math.PI * 0.95);
  else {
    ring(direct, 280, 205, -Math.PI * 0.96);
    const anchors = new Map(direct.map((entity) => [entity.id, entity.id]));
    const relationPriority = (relation: BusinessRelationship) => relation.kind === 'employment' ? 0 : relation.kind === 'project_role' ? 1 : relation.kind === 'introduction' ? 3 : 2;
    const structuralEdges = [...relationships].sort((a, b) => relationPriority(a) - relationPriority(b));
    for (let depth = 0; depth < 4; depth += 1) {
      for (const entity of peripheral) {
        if (anchors.has(entity.id)) continue;
        const connecting = structuralEdges.find((relation) => (relation.sourceId === entity.id && anchors.has(relation.targetId)) || (relation.targetId === entity.id && anchors.has(relation.sourceId)));
        if (connecting) anchors.set(entity.id, anchors.get(connecting.sourceId === entity.id ? connecting.targetId : connecting.sourceId)!);
      }
    }
    const groups = new Map<string, RelationshipEntity[]>();
    peripheral.forEach((entity) => { const anchor = anchors.get(entity.id) ?? 'unconnected'; groups.set(anchor, [...(groups.get(anchor) ?? []), entity]); });
    for (const [anchor, members] of groups) {
      const at = points.get(anchor);
      const baseAngle = at ? Math.atan2((at.y - HEIGHT / 2 + 20) / 205, (at.x - WIDTH / 2) / 280) : -Math.PI / 2;
      ordered(members).forEach((entity, index) => {
        const angle = baseAngle + (index - (members.length - 1) / 2) * 0.26;
        points.set(entity.id, { x: WIDTH / 2 + Math.cos(angle) * 455, y: HEIGHT / 2 - 20 + Math.sin(angle) * 335 });
      });
    }
  }
  // A small deterministic collision pass keeps labels apart without a moving graph.
  for (let step = 0; step < 40; step += 1) {
    for (let a = 0; a < other.length; a += 1) {
      for (let b = a + 1; b < other.length; b += 1) {
        const pa = points.get(other[a].id)!;
        const pb = points.get(other[b].id)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        if (Math.abs(dx) < 165 && Math.abs(dy) < 100) {
          const push = (100 - Math.abs(dy)) * 0.2;
          const sign = dy >= 0 ? 1 : -1;
          pa.y -= push * sign;
          pb.y += push * sign;
          pa.y = Math.max(72, Math.min(HEIGHT - 100, pa.y));
          pb.y = Math.max(72, Math.min(HEIGHT - 100, pb.y));
        }
      }
    }
  }
  return points;
}

function pointAtEdge(center: Point, toward: Point, entity: RelationshipEntity, isFocus: boolean, scale = 1) {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const dist = Math.hypot(dx, dy) || 1;
  const radius = (isFocus ? 62 : entity.kind === 'organization' ? 48 : entity.kind === 'project' ? 38 : 28) * scale;
  return { x: center.x + (dx / dist) * radius, y: center.y + (dy / dist) * radius };
}

function compactLabel(relation: BusinessRelationship, relationships: BusinessRelationship[], entityById: Map<string, RelationshipEntity>, focusId: string) {
  const baseLabel = relation.kind === 'introduction' && relation.viaId && entityById.has(relation.viaId)
    ? `${entityById.get(relation.viaId)!.name}引荐`
    : relation.label.replace(/^(任职|顾问|借贷|子公司|项目角色|合作|决策权) · /, '');
  const scopedSibling = relation.projectId && relationships.some((other) => other.id !== relation.id && other.sourceId === relation.sourceId && other.targetId === relation.targetId && other.kind === relation.kind && other.projectId !== relation.projectId);
  let scope = scopedSibling ? entityById.get(relation.projectId!)?.name ?? '' : '';
  const focusName = entityById.get(focusId)?.name ?? '';
  let prefixLength = 0;
  while (prefixLength < focusName.length && scope[prefixLength] === focusName[prefixLength]) prefixLength += 1;
  if (prefixLength >= 2) scope = scope.slice(prefixLength);
  scope = scope.replace(/项目$/, '');
  const state = relation.status === 'historical' ? '历史 · ' : relation.status === 'conflicted' ? '分歧 · ' : relation.status === 'review' ? '待确认 · ' : '';
  return `${state}${baseLabel}${relation.percentage !== undefined && !relation.label.includes('%') ? ` ${relation.percentage}%` : ''}${scope ? ` · ${scope}` : ''}`;
}

function overlap(a: Box, b: Box) { return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)); }

export default function RelationshipMap({ mode = '2d', entities, relationships, layoutEntities, layoutRelationships, focusId, selectedId, selectedRelationId, onSelect, onSelectRelation, onFocus }: Props) {
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [gesture, setGesture] = useState<'rotate' | 'pan'>('rotate');
  const drag = useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number; camera: Camera; rotate: boolean; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const flatPositions = useMemo(() => graphLayout(layoutEntities ?? entities, layoutRelationships ?? relationships, focusId), [entities, relationships, layoutEntities, layoutRelationships, focusId]);
  const positions = useMemo(() => new Map([...flatPositions].map(([id, point]) => [id, mode === '3d' ? projectPoint({ x: point.x - 560, y: point.y - 390, z: nodeDepth(id, focusId) }, camera) : { ...point, z: 0, scale: 1 }])), [flatPositions, mode, focusId, camera]);
  const depthOrderedEntities = useMemo(() => [...entities].sort((a, b) => (positions.get(a.id)?.z ?? 0) - (positions.get(b.id)?.z ?? 0)), [entities, positions]);
  const resetView = () => { setView({ x: 0, y: 0, scale: 1 }); setCamera(INITIAL_CAMERA); };
  const entityById = useMemo(() => new Map(entities.map((entity) => [entity.id, entity])), [entities]);
  const adjacency = useMemo(() => new Set(relationships.flatMap((relation) => relationParticipants(relation).includes(selectedId) ? relationParticipants(relation) : [])), [relationships, selectedId]);
  const edges = useMemo(() => {
    const pairs = new Map<string, BusinessRelationship[]>();
    const labelBoxes: Box[] = [];
    const nodeBoxes = entities.flatMap((entity) => {
      const point = positions.get(entity.id);
      if (!point) return [];
      const scale = point.scale;
      if (entity.id === focusId) return [{ x: point.x - 65 * scale, y: point.y - 65 * scale, w: 130 * scale, h: 130 * scale }];
      const width = Math.min(190, entity.name.length * 14.6 + 12);
      return [{ x: point.x - 48 * scale, y: point.y - 36 * scale, w: 96 * scale, h: 70 * scale }, { x: point.x - width / 2 * scale, y: point.y + 33 * scale, w: width * scale, h: 43 * scale }];
    });
    relationships.forEach((relation) => {
      const key = [relation.sourceId, relation.targetId].sort().join('::');
      pairs.set(key, [...(pairs.get(key) ?? []), relation]);
    });
    return relationships.flatMap((relation) => {
      const source = positions.get(relation.sourceId);
      const target = positions.get(relation.targetId);
      const sourceEntity = entityById.get(relation.sourceId);
      const targetEntity = entityById.get(relation.targetId);
      if (!source || !target || !sourceEntity || !targetEntity) return [];
      const siblings = pairs.get([relation.sourceId, relation.targetId].sort().join('::'))!;
      const offset = (siblings.indexOf(relation) - (siblings.length - 1) / 2) * 55;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const side = relation.sourceId < relation.targetId ? 1 : -1;
      const control = { x: (source.x + target.x) / 2 - (dy / distance) * offset * side, y: (source.y + target.y) / 2 + (dx / distance) * offset * side };
      const start = pointAtEdge(source, control, sourceEntity, relation.sourceId === focusId, source.scale);
      const end = pointAtEdge(target, control, targetEntity, relation.targetId === focusId, target.scale);
      const labelText = compactLabel(relation, relationships, entityById, focusId);
      const labelWidth = Math.min(220, labelText.length * 12.4 + 18);
      let label = { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 };
      let bestScore = Number.POSITIVE_INFINITY;
      for (const t of [0.5, 0.42, 0.58, 0.33, 0.67, 0.25, 0.75]) {
        for (const perpendicular of [0, -16, 16]) {
          const candidate = { x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x - dy / distance * perpendicular, y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y + dx / distance * perpendicular };
          const box = { x: candidate.x - labelWidth / 2 - 3, y: candidate.y - 14, w: labelWidth + 6, h: 28 };
          const score = nodeBoxes.reduce((sum, node) => sum + overlap(box, node) * 5, 0) + labelBoxes.reduce((sum, previous) => sum + overlap(box, previous) * 10, 0) + Math.abs(t - 0.5) * 70 + Math.abs(perpendicular);
          if (score < bestScore) { bestScore = score; label = candidate; }
        }
      }
      labelBoxes.push({ x: label.x - labelWidth / 2, y: label.y - 13, w: labelWidth, h: 26 });
      return [{ relation, start, end, control, label, labelText }];
    });
  }, [entities, relationships, positions, entityById, focusId]);
  const zoom = (factor: number) => setView((current) => ({ ...current, scale: Math.min(2, Math.max(0.65, current.scale * factor)) }));
  return <div className={`rw-map-wrap ${mode === '3d' ? 'is-3d' : ''}`} data-view={mode}>
    <svg ref={svgRef} className="rw-map" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" tabIndex={0} aria-label={`${mode === '3d' ? '3D' : '2D'}客户关系图谱，箭头表示关系方向，点击节点或连线查看关系；方向键调整视角，加减键缩放，Home复位`} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const dx = event.key === 'ArrowLeft' ? -30 : event.key === 'ArrowRight' ? 30 : 0;
        const dy = event.key === 'ArrowUp' ? -30 : event.key === 'ArrowDown' ? 30 : 0;
        if (mode === '3d' && gesture === 'rotate' && !event.shiftKey) setCamera(current => orbitCamera(current, dx, dy));
        else setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
      } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.15); }
      else if (event.key === '-') { event.preventDefault(); zoom(0.85); }
      else if (event.key === 'Home') { event.preventDefault(); resetView(); }
    }} onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y, camera, rotate: mode === '3d' && gesture === 'rotate' && !event.shiftKey, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const viewRatio = Math.max(WIDTH / bounds.width, HEIGHT / bounds.height);
      const deltaX = (event.clientX - active.startX) * viewRatio;
      const deltaY = (event.clientY - active.startY) * viewRatio;
      active.moved = Math.abs(deltaX) + Math.abs(deltaY) > 3;
      if (active.moved) {
        if (active.rotate) setCamera(orbitCamera(active.camera, deltaX, deltaY));
        else setView((current) => ({ ...current, x: active.viewX + deltaX, y: active.viewY + deltaY }));
      }
    }} onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }} onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}>
      <defs>
        <pattern id="rw-grid" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.7" fill="#d9ddd9" /></pattern>
        <marker id="rw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="#a3acb8" strokeWidth="1.2" /></marker>
        <marker id="rw-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="#a48347" strokeWidth="1.4" /></marker>
      </defs>
      <rect width={WIDTH} height={HEIGHT} fill="url(#rw-grid)" />
      <g transform={`translate(${WIDTH / 2 + view.x} ${HEIGHT / 2 + view.y}) scale(${view.scale}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}>
        {mode === '3d' ? <><path className="rw-orbit" d={orbitPath(camera, 340, 'horizontal')} /><path className="rw-orbit rw-orbit-outer" d={orbitPath(camera, 455, 'vertical')} /></> : <><ellipse className="rw-orbit" cx={WIDTH / 2} cy={HEIGHT / 2 - 20} rx="280" ry="205" /><ellipse className="rw-orbit rw-orbit-outer" cx={WIDTH / 2} cy={HEIGHT / 2 - 20} rx="455" ry="335" /></>}
        {edges.map(({ relation, start, end, control, label, labelText }) => {
          const active = relation.id === selectedRelationId;
          const linked = relationParticipants(relation).includes(selectedId);
          const dimmed = selectedId !== focusId && !linked && !active;
          return <g key={relation.id} className={`rw-edge ${active ? 'is-active' : ''} ${dimmed ? 'is-dimmed' : ''} ${relation.status !== 'supported' ? 'is-uncertain' : ''}`} role="button" tabIndex={0} aria-label={`${entityById.get(relation.sourceId)?.name} ${labelText} ${entityById.get(relation.targetId)?.name}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSelectRelation(relation.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRelation(relation.id); } }}>
            <title>{`${entityById.get(relation.sourceId)?.name} → ${labelText} → ${entityById.get(relation.targetId)?.name}`}</title>
            <path className="rw-edge-hit" d={`M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`} />
            <path className="rw-edge-line" d={`M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`} markerEnd={active ? 'url(#rw-arrow-active)' : 'url(#rw-arrow)'} />
            <g transform={`translate(${label.x} ${label.y})`} className="rw-edge-label"><rect x={-Math.min(110, labelText.length * 6.2 + 9)} y="-11" width={Math.min(220, labelText.length * 12.4 + 18)} height="22" rx="5" /><text textAnchor="middle" dominantBaseline="central">{labelText.length > 16 ? `${labelText.slice(0, 15)}…` : labelText}</text></g>
          </g>;
        })}
        {depthOrderedEntities.map((entity) => {
          const position = positions.get(entity.id);
          if (!position) return null;
          const isFocus = entity.id === focusId;
          const active = entity.id === selectedId;
          const dimmed = selectedId !== focusId && !active && !adjacency.has(entity.id);
          return <g key={entity.id} transform={`translate(${position.x} ${position.y}) scale(${position.scale})`} className={`rw-node rw-node-${entity.kind} ${isFocus ? 'is-focus' : ''} ${active ? 'is-active' : ''} ${dimmed ? 'is-dimmed' : ''}`} tabIndex={0} role="button" aria-label={`查看${entity.name}的关系`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSelect(entity.id)} onDoubleClick={() => { onFocus(entity.id); resetView(); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(entity.id); } }}>
            {isFocus ? <><circle className="rw-focus-halo" r="75" /><circle className="rw-node-shape" r="59" /><text className="rw-focus-kicker" y="-17" textAnchor="middle">当前客户</text><text className="rw-focus-name" y="8" textAnchor="middle">{entity.name.length > 8 ? `${entity.name.slice(0, 7)}…` : entity.name}</text><text className="rw-focus-kind" y="30" textAnchor="middle">{entity.category ?? (entity.kind === 'organization' ? '企业' : entity.kind === 'person' ? '个人' : '项目')}</text></>
              : <>{entity.kind === 'person' ? <><circle className="rw-node-shape" r="27" /><text className="rw-node-initial" y="1" textAnchor="middle" dominantBaseline="central">{entity.name.slice(-2)}</text></> : entity.kind === 'project' ? <><path className="rw-node-shape" d="M 0 -34 L 37 0 L 0 34 L -37 0 Z" /><path className="rw-node-icon" d="M -9 -10 H 9 V 10 H -9 Z M -5 -4 H 5 M -5 2 H 5" /></> : <><rect className="rw-node-shape" x="-44" y="-27" width="88" height="54" rx="13" /><path className="rw-node-icon" d="M -11 12 V -12 H 6 V 12 M 6 -3 H 13 V 12 M -16 12 H 17 M -6 -7 H 0 M -6 -1 H 0 M -6 5 H 0" /></>}
                <rect className="rw-node-text-bg" x={-Math.min(95, entity.name.length * 7.3 + 6)} y="35" width={Math.min(190, entity.name.length * 14.6 + 12)} height="23" rx="4" /><text className="rw-node-name" y="51" textAnchor="middle">{entity.name.length > 12 ? `${entity.name.slice(0, 11)}…` : entity.name}</text><text className="rw-node-category" y="69" textAnchor="middle">{entity.category ?? (entity.kind === 'person' ? '个人' : entity.kind === 'organization' ? '企业' : '项目')}</text></>}
          </g>;
        })}
      </g>
    </svg>
    <div className="rw-map-bottom"><div className="rw-map-legend"><span><i className="person" />个人</span><span><i className="organization" />机构</span><span><i className="project" />项目</span><span className="rw-line-legend"><i />有明确记录</span><span className="rw-line-legend uncertain"><i />待确认 / 分歧</span></div><div className="rw-map-controls">{mode === '3d' && <div className="rw-gesture" role="group" aria-label="3D拖动方式"><button aria-pressed={gesture === 'rotate'} onClick={() => setGesture('rotate')}>旋转</button><button aria-pressed={gesture === 'pan'} onClick={() => setGesture('pan')}>平移</button></div>}<div className="rw-zoom"><button title="缩小" aria-label="缩小图谱" onClick={() => zoom(0.85)}>−</button><span>{Math.round(view.scale * 100)}%</span><button title="放大" aria-label="放大图谱" onClick={() => zoom(1.15)}>+</button><button title="重置视图" aria-label="重置视图" onClick={resetView}>⌖</button></div></div></div>
  </div>;
}
