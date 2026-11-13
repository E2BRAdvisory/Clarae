import { useEffect, useRef } from 'react';
import { api } from '../app/api';
import { isGraphPath } from '../graph/paths';
import { normalizeLeftTab, normalizeRightTab, useAppStore } from '../state/store';
import { useSettings } from '../state/settings';
import { allPanes, parseLayout, removePath } from '../workspace/layout';

/**
 * Writes the layout and the sidebars of the open vault to `.clarae/workspace.json` now (the
 * session does it 500 ms after a change). Call it before the store is reset for another vault.
 */
export async function saveWorkspaceNow(vaultId: string): Promise<void> {
  const st = useAppStore.getState();
  try {
    await api.vault.writeConfig(
      vaultId,
      'workspace.json',
      JSON.stringify({ layout: st.layout, left: st.left, right: st.right }),
    );
  } catch {
    // A read-only vault (or one that just went away) keeps no workspace: nothing to lose.
  }
}

/** Loads per-vault settings and the saved workspace, then keeps the workspace saved. */
export function useVaultSession(vaultId: string): boolean {
  const ready = useRef(false);
  useEffect(() => {
    let cancelled = false;
    ready.current = false;
    // Every await may have let another vault take over (the effect cleaned up): nothing of this
    // vault is applied after that.
    void (async () => {
      try {
        try {
          await useSettings.getState().load(vaultId);
        } catch {
          // Unreadable settings: the defaults stay in force (nothing is written over the files).
        }
        if (cancelled) return;
        const saved = JSON.parse(
          (await api.vault.readConfig(vaultId, 'workspace.json')) || 'null',
        ) as Record<string, unknown> | null;
        const layout = saved ? parseLayout(saved['layout']) : null;
        if (!layout || cancelled) return;
        // Forget tabs whose file has disappeared since the last session.
        const tree = new Set((await api.vault.listTree(vaultId)).map((e) => e.path));
        if (cancelled) return;
        let next = layout;
        for (const p of allPanes(layout.root))
          for (const tab of p.tabs)
            if (!tree.has(tab.path) && !isGraphPath(tab.path)) next = removePath(next, tab.path);
        useAppStore.getState().setLayout(next);
        const l = saved?.['left'] as { open?: boolean; tab?: string; width?: number } | undefined;
        const r = saved?.['right'] as { open?: boolean; tab?: string; width?: number } | undefined;
        if (l)
          useAppStore.getState().setLeft({
            ...(typeof l.open === 'boolean' ? { open: l.open } : {}),
            // A saved 'search' starts as the file tree: the search view is opened on demand.
            ...(l.tab ? { tab: l.tab === 'search' ? 'files' : normalizeLeftTab(l.tab) } : {}),
            ...(typeof l.width === 'number'
              ? { width: Math.min(600, Math.max(180, l.width)) }
              : {}),
          });
        if (r)
          useAppStore.getState().setRight({
            ...(typeof r.open === 'boolean' ? { open: r.open } : {}),
            ...(r.tab ? { tab: normalizeRightTab(r.tab) } : {}),
            ...(typeof r.width === 'number'
              ? { width: Math.min(600, Math.max(180, r.width)) }
              : {}),
          });
      } catch {
        // No or unreadable workspace file: start with an empty workspace.
      } finally {
        // The workspace is saved from now on, even when it could not be read.
        if (!cancelled) ready.current = true;
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useAppStore.subscribe((s, prev) => {
      if (
        !ready.current ||
        (s.layout === prev.layout && s.left === prev.left && s.right === prev.right)
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void saveWorkspaceNow(vaultId), 500);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsub();
      useSettings.getState().reset();
    };
  }, [vaultId]);
  return ready.current;
}
