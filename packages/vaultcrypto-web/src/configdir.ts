// The names of the configuration folder of a vault, for the names in an exported archive. They are
// the ones of shared/go/pathrules (ConfigDir, LegacyConfigDirs), which the Go server uses to write the
// ZIP of a shared vault (services/cloud/internal/export, archivePath): a ZIP of a private vault, made
// here from the decrypted paths, must give the same names. configdir.test.ts compares them with the
// constants generated from Go for the workbench (platform/vaultPaths.gen.ts).

/** The configuration folder of a vault. */
export const CONFIG_DIR = '.clarae';

/** Its former names, most recent first: written by 1.x clients, never by the current ones (ADR-0052). */
export const LEGACY_CONFIG_DIRS: readonly string[] = ['.memobrain'];

const hasPrefix = (p: string, dir: string) => p === dir || p.startsWith(dir + '/');

/**
 * The name a file gets in the archive: a file of a former configuration folder is written under
 * `.clarae/`, so that a vault exported after the rename has one settings folder (ADR-0059). Any other
 * path, the former folder itself included, is unchanged (Go: archivePath).
 */
export function archivePath(p: string): string {
  if (hasPrefix(p, CONFIG_DIR)) return p;
  for (const dir of LEGACY_CONFIG_DIRS) {
    if (p.startsWith(dir + '/') && p.length > dir.length + 1)
      return `${CONFIG_DIR}/${p.slice(dir.length + 1)}`;
  }
  return p;
}
