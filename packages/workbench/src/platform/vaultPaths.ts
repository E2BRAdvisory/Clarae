// The vault's own folders, as the UI needs them. The names come from the Go core
// (vaultPaths.gen.ts, from shared/go/pathrules): the configuration folder is CONFIG_DIR, and a vault
// created by a 1.x client, or shared with one, still has settings under a former name
// (LEGACY_CONFIG_DIRS, ADR-0052). The UI never builds such a path to read or write a setting: that
// goes through api.vault.readConfig / writeConfig, which know where the file is. Here are only the
// checks on the paths the core reports.
import { CONFIG_DIR, LEGACY_CONFIG_DIRS, TRASH_DIR } from './vaultPaths.gen';

export { CONFIG_DIR, LEGACY_CONFIG_DIRS, TRASH_DIR };

const CONFIG_DIRS: readonly string[] = [CONFIG_DIR, ...LEGACY_CONFIG_DIRS];

/** Whether a vault path is the configuration folder, current or former, or something inside it. */
export function isConfigPath(path: string): boolean {
  return CONFIG_DIRS.some((dir) => path === dir || path.startsWith(dir + '/'));
}

/**
 * The name of a file of the configuration folder (`bookmarks.json`, `cache/x`), wherever the vault
 * keeps it; null for any other path and for the folder itself.
 */
export function configFile(path: string): string | null {
  for (const dir of CONFIG_DIRS) {
    if (path.startsWith(dir + '/') && path.length > dir.length + 1)
      return path.slice(dir.length + 1);
  }
  return null;
}

/** Whether a vault path is the in-vault trash folder or something inside it. */
export function isTrashPath(path: string): boolean {
  return path === TRASH_DIR || path.startsWith(TRASH_DIR + '/');
}
