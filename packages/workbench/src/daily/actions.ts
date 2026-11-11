// Daily notes, unique notes, templates and the random note: the operations behind the commands.
import i18next from 'i18next';
import { invalidateVault } from '../app/actions';
import { api, type TemplateInfo } from '../app/api';
import { getActiveEditor } from '../editor/registry';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { activeTab } from '../workspace/layout';
import { useNotesSettings } from './settings';

/** "it" or "en": the language of month and weekday names in templates. */
export function uiLang(): string {
  return (i18next.language || 'en').slice(0, 2).toLowerCase() === 'it' ? 'it' : 'en';
}

function vaultId(): string {
  const v = useAppStore.getState().vault;
  if (!v) throw new Error('no vault is open');
  return v.id;
}

const activePath = (): string | null => activeTab(useAppStore.getState().layout)?.path ?? null;

/** Opens today's daily note (or the one of `date`, YYYY-MM-DD), creating it from the template. */
export async function openDaily(date = ''): Promise<string> {
  const id = vaultId();
  const s = await useNotesSettings.getState().ready(id);
  const res = await api.templates.openDaily(id, {
    date,
    folder: s.dailyFolder,
    format: s.dailyFormat,
    template: s.dailyTemplate,
    lang: uiLang(),
  });
  if (res.created) invalidateVault(id);
  useAppStore.getState().openNote(res.path);
  return res.path;
}

/** Opens the daily note delta days after (negative: before) the active daily note. */
export async function openAdjacentDaily(delta: number): Promise<void> {
  const id = vaultId();
  const s = await useNotesSettings.getState().ready(id);
  const path = activePath();
  const day = path
    ? await api.templates.dailyAdjacent(path, s.dailyFolder, s.dailyFormat, uiLang(), delta)
    : '';
  if (!day) {
    await dialog.alert(i18next.t('daily.title'), i18next.t('daily.notDaily'));
    return;
  }
  await openDaily(day);
}

/** Creates a note named with a timestamp prefix and opens it. */
export async function newUniqueNote(): Promise<string> {
  const id = vaultId();
  const s = await useNotesSettings.getState().ready(id);
  const res = await api.templates.newUnique(id, {
    folder: s.uniqueFolder,
    format: s.uniqueFormat,
    template: s.uniqueTemplate,
    lang: uiLang(),
  });
  invalidateVault(id);
  useAppStore.getState().openNote(res.path);
  return res.path;
}

/** Label of a template in the picker: library templates say where they come from. */
export function templateLabel(
  t: Pick<TemplateInfo, 'name' | 'path' | 'source' | 'library'>,
  folder = '',
): string {
  if (t.source === 'library') return `${t.name} (${t.library || i18next.t('templates.library')})`;
  const base = (folder || 'Templates').replace(/\/+$/, '') + '/';
  const rel = t.path.startsWith(base) ? t.path.slice(base.length) : t.path;
  return rel.includes('/') ? `${t.name} (${rel.slice(0, rel.lastIndexOf('/'))})` : t.name;
}

/** Asks which template to use; null when cancelled or when there is none. */
export async function pickTemplate(): Promise<TemplateInfo | null> {
  const id = vaultId();
  const s = await useNotesSettings.getState().ready(id);
  const list = await api.templates.list(id, s.templatesFolder);
  if (list.length === 0) {
    await dialog.alert(
      i18next.t('templates.title'),
      i18next.t('templates.none', { folder: s.templatesFolder || 'Templates' }),
    );
    return null;
  }
  const ref = await dialog.pick(
    i18next.t('templates.pick'),
    list.map((t) => ({ value: t.ref, label: templateLabel(t, s.templatesFolder) })),
  );
  return list.find((t) => t.ref === ref) ?? null;
}

/** Inserts a template, with its variables expanded, at the cursor of the active editor. */
export async function insertTemplate(): Promise<void> {
  const view = getActiveEditor();
  const path = activePath();
  if (!view || !path) return;
  const tpl = await pickTemplate();
  if (!tpl) return;
  const title = path.replace(/^.*\//, '').replace(/\.md$/, '');
  const text = await api.templates.expand(vaultId(), tpl.ref, title, uiLang());
  view.replaceSelection(text);
  view.focus();
}

/** Creates a note from a template (asking for its name) and opens it. */
export async function newNoteFromTemplate(): Promise<void> {
  const tpl = await pickTemplate();
  if (!tpl) return;
  const name = await dialog.prompt(i18next.t('templates.newName'), 'Untitled');
  if (!name) return;
  const id = vaultId();
  const path = await api.templates.createFromTemplate(
    id,
    useSettings.getState().editor.newNoteFolder,
    name,
    tpl.ref,
    uiLang(),
  );
  invalidateVault(id);
  useAppStore.getState().openNote(path);
}

/** A uniformly random element of `paths` other than `exclude`; undefined when there is none. */
export function pickRandom<T>(
  items: readonly T[],
  exclude: T | null,
  rnd: () => number = Math.random,
): T | undefined {
  const pool = exclude === null ? items : items.filter((x) => x !== exclude);
  if (pool.length === 0) return undefined;
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

/** Opens a random note of the vault, never the current one. */
export async function openRandomNote(): Promise<void> {
  const id = vaultId();
  const tree = await api.vault.listTree(id);
  const notes = tree
    .filter((e) => !e.isDir && e.path.toLowerCase().endsWith('.md'))
    .filter((e) => !e.path.startsWith('.trash/') && !e.path.startsWith('.memobrain/'))
    .map((e) => e.path);
  const pick = pickRandom(notes, activePath());
  if (!pick) {
    await dialog.alert(i18next.t('random.title'), i18next.t('random.none'));
    return;
  }
  useAppStore.getState().openNote(pick);
}
