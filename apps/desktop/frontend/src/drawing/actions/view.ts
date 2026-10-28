// "View" actions: they change what is shown (zoom, grid, selection, the styles new elements get),
// not the drawing, so they return a `view` patch and no element changes.
import { arrangeable } from './geometry';
import type { SceneAction } from './types';

const TYPES = [
  'rectangle',
  'ellipse',
  'diamond',
  'arrow',
  'line',
  'freedraw',
  'text',
  'image',
  'frame',
] as const;

const zoomToSelection: SceneAction = {
  id: 'zoom-to-fit-selected',
  group: 'view',
  needs: 1,
  run: (ctx) => ({ view: { zoomTo: [...ctx.selected] } }),
};

const toggleGrid: SceneAction = {
  id: 'toggle-grid',
  group: 'view',
  needs: 0,
  run: () => ({ view: { toggleGrid: true } }),
};

const setGridSize: SceneAction = {
  id: 'set-grid-size',
  group: 'view',
  needs: 0,
  params: [{ key: 'gridSize', default: 20, min: 1 }],
  run: (ctx) => ({
    view: { appState: { gridSize: Math.round(ctx.params?.gridSize ?? 20), gridModeEnabled: true } },
  }),
};

/** "Select elements of type": selects every live element of the chosen type. */
const selectOfType: SceneAction = {
  id: 'select-elements-of-type',
  group: 'view',
  needs: 0,
  params: [
    {
      key: 'elementType',
      default: 0,
      options: TYPES.map((t, value) => ({ value, labelKey: `drawing.options.${t}` })),
    },
  ],
  run(ctx) {
    const type = TYPES[ctx.params?.elementType ?? 0] ?? 'rectangle';
    const ids = ctx.elements.filter((e) => e.type === type && !e.isDeleted).map((e) => e.id);
    return ids.length ? { view: { select: ids } } : {};
  },
};

/** "Copy selected element styles to global": new elements get the style of the first selected. */
const copyStyles: SceneAction = {
  id: 'copy-styles-to-defaults',
  group: 'view',
  needs: 1,
  run(ctx) {
    const e = arrangeable(ctx)[0] ?? ctx.elements.find((x) => ctx.selected.includes(x.id));
    if (!e) return {};
    const appState: Record<string, unknown> = {};
    const map: Record<string, string> = {
      strokeColor: 'currentItemStrokeColor',
      backgroundColor: 'currentItemBackgroundColor',
      fillStyle: 'currentItemFillStyle',
      strokeWidth: 'currentItemStrokeWidth',
      strokeStyle: 'currentItemStrokeStyle',
      roughness: 'currentItemRoughness',
      opacity: 'currentItemOpacity',
      fontFamily: 'currentItemFontFamily',
      fontSize: 'currentItemFontSize',
      textAlign: 'currentItemTextAlign',
    };
    for (const [from, to] of Object.entries(map)) if (e[from] !== undefined) appState[to] = e[from];
    return Object.keys(appState).length ? { view: { appState } } : {};
  },
};

/** A pen: the freehand tool with a fixed style, bound to a command (so it can have a hotkey). */
function pen(id: string, style: { color: string; width: number; opacity: number }): SceneAction {
  return {
    id,
    group: 'view',
    needs: 0,
    run: () => ({
      view: {
        tool: 'freedraw',
        appState: {
          currentItemStrokeColor: style.color,
          currentItemStrokeWidth: style.width,
          currentItemOpacity: style.opacity,
          currentItemRoughness: 0,
          currentItemStrokeStyle: 'solid',
        },
      },
    }),
  };
}

export const PEN_ACTIONS: readonly SceneAction[] = [
  pen('pen-fine', { color: '#1e1e1e', width: 1, opacity: 100 }),
  pen('pen-marker', { color: '#e03131', width: 2, opacity: 100 }),
  pen('pen-highlighter', { color: '#ffd43b', width: 4, opacity: 40 }),
  {
    id: 'laser-pointer',
    group: 'view',
    needs: 0,
    run: () => ({ view: { tool: 'laser' } }),
  },
];

export const VIEW_ACTIONS: readonly SceneAction[] = [
  zoomToSelection,
  toggleGrid,
  setGridSize,
  selectOfType,
  copyStyles,
  ...PEN_ACTIONS,
];
