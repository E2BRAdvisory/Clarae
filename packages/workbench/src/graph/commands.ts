// Commands that open the graph view in a tab.
import { useAppStore } from '../state/store';
import { activeTab } from '../workspace/layout';
import { globalGraphPath, isGraphPath, localGraphPath } from './paths';

export function openGraph(): void {
  useAppStore.getState().openNote(globalGraphPath(), { newTab: true });
}

/** Opens the local graph of a note (default: the active one); false when there is none. */
export function openLocalGraph(notePath?: string): boolean {
  const path = notePath ?? activeTab(useAppStore.getState().layout)?.path;
  if (!path || isGraphPath(path) || !/\.md$/i.test(path)) return false;
  useAppStore.getState().openNote(localGraphPath(path), { newTab: true });
  return true;
}
