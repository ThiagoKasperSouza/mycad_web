import type {
  ArcEntity, CircleEntity, Constraint, ConstraintInput, CurveKind,
  EntityRef, LineEntity, PointEntity, Snapshot,
} from './types';

/**
 * Modelo do sketch: entidades (pontos, linhas, círculos e arcos) + restrições.
 * O documento é a única fonte de verdade; o solver apenas ajusta as coordenadas
 * dos pontos livres para satisfazer as restrições.
 */
export class SketchDocument {
  points = new Map<number, PointEntity>();
  lines = new Map<number, LineEntity>();
  circles = new Map<number, CircleEntity>();
  arcs = new Map<number, ArcEntity>();
  constraints = new Map<number, Constraint>();
  nextId = 1;
  originId: number;

  constructor() {
    this.originId = this.addPoint(0, 0, true).id;
  }

  addPoint(x: number, y: number, fixed = false): PointEntity {
    const p: PointEntity = { id: this.nextId++, x, y, fixed };
    this.points.set(p.id, p);
    return p;
  }

  addLine(a: number, b: number): LineEntity {
    const l: LineEntity = { id: this.nextId++, a, b };
    this.lines.set(l.id, l);
    return l;
  }

  addCircle(center: number, rim: number): CircleEntity {
    const c: CircleEntity = { id: this.nextId++, center, rim };
    this.circles.set(c.id, c);
    return c;
  }

  addArc(center: number, a: number, b: number, ccw = true): ArcEntity {
    const arc: ArcEntity = { id: this.nextId++, center, a, b, ccw };
    this.arcs.set(arc.id, arc);
    return arc;
  }

  addConstraint(input: ConstraintInput): Constraint {
    const c = { ...input, id: this.nextId++ } as Constraint;
    this.constraints.set(c.id, c);
    return c;
  }

  point(id: number): PointEntity {
    const p = this.points.get(id);
    if (!p) throw new Error(`Ponto ${id} não existe`);
    return p;
  }

  circleRadius(c: CircleEntity): number {
    const center = this.point(c.center);
    const rim = this.point(c.rim);
    return Math.hypot(rim.x - center.x, rim.y - center.y);
  }

  arcRadius(arc: ArcEntity): number {
    const center = this.point(arc.center);
    const a = this.point(arc.a);
    return Math.hypot(a.x - center.x, a.y - center.y);
  }

  /** Raio de um círculo ou arco pelo id. */
  radiusOf(entityId: number): number | undefined {
    const c = this.circles.get(entityId);
    if (c) return this.circleRadius(c);
    const arc = this.arcs.get(entityId);
    if (arc) return this.arcRadius(arc);
    return undefined;
  }

  /** Centro de uma curva (círculo/arco). Linhas não têm centro. */
  entityCenter(ref: EntityRef): PointEntity | undefined {
    if (ref.kind === 'line') return undefined;
    if (ref.kind === 'circle') {
      const c = this.circles.get(ref.id);
      return c ? this.point(c.center) : undefined;
    }
    const arc = this.arcs.get(ref.id);
    return arc ? this.point(arc.center) : undefined;
  }

  /** Raio de uma curva; undefined para linhas. */
  entityRadius(ref: EntityRef): number | undefined {
    return ref.kind === 'line' ? undefined : this.radiusOf(ref.id);
  }

  entityExists(ref: EntityRef): boolean {
    if (ref.kind === 'line') return this.lines.has(ref.id);
    if (ref.kind === 'circle') return this.circles.has(ref.id);
    return this.arcs.has(ref.id);
  }

  private sameRef(a: EntityRef, b: EntityRef): boolean {
    return a.kind === b.kind && a.id === b.id;
  }

  /** Restrições entre entidades que referenciam `ref`. */
  private touchesEntity(c: Constraint, ref: EntityRef): boolean {
    if (c.type === 'tangent' || c.type === 'perpendicular' || c.type === 'angle') {
      return this.sameRef(c.a, ref) || this.sameRef(c.b, ref);
    }
    return c.type === 'symmetry' && this.sameRef(c.axis, ref);
  }

  /** Remove um círculo/arco e as restrições associadas. */
  removeEntity(kind: CurveKind, id: number): void {
    this.circles.delete(id);
    this.arcs.delete(id);
    const ref: EntityRef = { kind, id };
    for (const [cid, c] of this.constraints) {
      if ((c.type === 'radius' || c.type === 'diameter') && c.entity === id) this.constraints.delete(cid);
      if (this.touchesEntity(c, ref)) this.constraints.delete(cid);
    }
  }

  /** Funda `removeId` em `keepId`, preservando todas as referências. */
  weldPoints(keepId: number, removeId: number): void {
    if (keepId === removeId || !this.points.has(keepId) || !this.points.has(removeId)) return;

    for (const l of this.lines.values()) {
      if (l.a === removeId) l.a = keepId;
      if (l.b === removeId) l.b = keepId;
    }
    for (const c of this.circles.values()) {
      if (c.center === removeId) c.center = keepId;
      if (c.rim === removeId) c.rim = keepId;
    }
    for (const arc of this.arcs.values()) {
      if (arc.center === removeId) arc.center = keepId;
      if (arc.a === removeId) arc.a = keepId;
      if (arc.b === removeId) arc.b = keepId;
    }
    for (const c of this.constraints.values()) {
      if (c.type === 'distance' || c.type === 'symmetry') {
        if (c.a === removeId) c.a = keepId;
        if (c.b === removeId) c.b = keepId;
      } else if (c.type === 'angle3') {
        if (c.a === removeId) c.a = keepId;
        if (c.vertex === removeId) c.vertex = keepId;
        if (c.b === removeId) c.b = keepId;
      }
    }
    this.points.delete(removeId);
  }

  /** Remove um ponto e, em cascata, entidades e restrições que o referenciam. */
  removePoint(id: number): void {
    if (id === this.originId) return; // origem é permanente
    this.points.delete(id);

    const removedLines: number[] = [];
    for (const [lid, l] of this.lines) {
      if (l.a === id || l.b === id) {
        this.lines.delete(lid);
        removedLines.push(lid);
      }
    }
    for (const [cid, c] of this.constraints) {
      if (c.type === 'distance' || c.type === 'symmetry' || c.type === 'coincident') {
        if (c.a === id || c.b === id) this.constraints.delete(cid);
      } else if (c.type === 'angle3') {
        if (c.a === id || c.vertex === id || c.b === id) this.constraints.delete(cid);
      } else if (c.type !== 'radius' && c.type !== 'diameter' && c.type !== 'tangent'
                 && c.type !== 'perpendicular' && c.type !== 'angle') {
        const l = this.lines.get(c.line);
        if (!l || l.a === id || l.b === id) this.constraints.delete(cid);
      }
    }
    for (const lid of removedLines) {
      const ref: EntityRef = { kind: 'line', id: lid };
      for (const [cid, c] of this.constraints) {
        if (this.touchesEntity(c, ref)) this.constraints.delete(cid);
      }
    }

    for (const [eid, c] of this.circles) {
      if (c.center === id || c.rim === id) this.removeEntity('circle', eid);
    }
    for (const [eid, arc] of this.arcs) {
      if (arc.center === id || arc.a === id || arc.b === id) this.removeEntity('arc', eid);
    }
  }

  removeLine(id: number): void {
    this.lines.delete(id);
    const ref: EntityRef = { kind: 'line', id };
    for (const [cid, c] of this.constraints) {
      if (c.type !== 'distance' && c.type !== 'radius' && c.type !== 'diameter' && c.type !== 'tangent'
          && c.type !== 'perpendicular' && c.type !== 'angle' && c.type !== 'angle3'
          && c.type !== 'symmetry' && c.type !== 'coincident' && c.line === id) {
        this.constraints.delete(cid);
      }
      if (this.touchesEntity(c, ref)) this.constraints.delete(cid);
    }
  }

  /** Remove pontos que não são mais referenciados por nenhuma entidade/restrição. */
  pruneOrphanPoints(): void {
    const used = new Set<number>();
    for (const l of this.lines.values()) { used.add(l.a); used.add(l.b); }
    for (const c of this.circles.values()) { used.add(c.center); used.add(c.rim); }
    for (const arc of this.arcs.values()) { used.add(arc.center); used.add(arc.a); used.add(arc.b); }
    for (const c of this.constraints.values()) {
      if (c.type === 'distance' || c.type === 'symmetry' || c.type === 'coincident') {
        used.add(c.a); used.add(c.b);
      } else if (c.type === 'angle3') {
        used.add(c.a); used.add(c.vertex); used.add(c.b);
      }
    }
    for (const id of [...this.points.keys()]) {
      if (id !== this.originId && !used.has(id)) this.points.delete(id);
    }
  }

  /** Remove todas as entidades exceto a origem. */
  clear(): void {
    this.points.clear();
    this.lines.clear();
    this.circles.clear();
    this.arcs.clear();
    this.constraints.clear();
    this.points.set(this.originId, { id: this.originId, x: 0, y: 0, fixed: true });
    this.nextId = this.originId + 1;
  }

  toSnapshot(): Snapshot {
    return {
      points: [...this.points.values()].map((p) => ({ ...p })),
      lines: [...this.lines.values()].map((l) => ({ ...l })),
      circles: [...this.circles.values()].map((c) => ({ ...c })),
      arcs: [...this.arcs.values()].map((a) => ({ ...a })),
      constraints: [...this.constraints.values()].map((c) => ({ ...c })),
      nextId: this.nextId,
      originId: this.originId,
    };
  }

  static fromSnapshot(s: Snapshot): SketchDocument {
    const doc = new SketchDocument();
    doc.points.clear();
    for (const p of s.points) doc.points.set(p.id, { ...p });
    for (const l of s.lines) doc.lines.set(l.id, { ...l });
    for (const c of s.circles) doc.circles.set(c.id, { ...c });
    for (const a of s.arcs) doc.arcs.set(a.id, { ...a });
    for (const c of s.constraints) doc.constraints.set(c.id, { ...c });
    doc.nextId = s.nextId;
    doc.originId = s.originId;
    return doc;
  }
}
