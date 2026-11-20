import { describe, expect, it } from 'vitest';
import { combosFromEvent, formatCombo, normalizeCombo } from '../commands/hotkeys';
import { isApplicationKey, isCopyKey, isPasteKey, newTabDefault, toggleDefault } from './keys';

const ev = (o: Partial<KeyboardEvent> & { key: string }) => ({
  code: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe('terminal shortcuts', () => {
  it('are Ctrl+` and Ctrl+Shift+` on every system, macOS included', () => {
    // Ctrl is "Mod" except on macOS, where Mod is Cmd and Ctrl is its own modifier.
    expect(toggleDefault(false)).toBe('Mod-`');
    expect(newTabDefault(false)).toBe('Mod-Shift-`');
    expect(toggleDefault(true)).toBe('Ctrl-`');
    expect(newTabDefault(true)).toBe('Ctrl-Shift-`');
  });

  it('are among the combos the keyboard events of those keys give, on both kinds of system', () => {
    const tick = { key: '`', code: 'Backquote' };
    expect(combosFromEvent(ev({ ...tick, ctrlKey: true }), false)).toContain(toggleDefault(false));
    expect(combosFromEvent(ev({ ...tick, ctrlKey: true }), true)).toContain(toggleDefault(true));
    // with Shift the character is "~" on a US layout; the place of the key is the alias
    const tilde = { key: '~', code: 'Backquote', shiftKey: true, ctrlKey: true };
    expect(combosFromEvent(ev(tilde), false)).toContain(newTabDefault(false));
    expect(combosFromEvent(ev(tilde), true)).toContain(newTabDefault(true));
    // an Italian layout has no ` : that key types "\\" and is Backquote all the same
    expect(
      combosFromEvent(ev({ key: '|', code: 'Backquote', ctrlKey: true, shiftKey: true }), true),
    ).toContain(newTabDefault(true));
    expect(combosFromEvent(ev({ key: '\\', code: 'Backquote', ctrlKey: true }), true)).toContain(
      toggleDefault(true),
    );
    // a layout that makes it a dead key
    expect(combosFromEvent(ev({ key: 'Dead', code: 'Backquote', ctrlKey: true }), false)).toEqual([
      toggleDefault(false),
    ]);
  });

  it('are not Cmd+` and Cmd+Shift+` on macOS, which stay with the system', () => {
    const cmd = combosFromEvent(ev({ key: '`', code: 'Backquote', metaKey: true }), true);
    const cmdShift = combosFromEvent(
      ev({ key: '~', code: 'Backquote', metaKey: true, shiftKey: true }),
      true,
    );
    expect(cmd).toEqual(['Mod-`']);
    expect(cmdShift).toEqual(['Mod-Shift-~', 'Mod-Shift-`']);
    for (const c of [...cmd, ...cmdShift])
      expect([toggleDefault(true), newTabDefault(true)]).not.toContain(c);
  });

  it('are shown with the control sign on macOS and as Ctrl+ elsewhere', () => {
    expect(formatCombo(toggleDefault(true), true)).toBe('⌃`');
    expect(formatCombo(newTabDefault(true), true)).toBe('⌃⇧`');
    expect(formatCombo(toggleDefault(false), false)).toBe('Ctrl+`');
    expect(formatCombo(newTabDefault(false), false)).toBe('Ctrl+Shift+`');
  });

  it('survive normalisation', () => {
    for (const mac of [true, false])
      for (const c of [toggleDefault(mac), newTabDefault(mac)]) expect(normalizeCombo(c)).toBe(c);
  });
});

describe('keys of the application inside the terminal', () => {
  const reserved = new Set([toggleDefault(false), newTabDefault(false), 'Mod-Shift-p']);

  it('are only the reserved combinations elsewhere than macOS; the rest is the shell’s', () => {
    const press = (key: string, code: string, extra: Partial<KeyboardEvent> = {}) =>
      isApplicationKey(ev({ key, code, ctrlKey: true, ...extra }), reserved, false);
    expect(press('`', 'Backquote')).toBe(true);
    expect(press('~', 'Backquote', { shiftKey: true })).toBe(true);
    expect(press('P', 'KeyP', { shiftKey: true })).toBe(true); // the palette
    expect(press('p', 'KeyP')).toBe(false); // previous command of the shell
    expect(press('c', 'KeyC')).toBe(false);
    expect(press('r', 'KeyR')).toBe(false);
    expect(isApplicationKey(ev({ key: 'a', code: 'KeyA' }), reserved, false)).toBe(false);
    expect(isApplicationKey(ev({ key: 'Shift', shiftKey: true }), reserved, false)).toBe(false);
  });

  it('are the shell’s when the key is also another command’s (Ctrl+\\ on an Italian layout)', () => {
    const key = ev({ key: '\\', code: 'Backquote', ctrlKey: true });
    const reserved = new Set([toggleDefault(false)]);
    expect(isApplicationKey(key, reserved, false)).toBe(true); // by the combination alone
    expect(isApplicationKey(key, reserved, false, 'pane:split-right')).toBe(false);
    expect(isApplicationKey(key, reserved, false, null)).toBe(false);
    expect(isApplicationKey(key, reserved, false, 'terminal:toggle')).toBe(true);
    expect(isApplicationKey(key, new Set(['Mod-Shift-p']), false, 'palette:open')).toBe(false); // not reserved
  });

  it('are every Cmd combination on macOS', () => {
    const none = new Set<string>();
    expect(isApplicationKey(ev({ key: 'p', code: 'KeyP', metaKey: true }), none, true)).toBe(true);
    expect(isApplicationKey(ev({ key: 'c', code: 'KeyC', metaKey: true }), none, true)).toBe(true);
    expect(isApplicationKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true }), none, true)).toBe(false);
    expect(
      isApplicationKey(
        ev({ key: '`', code: 'Backquote', ctrlKey: true }),
        new Set([toggleDefault(true)]),
        true,
      ),
    ).toBe(true);
  });

  it('copy and paste have their Ctrl+Shift keys outside macOS', () => {
    const c = ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    const v = ev({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true });
    expect(isCopyKey(c, false)).toBe(true);
    expect(isPasteKey(v, false)).toBe(true);
    expect(isCopyKey(c, true)).toBe(false);
    expect(isCopyKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true }), false)).toBe(false);
  });
});
