// One command per scene action (drawing:<action-id>), appended to the command registry. Titles
// live under "commands.drawing_<action id with '-' → '_'>" in the i18n files.
import i18next from 'i18next';
import type { Command } from '../commands/registry';
import { dialog } from '../ui/dialogs';
import { featureOn, useManaged } from '../state/managed';
import { getSceneController } from './actions/active';
import { SCENE_ACTIONS } from './actions/registry';
import {
  insertDrawingIntoDrawing,
  insertImageIntoDrawing,
  insertNoteIntoDrawing,
} from './embed/commands';
import {
  createNoteAndEmbed,
  deconstructIntoNewDrawing,
  refreshNoteCards,
  setDrawingAutoExport,
} from './embed/tools';
import { exportLibrary, importLegacyDrawing, importLibrary } from './library/commands';
import { latexOf } from './latex/insert';
import { selectedElements, type SceneAction, type SceneContext } from './actions/types';

/** Asks the action's parameters one by one; null when the user cancels or types a bad number. */
async function askParams(
  action: SceneAction,
  ctx: SceneContext,
): Promise<Record<string, number> | null> {
  const out: Record<string, number> = {};
  for (const spec of action.params ?? []) {
    const initial = typeof spec.default === 'function' ? spec.default(ctx) : spec.default;
    if (spec.options) {
      const picked = await dialog.pick(
        i18next.t(`drawing.params.${spec.key}`),
        spec.options.map((o) => ({
          value: String(o.value),
          label: o.labelKey ? i18next.t(o.labelKey) : (o.label ?? String(o.value)),
        })),
      );
      if (picked === null) return null;
      out[spec.key] = Number(picked);
      continue;
    }
    const raw = await dialog.prompt(i18next.t(`drawing.params.${spec.key}`), String(initial));
    if (raw === null) return null;
    const n = Number(raw.replace(',', '.'));
    if (raw.trim() === '' || !Number.isFinite(n) || (spec.min !== undefined && n < spec.min))
      return null;
    out[spec.key] = n;
  }
  return out;
}

async function runAction(action: SceneAction): Promise<void> {
  const c = getSceneController();
  if (!c || !c.canEdit()) return;
  let ctx = c.context();
  if (action.params?.length) {
    const params = await askParams(action, ctx);
    // The scene may have changed while the dialog was open.
    if (!params || getSceneController() !== c || !c.canEdit()) return;
    ctx = { ...c.context(), params };
  }
  const patch = action.run(ctx);
  if (
    Object.keys(patch.update ?? {}).length ||
    patch.add?.length ||
    patch.remove?.length ||
    patch.view
  )
    c.apply(patch);
}

function enabled(action: SceneAction): boolean {
  const c = getSceneController();
  if (!c || !featureOn(useManaged.getState().features, 'drawings') || !c.canEdit()) return false;
  return selectedElements(c.context()).length >= action.needs;
}

export const sceneCommands: Command[] = SCENE_ACTIONS.map((a) => ({
  id: `drawing:${a.id}`,
  group: 'editor',
  defaults: [],
  enabled: () => enabled(a),
  run: () => runAction(a),
}));

const drawingFeature = (): boolean => featureOn(useManaged.getState().features, 'drawings');
const editable = (): boolean => {
  const c = getSceneController();
  return !!c && c.canEdit() && drawingFeature();
};

/** The selected element when it is a LaTeX formula (and only it). */
function selectedFormula(): string | null {
  const c = getSceneController();
  if (!c) return null;
  const ctx = c.context();
  const sel = selectedElements(ctx);
  const only = sel.length === 1 ? sel[0] : undefined;
  return only && latexOf(only) ? only.id : null;
}

/** Tools that open a dialog of the editor (LaTeX formulas). */
export const toolCommands: Command[] = [
  {
    id: 'drawing:insert-latex',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => getSceneController()?.openTool('latex'),
  },
  {
    id: 'drawing:insert-mermaid',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => getSceneController()?.openTool('mermaid'),
  },
  {
    id: 'drawing:insert-image',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => insertImageIntoDrawing(),
  },
  {
    id: 'drawing:insert-drawing',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => insertDrawingIntoDrawing(),
  },
  {
    id: 'drawing:insert-note',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => insertNoteIntoDrawing(),
  },
  {
    id: 'drawing:create-note-and-embed',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => createNoteAndEmbed(),
  },
  {
    id: 'drawing:deconstruct-into-new-drawing',
    group: 'editor',
    defaults: [],
    enabled: () => editable() && (getSceneController()?.context().selected.length ?? 0) > 0,
    run: () => deconstructIntoNewDrawing(),
  },
  {
    id: 'drawing:refresh-note-cards',
    group: 'editor',
    defaults: [],
    enabled: () => editable() && (getSceneController()?.context().selected.length ?? 0) > 0,
    run: () => refreshNoteCards(),
  },
  {
    id: 'drawing:set-auto-export',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => setDrawingAutoExport(),
  },
  {
    id: 'drawing:slideshow',
    group: 'editor',
    defaults: [],
    enabled: () => !!getSceneController() && drawingFeature(),
    run: () => getSceneController()?.startSlideshow(),
  },
  {
    id: 'drawing:tools-panel',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => getSceneController()?.openTool('tools'),
  },
  {
    id: 'drawing:import-library',
    group: 'editor',
    defaults: [],
    enabled: editable,
    run: () => importLibrary(),
  },
  {
    id: 'drawing:export-library',
    group: 'editor',
    defaults: [],
    enabled: drawingFeature,
    run: () => exportLibrary(),
  },
  {
    id: 'drawing:import-legacy',
    group: 'editor',
    defaults: [],
    enabled: drawingFeature,
    run: () => importLegacyDrawing(),
  },
  {
    id: 'drawing:edit-latex',
    group: 'editor',
    defaults: [],
    enabled: () => editable() && selectedFormula() !== null,
    run: () => {
      const id = selectedFormula();
      if (id) getSceneController()?.openTool('latex', id);
    },
  },
];

/** Ids of the commands the tools panel lists (the scene actions and the tools above). */
export const toolIds: ReadonlySet<string> = new Set(
  [...sceneCommands, ...toolCommands].map((c) => c.id).filter((id) => id !== 'drawing:tools-panel'),
);
