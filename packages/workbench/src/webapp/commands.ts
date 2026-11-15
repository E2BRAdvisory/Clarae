// The commands of the applications (M18, track E): creating one, changing its address, picking one,
// opening its page in the system's browser, going back and forward in it, and forgetting what the
// applications of the vault stored on this device. The registry (commands/registry.ts) lists them
// with their feature and capabilities; the work is here.
import { Feature } from '@clarae/api-client/features';
import { api } from '../app/api';
import { invalidateVault, uniqueName } from '../app/actions';
import { folderOf } from '../drawing/scene';
import { i18next } from '../i18n';
import { featureOn, useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { openExternal } from '../util/external';
import { activeTab } from '../workspace/layout';
import { bumpWebappRevision, readWebapp } from './files';
import {
  checkWebappUrl,
  completeUrl,
  fileNameOf,
  isWebapp,
  serializeWebapp,
  suggestName,
  WEBAPP_EXT,
} from './model';
import { nativeViews } from './nativeViews';
import { forgetOrigins } from './origins';

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? i18next.t(key, options) : i18next.t(key);

/** Applications are on in the profile in force (the flag `web_viewer`). */
export const webappsOn = (): boolean =>
  featureOn(useManaged.getState().features, Feature.WebViewer);

/** The tab of an application in focus, if there is one. */
export function activeWebappTab(): { id: string; path: string } | null {
  const tab = activeTab(useAppStore.getState().layout);
  return tab && isWebapp(tab.path) ? { id: tab.id, path: tab.path } : null;
}

const readOnly = (): boolean => {
  const v = useAppStore.getState().vault;
  return v ? infoOf(useSync.getState(), v.id).readOnly : false;
};

/** An application can be created or changed: a vault that may be written, and the flag. */
export const canEditWebapps = (): boolean =>
  useAppStore.getState().vault !== null && !readOnly() && webappsOn();

/** The message under the field of an address that cannot be used (a sentence per reason). */
export function urlProblemText(reason: string): string {
  return t(`webapp.problem.${reason}`);
}

/** Validates what the form of an address holds; null when it is fine. */
function validateAddress(values: Record<string, string>): string | null {
  const checked = checkWebappUrl(completeUrl(values['url'] ?? ''));
  return checked.ok ? null : urlProblemText(checked.reason);
}

/** Asks for a name and an address, writes the `.webapp` file next to the active file and opens it. */
export async function newApplication(opts: { dir?: string } = {}): Promise<string | null> {
  const { vault, layout } = useAppStore.getState();
  if (!vault) throw new Error('no vault is open');
  const answer = await dialog.form(
    t('webapp.new.title'),
    [
      {
        name: 'url',
        label: t('webapp.new.url'),
        placeholder: 'https://example.com',
        hint: t('webapp.new.urlHint'),
        type: 'url',
      },
      { name: 'name', label: t('webapp.new.name'), hint: t('webapp.new.nameHint') },
    ],
    validateAddress,
  );
  if (!answer) return null;
  const url = completeUrl(answer['url'] ?? '');
  const name = fileNameOf(answer['name'] ?? '') || fileNameOf(suggestName(url)) || 'Application';
  const tab = activeTab(layout);
  const tree = await api.vault.listTree(vault.id);
  const path = uniqueName(tree, opts.dir ?? (tab ? folderOf(tab.path) : ''), name, WEBAPP_EXT);
  await api.vault.writeNote(vault.id, path, serializeWebapp(url), '');
  invalidateVault(vault.id);
  useAppStore.getState().openNote(path, { newTab: true });
  return path;
}

/** Asks for another address for the application in focus and writes it into its file. */
export async function editApplicationUrl(): Promise<void> {
  const vault = useAppStore.getState().vault;
  const tab = activeWebappTab();
  if (!vault || !tab) return;
  const file = await readWebapp(vault.id, tab.path);
  const current = file.parse.ok ? file.parse.url : '';
  const answer = await dialog.form(
    t('webapp.editTitle'),
    [{ name: 'url', label: t('webapp.new.url'), initial: current, type: 'url' }],
    validateAddress,
  );
  if (!answer) return;
  const url = completeUrl(answer['url'] ?? '');
  if (url === current) return;
  // the hash read above: a change made meanwhile (another device) is a conflict, never overwritten
  await api.vault.writeNote(vault.id, tab.path, serializeWebapp(url), file.hash);
  invalidateVault(vault.id);
  bumpWebappRevision();
}

/** Lists the applications of the vault and opens the one picked. */
export async function pickApplication(): Promise<void> {
  const vault = useAppStore.getState().vault;
  if (!vault) return;
  const tree = await api.vault.listTree(vault.id);
  const items = tree
    .filter(
      (e) => !e.isDir && isWebapp(e.path) && !e.path.split('/').some((s) => s.startsWith('.')),
    )
    .map((e) => ({ value: e.path, label: e.path.slice(0, -WEBAPP_EXT.length) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (items.length === 0) {
    await dialog.alert(t('webapp.pick.title'), t('webapp.pick.none'));
    return;
  }
  const path = await dialog.pick(t('webapp.pick.title'), items);
  if (path) useAppStore.getState().openNote(path, { newTab: true });
}

/** Opens the page of the application in focus in the system's browser (a tab of the browser on the web). */
export async function openApplicationInBrowser(): Promise<void> {
  const vault = useAppStore.getState().vault;
  const tab = activeWebappTab();
  if (!vault || !tab) return;
  const file = await readWebapp(vault.id, tab.path);
  if (!file.parse.ok) {
    await dialog.alert(t('webapp.pick.title'), t(`webapp.invalid.${file.parse.reason}`));
    return;
  }
  // Where the user went inside the application is where the browser continues, if it is still an address
  // an application may open; otherwise the address of the file.
  const page = nativeViews.pageOf(tab.id)?.url ?? '';
  const there = checkWebappUrl(page);
  openExternal(there.ok ? there.url : file.parse.url);
}

/**
 * Forgets what the applications of the vault keep on this device: their cookies, sessions and
 * caches (the core closes their views), and the origins the user confirmed. The `.webapp` files
 * stay; the next opening of each asks for the confirmation again.
 */
export async function clearApplicationData(): Promise<void> {
  const vault = useAppStore.getState().vault;
  if (!vault) return;
  const yes = await dialog.confirm(
    t('webapp.clear.title'),
    t('webapp.clear.message'),
    true,
    t('webapp.clear.confirm'),
  );
  if (!yes) return;
  await nativeViews.clearData(vault.id);
  forgetOrigins(vault.id);
}

/** The commands of the navigation of the tab in focus are available when its view is open. */
export const navigation = {
  has: (): boolean => {
    const tab = activeWebappTab();
    return !!tab && nativeViews.hasView(tab.id);
  },
  canGoBack: (): boolean => {
    const tab = activeWebappTab();
    return !!tab && (nativeViews.pageOf(tab.id)?.canGoBack ?? false);
  },
  canGoForward: (): boolean => {
    const tab = activeWebappTab();
    return !!tab && (nativeViews.pageOf(tab.id)?.canGoForward ?? false);
  },
  back: (): void => {
    const tab = activeWebappTab();
    if (tab) nativeViews.back(tab.id);
  },
  forward: (): void => {
    const tab = activeWebappTab();
    if (tab) nativeViews.forward(tab.id);
  },
  reload: (): void => {
    const tab = activeWebappTab();
    if (tab) nativeViews.reload(tab.id);
  },
};
