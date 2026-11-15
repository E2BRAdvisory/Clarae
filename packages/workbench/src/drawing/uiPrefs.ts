// What a drawing editor shows around the canvas, per device: these are choices about this screen,
// so they stay out of the vault (`.clarae/drawing.json` travels with the sync).
import { create } from 'zustand';

const MINIMAP_KEY = 'clarae.drawing.minimap';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts for the session */
  }
}

interface DrawingUiState {
  /** The mini-map of the drawing is shown (off until the user asks for it). */
  minimap: boolean;
  toggleMinimap: () => void;
}

export const useDrawingUi = create<DrawingUiState>((set, get) => ({
  minimap: readFlag(MINIMAP_KEY),
  toggleMinimap: () => {
    const minimap = !get().minimap;
    writeFlag(MINIMAP_KEY, minimap);
    set({ minimap });
  },
}));
