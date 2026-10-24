import { create } from 'zustand';
import { useAppStore } from '../state/store';

/**
 * Which folders of the file explorer are open. Every folder starts closed: the set is emptied
 * whenever a vault is opened or closed. It lives outside the component so that what the user
 * opened survives switching to another sidebar tab (which unmounts the explorer).
 */
interface ExpandedState {
  open: ReadonlySet<string>;
  toggle(path: string): void;
  reset(): void;
}

export const useExpanded = create<ExpandedState>((set) => ({
  open: new Set(),
  toggle: (path) =>
    set((s) => {
      const next = new Set(s.open);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { open: next };
    }),
  reset: () => set({ open: new Set() }),
}));

let current = useAppStore.getState().vault?.id ?? null;
useAppStore.subscribe((s) => {
  const id = s.vault?.id ?? null;
  if (id === current) return;
  current = id;
  useExpanded.getState().reset();
});
