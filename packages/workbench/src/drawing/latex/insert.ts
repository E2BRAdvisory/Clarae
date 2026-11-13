// Inserting and editing LaTeX formulas in a drawing. A formula is an ordinary `image` element
// (an SVG in the drawing's `files`) whose `customData.clarae` keeps the TeX source, so the
// file stays plain Excalidraw JSON that any tool can open, and the merge by element id is
// untouched.
import type { SceneElement, ScenePatch } from '../actions/types';
import { newId } from '../actions/ids';
import { contentId, svgDataUrl, texToSvg } from './tex2svg';

export const LATEX_KIND = 'latex';
const FONT_SIZE = 24;

export interface LatexMeta {
  kind: typeof LATEX_KIND;
  latex: string;
  /** Rendered width at font size 24: the element's current width / w0 is the user's scale. */
  w0: number;
  /** Glyph color the SVG was rendered with. */
  color: string;
}

/** The formula source of an element, or null when it is not a formula. */
export function latexOf(e: SceneElement | undefined): LatexMeta | null {
  const meta = (e?.customData as { clarae?: Partial<LatexMeta> } | undefined)?.clarae;
  return meta?.kind === LATEX_KIND && typeof meta.latex === 'string'
    ? {
        kind: LATEX_KIND,
        latex: meta.latex,
        w0: typeof meta.w0 === 'number' ? meta.w0 : 0,
        color: typeof meta.color === 'string' ? meta.color : '#000000',
      }
    : null;
}

/**
 * The patch that inserts a formula centered on `center`, or replaces the one in `existing`
 * (keeping its position, rotation and the user's scaling). Throws with MathJax's message when
 * the TeX is invalid, so the dialog can show it.
 */
export async function latexPatch(
  tex: string,
  o: { center: { x: number; y: number }; color?: string; existing?: SceneElement | undefined },
): Promise<ScenePatch> {
  const prev = o.existing ? latexOf(o.existing) : null;
  // A new formula takes the drawing's current stroke color; an edit keeps its own.
  const color = o.color ?? prev?.color ?? '#000000';
  const r = await texToSvg(tex, { fontSize: FONT_SIZE, color });
  const fileId = contentId(r.svg);
  const files = {
    [fileId]: {
      id: fileId,
      mimeType: 'image/svg+xml',
      dataURL: svgDataUrl(r.svg),
      created: Date.now(),
    },
  };
  const meta: LatexMeta = { kind: LATEX_KIND, latex: tex.trim(), w0: r.width, color };
  if (o.existing) {
    const scale = prev && prev.w0 > 0 ? Number(o.existing.width) / prev.w0 : 1;
    return {
      update: {
        [o.existing.id]: {
          fileId,
          width: r.width * scale,
          height: r.height * scale,
          customData: { ...(o.existing.customData as object), clarae: meta },
        },
      },
      files,
    };
  }
  return {
    add: [
      {
        id: newId(),
        type: 'image',
        x: o.center.x - r.width / 2,
        y: o.center.y - r.height / 2,
        width: r.width,
        height: r.height,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: null,
        link: null,
        locked: false,
        status: 'saved',
        fileId,
        scale: [1, 1],
        index: null,
        isDeleted: false,
        version: 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        customData: { clarae: meta },
      },
    ],
    files,
  };
}
