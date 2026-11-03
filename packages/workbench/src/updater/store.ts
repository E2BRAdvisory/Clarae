import { create } from 'zustand';
import { updaterApi, UpdaterEvents, type UpdateStatus } from './api';
import { api } from '../app/api';
import { errorMessage } from '../util/errors';

interface UpdaterState {
  status: UpdateStatus | null;
  dialogOpen: boolean;
  /** Result message of the last Install (what happened, or where the verified file is). */
  message: string;
  error: string;
  busy: boolean;
  set(status: UpdateStatus): void;
  showDialog(): void;
  hideDialog(): void;
  /** Manual check ("Check for updates"): always opens the dialog with the outcome. */
  check(): Promise<void>;
  install(): Promise<void>;
  skip(): Promise<void>;
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: null,
  dialogOpen: false,
  message: '',
  error: '',
  busy: false,
  set: (status) => set({ status }),
  showDialog: () => set({ dialogOpen: true, message: '', error: '' }),
  hideDialog: () => set({ dialogOpen: false }),
  check: async () => {
    set({ dialogOpen: true, message: '', error: '', busy: true });
    try {
      set({ status: await updaterApi.check() });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ busy: false });
    }
  },
  install: async () => {
    set({ busy: true, error: '', message: '' });
    try {
      const res = await updaterApi.install();
      set({ message: res.message });
    } catch (e) {
      set({ error: errorMessage(e) });
    } finally {
      set({ busy: false });
    }
  },
  skip: async () => {
    const v = get().status?.latest;
    if (v) await updaterApi.skip(v);
    const cur = get().status;
    set({ dialogOpen: false, status: cur ? { ...cur, skipped: true } : cur });
  },
}));

/** Subscribes the store to backend status events and loads the current status. */
export function connectUpdater(): () => void {
  void updaterApi
    .status()
    .then((s) => useUpdater.getState().set(s))
    .catch(() => undefined);
  return api.on(UpdaterEvents.status, (s) => useUpdater.getState().set(s));
}

/** True when an update should be announced in the status bar. */
export function announced(s: UpdateStatus | null): boolean {
  return (
    !!s &&
    (s.state === 'available' || s.state === 'downloading' || s.state === 'ready') &&
    !s.skipped
  );
}
