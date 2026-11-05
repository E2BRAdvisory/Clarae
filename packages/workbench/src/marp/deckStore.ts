// The presentation in focus, for the Slideshow tab (ADR-0048). Its editor view publishes the text
// (after typing pauses, like the other sidebars) and the line of the cursor; the panel reads them
// without importing the editor. Edits go back through `marp/controller.ts`.
import { create } from 'zustand';

interface DeckState {
  vaultId: string;
  path: string;
  /** The pane whose editor holds the file. */
  paneId: string;
  /** The text of the editor, as of the last pause in typing (unsaved edits included). */
  source: string;
  /** 0-based line of the editor's cursor. */
  cursorLine: number;
  readOnly: boolean;
  /**
   * Writes the presenter notes typed in the Slideshow tab that are not in the editor yet (set by the
   * open notes box). The note view calls it before it clears the presentation: its editor is still
   * there, so a tab switch within the typing delay loses nothing.
   */
  flushNotes: (() => boolean) | null;
  publish: (d: {
    vaultId: string;
    path: string;
    paneId: string;
    source: string;
    cursorLine?: number | undefined;
    readOnly: boolean;
  }) => void;
  setCursor: (line: number) => void;
  clear: (path: string) => void;
}

const EMPTY = { vaultId: '', path: '', paneId: '', source: '', cursorLine: 0, readOnly: false };

export const useMarpDeck = create<DeckState>((set, get) => ({
  ...EMPTY,
  flushNotes: null,
  publish: (d) =>
    set((s) => ({
      ...d,
      // The editor reads every line break as \n whatever the file has: edits are computed on that text.
      source: d.source.replace(/\r\n?/g, '\n'),
      cursorLine: d.cursorLine ?? (s.path === d.path ? s.cursorLine : 0),
    })),
  setCursor: (line) => {
    if (get().cursorLine !== line) set({ cursorLine: line });
  },
  clear: (path) => {
    if (get().path === path) set({ ...EMPTY });
  },
}));
