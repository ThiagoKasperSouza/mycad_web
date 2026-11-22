import * as THREE from 'three';
import type { SketchDocument } from '../core/sketch';

export interface Plane {
  origin: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  normal: THREE.Vector3;
}

export interface SketchInfo {
  id: number;
  name: string;
  doc: SketchDocument;
  plane: Plane;
  extruded: boolean;
}

export interface BodyInfo {
  id: number;
  name: string;
  sketchId: number;
  thickness: number;
  mesh: THREE.Mesh;
  visible: boolean;
}

export function defaultPlane(): Plane {
  return {
    origin: new THREE.Vector3(0, 0, 0),
    u: new THREE.Vector3(1, 0, 0),
    v: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 0, 1),
  };
}

export function planeFromFace(point: THREE.Vector3, normal: THREE.Vector3): Plane {
  const n = normal.clone().normalize();
  const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(helper, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { origin: point.clone(), u, v, normal: n };
}

interface Pt { x: number; y: number; }

interface Edge {
  id: number;
  kind: 'line' | 'arc';
  start: number;
  end: number;
  points: Pt[];
}

function sampleArc(doc: SketchDocument, arcId: number): { a: number; b: number; center: Pt; r: number; ccw: boolean; sweep: number } {
  const arc = doc.arcs.get(arcId)!;
  const o = doc.point(arc.center);
  const pa = doc.point(arc.a);
  const pb = doc.point(arc.b);
  const center = { x: o.x, y: o.y };
  const a = Math.atan2(pa.y - o.y, pa.x - o.x);
  const b = Math.atan2(pb.y - o.y, pb.x - o.x);
  let sweep = b - a;
  if (arc.ccw) { while (sweep < 0) sweep += Math.PI * 2; }
  else { while (sweep > 0) sweep -= Math.PI * 2; }
  return { a, b, center, r: Math.hypot(pa.x - o.x, pa.y - o.y), ccw: arc.ccw, sweep };
}

function arcPoints(doc: SketchDocument, arcId: number): Pt[] {
  const { a, center, r, sweep } = sampleArc(doc, arcId);
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a + sweep * i / steps;
    out.push({ x: center.x + Math.cos(t) * r, y: center.y + Math.sin(t) * r });
  }
  return out;
}

function polygonArea(pts: Pt[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Extrai os contornos fechados do sketch 2D como polilinhas. */
function sketchLoops(doc: SketchDocument): Pt[][] {
  const edges: Edge[] = [];
  for (const l of doc.lines.values()) {
    const a = doc.point(l.a);
    const b = doc.point(l.b);
    edges.push({
      id: l.id, kind: 'line', start: l.a, end: l.b,
      points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
    });
  }
  for (const arc of doc.arcs.values()) {
    edges.push({
      id: arc.id, kind: 'arc', start: arc.a, end: arc.b,
      points: arcPoints(doc, arc.id),
    });
  }

  const loops: Pt[][] = [];
  for (const c of doc.circles.values()) {
    const o = doc.point(c.center);
    const r = doc.circleRadius(c);
    const pts: Pt[] = [];
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const t = Math.PI * 2 * i / steps;
      pts.push({ x: o.x + Math.cos(t) * r, y: o.y + Math.sin(t) * r });
    }
    loops.push(pts);
  }

  const unused = new Set(edges.map((e) => e.id));
  while (unused.size) {
    const firstId = unused.values().next().value as number;
    if (firstId === undefined) break;
    unused.delete(firstId);
    const first = edges.find((e) => e.id === firstId)!;
    const loop: Pt[] = [...first.points];
    let end = first.end;
    const start = first.start;
    let guard = 0;
    while (end !== start && guard++ < 1000) {
      const next = [...unused].map((id) => edges.find((e) => e.id === id)!).find((e) => e.start === end || e.end === end);
      if (!next) break;
      unused.delete(next.id);
      if (next.start === end) {
        loop.push(...next.points.slice(1));
        end = next.end;
      } else {
        loop.push(...[...next.points].reverse().slice(1));
        end = next.start;
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Converte os contornos do sketch em shapes do Three.js (o maior é o exterior; os demais são furos). */
export function sketchToShapes(doc: SketchDocument): THREE.Shape[] {
  const loops = sketchLoops(doc).filter((l) => Math.abs(polygonArea(l)) > 1e-6);
  if (!loops.length) return [];

  const ordered = [...loops].sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const shapes: THREE.Shape[] = [];
  const outers: Pt[][] = [];

  for (const loop of ordered) {
    let parent: Pt[][] | undefined;
    for (const outer of outers) {
      if (pointInPolygon(loop[0], outer)) { parent = [outer]; break; }
    }
    const toVec = (pts: Pt[]) => pts.map((p) => new THREE.Vector2(p.x, p.y));
    let pts = loop;
    if (parent) {
      const outer = parent[0];
      if (Math.sign(polygonArea(pts)) === Math.sign(polygonArea(outer))) pts = [...pts].reverse();
      const shapeIndex = outers.indexOf(outer);
      if (shapeIndex >= 0) shapes[shapeIndex].holes.push(new THREE.Path(toVec(pts)));
    } else {
      outers.push(pts);
      shapes.push(new THREE.Shape(toVec(pts)));
    }
  }
  return shapes;
}

/** Gera a malha extrudada do sketch no plano informado. */
export function extrudeSketch(doc: SketchDocument, plane: Plane, thickness: number): THREE.Mesh | undefined {
  const shapes = sketchToShapes(doc);
  if (!shapes.length || thickness <= 0) return undefined;

  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 8,
  });
  geometry.computeVertexNormals();
  const matrix = new THREE.Matrix4().makeBasis(plane.u, plane.v, plane.normal);
  matrix.setPosition(plane.origin);
  geometry.applyMatrix4(matrix);

  const material = new THREE.MeshStandardMaterial({
    color: 0x5f9ee8,
    metalness: 0.1,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}
