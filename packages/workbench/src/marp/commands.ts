// Marp presentations (ADR-0047): "New presentation", presenting, and the exports of the .marp file
// in focus (standalone HTML, PDF through the print dialog; PPTX is not available yet). The renderer
// is loaded on demand: none of this pulls marp-core into the startup bundle.
import { api } from '../app/api';
import { invalidateVault, uniqueName } from '../app/actions';
import { drawingBaseName, folderOf } from '../drawing/scene';
import { beginPrint, endPrint } from '../export/commands';
import { i18next } from '../i18n';
import { backendFor } from '../reading/ReadingView';
import { useActiveNote } from '../state/activeNote';
import { selectActivePath, useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { importWithRetry } from '../ui/lazyView';
import { activeTab } from '../workspace/layout';
import { exportAssets } from './assets';
import { deckHtmlDocument, PRINT_CSS } from './document';
import { present } from './presenter';

/** The first content of a new presentation: Marp on, the default theme, page numbers, two slides. */
export function newDeckContent(title: string): string {
  return `---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# ${title}\n\n---\n\n## ${i18next.t('marp.secondSlide')}\n\n- \n`;
}

export const isDeck = (path: string): boolean => /\.marp$/i.test(path);

const titleOf = (path: string): string => (path.split('/').pop() ?? path).replace(/\.marp$/i, '');

/** Creates a presentation next to the active file (or in dir) and opens it. */
export async function newPresentation(opts: { dir?: string } = {}): Promise<string> {
  const { vault, layout } = useAppStore.getState();
  if (!vault) throw new Error('no vault is open');
  const tab = activeTab(layout);
  const tree = await api.vault.listTree(vault.id);
  const base = drawingBaseName(new Date()).replace(/^Drawing/, 'Presentation');
  const path = uniqueName(tree, opts.dir ?? (tab ? folderOf(tab.path) : ''), base, '.marp');
  await api.vault.writeNote(vault.id, path, newDeckContent(titleOf(path)), '');
  invalidateVault(vault.id);
  useAppStore.getState().openNote(path, { newTab: true });
  return path;
}

/** The presentation in focus, as the user sees it (unsaved edits included), or null. */
async function currentDeck(): Promise<{ vaultId: string; path: string; content: string } | null> {
  const st = useAppStore.getState();
  const path = selectActivePath(st);
  if (!st.vault || !path || !isDeck(path)) return null;
  const live = useActiveNote.getState().note;
  if (live && live.path === path && live.vaultId === st.vault.id)
    return { vaultId: st.vault.id, path, content: live.current() };
  const read = await api.vault.readNote(st.vault.id, path);
  return { vaultId: st.vault.id, path, content: read.content };
}

async function renderForExport(): Promise<{
  vaultId: string;
  path: string;
  html: string;
  css: string;
} | null> {
  const deck = await currentDeck();
  if (!deck) {
    await dialog.alert(i18next.t('marp.title'), i18next.t('marp.notADeck'));
    return null;
  }
  const { renderDeck } = await importWithRetry(() => import('./engine'));
  const out = await renderDeck(deck.content, exportAssets(backendFor(deck.vaultId), deck.path));
  return { vaultId: deck.vaultId, path: deck.path, html: out.html, css: out.css };
}

/** Presents the presentation in focus, from its first slide. */
export async function presentDeck(): Promise<void> {
  const path = selectActivePath(useAppStore.getState());
  if (!path || !isDeck(path) || !present(path))
    await dialog.alert(i18next.t('marp.title'), i18next.t('marp.notADeck'));
}

/** Saves the presentation as one self-contained HTML file. */
export async function exportDeckHtml(): Promise<void> {
  try {
    const r = await renderForExport();
    if (!r) return;
    const html = deckHtmlDocument({
      title: titleOf(r.path),
      lang: i18next.language || 'en',
      css: r.css,
      html: r.html,
    });
    const res = await api.exporter.saveHtml(r.vaultId, titleOf(r.path), html);
    if (res.cancelled) return;
    await dialog.alert(i18next.t('marp.title'), i18next.t('marp.htmlDone', { path: res.path }));
  } catch (e) {
    await dialog.error(e);
  }
}

/** Opens the system print dialog with one slide per page ("Save as PDF" there makes the PDF). */
export async function exportDeckPdf(): Promise<void> {
  try {
    const r = await renderForExport();
    if (!r) return;
    beginPrint(r.html, { css: `${r.css}\n${PRINT_CSS}`, className: 'marp-print' });
    const imgs = [...document.querySelectorAll<HTMLImageElement>('#memobrain-print img')];
    await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    window.addEventListener('afterprint', endPrint, { once: true });
    try {
      await api.exporter.print();
    } catch {
      window.print(); // no native binding (plain browser): the web view's own print
    }
  } catch (e) {
    endPrint();
    await dialog.error(e);
  }
}

/** PPTX needs a headless browser that neither the desktop nor the browser has (ADR-0047). */
export async function exportDeckPptx(): Promise<void> {
  await dialog.alert(i18next.t('marp.title'), i18next.t('marp.pptxLater'));
}
