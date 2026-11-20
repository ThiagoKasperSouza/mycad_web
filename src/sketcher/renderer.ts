import type { SketchDocument } from '../core/sketch';
import type { ArcEntity, Constraint, CurveKind, EntityKind, EntityRef } from '../core/types';
import { screenToWorld, worldToScreen, type SnapResult, type Vec2, type View } from './snapping';

export interface Selection {
  points: Set<number>;
  lines: Set<number>;
  curves: Set<number>;
  constraints: Set<number>;
}

export interface Preview {
  kind: 'point' | 'line' | 'circle' | 'arc';
  x: number;          // mundo: ponto atual do cursor (já com snap)
  y: number;
  start?: Vec2;       // mundo: início da operação (linha / centro)
  second?: Vec2;      // mundo: segundo ponto do arco
  ccw?: boolean;      // sentido do arco em prévia
  snap?: SnapResult;
}

export function formatNumber(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

interface Rect { x: number; y: number; w: number; h: number; }
interface DimLayout { a: Vec2; b: Vec2; p1: Vec2; p2: Vec2; mid: Vec2; text: string; rect: Rect; }

function dimensionLayout(a: Vec2, b: Vec2, value: number): DimLayout {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let nx = 0;
  let ny = -1;
  if (len > 1e-6) {
    nx = -dy / len;
    ny = dx / len;
    if (ny > 0) { nx = -nx; ny = -ny; }
  }
  const off = 26;
  const p1 = { x: a.x + nx * off, y: a.y + ny * off };
  const p2 = { x: b.x + nx * off, y: b.y + ny * off };
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const text = formatNumber(value);
  const w = Math.max(32, text.length * 8 + 16);
  const h = 20;
  return { a, b, p1, p2, mid, text, rect: { x: mid.x - w / 2, y: mid.y - h / 2, w, h } };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawText(ctx: CanvasRenderingContext2D, text: string, mid: Vec2, rect: Rect, color: string): void {
  ctx.fillStyle = '#0d1520';
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, mid.x, mid.y + 0.5);
}

function drawArrow(ctx: CanvasRenderingContext2D, tip: Vec2, dir: Vec2, size = 8): void {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const px = -uy;
  const py = ux;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - ux * size + px * size * 0.35, tip.y - uy * size + py * size * 0.35);
  ctx.lineTo(tip.x - ux * size - px * size * 0.35, tip.y - uy * size - py * size * 0.35);
  ctx.closePath();
  ctx.fill();
}

// ----- geometria de arcos (mundo, Y para cima) -----
const TAU = Math.PI * 2;

export function arcAngles(doc: SketchDocument, arc: ArcEntity): { a: number; b: number; r: number; sweep: number } {
  const o = doc.point(arc.center);
  const pa = doc.point(arc.a);
  const pb = doc.point(arc.b);
  const a = Math.atan2(pa.y - o.y, pa.x - o.x);
  const b = Math.atan2(pb.y - o.y, pb.x - o.x);
  let sweep = b - a;
  if (arc.ccw) {
    while (sweep < 0) sweep += TAU;
  } else {
    while (sweep > 0) sweep -= TAU;
  }
  return { a, b, r: doc.arcRadius(arc), sweep };
}

function arcMidWorld(doc: SketchDocument, arc: ArcEntity): Vec2 {
  const o = doc.point(arc.center);
  const { a, r, sweep } = arcAngles(doc, arc);
  const mid = a + sweep / 2;
  return { x: o.x + Math.cos(mid) * r, y: o.y + Math.sin(mid) * r };
}

/** Ponto na curva usado como âncora da cota de raio/diâmetro. */
function curveAnchor(doc: SketchDocument, entityId: number): { center: Vec2; rim: Vec2 } | undefined {
  const circle = doc.circles.get(entityId);
  if (circle) {
    const o = doc.point(circle.center);
    const r = doc.point(circle.rim);
    return { center: { x: o.x, y: o.y }, rim: { x: r.x, y: r.y } };
  }
  const arc = doc.arcs.get(entityId);
  if (arc) {
    const o = doc.point(arc.center);
    return { center: { x: o.x, y: o.y }, rim: arcMidWorld(doc, arc) };
  }
  return undefined;
}

/** Cota radial (raio ou diâmetro) desenhada sobre círculo/arco. */
function radialLayout(doc: SketchDocument, c: Extract<Constraint, { type: 'radius' | 'diameter' }>, view: View): DimLayout | undefined {
  const anchor = curveAnchor(doc, c.entity);
  if (!anchor) return undefined;
  const center = worldToScreen(anchor.center.x, anchor.center.y, view);
  const rim = worldToScreen(anchor.rim.x, anchor.rim.y, view);
  const p2 = rim;
  const p1 = c.type === 'diameter'
    ? { x: center.x * 2 - rim.x, y: center.y * 2 - rim.y }
    : center;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; }
  const mid = { x: (p1.x + p2.x) / 2 + nx * 16, y: (p1.y + p2.y) / 2 + ny * 16 };
  const text = (c.type === 'diameter' ? '⌀' : 'R') + formatNumber(c.value);
  const w = Math.max(38, text.length * 8 + 14);
  const h = 20;
  return { a: center, b: rim, p1, p2, mid, text, rect: { x: mid.x - w / 2, y: mid.y - h / 2, w, h } };
}

interface TangentLayout { badge: Vec2; contact?: Vec2; rect: Rect; text: string; }

function projectOnLine(doc: SketchDocument, lineId: number, p: Vec2): Vec2 {
  const a = doc.point(doc.lines.get(lineId)!.a);
  const b = doc.point(doc.lines.get(lineId)!.b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function lineMid(doc: SketchDocument, lineId: number): Vec2 {
  const l = doc.lines.get(lineId)!;
  const a = doc.point(l.a);
  const b = doc.point(l.b);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Glifo de tangência: badge perto do contato e marcador no ponto de toque. */
function tangentLayout(doc: SketchDocument, c: Extract<Constraint, { type: 'tangent' }>, view: View): TangentLayout | undefined {
  const lineA = c.a.kind === 'line' ? c.a.id : undefined;
  const lineB = c.b.kind === 'line' ? c.b.id : undefined;
  const centerA = doc.entityCenter(c.a);
  const centerB = doc.entityCenter(c.b);
  const rA = doc.entityRadius(c.a);
  const rB = doc.entityRadius(c.b);

  let anchorA: Vec2 | undefined;
  let anchorB: Vec2 | undefined;
  let contactWorld: Vec2 | undefined;

  if (lineA !== undefined && centerB && rB !== undefined) {
    contactWorld = projectOnLine(doc, lineA, { x: centerB.x, y: centerB.y });
    anchorA = contactWorld;
    anchorB = { x: centerB.x, y: centerB.y };
  } else if (lineB !== undefined && centerA && rA !== undefined) {
    contactWorld = projectOnLine(doc, lineB, { x: centerA.x, y: centerA.y });
    anchorA = contactWorld;
    anchorB = { x: centerA.x, y: centerA.y };
  } else if (centerA && centerB && rA !== undefined && rB !== undefined) {
    anchorA = { x: centerA.x, y: centerA.y };
    anchorB = { x: centerB.x, y: centerB.y };
    const d = Math.hypot(anchorB.x - anchorA.x, anchorB.y - anchorA.y);
    if (d > 1e-9) {
      const t = c.mode === 'external' ? rA / (rA + rB) : rA / Math.max(1e-9, Math.abs(rA - rB));
      contactWorld = {
        x: anchorA.x + (anchorB.x - anchorA.x) * t,
        y: anchorA.y + (anchorB.y - anchorA.y) * t,
      };
    }
  } else if (lineA !== undefined && lineB !== undefined) {
    anchorA = lineMid(doc, lineA);
    anchorB = lineMid(doc, lineB);
  }
  if (!anchorA || !anchorB) return undefined;

  const sa = worldToScreen(anchorA.x, anchorA.y, view);
  const sb = worldToScreen(anchorB.x, anchorB.y, view);
  const badge = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 - 14 };
  const text = c.mode === 'internal' ? 'tg int' : 'tg';
  const w = text.length * 7 + 14;
  const h = 18;
  return {
    badge,
    contact: contactWorld ? worldToScreen(contactWorld.x, contactWorld.y, view) : undefined,
    rect: { x: badge.x - w / 2, y: badge.y - h / 2, w, h },
    text,
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, view: View, width: number, height: number): void {
  let step = 10;
  while (step * view.scale < 14) step *= 5;

  const topLeft = screenToWorld(0, 0, view);
  const bottomRight = screenToWorld(width, height, view);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#171f2b';
  ctx.beginPath();
  for (let x = Math.ceil(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
    const sx = Math.round(worldToScreen(x, 0, view).x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  for (let y = Math.ceil(bottomRight.y / step) * step; y <= topLeft.y; y += step) {
    const sy = Math.round(worldToScreen(0, y, view).y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();

  const origin = worldToScreen(0, 0, view);
  ctx.strokeStyle = '#33455c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(origin.x) + 0.5, 0);
  ctx.lineTo(Math.round(origin.x) + 0.5, height);
  ctx.moveTo(0, Math.round(origin.y) + 0.5);
  ctx.lineTo(width, Math.round(origin.y) + 0.5);
  ctx.stroke();
}

function drawConstraint(ctx: CanvasRenderingContext2D, c: Constraint, doc: SketchDocument, view: View, selected: boolean): void {
  const color = selected ? '#ffcc66' : '#7fb2e8';

  if (c.type === 'radius' || c.type === 'diameter') {
    const L = radialLayout(doc, c, view);
    if (!L) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L.p1.x, L.p1.y);
    ctx.lineTo(L.p2.x, L.p2.y);
    ctx.stroke();
    drawArrow(ctx, L.p2, { x: L.p2.x - L.p1.x, y: L.p2.y - L.p1.y }, 7);
    drawText(ctx, L.text, L.mid, L.rect, color);
    return;
  }

  if (c.type !== 'distance') return;
  const a = doc.points.get(c.a);
  const b = doc.points.get(c.b);
  if (!a || !b) return;
  const sa = worldToScreen(a.x, a.y, view);
  const sb = worldToScreen(b.x, b.y, view);
  const L = dimensionLayout(sa, sb, c.value);
  const along = (p: Vec2, other: Vec2) => {
    const len = Math.hypot(p.x - other.x, p.y - other.y) || 1;
    return { x: (p.x - other.x) / len * 5, y: (p.y - other.y) / len * 5 };
  };

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  const e1 = along(L.p1, L.p2);
  const e2 = along(L.p2, L.p1);
  ctx.beginPath();
  ctx.moveTo(L.a.x, L.a.y);
  ctx.lineTo(L.p1.x + e1.x, L.p1.y + e1.y);
  ctx.moveTo(L.b.x, L.b.y);
  ctx.lineTo(L.p2.x + e2.x, L.p2.y + e2.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(L.p1.x, L.p1.y);
  ctx.lineTo(L.p2.x, L.p2.y);
  ctx.stroke();

  const dir = { x: L.p2.x - L.p1.x, y: L.p2.y - L.p1.y };
  drawArrow(ctx, L.p1, { x: -dir.x, y: -dir.y });
  drawArrow(ctx, L.p2, dir);
  drawText(ctx, L.text, L.mid, L.rect, color);
}

function drawInferenceBadge(ctx: CanvasRenderingContext2D, c: Constraint, doc: SketchDocument, view: View): void {
  if (c.type === 'distance' || c.type === 'radius' || c.type === 'diameter' || c.type === 'tangent') return;
  const l = doc.lines.get(c.line);
  if (!l) return;
  const a = doc.point(l.a);
  const b = doc.point(l.b);
  const mid = worldToScreen((a.x + b.x) / 2, (a.y + b.y) / 2, view);
  const letter = c.type === 'horizontal' ? 'H' : 'V';
  ctx.fillStyle = '#1d3a2b';
  ctx.strokeStyle = '#5fd38b';
  ctx.lineWidth = 1;
  roundRect(ctx, mid.x - 9, mid.y - 9, 18, 18, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#8ff0b3';
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, mid.x, mid.y + 0.5);
}

function drawTangentGlyph(ctx: CanvasRenderingContext2D, c: Constraint, doc: SketchDocument, view: View, selected: boolean): void {
  if (c.type !== 'tangent') return;
  const L = tangentLayout(doc, c, view);
  if (!L) return;
  const color = selected ? '#ffcc66' : '#6fd8c8';

  if (L.contact) {
    ctx.fillStyle = color;
    ctx.save();
    ctx.translate(L.contact.x, L.contact.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-3, -3, 6, 6);
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(L.badge.x, L.badge.y + 8);
    ctx.lineTo(L.contact.x, L.contact.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = '#0d1818';
  roundRect(ctx, L.rect.x, L.rect.y, L.rect.w, L.rect.h, 4);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(L.text, L.badge.x, L.badge.y + 0.5);
}

function drawCurves(ctx: CanvasRenderingContext2D, doc: SketchDocument, view: View, selection: Selection): void {
  for (const circle of doc.circles.values()) {
    const o = doc.point(circle.center);
    const s = worldToScreen(o.x, o.y, view);
    const selected = selection.curves.has(circle.id);
    ctx.strokeStyle = selected ? '#ffcc66' : '#a8bdd4';
    ctx.lineWidth = selected ? 2.6 : 1.8;
    ctx.beginPath();
    ctx.arc(s.x, s.y, doc.circleRadius(circle) * view.scale, 0, TAU);
    ctx.stroke();
  }

  for (const arc of doc.arcs.values()) {
    const o = doc.point(arc.center);
    const s = worldToScreen(o.x, o.y, view);
    const { a, b } = arcAngles(doc, arc);
    const selected = selection.curves.has(arc.id);
    ctx.strokeStyle = selected ? '#ffcc66' : '#a8bdd4';
    ctx.lineWidth = selected ? 2.6 : 1.8;
    ctx.beginPath();
    ctx.arc(s.x, s.y, doc.arcRadius(arc) * view.scale, -a, -b, arc.ccw);
    ctx.stroke();
  }
}

function drawPreview(ctx: CanvasRenderingContext2D, preview: Preview, view: View): void {
  const end = worldToScreen(preview.x, preview.y, view);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#4da3ff';
  ctx.fillStyle = '#4da3ff';

  if (preview.start) {
    const start = worldToScreen(preview.start.x, preview.start.y, view);

    if (preview.kind === 'line' && preview.snap?.inference) {
      ctx.strokeStyle = 'rgba(95, 211, 139, .55)';
      ctx.beginPath();
      if (preview.snap.inference === 'horizontal') {
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x + Math.sign(end.x - start.x) * 40, start.y);
      } else {
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(start.x, end.y + Math.sign(end.y - start.y) * 40);
      }
      ctx.stroke();
      ctx.strokeStyle = '#4da3ff';
    }

    if (preview.kind === 'circle') {
      const r = Math.hypot(preview.x - preview.start.x, preview.y - preview.start.y) * view.scale;
      ctx.beginPath();
      ctx.arc(start.x, start.y, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(start.x, start.y, 3, 0, TAU);
      ctx.fill();
    } else if (preview.kind === 'arc' && preview.second) {
      const a0 = Math.atan2(preview.second.y - preview.start.y, preview.second.x - preview.start.x);
      const a1 = Math.atan2(preview.y - preview.start.y, preview.x - preview.start.x);
      const r = Math.hypot(preview.second.x - preview.start.x, preview.second.y - preview.start.y) * view.scale;
      const second = worldToScreen(preview.second.x, preview.second.y, view);
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(second.x, second.y);
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(start.x, start.y, r, -a0, -a1, preview.ccw ?? true);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(start.x, start.y, 3, 0, TAU);
    ctx.fill();
  }

  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(end.x, end.y, 6, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D,
  doc: SketchDocument,
  view: View,
  width: number,
  height: number,
  selection: Selection,
  preview: Preview | null,
  hoverPointId?: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0f15';
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, view, width, height);

  // linhas e curvas
  ctx.lineCap = 'round';
  for (const l of doc.lines.values()) {
    const a = doc.point(l.a);
    const b = doc.point(l.b);
    const sa = worldToScreen(a.x, a.y, view);
    const sb = worldToScreen(b.x, b.y, view);
    const selected = selection.lines.has(l.id);
    ctx.strokeStyle = selected ? '#ffcc66' : '#a8bdd4';
    ctx.lineWidth = selected ? 3 : 1.8;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }
  drawCurves(ctx, doc, view, selection);

  // restrições
  for (const c of doc.constraints.values()) {
    drawConstraint(ctx, c, doc, view, selection.constraints.has(c.id));
    drawInferenceBadge(ctx, c, doc, view);
    drawTangentGlyph(ctx, c, doc, view, selection.constraints.has(c.id));
  }

  // pontos
  for (const p of doc.points.values()) {
    const s = worldToScreen(p.x, p.y, view);
    const selected = selection.points.has(p.id);
    const hovered = p.id === hoverPointId;
    const fill = selected ? '#ffcc66' : hovered ? '#ffffff' : p.fixed ? '#ff9f68' : '#d5e8fb';
    ctx.fillStyle = fill;
    ctx.strokeStyle = '#0b0f15';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (p.fixed) {
      ctx.rect(s.x - 4.5, s.y - 4.5, 9, 9);
    } else {
      ctx.arc(s.x, s.y, hovered ? 5.5 : 4, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    if (selected) {
      ctx.strokeStyle = '#ffcc66';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (preview) drawPreview(ctx, preview, view);
}

// ----- hit testing -----
export function hitTestPoint(doc: SketchDocument, wx: number, wy: number, tol: number): number | undefined {
  let best: number | undefined;
  let bestD = tol;
  for (const p of doc.points.values()) {
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < bestD) { bestD = d; best = p.id; }
  }
  return best;
}

export function hitTestLine(doc: SketchDocument, wx: number, wy: number, tol: number): number | undefined {
  let best: number | undefined;
  let bestD = tol;
  for (const l of doc.lines.values()) {
    const a = doc.point(l.a);
    const b = doc.point(l.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((wx - a.x) * dx + (wy - a.y) * dy) / len2));
    const d = Math.hypot(wx - (a.x + t * dx), wy - (a.y + t * dy));
    if (d < bestD) { bestD = d; best = l.id; }
  }
  return best;
}

/** Círculo ou arco cuja curva passa perto do ponto (mundo). */
export function hitTestCurve(doc: SketchDocument, wx: number, wy: number, tol: number): { kind: CurveKind; id: number } | undefined {
  for (const circle of doc.circles.values()) {
    const o = doc.point(circle.center);
    if (Math.abs(Math.hypot(wx - o.x, wy - o.y) - doc.circleRadius(circle)) <= tol) {
      return { kind: 'circle', id: circle.id };
    }
  }
  for (const arc of doc.arcs.values()) {
    const o = doc.point(arc.center);
    const d = Math.hypot(wx - o.x, wy - o.y);
    if (Math.abs(d - doc.arcRadius(arc)) > tol) continue;
    const { a, sweep, r } = arcAngles(doc, arc);
    if (r < 1e-9) continue;
    const theta = Math.atan2(wy - o.y, wx - o.x);
    let delta = theta - a;
    if (arc.ccw) {
      while (delta < 0) delta += TAU;
      if (delta <= sweep + 1e-6) return { kind: 'arc', id: arc.id };
    } else {
      while (delta > 0) delta -= TAU;
      if (delta >= sweep - 1e-6) return { kind: 'arc', id: arc.id };
    }
  }
  return undefined;
}

function distanceToLine(doc: SketchDocument, id: number, wx: number, wy: number): number {
  const l = doc.lines.get(id)!;
  const a = doc.point(l.a);
  const b = doc.point(l.b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((wx - a.x) * dx + (wy - a.y) * dy) / l2));
  return Math.hypot(wx - (a.x + t * dx), wy - (a.y + t * dy));
}

function distanceToCurve(doc: SketchDocument, curve: { kind: CurveKind; id: number }, wx: number, wy: number): number {
  if (curve.kind === 'circle') {
    const c = doc.circles.get(curve.id)!;
    const o = doc.point(c.center);
    return Math.abs(Math.hypot(wx - o.x, wy - o.y) - doc.circleRadius(c));
  }
  const arc = doc.arcs.get(curve.id)!;
  const o = doc.point(arc.center);
  const d = Math.hypot(wx - o.x, wy - o.y);
  const { a, sweep, r } = arcAngles(doc, arc);
  if (r < 1e-9) return Infinity;
  const theta = Math.atan2(wy - o.y, wx - o.x);
  let delta = theta - a;
  if (arc.ccw) {
    while (delta < 0) delta += TAU;
    if (delta > sweep + 1e-6) return Infinity;
  } else {
    while (delta > 0) delta -= TAU;
    if (delta < sweep - 1e-6) return Infinity;
  }
  return Math.abs(d - r);
}

/** Entidade (linha, círculo ou arco) mais próxima do cursor, dentro da tolerância. */
export function hitTestEntity(doc: SketchDocument, wx: number, wy: number, tol: number): EntityRef | undefined {
  let best: EntityRef | undefined;
  let bestD = tol;

  for (const id of doc.lines.keys()) {
    const d = distanceToLine(doc, id, wx, wy);
    if (d < bestD) { bestD = d; best = { kind: 'line' as EntityKind, id }; }
  }
  for (const c of doc.circles.values()) {
    const d = distanceToCurve(doc, { kind: 'circle', id: c.id }, wx, wy);
    if (d < bestD) { bestD = d; best = { kind: 'circle' as EntityKind, id: c.id }; }
  }
  for (const a of doc.arcs.values()) {
    const d = distanceToCurve(doc, { kind: 'arc', id: a.id }, wx, wy);
    if (d < bestD) { bestD = d; best = { kind: 'arc' as EntityKind, id: a.id }; }
  }
  return best;
}

/** Cota cujo rótulo contém o ponto da tela (distância, raio, diâmetro ou tangência). */
export function hitTestConstraint(doc: SketchDocument, view: View, sx: number, sy: number): number | undefined {
  for (const c of doc.constraints.values()) {
    let rect: Rect | undefined;
    if (c.type === 'distance') {
      const a = doc.point(c.a);
      const b = doc.point(c.b);
      rect = dimensionLayout(worldToScreen(a.x, a.y, view), worldToScreen(b.x, b.y, view), c.value).rect;
    } else if (c.type === 'radius' || c.type === 'diameter') {
      rect = radialLayout(doc, c, view)?.rect;
    } else if (c.type === 'tangent') {
      rect = tangentLayout(doc, c, view)?.rect;
    }
    if (!rect) continue;
    if (sx >= rect.x - 3 && sx <= rect.x + rect.w + 3 && sy >= rect.y - 3 && sy <= rect.y + rect.h + 3) return c.id;
  }
  return undefined;
}
