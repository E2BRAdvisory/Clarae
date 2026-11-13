// Marp presentations (ADR-0047): "New presentation", presenting, and the exports of the .marp file
// in focus (standalone HTML, PDF through the print dialog, editable PowerPoint) and presenting it
// full screen (marp/MarpShow.tsx). The renderer and the PPTX writer are loaded on demand: none of
// this pulls marp-core or pptxgenjs into the startup bundle.
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
import { useMarpShow } from './showStore';

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

/** The text of a presentation as the user sees it: the editor's, unsaved edits included. */
export async function deckSource(vaultId: string, path: string): Promise<string> {
  const live = useActiveNote.getState().note;
  if (live && live.path === path && live.vaultId === vaultId) return live.current();
  return (await api.vault.readNote(vaultId, path)).content;
}

/** The presentation in focus, as the user sees it (unsaved edits included), or null. */
export async function currentDeck(): Promise<{
  vaultId: string;
  path: string;
  content: string;
} | null> {
  const st = useAppStore.getState();
  const path = selectActivePath(st);
  if (!st.vault || !path || !isDeck(path)) return null;
  return { vaultId: st.vault.id, path, content: await deckSource(st.vault.id, path) };
}

async function renderForExport(): Promise<{
  vaultId: string;
  path: string;
  html: string;
  css: string;
  notes: string[];
} | null> {
  const deck = await currentDeck();
  if (!deck) {
    await dialog.alert(i18next.t('marp.title'), i18next.t('marp.notADeck'));
    return null;
  }
  const { renderDeck } = await importWithRetry(() => import('./engine'));
  const out = await renderDeck(deck.content, exportAssets(backendFor(deck.vaultId), deck.path));
  // The slides left out of the presentation are left out of every export.
  const { includedDeck } = await importWithRetry(() => import('./slides'));
  const kept = includedDeck(out);
  if (kept.indices.length === 0) {
    await dialog.alert(i18next.t('marp.title'), i18next.t('marp.show.empty'));
    return null;
  }
  return {
    vaultId: deck.vaultId,
    path: deck.path,
    html: kept.html,
    css: out.css,
    notes: kept.notes,
  };
}

/** Presents the presentation in focus full screen, from its first slide (or the one asked for). */
export async function presentDeck(from = 0): Promise<void> {
  const st = useAppStore.getState();
  const path = selectActivePath(st);
  if (!st.vault || !path || !isDeck(path))
    return dialog.alert(i18next.t('marp.title'), i18next.t('marp.notADeck'));
  useMarpShow.getState().start(st.vault.id, path, from);
}

/** Saves the presentation as one self-contained HTML file. */
export async function exportDeckHtml(): Promise<void> {
  try {
    const r = await renderForExport();
    if (!r) return;
    const { deckHtmlDocument } = await importWithRetry(() => import('./document'));
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
    const { PRINT_CSS } = await importWithRetry(() => import('./document'));
    beginPrint(r.html, { css: `${r.css}\n${PRINT_CSS}`, className: 'marp-print' });
    const imgs = [...document.querySelectorAll<HTMLImageElement>('#clarae-print img')];
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

/** The MIME type the save binding accepts for a PowerPoint file. */
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Saves the presentation as an editable PowerPoint file (theme approximated, notes included). */
export async function exportDeckPptx(): Promise<void> {
  try {
    const deck = await currentDeck();
    if (!deck) {
      await dialog.alert(i18next.t('marp.title'), i18next.t('marp.notADeck'));
      return;
    }
    const { renderDeck } = await importWithRetry(() => import('./engine'));
    const out = await renderDeck(deck.content, exportAssets(backendFor(deck.vaultId), deck.path));
    const { includedDeck } = await importWithRetry(() => import('./slides'));
    const kept = includedDeck(out);
    if (kept.indices.length === 0) {
      await dialog.alert(i18next.t('marp.title'), i18next.t('marp.show.empty'));
      return;
    }
    const { deckToPptx } = await importWithRetry(() => import('./pptx'));
    const { data: b64, skipped } = await deckToPptx({
      html: kept.html,
      notes: kept.notes,
      title: titleOf(deck.path),
      lang: i18next.language || 'en',
    });
    const res = await api.exporter.saveFile(deck.vaultId, titleOf(deck.path), PPTX_MIME, b64);
    if (res.cancelled) return;
    await dialog.alert(
      i18next.t('marp.title'),
      [
        i18next.t('marp.pptxDone', { path: res.path }),
        skipped.length ? i18next.t('marp.pptxSkipped', { list: skipped.join(', ') }) : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  } catch (e) {
    await dialog.error(e);
  }
}
