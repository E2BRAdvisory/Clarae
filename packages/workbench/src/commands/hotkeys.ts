// Hotkey combos are strings like "Mod-Shift-p" (CodeMirror style): modifiers in
// the fixed order Mod, Ctrl, Alt, Shift, then the key. "Mod" is Cmd on macOS
// and Ctrl elsewhere, so one default works on every platform.

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  escape: 'Escape',
  enter: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

function canonicalKey(key: string): string {
  const k = key.toLowerCase();
  return (
    KEY_NAMES[k] ??
    (k.length === 1 ? k : key.length > 1 ? key.charAt(0).toUpperCase() + key.slice(1) : k)
  );
}

/** Canonical form of a combo (modifier order, key case); '' for an invalid one. */
export function normalizeCombo(combo: string): string {
  let key: string;
  let modPart: string;
  if (combo === '-') {
    key = '-';
    modPart = '';
  } else if (combo.endsWith('--')) {
    key = '-'; // the "-" key itself: "Mod--"
    modPart = combo.slice(0, -2);
  } else {
    const i = combo.lastIndexOf('-');
    key = i < 0 ? combo : combo.slice(i + 1);
    modPart = i < 0 ? '' : combo.slice(0, i);
  }
  if (!key) return '';
  const mods = new Set<string>();
  for (const p of modPart ? modPart.split('-') : []) {
    const m = MOD_ORDER.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m) return '';
    mods.add(m);
  }
  return [...MOD_ORDER.filter((m) => mods.has(m)), canonicalKey(key)].join('-');
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead']);

type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>;

function comboOf(e: KeyEventLike, key: string, mac: boolean): string {
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac ? e.ctrlKey : false) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mac && e.metaKey) mods.push('Meta');
  return normalizeCombo([...mods, canonicalKey(key)].join('-') || canonicalKey(key));
}

/** The combo a keyboard event represents, or null for a bare modifier press. */
export function comboFromEvent(e: KeyEventLike, mac = isMac()): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  // Letters and digits come from the physical key so Shift/Alt do not change them.
  let key = e.key;
  const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code ?? '');
  if (code) key = (code[1] ?? code[2] ?? key).toLowerCase();
  return comboOf(e, key, mac);
}

/**
 * The physical keys that count as "`" (the terminal's key): the one left of 1 everywhere, and on macOS
 * the other key an ISO (Italian, German…) keyboard has there: macOS reports the top-left key of such a
 * keyboard as IntlBackslash and the "<>" key next to the left Shift as Backquote, so both are tried.
 */
const aliasCodes = (mac: boolean): readonly string[] =>
  mac ? ['Backquote', 'IntlBackslash'] : ['Backquote'];

/**
 * The combos an event may stand for, in the order to try them: the one of its character
 * (comboFromEvent), then, for those keys (aliasCodes), the one of their place, written "`". The key
 * left of 1 is "`" on a US layout but "~" with Shift, and has no "`" at all on an Italian one (it types
 * "\\"), yet it is one shortcut key everywhere (the terminal's). The character goes first so that a
 * layout's own "\\" still finds what is bound to it; the place is the alias, tried only when nothing matches.
 */
export function combosFromEvent(e: KeyEventLike, mac = isMac()): string[] {
  const out: string[] = [];
  const primary = comboFromEvent(e, mac);
  if (primary) out.push(primary);
  // a layout that composes accents reports the key as "Dead": its place is what counts
  if (aliasCodes(mac).includes(e.code)) {
    const alias = comboOf(e, '`', mac);
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
}

const MAC_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Meta: '⌘',
};
const KEY_SYMBOLS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Backspace: '⌫',
  Escape: 'Esc',
  Space: 'Space',
};

/** Human readable combo: ⌘⇧P on macOS, Ctrl+Shift+P elsewhere. */
export function formatCombo(combo: string, mac = isMac()): string {
  const norm = normalizeCombo(combo);
  if (!norm) return '';
  const parts = norm.endsWith('--')
    ? [...norm.slice(0, -2).split('-').filter(Boolean), '-']
    : norm.split('-');
  const key = parts.pop() ?? '';
  const shownKey = KEY_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) return parts.map((m) => MAC_SYMBOLS[m] ?? m).join('') + shownKey;
  return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), shownKey].join('+');
}

export interface HotkeyBinding {
  id: string;
  defaults: readonly string[];
}

/** Effective combos per command: overrides replace defaults ([] unbinds). */
export function effectiveCombos(
  bindings: readonly HotkeyBinding[],
  overrides: Record<string, string[]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of bindings) {
    const list = overrides[b.id] ?? [...b.defaults];
    out.set(b.id, list.map(normalizeCombo).filter(Boolean));
  }
  return out;
}

/** combo -> command ids using it; more than one id is a conflict. */
export function comboIndex(effective: Map<string, string[]>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [id, combos] of effective)
    for (const c of combos) idx.set(c, [...(idx.get(c) ?? []), id]);
  return idx;
}
