// The 3D scene of the graph, on 3d-force-graph (three.js). The library gives the renderer, the
// camera with its orbit controls, picking and dragging of the nodes; three things are done here
// instead, the conditions the M18-D0 spike set (ADR-0055):
//  - the links are one LineSegments, not an object each: a draw call for all of them;
//  - the layout is not the library's: positions come from the layout worker (layoutHost), and the
//    library's own simulation is left without forces and never ticks;
//  - above SPRITE_NODES nodes the nodes are a Points per look instead of a Sprite each.
// Nothing here is React: Graph3D.tsx owns the instance and feeds it.
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from '3d-force-graph';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  LineBasicMaterial,
  LineSegments,
  type PerspectiveCamera,
  Points,
  PointsMaterial,
  Spherical,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { ICON_DATA, type IconPath } from '../../shell/iconData';
import type { IconName } from '../../shell/icons';
import { boundsOf, fitDistance, planLinks, writeLinks, type LinkPlan } from '../geometry3d';
import { kindIcon, nodeKind } from '../kinds';
import type { GraphModel } from '../model';
import { classColor, fallbackPalette, neighbourSet, type Palette } from '../renderer';

/** Up to this many nodes each one is a sprite the user can drag; beyond, points (a draw call per look). */
export const SPRITE_NODES = 2000;
export type Lod = 'sprite' | 'points';

const TEXTURE_PX = 64;
const LINK_OPACITY = 0.8;
const DIM_LINK_OPACITY = 0.25;
const DIM_NODE_OPACITY = 0.15;
/** The scene stops rendering this long after the last thing that changed it. */
const IDLE_MS = 1500;
const MAX_LABELS = 40;
/** The most connected nodes that may get a label (plus the current node and its neighbours). */
const LABEL_CANDIDATES = 200;
/** Distance from the camera within which labels show, at label zoom 1. */
const LABEL_RANGE = 520;
/** How close to a point, in px, the pointer picks it. */
const PICK_PX = 12;
/** Distance of the camera from a node it flies to. */
const FOCUS_DISTANCE = 220;

export interface SceneEvents {
  /** A click on a node (-1: on the background). */
  onClick(index: number, newTab: boolean): void;
  /** A node follows the pointer. */
  onDrag(index: number, x: number, y: number, z: number): void;
  onDragEnd(index: number, x: number, y: number, z: number): void;
  /** The user turned, moved or zoomed the camera. */
  onUserMove(): void;
  /** The GPU took the context back: the scene cannot draw any more. */
  onContextLost(): void;
}

/** What the E2E builds can ask a scene (window.__graph3d): never present in a release. */
export interface Graph3DProbe {
  lod(): Lod;
  nodes(): number;
  drawCalls(): number;
  contextLost(): boolean;
  /** Frames the renderer has drawn so far: the count stands still while the scene is at rest. */
  rendered(): number;
  /** Where a node is on the page, null when it is behind the camera. */
  pageOf(index: number): { x: number; y: number } | null;
  /** Milliseconds between the frames rendered since the last call. */
  takeFrames(): number[];
}

declare global {
  interface Window {
    __graph3d?: Graph3DProbe;
  }
}

interface SceneNode extends NodeObject {
  id: string;
  /** Index in the model. */
  i: number;
}

interface PointGroup {
  obj: Points;
  /** The nodes of the group, oldest first: the timelapse shows a prefix of them. */
  nodes: Int32Array;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class GraphScene {
  /** Positions of the nodes, x0,y0,z0,x1,… (what the layout last sent). */
  positions: Float32Array = new Float32Array(0);
  labelZoom = 1.2;
  private readonly g: ForceGraph3DInstance;
  private readonly camera: PerspectiveCamera;
  private readonly labelLayer: HTMLDivElement;
  private readonly spans: HTMLSpanElement[] = [];
  private readonly spanText: string[] = [];
  private readonly resizeObserver: ResizeObserver;
  private model: GraphModel | null = null;
  private palette: Palette = fallbackPalette;
  private lod: Lod = 'sprite';
  private curved = true;
  private visible: Uint8Array | null = null;
  private hover = -1;
  private selected = -1;
  private dragging = -1;
  /** The node whose neighbourhood is lit, and that neighbourhood. */
  private lit: Uint8Array | null = null;
  // sprite level
  private nodes: SceneNode[] = [];
  private sprites: (Sprite | undefined)[] = [];
  // points level
  private groups: PointGroup[] = [];
  /** Look of each node: the key of its texture. */
  private looks: string[] = [];
  private readonly textures = new Map<string, CanvasTexture>();
  private readonly materials = new Map<string, SpriteMaterial>();
  private readonly dimMaterials = new Map<string, SpriteMaterial>();
  private plan: LinkPlan | null = null;
  private links: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  private glow: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  private ring: Sprite | null = null;
  private byDegree: Int32Array = new Int32Array(0);
  private labelStamp: Uint32Array = new Uint32Array(0);
  private stamp = 0;
  private width = 1;
  private height = 1;
  private raf = 0;
  /** The library's render loop is running (it is paused at rest). */
  private running = false;
  private awakeUntil = 0;
  /** Where the pointer went down, and whether on a node (a drag of the node, not of the camera). */
  private pointerDown: { x: number; y: number; onNode: boolean } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private lastFrame = 0;
  private frames: number[] = [];
  private disposed = false;
  private readonly v = new Vector3();
  private readonly probe: Graph3DProbe | null = null;

  /** Throws when the device cannot give a WebGL context. */
  constructor(
    private readonly el: HTMLElement,
    private readonly events: SceneEvents,
  ) {
    const g = new ForceGraph3D(el, {
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: false, powerPreference: 'default' },
    });
    this.g = g;
    this.camera = g.camera() as PerspectiveCamera;
    this.width = Math.max(1, el.clientWidth);
    this.height = Math.max(1, el.clientHeight);
    g.width(this.width).height(this.height);
    g.showNavInfo(false);
    g.nodeLabel(() => ''); // the library's tooltip takes HTML: labels are drawn here, as text
    // The layout is the worker's. The library's simulation keeps no force and gets no tick: it
    // only ever copies the coordinates of the nodes, which are written here, to their objects.
    g.d3Force('link', null).d3Force('charge', null).d3Force('center', null);
    g.warmupTicks(0).cooldownTicks(0);
    g.nodeThreeObject((node) => this.sprite((node as SceneNode).i));
    g.onNodeHover((node) => this.setHover(node ? (node as SceneNode).i : -1));
    g.onNodeClick((node, e) => {
      const i = (node as SceneNode).i;
      // Never a node the timelapse hides: what is drawn under the pointer, if anything.
      const at = this.shown(i) ? i : this.pick(this.local(e).x, this.local(e).y);
      this.events.onClick(at, e.metaKey || e.ctrlKey);
    });
    // The library reports the object it last found under the pointer, which it looks for a few
    // times a second: a click right after the pointer moved is "on the background" for it.
    g.onBackgroundClick((e) => {
      // Points are not the library's objects: their clicks are all "on the background" for it,
      // and are reported once, by onPointerUp.
      if (this.lod === 'points') return;
      const p = this.local(e);
      this.events.onClick(this.pick(p.x, p.y), e.metaKey || e.ctrlKey);
    });
    g.onNodeDrag((node) => {
      const n = node as SceneNode;
      this.dragging = n.i;
      this.moveNode(n.i, n.x ?? 0, n.y ?? 0, n.z ?? 0);
      this.events.onDrag(n.i, n.x ?? 0, n.y ?? 0, n.z ?? 0);
    });
    g.onNodeDragEnd((node) => {
      const n = node as SceneNode;
      this.dragging = -1;
      this.events.onDragEnd(n.i, n.x ?? 0, n.y ?? 0, n.z ?? 0);
    });

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'graph3d-labels';
    this.labelLayer.setAttribute('aria-hidden', 'true');
    el.append(this.labelLayer);

    const canvas = g.renderer().domElement;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    el.addEventListener('pointerdown', this.onPointerDown, true);
    el.addEventListener('pointermove', this.onPointerMove, true);
    el.addEventListener('pointerup', this.onPointerUp, true);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    this.resizeObserver = new ResizeObserver(() => {
      this.width = Math.max(1, el.clientWidth);
      this.height = Math.max(1, el.clientHeight);
      g.width(this.width).height(this.height);
      this.wake();
    });
    this.resizeObserver.observe(el);

    if (import.meta.env.CLARAE_E2E) {
      this.probe = {
        lod: () => this.lod,
        nodes: () => this.model?.n ?? 0,
        drawCalls: () => g.renderer().info.render.calls,
        contextLost: () => g.renderer().getContext().isContextLost(),
        rendered: () => g.renderer().info.render.frame,
        pageOf: (i) => {
          const p = this.screenOf(i);
          if (!p) return null;
          const box = el.getBoundingClientRect();
          return { x: box.left + p.x, y: box.top + p.y };
        },
        takeFrames: () => this.frames.splice(0),
      };
      window.__graph3d = this.probe;
    }
    this.wake();
  }

  // ---- rendering only while something changes

  /** Keeps the scene rendering for a while: called by whatever changes what is on screen. */
  wake(ms = IDLE_MS): void {
    if (this.disposed) return;
    this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms);
    if (this.raf === 0) this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    if (!this.running) {
      // Resumed here, on a frame, not where wake() is called: the library renders and looks for
      // the object under the pointer at once, and a pointer event that wakes the scene reaches the
      // library's own listener, which records where the pointer is, only after ours.
      this.running = true;
      this.g.resumeAnimation();
    }
    const now = performance.now();
    if (this.probe && this.lastFrame > 0) this.frames.push(now - this.lastFrame);
    this.lastFrame = now;
    if (this.lod === 'points' && this.pointer && !this.pointerDown) {
      this.setHover(this.pick(this.pointer.x, this.pointer.y));
    }
    this.updateLabels();
    if (now >= this.awakeUntil && !this.pointerDown) {
      // At rest: no frame is rendered until something changes again.
      this.g.pauseAnimation();
      this.running = false;
      this.lastFrame = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  // ---- colours

  /** The colours of the theme: everything drawn here is redrawn with them. */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.g.backgroundColor(cssHex(palette.bg));
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.dimMaterials.values()) m.dispose();
    this.textures.clear();
    this.materials.clear();
    this.dimMaterials.clear();
    this.links?.material.color.set(cssHex(palette.edge));
    this.glow?.material.color.set(cssHex(palette.accent));
    this.ring?.material.map?.dispose();
    this.ring?.material.dispose();
    if (this.ring) this.ring.material = this.ringMaterial();
    this.restyleNodes();
    this.wake();
  }

  private look(i: number): string {
    const m = this.model as GraphModel;
    const nd = m.data.nodes[i] as { kind: string; path: string };
    return `${cssHex(classColor(this.palette, m.cls[i] as number))}|${kindIcon(nodeKind(nd))}`;
  }

  /** The disc of a node: its colour, with the icon of its kind of document cut in the background colour. */
  private texture(look: string): CanvasTexture {
    let t = this.textures.get(look);
    if (t) return t;
    const [color, icon] = look.split('|') as [string, IconName];
    const c = document.createElement('canvas');
    c.width = c.height = TEXTURE_PX;
    const ctx = c.getContext('2d');
    if (ctx) {
      const half = TEXTURE_PX / 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(half, half, half - 2, 0, Math.PI * 2);
      ctx.fill();
      // The 24 px icon, drawn at 36 px in the middle of the disc.
      ctx.translate(half - 18, half - 18);
      ctx.scale(1.5, 1.5);
      ctx.fillStyle = cssHex(this.palette.bg);
      for (const [d, opacity] of ICON_DATA[icon] as readonly IconPath[]) {
        ctx.globalAlpha = opacity ?? 1;
        ctx.fill(new Path2D(d));
      }
    }
    t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    this.textures.set(look, t);
    return t;
  }

  private material(look: string, dim: boolean): SpriteMaterial {
    const cache = dim ? this.dimMaterials : this.materials;
    let m = cache.get(look);
    if (!m) {
      m = new SpriteMaterial({
        map: this.texture(look),
        transparent: true,
        depthWrite: false,
        opacity: dim ? DIM_NODE_OPACITY : 1,
      });
      cache.set(look, m);
    }
    return m;
  }

  private ringMaterial(): SpriteMaterial {
    const c = document.createElement('canvas');
    c.width = c.height = TEXTURE_PX;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = cssHex(this.palette.accent);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(TEXTURE_PX / 2, TEXTURE_PX / 2, TEXTURE_PX / 2 - 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    const map = new CanvasTexture(c);
    map.colorSpace = SRGBColorSpace;
    return new SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false });
  }

  // ---- nodes

  /** The diameter of a node: the one it has in the 2D graph. */
  private size(i: number): number {
    return 2 * ((this.model as GraphModel).radius[i] as number);
  }

  /**
   * Shows or hides a sprite. A hidden one also leaves the layer the camera and the raycasters
   * look at: three.js picks and drags invisible objects otherwise.
   */
  private show(s: Sprite, shown: boolean): void {
    s.visible = shown;
    s.layers.set(shown ? 0 : 1);
  }

  /** The sprite of a node (the library asks for it when it takes the nodes in). */
  private sprite(i: number): Sprite {
    const look = this.looks[i] ?? '';
    const s = new Sprite(this.material(look, !!this.lit && !this.lit[i]));
    const size = this.size(i);
    s.scale.set(size, size, 1);
    this.show(s, !this.visible || !!this.visible[i]);
    if (3 * i + 2 < this.positions.length) {
      s.position.set(
        this.positions[3 * i] as number,
        this.positions[3 * i + 1] as number,
        this.positions[3 * i + 2],
      );
    }
    this.sprites[i] = s;
    return s;
  }

  /**
   * A new graph. `seed` holds the positions its layout starts from (a refresh keeps the nodes
   * where they were); without it the nodes appear with the first positions of the layout.
   */
  setModel(model: GraphModel, seed: Float32Array | null): void {
    this.model = model;
    this.positions = seed ?? new Float32Array(0);
    // Indexes are those of the old graph: the selection is given again for the new one.
    this.hover = -1;
    this.selected = -1;
    this.el.classList.remove('hovering');
    this.lit = null;
    this.visible = null;
    this.dragging = -1;
    this.lod = model.n > SPRITE_NODES ? 'points' : 'sprite';
    this.el.dataset['graphLod'] = this.lod;
    this.looks = Array.from({ length: model.n }, (_, i) => this.look(i));
    this.byDegree = Int32Array.from({ length: model.n }, (_, i) => i).sort(
      (a, b) => (model.degree[b] as number) - (model.degree[a] as number),
    );
    this.labelStamp = new Uint32Array(model.n);
    this.clearGroups();
    this.sprites = new Array<Sprite | undefined>(model.n);
    if (this.lod === 'sprite') {
      this.nodes = model.data.nodes.map((nd, i) => {
        const node: SceneNode = { id: nd.id, i };
        if (seed && Number.isFinite(seed[3 * i])) {
          node.x = seed[3 * i] as number;
          node.y = seed[3 * i + 1] as number;
          node.z = seed[3 * i + 2] as number;
        }
        return node;
      });
    } else {
      this.nodes = [];
      this.buildGroups();
    }
    this.g.graphData({ nodes: this.nodes, links: [] });
    this.buildLinks();
    this.placeMarks();
    this.wake();
  }

  /** The node size changed: same graph, same layout, other radii. */
  resize(model: GraphModel): void {
    if (!this.model || model.n !== this.model.n) return;
    this.model = model;
    this.sprites.forEach((s, i) => {
      const size = this.size(i);
      s?.scale.set(size, size, 1);
    });
    for (const grp of this.groups) (grp.obj.material as PointsMaterial).size = this.pointSize();
    this.placeMarks();
    this.wake();
  }

  private pointSize(): number {
    // Points have one size per group: that of a node with a few links.
    const m = this.model;
    return m && m.n > 0 ? 2 * (m.radius[this.byDegree[m.n >> 1] as number] as number) + 2 : 10;
  }

  private buildGroups(): void {
    const m = this.model as GraphModel;
    const byLook = new Map<string, number[]>();
    for (let i = 0; i < m.n; i++) {
      const look = this.looks[i] as string;
      const list = byLook.get(look);
      if (list) list.push(i);
      else byLook.set(look, [i]);
    }
    for (const [look, list] of byLook) {
      list.sort((a, b) => (m.rank[a] as number) - (m.rank[b] as number));
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(list.length * 3), 3));
      const obj = new Points(
        geometry,
        new PointsMaterial({
          map: this.texture(look),
          size: this.pointSize(),
          sizeAttenuation: true,
          transparent: true,
          alphaTest: 0.05,
          depthWrite: false,
        }),
      );
      obj.frustumCulled = false;
      this.g.scene().add(obj);
      this.groups.push({ obj, nodes: Int32Array.from(list) });
    }
    this.writeGroups();
  }

  private clearGroups(): void {
    for (const grp of this.groups) {
      this.g.scene().remove(grp.obj);
      grp.obj.geometry.dispose();
      (grp.obj.material as PointsMaterial).dispose();
    }
    this.groups = [];
  }

  private writeGroups(): void {
    const pos = this.positions;
    for (const grp of this.groups) {
      const attr = grp.obj.geometry.getAttribute('position') as BufferAttribute;
      const a = attr.array as Float32Array;
      let shown = 0;
      grp.nodes.forEach((i, k) => {
        const placed = 3 * i + 2 < pos.length;
        a[3 * k] = placed ? (pos[3 * i] as number) : 0;
        a[3 * k + 1] = placed ? (pos[3 * i + 1] as number) : 0;
        a[3 * k + 2] = placed ? (pos[3 * i + 2] as number) : 0;
        if (!this.visible || this.visible[i]) shown = k + 1;
      });
      attr.needsUpdate = true;
      // The nodes are in creation order, so the ones the timelapse shows are the first ones.
      grp.obj.geometry.setDrawRange(0, pos.length === 0 ? 0 : shown);
    }
  }

  /** Materials again after a change of colours, or of the lit neighbourhood. */
  private restyleNodes(): void {
    if (!this.model) return;
    this.looks = Array.from({ length: this.model.n }, (_, i) => this.look(i));
    if (this.lod === 'sprite') {
      this.sprites.forEach((s, i) => {
        if (s) s.material = this.material(this.looks[i] as string, !!this.lit && !this.lit[i]);
      });
    } else {
      this.clearGroups();
      this.buildGroups();
    }
  }

  // ---- links

  /** Reciprocal links as two arcs, or every link straight. */
  setCurved(curved: boolean): void {
    if (this.curved === curved) return;
    this.curved = curved;
    if (this.model) this.buildLinks();
    this.wake();
  }

  private buildLinks(): void {
    const m = this.model as GraphModel;
    const scene = this.g.scene();
    for (const old of [this.links, this.glow]) {
      if (!old) continue;
      scene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }
    this.plan = planLinks(m.edges, m.n, this.curved);
    const line = (color: string, opacity: number, vertices: number) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices * 3), 3));
      const obj = new LineSegments(
        geometry,
        new LineBasicMaterial({ color: cssHex(color), transparent: true, opacity }),
      );
      obj.frustumCulled = false;
      scene.add(obj);
      return obj;
    };
    this.links = line(this.palette.edge, LINK_OPACITY, this.plan.vertices);
    // The links of the lit node, drawn over the others: at most as many as its neighbours.
    let most = 0;
    for (let i = 0; i < m.n; i++)
      most = Math.max(most, (m.off[i + 1] as number) - (m.off[i] as number));
    this.glow = line(this.palette.accent, 0.9, most * 2);
    this.glow.visible = false;
    this.writeLinks();
  }

  private writeLinks(): void {
    if (!this.links || !this.plan) return;
    const attr = this.links.geometry.getAttribute('position') as BufferAttribute;
    writeLinks(attr.array as Float32Array, this.plan, this.positions, this.visible);
    attr.needsUpdate = true;
  }

  // ---- positions

  /** New coordinates from the layout (x0,y0,z0,…). */
  setPositions(pos: Float32Array): void {
    this.positions = pos;
    if (this.lod === 'sprite') {
      const count = Math.min(this.nodes.length, Math.floor(pos.length / 3));
      for (let i = 0; i < count; i++) {
        // The node in the user's hand is where the pointer is, not where the layout last saw it.
        if (i === this.dragging) continue;
        const x = pos[3 * i] as number;
        const y = pos[3 * i + 1] as number;
        const z = pos[3 * i + 2] as number;
        const node = this.nodes[i] as SceneNode;
        node.x = x;
        node.y = y;
        node.z = z;
        this.sprites[i]?.position.set(x, y, z);
      }
    } else this.writeGroups();
    this.writeLinks();
    this.placeMarks();
    this.wake();
  }

  /** The dragged node, between two answers of the layout: its links follow it at once. */
  private moveNode(i: number, x: number, y: number, z: number): void {
    if (3 * i + 2 >= this.positions.length) return;
    this.positions[3 * i] = x;
    this.positions[3 * i + 1] = y;
    this.positions[3 * i + 2] = z;
    this.writeLinks();
    this.placeMarks();
    this.wake();
  }

  /** The timelapse: the nodes shown (null: all). */
  setVisible(mask: Uint8Array | null): void {
    this.visible = mask;
    if (this.lod === 'sprite') {
      this.sprites.forEach((s, i) => {
        if (s) this.show(s, !mask || !!mask[i]);
      });
    } else this.writeGroups();
    this.writeLinks();
    this.placeMarks();
    this.wake();
  }

  // ---- the current node

  private shown(i: number): boolean {
    return i >= 0 && 3 * i + 2 < this.positions.length && (!this.visible || !!this.visible[i]);
  }

  /** The node under the pointer (-1: none): it and its neighbours stand out. */
  setHover(i: number): void {
    const next = this.shown(i) ? i : -1;
    if (next === this.hover) return;
    this.hover = next;
    this.el.classList.toggle('hovering', next >= 0);
    this.relight();
  }

  /** The node the user walked or clicked to (-1: none): ringed, and lit while nothing is hovered. */
  setSelected(i: number): void {
    if (i === this.selected) return;
    this.selected = i;
    this.relight();
  }

  private current(): number {
    return this.hover >= 0 ? this.hover : this.selected;
  }

  private relight(): void {
    const m = this.model;
    const at = this.current();
    const lit = m && this.shown(at) ? neighbourSet(m, at) : null;
    const changed = lit !== this.lit;
    this.lit = lit;
    if (changed && this.lod === 'sprite') {
      this.sprites.forEach((s, i) => {
        if (s) s.material = this.material(this.looks[i] as string, !!lit && !lit[i]);
      });
    }
    if (this.links) this.links.material.opacity = lit ? DIM_LINK_OPACITY : LINK_OPACITY;
    this.placeMarks();
    this.wake();
  }

  /** The ring of the selected node and the links of the lit one, at the current positions. */
  private placeMarks(): void {
    const m = this.model;
    const pos = this.positions;
    if (!m) return;
    const sel = this.selected;
    if (this.shown(sel) && sel < m.n) {
      if (!this.ring) {
        this.ring = new Sprite(this.ringMaterial());
        this.ring.renderOrder = 10;
        this.g.scene().add(this.ring);
      }
      const size = (this.lod === 'sprite' ? this.size(sel) : this.pointSize()) * 1.7;
      this.ring.scale.set(size, size, 1);
      this.ring.position.set(pos[3 * sel] as number, pos[3 * sel + 1] as number, pos[3 * sel + 2]);
      this.ring.visible = true;
    } else if (this.ring) this.ring.visible = false;

    const glow = this.glow;
    if (!glow) return;
    const at = this.current();
    if (!this.lit || !this.shown(at) || at >= m.n) {
      glow.visible = false;
      return;
    }
    const attr = glow.geometry.getAttribute('position') as BufferAttribute;
    const a = attr.array as Float32Array;
    let v = 0;
    for (let k = m.off[at] as number; k < (m.off[at + 1] as number); k++) {
      const nb = m.adj[k] as number;
      if (!this.shown(nb)) continue;
      a[v++] = pos[3 * at] as number;
      a[v++] = pos[3 * at + 1] as number;
      a[v++] = pos[3 * at + 2] as number;
      a[v++] = pos[3 * nb] as number;
      a[v++] = pos[3 * nb + 1] as number;
      a[v++] = pos[3 * nb + 2] as number;
    }
    attr.needsUpdate = true;
    glow.geometry.setDrawRange(0, v / 3);
    glow.visible = v > 0;
  }

  // ---- camera

  private target(): Vector3 {
    return (this.g.controls() as { target: Vector3 }).target;
  }

  /** The direction the camera looks from, as a unit vector from what it looks at. */
  private viewDirection(): Vector3 {
    const d = this.camera.position.clone().sub(this.target());
    return d.lengthSq() > 1e-6 ? d.normalize() : d.set(0, 0, 1);
  }

  private fly(to: Vector3, lookAt: Vector3, animate: boolean): void {
    const ms = animate && !reducedMotion() ? 700 : 0;
    this.g.cameraPosition(
      { x: to.x, y: to.y, z: to.z },
      { x: lookAt.x, y: lookAt.y, z: lookAt.z },
      ms,
    );
    this.wake(ms + IDLE_MS);
  }

  /** Brings the nodes shown into view, looking from where the camera already looks. */
  fit(animate = true): void {
    const m = this.model;
    const b = m ? boundsOf(this.positions, m.n, this.visible) : null;
    if (!b) return;
    const centre = new Vector3(b.x, b.y, b.z);
    const d = fitDistance(b.r, this.camera.fov, this.width / this.height);
    this.fly(this.viewDirection().multiplyScalar(d).add(centre), centre, animate);
  }

  /** Flies to a node and looks at it. */
  focus(i: number): void {
    if (!this.shown(i)) return;
    const at = new Vector3(
      this.positions[3 * i],
      this.positions[3 * i + 1],
      this.positions[3 * i + 2],
    );
    this.fly(this.viewDirection().multiplyScalar(FOCUS_DISTANCE).add(at), at, true);
  }

  /** Turns the camera around what it looks at (radians) and moves it closer or farther (factor). */
  orbit(azimuth: number, polar: number, zoom = 1): void {
    const target = this.target().clone();
    const s = new Spherical().setFromVector3(this.camera.position.clone().sub(target));
    s.theta += azimuth;
    s.phi = Math.min(Math.PI - 0.05, Math.max(0.05, s.phi + polar));
    s.radius = Math.max(10, s.radius * zoom);
    this.fly(new Vector3().setFromSpherical(s).add(target), target, false);
  }

  /** Where a node is in the surface, in px; null when it is not placed or behind the camera. */
  private screenOf(i: number): { x: number; y: number; depth: number } | null {
    const pos = this.positions;
    if (i < 0 || 3 * i + 2 >= pos.length) return null;
    const v = this.v.set(pos[3 * i] as number, pos[3 * i + 1] as number, pos[3 * i + 2]);
    v.project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return { x: ((v.x + 1) * this.width) / 2, y: ((1 - v.y) * this.height) / 2, depth: v.z };
  }

  /**
   * The node drawn at a point of the surface (-1: none): the nearest one within its own radius on
   * screen, or within reach of the pointer when it is drawn smaller than that.
   */
  private pick(x: number, y: number): number {
    const m = this.model;
    if (!m) return -1;
    const pos = this.positions;
    const cam = this.camera.position;
    const perPx = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.height;
    const flat = this.lod === 'points' ? this.pointSize() : 0;
    let best = -1;
    let bestD = Infinity;
    let bestDepth = Infinity;
    for (let i = 0; i < m.n; i++) {
      if (this.visible && !this.visible[i]) continue;
      const p = this.screenOf(i);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > bestD) continue;
      const dist = Math.hypot(
        (pos[3 * i] as number) - cam.x,
        (pos[3 * i + 1] as number) - cam.y,
        (pos[3 * i + 2] as number) - cam.z,
      );
      const radius = (flat || this.size(i)) / 2 / Math.max(1e-6, dist * perPx);
      if (d > Math.max(PICK_PX, radius)) continue;
      // Of two nodes equally near the pointer, the one in front.
      if (d < bestD || p.depth < bestDepth) {
        best = i;
        bestD = d;
        bestDepth = p.depth;
      }
    }
    return best;
  }

  // ---- labels (HTML over the scene: plain text, never markup)

  private updateLabels(): void {
    const m = this.model;
    let used = 0;
    if (m && this.positions.length >= 3 * m.n) {
      const cam = this.camera.position;
      const range = LABEL_RANGE / this.labelZoom;
      const perPx = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / this.height;
      const stamp = ++this.stamp;
      const at = this.current();
      const put = (i: number, always: boolean): void => {
        if (used >= MAX_LABELS || this.labelStamp[i] === stamp || !this.shown(i)) return;
        const pos = this.positions;
        const dist = Math.hypot(
          (pos[3 * i] as number) - cam.x,
          (pos[3 * i + 1] as number) - cam.y,
          (pos[3 * i + 2] as number) - cam.z,
        );
        if (!always && dist > range) return;
        const p = this.screenOf(i);
        if (!p || p.x < -40 || p.y < -20 || p.x > this.width + 40 || p.y > this.height + 20) return;
        this.labelStamp[i] = stamp;
        // Below the node: its radius on screen, plus a gap.
        const below = this.size(i) / 2 / Math.max(1e-6, dist * perPx) + 3;
        this.label(
          used++,
          (m.data.nodes[i] as { label: string }).label,
          p.x,
          p.y + below,
          i === at,
        );
      };
      if (at >= 0 && at < m.n) {
        put(at, true);
        for (let k = m.off[at] as number; k < (m.off[at + 1] as number); k++) {
          put(m.adj[k] as number, this.hover >= 0);
        }
      }
      const candidates = Math.min(LABEL_CANDIDATES, m.n);
      for (let k = 0; k < candidates; k++) put(this.byDegree[k] as number, false);
    }
    for (let k = used; k < this.spans.length; k++) (this.spans[k] as HTMLSpanElement).hidden = true;
  }

  private label(k: number, text: string, x: number, y: number, current: boolean): void {
    let span = this.spans[k];
    if (!span) {
      span = document.createElement('span');
      span.className = 'graph3d-label';
      this.labelLayer.append(span);
      this.spans[k] = span;
      this.spanText[k] = '';
    }
    if (this.spanText[k] !== text) {
      span.textContent = text;
      this.spanText[k] = text;
    }
    span.hidden = false;
    span.classList.toggle('current', current);
    span.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, 0)`;
  }

  // ---- input

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const box = this.el.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY, onNode: this.hover >= 0 };
    this.wake();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointer = this.local(e);
    const d = this.pointerDown;
    const camera = d && (this.lod === 'points' || !d.onNode);
    if (camera && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) {
      this.events.onUserMove();
    }
    this.wake();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.pointerDown;
    this.pointerDown = null;
    this.wake();
    // Points are picked here; sprites are the library's, which reports their clicks itself.
    if (this.lod !== 'points' || !d || e.button !== 0) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) return;
    const p = this.local(e);
    this.events.onClick(this.pick(p.x, p.y), e.metaKey || e.ctrlKey);
  };

  private readonly onPointerLeave = (): void => {
    this.pointer = null;
    if (this.lod === 'points') this.setHover(-1);
  };

  private readonly onWheel = (): void => {
    this.events.onUserMove();
    this.wake();
  };

  private readonly onContextLost = (): void => {
    if (!this.disposed) this.events.onContextLost();
  };

  // ---- end

  /** Releases everything, the WebGL context included (the library has no dispose of its own). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver.disconnect();
    const el = this.el;
    el.removeEventListener('pointerdown', this.onPointerDown, true);
    el.removeEventListener('pointermove', this.onPointerMove, true);
    el.removeEventListener('pointerup', this.onPointerUp, true);
    el.removeEventListener('pointerleave', this.onPointerLeave);
    el.removeEventListener('wheel', this.onWheel, true);
    el.classList.remove('hovering');
    const g = this.g;
    const renderer = g.renderer();
    renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    g.pauseAnimation();
    this.clearGroups();
    for (const obj of [this.links, this.glow]) {
      obj?.geometry.dispose();
      obj?.material.dispose();
    }
    this.ring?.material.map?.dispose();
    this.ring?.material.dispose();
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.dimMaterials.values()) m.dispose();
    g._destructor();
    renderer.dispose();
    // Without this the context lives until the garbage collector finds the canvas: a few closed
    // graphs would use up the contexts a page may hold (measured in the M18-D0 spike).
    renderer.forceContextLoss();
    renderer.domElement.remove();
    this.labelLayer.remove();
    if (this.probe && window.__graph3d === this.probe) delete window.__graph3d;
  }
}

let probe: CanvasRenderingContext2D | null | undefined;
const hexCache = new Map<string, string>();

/**
 * A CSS colour as #rrggbb, which is what three.js parses for sure: the tokens of the theme may be
 * written in any syntax the browser knows. The browser itself does the conversion, on a 1 px canvas.
 */
export function cssHex(color: string): string {
  const known = hexCache.get(color);
  if (known) return known;
  if (probe === undefined) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
  }
  let hex = color;
  if (probe) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000000';
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    hex = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
  }
  hexCache.set(color, hex);
  return hex;
}
