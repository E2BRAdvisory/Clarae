// SVG previews of drawings for embeds (§M3-WP2). The preview is rendered by Excalidraw
// (exportToSvg) and cached by the hash of the drawing's content through DrawingAPI, so a
// changed drawing simply misses the cache and an unchanged one never loads Excalidraw.
import { api } from '../app/api';
import { loadExcalidraw } from './excalidraw';
import { parseScene } from './scene';
import { refElements, refKey, type DrawingRef } from './embed/ref';
import { PreviewUrls } from '../embeds/previewUrls';

/** Thrown when an embed names a frame/group/area the drawing does not have. */
export class MissingPartError extends Error {
  override name = 'MissingPartError';
}

/** Renders the SVG of a drawing, or of one part of it (loads Excalidraw on first use). */
export async function renderSvg(text: string, ref: DrawingRef | null = null): Promise<string> {
  const ex = await loadExcalidraw();
  const scene = parseScene(text);
  let elements = ex.restoreElements(scene.elements as never, null);
  let frame: (typeof elements)[number] | null = null;
  if (ref) {
    const part = refElements(elements as unknown as Parameters<typeof refElements>[0], ref);
    if (!part) throw new MissingPartError(`${ref.kind}=${ref.value}`);
    elements = part.elements as unknown as typeof elements;
    frame = part.frame as unknown as typeof frame;
  }
  const svg = await ex.exportToSvg({
    elements: elements as never,
    ...(frame ? { exportingFrame: frame } : {}),
    appState: {
      exportBackground: true,
      viewBackgroundColor:
        typeof scene.appState['viewBackgroundColor'] === 'string'
          ? scene.appState['viewBackgroundColor']
          : '#ffffff',
    },
    files: scene.files as never,
    exportPadding: 12,
  });
  return new XMLSerializer().serializeToString(svg);
}

const urls = new PreviewUrls();

/** Revokes the drawing previews of a vault (it was closed). */
export function releaseDrawingPreviews(vaultId: string): void {
  urls.releaseVault(vaultId);
}

/**
 * Blob URL of the drawing's preview, for an <img>: in an image the SVG cannot run scripts or
 * load anything, and it keeps its own embedded fonts and styles.
 */
export async function drawingPreviewUrl(
  vaultId: string,
  path: string,
  ref: DrawingRef | null = null,
): Promise<string> {
  const note = await api.vault.readNote(vaultId, path);
  const part = refKey(ref);
  const key = `${note.hash}:${part}`;
  const hit = urls.get(vaultId, key);
  if (hit) return hit;
  // Only whole drawings use the on-disk cache (keyed by the content hash alone).
  let svg = ref ? '' : await api.drawing.readPreview(vaultId, note.hash).catch(() => '');
  if (!svg) {
    svg = await renderSvg(note.content, ref);
    if (!ref) void api.drawing.savePreview(vaultId, note.hash, svg).catch(() => undefined);
  }
  return urls.put(vaultId, `${path}\u0000${part}`, key, svg);
}
