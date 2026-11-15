// The key combinations of the application that a native view hands back instead of consuming
// (WebViewAPI.ReserveKeys, webview:key). While a page has the keyboard focus the application sees no
// key at all, so without this Mod-p or Mod-w would do nothing over an application tab.
//
// The hotkeys of the application are "Mod-Shift-p" (CodeMirror style, hotkeys.ts); the core wants
// "shift+cmd+p" (its own grammar: webview.ParseAccelerator, apps/desktop/internal/webview/
// accelerator.go): lower case, joined with "+", the modifiers in the order ctrl, alt, shift, cmd, then
// a printable ASCII character or a key name, with ctrl or cmd unless it is a function key, and never
// the shortcuts of text editing. toAccelerator converts one combination and returns null for what the
// core would refuse, so one that cannot be reserved is simply not (the page keeps it).
import { normalizeCombo } from '../commands/hotkeys';

/** The most the core accepts in one call (webview.MaxAccelerators). */
export const MAX_ACCELERATORS = 128;

/** Longest accelerator the core accepts, in characters. */
const MAX_LENGTH = 32;

/** Key names of the application → names of the core. */
const KEY_NAMES: Record<string, string> = {
  Space: 'space',
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
};

/**
 * The key a shifted symbol is, on the layout the hotkeys are written for. The driver reads the key
 * without its modifiers (`charactersByApplyingModifiers: 0`), so `Mod-Shift-\` is `shift+cmd+\`, never
 * `shift+cmd+|`; a combination recorded from the keyboard may hold the shifted character.
 */
const UNSHIFTED: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
};

/** The shortcuts a text field of a page needs (the `editing` set of the core). */
const TEXT_EDITING = new Set(['cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'shift+cmd+z']);

/** The order of the modifiers in the core's form. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd'] as const;

/** `Mod-Shift-p` → modifiers and key; the key `-` is written `Mod--`. */
function split(combo: string): { mods: string[]; key: string } | null {
  const norm = normalizeCombo(combo);
  if (!norm) return null;
  if (norm === '-') return { mods: [], key: '-' };
  if (norm.endsWith('--')) return { mods: norm.slice(0, -2).split('-').filter(Boolean), key: '-' };
  const i = norm.lastIndexOf('-');
  return i < 0
    ? { mods: [], key: norm }
    : { mods: norm.slice(0, i).split('-'), key: norm.slice(i + 1) };
}

/**
 * The accelerator of a hotkey in the core's grammar, or null when the core would not take it.
 * `mac` says what `Mod` is: the Command key on a Mac, Ctrl elsewhere.
 */
export function toAccelerator(combo: string, mac: boolean): string | null {
  const parts = split(combo);
  if (!parts) return null;
  const mods = new Set<string>();
  for (const m of parts.mods) {
    switch (m) {
      case 'Mod':
        mods.add(mac ? 'cmd' : 'ctrl');
        break;
      case 'Ctrl':
        mods.add('ctrl');
        break;
      case 'Alt':
        mods.add('alt');
        break;
      case 'Shift':
        mods.add('shift');
        break;
      case 'Meta':
        // The Windows or Super key: the core has only the Command key of a Mac.
        if (!mac) return null;
        mods.add('cmd');
        break;
      default:
        return null;
    }
  }
  let key: string;
  if (mods.has('shift') && UNSHIFTED[parts.key]) key = UNSHIFTED[parts.key] as string;
  else if (parts.key === '+') key = 'plus';
  else if (KEY_NAMES[parts.key]) key = KEY_NAMES[parts.key] as string;
  else if (/^F([1-9]|1\d|20)$/.test(parts.key)) key = parts.key.toLowerCase();
  else if (parts.key.length === 1 && parts.key > ' ' && parts.key < '\u007f')
    key = parts.key.toLowerCase();
  else return null;
  const functionKey = /^f\d+$/.test(key);
  if (!mods.has('ctrl') && !mods.has('cmd') && !functionKey) return null;
  const accelerator = [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
  if (accelerator.length > MAX_LENGTH || TEXT_EDITING.has(accelerator)) return null;
  return accelerator;
}

/** What a set of commands reserves. */
export interface ReservedKeys {
  /** The list for ReserveKeys, without duplicates, at most MAX_ACCELERATORS. */
  accelerators: string[];
  /** The commands (in the order they were given) that use each accelerator. */
  commands: ReadonlyMap<string, readonly string[]>;
}

/** The accelerators of the effective combinations of the commands (`id` → its combinations). */
export function reservedKeys(
  combos: ReadonlyMap<string, readonly string[]>,
  mac: boolean,
): ReservedKeys {
  const commands = new Map<string, string[]>();
  for (const [id, list] of combos)
    for (const combo of list) {
      const a = toAccelerator(combo, mac);
      if (a === null) continue;
      const ids = commands.get(a);
      if (!ids) {
        if (commands.size >= MAX_ACCELERATORS) continue;
        commands.set(a, [id]);
      } else if (!ids.includes(id)) ids.push(id);
    }
  return { accelerators: [...commands.keys()], commands };
}
