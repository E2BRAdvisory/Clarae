// Connects the slash menu (pure editor extension) to the application: the on/off setting and the
// command registry. The registry is imported lazily so the editor does not depend on it statically.
import { useNotesSettings } from '../daily/settings';
import type { SlashOptions } from './slash';

export const slashHost: SlashOptions = {
  enabled: () => useNotesSettings.getState().settings.slashCommands,
  run: (id) => {
    void import('../commands/registry').then((m) => m.runCommand(id));
  },
};
