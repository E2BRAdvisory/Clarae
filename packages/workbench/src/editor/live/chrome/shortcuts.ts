// The shortcuts the toolbar of the selection shows. They are the application's (the command registry and
// the user's own bindings), not the ones Milkdown binds to the same marks: a key that does something else
// in the application would mislead.

/** A shortcut as the toolbar shows it. */
export interface Shortcut {
  /** For the eye (`⌘B`, `Ctrl+B`). */
  display: string;
  /** In the grammar of `aria-keyshortcuts` (`Meta+B`, `Control+Shift+H`). */
  aria: string;
}

/** What gives the shortcut of a command of the registry (`undefined`: it has none now). */
export type ShortcutOf = (commandId: string) => Shortcut | undefined;

const ARIA_MOD: Record<string, string> = {
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: 'Meta',
};

const ARIA_KEY: Record<string, string> = { Space: ' ' };

/** A combo of the registry (`Mod-Shift-h`, canonical) in the grammar of `aria-keyshortcuts`. */
export function ariaCombo(combo: string, mac: boolean): string {
  const trailing = combo.endsWith('--');
  const parts = (trailing ? combo.slice(0, -2) : combo).split('-').filter(Boolean);
  const key = trailing ? '-' : (parts.pop() ?? '');
  const mods = parts.map((m) => (m === 'Mod' ? (mac ? 'Meta' : 'Control') : (ARIA_MOD[m] ?? m)));
  const shown = ARIA_KEY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, shown].join('+');
}
