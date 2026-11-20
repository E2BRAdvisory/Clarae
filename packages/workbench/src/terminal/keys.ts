// The keys of the terminal. Inside the terminal almost every key belongs to the shell (Ctrl+C, Ctrl+R,
// Ctrl+P…), so the application keeps only a few combinations; the rest never reaches its hotkeys.
import { combosFromEvent, isMac, normalizeCombo } from '../commands/hotkeys';

/**
 * Default combinations of the terminal commands. Ctrl+` and Ctrl+Shift+` on every system, macOS
 * included: Cmd+` stays with the system (it cycles the windows of an application). "Mod" is Cmd on
 * macOS and Ctrl elsewhere (commands/hotkeys.ts), so on macOS the Ctrl is written out.
 */
export const toggleDefault = (mac: boolean = isMac()): string => (mac ? 'Ctrl-`' : 'Mod-`');
export const newTabDefault = (mac: boolean = isMac()): string =>
  mac ? 'Ctrl-Shift-`' : 'Mod-Shift-`';

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/**
 * Whether a key pressed in the terminal is the application's, and not the shell's (the terminal
 * then does not take it, and it goes on to the application's hotkeys).
 *  - On macOS every Cmd combination: a shell never gets them (Cmd+C and Cmd+V stay the terminal's
 *    own copy and paste, which the application does not bind).
 *  - Elsewhere the combinations in `reserved` (the terminal's own commands, as the user set them) and
 *    the ones the application shares with it that a shell does not use: those with Shift, like the
 *    command palette's Ctrl+Shift+P. Plain Ctrl+P is the shell's (previous command).
 *  - A reserved combination is the application's only if the command the application would run for
 *    the key (`chosen`: its id, null for none) is one of those: when the key also stands for another
 *    command (Ctrl+\ for the split on an Italian layout, where it is the key of "`" too) the shell
 *    keeps it. Without `chosen` the combination alone decides.
 */
export function isApplicationKey(
  e: KeyLike,
  reserved: ReadonlySet<string>,
  mac: boolean = isMac(),
  chosen?: string | null,
): boolean {
  if (mac && e.metaKey) return true;
  // either form of the event: the key left of 1 also counts as "`" (combosFromEvent)
  if (!combosFromEvent(e, mac).some((c) => reserved.has(normalizeCombo(c)))) return false;
  if (chosen === undefined) return true;
  return chosen !== null && (chosen.startsWith('terminal:') || chosen === 'palette:open');
}

/** Ctrl+Shift+C: copy, where a shell has no key for it (Windows and Linux terminals do the same). */
export function isCopyKey(e: KeyLike, mac: boolean = isMac()): boolean {
  return !mac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC';
}

/** Ctrl+Shift+V: paste (the browser's own paste, which xterm turns into input). */
export function isPasteKey(e: KeyLike, mac: boolean = isMac()): boolean {
  return !mac && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyV';
}
