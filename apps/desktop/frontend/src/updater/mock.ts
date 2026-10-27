// In-memory UpdaterAPI for Vitest and browser-only runs (installed by test/wails-mock).
import type { UpdateResult, UpdateSettings, UpdateStatus } from './api';

export interface UpdaterMockState {
  settings: UpdateSettings;
  status: UpdateStatus;
  /** Status returned by the next Check. */
  next: UpdateStatus;
  checkError: string;
  installError: string;
  installResult: UpdateResult;
  checks: number;
  installs: number;
  skipped: string[];
}

export const idleStatus = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: 'idle',
  current: '1.0.0',
  latest: '',
  channel: 'stable',
  notes: '',
  notesUrl: '',
  released: null,
  required: false,
  skipped: false,
  kind: '',
  size: 0,
  done: 0,
  error: '',
  checkedAt: null,
  disabled: '',
  ...over,
});

const initialResult = (): UpdateResult => ({
  method: 'reveal',
  quit: false,
  path: '/mock/update.deb',
  message: 'Verified: /mock/update.deb',
});

export const updaterMock: UpdaterMockState = {
  settings: { enabled: true, channel: 'stable', skippedVersion: '' },
  status: idleStatus(),
  next: idleStatus({ state: 'up-to-date', latest: '1.0.0' }),
  checkError: '',
  installError: '',
  installResult: initialResult(),
  checks: 0,
  installs: 0,
  skipped: [],
};

export function resetUpdaterMock(): void {
  updaterMock.settings = { enabled: true, channel: 'stable', skippedVersion: '' };
  updaterMock.status = idleStatus();
  updaterMock.next = idleStatus({ state: 'up-to-date', latest: '1.0.0' });
  updaterMock.checkError = '';
  updaterMock.installError = '';
  updaterMock.installResult = initialResult();
  updaterMock.checks = 0;
  updaterMock.installs = 0;
  updaterMock.skipped = [];
}

export function createUpdaterMock(emit: (name: string, payload: unknown) => void) {
  resetUpdaterMock();
  return {
    GetSettings: (): Promise<UpdateSettings> => Promise.resolve({ ...updaterMock.settings }),
    SetSettings: (s: UpdateSettings): Promise<void> => {
      updaterMock.settings = { ...s };
      return Promise.resolve();
    },
    Status: (): Promise<UpdateStatus> => Promise.resolve(updaterMock.status),
    Check: (): Promise<UpdateStatus> => {
      updaterMock.checks++;
      if (updaterMock.checkError) return Promise.reject(new Error(updaterMock.checkError));
      updaterMock.status = updaterMock.next;
      emit('updater:status', updaterMock.status);
      return Promise.resolve(updaterMock.status);
    },
    Skip: (v: string): Promise<void> => {
      updaterMock.skipped.push(v);
      updaterMock.status = { ...updaterMock.status, skipped: true };
      emit('updater:status', updaterMock.status);
      return Promise.resolve();
    },
    Install: (): Promise<UpdateResult> => {
      updaterMock.installs++;
      if (updaterMock.installError) return Promise.reject(new Error(updaterMock.installError));
      return Promise.resolve(updaterMock.installResult);
    },
  };
}
