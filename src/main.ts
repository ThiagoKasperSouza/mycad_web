import './style.css';
import { SketchDocument } from './core/sketch';
import { solve } from './core/solver';
import type { EntityRef, Snapshot, Tool } from './core/types';
import {
  hitTestConstraint, hitTestCurve, hitTestEntity, hitTestLine, hitTestPoint, render,
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
  pan: 'Pan',
};

const TOOL_HINT: Record<Tool, string> = {
  select: 'Clique para selecionar · Arraste pontos para mover · Delete remove',
  point: 'Clique para posicionar pontos',
  line: 'Clique para definir o início da linha',
  circle: 'Clique no centro, depois no raio',
  arc: 'Clique centro → início → fim · R inverte o sentido',
  dimension: 'Clique em linha/círculo/arco ou em dois pontos · Shift+clique na curva = diâmetro',
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

  constructor() {
    this.bindEvents();
    this.resize();
    this.fitView();
    this.refresh();
  }

  private emptySelection(): Selection {
    return { points: new Set(), lines: new Set(), curves: new Set(), constraints: new Set() };
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
    this.draw();
    this.updateInspector();
  }

  private solveAndRefresh(): void {
    this.solverInfo = solve(this.doc);
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
      else label = `diâmetro = ${this.fmt(c.value)}`;
      return this.row('constraint', c.id, `C${c.id} &nbsp; ${label}`, '', this.selection.constraints.has(c.id));
    });
    constraintList.innerHTML = constraintRows.join('') || '<div class="empty">Nenhuma restrição</div>';
    document.getElementById('constraint-count')!.textContent = String(constraintRows.length);
  }

  private fmt(v: number): string { return String(Math.round(v * 100) / 100); }

  private row(kind: string, id: number, label: string, tag: string, selected: boolean): string {
    return `<div class="row${selected ? ' sel' : ''}" data-kind="${kind}" data-id="${id}">
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

    if (c && (c.type === 'distance' || c.type === 'radius' || c.type === 'diameter')
        && Number.isFinite(raw) && raw > 0) {
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
    if (this.lineStart || this.circleCenter || this.arcState || this.dimFirstPoint !== undefined) {
      this.lineStart = null;
      this.circleCenter = null;
      this.arcState = null;
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
    document.getElementById('tool-group')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
      if (btn?.dataset.tool) this.setTool(btn.dataset.tool as Tool);
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
