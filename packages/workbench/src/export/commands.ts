// "Export to PDF" and "Export to HTML" for the note in focus (commands `note:export-pdf` and
// `note:export-html`). Both render through renderExportBody, so what is printed and what is saved
// are the same document. Read-only vaults can be exported: nothing is ever written to the vault.
import i18next from 'i18next';
import { api } from '../app/api';
import { backendFor } from '../reading/ReadingView';
import { useActiveNote } from '../state/activeNote';
import { selectActivePath, useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { printCss, standaloneCss } from './css';
import { buildHtmlDocument } from './html';
import { renderExportBody, type ExportBody } from './render';

const t = (key: string, opts: Record<string, unknown> = {}): string =>
  i18next.t(`exportNote.${key}`, opts);

const PRINT_ID = 'memobrain-print';
const PRINT_STYLE_ID = 'memobrain-print-style';

/** The note in focus, as the user sees it (unsaved edits included), or null. */
async function currentNote(): Promise<{ vaultId: string; path: string; content: string } | null> {
  const st = useAppStore.getState();
  const path = selectActivePath(st);
  if (!st.vault || !path || !path.toLowerCase().endsWith('.md')) return null;
  const live = useActiveNote.getState().note;
  if (live && live.path === path && live.vaultId === st.vault.id)
    return { vaultId: st.vault.id, path, content: live.current() };
  const read = await api.vault.readNote(st.vault.id, path);
  return { vaultId: st.vault.id, path, content: read.content };
}

const title = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

async function render(): Promise<{ path: string; vaultId: string; body: ExportBody } | null> {
  const note = await currentNote();
  if (!note) {
    await dialog.alert(t('title'), t('notANote'));
    return null;
  }
  const body = await renderExportBody({
    backend: backendFor(note.vaultId),
    path: note.path,
    content: note.content,
  });
  return { ...note, body };
}

function warnings(body: ExportBody): string {
  const out: string[] = [];
  if (body.skipped.length)
    out.push(t('skipped', { count: body.skipped.length, files: body.skipped.join(', ') }));
  if (body.omitted.length)
    out.push(t('omitted', { count: body.omitted.length, files: body.omitted.join(', ') }));
  return out.join('\n');
}

/** Saves the note as one self-contained HTML file chosen in the native "save as" dialog. */
export async function exportNoteHtml(): Promise<void> {
  try {
    const r = await render();
    if (!r) return;
    const html = buildHtmlDocument({
      title: title(r.path),
      lang: i18next.language || 'en',
      body: r.body.html,
    });
    const res = await api.exporter.saveHtml(r.vaultId, title(r.path), html);
    if (res.cancelled) return;
    const warn = warnings(r.body);
    await dialog.alert(t('title'), t('htmlDone', { path: res.path }) + (warn ? `\n\n${warn}` : ''));
  } catch (e) {
    await dialog.error(e);
  }
}

/** Removes the print layer (the application is back to normal). */
export function endPrint(): void {
  document.getElementById(PRINT_ID)?.remove();
  document.getElementById(PRINT_STYLE_ID)?.remove();
  document.body.classList.remove('printing');
}

/**
 * Builds the print layer: the document in a light, paper-oriented layout; the stylesheet shows only
 * this layer when the page is printed and hides it on screen. A presentation brings its own
 * stylesheet (its theme and one slide per page) and class.
 */
export function beginPrint(
  bodyHtml: string,
  opts: { css?: string; className?: string } = {},
): void {
  endPrint();
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = opts.css ?? printCss();
  const layer = document.createElement('div');
  layer.id = PRINT_ID;
  const doc = document.createElement('article');
  doc.className = opts.className ?? 'export-doc';
  doc.innerHTML = bodyHtml; // sanitized by renderExportBody or renderDeck
  layer.append(doc);
  document.head.append(style);
  document.body.append(layer);
  document.body.classList.add('printing');
}

/** Opens the system print dialog on the print layer; "Save as PDF" there produces the PDF. */
export async function exportNotePdf(): Promise<void> {
  try {
    const r = await render();
    if (!r) return;
    beginPrint(r.body.html);
    const imgs = [...document.querySelectorAll<HTMLImageElement>(`#${PRINT_ID} img`)];
    await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    window.addEventListener('afterprint', endPrint, { once: true });
    try {
      await api.exporter.print();
    } catch {
      window.print(); // no native binding (plain browser): the web view's own print
    }
    const warn = warnings(r.body);
    if (warn) await dialog.alert(t('title'), warn);
  } catch (e) {
    endPrint();
    await dialog.error(e);
  }
}

const XHTML = 'http://www.w3.org/1999/xhtml';
const IMAGE_WIDTH = 800;
/** Largest canvas side that every web view accepts. */
const MAX_CANVAS_SIDE = 16384;

/** Draws the rendered note (fixed width, light, paper-like) on a canvas and returns it as PNG. */
async function renderPng(bodyHtml: string): Promise<string> {
  const article = new DOMParser().parseFromString(
    `<article class="export-doc">${bodyHtml}</article>`,
    'text/html',
  ).body.firstElementChild as HTMLElement;
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = `${standaloneCss()}\n.export-doc { background: #fff; color: #1f2328; }`;
  const wrap = document.createElementNS(XHTML, 'div');
  wrap.setAttribute('style', `width:${IMAGE_WIDTH}px;background:#fff`);
  wrap.append(style, article);

  // Measure in the live document (same stylesheet, scoped to .export-doc), off screen.
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;left:-10000px;top:0;width:${IMAGE_WIDTH}px`;
  probe.append(wrap.cloneNode(true));
  document.body.append(probe);
  await Promise.all(
    [...probe.querySelectorAll('img')].map((i) => i.decode().catch(() => undefined)),
  );
  const height = Math.ceil(probe.scrollHeight);
  probe.remove();
  if (height > MAX_CANVAS_SIDE) throw new Error(t('imageTooTall'));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${height}">` +
    `<foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();

  const scale = Math.min(2, MAX_CANVAS_SIDE / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(IMAGE_WIDTH * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('imageFailed'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  const url = canvas.toDataURL('image/png'); // throws if the web view tainted the canvas
  return url.slice(url.indexOf(',') + 1);
}

/** Saves the note as one PNG image chosen in the native "save as" dialog. */
export async function exportNoteImage(): Promise<void> {
  try {
    const r = await render();
    if (!r) return;
    const png = await renderPng(r.body.html);
    const res = await api.exporter.saveFile(r.vaultId, title(r.path), 'image/png', png);
    if (res.cancelled) return;
    const warn = warnings(r.body);
    await dialog.alert(
      t('title'),
      t('imageDone', { path: res.path }) + (warn ? `\n\n${warn}` : ''),
    );
  } catch (e) {
    await dialog.error(e);
  }
}
