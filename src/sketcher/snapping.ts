import type { SketchDocument } from '../core/sketch';

/** View: transformação mundo → tela (eixo Y apontando para cima). */
export interface View {
  offsetX: number;
  offsetY: number;
  scale: number; // pixels por unidade do mundo
}

export interface Vec2 { x: number; y: number; }

export type Inference = 'horizontal' | 'vertical';

export interface SnapResult {
  x: number;
  y: number;
  pointId?: number;   // snap em ponto existente (coincidência)
  inference?: Inference; // inferência H/V em relação ao ponto de referência
}

export function worldToScreen(x: number, y: number, v: View): Vec2 {
  return { x: x * v.scale + v.offsetX, y: v.offsetY - y * v.scale };
}

export function screenToWorld(sx: number, sy: number, v: View): Vec2 {
  return { x: (sx - v.offsetX) / v.scale, y: (v.offsetY - sy) / v.scale };
}

export interface SnapOptions {
  reference?: Vec2;   // ponto de origem da operação (para inferência H/V)
  skipPointId?: number;
  grid: number;
  radiusPx: number;
}

/**
 * Prioridade do snap: ponto existente > inferência horizontal/vertical > grade.
 * O raio é informado em pixels e convertido para unidades do mundo.
 */
export function snap(
  doc: SketchDocument,
  wx: number,
  wy: number,
  view: View,
  opts: SnapOptions,
): SnapResult {
  const tol = opts.radiusPx / view.scale;

  let bestId: number | undefined;
  let bestDist = tol;
  for (const p of doc.points.values()) {
    if (p.id === opts.skipPointId) continue;
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < bestDist) {
      bestDist = d;
      bestId = p.id;
    }
  }
  if (bestId !== undefined) {
    const p = doc.point(bestId);
    // Mesmo ao fechar num ponto existente, ainda faz sentido inferir H/V.
    let inference: Inference | undefined;
    if (opts.reference) {
      if (Math.abs(p.y - opts.reference.y) <= tol) inference = 'horizontal';
      else if (Math.abs(p.x - opts.reference.x) <= tol) inference = 'vertical';
    }
    return { x: p.x, y: p.y, pointId: bestId, inference };
  }

  if (opts.reference) {
    if (Math.abs(wy - opts.reference.y) <= tol) {
      return { x: wx, y: opts.reference.y, inference: 'horizontal' };
    }
    if (Math.abs(wx - opts.reference.x) <= tol) {
      return { x: opts.reference.x, y: wy, inference: 'vertical' };
    }
  }

  const g = opts.grid;
  return { x: Math.round(wx / g) * g, y: Math.round(wy / g) * g };
}
