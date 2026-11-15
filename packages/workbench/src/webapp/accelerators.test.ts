import { describe, expect, it } from 'vitest';
import { commands } from '../commands/registry';
import { currentCombos } from '../commands/registry';
import { acceleratorProblem } from '../test/wails-mock/webview';
import { MAX_ACCELERATORS, reservedKeys, toAccelerator } from './accelerators';
import { forwardsKeys } from './start';

describe('toAccelerator', () => {
  it('converts the combinations of the application to the grammar of the core', () => {
    expect(toAccelerator('Mod-w', true)).toBe('cmd+w');
    expect(toAccelerator('Mod-w', false)).toBe('ctrl+w');
    expect(toAccelerator('Mod-Shift-p', true)).toBe('shift+cmd+p');
    expect(toAccelerator('Mod-Alt-ArrowRight', true)).toBe('alt+cmd+right');
    expect(toAccelerator('Ctrl-Alt-Shift-Mod-k', true)).toBe('ctrl+alt+shift+cmd+k');
    expect(toAccelerator('Mod-\\', true)).toBe('cmd+\\');
    expect(toAccelerator('Mod-,', true)).toBe('cmd+,');
    expect(toAccelerator('Mod-Enter', true)).toBe('cmd+enter');
    expect(toAccelerator('Mod-[', true)).toBe('cmd+[');
    expect(toAccelerator('Mod-+', true)).toBe('cmd+plus');
    expect(toAccelerator('Mod--', true)).toBe('cmd+-');
    expect(toAccelerator('Mod-PageDown', false)).toBe('ctrl+pagedown');
    expect(toAccelerator('Mod-Space', true)).toBe('cmd+space');
  });

  it('lets a function key stand alone, and nothing else', () => {
    expect(toAccelerator('F2', true)).toBe('f2');
    expect(toAccelerator('Shift-F5', true)).toBe('shift+f5');
    expect(toAccelerator('F20', true)).toBe('f20');
    expect(toAccelerator('F21', true)).toBeNull();
    expect(toAccelerator('Escape', true)).toBeNull();
    expect(toAccelerator('Alt-x', true)).toBeNull();
    expect(toAccelerator('Shift-a', true)).toBeNull();
  });

  it('writes a shifted symbol as the key it is on the keyboard, which is what the driver reads', () => {
    // the core reads the key without its modifiers: Mod-Shift-\\ arrives as shift+cmd+\\, never shift+cmd+|
    expect(toAccelerator('Mod-Shift-\\', true)).toBe('shift+cmd+\\');
    expect(toAccelerator('Mod-Shift-|', true)).toBe('shift+cmd+\\');
    expect(toAccelerator('Mod-Shift-?', true)).toBe('shift+cmd+/');
    expect(toAccelerator('Mod-Shift-{', true)).toBe('shift+cmd+[');
    expect(toAccelerator('Mod-Shift-+', true)).toBe('shift+cmd+=');
    // without Shift a symbol is itself
    expect(toAccelerator('Mod-|', true)).toBe('cmd+|');
    expect(toAccelerator('Mod-+', true)).toBe('cmd+plus');
  });

  it('drops what a page needs to read what the user writes', () => {
    for (const c of ['Mod-c', 'Mod-v', 'Mod-x', 'Mod-a', 'Mod-z', 'Mod-Shift-z'])
      expect(toAccelerator(c, true), c).toBeNull();
    // on another system Mod is Ctrl, which the core does not hold back
    expect(toAccelerator('Mod-c', false)).toBe('ctrl+c');
  });

  it('drops what the core has no word for', () => {
    expect(toAccelerator('Meta-k', false)).toBeNull();
    expect(toAccelerator('Meta-k', true)).toBe('cmd+k');
    expect(toAccelerator('Mod-Insert', true)).toBeNull();
    expect(toAccelerator('Mod-é', true)).toBeNull();
    expect(toAccelerator('', true)).toBeNull();
    expect(toAccelerator('Hyper-k', true)).toBeNull();
  });

  it('never gives the core something it refuses', () => {
    const combos = [
      'Mod-a',
      'Mod-Shift-z',
      'Mod-,',
      'Mod-.',
      'Mod-/',
      'Mod-;',
      "Mod-'",
      'Mod-`',
      'Mod-=',
      'Mod--',
      'Mod-1',
      'Mod-0',
      'Mod-Tab',
      'Mod-Backspace',
      'Mod-Delete',
      'Mod-Home',
      'Ctrl-Tab',
      'Ctrl-Shift-Tab',
      'Mod-Alt-Shift-ArrowUp',
      'F1',
      'F12',
      'Ctrl-Alt-Shift-Mod-F5',
      'Mod-[',
      'Mod-]',
    ];
    for (const mac of [true, false])
      for (const c of combos) {
        const a = toAccelerator(c, mac);
        if (a !== null) expect(acceleratorProblem(a), `${c} -> ${a}`).toBe('');
      }
  });
});

describe('reservedKeys', () => {
  it('lists each accelerator once, with the commands that use it', () => {
    const r = reservedKeys(
      new Map([
        ['palette:open', ['Mod-p', 'Mod-Shift-p']],
        ['other:open', ['Mod-p']],
        ['note:copy', ['Mod-c']],
        ['tab:close', ['Mod-w']],
      ]),
      true,
    );
    expect(r.accelerators).toEqual(['cmd+p', 'shift+cmd+p', 'cmd+w']);
    expect(r.commands.get('cmd+p')).toEqual(['palette:open', 'other:open']);
    expect(r.commands.has('cmd+c')).toBe(false);
  });

  it('stops at the most the core takes', () => {
    const many = new Map<string, string[]>();
    for (let i = 0; i < 200; i++)
      many.set(`c:${i}`, [`Mod-Alt-Shift-${String.fromCharCode(33 + (i % 90))}-${i}`]);
    const keys = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
    const combos = new Map<string, string[]>();
    let n = 0;
    for (const a of keys)
      for (const mods of ['Mod-', 'Mod-Shift-', 'Mod-Alt-', 'Ctrl-Alt-', 'Mod-Alt-Shift-'])
        combos.set(`c:${n++}`, [`${mods}${a}`]);
    expect(combos.size).toBeGreaterThan(MAX_ACCELERATORS);
    const r = reservedKeys(combos, true);
    expect(r.accelerators).toHaveLength(MAX_ACCELERATORS);
    expect(new Set(r.accelerators).size).toBe(MAX_ACCELERATORS);
  });

  it('holds what the commands of the application bind by default, all of it accepted by the core', () => {
    const combos = new Map([...currentCombos({})].filter(([id]) => forwardsKeys(id)));
    for (const mac of [true, false]) {
      const r = reservedKeys(combos, mac);
      expect(r.accelerators.length).toBeGreaterThan(10);
      for (const a of r.accelerators) expect(acceleratorProblem(a), a).toBe('');
    }
    const mac = reservedKeys(combos, true);
    // the palette, closing a tab and settings are reserved; the keys of the editors are not
    expect(mac.accelerators).toEqual(expect.arrayContaining(['cmd+p', 'cmd+w', 'cmd+,']));
    expect(mac.accelerators).not.toContain('cmd+b');
    expect(mac.accelerators).not.toContain('cmd+k');
    // a page uses F2 (a cell is edited with it): renaming the file is not worth taking it
    expect(mac.accelerators).not.toContain('f2');
    expect(forwardsKeys('note:rename')).toBe(false);
    expect(forwardsKeys('mode:toggle-reading')).toBe(false);
    expect(forwardsKeys('palette:open')).toBe(true);
    expect(commands.length).toBeGreaterThan(50);
  });
});
