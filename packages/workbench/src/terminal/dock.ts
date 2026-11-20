// Where the terminal panel sits in the main window and how big it is: a choice about this screen, so
// it is kept per device in localStorage and stays out of the vault (as drawing/uiPrefs.ts does).

export type DockPosition = 'bottom' | 'left' | 'right';

export const DOCK_POSITIONS: readonly DockPosition[] = ['bottom', 'left', 'right'];

export interface DockPrefs {
  position: DockPosition;
  /** Height of the panel at the bottom, width at the sides, in CSS pixels. */
  size: number;
}

export const DOCK_KEY = 'clarae.terminal.dock';

export const DOCK_MIN = 140;
export const DOCK_MAX = 1600;
export const DOCK_DEFAULT: DockPrefs = { position: 'bottom', size: 280 };

/** Keeps a size in the range the panel can have (a non-number becomes the default). */
export function clampSize(size: unknown): number {
  const n = typeof size === 'number' && Number.isFinite(size) ? size : DOCK_DEFAULT.size;
  return Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, n)));
}

const isPosition = (v: unknown): v is DockPosition =>
  typeof v === 'string' && (DOCK_POSITIONS as readonly string[]).includes(v);

/** The stored choice; anything missing, damaged or out of range falls back to the default. */
export function readDock(): DockPrefs {
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return { ...DOCK_DEFAULT };
    const v = JSON.parse(raw) as Partial<DockPrefs> | null;
    return {
      position: isPosition(v?.position) ? v.position : DOCK_DEFAULT.position,
      size: clampSize(v?.size),
    };
  } catch {
    return { ...DOCK_DEFAULT };
  }
}

export function writeDock(prefs: DockPrefs): void {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the choice lasts for the session */
  }
}
