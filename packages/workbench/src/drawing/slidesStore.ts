// The slides (frames) of the drawing in focus, for the right sidebar's Slideshow tab. The editor
// publishes them whenever the frames change; the panel reads them without importing Excalidraw.
import { create } from 'zustand';
import type { Slide } from './slides';

interface DrawingSlidesState {
  path: string;
  slides: Slide[];
  publish: (path: string, slides: Slide[]) => void;
  clear: (path: string) => void;
}

const key = (slides: Slide[]) =>
  slides.map((s) => `${s.id}|${s.name}|${s.notes}|${s.included}|${s.version}`).join('\n');

export const useDrawingSlides = create<DrawingSlidesState>((set, get) => ({
  path: '',
  slides: [],
  publish: (path, slides) => {
    const cur = get();
    if (cur.path === path && key(cur.slides) === key(slides)) return;
    set({ path, slides });
  },
  clear: (path) => {
    if (get().path === path) set({ path: '', slides: [] });
  },
}));
