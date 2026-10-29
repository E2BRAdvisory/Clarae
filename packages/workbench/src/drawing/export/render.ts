// Renders an export with Excalidraw: PNG/SVG of the whole drawing, the selection or one frame,
// optionally with the scene embedded so the file can be dropped back into Excalidraw.
import type * as Excalidraw from '@excalidraw/excalidraw';
import { scopeElements, type ExportOptions } from './options';

type Ex = typeof Excalidraw;

export interface ExportInput {
  elements: readonly { id: string; type: string; isDeleted?: boolean }[];
  appState: Record<string, unknown>;
  files: unknown;
  selected: readonly string[];
}

export interface Rendered {
  mime: 'image/png' | 'image/svg+xml';
  base64: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** PNG size at `scale`x (Excalidraw's own getDimensions hook). */
export function dimensionsFor(scale: number) {
  return (width: number, height: number) => ({
    width: width * scale,
    height: height * scale,
    scale,
  });
}

/** Throws "nothing to export" when the scope is empty (no selection, unknown frame). */
export async function renderExport(
  ex: Ex,
  input: ExportInput,
  o: ExportOptions,
): Promise<Rendered> {
  const { elements, frame } = scopeElements(
    input.elements as { id: string; type: string; isDeleted?: boolean }[],
    input.selected,
    o.scope,
  );
  if (elements.length === 0) throw new Error('nothing to export');
  const base = {
    elements: elements as never,
    files: input.files as never,
    exportPadding: o.padding,
    ...(frame ? { exportingFrame: frame as never } : {}),
  };
  // The public export API ignores appState.exportScale: the scale is given through getDimensions.
  const sized = { ...base, getDimensions: dimensionsFor(o.scale) };
  const appState = {
    ...input.appState,
    exportBackground: o.background,
    exportScale: o.scale,
    exportWithDarkMode: o.dark,
    exportEmbedScene: o.embedScene,
  } as never;
  if (o.format === 'png') {
    const blob = await ex.exportToBlob({ ...sized, appState, mimeType: 'image/png' });
    return { mime: 'image/png', base64: await blobToBase64(blob) };
  }
  const svg = await ex.exportToSvg({ ...base, appState });
  const text = new XMLSerializer().serializeToString(svg);
  return { mime: 'image/svg+xml', base64: bytesToBase64(new TextEncoder().encode(text)) };
}

/** Puts the same selection of elements on the clipboard (PNG or SVG). */
export async function copyExport(ex: Ex, input: ExportInput, o: ExportOptions): Promise<void> {
  const { elements, frame } = scopeElements(
    input.elements as { id: string; type: string; isDeleted?: boolean }[],
    input.selected,
    o.scope,
  );
  if (elements.length === 0) throw new Error('nothing to export');
  await ex.exportToClipboard({
    elements: elements as never,
    files: input.files as never,
    appState: {
      ...input.appState,
      exportBackground: o.background,
      exportScale: o.scale,
      exportWithDarkMode: o.dark,
      exportEmbedScene: o.embedScene,
    },
    type: o.format,
    getDimensions: dimensionsFor(o.scale),
    ...(frame ? { exportingFrame: frame as never } : {}),
  });
}
