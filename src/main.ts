import './style.css';
import { entityInfo, trim, trimInterval } from './core/geometry';
import { SketchDocument } from './core/sketch';
import { analyze, internalAngle, solve, type SketchAnalysis } from './core/solver';
import type { EntityRef, Snapshot, Tool } from './core/types';
import {
  angle3LabelPos, angleLabelPos, hitTestConstraint, hitTestCurve, hitTestEntity, hitTestLine, hitTestPoint, render,
  type Preview, type Selection,
} from './sketcher/renderer';
import { screenToWorld, snap, worldToScreen, type Vec2, type View } from './sketcher/snapping';

const GRID = 10;
const SNAP_RADIUS = 9;
const PICK_RADIUS = 8;

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Selecionar',
  point: 'Ponto',
  line: 'Linha',
  circle: 'Círculo',
  arc: 'Arco',
  dimension: 'Dimensão',
  tangent: 'Tangente',
  perpendicular: 'Perpendicular',
  angle: 'Ângulo entre retas',
  angleInternal: 'Ângulo interno',
  symmetry: 'Simetria',
  trim: 'Recortar',
  coincident: 'Coincidente',
  pan: 'Pan',
};

const TOOL_HINT: Record<Tool, string> = {
  select: 'Clique para selecionar · Arraste pontos para mover · Delete remove',
  point: 'Clique para posicionar pontos',
  line: 'Clique para definir o início da linha',
  circle: 'Clique no centro, depois no raio',
  arc: 'Clique centro → início → fim · R inverte o sentido',
  dimension: 'Clique em linha/círculo/arco ou em dois pontos · Shift+clique na curva = diâmetro',
  tangent: 'Clique na 1ª entidade, depois na 2ª · Shift = tangência interna (curvas)',
  perpendicular: 'Clique em duas retas (ou reta e curva)',
  angle: 'Clique em duas retas (ângulo dirigido entre elas)',
  angleInternal: 'Clique no vértice e depois em cada lateral (ponto ou linha)',
  symmetry: 'Clique no 1º ponto, na reta de simetria e no 2º ponto',
  trim: 'Passe sobre uma entidade e clique para remover o trecho destacado',
  coincident: 'Clique em dois pontos para forçá-los à mesma posição',
  pan: 'Arraste para mover a vista',
};

interface CircleState { id: number; ref: Vec2; }
interface ArcState { centerId: number; center: Vec2; startId?: number; start?: Vec2; ccw: boolean; }

class SketcherApp {
  private canvas = document.getElementById('sketch') as HTMLCanvasElement;
  private wrap = document.getElementById('canvas-wrap') as HTMLDivElement;
  private ctx = this.canvas.getContext('2d')!;
  private editorBox = document.getElementById('inline-editor') as HTMLDivElement;
  private dimInput = document.getElementById('dim-input') as HTMLInputElement;

  private doc = new SketchDocument();
  private view: View = { offsetX: 0, offsetY: 0, scale: 1 };
  private width = 0;
  private height = 0;
  private dpr = 1;

  private tool: Tool = 'select';
  private selection: Selection = this.emptySelection();
  private preview: Preview | null = null;
  private pointerWorld: Vec2 = { x: 0, y: 0 };
  private hoverPoint: number | undefined;

  private lineStart: { id: number; ref: Vec2 } | null = null;
  private circleCenter: CircleState | null = null;
  private arcState: ArcState | null = null;
  private arcCcw = true;
  private tangentFirst: EntityRef | null = null;
  private perpFirst: EntityRef | null = null;
  private angleFirst: EntityRef | null = null;
  private anglePoints: { vertex: number; a?: number } | null = null;
  private symPointA: number | undefined;
  private symAxis: EntityRef | null = null;
  private coincidentFirst: number | undefined;
  private dimFirstPoint: number | undefined;
  private dragging: { id: number } | null = null;
  private panning: { sx: number; sy: number; ox: number; oy: number } | null = null;
  private spaceDown = false;
  private editing: { id: number; needsUndo: boolean } | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private commandOpen = false;
  private hint = TOOL_HINT.select;
  private solverInfo = { error: 0, converged: true, iterations: 0 };
  private analysis: SketchAnalysis = {
    variables: 0, equations: 0, rank: 0, dof: 0, redundant: [], status: 'ok', error: 0,
  };

  constructor() {
    this.bindEvents();
    this.resize();
    this.fitView();
    this.solveAndRefresh();
  }

  private emptySelection(): Selection {
    return {
      points: new Set(), lines: new Set(), curves: new Set(),
      constraints: new Set(), redundant: new Set(),
    };
  }

  // ----- comandos / undo -----
  private beginCommand(): void {
    if (this.commandOpen) return;
    this.undoStack.push(this.doc.toSnapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.commandOpen = true;
  }

  private endCommand(): void {
    this.commandOpen = false;
  }

  private restore(s: Snapshot): void {
    this.doc = SketchDocument.fromSnapshot(s);
    this.commandOpen = false;
    this.selection = this.emptySelection();
    this.lineStart = null;
    this.circleCenter = null;
    this.arcState = null;
    this.tangentFirst = null;
    this.perpFirst = null;
    this.angleFirst = null;
    this.anglePoints = null;
    this.symPointA = undefined;
    this.symAxis = null;
    this.coincidentFirst = undefined;
    this.dimFirstPoint = undefined;
    this.dragging = null;
    this.cancelEditor();
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.doc.toSnapshot());
    this.restore(s);
    this.solveAndRefresh();
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.doc.toSnapshot());
    this.restore(s);
    this.solveAndRefresh();
  }

  // ----- visualização -----
  private resize(): void {
    const rect = this.wrap.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  private fitView(): void {
    const pts = [...this.doc.points.values()];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(0, ...xs);
    const maxX = Math.max(0, ...xs);
    const minY = Math.min(0, ...ys);
    const maxY = Math.max(0, ...ys);
    const w = Math.max(20, maxX - minX);
    const h = Math.max(20, maxY - minY);
    this.view.scale = Math.max(0.05, Math.min(20, (this.width - 140) / w, (this.height - 140) / h));
    this.view.offsetX = this.width / 2 - ((minX + maxX) / 2) * this.view.scale;
    this.view.offsetY = this.height / 2 + ((minY + maxY) / 2) * this.view.scale;
  }

  private draw(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    render(this.ctx, this.doc, this.view, this.width, this.height, this.selection, this.preview, this.hoverPoint);
    this.updateStatus();
  }

  private refresh(): void {
    this.selection.redundant = new Set(this.analysis.redundant);
    this.draw();
    this.updateInspector();
  }

  private solveAndRefresh(): void {
    this.solverInfo = solve(this.doc);
    this.analysis = analyze(this.doc, this.solverInfo.error);
    this.refresh();
  }

  private updateStatus(): void {
    const set = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };
    set('status-tool', TOOL_LABEL[this.tool]);
    set('status-coords', `x: ${this.pointerWorld.x.toFixed(2)}   y: ${this.pointerWorld.y.toFixed(2)}`);

    const solver = document.getElementById('status-solver')!;
    const constraints = this.doc.constraints.size;
    if (constraints === 0) {
      solver.textContent = 'sem restrições';
      solver.className = '';
    } else if (this.solverInfo.converged) {
      solver.textContent = `resolver OK · ${constraints} restrição(ões) · ${this.solverInfo.iterations} it.`;
      solver.className = 'ok';
    } else {
      solver.textContent = `resolver: erro ${this.solverInfo.error.toExponential(1)} · ${constraints} restrição(ões)`;
      solver.className = 'bad';
    }

    const a = this.analysis;
    const dof = document.getElementById('status-dof')!;
    dof.textContent = `GL: ${a.dof}`;
    dof.className = a.status === 'conflict' ? 'bad' : a.status === 'redundant' ? 'warn' : '';
    dof.title = `${a.variables} variáveis · ${a.equations} equações · posto ${a.rank}`;

    const banner = document.getElementById('warning-banner')!;
    if (a.status === 'conflict') {
      banner.hidden = false;
      banner.className = 'warning-banner';
      const worst = a.worstConstraint !== undefined ? `C${a.worstConstraint} não pode ser satisfeita` : 'restrições conflitantes';
      const others = a.redundant.filter((id) => id !== a.worstConstraint);
      const extra = others.length ? ` · redundantes: ${this.ids(others)}` : '';
      banner.textContent = `⚠ Sketch superdimensionado: ${worst} (resíduo ${a.error.toExponential(1)})${extra}.`;
    } else if (a.status === 'redundant') {
      banner.hidden = false;
      banner.className = 'warning-banner info';
      banner.textContent = `⚠ Restrições redundantes: ${this.ids(a.redundant)} — remova uma para evitar superdimensionamento.`;
    } else {
      banner.hidden = true;
    }

    let hint = this.hint;
    if (this.preview?.snap?.inference === 'horizontal') hint = 'Inferência: HORIZONTAL (H)';
    if (this.preview?.snap?.inference === 'vertical') hint = 'Inferência: VERTICAL (V)';
    set('status-hint', hint);
  }

  private updateInspector(): void {
    const entityList = document.getElementById('entity-list')!;
    const constraintList = document.getElementById('constraint-list')!;

    const pointRows = [...this.doc.points.values()].map((p) =>
      this.row('point', p.id, `P${p.id} &nbsp; (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`,
        p.fixed ? '<span class="tag">fixo</span>' : '', this.selection.points.has(p.id)));
    const lineRows = [...this.doc.lines.values()].map((l) =>
      this.row('line', l.id, `L${l.id} &nbsp; P${l.a} → P${l.b}`, '', this.selection.lines.has(l.id)));
    const curveRows = [
      ...[...this.doc.circles.values()].map((c) =>
        this.row('curve', c.id, `C${c.id} &nbsp; ◯ R${this.fmt(this.doc.circleRadius(c))}`, '', this.selection.curves.has(c.id))),
      ...[...this.doc.arcs.values()].map((a) =>
        this.row('curve', a.id, `A${a.id} &nbsp; ◜ R${this.fmt(this.doc.arcRadius(a))} ${a.ccw ? '↺' : '↻'}`, '', this.selection.curves.has(a.id))),
    ];

    entityList.innerHTML = [...pointRows, ...lineRows, ...curveRows].join('') || '<div class="empty">Nenhuma entidade</div>';
    document.getElementById('entity-count')!.textContent = String(pointRows.length + lineRows.length + curveRows.length);

    const constraintRows = [...this.doc.constraints.values()].map((c) => {
      let label = '';
      if (c.type === 'distance') label = `distância = ${this.fmt(c.value)}`;
      else if (c.type === 'horizontal') label = `horizontal (L${c.line})`;
      else if (c.type === 'vertical') label = `vertical (L${c.line})`;
      else if (c.type === 'radius') label = `raio = ${this.fmt(c.value)}`;
      else if (c.type === 'diameter') label = `diâmetro = ${this.fmt(c.value)}`;
      else if (c.type === 'tangent') label = `tangente ${this.entityLabel(c.a)} ↔ ${this.entityLabel(c.b)} (${c.mode === 'internal' ? 'interna' : 'externa'})`;
      else if (c.type === 'perpendicular') label = `perpendicular ${this.entityLabel(c.a)} ⊥ ${this.entityLabel(c.b)}`;
      else if (c.type === 'angle') label = `ângulo = ${this.fmt(c.value)}° (${this.entityLabel(c.a)}, ${this.entityLabel(c.b)})`;
      else if (c.type === 'angle3') label = `ângulo interno = ${this.fmt(c.value)}° (P${c.a}, P${c.vertex}, P${c.b})`;
      else if (c.type === 'symmetry') label = `simetria P${c.a} ↔ P${c.b} sobre ${this.entityLabel(c.axis)}`;
      else label = `coincidente P${c.a} ≡ P${c.b}`;
      const redundant = this.selection.redundant.has(c.id);
      return this.row('constraint', c.id, `C${c.id} &nbsp; ${label}`,
        redundant ? '<span class="tag warn">redundante</span>' : '',
        this.selection.constraints.has(c.id), redundant);
    });
    constraintList.innerHTML = constraintRows.join('') || '<div class="empty">Nenhuma restrição</div>';
    document.getElementById('constraint-count')!.textContent = String(constraintRows.length);
  }

  private fmt(v: number): string { return String(Math.round(v * 100) / 100); }

  private ids(ids: number[]): string { return ids.map((id) => `C${id}`).join(', '); }

  private entityLabel(ref: EntityRef): string {
    const prefix = ref.kind === 'line' ? 'L' : ref.kind === 'circle' ? 'C' : 'A';
    return `${prefix}${ref.id}`;
  }

  /**
   * Ponto que define uma lateral do ângulo: um ponto clicado diretamente, ou
   * o extremo da linha clicada mais distante do vértice (para cliques no meio
   * do segmento).
   */
  private armPointAt(w: Vec2, pick: number, vertexId: number): number | undefined {
    const pid = hitTestPoint(this.doc, w.x, w.y, pick);
    if (pid !== undefined && pid !== vertexId) return pid;

    const lid = hitTestLine(this.doc, w.x, w.y, pick);
    if (lid === undefined) return undefined;
    const line = this.doc.lines.get(lid)!;
    const v = this.doc.point(vertexId);
    const distance = (id: number) => {
      const p = this.doc.point(id);
      return Math.hypot(p.x - v.x, p.y - v.y);
    };
    // Se a lateral termina num ponto coincidente com o vértice (duplicata),
    // funde-os para que o ângulo use o mesmo ponto das duas linhas.
    for (const id of [line.a, line.b]) {
      if (id === vertexId || !this.doc.points.has(id)) continue;
      const p = this.doc.point(id);
      if (Math.hypot(p.x - v.x, p.y - v.y) < 1e-3) this.doc.weldPoints(vertexId, id);
    }

    const endpoints = [line.a, line.b];
    const pool = endpoints.filter((id) => id !== vertexId);
    const candidates = pool.length > 0 ? pool : endpoints;
    return candidates.reduce((best, id) => distance(id) > distance(best) ? id : best, candidates[0]);
  }

  /** Ângulo dirigido (graus) entre duas retas, normalizado para [-180, 180]. */
  private signedAngleDeg(a: EntityRef, b: EntityRef): number {
    const la = this.doc.lines.get(a.id);
    const lb = this.doc.lines.get(b.id);
    if (!la || !lb) return 0;
    const p = this.doc.point(la.a);
    const q = this.doc.point(la.b);
    const r = this.doc.point(lb.a);
    const s = this.doc.point(lb.b);
    const cross = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
    const dot = (q.x - p.x) * (s.x - r.x) + (q.y - p.y) * (s.y - r.y);
    return Math.atan2(cross, dot) * 180 / Math.PI;
  }

  private selectEntity(ref: EntityRef): void {
    if (ref.kind === 'line') this.setSelection('line', ref.id);
    else this.setSelection('curve', ref.id);
  }

  private row(kind: string, id: number, label: string, tag: string, selected: boolean, redundant = false): string {
    return `<div class="row${selected ? ' sel' : ''}${redundant ? ' redundant' : ''}" data-kind="${kind}" data-id="${id}">
      <span class="label">${label}</span>${tag}<button class="del" data-del="${id}" data-kind="${kind}" title="Remover">×</button>
    </div>`;
  }

  // ----- editor de cota -----
  private openDimensionEditor(id: number, needsUndo: boolean): void {
    const c = this.doc.constraints.get(id);
    if (!c) return;
    let mx: number;
    let my: number;

    if (c.type === 'distance') {
      const a = this.doc.point(c.a);
      const b = this.doc.point(c.b);
      const sa = worldToScreen(a.x, a.y, this.view);
      const sb = worldToScreen(b.x, b.y, this.view);
      mx = (sa.x + sb.x) / 2;
      my = (sa.y + sb.y) / 2 - 26;
    } else if (c.type === 'radius' || c.type === 'diameter') {
      const circle = this.doc.circles.get(c.entity);
      const arc = this.doc.arcs.get(c.entity);
      const centerId = circle?.center ?? arc?.center;
      const rimId = circle?.rim ?? arc?.a;
      if (centerId === undefined || rimId === undefined) return;
      const o = this.doc.point(centerId);
      const r = this.doc.point(rimId);
      const so = worldToScreen(o.x, o.y, this.view);
      const sr = worldToScreen(r.x, r.y, this.view);
      mx = (so.x + sr.x) / 2;
      my = (so.y + sr.y) / 2 - 20;
    } else if (c.type === 'angle') {
      const pos = angleLabelPos(this.doc, c, this.view);
      if (!pos) return;
      mx = pos.x;
      my = pos.y;
    } else if (c.type === 'angle3') {
      const pos = angle3LabelPos(this.doc, c, this.view);
      if (!pos) return;
      mx = pos.x;
      my = pos.y;
    } else {
      return;
    }

    this.editing = { id, needsUndo };
    this.editorBox.hidden = false;
    this.editorBox.style.left = `${mx - 52}px`;
    this.editorBox.style.top = `${my - 12}px`;
    this.dimInput.value = String(this.fmt(c.value));
    this.dimInput.focus();
    this.dimInput.select();
  }

  private cancelEditor(): void {
    this.editing = null;
    this.editorBox.hidden = true;
  }

  private commitEditor(): void {
    if (!this.editing) return;
    const { id, needsUndo } = this.editing;
    const c = this.doc.constraints.get(id);
    const raw = Number.parseFloat(this.dimInput.value.replace(',', '.'));
    this.cancelEditor();

    const valid = !!c && Number.isFinite(raw) && (
      c.type === 'angle3' ? raw >= 0 && raw <= 180
        : c.type === 'angle' ? Math.abs(raw) <= 360 : raw > 0
    );
    if (c && valid && (c.type === 'distance' || c.type === 'radius'
        || c.type === 'diameter' || c.type === 'angle' || c.type === 'angle3')) {
      if (needsUndo) this.beginCommand();
      c.value = raw;
      this.solveAndRefresh();
      if (needsUndo) this.endCommand();
    } else {
      this.refresh();
    }
  }

  // ----- ferramentas -----
  private setTool(tool: Tool): void {
    this.endCommand();
    this.cancelEditor();
    this.tool = tool;
    this.lineStart = null;
    this.circleCenter = null;
    this.arcState = null;
    this.tangentFirst = null;
    this.perpFirst = null;
    this.angleFirst = null;
    this.anglePoints = null;
    this.symPointA = undefined;
    this.symAxis = null;
    this.coincidentFirst = undefined;
    this.dimFirstPoint = undefined;
    this.preview = null;
    this.hint = TOOL_HINT[tool];
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    this.canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    this.refresh();
  }

  private setSelection(kind: 'point' | 'line' | 'curve' | 'constraint', id: number): void {
    this.selection = this.emptySelection();
    if (kind === 'point') this.selection.points.add(id);
    else if (kind === 'line') this.selection.lines.add(id);
    else if (kind === 'curve') this.selection.curves.add(id);
    else this.selection.constraints.add(id);
    this.refresh();
  }

  private deleteEntity(kind: string, id: number): void {
    this.beginCommand();
    if (kind === 'point') this.doc.removePoint(id);
    else if (kind === 'line') this.doc.removeLine(id);
    else if (kind === 'curve') {
      if (this.doc.circles.has(id)) this.doc.removeEntity('circle', id);
      else this.doc.removeEntity('arc', id);
    } else this.doc.constraints.delete(id);
    this.endCommand();
    this.solveAndRefresh();
  }

  private deleteSelection(): void {
    if (!this.selection.points.size && !this.selection.lines.size
        && !this.selection.curves.size && !this.selection.constraints.size) return;
    this.beginCommand();
    for (const id of this.selection.points) this.doc.removePoint(id);
    for (const id of this.selection.lines) this.doc.removeLine(id);
    for (const id of this.selection.curves) {
      if (this.doc.circles.has(id)) this.doc.removeEntity('circle', id);
      else this.doc.removeEntity('arc', id);
    }
    for (const id of this.selection.constraints) this.doc.constraints.delete(id);
    this.endCommand();
    this.selection = this.emptySelection();
    this.solveAndRefresh();
  }

  private toScreen(e: PointerEvent | MouseEvent | WheelEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Cria ou reutiliza um ponto na posição com snap. */
  private pointAt(w: Vec2, skipId?: number, reference?: Vec2): number {
    const r = snap(this.doc, w.x, w.y, this.view, {
      grid: GRID, radiusPx: SNAP_RADIUS, skipPointId: skipId, reference,
    });
    return r.pointId ?? this.doc.addPoint(r.x, r.y).id;
  }

  private onPointerDown(e: PointerEvent): void {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético / não ativo */ }
    const s = this.toScreen(e);
    const w = screenToWorld(s.x, s.y, this.view);
    const pick = PICK_RADIUS / this.view.scale;

    if (e.button === 1 || this.spaceDown || this.tool === 'pan') {
      this.panning = { sx: s.x, sy: s.y, ox: this.view.offsetX, oy: this.view.offsetY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'point') {
      this.beginCommand();
      const id = this.pointAt(w);
      this.endCommand();
      this.setSelection('point', id);
      this.solveAndRefresh();
      return;
    }

    if (this.tool === 'line') {
      if (!this.lineStart) {
        this.beginCommand();
        const id = this.pointAt(w);
        const p = this.doc.point(id);
        this.lineStart = { id, ref: { x: p.x, y: p.y } };
        this.hint = 'Clique para definir o fim · Esc encerra a cadeia';
      } else {
        const snapRes = snap(this.doc, w.x, w.y, this.view, {
          reference: this.lineStart.ref, skipPointId: this.lineStart.id,
          grid: GRID, radiusPx: SNAP_RADIUS,
        });
        if (snapRes.pointId === this.lineStart.id) return;
        const endId = snapRes.pointId ?? this.doc.addPoint(snapRes.x, snapRes.y).id;
        const line = this.doc.addLine(this.lineStart.id, endId);
        if (snapRes.inference === 'horizontal') this.doc.addConstraint({ type: 'horizontal', line: line.id });
        if (snapRes.inference === 'vertical') this.doc.addConstraint({ type: 'vertical', line: line.id });
        const end = this.doc.point(endId);
        this.lineStart = { id: endId, ref: { x: end.x, y: end.y } };
      }
      this.solveAndRefresh();
      return;
    }

    if (this.tool === 'circle') {
      if (!this.circleCenter) {
        this.beginCommand();
        const id = this.pointAt(w);
        const p = this.doc.point(id);
        this.circleCenter = { id, ref: { x: p.x, y: p.y } };
        this.hint = 'Clique para definir o raio';
      } else {
        const rimId = this.pointAt(w, this.circleCenter.id);
        if (rimId === this.circleCenter.id) return;
        this.doc.addCircle(this.circleCenter.id, rimId);
        this.circleCenter = null;
        this.endCommand();
        this.hint = TOOL_HINT.circle;
        this.solveAndRefresh();
      }
      this.draw();
      return;
    }

    if (this.tool === 'arc') {
      if (!this.arcState) {
        this.beginCommand();
        const id = this.pointAt(w);
        const p = this.doc.point(id);
        this.arcState = { centerId: id, center: { x: p.x, y: p.y }, ccw: this.arcCcw };
        this.hint = 'Clique no ponto inicial do arco';
      } else if (this.arcState.startId === undefined) {
        const id = this.pointAt(w, this.arcState.centerId, this.arcState.center);
        if (id === this.arcState.centerId) return;
        const p = this.doc.point(id);
        this.arcState.startId = id;
        this.arcState.start = { x: p.x, y: p.y };
        this.hint = 'Clique no ponto final · R inverte o sentido';
      } else {
        const id = this.pointAt(w, this.arcState.startId);
        if (id === this.arcState.centerId || id === this.arcState.startId) return;
        this.doc.addArc(this.arcState.centerId, this.arcState.startId, id, this.arcState.ccw);
        this.arcState = null;
        this.endCommand();
        this.hint = TOOL_HINT.arc;
        this.solveAndRefresh();
      }
      this.draw();
      return;
    }

    if (this.tool === 'coincident') {
      const pid = hitTestPoint(this.doc, w.x, w.y, pick);
      if (pid === undefined) {
        this.coincidentFirst = undefined;
        this.hint = TOOL_HINT.coincident;
        this.draw();
        return;
      }
      if (this.coincidentFirst === undefined) {
        this.beginCommand();
        this.coincidentFirst = pid;
        this.setSelection('point', pid);
        this.hint = 'Agora clique no segundo ponto';
        this.draw();
        return;
      }
      if (pid === this.coincidentFirst) return;
      const c = this.doc.addConstraint({ type: 'coincident', a: this.coincidentFirst, b: pid });
      this.coincidentFirst = undefined;
      this.endCommand();
      this.hint = TOOL_HINT.coincident;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      return;
    }

    if (this.tool === 'trim') {
      const hit = hitTestEntity(this.doc, w.x, w.y, pick);
      if (!hit) {
        this.hint = TOOL_HINT.trim;
        this.draw();
        return;
      }
      const param = entityInfo(this.doc, hit).paramAt(w);
      if (param === undefined) return;
      this.beginCommand();
      const created = trim(this.doc, hit, param);
      if (created.length === 0) {
        this.undoStack.pop();
        this.commandOpen = false;
        this.hint = 'Não há interseções para recortar nesta entidade';
        this.draw();
        return;
      }
      this.endCommand();
      this.preview = null;
      this.hint = TOOL_HINT.trim;
      this.solveAndRefresh();
      return;
    }

    if (this.tool === 'perpendicular') {
      const hit = hitTestEntity(this.doc, w.x, w.y, pick);
      if (!hit) {
        this.perpFirst = null;
        this.selection = this.emptySelection();
        this.hint = TOOL_HINT.perpendicular;
        this.draw();
        return;
      }
      if (!this.perpFirst) {
        this.beginCommand();
        this.perpFirst = hit;
        this.selectEntity(hit);
        this.hint = 'Agora clique na segunda entidade';
        this.draw();
        return;
      }
      if (hit.kind === this.perpFirst.kind && hit.id === this.perpFirst.id) return;
      const c = this.doc.addConstraint({ type: 'perpendicular', a: this.perpFirst, b: hit });
      this.perpFirst = null;
      this.endCommand();
      this.hint = TOOL_HINT.perpendicular;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      return;
    }

    if (this.tool === 'angleInternal') {
      if (!this.anglePoints) {
        const pid = hitTestPoint(this.doc, w.x, w.y, pick);
        if (pid === undefined) {
          this.hint = 'Clique no vértice do ângulo';
          this.draw();
          return;
        }
        this.beginCommand();
        this.anglePoints = { vertex: pid };
        this.setSelection('point', pid);
        this.hint = 'Vértice escolhido · clique na primeira lateral (ponto ou linha)';
        this.draw();
        return;
      }
      if (this.anglePoints.a === undefined) {
        const pid = this.armPointAt(w, pick, this.anglePoints.vertex);
        if (pid === undefined) {
          this.hint = 'Clique na primeira lateral (ponto ou linha)';
          this.draw();
          return;
        }
        this.anglePoints.a = pid;
        this.setSelection('point', pid);
        this.hint = 'Agora clique na segunda lateral (ponto ou linha)';
        this.draw();
        return;
      }
      const pid = this.armPointAt(w, pick, this.anglePoints.vertex);
      if (pid === undefined || pid === this.anglePoints.a) {
        this.hint = 'Clique numa lateral diferente da primeira';
        this.draw();
        return;
      }
      const { vertex, a } = this.anglePoints;
      const value = internalAngle(this.doc, a, vertex, pid) * 180 / Math.PI;
      const c = this.doc.addConstraint({ type: 'angle3', a, vertex, b: pid, value });
      this.anglePoints = null;
      this.endCommand();
      this.hint = TOOL_HINT.angleInternal;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      this.openDimensionEditor(c.id, false);
      return;
    }

    if (this.tool === 'angle') {
      const hit = hitTestEntity(this.doc, w.x, w.y, pick);
      if (!hit || hit.kind !== 'line') {
        this.angleFirst = null;
        this.selection = this.emptySelection();
        this.hint = TOOL_HINT.angle;
        this.draw();
        return;
      }
      if (!this.angleFirst) {
        this.beginCommand();
        this.angleFirst = hit;
        this.selectEntity(hit);
        this.hint = 'Agora clique na segunda reta';
        this.draw();
        return;
      }
      if (hit.kind === this.angleFirst.kind && hit.id === this.angleFirst.id) return;
      const c = this.doc.addConstraint({
        type: 'angle', a: this.angleFirst, b: hit, value: this.signedAngleDeg(this.angleFirst, hit),
      });
      this.angleFirst = null;
      this.endCommand();
      this.hint = TOOL_HINT.angle;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      this.openDimensionEditor(c.id, false);
      return;
    }

    if (this.tool === 'symmetry') {
      if (this.symPointA === undefined) {
        const pid = hitTestPoint(this.doc, w.x, w.y, pick);
        if (pid === undefined || pid === this.doc.originId) {
          this.hint = 'Clique num ponto (não a origem)';
          this.draw();
          return;
        }
        this.beginCommand();
        this.symPointA = pid;
        this.setSelection('point', pid);
        this.hint = 'Agora clique na reta de simetria';
        this.draw();
        return;
      }
      if (!this.symAxis) {
        const hit = hitTestEntity(this.doc, w.x, w.y, pick);
        if (!hit || hit.kind !== 'line') {
          this.hint = 'A simetria precisa de uma reta como eixo';
          this.draw();
          return;
        }
        this.symAxis = hit;
        this.setSelection('line', hit.id);
        this.hint = 'Agora clique no segundo ponto';
        this.draw();
        return;
      }
      const pid = hitTestPoint(this.doc, w.x, w.y, pick);
      if (pid === undefined || pid === this.symPointA) return;
      const c = this.doc.addConstraint({ type: 'symmetry', a: this.symPointA, axis: this.symAxis, b: pid });
      this.symPointA = undefined;
      this.symAxis = null;
    this.coincidentFirst = undefined;
      this.endCommand();
      this.hint = TOOL_HINT.symmetry;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      return;
    }

    if (this.tool === 'tangent') {
      const hit = hitTestEntity(this.doc, w.x, w.y, pick);
      if (!hit) {
        this.tangentFirst = null;
        this.selection = this.emptySelection();
        this.hint = TOOL_HINT.tangent;
        this.draw();
        return;
      }
      if (!this.tangentFirst) {
        this.beginCommand();
        this.tangentFirst = hit;
        this.selectEntity(hit);
        this.hint = 'Agora clique na segunda entidade · Shift = tangência interna';
        this.draw();
        return;
      }
      const first = this.tangentFirst;
      if (hit.kind === first.kind && hit.id === first.id) return;

      // Trava o raio das curvas envolvidas para que a tangência mova a geometria,
      // não redimensione as curvas (o solver tem acesso aos pontos do raio).
      const seen = new Set<number>();
      for (const ref of [first, hit]) {
        if (ref.kind === 'line' || seen.has(ref.id)) continue;
        seen.add(ref.id);
        const alreadyLocked = [...this.doc.constraints.values()].some(
          (c) => (c.type === 'radius' || c.type === 'diameter') && c.entity === ref.id,
        );
        const r = this.doc.radiusOf(ref.id);
        if (!alreadyLocked && r !== undefined && r > 1e-6) {
          this.doc.addConstraint({ type: 'radius', entity: ref.id, value: r });
        }
      }

      const c = this.doc.addConstraint({
        type: 'tangent', a: first, b: hit,
        mode: e.shiftKey ? 'internal' : 'external',
      });
      this.tangentFirst = null;
      this.endCommand();
      this.hint = TOOL_HINT.tangent;
      this.solveAndRefresh();
      this.setSelection('constraint', c.id);
      return;
    }

    if (this.tool === 'dimension') {
      const cid = hitTestConstraint(this.doc, this.view, s.x, s.y);
      if (cid !== undefined) {
        this.setSelection('constraint', cid);
        this.hint = 'Cota selecionada · duplo clique para editar';
        this.draw();
        return;
      }
      const lineId = hitTestLine(this.doc, w.x, w.y, pick);
      if (lineId !== undefined) {
        const l = this.doc.lines.get(lineId)!;
        const a = this.doc.point(l.a);
        const b = this.doc.point(l.b);
        const value = Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y));
        this.beginCommand();
        const c = this.doc.addConstraint({ type: 'distance', a: l.a, b: l.b, value });
        this.endCommand();
        this.dimFirstPoint = undefined;
        this.hint = TOOL_HINT.dimension;
        this.solveAndRefresh();
        this.openDimensionEditor(c.id, false);
        return;
      }
      const pid = hitTestPoint(this.doc, w.x, w.y, pick);
      if (pid !== undefined) {
        if (this.dimFirstPoint === undefined) {
          this.dimFirstPoint = pid;
          this.hint = 'Agora clique no segundo ponto';
          this.draw();
        } else if (pid !== this.dimFirstPoint) {
          const a = this.doc.point(this.dimFirstPoint);
          const b = this.doc.point(pid);
          const value = Math.max(1e-3, Math.hypot(b.x - a.x, b.y - a.y));
          this.beginCommand();
          const c = this.doc.addConstraint({ type: 'distance', a: a.id, b: b.id, value });
          this.endCommand();
          this.dimFirstPoint = undefined;
          this.hint = TOOL_HINT.dimension;
          this.solveAndRefresh();
          this.openDimensionEditor(c.id, false);
        }
        return;
      }
      const curve = hitTestCurve(this.doc, w.x, w.y, pick);
      if (curve) {
        const value = Math.max(1e-3, this.doc.radiusOf(curve.id) ?? 1e-3);
        this.beginCommand();
        const c = e.shiftKey
          ? this.doc.addConstraint({ type: 'diameter', entity: curve.id, value: value * 2 })
          : this.doc.addConstraint({ type: 'radius', entity: curve.id, value });
        this.endCommand();
        this.hint = TOOL_HINT.dimension;
        this.solveAndRefresh();
        this.openDimensionEditor(c.id, false);
        return;
      }
      this.dimFirstPoint = undefined;
      this.hint = TOOL_HINT.dimension;
      this.draw();
      return;
    }

    // selecionar
    const pid = hitTestPoint(this.doc, w.x, w.y, pick);
    if (pid !== undefined) {
      this.setSelection('point', pid);
      if (pid !== this.doc.originId) {
        this.beginCommand();
        this.dragging = { id: pid };
      }
      return;
    }
    const lid = hitTestLine(this.doc, w.x, w.y, pick);
    if (lid !== undefined) { this.setSelection('line', lid); return; }
    const curve = hitTestCurve(this.doc, w.x, w.y, pick);
    if (curve) { this.setSelection('curve', curve.id); return; }
    const cid = hitTestConstraint(this.doc, this.view, s.x, s.y);
    if (cid !== undefined) { this.setSelection('constraint', cid); return; }
    this.selection = this.emptySelection();
    this.refresh();
  }

  private onPointerMove(e: PointerEvent): void {
    const s = this.toScreen(e);
    const w = screenToWorld(s.x, s.y, this.view);
    this.pointerWorld = w;

    if (this.panning) {
      this.view.offsetX = this.panning.ox + (s.x - this.panning.sx);
      this.view.offsetY = this.panning.oy + (s.y - this.panning.sy);
      this.draw();
      return;
    }

    if (this.dragging) {
      const snapRes = snap(this.doc, w.x, w.y, this.view, {
        grid: GRID, radiusPx: SNAP_RADIUS, skipPointId: this.dragging.id,
      });
      const p = this.doc.point(this.dragging.id);
      p.x = snapRes.x;
      p.y = snapRes.y;
      this.solveAndRefresh();
      return;
    }

    this.hoverPoint = hitTestPoint(this.doc, w.x, w.y, PICK_RADIUS / this.view.scale);

    if (this.tool === 'line' && this.lineStart) {
      const snapRes = snap(this.doc, w.x, w.y, this.view, {
        reference: this.lineStart.ref, skipPointId: this.lineStart.id,
        grid: GRID, radiusPx: SNAP_RADIUS,
      });
      this.preview = { kind: 'line', x: snapRes.x, y: snapRes.y, start: this.lineStart.ref, snap: snapRes };
    } else if (this.tool === 'circle' && this.circleCenter) {
      const snapRes = snap(this.doc, w.x, w.y, this.view, {
        grid: GRID, radiusPx: SNAP_RADIUS, skipPointId: this.circleCenter.id,
      });
      this.preview = { kind: 'circle', x: snapRes.x, y: snapRes.y, start: this.circleCenter.ref, snap: snapRes };
    } else if (this.tool === 'arc' && this.arcState) {
      const snapRes = snap(this.doc, w.x, w.y, this.view, {
        grid: GRID, radiusPx: SNAP_RADIUS,
        skipPointId: this.arcState.startId ?? this.arcState.centerId,
        reference: this.arcState.startId === undefined ? this.arcState.center : undefined,
      });
      this.preview = {
        kind: 'arc', x: snapRes.x, y: snapRes.y,
        start: this.arcState.center, second: this.arcState.start,
        ccw: this.arcState.ccw, snap: snapRes,
      };
    } else if (this.tool === 'trim') {
      const hit = hitTestEntity(this.doc, w.x, w.y, PICK_RADIUS / this.view.scale);
      if (hit) {
        const param = entityInfo(this.doc, hit).paramAt(w);
        this.preview = {
          kind: 'trim', x: w.x, y: w.y,
          trim: { ref: hit, interval: param === undefined ? undefined : trimInterval(this.doc, hit, param) },
        };
        this.hint = this.preview.trim?.interval
          ? 'Clique para remover o trecho em vermelho'
          : 'Sem interseções para recortar nesta entidade';
      } else {
        this.preview = { kind: 'trim', x: w.x, y: w.y };
        this.hint = TOOL_HINT.trim;
      }
    } else if (this.tool === 'point') {
      const snapRes = snap(this.doc, w.x, w.y, this.view, { grid: GRID, radiusPx: SNAP_RADIUS });
      this.preview = { kind: 'point', x: snapRes.x, y: snapRes.y, snap: snapRes };
    } else {
      this.preview = null;
    }
    this.draw();
  }

  private onPointerUp(e: PointerEvent): void {
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    } catch { /* ponteiro sintético / não ativo */ }
    if (this.dragging) {
      this.dragging = null;
      this.endCommand();
      this.solveAndRefresh();
    }
    if (this.panning) {
      this.panning = null;
      this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const s = this.toScreen(e);
    const before = screenToWorld(s.x, s.y, this.view);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.view.scale = Math.max(0.02, Math.min(200, this.view.scale * factor));
    this.view.offsetX = s.x - before.x * this.view.scale;
    this.view.offsetY = s.y + before.y * this.view.scale;
    this.draw();
  }

  private cancel(): void {
    this.cancelEditor();
    if (this.lineStart || this.circleCenter || this.arcState || this.tangentFirst || this.perpFirst
        || this.angleFirst || this.anglePoints || this.symAxis
        || this.symPointA !== undefined || this.coincidentFirst !== undefined
        || this.dimFirstPoint !== undefined) {
      this.lineStart = null;
      this.circleCenter = null;
      this.arcState = null;
      this.tangentFirst = null;
      this.perpFirst = null;
      this.angleFirst = null;
      this.anglePoints = null;
      this.symPointA = undefined;
      this.symAxis = null;
    this.coincidentFirst = undefined;
      this.dimFirstPoint = undefined;
      this.hint = TOOL_HINT[this.tool];
      this.preview = null;
      this.endCommand();
      this.draw();
      return;
    }
    this.selection = this.emptySelection();
    this.refresh();
  }

  // ----- eventos -----
  private bindEvents(): void {
    document.querySelectorAll('.tool-buttons').forEach((group) => {
      group.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
        if (btn?.dataset.tool) this.setTool(btn.dataset.tool as Tool);
      });
    });

    document.getElementById('undo-btn')!.addEventListener('click', () => this.undo());
    document.getElementById('redo-btn')!.addEventListener('click', () => this.redo());
    document.getElementById('fit-btn')!.addEventListener('click', () => { this.fitView(); this.draw(); });
    document.getElementById('clear-btn')!.addEventListener('click', () => {
      this.beginCommand();
      this.doc.clear();
      this.endCommand();
      this.selection = this.emptySelection();
      this.lineStart = null;
      this.circleCenter = null;
      this.arcState = null;
      this.tangentFirst = null;
      this.perpFirst = null;
      this.angleFirst = null;
      this.anglePoints = null;
      this.symPointA = undefined;
      this.symAxis = null;
    this.coincidentFirst = undefined;
      this.dimFirstPoint = undefined;
      this.fitView();
      this.solveAndRefresh();
    });

    for (const id of ['entity-list', 'constraint-list']) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const del = target.closest<HTMLElement>('[data-del]');
        if (del) {
          this.deleteEntity(del.dataset.kind!, Number(del.dataset.del));
          return;
        }
        const row = target.closest<HTMLElement>('[data-kind]');
        if (row) this.setSelection(row.dataset.kind as 'point' | 'line' | 'curve' | 'constraint', Number(row.dataset.id));
      });
    }

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverPoint = undefined; this.draw(); });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('dblclick', (e) => {
      const s = this.toScreen(e);
      const cid = hitTestConstraint(this.doc, this.view, s.x, s.y);
      if (cid !== undefined) this.openDimensionEditor(cid, true);
    });

    this.dimInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commitEditor(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEditor(); this.draw(); }
    });
    this.dimInput.addEventListener('blur', () => this.commitEditor());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
      if (e.key === 'Escape') { this.cancel(); return; }
      if (e.key === ' ') { e.preventDefault(); this.spaceDown = true; return; }
      if (k === 'v') this.setTool('select');
      else if (k === 'p') this.setTool('point');
      else if (k === 'l') this.setTool('line');
      else if (k === 'c') this.setTool('circle');
      else if (k === 'a') this.setTool('arc');
      else if (k === 'd') this.setTool('dimension');
      else if (k === 't') this.setTool('tangent');
      else if (k === 'e') this.setTool('perpendicular');
      else if (k === 'g') this.setTool('angle');
      else if (k === 'i') this.setTool('angleInternal');
      else if (k === 's') this.setTool('symmetry');
      else if (k === 'x') this.setTool('trim');
      else if (k === 'o') this.setTool('coincident');
      else if (k === 'f') { this.fitView(); this.draw(); }
      else if (k === 'r' && this.tool === 'arc') {
        this.arcCcw = !this.arcCcw;
        if (this.arcState) this.arcState.ccw = this.arcCcw;
        this.hint = `Arco: sentido ${this.arcCcw ? 'anti-horário (↺)' : 'horário (↻)'} · R inverte`;
        this.draw();
      }
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this.spaceDown = false; });
    window.addEventListener('resize', () => { this.resize(); this.draw(); });
  }
}

new SketcherApp();
