import type { SceneAction } from '../actions/types';
import { selectedElements } from '../actions/types';
import { latexOf } from './insert';

/** "Reset LaTeX size": selected formulas go back to the size they were rendered at. */
export const resetLatexSize: SceneAction = {
  id: 'reset-latex-size',
  group: 'generators',
  needs: 1,
  run(ctx) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of selectedElements(ctx)) {
      const meta = latexOf(e);
      const w = Number(e.width);
      const h = Number(e.height);
      if (!meta || meta.w0 <= 0 || !(w > 0) || Math.abs(w - meta.w0) < 1e-6) continue;
      update[e.id] = { width: meta.w0, height: (h / w) * meta.w0 };
    }
    return { update };
  },
};
