import type { SketchDocument } from './sketch';
import type { Constraint, EntityRef } from './types';

export interface SolveResult {
  iterations: number;
  error: number;      // maior resíduo absoluto (em unidades do mundo)
  converged: boolean;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

function lineDirection(doc: SketchDocument, ref: EntityRef) {
  if (ref.kind !== 'line') return undefined;
  const l = doc.lines.get(ref.id);
  if (!l) return undefined;
  const a = doc.point(l.a);
  const b = doc.point(l.b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return undefined;
  return { a, dx, dy, len, ux: dx / len, uy: dy / len };
}

/**
 * Resíduos de uma restrição: 0 significa satisfeita.
 * Uma restrição pode gerar mais de uma equação — uma cota de raio num arco,
 * por exemplo, força os dois extremos a ficarem sobre a mesma circunferência.
 */
/** Ângulo interno (0–180°) entre os raios V→A e V→B, em radianos. */
export function internalAngle(doc: SketchDocument, a: number, vertex: number, b: number): number {
  const V = doc.point(vertex);
  const A = doc.point(a);
  const B = doc.point(b);
  const ux = A.x - V.x;
  const uy = A.y - V.y;
  const vx = B.x - V.x;
  const vy = B.y - V.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return Math.acos(cos);
}

function residuals(c: Constraint, doc: SketchDocument): number[] {
  switch (c.type) {
    case 'distance': {
      const a = doc.point(c.a);
      const b = doc.point(c.b);
      return [dist(a.x, a.y, b.x, b.y) - c.value];
    }
    case 'horizontal': {
      const l = doc.lines.get(c.line);
      return l ? [doc.point(l.b).y - doc.point(l.a).y] : [];
    }
    case 'vertical': {
      const l = doc.lines.get(c.line);
      return l ? [doc.point(l.b).x - doc.point(l.a).x] : [];
    }
    case 'tangent': {
      const { a: ra, b: rb, mode } = c;
      if (ra.kind === rb.kind && ra.id === rb.id) return [];
      if (!doc.entityExists(ra) || !doc.entityExists(rb)) return [];

      const lineA = ra.kind === 'line' ? doc.lines.get(ra.id) : undefined;
      const lineB = rb.kind === 'line' ? doc.lines.get(rb.id) : undefined;
      const centerA = doc.entityCenter(ra);
      const centerB = doc.entityCenter(rb);
      const radiusA = doc.entityRadius(ra);
      const radiusB = doc.entityRadius(rb);

      // Linha–linha: retas infinitas são tangentes quando paralelas.
      if (lineA && lineB) {
        const p1 = doc.point(lineA.a);
        const q1 = doc.point(lineA.b);
        const p2 = doc.point(lineB.a);
        const q2 = doc.point(lineB.b);
        const dx1 = q1.x - p1.x;
        const dy1 = q1.y - p1.y;
        const dx2 = q2.x - p2.x;
        const dy2 = q2.y - p2.y;
        const n1 = Math.hypot(dx1, dy1);
        const n2 = Math.hypot(dx2, dy2);
        if (n1 < 1e-9 || n2 < 1e-9) return [];
        return [(dx1 * dy2 - dy1 * dx2) / (n1 * n2)];
      }

      // Linha–curva: a distância do centro da curva à reta deve ser o raio.
      if ((lineA && centerB && radiusB !== undefined) || (lineB && centerA && radiusA !== undefined)) {
        const line = lineA ?? lineB!;
        const center = (lineA ? centerB : centerA)!;
        const radius = (lineA ? radiusB : radiusA)!;
        const p = doc.point(line.a);
        const q = doc.point(line.b);
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return [];
        const signed = (dx * (center.y - p.y) - dy * (center.x - p.x)) / len;
        return [Math.abs(signed) - radius];
      }

      // Curva–curva: centros separados pela soma (externa) ou diferença (interna) dos raios.
      if (centerA && centerB && radiusA !== undefined && radiusB !== undefined) {
        const d = dist(centerA.x, centerA.y, centerB.x, centerB.y);
        const target = mode === 'external' ? radiusA + radiusB : Math.abs(radiusA - radiusB);
        return [d - target];
      }
      return [];
    }
    case 'perpendicular': {
      const u = lineDirection(doc, c.a);
      const v = lineDirection(doc, c.b);
      if (u && v) return [u.ux * v.ux + u.uy * v.uy];
      // Linha perpendicular a uma curva: a reta passa pelo centro da curva.
      const lineRef = u ? c.a : v ? c.b : undefined;
      const curveRef = u ? c.b : c.a;
      const d = lineRef ? lineDirection(doc, lineRef) : undefined;
      const center = doc.entityCenter(curveRef);
      if (d && center) return [d.ux * (center.y - d.a.y) - d.uy * (center.x - d.a.x)];
      return [];
    }
    case 'angle': {
      const u = lineDirection(doc, c.a);
      const v = lineDirection(doc, c.b);
      if (!u || !v) return [];
      const cross = u.ux * v.uy - u.uy * v.ux;
      const dot = u.ux * v.ux + u.uy * v.uy;
      let r = Math.atan2(cross, dot) - c.value * Math.PI / 180;
      while (r > Math.PI) r -= Math.PI * 2;
      while (r < -Math.PI) r += Math.PI * 2;
      return [r];
    }
    case 'angle3': {
      if (!doc.points.has(c.a) || !doc.points.has(c.vertex) || !doc.points.has(c.b)) return [];
      return [internalAngle(doc, c.a, c.vertex, c.b) - c.value * Math.PI / 180];
    }
    case 'symmetry': {
      const line = doc.lines.get(c.axis.id);
      if (!line || !doc.points.has(c.a) || !doc.points.has(c.b)) return [];
      const A = doc.point(c.a);
      const B = doc.point(c.b);
      const P = doc.point(line.a);
      const Q = doc.point(line.b);
      const dx = Q.x - P.x;
      const dy = Q.y - P.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return [];
      const ux = dx / len;
      const uy = dy / len;
      const signedA = ux * (A.y - P.y) - uy * (A.x - P.x);
      const signedB = ux * (B.y - P.y) - uy * (B.x - P.x);
      const along = (B.x - A.x) * ux + (B.y - A.y) * uy;
      return [signedA + signedB, along];
    }
    case 'radius':
    case 'diameter': {
      const target = c.type === 'radius' ? c.value : c.value / 2;
      const circle = doc.circles.get(c.entity);
      if (circle) {
        const o = doc.point(circle.center);
        const r = doc.point(circle.rim);
        return [dist(o.x, o.y, r.x, r.y) - target];
      }
      const arc = doc.arcs.get(c.entity);
      if (arc) {
        const o = doc.point(arc.center);
        const a = doc.point(arc.a);
        const b = doc.point(arc.b);
        return [
          dist(o.x, o.y, a.x, a.y) - target,
          dist(o.x, o.y, b.x, b.y) - target,
        ];
      }
      return [];
    }
  }
}

/**
 * Solver de restrições por Gauss-Newton amortecido (Levenberg-Marquardt).
 *
 * Para cada iteração montamos o vetor de resíduos F e a matriz Jacobiana J
 * (derivadas numéricas), depois resolvemos:
 *
 *     (JᵀJ + λI) · Δx = -JᵀF
 *
 * O termo λI regulariza sistemas subdeterminados: direções sem restrição
 * recebem Δx ≈ 0, então os pontos se movem o mínimo necessário — exatamente
 * o comportamento esperado num sketcher paramétrico.
 */
export function solve(doc: SketchDocument, maxIterations = 100, tolerance = 1e-6): SolveResult {
  const free = [...doc.points.values()].filter((p) => !p.fixed);
  const active = [...doc.constraints.values()].filter((c) => {
    if (c.type === 'distance') return true;
    if (c.type === 'horizontal' || c.type === 'vertical') return doc.lines.has(c.line);
    if (c.type === 'tangent' || c.type === 'perpendicular' || c.type === 'angle') {
      return doc.entityExists(c.a) && doc.entityExists(c.b);
    }
    if (c.type === 'symmetry') return doc.lines.has(c.axis.id) && doc.points.has(c.a) && doc.points.has(c.b);
    if (c.type === 'angle3') return doc.points.has(c.a) && doc.points.has(c.vertex) && doc.points.has(c.b);
    return doc.circles.has(c.entity) || doc.arcs.has(c.entity);
  });

  const n = free.length * 2; // x,y por ponto livre
  let groups = active.map((c) => residuals(c, doc));
  let m = groups.reduce((sum, g) => sum + g.length, 0);
  if (n === 0 || m === 0) return { iterations: 0, error: 0, converged: true };

  let F = new Float64Array(m);
  const Fp = new Float64Array(m);
  let J = new Float64Array(m * n);
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  const delta = new Float64Array(n);

  const lambda = 1e-3;
  const eps = 1e-6;
  let iterations = 0;
  let error = Infinity;
  let converged = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;

    groups = active.map((c) => residuals(c, doc));
    m = groups.reduce((sum, g) => sum + g.length, 0);
    if (m !== F.length) {
      F = new Float64Array(m);
      J = new Float64Array(m * n);
    }
    let k = 0;
    for (const g of groups) for (const r of g) F[k++] = r;

    error = 0;
    for (let i = 0; i < m; i++) error = Math.max(error, Math.abs(F[i]));
    if (error < tolerance) {
      converged = true;
      break;
    }

    // Jacobiana por diferenças finais (genérica para qualquer restrição).
    for (let j = 0; j < n; j++) {
      const p = free[j >> 1];
      const isX = (j & 1) === 0;
      const original = isX ? p.x : p.y;
      if (isX) p.x += eps;
      else p.y += eps;
      let idx = 0;
      for (const c of active) {
        for (const r of residuals(c, doc)) Fp[idx++] = r;
      }
      if (isX) p.x = original;
      else p.y = original;
      for (let i = 0; i < m; i++) J[i * n + j] = (Fp[i] - F[i]) / eps;
    }

    // A = JᵀJ + λI ; b = -JᵀF
    for (let j = 0; j < n; j++) {
      for (let l = 0; l < n; l++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += J[i * n + j] * J[i * n + l];
        A[j * n + l] = sum + (j === l ? lambda : 0);
      }
      let sum = 0;
      for (let i = 0; i < m; i++) sum += J[i * n + j] * F[i];
      b[j] = -sum;
    }

    solveLinear(A, b, delta, n);

    for (let j = 0; j < n; j++) {
      const step = Math.max(-1e4, Math.min(1e4, delta[j]));
      const p = free[j >> 1];
      if ((j & 1) === 0) p.x += step;
      else p.y += step;
    }
  }

  error = 0;
  for (const g of active.map((c) => residuals(c, doc))) {
    for (const r of g) error = Math.max(error, Math.abs(r));
  }
  if (error < tolerance) converged = true;
  return { iterations, error, converged };
}

/** Eliminação Gaussiana com pivotação parcial: resolve A·x = b. */
function solveLinear(A: Float64Array, b: Float64Array, out: Float64Array, n: number): void {
  const w = n + 1;
  const M = new Float64Array(n * w);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * w + j] = A[i * n + j];
    M[i * w + n] = b[i];
  }

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r * w + col]) > Math.abs(M[pivot * w + col])) pivot = r;
    }
    if (Math.abs(M[pivot * w + col]) < 1e-12) continue;
    if (pivot !== col) {
      for (let c = col; c <= n; c++) {
        const tmp = M[col * w + c];
        M[col * w + c] = M[pivot * w + c];
        M[pivot * w + c] = tmp;
      }
    }
    const pv = M[col * w + col];
    for (let c = col; c <= n; c++) M[col * w + c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * w + col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r * w + c] -= f * M[col * w + c];
    }
  }

  for (let i = 0; i < n; i++) out[i] = M[i * w + n];
}
