// Generators of the script library: Mindmap Builder, calendars and comic panels. They build whole
// structures of new elements (skeletons: the editor completes and re-measures them).
import i18next from 'i18next';
import { arrowBetween, baseElement, boundsOf, textElement, type Box } from './factory';
import { newId } from './ids';
import { selectedElements, type SceneAction, type SceneContext, type SceneElement } from './types';

type Props = Record<string, unknown>;

/** Where a generator puts a structure of size w × h: centered on the screen, else below the scene. */
function placeAt(ctx: SceneContext, w: number, h: number): { x: number; y: number } {
  if (ctx.origin) return { x: ctx.origin.x - w / 2, y: ctx.origin.y - h / 2 };
  const b = boundsOf(ctx.elements.filter((e) => !e.isDeleted));
  return b ? { x: b.x, y: b.y + b.height + 80 } : { x: 0, y: 0 };
}

/** A shape with its label: the text is the shape's bound text, centered. */
function labeled(
  type: 'rectangle' | 'ellipse',
  box: Box,
  label: string,
  shape: Props = {},
  from: SceneElement | null = null,
  fontSize = 20,
): [SceneElement, SceneElement] {
  const base = from ?? baseElement('text', box);
  const text = textElement(label, { x: box.x, y: box.y }, base, {
    fontSize,
    textAlign: 'center',
    verticalAlign: 'middle',
  });
  const w = Number(text.width) || 0;
  const h = Number(text.height) || 0;
  const container = baseElement(type, box, {
    ...shape,
    boundElements: [{ id: text.id, type: 'text' }],
  });
  text.x = box.x + (box.width - w) / 2;
  text.y = box.y + (box.height - h) / 2;
  text.containerId = container.id;
  return [container, text];
}

export interface OutlineNode {
  text: string;
  children: OutlineNode[];
}

/**
 * Reads an indented outline (spaces or tabs, optional "-", "*", "+" or "•" bullets). The first
 * line is the root; later lines that are not indented deeper than it become its children.
 */
export function parseOutline(src: string): OutlineNode | null {
  const stack: { indent: number; node: OutlineNode }[] = [];
  let root: OutlineNode | null = null;
  for (const raw of src.split('\n')) {
    if (!raw.trim()) continue;
    const lead = /^[ \t]*/.exec(raw)?.[0] ?? '';
    const indent = [...lead].reduce((n, c) => n + (c === '\t' ? 2 : 1), 0);
    const text = raw.trim().replace(/^[-*+•]\s+/, '');
    if (!text) continue;
    const node: OutlineNode = { text, children: [] };
    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }
    while (stack.length > 1 && (stack[stack.length - 1] as { indent: number }).indent >= indent)
      stack.pop();
    (stack[stack.length - 1] as { node: OutlineNode }).node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

const BRANCH_COLORS = ['#b2f2bb', '#ffec99', '#ffc9c9', '#d0bfff', '#99e9f2', '#ffd8a8'];
const MAX_NODES = 300;

interface Placed {
  node: OutlineNode;
  depth: number;
  w: number;
  h: number;
  y: number;
  color: string;
  kids: Placed[];
}

/** "Mindmap Builder": a selected outline text becomes a tree of boxes joined by arrows. */
const mindmap: SceneAction = {
  id: 'mindmap-from-text',
  group: 'generators',
  needs: 1,
  params: [
    { key: 'hgap', default: 80, min: 20 },
    { key: 'vgap', default: 16, min: 0 },
  ],
  run(ctx) {
    const hgap = ctx.params?.hgap ?? 80;
    const vgap = ctx.params?.vgap ?? 16;
    const add: SceneElement[] = [];
    const remove: string[] = [];
    for (const src of selectedElements(ctx).filter(
      (e) => e.type === 'text' && typeof e.containerId !== 'string',
    )) {
      const outline = parseOutline(typeof src.text === 'string' ? src.text : '');
      if (!outline || outline.children.length === 0) continue;
      let count = 0;
      const place = (node: OutlineNode, depth: number, color: string): Placed | null => {
        if (count++ >= MAX_NODES) return null;
        const kids: Placed[] = [];
        node.children.forEach((c, i) => {
          const k = place(c, depth + 1, depth === 0 ? (BRANCH_COLORS[i % 6] as string) : color);
          if (k) kids.push(k);
        });
        const fs = 20;
        return {
          node,
          depth,
          w: Math.max(100, node.text.length * fs * 0.6 + 32),
          h: fs * 1.25 + 24,
          y: 0,
          color: depth === 0 ? '#a5d8ff' : color,
          kids,
        };
      };
      const tree = place(outline, 0, '#a5d8ff');
      if (!tree) continue;
      const colW: number[] = [];
      let cursor = 0;
      const measure = (p: Placed): void => {
        colW[p.depth] = Math.max(colW[p.depth] ?? 0, p.w);
        p.kids.forEach(measure);
        if (p.kids.length === 0) {
          p.y = cursor;
          cursor += p.h + vgap;
        } else {
          const first = p.kids[0] as Placed;
          const last = p.kids[p.kids.length - 1] as Placed;
          p.y = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - p.h / 2;
        }
      };
      measure(tree);
      const colX: number[] = [];
      colW.forEach((w, d) => {
        colX[d] = d === 0 ? 0 : (colX[d - 1] as number) + (colW[d - 1] as number) + hgap;
      });
      // The root sits where the source text was.
      const sb = boundsOf([src]) as Box;
      const dx = sb.x;
      const dy = sb.y + sb.height / 2 - (tree.y + tree.h / 2);
      const made = new Map<Placed, SceneElement>();
      const build = (p: Placed): void => {
        const box = { x: dx + (colX[p.depth] as number), y: dy + p.y, width: p.w, height: p.h };
        const [container, label] = labeled(
          'rectangle',
          box,
          p.node.text,
          {
            backgroundColor: p.color,
            roundness: { type: 3 },
            strokeColor: typeof src.strokeColor === 'string' ? src.strokeColor : '#1e1e1e',
          },
          src,
        );
        made.set(p, container);
        add.push(container, label);
        p.kids.forEach(build);
      };
      build(tree);
      const link = (p: Placed): void => {
        for (const k of p.kids) {
          const a = made.get(p) as SceneElement;
          const b = made.get(k) as SceneElement;
          const { arrow } = arrowBetween(a, b);
          add.push(arrow);
          for (const s of [a, b])
            s.boundElements = [
              ...((s.boundElements as unknown[] | null) ?? []),
              { id: arrow.id, type: 'arrow' },
            ];
          link(k);
        }
      };
      link(tree);
      remove.push(src.id);
    }
    return add.length ? { add, remove } : {};
  },
};

const capitalize = (s: string): string => s.charAt(0).toLocaleUpperCase() + s.slice(1);
const locale = (): string => i18next.language || 'en';

/** Two-letter weekday names starting at `first` (0 = Sunday). */
export function weekdayNames(first: number, lang = locale()): string[] {
  const f = new Intl.DateTimeFormat(lang, { weekday: 'short' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    capitalize(f.format(new Date(2023, 0, 1 + ((first + i) % 7)))).slice(0, 2),
  );
}

export const monthName = (year: number, month: number, lang = locale()): string =>
  capitalize(new Intl.DateTimeFormat(lang, { month: 'long' }).format(new Date(year, month, 1)));

const daysIn = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();

/** A month as monospaced text: a weekday header and one line per week. */
export function monthGrid(year: number, month: number, first: number, lang = locale()): string {
  const lines = [weekdayNames(first, lang).join(' ')];
  const offset = (new Date(year, month, 1).getDay() - first + 7) % 7;
  const cells: string[] = [
    ...Array<string>(offset).fill('  '),
    ...Array.from({ length: daysIn(year, month) }, (_, i) => String(i + 1).padStart(2, ' ')),
  ];
  for (let i = 0; i < cells.length; i += 7) lines.push(cells.slice(i, i + 7).join(' '));
  return lines.join('\n');
}

const firstDayParam = {
  key: 'firstDay',
  default: 1,
  options: [
    { value: 1, labelKey: 'drawing.options.monday' },
    { value: 0, labelKey: 'drawing.options.sunday' },
  ],
} as const;
const yearParam = {
  key: 'year',
  default: () => new Date().getFullYear(),
  min: 1900,
} as const;

/** "Full-year Calendar": twelve month boxes in a 4 × 3 grid. */
const calendarYear: SceneAction = {
  id: 'calendar-year',
  group: 'generators',
  needs: 0,
  params: [yearParam, firstDayParam],
  run(ctx) {
    const year = Math.floor(ctx.params?.year ?? new Date().getFullYear());
    const first = ctx.params?.firstDay === 0 ? 0 : 1;
    const cellW = 260;
    const cellH = 220;
    const gap = 30;
    const w = 4 * cellW + 3 * gap;
    const h = 3 * cellH + 2 * gap;
    const o = placeAt(ctx, w, h);
    const group = newId();
    const add: SceneElement[] = [];
    for (let m = 0; m < 12; m++) {
      const x = o.x + (m % 4) * (cellW + gap);
      const y = o.y + Math.floor(m / 4) * (cellH + gap);
      const [box, title] = labeled(
        'rectangle',
        { x, y, width: cellW, height: 40 },
        monthName(year, m),
        { roundness: { type: 3 }, backgroundColor: '#e7f5ff', groupIds: [group] },
        null,
        22,
      );
      title.groupIds = [group];
      const body = textElement(
        monthGrid(year, m, first),
        { x: x + 22, y: y + 54 },
        baseElement('text', box as unknown as Box),
        { fontFamily: 3, fontSize: 16, groupIds: [group], textAlign: 'left' },
      );
      add.push(
        box,
        title,
        baseElement(
          'rectangle',
          { x, y, width: cellW, height: cellH },
          { roundness: { type: 3 }, groupIds: [group] },
        ),
        body,
      );
    }
    return { add };
  },
};

/** "Linear Calendar": a row per month, one cell per day; weekends shaded. */
const calendarLinear: SceneAction = {
  id: 'calendar-linear',
  group: 'generators',
  needs: 0,
  params: [yearParam, firstDayParam],
  run(ctx) {
    const year = Math.floor(ctx.params?.year ?? new Date().getFullYear());
    const cell = 32;
    const labelW = 130;
    const w = labelW + 31 * cell;
    const h = 13 * cell;
    const o = placeAt(ctx, w, h);
    const group = newId();
    const proto = baseElement('text', { x: 0, y: 0, width: 1, height: 1 });
    const add: SceneElement[] = [];
    for (let d = 1; d <= 31; d++)
      add.push(
        textElement(String(d), { x: o.x + labelW + (d - 1) * cell + 6, y: o.y + 4 }, proto, {
          fontSize: 14,
          groupIds: [group],
        }),
      );
    for (let m = 0; m < 12; m++) {
      const y = o.y + (m + 1) * cell;
      add.push(
        textElement(monthName(year, m), { x: o.x, y: y + 5 }, proto, {
          fontSize: 16,
          groupIds: [group],
        }),
      );
      for (let d = 1; d <= daysIn(year, m); d++) {
        const dow = new Date(year, m, d).getDay();
        add.push(
          baseElement(
            'rectangle',
            { x: o.x + labelW + (d - 1) * cell, y, width: cell, height: cell },
            {
              strokeWidth: 1,
              roughness: 0,
              backgroundColor: dow === 0 || dow === 6 ? '#e9ecef' : 'transparent',
              groupIds: [group],
            },
          ),
        );
      }
    }
    return { add };
  },
};

/** "Comic Strip Director": a grid of panels. */
const comicPanels: SceneAction = {
  id: 'comic-panels',
  group: 'generators',
  needs: 0,
  params: [
    { key: 'rows', default: 2, min: 1 },
    { key: 'columns', default: 3, min: 1 },
    { key: 'panelWidth', default: 260, min: 40 },
    { key: 'panelHeight', default: 200, min: 40 },
  ],
  run(ctx) {
    const rows = Math.min(10, Math.floor(ctx.params?.rows ?? 2));
    const cols = Math.min(10, Math.floor(ctx.params?.columns ?? 3));
    const pw = ctx.params?.panelWidth ?? 260;
    const ph = ctx.params?.panelHeight ?? 200;
    const gap = 16;
    const o = placeAt(ctx, cols * pw + (cols - 1) * gap, rows * ph + (rows - 1) * gap);
    const add: SceneElement[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        add.push(
          baseElement(
            'rectangle',
            { x: o.x + c * (pw + gap), y: o.y + r * (ph + gap), width: pw, height: ph },
            { strokeWidth: 4, roughness: 0 },
          ),
        );
    return { add };
  },
};

/** "Callout Editor": a speech bubble (an ellipse and its tail) for each selected text. */
const speechBubble: SceneAction = {
  id: 'speech-bubble',
  group: 'generators',
  needs: 1,
  run(ctx) {
    const add: SceneElement[] = [];
    const update: Record<string, Props> = {};
    for (const t of selectedElements(ctx).filter(
      (e) => e.type === 'text' && typeof e.containerId !== 'string',
    )) {
      const b = boundsOf([t]) as Box;
      const w = b.width * 1.5 + 40;
      const h = b.height * 1.8 + 30;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const bubble = baseElement(
        'ellipse',
        { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
        { backgroundColor: '#ffffff', boundElements: [{ id: t.id, type: 'text' }] },
      );
      const tail = baseElement(
        'line',
        { x: cx - w * 0.1, y: cy + h / 2 - 2, width: w * 0.1, height: 28 },
        {
          points: [
            [0, 0],
            [w * 0.1, 28],
            [w * 0.18, -2],
          ],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
          backgroundColor: '#ffffff',
        },
      );
      add.push(bubble, tail);
      update[t.id] = { containerId: bubble.id, textAlign: 'center', verticalAlign: 'middle' };
    }
    return add.length ? { add, update } : {};
  },
};

export const GENERATOR_ACTIONS: readonly SceneAction[] = [
  mindmap,
  calendarYear,
  calendarLinear,
  comicPanels,
  speechBubble,
];
