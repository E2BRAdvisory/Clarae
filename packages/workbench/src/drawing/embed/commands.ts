// "Insert an image from the vault" and "Insert a note as a card": commands of the drawing editor
// that bring vault content into the open drawing.
import i18next from 'i18next';
import { api } from '../../app/api';
import { dialog } from '../../ui/dialogs';
import { getSceneController } from '../actions/active';
import { bytesToBase64 } from '../export/render';
import { renderSvg } from '../preview';
import { imagePatch, isImagePath, noteCardPatch } from './insert';

const MAX_LISTED = 2000;

const t = (key: string): string => i18next.t(`drawing.embedInsert.${key}`);

/** Natural size of an image, decoded by the browser. */
function imageSize(dataURL: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(t('unreadable')));
    img.src = dataURL;
  });
}

async function guard(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    await dialog.error(e);
  }
}

/** Pick an image of the vault and add it to the drawing (stored in the drawing's `files`). */
export function insertImageIntoDrawing(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const images = (await api.vault.listTree(c.vaultId))
      .filter((e) => !e.isDir && isImagePath(e.path))
      .map((e) => e.path)
      .sort()
      .slice(0, MAX_LISTED);
    if (images.length === 0) return dialog.alert(t('imageTitle'), t('noImages'));
    const picked = await dialog.pick(
      t('imageTitle'),
      images.map((p) => ({ value: p, label: p })),
    );
    if (!picked) return;
    await insertImageAt(picked);
  });
}

type Point = { x: number; y: number };

/** Adds the image at `path` to the open drawing, centered on `at` (default: the view). */
export async function insertImageAt(path: string, at?: Point): Promise<void> {
  const c = getSceneController();
  if (!c?.canEdit()) return;
  const content = await api.vault.readBinary(c.vaultId, path);
  const natural = await imageSize(`data:${content.mime};base64,${content.data}`);
  c.apply(imagePatch(content, natural, at ?? c.viewportCenter()));
}

/** Adds the note at `path` to the open drawing as a card, centered on `at` (default: the view). */
export async function insertNoteAt(path: string, at?: Point): Promise<void> {
  const c = getSceneController();
  if (!c?.canEdit()) return;
  const note = await api.vault.readNote(c.vaultId, path);
  c.apply(noteCardPatch(path, note.content, at ?? c.viewportCenter()));
}

/** Natural size of an SVG, from the width/height (or viewBox) Excalidraw writes on it. */
export function svgSize(svg: string): { width: number; height: number } {
  const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const num = (name: string): number =>
    Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(open)?.[1]);
  const vb = /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)"/.exec(open);
  return {
    width: num('width') || Number(vb?.[1]) || 0,
    height: num('height') || Number(vb?.[2]) || 0,
  };
}

/** Adds another drawing of the vault as a picture (SVG in `files`), centered on `at`. */
export async function insertDrawingAt(path: string, at?: Point): Promise<void> {
  const c = getSceneController();
  if (!c?.canEdit()) return;
  if (path === c.drawingPath) {
    await dialog.alert(t('drawingTitle'), t('cannotSelf'));
    return;
  }
  const note = await api.vault.readNote(c.vaultId, path);
  const svg = await renderSvg(note.content);
  const bytes = new TextEncoder().encode(svg);
  const image = { path, mime: 'image/svg+xml', data: bytesToBase64(bytes), size: bytes.length };
  c.apply(imagePatch(image, svgSize(svg), at ?? c.viewportCenter(), 400, 'drawing'));
}

/** Pick another drawing of the vault and add it to this one as a picture. */
export function insertDrawingIntoDrawing(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const drawings = (await api.vault.listTree(c.vaultId))
      .filter((e) => !e.isDir && /\.excalidraw$/i.test(e.path) && e.path !== c.drawingPath)
      .map((e) => e.path)
      .sort()
      .slice(0, MAX_LISTED);
    if (drawings.length === 0) return dialog.alert(t('drawingTitle'), t('noDrawings'));
    const picked = await dialog.pick(
      t('drawingTitle'),
      drawings.map((p) => ({ value: p, label: p.replace(/\.excalidraw$/i, '') })),
    );
    if (picked) await insertDrawingAt(picked);
  });
}

/** What dropping a vault file on the drawing does: images and notes are added, the rest is refused. */
export function dropVaultFile(path: string, at: Point): Promise<void> {
  return guard(async () => {
    if (isImagePath(path)) return insertImageAt(path, at);
    if (/\.md$/i.test(path)) return insertNoteAt(path, at);
    if (/\.excalidraw$/i.test(path)) return insertDrawingAt(path, at);
    await dialog.alert(t('dropTitle'), t('cannotDrop'));
  });
}

/** Search a note and add it to the drawing as a linked card. */
export function insertNoteIntoDrawing(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const query = await dialog.prompt(t('noteTitle'), '', t('noteSearch'));
    if (query === null) return;
    const rows = await api.links.suggest(c.vaultId, 'notes', query, '', 30);
    const paths = [...new Set(rows.map((r) => r.path).filter(Boolean))];
    if (paths.length === 0) return dialog.alert(t('noteTitle'), t('noNotes'));
    const picked = await dialog.pick(
      t('noteTitle'),
      paths.map((p) => ({ value: p, label: p.replace(/\.md$/i, '') })),
    );
    if (!picked) return;
    await insertNoteAt(picked);
  });
}
