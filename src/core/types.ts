/** Ferramentas disponíveis no sketcher. */
export type Tool = 'select' | 'point' | 'line' | 'circle' | 'arc'
  | 'dimension' | 'tangent' | 'perpendicular' | 'angle' | 'angleInternal' | 'symmetry'
  | 'trim' | 'coincident' | 'polygon' | 'fillet' | 'pan';

/** Ponto 2D. `fixed` e origin ancoram o sketch (não são movidos pelo solver). */
export interface PointEntity {
  id: number;
  x: number;
  y: number;
  fixed: boolean;
}

/** Segmento de reta definido por dois pontos (por id). */
export interface LineEntity {
  id: number;
  a: number;
  b: number;
}

/**
 * Círculo definido por centro + ponto na circunferência.
 * O raio é derivado da distância entre eles, então o solver já sabe movê-lo.
 */
export interface CircleEntity {
  id: number;
  center: number; // id do ponto
  rim: number;    // id do ponto na circunferência
}

/**
 * Arco definido por centro + dois pontos extremos.
 * O raio é derivado de center→a; o sentido `ccw` define o arco percorrido
 * de a até b (sentido anti-horário no mundo, onde Y aponta para cima).
 */
export interface ArcEntity {
  id: number;
  center: number;
  a: number;
  b: number;
  ccw: boolean;
}

/** Referência a uma entidade (para restrições entre duas entidades). */
export type EntityKind = 'line' | 'circle' | 'arc';
export interface EntityRef { kind: EntityKind; id: number; }
export type TangentMode = 'external' | 'internal';

/** Restrições suportadas. */
export type Constraint =
  | { id: number; type: 'distance'; a: number; b: number; value: number }
  | { id: number; type: 'horizontal'; line: number }
  | { id: number; type: 'vertical'; line: number }
  | { id: number; type: 'radius'; entity: number; value: number }
  | { id: number; type: 'diameter'; entity: number; value: number }
  | { id: number; type: 'tangent'; a: EntityRef; b: EntityRef; mode: TangentMode }
  | { id: number; type: 'perpendicular'; a: EntityRef; b: EntityRef }
  | { id: number; type: 'angle'; a: EntityRef; b: EntityRef; value: number } // graus, dirigido
  | { id: number; type: 'angle3'; a: number; vertex: number; b: number; value: number } // interno, 0–180°
  | { id: number; type: 'symmetry'; a: number; axis: EntityRef; b: number }
  | { id: number; type: 'coincident'; a: number; b: number };

/** Entrada para criação de restrição (sem id). */
export type ConstraintInput =
  | { type: 'distance'; a: number; b: number; value: number }
  | { type: 'horizontal'; line: number }
  | { type: 'vertical'; line: number }
  | { type: 'radius'; entity: number; value: number }
  | { type: 'diameter'; entity: number; value: number }
  | { type: 'tangent'; a: EntityRef; b: EntityRef; mode: TangentMode }
  | { type: 'perpendicular'; a: EntityRef; b: EntityRef }
  | { type: 'angle'; a: EntityRef; b: EntityRef; value: number }
  | { type: 'angle3'; a: number; vertex: number; b: number; value: number }
  | { type: 'symmetry'; a: number; axis: EntityRef; b: number }
  | { type: 'coincident'; a: number; b: number };

/** Tipo de entidade curva (para hit-testing e remoção). */
export type CurveKind = 'circle' | 'arc';

/** Serialização completa do documento (usada por undo/redo). */
export interface Snapshot {
  points: PointEntity[];
  lines: LineEntity[];
  circles: CircleEntity[];
  arcs: ArcEntity[];
  constraints: Constraint[];
  nextId: number;
  originId: number;
}
