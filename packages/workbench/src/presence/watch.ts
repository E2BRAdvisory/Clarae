// The life of a watch (ADR-0065): a view that shows a file of a shared vault watches it while it is on screen
// and stops with it (tab in front, file changed, tab or vault closed). The core counts the watches of a file, so a
// second pane with the same file is one more Watch and one more Unwatch here; it registers nothing for a file it
// cannot observe (not synced yet, offline), so the request is repeated when the sync state changes.
import { useEffect } from 'react';
import { api } from '../app/api';
import { Events } from '../app/events';
import { useCan } from '../platform';
import { featureOn, useManaged } from '../state/managed';
import { infoOf, useSync } from '../state/sync';
import { roomKey, usePresenceStore } from './store';

/** The watches this window holds, by file: when the last one goes, nothing of the file is left on screen. */
const held = new Map<string, number>();

function hold(vaultId: string, path: string): () => void {
  const key = roomKey(vaultId, path);
  held.set(key, (held.get(key) ?? 0) + 1);
  return () => {
    const n = (held.get(key) ?? 1) - 1;
    if (n > 0) return void held.set(key, n);
    held.delete(key);
    usePresenceStore.getState().cleared(vaultId, path);
  };
}

/**
 * Whether presence applies to a vault: the capability of the host, the flag of the profile and a shared vault
 * linked to the cloud (a private one never takes part, and the core says `not-shared` for what is not shared, a folder that is not linked has nobody to meet).
 */
export function usePresenceEnabled(vaultId: string | null | undefined): boolean {
  const capable = useCan('presence');
  const flag = useManaged((m) => featureOn(m.features, 'presence'));
  const shared = useSync((s) => {
    const info = vaultId ? infoOf(s, vaultId) : undefined;
    return !!info && info.linked && info.kind !== 'private';
  });
  return capable && flag && shared;
}

/**
 * Watches a file while the view is mounted and `on`; `path` may be null (nothing to watch). Unwatches on
 * every change of the file, the vault or the switch, and on unmount.
 */
export function usePresenceWatch(vaultId: string, path: string | null, on: boolean): void {
  useEffect(() => {
    if (!on || !path) return;
    let alive = true;
    let watching = false;
    let asking = false;
    const release = hold(vaultId, path);
    const stop = (): void => {
      void api.presence.unwatch(vaultId, path).catch(() => undefined);
    };
    const ask = async (): Promise<void> => {
      if (watching || asking) return;
      asking = true;
      try {
        const r = await api.presence.watch(vaultId, path);
        if (!alive) {
          if (r.watching) stop(); // the view went away while the core was answering
          return;
        }
        watching = r.watching;
      } catch {
        /* refused (host without it, vault closed): not watched, asked again at the next sync state */
      } finally {
        asking = false;
      }
    };
    void ask();
    const off = api.on(Events.syncStatus, (s) => {
      if (s.vaultId === vaultId) void ask();
    });
    return () => {
      alive = false;
      off();
      if (watching) stop();
      release();
    };
  }, [vaultId, path, on]);
}
