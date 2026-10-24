// SVG previews of drawings for embeds (§M3-WP2). The preview is rendered by Excalidraw
// (exportToSvg) and cached by the hash of the drawing's content through DrawingAPI, so a
// changed drawing simply misses the cache and an unchanged one never loads Excalidraw.
import { api } from '../app/api';
import { loadExcalidraw } from './excalidraw';
import { parseScene } from './scene';

/** Renders the SVG of a drawing (loads Excalidraw on first use). */
export async function renderSvg(text: string): Promise<string> {
  const ex = await loadExcalidraw();
  const scene = parseScene(text);
  const svg = await ex.exportToSvg({
    elements: ex.restoreElements(scene.elements as never, null),
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

const urls = new Map<string, string>();

/**
 * Blob URL of the drawing's preview, for an <img>: in an image the SVG cannot run scripts or
 * load anything, and it keeps its own embedded fonts and styles.
 */
export async function drawingPreviewUrl(vaultId: string, path: string): Promise<string> {
  const note = await api.vault.readNote(vaultId, path);
  const hit = urls.get(note.hash);
  if (hit) return hit;
  let svg = await api.drawing.readPreview(vaultId, note.hash).catch(() => '');
  if (!svg) {
    svg = await renderSvg(note.content);
    void api.drawing.savePreview(vaultId, note.hash, svg).catch(() => undefined);
  }
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  urls.set(note.hash, url);
  return url;
}
