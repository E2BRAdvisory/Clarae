// The combinations the terminal hands to the application (keys.ts decides with them). They follow what
// the user set in Settings > Hotkeys, so they are read when a key is pressed, not once.
import { currentCombos, commandForEvent } from '../commands/registry';
import { isMac } from '../commands/hotkeys';
import { isApplicationKey } from './keys';

/** The terminal's own commands, and in the main window the command palette's combinations that use Shift (plain Ctrl+P is the shell's). */
export function reservedCombos(
  overrides: Record<string, string[]>,
  withPalette: boolean,
): Set<string> {
  const effective = currentCombos(overrides);
  const out = new Set<string>();
  for (const id of ['terminal:toggle', 'terminal:new-tab'])
    for (const c of effective.get(id) ?? []) out.add(c);
  if (withPalette)
    for (const c of effective.get('palette:open') ?? []) if (c.includes('Shift-')) out.add(c);
  return out;
}

/**
 * Whether a key pressed in the terminal screen goes to the application (isApplicationKey). `separate` is the
 * separate window, which has no other commands than the terminal's: there only those are the application's.
 */
export function isReservedKey(
  e: KeyboardEvent,
  overrides: Record<string, string[]>,
  separate: boolean,
  mac: boolean = isMac(),
): boolean {
  const chosen = commandForEvent(
    e,
    overrides,
    separate ? (c) => c.id.startsWith('terminal:') : undefined,
  );
  return isApplicationKey(e, reservedCombos(overrides, !separate), mac, chosen?.id ?? null);
}
