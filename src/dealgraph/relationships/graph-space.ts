export interface SpacePoint { x: number; y: number; z: number }
export interface Camera { yaw: number; pitch: number }
export const INITIAL_CAMERA: Camera = { yaw: -0.28, pitch: 0.2 };

/** Stable depth keeps node identity and the 2D neighbourhood layout across view changes. */
export function nodeDepth(id: string, focusId: string): number {
  if (id === focusId) return 0;
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 1001 / 1000 - 0.5) * 400;
}

export function projectPoint(point: SpacePoint, camera: Camera) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const yawZ = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - yawZ * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + yawZ * Math.cos(camera.pitch);
  const scale = 1400 / Math.max(700, 1400 - z);
  return { x: 560 + x * scale, y: 390 + y * scale, z, scale };
}

export function orbitCamera(camera: Camera, dx: number, dy: number): Camera {
  return { yaw: camera.yaw + dx * 0.005, pitch: Math.max(-1.25, Math.min(1.25, camera.pitch + dy * 0.005)) };
}

export function orbitPath(camera: Camera, radius: number, plane: 'horizontal' | 'vertical') {
  return Array.from({ length: 81 }, (_, index) => {
    const angle = index / 80 * Math.PI * 2;
    const point = projectPoint({ x: Math.cos(angle) * radius, y: plane === 'vertical' ? Math.sin(angle) * radius * 0.7 : 0, z: plane === 'horizontal' ? Math.sin(angle) * radius : 0 }, camera);
    return `${index ? 'L' : 'M'} ${point.x} ${point.y}`;
  }).join(' ') + ' Z';
}
