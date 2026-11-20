import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useSettings } from '../state/settings';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { resetTerminal } from './controller';
import { TerminalWindow } from './TerminalWindow';

// The panel is covered by TerminalPanel.test.tsx and the browser specs: here the page around it.
vi.mock('./lazy', () => ({ LazyTerminalPanel: () => null }));

let mock: WailsMock;
const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 20)));

beforeEach(() => {
  initI18n('en');
  configurePlatform();
  (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
    mode: 'detached',
    sessions: [{ id: 'term-7', vaultId: 'vault-7', cwd: '/work/notes', title: 'notes' }],
  };
  mock = installWailsMock();
  resetTerminal();
  useSettings.getState().reset();
});
afterEach(() => {
  cleanup();
  resetTerminal();
  useSettings.getState().reset();
  delete (window as unknown as { __CLARAE_TERMINAL__?: unknown }).__CLARAE_TERMINAL__;
  vi.restoreAllMocks();
});

describe('the page of the separate terminal window', () => {
  it('has the title of the application in its language, on the page and on the window', async () => {
    const setTitle = vi.fn();
    (window as unknown as { runtime: Record<string, unknown> }).runtime['WindowSetTitle'] =
      setTitle;
    render(<TerminalWindow />);
    await settle();
    expect(document.title).toBe('Clarae notanda — Terminal');
    expect(setTitle).toHaveBeenCalledWith('Clarae notanda — Terminal');
  });

  it('uses the hotkeys the user set in the vault of the front tab', async () => {
    const read = vi
      .spyOn(api.vault, 'readConfig')
      .mockImplementation((_id, name) =>
        Promise.resolve(
          name === 'hotkeys.json' ? JSON.stringify({ 'terminal:toggle': ['Mod-j'] }) : '',
        ),
      );
    render(<TerminalWindow />);
    await settle();
    expect(read).toHaveBeenCalledWith('vault-7', 'hotkeys.json');
    expect(useSettings.getState().hotkeys).toEqual({ 'terminal:toggle': ['Mod-j'] });
    // the key the user chose runs the command (here: back to the main window)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', ctrlKey: true }));
    await settle();
    expect(mock.terminal.log).toContain('Dock');
  });

  it('uses the terminal font size of the vault of the front tab, and 13 without one', async () => {
    vi.spyOn(api.vault, 'readConfig').mockImplementation((_id, name) =>
      Promise.resolve(name === 'appearance.json' ? JSON.stringify({ terminalFontSize: 18 }) : ''),
    );
    render(<TerminalWindow />);
    await settle();
    expect(useSettings.getState().appearance.terminalFontSize).toBe(18);
    cleanup();
    useSettings.getState().reset();
    expect(useSettings.getState().appearance.terminalFontSize).toBe(13);
  });

  it('uses the terminal font of the vault of the front tab, and the default without one', async () => {
    vi.spyOn(api.vault, 'readConfig').mockImplementation((_id, name) =>
      Promise.resolve(
        name === 'appearance.json' ? JSON.stringify({ terminalFont: 'Fira Code' }) : '',
      ),
    );
    render(<TerminalWindow />);
    await settle();
    expect(useSettings.getState().appearance.terminalFont).toBe('Fira Code');
    cleanup();
    useSettings.getState().reset();
    resetTerminal();
    (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
      mode: 'detached',
      sessions: [{ id: 'term-8', vaultId: '', cwd: '/home/mock', title: 'mock' }],
    };
    mock = installWailsMock();
    render(<TerminalWindow />);
    await settle();
    expect(useSettings.getState().appearance.terminalFont).toBe('MesloLGS NF');
  });

  it('keeps the defaults when the vault of the front tab cannot be read', async () => {
    vi.spyOn(api.vault, 'readConfig').mockRejectedValue(new Error('vault-not-open: closed'));
    render(<TerminalWindow />);
    await settle();
    expect(useSettings.getState().hotkeys).toEqual({});
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '`', code: 'Backquote', ctrlKey: true }),
    );
    await settle();
    expect(mock.terminal.log).toContain('Dock');
  });
});
