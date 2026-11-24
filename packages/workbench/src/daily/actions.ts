// Daily notes, unique notes, templates and the random note: the operations behind the commands.
import i18next from 'i18next';
import { invalidateVault } from '../app/actions';
import { api, type TemplateInfo, type TemplateKind } from '../app/api';
import { getActiveEditor } from '../editor/registry';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { activeTab } from '../workspace/layout';
import { isConfigPath, isTrashPath } from '../platform/vaultPaths';
import { displayName } from '../embeds/media';
import { uiLang } from './lang';
import { useNotesSettings } from './settings';

export { uiLang };

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

/**
 * Label of a template in the picker: its name, with the sub-folder of the templates folder it is
 * in; library templates say where they come from.
 */
export function templateLabel(
  t: Pick<TemplateInfo, 'name' | 'rel' | 'source' | 'library'>,
): string {
  if (t.source === 'library') return `${t.name} (${t.library || i18next.t('templates.library')})`;
  const dir = t.rel.includes('/') ? t.rel.slice(0, t.rel.lastIndexOf('/')) : '';
  return dir ? `${t.name} (${dir})` : t.name;
}

/** The templates of one kind of the open vault (and of the group library). */
export async function listTemplates(kind: TemplateKind): Promise<TemplateInfo[]> {
  return (await api.templates.list(vaultId())).filter((t) => t.kind === kind);
}

/** Asks which template of a kind to use; null when cancelled or when there is none. */
export async function pickTemplate(kind: TemplateKind = 'note'): Promise<TemplateInfo | null> {
  const list = await listTemplates(kind);
  if (list.length === 0) {
    await dialog.alert(i18next.t('templates.title'), i18next.t('templates.none'));
    return null;
  }
  const ref = await dialog.pick(
    i18next.t('templates.pick'),
    list.map((t) => ({ value: t.ref, label: templateLabel(t) })),
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

const kindOfPath = (path: string): TemplateKind | null =>
  /\.md$/i.test(path)
    ? 'note'
    : /\.excalidraw$/i.test(path)
      ? 'drawing'
      : /\.marp$/i.test(path)
        ? 'presentation'
        : null;

/** Creates a drawing from a template the user picks and opens it. */
export async function newDrawingFromTemplate(): Promise<void> {
  const tpl = await pickTemplate('drawing');
  if (!tpl) return;
  const { newDrawing } = await import('../drawing/commands');
  await newDrawing({ template: tpl.ref });
}

/** Creates a presentation from a template the user picks and opens it. */
export async function newPresentationFromTemplate(): Promise<void> {
  const tpl = await pickTemplate('presentation');
  if (!tpl) return;
  const { newPresentation } = await import('../marp/commands');
  await newPresentation({ template: tpl.ref });
}

/** Adds the slides of a template after the slide of the cursor of the presentation in focus. */
async function applyDeckTemplate(path: string): Promise<void> {
  if (!getActiveEditor()) return;
  const tpl = await pickTemplate('presentation');
  if (!tpl) return;
  const text = await api.templates.expand(vaultId(), tpl.ref, displayName(path), uiLang());
  const [{ deckBody, insertSlidesEdit, slideAt }, { slideLinesOf }] = await Promise.all([
    import('../marp/slides'),
    import('../marp/engine'),
  ]);
  const view = getActiveEditor();
  if (!view || activePath() !== path) return;
  const source = view.text();
  const lines = slideLinesOf(source);
  const edits = insertSlidesEdit(
    source,
    lines,
    slideAt(lines, view.cursor().line - 1),
    deckBody(text),
  );
  view.applySourceEdits(source, edits, 'input.template');
  view.focus();
}

/**
 * "Apply template": adds a template of the kind of the file in focus to it. A note takes it at the
 * cursor, a drawing in the middle of what is on screen, a presentation as slides after the current one.
 */
export async function applyTemplate(): Promise<void> {
  const path = activePath();
  if (!path) return;
  switch (kindOfPath(path)) {
    case 'drawing': {
      const tpl = await pickTemplate('drawing');
      if (tpl && !(await (await import('../drawing/template')).applyDrawingTemplate(tpl.ref)))
        await dialog.alert(i18next.t('templates.title'), i18next.t('templates.emptyDrawing'));
      return;
    }
    case 'presentation':
      return applyDeckTemplate(path);
    case 'note':
      return insertTemplate();
    default:
  }
}

/** What a new template of each kind holds. */
async function blankTemplate(kind: TemplateKind, name: string): Promise<string> {
  if (kind === 'drawing') return (await import('../drawing/scene')).EMPTY_DRAWING;
  if (kind === 'presentation') return (await import('../marp/commands')).newDeckContent(name);
  return '';
}

/** "New template": asks kind and name, creates it in the templates folder and opens it to be edited. */
export async function newTemplate(kind?: TemplateKind): Promise<void> {
  const k =
    kind ??
    ((await dialog.pick(
      i18next.t('templates.kindPick'),
      (['note', 'drawing', 'presentation'] as const).map((value) => ({
        value,
        label: i18next.t(`templates.kind_${value}`),
      })),
    )) as TemplateKind | null);
  if (!k) return;
  const name = (await dialog.prompt(i18next.t('templates.templateName'), ''))?.trim();
  if (!name) return;
  const id = vaultId();
  const tpl = await api.templates.create(id, name, k, await blankTemplate(k, name));
  invalidateVault(id);
  useAppStore.getState().openNote(tpl.path, { newTab: true });
}

/** "Save as template": a copy of the file in focus, unsaved edits included, becomes a template. */
export async function saveAsTemplate(): Promise<void> {
  const path = activePath();
  const kind = path ? kindOfPath(path) : null;
  if (!path || !kind) return;
  const id = vaultId();
  const name = (
    await dialog.prompt(i18next.t('templates.templateName'), displayName(path))
  )?.trim();
  if (!name) return;
  let content: string;
  if (kind === 'drawing') {
    const { getSceneController } = await import('../drawing/actions/active');
    await getSceneController(path)?.save();
    content = (await api.vault.readNote(id, path)).content;
  } else {
    const view = getActiveEditor();
    content =
      view && activePath() === path ? view.text() : (await api.vault.readNote(id, path)).content;
  }
  const tpl = await api.templates.create(id, name, kind, content);
  invalidateVault(id);
  await dialog.alert(
    i18next.t('templates.title'),
    i18next.t('templates.saved', { name: tpl.name }),
  );
}

/** "Edit template": opens a template of the vault in a tab, like any file. */
export async function editTemplate(): Promise<void> {
  const list = (await api.templates.list(vaultId())).filter((t) => t.source === 'vault');
  if (list.length === 0) {
    await dialog.alert(i18next.t('templates.title'), i18next.t('templates.none'));
    return;
  }
  const ref = await dialog.pick(
    i18next.t('templates.pick'),
    list.map((t) => ({
      value: t.ref,
      label: `${templateLabel(t)} · ${i18next.t(`templates.kind_${t.kind}`)}`,
    })),
  );
  const tpl = list.find((t) => t.ref === ref);
  if (tpl) useAppStore.getState().openNote(tpl.path, { newTab: true });
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
    .filter((e) => !isTrashPath(e.path) && !isConfigPath(e.path))
    .map((e) => e.path);
  const pick = pickRandom(notes, activePath());
  if (!pick) {
    await dialog.alert(i18next.t('random.title'), i18next.t('random.none'));
    return;
  }
  useAppStore.getState().openNote(pick);
}
