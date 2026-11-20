import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { api, linkInfo } from '../app/api';
import { comboIndex } from '../commands/hotkeys';
import {
  commandById,
  commandForEvent,
  currentCombos,
  isAvailable,
  isEnabled,
  runCommand,
} from '../commands/registry';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { resetTerminal, startTerminal } from './controller';
import { newTabDefault, toggleDefault } from './keys';
import { isReservedKey, reservedCombos } from './reserved';
import { useTerminal } from './store';

let mock: WailsMock;
let stop: () => void = () => undefined;
const state = useTerminal.getState;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
const cmd = (id: string) => commandById.get(id)!;

beforeEach(() => {
  initI18n('en');
  configurePlatform();
  mock = installWailsMock();
  resetTerminal();
  useAppStore.getState().setVault(null);
  useSync.setState({ info: {} });
  stop = startTerminal('main');
});
afterEach(() => {
  stop();
  resetTerminal();
  configurePlatform();
});

describe('terminal commands', () => {
  const ids = [
    'terminal:toggle',
    'terminal:new-tab',
    'terminal:close-tab',
    'terminal:undock',
    'terminal:dock',
  ];

  it('exist for the terminal feature, on a host with the capability only', () => {
    for (const id of ids) {
      expect(cmd(id).feature, id).toBe('terminal');
      expect(cmd(id).requires, id).toEqual(['terminal']);
      expect(isAvailable(cmd(id)), id).toBe(true);
    }
    configurePlatform({ kind: 'web' });
    for (const id of ids) {
      expect(isAvailable(cmd(id)), id).toBe(false);
      expect(isEnabled(cmd(id)), id).toBe(false);
    }
  });

  it('have the platform default combinations, and a Ctrl+` that finds the command', () => {
    expect(cmd('terminal:toggle').defaults).toEqual([toggleDefault()]);
    expect(cmd('terminal:new-tab').defaults).toEqual([newTabDefault()]);
    // jsdom is not a Mac: the combination is Ctrl+`
    const tick = { key: '`', code: 'Backquote', ctrlKey: true, bubbles: true };
    expect(commandForEvent(new KeyboardEvent('keydown', tick), {})?.id).toBe('terminal:toggle');
    expect(
      commandForEvent(new KeyboardEvent('keydown', { ...tick, key: '~', shiftKey: true }), {})?.id,
    ).toBe('terminal:new-tab');
    // Cmd+` is not the application's
    expect(
      commandForEvent(new KeyboardEvent('keydown', { ...tick, ctrlKey: false, metaKey: true }), {}),
    ).toBeNull();
  });

  it('toggle the panel, and Ctrl+Shift+` opens a tab even with the panel closed', async () => {
    await runCommand('terminal:toggle');
    expect(state().open).toBe(true);
    expect(state().tabs).toHaveLength(1);
    await runCommand('terminal:toggle');
    expect(state().open).toBe(false);
    await runCommand('terminal:new-tab');
    expect(state().open).toBe(true);
    expect(state().tabs).toHaveLength(2);
    await settle();
  });

  it('close the front tab only while the panel is shown', async () => {
    expect(isEnabled(cmd('terminal:close-tab'))).toBe(false);
    await runCommand('terminal:new-tab');
    expect(isEnabled(cmd('terminal:close-tab'))).toBe(true);
    await runCommand('terminal:close-tab');
    expect(state().tabs).toEqual([]);
    expect(state().open).toBe(false);
  });

  it('undock needs a tab and dock needs the panel to be detached', async () => {
    expect(isEnabled(cmd('terminal:undock'))).toBe(false);
    expect(isEnabled(cmd('terminal:dock'))).toBe(false);
    await runCommand('terminal:new-tab');
    expect(isEnabled(cmd('terminal:undock'))).toBe(true);
    await runCommand('terminal:undock');
    expect(state().mode).toBe('detached');
    expect(isEnabled(cmd('terminal:undock'))).toBe(false);
    expect(isEnabled(cmd('terminal:dock'))).toBe(true);
    await runCommand('terminal:dock');
    expect(state().mode).toBe('docked');
    expect(state().tabs).toHaveLength(1);
    expect(mock.terminal.log).toEqual(expect.arrayContaining(['Undock', 'Dock']));
  });

  it('refuse to start a shell for a vault that is read-only, but still close an open terminal', async () => {
    const info = await api.vault.open('/vaults/Viewer');
    useAppStore.getState().setVault(info);
    await runCommand('terminal:new-tab'); // a terminal is open (the vault was writable then)
    expect(state().tabs).toHaveLength(1);
    act(() => useSync.setState({ info: { [info.id]: linkInfo({ readOnly: true }) } }));
    expect(isEnabled(cmd('terminal:new-tab'))).toBe(false);
    expect(isEnabled(cmd('terminal:toggle'))).toBe(true); // it is open: it can be closed
    await runCommand('terminal:toggle');
    expect(state().open).toBe(false);
    expect(isEnabled(cmd('terminal:toggle'))).toBe(false); // closed: it would start a shell here
    await runCommand('terminal:toggle');
    expect(state().open).toBe(false);
  });
});

describe('the key left of 1 on every layout', () => {
  const tick = (o: Partial<KeyboardEventInit> & { key: string }) =>
    new KeyboardEvent('keydown', { code: 'Backquote', bubbles: true, ...o });
  const mac = {
    'terminal:toggle': [toggleDefault(true)],
    'terminal:new-tab': [newTabDefault(true)],
  };
  const onMac = () => vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  const openNote = async () => {
    useAppStore.getState().setVault(await api.vault.open('/vaults/Keys'));
    act(() => useAppStore.getState().openNote('Note.md', { newTab: true }));
  };
  afterEach(() => vi.restoreAllMocks());

  it('on a Mac with an Italian layout: Cmd splits as before, Ctrl and Ctrl+Shift are the terminal', async () => {
    onMac();
    await openNote();
    // the key types "\\" (and "|" with Shift) there
    expect(commandForEvent(tick({ key: '\\', metaKey: true }), mac)?.id).toBe('pane:split-right');
    expect(commandForEvent(tick({ key: '\\', ctrlKey: true }), mac)?.id).toBe('terminal:toggle');
    expect(commandForEvent(tick({ key: '|', ctrlKey: true, shiftKey: true }), mac)?.id).toBe(
      'terminal:new-tab',
    );
    // Cmd+` and Cmd+Shift+` are the system's
    expect(commandForEvent(tick({ key: '`', metaKey: true }), mac)).toBeNull();
    expect(commandForEvent(tick({ key: '~', metaKey: true, shiftKey: true }), mac)).toBeNull();
    expect(commandForEvent(tick({ key: '|', metaKey: true, shiftKey: true }), mac)).toBeNull();
  });

  it('on a Mac with a US layout: Ctrl+` and Ctrl+Shift+` are the terminal', () => {
    onMac();
    expect(commandForEvent(tick({ key: '`', ctrlKey: true }), mac)?.id).toBe('terminal:toggle');
    expect(commandForEvent(tick({ key: '~', ctrlKey: true, shiftKey: true }), mac)?.id).toBe(
      'terminal:new-tab',
    );
    expect(commandForEvent(tick({ key: '`', metaKey: true }), mac)).toBeNull();
    expect(commandForEvent(tick({ key: '~', metaKey: true, shiftKey: true }), mac)).toBeNull();
  });

  it('on Windows and Linux with a US layout: Ctrl+` and Ctrl+Shift+` are the terminal', async () => {
    await openNote();
    expect(commandForEvent(tick({ key: '`', ctrlKey: true }), {})?.id).toBe('terminal:toggle');
    expect(commandForEvent(tick({ key: '~', ctrlKey: true, shiftKey: true }), {})?.id).toBe(
      'terminal:new-tab',
    );
  });

  it('on Windows and Linux with an Italian layout, Ctrl+key is the split (a known conflict), Ctrl+Shift+key the terminal', async () => {
    // "\\" is Mod-\\ there: the character wins over the alias while a note is open for it
    expect(commandForEvent(tick({ key: '\\', ctrlKey: true }), {})?.id).toBe('terminal:toggle'); // no note: split is off
    await openNote();
    expect(commandForEvent(tick({ key: '\\', ctrlKey: true }), {})?.id).toBe('pane:split-right');
    expect(commandForEvent(tick({ key: '|', ctrlKey: true, shiftKey: true }), {})?.id).toBe(
      'terminal:new-tab',
    );
    // the separate window has no split: there the key is the terminal's
    expect(
      commandForEvent(tick({ key: '\\', ctrlKey: true }), {}, (c) => c.id.startsWith('terminal:'))
        ?.id,
    ).toBe('terminal:toggle');
  });

  it('is not flagged by Settings > Hotkeys: its table compares equal combos, and Mod-\\ is not Mod-`', () => {
    const index = comboIndex(currentCombos({}));
    expect(index.get('Mod-\\')).toEqual(['pane:split-right']);
    expect(index.get('Mod-`')).toEqual(['terminal:toggle']);
  });
});

describe('the keys inside the terminal screen', () => {
  const tick = (o: Partial<KeyboardEventInit> & { key: string }) =>
    new KeyboardEvent('keydown', { code: 'Backquote', bubbles: true, ...o });
  const mac = {
    'terminal:toggle': [toggleDefault(true)],
    'terminal:new-tab': [newTabDefault(true)],
  };
  const openNote = async () => {
    useAppStore.getState().setVault(await api.vault.open('/vaults/Keys'));
    act(() => useAppStore.getState().openNote('Note.md', { newTab: true }));
  };
  afterEach(() => vi.restoreAllMocks());

  it('leave Ctrl+\\ to the shell on an Italian layout when it would split the editor', async () => {
    await openNote();
    expect(isReservedKey(tick({ key: '\\', ctrlKey: true }), {}, false)).toBe(false);
    // Ctrl+Shift+key and the US key are the terminal's
    expect(isReservedKey(tick({ key: '|', ctrlKey: true, shiftKey: true }), {}, false)).toBe(true);
    expect(isReservedKey(tick({ key: '`', ctrlKey: true }), {}, false)).toBe(true);
    // in the separate window there is no split: the key is the terminal's
    expect(isReservedKey(tick({ key: '\\', ctrlKey: true }), {}, true)).toBe(true);
  });

  it('keep Ctrl+\\ for the terminal when nothing else would take it', () => {
    expect(isReservedKey(tick({ key: '\\', ctrlKey: true }), {}, false)).toBe(true); // no note: no split
  });

  it('keep Ctrl+P and the other plain Ctrl keys for the shell, and the palette with Shift for the application', () => {
    const p = { code: 'KeyP', ctrlKey: true };
    expect(isReservedKey(tick({ ...p, key: 'p' }), {}, false)).toBe(false);
    expect(isReservedKey(tick({ ...p, key: 'P', shiftKey: true }), {}, false)).toBe(true);
    expect(isReservedKey(tick({ ...p, key: 'P', shiftKey: true }), {}, true)).toBe(false);
  });

  it('on a Mac pass Cmd keys and both ISO keys with Ctrl to the application', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    expect(isReservedKey(tick({ key: 'p', code: 'KeyP', metaKey: true }), mac, false)).toBe(true);
    expect(
      isReservedKey(tick({ key: '§', code: 'IntlBackslash', ctrlKey: true }), mac, false),
    ).toBe(true);
    expect(isReservedKey(tick({ key: '\\', ctrlKey: true }), mac, false)).toBe(true); // the "<>" key
    expect(isReservedKey(tick({ key: 'r', code: 'KeyR', ctrlKey: true }), mac, false)).toBe(false);
  });
});

describe('the keys the terminal hands to the application', () => {
  it('follow the hotkeys the user set', () => {
    expect([...reservedCombos({}, false)].sort()).toEqual(
      [toggleDefault(), newTabDefault()].sort(),
    );
    const mine = reservedCombos({ 'terminal:toggle': ['Mod-j'], 'palette:open': [] }, true);
    expect([...mine].sort()).toEqual(['Mod-j', newTabDefault()].sort());
  });

  it('include only the palette combinations that use Shift (plain Ctrl+P is the shell’s)', () => {
    const r = reservedCombos({}, true);
    expect(r.has('Mod-Shift-p')).toBe(true);
    expect(r.has('Mod-p')).toBe(false);
  });
});
