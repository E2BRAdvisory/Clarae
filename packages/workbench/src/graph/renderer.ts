// Canvas 2D renderer of the graph. Edges are stroked in one path and nodes filled in one path
// per colour class, so a frame costs a handful of draw calls even with 10k nodes. Labels are
// drawn in screen space (constant size) above a zoom threshold, most connected first.
import { CLASS_ATTACHMENT, CLASS_GHOST, CLASS_GROUP, CLASS_NOTE, CLASS_TAG } from './model';
import type { GraphModel } from './model';
import { hitTest, type View } from './view';

export interface Palette {
  bg: string;
  text: string;
  muted: string;
  faint: string;
  edge: string;
  accent: string;
  success: string;
  font: string;
  /** Colours of the user's colour groups, by group index. */
  groups: string[];
}

export const fallbackPalette: Palette = {
  bg: '#ffffff',
  text: '#1d1d1f',
  muted: '#6e6e73',
  faint: '#a1a1a6',
  edge: '#a1a1a6',
  accent: '#159992',
  success: '#2e8b57',
  font: 'sans-serif',
  groups: [],
};

/** Reads the palette from the theme's CSS tokens (styles/tokens.css): nothing is hard-coded. */
export function readPalette(el: Element, groups: string[]): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string): string => cs.getPropertyValue(name).trim() || fb;
  const f = fallbackPalette;
  return {
    bg: v('--bg', f.bg),
    text: v('--text', f.text),
    muted: v('--text-muted', f.muted),
    faint: v('--text-faint', f.faint),
    edge: v('--border', f.edge),
    accent: v('--accent-bright', v('--accent', f.accent)),
    success: v('--success', f.success),
    font: v('--font-ui', f.font),
    groups,
  };
}

export interface FrameStats {
  ms: number;
  nodes: number;
  edges: number;
  labels: number;
}

const MAX_LABELS = 400;
const DIM_ALPHA = 0.12;

export class GraphRenderer {
  view: View = { k: 1, x: 0, y: 0 };
  positions: Float32Array = new Float32Array(0);
  palette: Palette = fallbackPalette;
  labelZoom = 1.2;
  private model: GraphModel | null = null;
  private visible: Uint8Array | null = null;
  private hover = -1;
  private selected = -1;
  private focusSet: Uint8Array | null = null;
  private byClass: Int32Array[] = [];
  private byDegree: Int32Array = new Int32Array(0);
  private w = 0;
  private h = 0;
  private dpr = 1;
  private readonly ctx: CanvasRenderingContext2D;
  last: FrameStats = { ms: 0, nodes: 0, edges: 0, labels: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2D is not available');
    this.ctx = ctx;
  }

  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
  }

  setModel(model: GraphModel | null): void {
    this.model = model;
    this.hover = -1;
    this.selected = -1;
    this.focusSet = null;
    this.visible = null;
    const n = model?.n ?? 0;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const c = (model as GraphModel).cls[i] as number;
      const b = buckets.get(c);
      if (b) b.push(i);
      else buckets.set(c, [i]);
    }
    this.byClass = [];
    for (const [c, list] of buckets) this.byClass[c] = Int32Array.from(list);
    this.byDegree = Int32Array.from({ length: n }, (_, i) => i).sort(
      (a, b) =>
        ((model as GraphModel).degree[b] as number) - ((model as GraphModel).degree[a] as number),
    );
  }

  setVisible(mask: Uint8Array | null): void {
    this.visible = mask;
  }

  /** Highlights a node and its neighbours (-1 clears). */
  setHover(i: number): void {
    this.hover = i;
    if (i < 0 || !this.model) {
      this.focusSet = null;
      return;
    }
    const m = this.model;
    const set = new Uint8Array(m.n);
    set[i] = 1;
    for (let k = m.off[i] as number; k < (m.off[i + 1] as number); k++) set[m.adj[k] as number] = 1;
    this.focusSet = set;
  }

  get hovered(): number {
    return this.hover;
  }

  setSelected(i: number): void {
    this.selected = i;
  }

  hit(sx: number, sy: number): number {
    const m = this.model;
    if (!m) return -1;
    return hitTest(this.view, this.positions, m.radius, m.n, this.visible, sx, sy);
  }

  private colorOf(c: number): string {
    const p = this.palette;
    if (c >= CLASS_GROUP) return p.groups[c - CLASS_GROUP] ?? p.accent;
    switch (c) {
      case CLASS_GHOST:
        return p.faint;
      case CLASS_ATTACHMENT:
        return p.success;
      case CLASS_TAG:
        return p.accent;
      case CLASS_NOTE:
      default:
        return p.muted;
    }
  }

  private snap: HTMLCanvasElement | null = null;
  private snapView: View = { k: 1, x: 0, y: 0 };

  get gesturing(): boolean {
    return this.snap !== null;
  }

  /**
   * Pan/zoom gestures: the current picture is kept as a bitmap and merely transformed while
   * the gesture lasts (a few ms per frame whatever the graph size); endGesture() returns to
   * exact drawing.
   */
  startGesture(): void {
    if (this.snap) return;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.getContext('2d')?.drawImage(this.canvas, 0, 0);
    this.snap = c;
    this.snapView = { ...this.view };
  }

  endGesture(): void {
    this.snap = null;
  }

  /** Draws the gesture bitmap under the current view. */
  quickDraw(): FrameStats {
    const t0 = performance.now();
    const { ctx, view: v, dpr, w, h, snap } = this;
    if (!snap) return this.draw();
    const f = v.k / this.snapView.k;
    const dx = v.x - this.snapView.x * f;
    const dy = v.y - this.snapView.y * f;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(dpr * f, 0, 0, dpr * f, dpr * dx, dpr * dy);
    ctx.drawImage(snap, 0, 0, w, h);
    this.last = { ms: performance.now() - t0, nodes: 0, edges: 0, labels: 0 };
    return this.last;
  }

  /** Forces pending canvas commands to be rasterised (benchmarks: JS time alone hides raster cost). */
  flush(): void {
    this.ctx.getImageData(0, 0, 1, 1);
  }

  draw(): FrameStats {
    const t0 = performance.now();
    const { ctx, view: v, w, h, dpr, palette: p } = this;
    const m = this.model;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, w, h);
    if (!m || m.n === 0 || this.positions.length < m.n * 2) {
      this.last = { ms: performance.now() - t0, nodes: 0, edges: 0, labels: 0 };
      return this.last;
    }
    const pos = this.positions;
    const vis = this.visible;
    const focus = this.focusSet;
    // Viewport in world coordinates, with a margin of the largest node radius.
    const mx = 20 / v.k;
    const x0 = -v.x / v.k - mx;
    const y0 = -v.y / v.k - mx;
    const x1 = (w - v.x) / v.k + mx;
    const y1 = (h - v.y) / v.k + mx;
    const inView = (i: number): boolean => {
      const x = pos[2 * i] as number;
      const y = pos[2 * i + 1] as number;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    };

    ctx.setTransform(dpr * v.k, 0, 0, dpr * v.k, dpr * v.x, dpr * v.y);

    // ---- edges
    let edgeCount = 0;
    const strokeEdges = (only: 'all' | 'focus' | 'dim', color: string, alpha: number): void => {
      ctx.beginPath();
      for (let e = 0; e < m.edges.length; e += 2) {
        const s = m.edges[e] as number;
        const t = m.edges[e + 1] as number;
        if (vis && (!vis[s] || !vis[t])) continue;
        if (only !== 'all' && focus) {
          const hot = s === this.hover || t === this.hover;
          if ((only === 'focus') !== hot) continue;
        }
        const sx = pos[2 * s] as number;
        const sy = pos[2 * s + 1] as number;
        const tx = pos[2 * t] as number;
        const ty = pos[2 * t + 1] as number;
        if (
          (sx < x0 && tx < x0) ||
          (sx > x1 && tx > x1) ||
          (sy < y0 && ty < y0) ||
          (sy > y1 && ty > y1)
        )
          continue;
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        edgeCount++;
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      // Exactly one device pixel: Skia strokes such "hairlines" on a fast path; wider lines on tens of thousands of segments are ~50x slower on CPU rasterisers.
      ctx.lineWidth = (only === 'focus' ? 2 : 1) / (v.k * dpr);
      ctx.stroke();
    };
    if (focus) {
      strokeEdges('dim', p.edge, 0.12);
      strokeEdges('focus', p.accent, 0.9);
    } else {
      strokeEdges('all', p.edge, 0.55);
    }

    // ---- nodes
    let nodeCount = 0;
    const fillNodes = (inFocus: boolean, alpha: number): void => {
      ctx.globalAlpha = alpha;
      for (let c = 0; c < this.byClass.length; c++) {
        const list = this.byClass[c];
        if (!list) continue;
        ctx.beginPath();
        for (let q = 0; q < list.length; q++) {
          const i = list[q] as number;
          if (vis && !vis[i]) continue;
          if (focus && (focus[i] === 1) !== inFocus) continue;
          if (!inView(i)) continue;
          const x = pos[2 * i] as number;
          const y = pos[2 * i + 1] as number;
          const r = m.radius[i] as number;
          // Nodes under ~5 px wide are squares: about half the raster cost of arcs and indistinguishable.
          if (r * v.k < 2.5) {
            const hs = Math.max(r, 0.75 / v.k);
            ctx.rect(x - hs, y - hs, 2 * hs, 2 * hs);
          } else {
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
          nodeCount++;
        }
        ctx.fillStyle = this.colorOf(c);
        ctx.fill();
      }
    };
    if (focus) {
      fillNodes(false, DIM_ALPHA);
      fillNodes(true, 1);
    } else {
      fillNodes(true, 1);
    }
    ctx.globalAlpha = 1;
    // Hovered and selected node: accent ring.
    for (const i of [this.selected, this.hover]) {
      if (i < 0 || (vis && !vis[i])) continue;
      ctx.beginPath();
      ctx.arc(
        pos[2 * i] as number,
        pos[2 * i + 1] as number,
        (m.radius[i] as number) + 2 / v.k,
        0,
        Math.PI * 2,
      );
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 2 / v.k;
      ctx.stroke();
    }

    // ---- labels (screen space)
    let labels = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const showAll = v.k >= this.labelZoom;
    const fade = Math.min(1, (v.k - this.labelZoom) / (0.35 * this.labelZoom) + 0.0001);
    if (showAll || focus) {
      ctx.font = `12px ${p.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = p.text;
      for (let q = 0; q < this.byDegree.length && labels < MAX_LABELS; q++) {
        const i = this.byDegree[q] as number;
        const hot = focus ? focus[i] === 1 : false;
        if (!hot && (!showAll || focus)) continue;
        if (vis && !vis[i]) continue;
        if (!inView(i)) continue;
        const sx = (pos[2 * i] as number) * v.k + v.x;
        const sy = (pos[2 * i + 1] as number) * v.k + v.y + (m.radius[i] as number) * v.k + 3;
        ctx.globalAlpha = hot ? 1 : Math.max(0, fade);
        ctx.fillText(m.data.nodes[i]?.label ?? '', sx, sy);
        labels++;
      }
      ctx.globalAlpha = 1;
    }
    this.last = { ms: performance.now() - t0, nodes: nodeCount, edges: edgeCount, labels };
    return this.last;
  }
}
