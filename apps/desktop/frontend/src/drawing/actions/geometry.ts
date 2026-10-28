// Geometry and patch-building helpers shared by the layout/shape actions. Excalidraw does not
// reposition the text bound to a container when a scene is updated from outside, so moving or
// resizing a container here moves/re-centers its text too.
import { edgePoint, shapeKind } from './factory';
import { selectedElements, type SceneContext, type SceneElement, type ScenePatch } from './types';

export const num = (e: SceneElement, key: string): number => {
  const v = e[key];
  return typeof v === 'number' ? v : 0;
};

/** Text bound to a container (its label). */
export function boundTextOf(ctx: SceneContext, container: SceneElement): SceneElement[] {
  return ctx.elements.filter(
    (e) => e.type === 'text' && e.containerId === container.id && !e.isDeleted,
  );
}

/**
 * Selected elements an arrangement applies to. Bound labels follow their container, and arrows
 * follow the shapes they are bound to, so neither is arranged on its own.
 */
export function arrangeable(ctx: SceneContext): SceneElement[] {
  return selectedElements(ctx).filter(
    (e) => e.type !== 'arrow' && !(e.type === 'text' && typeof e.containerId === 'string'),
  );
}

export type Point = [number, number];

/** Width and height of a polyline (arrow/line points are relative to the element's x, y). */
export function extent(points: readonly Point[]): { width: number; height: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

const pointsOf = (e: SceneElement): Point[] =>
  Array.isArray(e.points) ? (e.points as Point[]).map(([x, y]) => [x, y]) : [];

const boundTo = (binding: unknown, id: string): boolean =>
  typeof binding === 'object' &&
  binding !== null &&
  (binding as { elementId?: unknown }).elementId === id;

export class PatchBuilder {
  private readonly update: Record<string, Record<string, unknown>> = {};
  /** Latest known geometry by id, so several steps compose. */
  private readonly geo = new Map<string, { x: number; y: number; width: number; height: number }>();

  constructor(private readonly ctx: SceneContext) {}

  private geometry(e: SceneElement) {
    let g = this.geo.get(e.id);
    if (!g) {
      g = { x: num(e, 'x'), y: num(e, 'y'), width: num(e, 'width'), height: num(e, 'height') };
      this.geo.set(e.id, g);
    }
    return g;
  }

  /** Current geometry (with pending changes). */
  at(e: SceneElement): { x: number; y: number; width: number; height: number } {
    return { ...this.geometry(e) };
  }

  /** Pending state of arrows that follow a moved element. */
  private readonly arrows = new Map<string, { x: number; y: number; points: Point[] }>();

  /**
   * Arrows bound to a moved element keep their attachment: the bound end moves with it, the other
   * end stays. (Excalidraw only re-routes bound arrows for edits made in the editor itself.)
   */
  private dragArrows(id: string, dx: number, dy: number): void {
    for (const a of this.ctx.elements) {
      if (a.type !== 'arrow' || a.isDeleted || a.elbowed === true) continue;
      const start = boundTo(a.startBinding, id);
      const end = boundTo(a.endBinding, id);
      if (!start && !end) continue;
      let st = this.arrows.get(a.id);
      if (!st) {
        st = { x: num(a, 'x'), y: num(a, 'y'), points: pointsOf(a) };
        this.arrows.set(a.id, st);
      }
      if (st.points.length < 2) continue;
      if (start) {
        st.x += dx;
        st.y += dy;
        st.points = st.points.map((p, i): Point => (i === 0 ? p : [p[0] - dx, p[1] - dy]));
      }
      if (end) {
        const last = st.points.length - 1;
        st.points = st.points.map((p, i): Point => (i === last ? [p[0] + dx, p[1] + dy] : p));
      }
      this.put(a.id, { x: st.x, y: st.y, points: st.points, ...extent(st.points) });
    }
  }

  /**
   * After a resize the bound ends of arrows are put back on the shape's outline, on the line to
   * the arrow's other end (a move is handled by `dragArrows`).
   */
  private rerouteArrows(e: SceneElement): void {
    const g = this.geometry(e);
    const kind = shapeKind(e);
    for (const a of this.ctx.elements) {
      if (a.type !== 'arrow' || a.isDeleted || a.elbowed === true) continue;
      const start = boundTo(a.startBinding, e.id);
      const end = boundTo(a.endBinding, e.id);
      if (!start && !end) continue;
      const st = this.arrows.get(a.id) ?? { x: num(a, 'x'), y: num(a, 'y'), points: pointsOf(a) };
      if (st.points.length < 2) continue;
      const abs = st.points.map((p): Point => [p[0] + st.x, p[1] + st.y]);
      if (start) {
        const to = abs[1] as Point;
        const p = edgePoint(g, kind, to[0], to[1]);
        abs[0] = [p.x, p.y];
      }
      if (end) {
        const to = abs[abs.length - 2] as Point;
        const p = edgePoint(g, kind, to[0], to[1]);
        abs[abs.length - 1] = [p.x, p.y];
      }
      const o = abs[0] as Point;
      const points = abs.map((p): Point => [p[0] - o[0], p[1] - o[1]]);
      this.arrows.set(a.id, { x: o[0], y: o[1], points });
      this.put(a.id, { x: o[0], y: o[1], points, ...extent(points) });
    }
  }

  private put(id: string, props: Record<string, unknown>): void {
    this.update[id] = { ...this.update[id], ...props };
  }

  /** Moves an element (and its bound text) to x, y. */
  moveTo(e: SceneElement, x: number, y: number): void {
    const g = this.geometry(e);
    const dx = x - g.x;
    const dy = y - g.y;
    if (dx === 0 && dy === 0) return;
    g.x = x;
    g.y = y;
    this.put(e.id, { x, y });
    for (const t of boundTextOf(this.ctx, e)) {
      const tg = this.geometry(t);
      tg.x += dx;
      tg.y += dy;
      this.put(t.id, { x: tg.x, y: tg.y });
    }
    this.dragArrows(e.id, dx, dy);
  }

  /** Sets position and size, keeping bound text centered in the container. */
  setBox(e: SceneElement, box: { x: number; y: number; width: number; height: number }): void {
    const g = this.geometry(e);
    Object.assign(g, box);
    this.put(e.id, { ...box });
    for (const t of boundTextOf(this.ctx, e)) {
      const tg = this.geometry(t);
      tg.x = box.x + (box.width - tg.width) / 2;
      tg.y = box.y + (box.height - tg.height) / 2;
      this.put(t.id, { x: tg.x, y: tg.y });
    }
    this.rerouteArrows(e);
  }

  /** Sets position and size of the container only; its text stays where it is. */
  setBoxKeepingText(
    e: SceneElement,
    box: { x: number; y: number; width: number; height: number },
  ): void {
    Object.assign(this.geometry(e), box);
    this.put(e.id, { ...box });
    this.rerouteArrows(e);
  }

  build(): ScenePatch {
    // Drop no-op updates so an action that changes nothing writes nothing.
    const update: Record<string, Record<string, unknown>> = {};
    for (const [id, props] of Object.entries(this.update)) {
      const el = this.ctx.elements.find((e) => e.id === id);
      const changed = Object.entries(props).some(([k, v]) => el?.[k] !== v);
      if (changed) update[id] = props;
    }
    return { update };
  }
}
