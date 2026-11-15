// Reading an application (a `.webapp` file) from the vault, and telling the views that it changed.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../app/api';
import { onVaultChanges } from '../app/fileChanges';
import { parseWebapp, type WebappParse } from './model';

/** The file as the core has it: its hash (for a write that must not overwrite another edit) and what it says. */
export async function readWebapp(
  vaultId: string,
  path: string,
): Promise<{ hash: string; parse: WebappParse }> {
  const note = await api.vault.readNote(vaultId, path);
  return { hash: note.hash, parse: parseWebapp(note.content) };
}

/**
 * Bumped when this window changes an application file (the core's own watcher may not report what the
 * window wrote itself), so the tabs that show it read it again.
 */
const useRevision = create<{ rev: number }>(() => ({ rev: 0 }));
export const bumpWebappRevision = (): void => useRevision.setState((s) => ({ rev: s.rev + 1 }));

export type WebappFile =
  | { status: 'loading' }
  | { status: 'ready'; parse: WebappParse }
  | { status: 'error'; error: unknown };

/** The application file of a tab, kept current while the tab shows it. */
export function useWebappFile(vaultId: string, path: string): WebappFile {
  const rev = useRevision((s) => s.rev);
  const [file, setFile] = useState<{ key: string; value: WebappFile } | null>(null);
  const key = `${vaultId}\u0000${path}`;
  useEffect(() => {
    let stale = false;
    const load = (): void => {
      readWebapp(vaultId, path).then(
        (r) => !stale && setFile({ key, value: { status: 'ready', parse: r.parse } }),
        (error: unknown) => !stale && setFile({ key, value: { status: 'error', error } }),
      );
    };
    load();
    const off = onVaultChanges((b) => {
      if (b.vaultId === vaultId && (b.unknown || b.paths.includes(path))) load();
    });
    return () => {
      stale = true;
      off();
    };
  }, [vaultId, path, key, rev]);
  return file && file.key === key ? file.value : { status: 'loading' };
}
