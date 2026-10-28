// Text group of the script library: split a text into lines, join lines, sticky notes, links.
import { arrangeable, num } from './geometry';
import { baseElement, boundsOf, textElement } from './factory';
import type { SceneAction, SceneContext, SceneElement } from './types';

/** Selected texts that are free (not the label of a container). */
const freeTexts = (ctx: SceneContext): SceneElement[] =>
  arrangeable(ctx).filter((e) => e.type === 'text' && typeof e.containerId !== 'string');

const textOf = (e: SceneElement): string => (typeof e.text === 'string' ? e.text : '');
const lineHeight = (e: SceneElement): number => (num(e, 'fontSize') || 20) * 1.25;

/** "Split text by lines": one text element per non-empty line, stacked where the text was. */
const splitByLines: SceneAction = {
  id: 'split-text-by-lines',
  group: 'text',
  needs: 1,
  run(ctx) {
    const add: SceneElement[] = [];
    const remove: string[] = [];
    for (const t of freeTexts(ctx)) {
      const lines = textOf(t).split('\n');
      if (lines.filter((l) => l.trim()).length < 2) continue;
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        add.push(
          textElement(line, { x: num(t, 'x'), y: num(t, 'y') + i * lineHeight(t) }, t, {
            groupIds: t.groupIds ?? [],
          }),
        );
      });
      remove.push(t.id);
    }
    return add.length ? { add, remove } : {};
  },
};

/** "Concatenate lines": the selected texts, top to bottom, as the lines of one text. */
const concatenateLines: SceneAction = {
  id: 'concatenate-lines',
  group: 'text',
  needs: 2,
  run(ctx) {
    const texts = freeTexts(ctx).sort(
      (a, b) => num(a, 'y') - num(b, 'y') || num(a, 'x') - num(b, 'x'),
    );
    if (texts.length < 2) return {};
    const first = texts[0] as SceneElement;
    const joined = texts.map(textOf).join('\n');
    return {
      add: [textElement(joined, { x: num(first, 'x'), y: num(first, 'y') }, first)],
      remove: texts.map((t) => t.id),
    };
  },
};

const STICKY_COLORS = ['#ffec99', '#ffd8a8', '#b2f2bb', '#a5d8ff', '#eebefa'];

/** "Convert text to sticky notes": each free text goes inside a colored note. */
const stickyNotes: SceneAction = {
  id: 'text-to-sticky-notes',
  group: 'text',
  needs: 1,
  run(ctx) {
    const add: SceneElement[] = [];
    const update: Record<string, Record<string, unknown>> = {};
    freeTexts(ctx).forEach((t, i) => {
      const b = boundsOf([t]);
      if (!b) return;
      const side = Math.max(b.width, b.height) + 40;
      const w = Math.max(b.width + 40, 120);
      const h = Math.max(b.height + 40, Math.min(side, 120));
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const note = baseElement(
        'rectangle',
        { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
        {
          backgroundColor: STICKY_COLORS[i % STICKY_COLORS.length],
          strokeColor: 'transparent',
          roughness: 0,
          roundness: { type: 3 },
          boundElements: [{ id: t.id, type: 'text' }],
        },
      );
      add.push(note);
      update[t.id] = {
        containerId: note.id,
        textAlign: 'center',
        verticalAlign: 'middle',
        x: cx - b.width / 2,
        y: cy - b.height / 2,
      };
    });
    return add.length ? { add, update } : {};
  },
};

/** "Convert text to link": the element links to the note named by the text's first line. */
const textToLink: SceneAction = {
  id: 'convert-text-to-link',
  group: 'links',
  needs: 1,
  run(ctx) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const t of freeTexts(ctx)) {
      const name =
        textOf(t)
          .split('\n')[0]
          ?.trim()
          .replace(/[[\]|#^]/g, '') ?? '';
      if (!name) continue;
      const link = `[[${name}]]`;
      if (t.link !== link) update[t.id] = { link };
    }
    return { update };
  },
};

export const TEXT_ACTIONS: readonly SceneAction[] = [
  splitByLines,
  concatenateLines,
  stickyNotes,
  textToLink,
];
