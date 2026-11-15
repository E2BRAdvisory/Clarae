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

/**
 * Renders the SVG of a drawing, or of one part of it (loads Excalidraw on first use). `theme`
 * dark gives the picture Excalidraw shows in its dark theme, for a page that is dark; what leaves
 * the app (print, export, a picture inside another drawing) stays light.
 */
export async function renderSvg(
  text: string,
  ref: DrawingRef | null = null,
  theme: 'light' | 'dark' = 'light',
): Promise<string> {
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
      exportWithDarkMode: theme === 'dark',
    },
    files: scene.files as never,
    exportPadding: 12,
  });
  return new XMLSerializer().serializeToString(svg);
}

const urls = new PreviewUrls();
/** Pictures being drawn, by vault, file, part and version: two embeds of a drawing share one. */
const drawn = new Map<string, Promise<string>>();

/** Revokes the drawing previews of a vault (it was closed). */
export function releaseDrawingPreviews(vaultId: string): void {
  urls.releaseVault(vaultId);
}

/**
 * Blob URL of the drawing's preview, for an <img>: in an image the SVG cannot run scripts or
 * load anything, and it keeps its own embedded fonts and styles.
 *
 * The core says which version of the drawing is on disk (its content hash) and hands over the
 * picture cached for it: the drawing itself — megabytes, with pictures in it — is read only when
 * there is no picture of that version yet. A picture belongs to a theme: the light and the dark
 * one of a drawing are cached side by side.
 */
export async function drawingPreviewUrl(
  vaultId: string,
  path: string,
  ref: DrawingRef | null = null,
  theme: 'light' | 'dark' = 'light',
): Promise<string> {
  const variant = theme === 'dark' ? 'dark' : '';
  const part = `${refKey(ref)}:${variant}`;
  const slot = `${path}\u0000${part}`;
  const cached = await api.drawing.preview(vaultId, path, variant);
  const hit = urls.get(vaultId, `${cached.hash}:${part}`);
  if (hit) return hit;
  // Only whole drawings use the on-disk cache (keyed by the content hash alone).
  if (!ref && cached.svg) return urls.put(vaultId, slot, `${cached.hash}:${part}`, cached.svg);
  // No picture of this version: read it and draw it, once for all the embeds that ask meanwhile.
  const asked = `${vaultId}\u0000${slot}\u0000${cached.hash}`;
  let drawing = drawn.get(asked);
  if (!drawing) {
    drawing = (async () => {
      const note = await api.vault.readNote(vaultId, path);
      const svg = await renderSvg(note.content, ref, theme);
      if (!ref)
        void api.drawing.savePreview(vaultId, note.hash, variant, svg).catch(() => undefined);
      // The drawing may have changed since the question above: filed under the hash of what was read.
      return urls.put(vaultId, slot, `${note.hash}:${part}`, svg);
    })().finally(() => drawn.delete(asked));
    drawn.set(asked, drawing);
  }
  return drawing;
}
