// "Text → diagram": converts Mermaid source (flowchart, sequence and class diagrams natively;
// other types fall back to a picture) into editable Excalidraw elements, offline, with the
// Excalidraw Extras' converter. The converter bundles its own mermaid 10 (isolated from the
// app's mermaid 12 used by the reading view) and is loaded lazily, only for this dialog.
//
// Security (ADR-0005): `securityLevel: 'strict'` is passed explicitly, and the result is plain
// Excalidraw elements/images: nothing from the diagram is ever inserted as HTML.
import type { SceneElement, SceneFile, ScenePatch } from '../actions/types';

export interface Converted {
  /** Excalidraw element skeletons, as produced by the converter. */
  elements: unknown[];
  files?: Record<string, SceneFile> | undefined;
}

export interface MermaidDeps {
  parse(definition: string): Promise<Converted>;
  /** Excalidraw's convertToExcalidrawElements (skeletons → full elements, new ids). */
  convert(skeletons: unknown[]): SceneElement[];
}

/** The real converter (lazy). Cleans up the DOM the converter may leave behind on failure. */
export async function parseMermaid(definition: string): Promise<Converted> {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  try {
    const r = await parseMermaidToExcalidraw(definition, {
      securityLevel: 'strict',
    } as Parameters<typeof parseMermaidToExcalidraw>[1]);
    return {
      elements: r.elements as unknown[],
      files: r.files as Record<string, SceneFile> | undefined,
    };
  } finally {
    // mermaid.render() leaves its scratch nodes in <body> when it throws.
    for (const id of ['dmermaid-to-excalidraw', 'mermaid-diagram'])
      document.getElementById(id)?.remove();
  }
}

const n = (e: SceneElement, k: string): number => (typeof e[k] === 'number' ? e[k] : 0);

/**
 * Centers the converted elements on `center` and groups them (so the diagram moves as one
 * piece; ungrouping gives the individual shapes back). Pure.
 */
export function placeDiagram(
  elements: readonly SceneElement[],
  files: Record<string, SceneFile> | undefined,
  center: { x: number; y: number },
  groupId: string,
): ScenePatch {
  if (elements.length === 0) throw new Error('the diagram is empty');
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const e of elements) {
    l = Math.min(l, n(e, 'x'), n(e, 'x') + n(e, 'width'));
    t = Math.min(t, n(e, 'y'), n(e, 'y') + n(e, 'height'));
    r = Math.max(r, n(e, 'x'), n(e, 'x') + n(e, 'width'));
    b = Math.max(b, n(e, 'y'), n(e, 'y') + n(e, 'height'));
  }
  const dx = center.x - (l + r) / 2;
  const dy = center.y - (t + b) / 2;
  const add = elements.map((e) => ({
    ...e,
    x: n(e, 'x') + dx,
    y: n(e, 'y') + dy,
    groupIds: [...(Array.isArray(e.groupIds) ? (e.groupIds as string[]) : []), groupId],
  }));
  return { add, ...(files && Object.keys(files).length ? { files } : {}) };
}

/** Mermaid source → the patch that inserts the diagram. Throws the converter's message on bad syntax. */
export async function mermaidPatch(
  source: string,
  center: { x: number; y: number },
  deps: MermaidDeps,
  groupId: string = crypto.randomUUID(),
): Promise<ScenePatch> {
  if (!source.trim()) throw new Error('empty diagram');
  const parsed = await deps.parse(source);
  return placeDiagram(deps.convert(parsed.elements), parsed.files, center, groupId);
}
