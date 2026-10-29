import { create } from 'zustand';

/** State of the presentation overlay (ADR-0027): one at a time, in the application window (V-07). */
interface SlideshowState {
  open: boolean;
  vaultId: string;
  path: string;
  index: number;
  /** Which way the last move went (picks the transition). */
  direction: 'next' | 'prev';
  /** When the presentation started (ms), for the timer of the presenter view. */
  startedAt: number;
  /** Presenter view: current and next slide, speaker notes, timer. */
  presenter: boolean;
  start: (vaultId: string, path: string, index?: number) => void;
  close: () => void;
  setIndex: (index: number) => void;
  togglePresenter: () => void;
}

export const useSlideshow = create<SlideshowState>((set) => ({
  open: false,
  vaultId: '',
  path: '',
  index: 0,
  direction: 'next',
  startedAt: 0,
  presenter: false,
  start: (vaultId, path, index = 0) =>
    set({
      open: true,
      vaultId,
      path,
      index,
      direction: 'next',
      startedAt: Date.now(),
      presenter: false,
    }),
  close: () => set({ open: false }),
  setIndex: (index) => set((s) => ({ index, direction: index >= s.index ? 'next' : 'prev' })),
  togglePresenter: () => set((s) => ({ presenter: !s.presenter })),
}));
