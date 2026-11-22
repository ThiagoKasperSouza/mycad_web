import type { SketchDocument } from './sketch';
import type { Constraint, EntityRef } from './types';

const TAU = Math.PI * 2;
const EPS = 1e-7;

export interface Pt { x: number; y: number; }

export function sameRef(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function add(a: Pt, b: Pt): Pt { return { x: a.x + b.x, y: a.y + b.y }; }
function sub(a: Pt, b: Pt): Pt { return { x: a.x - b.x, y: a.y - b.y }; }
function mul(a: Pt, k: number): Pt { return { x: a.x * k, y: a.y * k }; }
function len(a: Pt): number { return Math.hypot(a.x, a.y); }
function dot(a: Pt, b: Pt): number { return a.x * b.x + a.y * b.y; }

function normalizeAngle(a: number): number {
  let r = a % TAU;
  if (r < 0) r += TAU;
  return r;
}

interface ArcInfo { center: Pt; r: number; start: number; sweep: number; ccw: boolean; }

function arcInfo(doc: SketchDocument, id: number): ArcInfo {
  const arc = doc.arcs.get(id)!;
  const centerPt = doc.point(arc.center);
  const startPt = doc.point(arc.a);
  const endPt = doc.point(arc.b);
  const center = { x: centerPt.x, y: centerPt.y };
  const start = Math.atan2(startPt.y - center.y, startPt.x - center.x);
  const end = Math.atan2(endPt.y - center.y, endPt.x - center.x);
  let sweep = end - start;
  if (arc.ccw) {
    while (sweep < 0) sweep += TAU;
  } else {
    while (sweep > 0) sweep -= TAU;
  }
  return { center, r: Math.hypot(startPt.x - center.x, startPt.y - center.y), start, sweep, ccw: arc.ccw };
}

interface EntityInfo {
  paramAt(p: Pt): number | undefined;
  pointAt(param: number): Pt;
  min: number;
  max: number;
  closed: boolean;
}

/** Parâmetro normalizado de cada entidade: t em [0,1] para retas, ângulo para curvas. */
export function entityInfo(doc: SketchDocument, ref: EntityRef): EntityInfo {
  if (ref.kind === 'line') {
    const line = doc.lines.get(ref.id)!;
    const a = doc.point(line.a);
    const b = doc.point(line.b);
    const d = sub({ x: b.x, y: b.y }, { x: a.x, y: a.y });
    const l2 = dot(d, d);
    return {
      min: 0,
      max: 1,
      closed: false,
      paramAt: (p) => {
        if (l2 < EPS) return 0;
        const t = dot(sub(p, { x: a.x, y: a.y }), d) / l2;
        return t < -EPS || t > 1 + EPS ? undefined : Math.max(0, Math.min(1, t));
      },
      pointAt: (t) => add({ x: a.x, y: a.y }, mul(d, t)),
    };
  }

  if (ref.kind === 'circle') {
    const c = doc.circles.get(ref.id)!;
    const o = doc.point(c.center);
    const r = doc.circleRadius(c);
    const center = { x: o.x, y: o.y };
    return {
      min: 0,
      max: TAU,
      closed: true,
      paramAt: (p) => normalizeAngle(Math.atan2(p.y - center.y, p.x - center.x)),
      pointAt: (t) => ({ x: center.x + Math.cos(t) * r, y: center.y + Math.sin(t) * r }),
    };
  }

  const info = arcInfo(doc, ref.id);
  return {
    min: 0,
    max: Math.abs(info.sweep),
    closed: false,
    paramAt: (p) => {
      const theta = Math.atan2(p.y - info.center.y, p.x - info.center.x);
      let delta = theta - info.start;
      if (info.ccw) {
        while (delta < 0) delta += TAU;
        if (delta > info.sweep + EPS) return undefined;
      } else {
        while (delta > 0) delta -= TAU;
        if (delta < info.sweep - EPS) return undefined;
      }
      return Math.max(0, Math.min(Math.abs(info.sweep), Math.abs(delta)));
    },
    pointAt: (t) => {
      const theta = info.start + (info.ccw ? 1 : -1) * t;
      return {
        x: info.center.x + Math.cos(theta) * info.r,
        y: info.center.y + Math.sin(theta) * info.r,
      };
    },
  };
}

function lineCircle(doc: SketchDocument, lineId: number, center: Pt, r: number): Pt[] {
  const line = doc.lines.get(lineId)!;
  const a = doc.point(line.a);
  const b = doc.point(line.b);
  const d = sub({ x: b.x, y: b.y }, { x: a.x, y: a.y });
  const f = sub({ x: a.x, y: a.y }, center);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  const out: Pt[] = [];
  for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
    if (t >= -EPS && t <= 1 + EPS) out.push(add({ x: a.x, y: a.y }, mul(d, Math.max(0, Math.min(1, t)))));
  }
  return out;
}

function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const dVec = sub(c2, c1);
  const d = len(dVec);
  if (d < EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const base = add(c1, mul(dVec, a / d));
  if (h2 < -EPS) return [];
  if (h2 <= EPS) return [base];
  const h = Math.sqrt(h2);
  const perp = { x: -dVec.y / d, y: dVec.x / d };
  return [add(base, mul(perp, h)), sub(base, mul(perp, h))];
}

function centerRadius(doc: SketchDocument, ref: EntityRef): { center: Pt; r: number } | undefined {
  if (ref.kind === 'line') return undefined;
  const center = doc.entityCenter(ref);
  const r = doc.entityRadius(ref);
  if (!center || r === undefined) return undefined;
  return { center: { x: center.x, y: center.y }, r };
}

function onArc(doc: SketchDocument, arcId: number, p: Pt): boolean {
  return entityInfo(doc, { kind: 'arc', id: arcId }).paramAt(p) !== undefined;
}

/** Pontos de interseção entre duas entidades (dentro dos trechos finitos). */
export function intersect(doc: SketchDocument, a: EntityRef, b: EntityRef): Pt[] {
  if (sameRef(a, b)) return [];

  let pts: Pt[] = [];
  if (a.kind === 'line' && b.kind === 'line') {
    const la = doc.lines.get(a.id)!;
    const lb = doc.lines.get(b.id)!;
    const p = doc.point(la.a);
    const p2 = doc.point(la.b);
    const q = doc.point(lb.a);
    const q2 = doc.point(lb.b);
    const r = sub({ x: p2.x, y: p2.y }, { x: p.x, y: p.y });
    const s = sub({ x: q2.x, y: q2.y }, { x: q.x, y: q.y });
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) > EPS) {
      const qp = sub({ x: q.x, y: q.y }, { x: p.x, y: p.y });
      const t = (qp.x * s.y - qp.y * s.x) / den;
      const u = (qp.x * r.y - qp.y * r.x) / den;
      if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
        pts = [add({ x: p.x, y: p.y }, mul(r, t))];
      }
    }
  } else if (a.kind === 'line' || b.kind === 'line') {
    const line = a.kind === 'line' ? a : b;
    const curve = a.kind === 'line' ? b : a;
    const cr = centerRadius(doc, curve);
    if (cr) pts = lineCircle(doc, line.id, cr.center, cr.r);
  } else {
    const ca = centerRadius(doc, a)!;
    const cb = centerRadius(doc, b)!;
    pts = circleCircle(ca.center, ca.r, cb.center, cb.r);
  }

  if (a.kind === 'arc') pts = pts.filter((p) => onArc(doc, a.id, p));
  if (b.kind === 'arc') pts = pts.filter((p) => onArc(doc, b.id, p));

  // dedupe
  const out: Pt[] = [];
  for (const p of pts) {
    if (!out.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-5)) out.push(p);
  }
  return out;
}

/** Todas as interseções de uma entidade com as demais. */
export function allIntersections(doc: SketchDocument, ref: EntityRef): Pt[] {
  const others: EntityRef[] = [
    ...[...doc.lines.keys()].map((id) => ({ kind: 'line' as const, id })),
    ...[...doc.circles.keys()].map((id) => ({ kind: 'circle' as const, id })),
    ...[...doc.arcs.keys()].map((id) => ({ kind: 'arc' as const, id })),
  ];
  const pts: Pt[] = [];
  for (const other of others) {
    if (sameRef(other, ref)) continue;
    for (const p of intersect(doc, ref, other)) {
      if (!pts.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-5)) pts.push(p);
    }
  }
  return pts;
}

export interface Interval { from: number; to: number; }

/** Trecho entre interseções consecutivas que contém o parâmetro clicado. */
export function trimInterval(doc: SketchDocument, ref: EntityRef, param: number): Interval | undefined {
  const info = entityInfo(doc, ref);
  const cuts = allIntersections(doc, ref)
    .map((p) => info.paramAt(p))
    .filter((v): v is number => v !== undefined);
  if (cuts.length === 0) return undefined;

  const sorted = [...new Set(cuts.map((v) => Math.round(v / EPS) * EPS))].sort((a, b) => a - b);

  if (info.closed) {
    const bounds = [...sorted, sorted[0] + TAU];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i];
      const to = bounds[i + 1];
      if (param >= from - EPS && param <= to + EPS) return { from, to };
    }
    return undefined;
  }

  const bounds = [info.min, ...sorted.filter((v) => v > info.min + EPS && v < info.max - EPS), info.max];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (param >= bounds[i] - EPS && param <= bounds[i + 1] + EPS) return { from: bounds[i], to: bounds[i + 1] };
  }
  return undefined;
}

function pointIdAt(doc: SketchDocument, ref: EntityRef, param: number, info: EntityInfo): number {
  if (ref.kind === 'line') {
    const l = doc.lines.get(ref.id)!;
    if (Math.abs(param - info.min) < EPS) return l.a;
    if (Math.abs(param - info.max) < EPS) return l.b;
  } else if (ref.kind === 'arc') {
    const arc = doc.arcs.get(ref.id)!;
    if (Math.abs(param - info.min) < EPS) return arc.a;
    if (Math.abs(param - info.max) < EPS) return arc.b;
  }
  const p = info.pointAt(param);
  return doc.addPoint(p.x, p.y).id;
}

function refMatchesEntity(c: Constraint, ref: EntityRef): boolean {
  if (c.type === 'horizontal' || c.type === 'vertical') return ref.kind === 'line' && c.line === ref.id;
  if (c.type === 'tangent' || c.type === 'perpendicular' || c.type === 'angle') {
    return sameRef(c.a, ref) || sameRef(c.b, ref);
  }
  if (c.type === 'radius' || c.type === 'diameter') return c.entity === ref.id;
  return false;
}

function replaceRef(c: Constraint, from: EntityRef, to: EntityRef): Constraint | undefined {
  if (c.type === 'horizontal' || c.type === 'vertical') {
    return to.kind === 'line' ? { ...c, line: to.id } : undefined;
  }
  if (c.type === 'tangent' || c.type === 'perpendicular' || c.type === 'angle') {
    return {
      ...c,
      a: sameRef(c.a, from) ? to : c.a,
      b: sameRef(c.b, from) ? to : c.b,
    };
  }
  if (c.type === 'radius' || c.type === 'diameter') {
    return (to.kind === 'circle' || to.kind === 'arc') ? { ...c, entity: to.id } : undefined;
  }
  return undefined;
}

function pieceLength(doc: SketchDocument, ref: EntityRef): number {
  if (ref.kind === 'line') {
    const l = doc.lines.get(ref.id)!;
    const a = doc.point(l.a);
    const b = doc.point(l.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  const info = entityInfo(doc, ref);
  const r = doc.entityRadius(ref) ?? 0;
  return (info.max - info.min) * r;
}

/**
 * Recorta o trecho clicado de `ref`, preservando o restante como novas entidades.
 * Restrições da entidade original são transferidas para o fragmento mais longo.
 */
export function trim(doc: SketchDocument, ref: EntityRef, param: number): EntityRef[] {
  const info = entityInfo(doc, ref);
  const interval = trimInterval(doc, ref, param);
  if (!interval) return [];
  // Um único corte numa curva fechada não define trecho a remover.
  if (info.closed && interval.to - interval.from >= TAU - EPS) return [];

  // Fragmentos que sobram: [min, from] e [to, max]; círculo é fechado e vira um arco.
  let ranges: Array<[number, number]>;
  if (info.closed) {
    ranges = [[interval.to, interval.from + TAU]];
  } else {
    ranges = [];
    if (interval.from > info.min + EPS) ranges.push([info.min, interval.from]);
    if (interval.to < info.max - EPS) ranges.push([interval.to, info.max]);
  }
  if (ranges.length === 0) return [];

  const related = [...doc.constraints.values()].filter((c) => refMatchesEntity(c, ref));
  const created: EntityRef[] = [];

  for (const [from, to] of ranges) {
    if (ref.kind === 'line') {
      const a = pointIdAt(doc, ref, from, info);
      const b = pointIdAt(doc, ref, to, info);
      if (a === b) continue;
      created.push({ kind: 'line', id: doc.addLine(a, b).id });
    } else {
      const a = pointIdAt(doc, ref, from, info);
      const b = pointIdAt(doc, ref, to, info);
      if (a === b) continue;
      const center = ref.kind === 'circle' ? doc.circles.get(ref.id)!.center : doc.arcs.get(ref.id)!.center;
      const ccw = ref.kind === 'circle' ? true : doc.arcs.get(ref.id)!.ccw;
      created.push({ kind: 'arc', id: doc.addArc(center, a, b, ccw).id });
    }
  }
  if (created.length === 0) return [];

  // Remove a entidade original (e suas restrições) e recria as compatíveis no fragmento principal.
  if (ref.kind === 'line') doc.removeLine(ref.id);
  else doc.removeEntity(ref.kind, ref.id);

  const target = created.reduce((best, cur) => pieceLength(doc, cur) > pieceLength(doc, best) ? cur : best, created[0]);
  for (const c of related) {
    const moved = replaceRef(c, ref, target);
    if (moved) doc.addConstraint(moved);
  }

  return created;
}
