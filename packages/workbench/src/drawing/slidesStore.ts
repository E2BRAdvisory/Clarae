// The slides (frames) of the drawing in focus, for the right sidebar's Slideshow tab. The editor
// publishes them whenever the frames change; the panel reads them without importing Excalidraw.
//
// A drawing can be open in two panes, each with its own editor and, until the next save, its own
// frames. One editor owns what the panel shows: the one in focus. Another editor takes over only
// when it comes into focus or when the owner goes away.
import { create } from 'zustand';
import type { Slide } from './slides';

interface DrawingSlidesState {
  /** The editor whose frames these are ('' when no drawing publishes). */
  owner: string;
  path: string;
  slides: Slide[];
  /**
   * The frames of the editor `owner`. Taken when nobody owns the panel, when `owner` already does,
   * or when `focused` says this editor is the one in focus; ignored otherwise.
   */
  publish: (owner: string, path: string, slides: Slide[], focused?: boolean) => void;
  /** The editor `owner` is gone: its frames leave the panel (another editor's stay). */
  clear: (owner: string) => void;
}

const key = (slides: Slide[]) =>
  slides.map((s) => `${s.id}|${s.name}|${s.notes}|${s.included}|${s.version}`).join('\n');

export const useDrawingSlides = create<DrawingSlidesState>((set, get) => ({
  owner: '',
  path: '',
  slides: [],
  publish: (owner, path, slides, focused = false) => {
    const cur = get();
    if (cur.owner !== '' && cur.owner !== owner && !focused) return;
    if (cur.owner === owner && cur.path === path && key(cur.slides) === key(slides)) return;
    set({ owner, path, slides });
  },
  clear: (owner) => {
    if (get().owner === owner) set({ owner: '', path: '', slides: [] });
  },
}));
