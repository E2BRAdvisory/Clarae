// Whether the graph is drawn flat or in space: a choice about this device (its GPU, its screen),
// so it stays out of the vault (`.clarae/graph.json` travels with the sync).
import { create } from 'zustand';

export type GraphMode = '2d' | '3d';

const MODE_KEY = 'clarae.graph.mode';

function readMode(): GraphMode {
  try {
    return localStorage.getItem(MODE_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

interface GraphModeState {
  mode: GraphMode;
  setMode: (mode: GraphMode) => void;
}

export const useGraphMode = create<GraphModeState>((set) => ({
  mode: readMode(),
  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage unavailable: the choice lasts for the session */
    }
    set({ mode });
  },
}));
