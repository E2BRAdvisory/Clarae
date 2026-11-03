// Typed facade over the UpdaterAPI bindings (wailsjs is generated, never edited).
import * as UpdaterAPI from '../../wailsjs/go/app/UpdaterAPI';
import type { updater } from '../../wailsjs/go/models';
import { Events } from '../app/events';

type Plain<T> = Omit<T, 'convertValues'>;

export type UpdateSettings = Plain<updater.Settings>;
export type UpdateStatus = Plain<updater.Status>;
export type UpdateResult = Plain<updater.Result>;

/** The updater's event (generated from the Go registry, app/events.gen.ts). */
export const UpdaterEvents = { status: Events.updaterStatus } as const;

export const updaterApi = {
  getSettings: (): Promise<UpdateSettings> => UpdaterAPI.GetSettings(),
  setSettings: (s: UpdateSettings): Promise<void> => UpdaterAPI.SetSettings(s),
  status: (): Promise<UpdateStatus> => UpdaterAPI.Status(),
  check: (): Promise<UpdateStatus> => UpdaterAPI.Check(),
  skip: (version: string): Promise<void> => UpdaterAPI.Skip(version),
  install: (): Promise<UpdateResult> => UpdaterAPI.Install(),
};
