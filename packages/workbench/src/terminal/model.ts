// The tabs of the integrated terminal as a pure model (ADR-0064): no React, no bindings. The
// controller (controller.ts) applies the answers of the core to it and the panel draws the result.
import type { TerminalExitReason } from '../app/events.gen';

/** How a session ended, while its tab is still on the screen. */
export interface TabExit {
  /** The exit status of the shell (128 + the signal when it was killed). */
  code: number;
  reason: TerminalExitReason;
}

export interface TerminalTab {
  /** The id of the session in the core: it names the tab in every call and event. */
  id: string;
  /** The vault the session was opened for (`''` = the home directory). */
  vaultId: string;
  /** The directory the shell started in. */
  cwd: string;
  /** The title shown on the tab: the folder name first, then what the shell sets (OSC 0 and 2). */
  title: string;
  /** Set once the session is over; the tab stays until the user closes it. */
  exit: TabExit | null;
}

export interface TabsModel {
  tabs: TerminalTab[];
  /** The id of the tab in front, null when there is none. */
  active: string | null;
}

export const emptyTabs: TabsModel = { tabs: [], active: null };

/** Adds a tab (a tab with the same id is replaced) and brings it to the front. */
export function addTab(m: TabsModel, tab: TerminalTab): TabsModel {
  const rest = m.tabs.filter((t) => t.id !== tab.id);
  return { tabs: [...rest, tab], active: tab.id };
}

/**
 * Removes a tab. The one in front passes to its neighbour (the next one, else the previous one), as
 * in the tab bars of the editor; closing a tab behind the front one leaves the front one alone.
 */
export function closeTab(m: TabsModel, id: string): TabsModel {
  const i = m.tabs.findIndex((t) => t.id === id);
  if (i < 0) return m;
  const tabs = m.tabs.filter((t) => t.id !== id);
  if (m.active !== id) return { tabs, active: m.active };
  return { tabs, active: (tabs[i] ?? tabs[i - 1])?.id ?? null };
}

export function activate(m: TabsModel, id: string): TabsModel {
  return m.active === id || !m.tabs.some((t) => t.id === id) ? m : { ...m, active: id };
}

/** Moves the front tab by `delta` places, wrapping around (Ctrl+Tab style). */
export function step(m: TabsModel, delta: number): TabsModel {
  if (m.tabs.length < 2) return m;
  const i = m.tabs.findIndex((t) => t.id === m.active);
  const next =
    m.tabs[((((i < 0 ? 0 : i) + delta) % m.tabs.length) + m.tabs.length) % m.tabs.length];
  return next ? { ...m, active: next.id } : m;
}

/** A shell sets the title of its window with an escape sequence: an empty one keeps the folder name. */
export function retitle(m: TabsModel, id: string, title: string): TabsModel {
  const t = title.trim();
  if (!t) return m;
  return patch(m, id, (x) => (x.title === t ? x : { ...x, title: t }));
}

/** Marks a session as over: the tab stays, without input, until it is closed. */
export function markExited(m: TabsModel, id: string, exit: TabExit): TabsModel {
  return patch(m, id, (x) => ({ ...x, exit }));
}

/** The model of a list of sessions the core has (the front tab is the last one, the newest). */
export function fromSessions(
  sessions: readonly Pick<TerminalTab, 'id' | 'vaultId' | 'cwd' | 'title'>[],
  active: string | null = null,
): TabsModel {
  const tabs = sessions.map((s) => ({ ...s, exit: null }));
  const front = tabs.some((t) => t.id === active) ? active : (tabs[tabs.length - 1]?.id ?? null);
  return { tabs, active: front };
}

function patch(m: TabsModel, id: string, f: (t: TerminalTab) => TerminalTab): TabsModel {
  const i = m.tabs.findIndex((t) => t.id === id);
  const t = m.tabs[i];
  if (!t) return m;
  const next = f(t);
  if (next === t) return m;
  const tabs = [...m.tabs];
  tabs[i] = next;
  return { ...m, tabs };
}
