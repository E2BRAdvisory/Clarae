// Commands that open the graph view in a tab.
import { useAppStore } from '../state/store';
import { useGraphMode } from './mode';
import { activeTab } from '../workspace/layout';
import { canCenterGraph, globalGraphPath, isGraphPath, localGraphPath } from './paths';

export function openGraph(): void {
  useAppStore.getState().openNote(globalGraphPath(), { newTab: true });
}

/** Opens the graph of the vault drawn in 3D (the mode is kept for this device). */
export function openGraph3D(): void {
  useGraphMode.getState().setMode('3d');
  openGraph();
}

/** Switches the graph views of this device between 2D and 3D. */
export function toggleGraph3D(): void {
  const { mode, setMode } = useGraphMode.getState();
  setMode(mode === '3d' ? '2d' : '3d');
}

/** Opens the local graph of a note, drawing or canvas (default: the active one); false when there is none. */
export function openLocalGraph(notePath?: string): boolean {
  const path = notePath ?? activeTab(useAppStore.getState().layout)?.path;
  if (!path || isGraphPath(path) || !canCenterGraph(path)) return false;
  useAppStore.getState().openNote(localGraphPath(path), { newTab: true });
  return true;
}
