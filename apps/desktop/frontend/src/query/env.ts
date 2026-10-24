// Application wiring of embedded search: binds a block to the vault, the search
// binding, navigation and the "include the host note" setting.
import { api } from '../app/api';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { renderQueryBlock, type QueryEnv } from './block';

export function makeQueryEnv(vaultId: string, hostPath: string): QueryEnv {
  return {
    vaultId,
    hostPath,
    excludeHost: !useSettings.getState().editor.queryIncludeHost,
    search: (q, sort, limit) => api.search.query(vaultId, q, sort, limit),
    open: (path, line, newTab) =>
      useAppStore.getState().openNote(path, { newTab, ...(line > 0 ? { line } : {}) }),
    openInSearch: (q) => useAppStore.getState().search(q),
  };
}

/** Renders a query block of `hostPath` into el; returns the dispose function. */
export function renderQueryInto(
  el: HTMLElement,
  source: string,
  vaultId: string,
  hostPath: string,
): () => void {
  return renderQueryBlock(el, source, makeQueryEnv(vaultId, hostPath));
}
