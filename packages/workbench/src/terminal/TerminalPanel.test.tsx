import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api, linkInfo } from '../app/api';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { openTab, resetTerminal, startTerminal } from './controller';
import { dispose, mountScreen } from './instances';
import { DOCK_KEY } from './dock';
import { TerminalLayout } from './TerminalLayout';
import { TerminalPanel } from './TerminalPanel';
import { useTerminal } from './store';

// The screens are xterm's: they are covered by the browser specs. Here the panel around them.
vi.mock('./instances', () => ({
  mountScreen: vi.fn(),
  fit: vi.fn(),
  focusScreen: vi.fn(),
  themeScreens: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('./lazy', async () => {
  const { TerminalPanel: Panel } = await import('./TerminalPanel');
  return { LazyTerminalPanel: Panel };
});

class Observer {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

let mock: WailsMock;
let stop: () => void = () => undefined;
const state = useTerminal.getState;
const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 10)));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', Observer);
  initI18n('en');
  configurePlatform();
  mock = installWailsMock();
  localStorage.clear();
  resetTerminal();
  useAppStore.getState().setVault(null);
  useSync.setState({ info: {} });
  stop = startTerminal('main');
});
afterEach(() => {
  cleanup();
  stop();
  resetTerminal();
  configurePlatform();
  vi.unstubAllGlobals();
});

async function withTabs(n: number): Promise<void> {
  act(() => useTerminal.setState({ open: true }));
  for (let i = 0; i < n; i++) await act(async () => void (await openTab()));
}

describe('terminal panel', () => {
  it('shows a tab per session, the front one selected, with the folder as its tooltip', async () => {
    render(<TerminalPanel />);
    expect(screen.getByText(/No terminal is open/)).toBeInTheDocument();
    await withTabs(2);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
    expect(tabs[0]).toHaveAttribute('title', '/home/mock');
    fireEvent.click(tabs[0]!);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('opens a tab with + and closes one with its ×, the last one closing the panel', async () => {
    render(<TerminalPanel />);
    await withTabs(1);
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await settle();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    const close = document.querySelectorAll<HTMLButtonElement>('.terminal-tab .close');
    fireEvent.click(close[0]!);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.terminal-tab .close')!);
    await settle();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(state().open).toBe(false);
    expect(mock.terminal.sessions.size).toBe(0);
  });

  it('closes a tab with Delete and moves between tabs with the arrows', async () => {
    render(<TerminalPanel />);
    await withTabs(3);
    const [a, , c] = screen.getAllByRole('tab');
    expect(c).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(c!, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(a!, { key: 'Delete' });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('keeps + off for a vault that is read-only, with the reason', async () => {
    render(<TerminalPanel />);
    await withTabs(1);
    const info = await api.vault.open('/vaults/Viewer');
    act(() => {
      useAppStore.getState().setVault(info);
      useSync.setState({ info: { [info.id]: linkInfo({ readOnly: true }) } });
    });
    const plus = screen.getByRole('button', { name: 'New terminal' });
    expect(plus).toBeDisabled();
    expect(plus).toHaveAttribute('title', 'New terminal: this vault is read-only for you');
  });

  it('lets the user choose where the panel sits, and remembers it', () => {
    render(<TerminalPanel />);
    const select = screen.getByRole('combobox', { name: 'Position of the terminal' });
    expect(select).toHaveValue('bottom');
    fireEvent.change(select, { target: { value: 'left' } });
    expect(state().dock.position).toBe('left');
    expect(JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}')).toMatchObject({ position: 'left' });
  });

  it('has the undock button last in the bar, and it is off until there is a tab', async () => {
    render(<TerminalPanel />);
    const bar = document.querySelector('.terminal-bar')!;
    const last = bar.lastElementChild as HTMLElement;
    expect(last).toHaveAccessibleName('Undock terminal');
    expect(last).toBeDisabled();
    await withTabs(1);
    expect(last).toBeEnabled();
    fireEvent.click(last);
    await settle();
    expect(state().mode).toBe('detached');
  });

  it('says why a session ended, and covers the tabs of a locked vault', async () => {
    render(<TerminalPanel />);
    await withTabs(1);
    const { id } = state().tabs[0]!;
    mock.terminal.exit(id, 3, 'exited');
    await settle();
    expect(screen.getByText(/The shell ended \(exit code 3\)/)).toBeInTheDocument();
    cleanup();
    resetTerminal();
    stop();
    stop = startTerminal('main');
    render(<TerminalPanel />);
    await withTabs(1);
    const second = state().tabs[0]!.id;
    mock.terminal.exit(second, 129, 'read-only');
    await settle();
    expect(
      screen.getByText('The vault became read-only: the session was closed.'),
    ).toBeInTheDocument();
    act(() => useTerminal.setState({ locked: { '': true } }));
    // the home directory has no vault: nothing to lock
    expect(screen.queryByText(/This vault is locked/)).toBeNull();
    act(() =>
      useTerminal.setState({
        tabs: state().tabs.map((t) => ({ ...t, vaultId: 'v1' })),
        locked: { v1: true },
      }),
    );
    expect(screen.getByText(/This vault is locked/)).toBeInTheDocument();
  });

  it('shows what the core refused, translated, until it is dismissed', async () => {
    mock.terminal.failNextOpen = 'terminal-failed: the shell could not start';
    render(<TerminalPanel />);
    act(() => useTerminal.setState({ open: true }));
    await act(async () => void (await openTab()));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The terminal could not do it: see the log.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('in the separate window has no position selector and offers to dock back', () => {
    stop();
    resetTerminal();
    stop = startTerminal('window');
    act(() => useTerminal.setState({ mode: 'detached' }));
    render(<TerminalPanel />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dock to Clarae' })).toBeEnabled();
  });
});

describe('terminal layout', () => {
  it('puts the panel next to the work area where the user chose, hidden until it opens', async () => {
    useTerminal.setState({ dock: { position: 'right', size: 300 } });
    const { container } = render(
      <TerminalLayout>
        <p>work</p>
      </TerminalLayout>,
    );
    expect(screen.getByText('work')).toBeInTheDocument();
    expect(container.querySelector('.terminal-dock')).toBeNull();
    expect(container.querySelector('.terminal-layout')).toHaveClass('right');
    act(() => useTerminal.setState({ open: true }));
    await settle();
    const dock = container.querySelector<HTMLElement>('.terminal-dock')!;
    expect(dock).not.toHaveAttribute('hidden');
    expect(dock.style.width).toBe('300px');
    // closed again: still mounted, so the screens stay
    act(() => useTerminal.setState({ open: false }));
    expect(dock).toHaveAttribute('hidden');
  });

  it('has a splitter that works from the keyboard and is remembered', async () => {
    const { container } = render(
      <TerminalLayout>
        <p>work</p>
      </TerminalLayout>,
    );
    act(() => useTerminal.setState({ open: true }));
    await settle();
    const bar = screen.getByRole('separator', { name: 'Resize the terminal' });
    expect(bar).toHaveAttribute('aria-orientation', 'horizontal');
    expect(container.querySelector<HTMLElement>('.terminal-dock')?.style.height).toBe('280px');
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(state().dock.size).toBe(296);
    fireEvent.keyDown(bar, { key: 'ArrowDown', shiftKey: true });
    expect(state().dock.size).toBe(232);
    expect(JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}')).toMatchObject({ size: 232 });
  });

  it('keeps its tabs and screens when the vault view is rebuilt (a change of vault)', async () => {
    const view = (key: string) => (
      <TerminalLayout key={key}>
        <p>work</p>
      </TerminalLayout>
    );
    const { rerender } = render(view('vault-a'));
    act(() => useTerminal.setState({ open: true }));
    await act(async () => void (await openTab()));
    await settle();
    const mounted = vi.mocked(mountScreen).mock.calls;
    const first = mounted[mounted.length - 1]!;
    const id = state().tabs[0]!.id;
    rerender(view('vault-b')); // the vault view is keyed by the vault: it is rebuilt
    await settle();
    expect(state().tabs.map((t) => t.id)).toEqual([id]);
    expect(dispose).not.toHaveBeenCalled();
    const again = vi.mocked(mountScreen).mock.calls[vi.mocked(mountScreen).mock.calls.length - 1]!;
    expect(again[0]).toBe(id);
    expect(again[1]).not.toBe(first[1]); // the same screen, put in the new view
    expect(mock.terminal.sessions.size).toBe(1);
  });

  it('is only the work area where the host cannot run processes', () => {
    configurePlatform({ kind: 'web' });
    const { container } = render(
      <TerminalLayout>
        <p>work</p>
      </TerminalLayout>,
    );
    expect(container.querySelector('.terminal-layout')).toBeNull();
    expect(screen.getByText('work')).toBeInTheDocument();
  });
});
