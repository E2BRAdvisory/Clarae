import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../app/api';
import { Events } from '../app/events';
import { initI18n } from '../i18n';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import {
  activateTab,
  attachSink,
  closeActiveTab,
  closeTab,
  newTerminalTab,
  openTab,
  queueWrite,
  resetTerminal,
  setDock,
  startTerminal,
  toggleTerminal,
  undock,
  type TerminalSink,
} from './controller';
import { DOCK_KEY } from './dock';
import { useTerminal } from './store';

let mock: WailsMock;
let stop: () => void = () => undefined;

const state = useTerminal.getState;
/** Lets the mock's timers (its shell answers in a macrotask) and the promises that follow run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

interface FakeSink extends TerminalSink {
  out: string;
  resets: number;
  disposed: boolean;
}
const fakeSink = (): FakeSink => ({
  out: '',
  resets: 0,
  disposed: false,
  write(d) {
    this.out += d;
  },
  reset() {
    this.out = '';
    this.resets++;
  },
  dispose() {
    this.disposed = true;
  },
});

async function openVault(path: string): Promise<string> {
  const info = await api.vault.open(path);
  useAppStore.getState().setVault(info);
  return info.id;
}

function boot(role: 'main' | 'window' = 'main'): void {
  stop = startTerminal(role);
}

beforeEach(() => {
  initI18n('en');
  configurePlatform();
  mock = installWailsMock();
  resetTerminal();
  useAppStore.getState().setVault(null);
  localStorage.clear();
});
afterEach(() => {
  stop();
  stop = () => undefined;
  resetTerminal();
  delete (window as unknown as { __CLARAE_TERMINAL__?: unknown }).__CLARAE_TERMINAL__;
});

describe('opening tabs', () => {
  it('starts a shell in the root of the open vault and names the tab after it', async () => {
    const id = await openVault('/vaults/Notes');
    boot();
    await settle();
    expect(await openTab()).toBe(true);
    const [tab] = state().tabs;
    expect(tab).toMatchObject({ vaultId: id, cwd: '/vaults/Notes', title: 'Notes', exit: null });
    expect(state().active).toBe(tab?.id);
    expect(state().open).toBe(true);
    expect(mock.terminal.log).toContain(`Open ${id} 80x24`);
  });

  it('opens the home directory when no vault is open, and the new vault after a change of vault', async () => {
    boot();
    await settle();
    await openTab();
    expect(state().tabs[0]).toMatchObject({ vaultId: '', cwd: '/home/mock' });
    const a = await openVault('/vaults/A');
    await openTab();
    const b = await openVault('/vaults/B');
    await openTab();
    expect(state().tabs.map((t) => [t.vaultId, t.cwd])).toEqual([
      ['', '/home/mock'],
      [a, '/vaults/A'],
      [b, '/vaults/B'],
    ]);
  });

  it('shows what the core refused, translated, and keeps no tab', async () => {
    const id = await openVault('/vaults/Share');
    mock.sync.links.set(id, { ...(await api.sync.info(id)), readOnly: true });
    boot();
    await settle();
    expect(await openTab()).toBe(false);
    expect(state().tabs).toEqual([]);
    expect(state().notice).toMatch(/read-only for you/);
  });

  it('reports the limit of sessions', async () => {
    mock.terminal.maxSessions = 1;
    boot();
    await settle();
    await openTab();
    expect(await openTab()).toBe(false);
    expect(state().notice).toBe('Too many terminals are open: close one and try again.');
    expect(state().tabs).toHaveLength(1);
  });
});

describe('output', () => {
  it('draws what the shell shows, once, even for an event that arrives twice', async () => {
    boot();
    await settle();
    await openTab();
    const tab = state().tabs[0]!;
    const sink = fakeSink();
    // The prompt came before the screen existed: it waited and is drawn first.
    await settle();
    attachSink(tab.id, sink);
    expect(sink.out).toBe('mock $ ');
    mock.terminal.output(tab.id, 'ls\r\n');
    expect(sink.out).toBe('mock $ ls\r\n');
    mock.emit(Events.terminalOutput, { id: tab.id, seq: 2, data: 'ls\r\n' }); // again
    expect(sink.out).toBe('mock $ ls\r\n');
  });

  it('keeps the output of events that come before Open has answered', async () => {
    boot();
    await settle();
    // the core sent the prompt (seq 1) before the answer reached the page
    mock.emit(Events.terminalOutput, { id: 'term-1', seq: 1, data: 'early ' });
    await openTab();
    const sink = fakeSink();
    attachSink('term-1', sink);
    await settle();
    expect(sink.out).toContain('early ');
  });

  it('echoes the typed keys in order, one call at a time', async () => {
    boot();
    await settle();
    await openTab();
    const { id } = state().tabs[0]!;
    queueWrite(id, 'a');
    queueWrite(id, 'b');
    queueWrite(id, 'c');
    await settle();
    const writes = mock.terminal.log.filter((l) => l.startsWith('Write'));
    expect(writes.map((l) => JSON.parse(l.slice(`Write ${id} `.length)) as string).join('')).toBe(
      'abc',
    );
    expect(writes.length).toBeLessThan(3); // what came while one call was out went together
  });

  it('shows a refusal to write, translated', async () => {
    boot();
    await settle();
    await openTab();
    const { id } = state().tabs[0]!;
    const w = window as unknown as { go: { app: { TerminalAPI: Record<string, unknown> } } };
    w.go.app.TerminalAPI['Write'] = () =>
      Promise.reject(new Error('terminal-busy: the shell is not reading its input'));
    queueWrite(id, 'x');
    await settle();
    expect(state().notice).toBe('The program in the terminal is not reading what you type.');
  });
});

describe('closing tabs', () => {
  it('ends the session of a tab, and the last one closes the panel', async () => {
    boot();
    await settle();
    await openTab();
    await openTab();
    const [first, second] = state().tabs;
    closeTab(second!.id);
    expect(state().active).toBe(first!.id);
    expect(state().open).toBe(true);
    closeActiveTab();
    await settle();
    expect(state().tabs).toEqual([]);
    expect(state().open).toBe(false);
    expect(mock.terminal.log).toEqual(
      expect.arrayContaining([`Close ${second!.id}`, `Close ${first!.id}`]),
    );
    expect(mock.terminal.sessions.size).toBe(0);
  });

  it('releases the screen of a closed tab', async () => {
    boot();
    await settle();
    await openTab();
    const { id } = state().tabs[0]!;
    const sink = fakeSink();
    attachSink(id, sink);
    closeTab(id);
    expect(sink.disposed).toBe(true);
  });

  it('moves to the neighbour when the front tab goes', async () => {
    boot();
    await settle();
    await openTab();
    await openTab();
    await openTab();
    const [a, b, c] = state().tabs.map((t) => t.id);
    activateTab(b!);
    closeTab(b!);
    expect(state().active).toBe(c);
    closeTab(c!);
    expect(state().active).toBe(a);
  });
});

describe('how a session ends', () => {
  it('closes the tab of a shell that ended without an error', async () => {
    boot();
    await settle();
    await openTab();
    await openTab();
    const { id } = state().tabs[1]!;
    mock.terminal.exit(id, 0, 'exited');
    expect(state().tabs.map((t) => t.id)).not.toContain(id);
    expect(state().open).toBe(true);
  });

  it('keeps the tab of a shell that failed, with its code, until it is closed', async () => {
    boot();
    await settle();
    await openTab();
    const { id } = state().tabs[0]!;
    mock.terminal.exit(id, 127, 'exited');
    expect(state().tabs[0]?.exit).toEqual({ code: 127, reason: 'exited' });
    queueWrite(id, 'ls\r'); // nobody is listening any more
    await settle();
    expect(mock.terminal.log.some((l) => l.startsWith('Write'))).toBe(false);
    closeTab(id);
    expect(state().tabs).toEqual([]);
  });

  it('says that a vault became read-only, and keeps the tab', async () => {
    boot();
    await settle();
    await openTab();
    const { id } = state().tabs[0]!;
    mock.terminal.exit(id, 129, 'read-only');
    expect(state().tabs[0]?.exit).toEqual({ code: 129, reason: 'read-only' });
  });

  it('removes every tab when the separate window was closed by the system', async () => {
    boot();
    await settle();
    await openTab();
    await openTab();
    for (const t of state().tabs) mock.terminal.exit(t.id, 129, 'window-closed');
    expect(state().tabs).toEqual([]);
    expect(state().open).toBe(false);
  });
});

describe('the panel', () => {
  it('shows and hides, keeping the tabs, and starts a shell only when there is none', async () => {
    boot();
    await settle();
    await toggleTerminal();
    expect(state().open).toBe(true);
    expect(state().tabs).toHaveLength(1);
    await toggleTerminal();
    expect(state().open).toBe(false);
    expect(state().tabs).toHaveLength(1); // the shell lives on
    await toggleTerminal();
    expect(state().open).toBe(true);
    expect(state().tabs).toHaveLength(1);
  });

  it('opens a tab and the panel for a new tab', async () => {
    boot();
    await settle();
    await newTerminalTab();
    expect(state().open).toBe(true);
    await toggleTerminal(); // hide
    await newTerminalTab();
    expect(state().open).toBe(true);
    expect(state().tabs).toHaveLength(2);
  });

  it('remembers position and size per device, and survives a storage that throws', () => {
    setDock({ position: 'left', size: 333 });
    expect(JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}')).toEqual({
      position: 'left',
      size: 333,
    });
    const throwing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      expect(() => setDock({ position: 'right' })).not.toThrow();
      expect(state().dock).toEqual({ position: 'right', size: 333 });
    } finally {
      throwing.mockRestore();
    }
  });
});

describe('between the main window and the separate one', () => {
  it('releases the tabs when the panel goes away, and redraws each from its snapshot when it comes back', async () => {
    boot();
    await settle();
    await openTab();
    await openTab();
    const [a, b] = state().tabs.map((t) => t.id) as [string, string];
    const sinkA = fakeSink();
    attachSink(a, sinkA);
    await settle();
    mock.terminal.output(a, 'one\r\n');
    expect(sinkA.out).toBe('mock $ one\r\n');

    await undock();
    expect(state().mode).toBe('detached');
    expect(state().tabs).toEqual([]);
    expect(state().open).toBe(false);
    expect(sinkA.disposed).toBe(true);
    // the other window shows output meanwhile: this page ignores it
    mock.terminal.output(a, 'two\r\n');

    mock.terminal.layout('docked');
    await settle();
    expect(state().mode).toBe('docked');
    expect(state().open).toBe(true);
    expect(state().tabs.map((t) => t.id)).toEqual([a, b]);
    const again = fakeSink();
    attachSink(a, again);
    // what was shown while the panel was away is in the snapshot: drawn once, no duplicate
    expect(again.out).toBe('mock $ one\r\ntwo\r\n');
    expect(mock.terminal.log).toEqual(expect.arrayContaining([`Snapshot ${a}`, `Snapshot ${b}`]));
  });

  it('drops the events a snapshot already holds and draws the newer ones after it', async () => {
    boot();
    await settle();
    await openTab();
    await settle(); // the prompt
    const { id } = state().tabs[0]!;
    await undock();
    mock.terminal.output(id, 'A');
    mock.terminal.layout('docked');
    // an event that arrives while the snapshot is on its way, and one the snapshot covers
    mock.terminal.output(id, 'B');
    mock.emit(Events.terminalOutput, { id, seq: 1, data: 'stale' });
    await settle();
    const sink = fakeSink();
    attachSink(id, sink);
    expect(sink.out).toBe('mock $ AB');
    mock.terminal.output(id, 'C');
    expect(sink.out).toBe('mock $ ABC');
  });

  it('takes the panel in the separate window, listing the sessions of the core', async () => {
    (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
      mode: 'detached',
      sessions: [{ id: 'term-9', vaultId: '', cwd: '/work/x', title: 'x', output: 'hello\r\n' }],
    };
    mock = installWailsMock();
    boot('window');
    await settle();
    expect(state().mode).toBe('detached');
    expect(state().tabs.map((t) => t.id)).toEqual(['term-9']);
    const sink = fakeSink();
    attachSink('term-9', sink);
    expect(sink.out).toBe('hello\r\n');
  });

  it('goes back to the main window when its last tab closes', async () => {
    (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
      mode: 'detached',
      sessions: [{ id: 'term-9', cwd: '/work/x', title: 'x' }],
    };
    mock = installWailsMock();
    boot('window');
    await settle();
    closeActiveTab();
    await settle();
    expect(mock.terminal.log).toContain('Dock');
    expect(state().mode).toBe('docked');
    expect(state().tabs).toEqual([]);
  });

  it('opens new tabs of the separate window in the vault of the front tab', async () => {
    (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
      mode: 'detached',
      sessions: [{ id: 'term-9', vaultId: 'vault-7', cwd: '/work/x', title: 'x' }],
    };
    mock = installWailsMock();
    boot('window');
    await settle();
    await newTerminalTab();
    expect(mock.terminal.log).toContain('Open vault-7 80x24');
  });

  it('only brings the window forward from the main one while the panel is detached', async () => {
    boot();
    await settle();
    await openTab();
    await undock();
    mock.terminal.log.length = 0;
    await toggleTerminal();
    await newTerminalTab();
    expect(mock.terminal.log).toEqual(['Undock', 'Undock']);
    expect(state().tabs).toEqual([]);
  });
});

describe('locked vaults', () => {
  /** What the core says of the vault: its link (SyncAPI.Info) and the status of its sync. */
  async function setVault(id: string, locked: boolean, phase: string): Promise<void> {
    mock.sync.links.set(id, {
      ...(await api.sync.info(id)),
      linked: true,
      kind: 'private',
      locked,
    });
    mock.sync.status.set(id, { ...(await api.sync.status(id)), phase } as never);
  }

  it('covers the terminals of a vault while it is locked, and uncovers them when it is unlocked', async () => {
    const id = await openVault('/vaults/Private');
    boot();
    await settle();
    await openTab();
    expect(state().locked[id]).toBeUndefined();
    await setVault(id, true, 'locked');
    mock.emit(Events.vaultLocked, { vaultId: id, reason: 'manual', pending: 0, conflicts: 0 });
    expect(state().locked[id]).toBe(true);
    await settle();
    expect(state().locked[id]).toBe(true);
    await setVault(id, false, 'idle');
    mock.emit(Events.syncStatus, mock.sync.status.get(id));
    await settle();
    expect(state().locked[id]).toBe(false);
  });

  it('learns that a vault is locked when its tab is opened', async () => {
    const id = await openVault('/vaults/Private');
    await setVault(id, true, 'locked');
    boot();
    await settle();
    await openTab();
    await settle();
    expect(state().locked[id]).toBe(true);
  });

  it('keeps a vault covered while its sync is paused, whatever the next status says', async () => {
    const id = await openVault('/vaults/Private');
    // paused by the user, and the key is gone: the phase is `paused`, the vault is locked
    await setVault(id, true, 'paused');
    boot();
    await settle();
    await openTab();
    await settle();
    expect(state().locked[id]).toBe(true);
    mock.emit(Events.syncStatus, mock.sync.status.get(id));
    mock.emit(Events.syncStatus, { ...mock.sync.status.get(id), phase: 'idle' });
    await settle();
    expect(state().locked[id]).toBe(true);
  });
});

describe('a session that ends before the page has its tab', () => {
  it('opens the tab as ended when the exit came before the answer of Open', async () => {
    boot();
    await settle();
    const opened = openTab();
    // the core's exit event reaches the page before the answer of Open does
    mock.emit(Events.terminalExit, { id: 'term-1', code: 2, reason: 'exited' });
    await opened;
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]?.exit).toEqual({ code: 2, reason: 'exited' });
  });

  it('does not keep a tab whose session ended cleanly before the answer', async () => {
    boot();
    await settle();
    const opened = openTab();
    mock.emit(Events.terminalExit, { id: 'term-1', code: 0, reason: 'exited' });
    await opened;
    expect(state().tabs).toEqual([]);
    expect(state().open).toBe(false);
  });

  it('marks a tab as ended when its snapshot is refused as not found', async () => {
    (window as unknown as { __CLARAE_TERMINAL__: unknown }).__CLARAE_TERMINAL__ = {
      mode: 'detached',
      sessions: [{ id: 'term-9', cwd: '/work/x', title: 'x' }],
    };
    mock = installWailsMock();
    const w = window as unknown as { go: { app: { TerminalAPI: Record<string, unknown> } } };
    w.go.app.TerminalAPI['Snapshot'] = () =>
      Promise.reject(new Error('terminal-not-found: no such terminal session'));
    boot('window');
    await settle();
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]?.exit).toEqual({ code: 0, reason: 'exited' });
  });
});
