// Events of the importer (internal/app/bindings_importer.go): names and payloads come from the Go
// registry (app/events.gen.ts).
import { Events } from '../app/events';

export type { ImportDonePayload, ImportProgressPayload } from '../app/events';

export const ImporterEvents = {
  progress: Events.importerProgress,
  done: Events.importerDone,
} as const;
