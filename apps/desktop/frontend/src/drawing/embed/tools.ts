// Commands that read or write other files of the vault from the open drawing: a new note with a
// card, deconstruct into a new drawing, refresh note cards, per-drawing auto-export.
import i18next from 'i18next';
import { invalidateVault, uniqueName } from '../../app/actions';
import { api } from '../../app/api';
import { useAppStore } from '../../state/store';
import { dialog } from '../../ui/dialogs';
import { getSceneController } from '../actions/active';
import { selectedElements, type SceneElement } from '../actions/types';
import { folderOf } from '../scene';
import { deconstruct } from './deconstruct';
import { noteCardPatch, noteExcerpt, wrapLines } from './insert';

const t = (key: string): string => i18next.t(`drawing.tools.${key}`);

async function guard(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    await dialog.error(e);
  }
}

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim();

/** "Create a new note and embed it": asks a name, creates the note next to the drawing, adds its card. */
export function createNoteAndEmbed(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const raw = await dialog.prompt(t('newNoteTitle'), '', t('newNoteName'));
    const name = raw === null ? '' : safeName(raw);
    if (!name) return;
    const dir = folderOf(c.drawingPath);
    const path = `${dir ? dir + '/' : ''}${name}.md`;
    await api.vault.writeNote(c.vaultId, path, `# ${name}\n\n`, ''); // '' = create, fails if it exists
    invalidateVault(c.vaultId);
    c.apply(noteCardPatch(path, `# ${name}\n\n`, c.viewportCenter()));
  });
}

/** "Deconstruct selected elements into a new drawing". */
export function deconstructIntoNewDrawing(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const out = deconstruct(c.context(), c.files());
    if (!out) return;
    const tree = await api.vault.listTree(c.vaultId);
    const base =
      c.drawingPath
        .split('/')
        .pop()
        ?.replace(/\.excalidraw$/i, '') ?? 'Drawing';
    const path = uniqueName(tree, folderOf(c.drawingPath), `${base} - part`, '.excalidraw');
    await api.vault.writeNote(c.vaultId, path, out.json, '');
    invalidateVault(c.vaultId);
    c.apply({ remove: out.ids });
    await c.save(); // before the tab changes: the editor is unmounted before it reports the edit
    useAppStore.getState().openNote(path, { newTab: true });
  });
}

/** A card's label, re-read from the note: the text only (the card keeps its size and look). */
export function refreshedLabel(path: string, markdown: string): string {
  const name = path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s*#\s+.*(?:\n|$)/, '');
  return wrapLines(`${name}\n\n${noteExcerpt(body)}`.trimEnd(), 36).join('\n');
}

const cardPath = (e: SceneElement): string | null => {
  const m = (e.customData as { memobrain?: { kind?: string; path?: string } } | undefined)
    ?.memobrain;
  return m?.kind === 'note' && typeof m.path === 'string' ? m.path : null;
};

/** "Update the selected note cards from their notes". */
export function refreshNoteCards(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const ctx = c.context();
    const update: Record<string, Record<string, unknown>> = {};
    for (const card of selectedElements(ctx)) {
      const path = cardPath(card);
      if (!path) continue;
      const label = ctx.elements.find(
        (e) => e.type === 'text' && e.containerId === card.id && !e.isDeleted,
      );
      if (!label) continue;
      let text: string;
      try {
        text = refreshedLabel(path, (await api.vault.readNote(c.vaultId, path)).content);
      } catch {
        continue; // the note is gone or renamed: the card keeps what it shows
      }
      if (text !== label.text) update[label.id] = { text, originalText: text };
    }
    if (Object.keys(update).length) c.apply({ update });
    else await dialog.alert(t('refreshTitle'), t('refreshNothing'));
  });
}

type AutoMode = 'none' | 'png' | 'svg' | 'both';

/** "Auto-export of this drawing": follow the vault setting, or override it for this file. */
export function setDrawingAutoExport(): Promise<void> {
  return guard(async () => {
    const c = getSceneController();
    if (!c?.canEdit()) return;
    const choices: { value: AutoMode | 'default'; label: string }[] = [
      { value: 'default', label: t('autoFollow') },
      ...(['none', 'png', 'svg', 'both'] as const).map((m) => ({
        value: m,
        label: i18next.t(`drawing.settings.auto_${m}`),
      })),
    ];
    const picked = await dialog.pick(t('autoTitle'), choices);
    if (!picked) return;
    c.setFileSetting('autoExport', picked === 'default' ? null : picked);
  });
}
