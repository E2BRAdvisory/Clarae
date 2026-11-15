// Starts the manager of the native views and reserves the keys of the application in them. It lives
// apart from nativeViews.ts because it reads the command registry, which in turn names the commands
// of the applications (webapp/commands.ts): the manager itself never imports the registry.
import { commandById, currentCombos, isEnabled } from '../commands/registry';
import { isMac } from '../commands/hotkeys';
import { can } from '../platform';
import { useSettings } from '../state/settings';
import { nativeViews } from './nativeViews';
import { reservedKeys, type ReservedKeys } from './accelerators';

/**
 * Commands whose keys a page keeps although they have a hotkey. Over an application tab they have
 * nothing to act on, or a page uses the key: the editors' commands (group `editor`: bold, link, find…,
 * a page uses Mod-b and Mod-k and Mod-f itself), the modes of a note (`mode:*`), the rename and delete of
 * the active file with their F2 (a page uses F2 too: a spreadsheet edits a cell with it), and the
 * commands of drawings and presentations.
 */
const PAGE_KEEPS = ['mode:', 'drawing:', 'marp:', 'slides:'];
const PAGE_KEEPS_IDS = new Set(['note:rename', 'note:delete']);

/** The commands whose keys a page gives back: the ones that make sense over an application tab. */
export const forwardsKeys = (id: string): boolean => {
  const c = commandById.get(id);
  return (
    !!c &&
    c.group !== 'editor' &&
    !PAGE_KEEPS_IDS.has(id) &&
    !PAGE_KEEPS.some((prefix) => id.startsWith(prefix))
  );
};

/** What the effective hotkeys reserve now. */
export function currentReservation(overrides = useSettings.getState().hotkeys): ReservedKeys {
  const all = currentCombos(overrides);
  const combos = new Map([...all].filter(([id]) => forwardsKeys(id)));
  return reservedKeys(combos, isMac());
}

/**
 * Starts the views: their events, the tabs they follow, and the reserved keys (at once and at every
 * change of the hotkeys). Returns the function that stops them. Without the embedded browser nothing
 * starts: the page of an application opens in the system browser.
 */
export function startWebapps(): () => void {
  if (!can('embeddedBrowser')) return () => undefined;
  let reserved = currentReservation();
  const stop = nativeViews.start((accelerator) => {
    // the first of the commands that use the combination and can run now
    for (const id of reserved.commands.get(accelerator) ?? []) {
      const c = commandById.get(id);
      if (c && isEnabled(c)) {
        void c.run();
        return;
      }
    }
  });
  void nativeViews.reserveKeys(reserved.accelerators);
  const off = useSettings.subscribe((s, prev) => {
    if (s.hotkeys === prev.hotkeys) return;
    reserved = currentReservation(s.hotkeys);
    void nativeViews.reserveKeys(reserved.accelerators);
  });
  return () => {
    off();
    stop();
  };
}
