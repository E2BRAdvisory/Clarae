// In-memory TerminalAPI for Vitest and Playwright runs on the Wails mock (M23, ADR-0064): a stand-in for
// the shells of the desktop core, with the rules of the core (apps/desktop/internal/terminal and
// internal/app/bindings_terminal.go) that the UI depends on, written independently of the UI's own code so
// that a divergence shows.
//
// No process runs: a session is a record whose "shell" echoes what is written (a return starts a new
// prompt). A test (or an e2e spec, through `window.__mock.terminal`) reads what the UI asked for (`log`,
// `sessions`) and makes the core speak (`output`, `exit`, `layout`). One page is one window: to play the
// separate window, load terminal.html with `window.__CLARAE_TERMINAL__ = { mode: 'detached', sessions }`
// set before the page loads, or make the main page lose the panel with `layout('detached')`.
import { Events } from '../../app/events';
import type { TerminalExitReason, TerminalMode } from '../../app/events.gen';
import type { TerminalOpenCheck, TerminalSession, TerminalSnapshot } from '../../app/api';

export interface MockTerminalSession extends TerminalSession {
  /** `seq` of the last output event, from 1. */
  seq: number;
  /** Everything the session has shown (the core keeps the last 2 MiB). */
  transcript: string;
  cols: number;
  rows: number;
}

export interface MockTerminal {
  mode: TerminalMode;
  sessions: Map<string, MockTerminalSession>;
  /** Every call in order: "Open vault-1 80x24", "Write term-1 \"ls\\r\"", "Undock", … */
  log: string[];
  /** At most this many sessions (the core's limit is 16). */
  maxSessions: number;
  /** The next Open fails with this error message (once). */
  failNextOpen: string;
  /** The session shows `data`, as the core's coalesced output event does (seq goes up by one). */
  output: (id: string, data: string) => void;
  /** The session ends (as the core does: with the event; the session is gone from List). */
  exit: (id: string, code: number, reason: TerminalExitReason) => void;
  /** The panel moved to the other window (or back): the core's terminal:layout. */
  layout: (mode: TerminalMode) => void;
}

interface Deps {
  emit: (name: string, payload: unknown) => void;
  /** The root of an open vault, '' when the id is not an open vault. */
  vaultPath: (vaultId: string) => string;
  /** The vault is read-only for the user (a share as viewer, or a revoked one). */
  readOnly: (vaultId: string) => boolean;
}

interface Seed {
  mode?: TerminalMode;
  sessions?: { id: string; vaultId?: string; cwd?: string; title?: string; output?: string }[];
}

const HOME = '/home/mock';
export const MOCK_SESSION_LIMIT = 16;

const fail = (code: string, text: string): Promise<never> =>
  Promise.reject(new Error(`${code}: ${text}`));
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

export function createTerminalMock(deps: Deps): {
  state: MockTerminal;
  api: Record<string, (...args: never[]) => Promise<unknown>>;
} {
  const seed = (window as unknown as { __CLARAE_TERMINAL__?: Seed }).__CLARAE_TERMINAL__;
  let n = 0;
  const state: MockTerminal = {
    mode: seed?.mode ?? 'docked',
    sessions: new Map(),
    log: [],
    maxSessions: MOCK_SESSION_LIMIT,
    failNextOpen: '',
    output: (id, data) => {
      const s = state.sessions.get(id);
      if (!s) return;
      s.seq++;
      s.transcript += data;
      deps.emit(Events.terminalOutput, { id, seq: s.seq, data });
    },
    exit: (id, code, reason) => {
      if (!state.sessions.delete(id)) return;
      deps.emit(Events.terminalExit, { id, code, reason });
    },
    layout: (mode) => {
      if (state.mode === mode) return;
      state.mode = mode;
      deps.emit(Events.terminalLayout, { mode });
    },
  };
  const prompt = (s: MockTerminalSession): string => `${s.title} $ `;
  const make = (
    vaultId: string,
    cwd: string,
    title: string,
    id = `term-${++n}`,
  ): MockTerminalSession => {
    const s: MockTerminalSession = {
      id,
      vaultId,
      cwd,
      shell: 'sh',
      title,
      seq: 0,
      transcript: '',
      cols: 80,
      rows: 24,
    };
    state.sessions.set(id, s);
    return s;
  };
  for (const x of seed?.sessions ?? []) {
    const s = make(x.vaultId ?? '', x.cwd ?? HOME, x.title ?? baseName(x.cwd ?? HOME), x.id);
    if (x.output) {
      s.seq = 1;
      s.transcript = x.output;
    }
  }
  const get = (id: string): MockTerminalSession | Promise<never> =>
    state.sessions.get(id) ?? fail('terminal-not-found', 'no such terminal session');
  const call = <T>(text: string, f: () => Promise<T> | T): Promise<T> => {
    state.log.push(text);
    return Promise.resolve().then(f);
  };

  const api = {
    Open: (vaultId: string, cols: number, rows: number): Promise<TerminalSession> =>
      call(`Open ${vaultId} ${cols}x${rows}`, async () => {
        if (state.failNextOpen) {
          const message = state.failNextOpen;
          state.failNextOpen = '';
          throw new Error(message);
        }
        if (vaultId && deps.readOnly(vaultId))
          return fail('terminal-read-only', 'this vault is read-only for you');
        if (state.sessions.size >= state.maxSessions)
          return fail('terminal-limit', 'too many terminals are open');
        const root = vaultId ? deps.vaultPath(vaultId) : '';
        const s = make(root ? vaultId : '', root || HOME, root ? baseName(root) : baseName(HOME));
        s.cols = cols;
        s.rows = rows;
        // The prompt follows the answer, as the shell's first output does.
        setTimeout(() => state.output(s.id, prompt(s)), 0);
        const { id, vaultId: vid, cwd, shell, title } = s;
        return { id, vaultId: vid, cwd, shell, title };
      }),
    CanOpen: (vaultId: string): Promise<TerminalOpenCheck> =>
      call(`CanOpen ${vaultId}`, () =>
        vaultId && deps.readOnly(vaultId)
          ? { allowed: false, reason: 'read-only' }
          : { allowed: true, reason: '' },
      ),
    Write: (id: string, data: string): Promise<void> =>
      call(`Write ${id} ${JSON.stringify(data)}`, async () => {
        const s = await get(id);
        if (data.length > 1024 * 1024) return fail('terminal-too-large', 'too much input at once');
        // The shell echoes what it is given; a return ends the line and shows the next prompt.
        const echoed = data.replaceAll('\r', '\r\n');
        setTimeout(
          () => state.output(id, data.includes('\r') ? `${echoed}${prompt(s)}` : echoed),
          0,
        );
      }),
    Resize: (id: string, cols: number, rows: number): Promise<void> =>
      call(`Resize ${id} ${cols}x${rows}`, async () => {
        const s = await get(id);
        s.cols = cols;
        s.rows = rows;
      }),
    Close: (id: string): Promise<void> =>
      call(`Close ${id}`, () => {
        // A session already gone is not an error.
        if (state.sessions.delete(id))
          setTimeout(() => deps.emit(Events.terminalExit, { id, code: 129, reason: 'closed' }), 0);
      }),
    List: (): Promise<TerminalSession[]> =>
      call('List', () =>
        [...state.sessions.values()].map(({ id, vaultId, cwd, shell, title }) => ({
          id,
          vaultId,
          cwd,
          shell,
          title,
        })),
      ),
    Snapshot: (id: string): Promise<TerminalSnapshot> =>
      call(`Snapshot ${id}`, async () => {
        const s = await get(id);
        return { data: s.transcript, seq: s.seq };
      }),
    State: (): Promise<{ mode: string }> => call('State', () => ({ mode: state.mode })),
    Undock: (): Promise<void> =>
      call('Undock', () => {
        state.layout('detached');
      }),
    Dock: (): Promise<void> =>
      call('Dock', () => {
        state.layout('docked');
      }),
  };
  return { state, api };
}
