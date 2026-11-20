// What the integrated terminal does (ADR-0064): opens and closes sessions, feeds their output to the
// screens that draw them, and follows the panel between the main window and the separate one.
//
// Two pages run this code (the main window and terminal.html) and the core sends its events to both.
// The one that owns the panel (`ownsPanel`: the main window while the core says `docked`, the
// separate one while it says `detached`) draws the sessions; the other ignores the events. When the
// owner changes, the new one lists the sessions, asks for a snapshot of each (what the session has
// shown, and the `seq` of the last event in it), draws it and drops the events that the snapshot
// already holds (`seq` not greater than its own): the shell notices nothing, and the output, the
// cursor and the history are where they were. This file never imports xterm: the screens (the lazy
// chunk of the panel) register a `TerminalSink` per session, and what arrives before one exists waits.
import { api, type TerminalSession } from '../app/api';
import { Events } from '../app/events';
import type { TerminalExitReason, TerminalMode } from '../app/events.gen';
import { useAppStore } from '../state/store';
import { errorCodeOf, errorMessage } from '../util/errors';
import { clampSize, writeDock, type DockPrefs } from './dock';
import {
  activate,
  addTab,
  closeTab as modelClose,
  fromSessions,
  markExited,
  retitle,
  step,
  type TabsModel,
} from './model';
import { activeTab, initialTerminal, ownsPanel, useTerminal } from './store';

/** What draws one session: the xterm of its tab (terminal/instances.ts). */
export interface TerminalSink {
  /** Draws output. */
  write(data: string): void;
  /** Clears the screen and the scrollback before a snapshot is drawn. */
  reset(): void;
  /** The session is gone from this window: release the screen. */
  dispose(): void;
}

interface Runtime {
  /** `seq` of the last event drawn or covered by a snapshot. */
  lastSeq: number;
  /** A snapshot is on its way: the events that arrive meanwhile wait in `pending`. */
  syncing: boolean;
  pending: { seq: number; data: string }[];
  sink: TerminalSink | null;
  /** Output for a screen that does not exist yet (the tab was never shown), oldest first. */
  backlog: string[];
  backlogSize: number;
  /** Keystrokes not yet sent: they go one call at a time, so that they keep their order. */
  out: string;
  sending: boolean;
}

/** The most output kept for a screen that does not exist yet (the core keeps 2 MiB per session too). */
export const BACKLOG_LIMIT = 4 * 1024 * 1024;
/** The core takes 1 MiB per Write; stay well under it. */
const WRITE_CHUNK = 256 * 1024;
/** Events of sessions this page does not know yet (they can precede the answer of Open). */
const ORPHAN_SESSIONS = 32;
const ORPHAN_LIMIT = 1024 * 1024;
const runtimes = new Map<string, Runtime>();
/**
 * How the sessions this page has seen end, most recent last: a session can end before this page has the
 * tab (the answer of Open, or the list of an adoption, is still on its way), and the tab must then
 * start out as ended and not stay as a ghost. Bounded: ids are never reused.
 */
const ended = new Map<string, { code: number; reason: TerminalExitReason }>();
const ENDED_LIMIT = 64;
/** The latest lock check of each vault: an answer that is not the latest is stale and dropped. */
const lockChecks = new Map<string, number>();
const orphans = new Map<string, { seq: number; data: string }[]>();
let adoptGen = 0;
/** The size of the last screen that was fitted: the size a new session starts at. */
let sizeHint = { cols: 80, rows: 24 };

const get = useTerminal.getState;
const set = useTerminal.setState;

export function setSizeHint(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) sizeHint = { cols, rows };
}

/** Forgets everything (tests; a page that starts the terminal again). */
export function resetTerminal(): void {
  for (const r of runtimes.values()) r.sink?.dispose();
  runtimes.clear();
  orphans.clear();
  ended.clear();
  lockChecks.clear();
  adoptGen++;
  sizeHint = { cols: 80, rows: 24 };
  set(initialTerminal(), true);
}

const newRuntime = (): Runtime => ({
  lastSeq: 0,
  syncing: false,
  pending: [],
  sink: null,
  backlog: [],
  backlogSize: 0,
  out: '',
  sending: false,
});

// ---- the model in the store -------------------------------------------------------------------

const model = (): TabsModel => ({ tabs: get().tabs, active: get().active });
const setModel = (m: TabsModel): void => set({ tabs: m.tabs, active: m.active });

export const setNotice = (notice: string): void => set({ notice });
export const dismissNotice = (): void => set({ notice: '' });

/** A failure of the core, shown translated (the code before the first colon says what it is). */
function fail(e: unknown): void {
  // A session that is gone is told by its terminal:exit; nothing to show for the call that raced it.
  if (errorCodeOf(e) === 'terminal-not-found') return;
  setNotice(errorMessage(e));
}

// ---- screens ------------------------------------------------------------------------------------

/**
 * Registers the screen of a session. What the session showed while it had none is drawn first, in
 * order. Returns the function that unregisters it.
 */
export function attachSink(id: string, sink: TerminalSink): () => void {
  const r = runtimes.get(id);
  if (!r) return () => undefined;
  r.sink = sink;
  const waiting = r.backlog.join('');
  r.backlog = [];
  r.backlogSize = 0;
  if (waiting) sink.write(waiting);
  return () => {
    if (r.sink === sink) r.sink = null;
  };
}

function draw(r: Runtime, data: string): void {
  if (r.sink) {
    r.sink.write(data);
    return;
  }
  r.backlog.push(data);
  r.backlogSize += data.length;
  // A screen that is never shown must not grow without end: the oldest output goes first.
  while (r.backlogSize > BACKLOG_LIMIT && r.backlog.length > 1) {
    r.backlogSize -= (r.backlog.shift() ?? '').length;
  }
}

/** Draws an event unless a snapshot or an earlier event already covers it. */
function apply(r: Runtime, seq: number, data: string): void {
  if (seq <= r.lastSeq) return;
  r.lastSeq = seq;
  draw(r, data);
}

function onOutput(p: { id: string; seq: number; data: string }): void {
  if (!ownsPanel(get())) return;
  const r = runtimes.get(p.id);
  if (!r) {
    // Not a tab yet: Open has not answered, or the list is on its way. Keep it for the tab.
    let list = orphans.get(p.id);
    if (!list) {
      if (orphans.size >= ORPHAN_SESSIONS) return;
      list = [];
      orphans.set(p.id, list);
    }
    if (list.reduce((n, e) => n + e.data.length, 0) < ORPHAN_LIMIT)
      list.push({ seq: p.seq, data: p.data });
    return;
  }
  if (r.syncing) r.pending.push({ seq: p.seq, data: p.data });
  else apply(r, p.seq, p.data);
}

// ---- sessions -----------------------------------------------------------------------------------

/**
 * Starts to hold a session: its runtime, with the events that came before it was a tab. A session this
 * page adopts (`snapshot`) is about to be redrawn from a snapshot, so what came before waits for it and is
 * judged against its `seq`; a session this page just opened has all its events, which are drawn at once.
 */
function hold(id: string, snapshot: boolean): Runtime {
  const r = newRuntime();
  runtimes.set(id, r);
  const early = orphans.get(id) ?? [];
  orphans.delete(id);
  if (snapshot) {
    r.syncing = true;
    r.pending = early;
  } else {
    for (const e of early) apply(r, e.seq, e.data);
  }
  return r;
}

/** Releases a session from this page (the screen too). */
function drop(id: string): void {
  const r = runtimes.get(id);
  runtimes.delete(id);
  orphans.delete(id);
  r?.sink?.dispose();
  if (r) {
    r.sink = null;
    r.out = '';
  }
}

/** Draws what a session has shown, then the events newer than it. */
async function resync(id: string): Promise<void> {
  const r = runtimes.get(id);
  if (!r) return;
  r.syncing = true;
  try {
    const snap = await api.terminal.snapshot(id);
    if (runtimes.get(id) !== r) return;
    r.backlog = [];
    r.backlogSize = 0;
    r.sink?.reset();
    r.lastSeq = snap.seq;
    if (snap.data) draw(r, snap.data);
    for (const e of r.pending) apply(r, e.seq, e.data);
  } catch (e) {
    if (errorCodeOf(e) === 'terminal-not-found') {
      // The session is gone: its exit event came (or is on its way). A tab that is not marked yet
      // is, now, with what the event said, or with a clean end when this page did not see it.
      const known = ended.get(id);
      if (known) settleExit({ id, ...known });
      else if (get().tabs.some((t) => t.id === id && !t.exit))
        setModel(markExited(model(), id, { code: 0, reason: 'exited' }));
      return;
    }
    fail(e);
  } finally {
    r.syncing = false;
    r.pending = [];
  }
}

/** This page takes the panel over: lists the sessions and redraws each from its snapshot. */
async function adopt(): Promise<void> {
  const gen = ++adoptGen;
  let list: TerminalSession[];
  try {
    list = await api.terminal.list();
  } catch (e) {
    fail(e);
    return;
  }
  if (gen !== adoptGen || !ownsPanel(get())) return;
  const known = new Map(get().tabs.map((t) => [t.id, t]));
  const ids = new Set(list.map((s) => s.id));
  for (const t of get().tabs) if (!ids.has(t.id)) drop(t.id);
  for (const s of list) {
    // A tab this page already has keeps its title: the shell may have set one since.
    if (!runtimes.has(s.id)) hold(s.id, true);
  }
  setModel(
    fromSessions(
      list.map((s) => ({
        id: s.id,
        vaultId: s.vaultId,
        cwd: s.cwd,
        title: known.get(s.id)?.title ?? s.title,
      })),
      get().active,
    ),
  );
  if (list.length > 0 && get().role === 'main') set({ open: true });
  checkLocks(list.map((s) => s.vaultId));
  for (const s of list) {
    const known = ended.get(s.id);
    if (known) settleExit({ id: s.id, ...known });
  }
  await Promise.all(list.map((s) => resync(s.id)));
}

/** This page loses the panel: it keeps no tab and no screen (the other window draws them now). */
function release(): void {
  adoptGen++;
  for (const id of [...runtimes.keys()]) drop(id);
  orphans.clear();
  ended.clear();
  set({ tabs: [], active: null, open: false, notice: '' });
}

function applyMode(mode: TerminalMode): void {
  if (get().mode === mode) return;
  set({ mode });
  if (ownsPanel(get())) void adopt();
  else release();
}

// ---- tabs ---------------------------------------------------------------------------------------

/** The vault a new tab starts in: the open one in the main window, the one of the front tab in the separate one. */
function currentVault(): string {
  if (get().role === 'main') return useAppStore.getState().vault?.id ?? '';
  return activeTab(get())?.vaultId ?? '';
}

/** Starts a shell in a new tab, at the size of the panel. Returns whether it started. */
export async function openTab(vaultId: string = currentVault()): Promise<boolean> {
  if (!ownsPanel(get())) return false;
  try {
    const s = await api.terminal.open(vaultId, sizeHint.cols, sizeHint.rows);
    if (!ownsPanel(get())) return true; // the panel moved meanwhile: the new owner lists it
    hold(s.id, false);
    setModel(
      addTab(model(), { id: s.id, vaultId: s.vaultId, cwd: s.cwd, title: s.title, exit: null }),
    );
    set({ open: true, notice: '' });
    checkLocks([s.vaultId]);
    // it may have ended before this answer got here
    const known = ended.get(s.id);
    if (known) settleExit({ id: s.id, ...known });
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

/** Ends the session of a tab and removes the tab. The last one closes the panel (or the separate window). */
export function closeTab(id: string): void {
  if (!get().tabs.some((t) => t.id === id)) return;
  drop(id);
  setModel(modelClose(model(), id));
  // Close returns when the processes are gone (up to a couple of seconds): nobody waits for it.
  api.terminal.close(id).catch(fail);
  if (get().tabs.length === 0) afterLastTab();
}

export const closeActiveTab = (): void => {
  const id = get().active;
  if (id) closeTab(id);
};

function afterLastTab(): void {
  if (get().role === 'window') {
    // The separate window has nothing left to show: back to the main window, with the panel closed.
    void dock();
    return;
  }
  set({ open: false });
}

export function activateTab(id: string): void {
  setModel(activate(model(), id));
}

export function stepTab(delta: number): void {
  setModel(step(model(), delta));
}

/** The shell set the title of its terminal (OSC 0 and 2): the tab shows it. */
export function setTabTitle(id: string, title: string): void {
  setModel(retitle(model(), id, title));
}

interface ExitInfo {
  id: string;
  code: number;
  reason: TerminalExitReason;
}

function onExit(p: ExitInfo): void {
  orphans.delete(p.id);
  if (!ownsPanel(get())) return;
  ended.delete(p.id);
  ended.set(p.id, { code: p.code, reason: p.reason });
  while (ended.size > ENDED_LIMIT) ended.delete(ended.keys().next().value as string);
  settleExit(p);
}

/** What a session's end does to its tab, if this page has one. */
function settleExit(p: ExitInfo): void {
  const tab = get().tabs.find((t) => t.id === p.id);
  if (!tab) return;
  // What the user asked for, or the window it lived in going away: nothing to read, the tab goes.
  // A shell that ended by itself without an error (`exit`) goes the same way; one that failed stays,
  // with its last output and the code, until the user closes it. A vault that became read-only says why.
  if (
    p.reason === 'closed' ||
    p.reason === 'window-closed' ||
    (p.reason === 'exited' && p.code === 0)
  ) {
    drop(p.id);
    setModel(modelClose(model(), p.id));
    if (get().tabs.length === 0) afterLastTab();
    return;
  }
  const r = runtimes.get(p.id);
  if (r) r.out = '';
  setModel(markExited(model(), p.id, { code: p.code, reason: p.reason }));
}

// ---- input and size -----------------------------------------------------------------------------

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** What the user typed (or pasted) for a session. It goes in order, one call at a time, in pieces the core accepts. */
export function queueWrite(id: string, data: string): void {
  const r = runtimes.get(id);
  const tab = get().tabs.find((t) => t.id === id);
  if (!r || !tab || tab.exit || !data) return;
  r.out += data;
  if (!r.sending) void pump(id, r);
}

async function pump(id: string, r: Runtime): Promise<void> {
  r.sending = true;
  try {
    while (r.out) {
      let n = Math.min(r.out.length, WRITE_CHUNK);
      // Never cut a character in two: the core takes valid text.
      if (n < r.out.length && isHighSurrogate(r.out.charCodeAt(n - 1))) n--;
      const chunk = r.out.slice(0, n);
      r.out = r.out.slice(n);
      try {
        await api.terminal.write(id, chunk);
      } catch (e) {
        r.out = '';
        fail(e);
        return;
      }
    }
  } finally {
    r.sending = false;
  }
}

/** Tells the core the size of the screen of a session (a session that is gone is not an error). */
export function resizeSession(id: string, cols: number, rows: number): void {
  setSizeHint(cols, rows);
  if (!runtimes.has(id) || cols <= 0 || rows <= 0) return;
  api.terminal.resize(id, cols, rows).catch(fail);
}

// ---- the panel ------------------------------------------------------------------------------------

/** Shows or hides the panel (its tabs live on); the first time it shows, a shell starts. */
export async function toggleTerminal(): Promise<void> {
  const s = get();
  if (s.role === 'window') {
    await dock(); // the terminal's key in its own window brings it back
    return;
  }
  if (s.mode === 'detached') {
    await undock(); // the terminal is in its window: bring it forward
    return;
  }
  if (s.open) {
    set({ open: false });
    return;
  }
  set({ open: true });
  if (s.tabs.length === 0) await openTab();
}

/** A new tab; the panel opens for it if it is closed. In the separate window, the window comes forward instead of a tab opening here. */
export async function newTerminalTab(): Promise<void> {
  const s = get();
  if (s.role === 'main' && s.mode === 'detached') {
    await undock();
    return;
  }
  set({ open: true });
  await openTab();
}

/** Moves the panel to the window of its own; the shells go on. */
export async function undock(): Promise<void> {
  try {
    await api.terminal.undock();
    applyMode('detached');
  } catch (e) {
    fail(e);
  }
}

/** Moves the panel back to the main window; the shells go on. */
export async function dock(): Promise<void> {
  try {
    await api.terminal.dock();
    applyMode('docked');
  } catch (e) {
    fail(e);
  }
}

/** Position and size in the main window; remembered on this device. */
export function setDock(patch: Partial<DockPrefs>, persist = true): void {
  const prev = get().dock;
  const next: DockPrefs = {
    position: patch.position ?? prev.position,
    size: clampSize(patch.size ?? prev.size),
  };
  set({ dock: next });
  if (persist) writeDock(next);
}

// ---- locked vaults --------------------------------------------------------------------------------

function setLocked(vaultId: string, locked: boolean): void {
  if (!vaultId || !!get().locked[vaultId] === locked) return;
  set((s) => ({ locked: { ...s.locked, [vaultId]: locked } }));
}

/**
 * Learns which of these vaults are locked (a private vault whose key is gone): their terminals are covered.
 * The answer is the vault's `locked` (SyncAPI.Info), not the phase of its sync: a paused sync has the phase
 * `paused` with the key gone too, and a later status must not uncover it.
 */
function checkLocks(vaultIds: string[]): void {
  for (const id of new Set(vaultIds)) {
    if (!id) continue;
    const n = (lockChecks.get(id) ?? 0) + 1;
    lockChecks.set(id, n);
    api.sync
      .info(id)
      .then((info) => {
        if (lockChecks.get(id) === n) setLocked(id, info.locked);
      })
      .catch(() => undefined);
  }
}

/** A status or a lock event of a vault: ask again if a terminal here belongs to it. */
function vaultChanged(vaultId: string): void {
  if (get().locked[vaultId] || get().tabs.some((t) => t.vaultId === vaultId)) checkLocks([vaultId]);
}

// ---- start ----------------------------------------------------------------------------------------

/**
 * Starts the terminal in this page: listens to the core and takes the panel if it is this page's.
 * `role` says which page it is. Returns the function that stops it.
 */
export function startTerminal(role: 'main' | 'window'): () => void {
  let stopped = false;
  set({ role });
  const offs = [
    api.on(Events.terminalOutput, onOutput),
    api.on(Events.terminalExit, onExit),
    api.on(Events.terminalLayout, (p) => applyMode(p.mode)),
    api.on(Events.syncStatus, (s) => vaultChanged(s.vaultId)),
    api.on(Events.vaultLocked, (p) => {
      setLocked(p.vaultId, true); // the key is gone: cover at once, then confirm
      vaultChanged(p.vaultId);
    }),
  ];
  // The core records `detached` and sends terminal:layout before the window exists, so the first answer is the right one.
  const sync = async (): Promise<void> => {
    try {
      const { mode } = await api.terminal.state();
      if (stopped) return;
      const m: TerminalMode = mode === 'detached' ? 'detached' : 'docked';
      if (m !== get().mode) applyMode(m);
      else if (ownsPanel(get())) await adopt();
    } catch (e) {
      if (!stopped) fail(e);
    }
  };
  void sync();
  return () => {
    stopped = true;
    for (const off of offs) off();
  };
}
