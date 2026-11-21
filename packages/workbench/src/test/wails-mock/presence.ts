// In-memory PresenceAPI for Vitest and Playwright runs on the Wails mock (M25, ADR-0065): a stand-in for the
// presence hub of the desktop core (apps/desktop/internal/presence, internal/app/bindings_presence.go), with
// the rules of the core that the UI depends on, written independently of the UI's own code so that a
// divergence shows: `Watch` registers nothing for a vault that is not a linked shared one and says why, it
// counts the watches of a file (one `Unwatch` per `Watch`), and `Move` is recorded as it would go out.
//
// No server runs: a test (or an e2e spec, through `window.__mock.presence`) makes the core speak with
// `members`, `move` and `cleared`, and reads what the UI asked for in `log`, `watches` and `moves`.
import { Events } from '../../app/events';

export interface MockPresenceMember {
  sid: string;
  userId: string;
  name: string;
}

export interface MockPresenceMove {
  vaultId: string;
  path: string;
  pos: { kind: string; line: number; col: number; x: number; y: number };
}

export interface MockPresence {
  /** Every call in order: "Watch vault-1 Note.md", "Unwatch …", "Move vault-1 Note.md text 3:7", … */
  log: string[];
  /** The files the UI holds a watch of, with the count (`vaultId\u0000path`). */
  watches: Map<string, number>;
  /** The positions the UI sent, in order. */
  moves: MockPresenceMove[];
  /** The next Watch of a file answers with this reason (and registers nothing), once; '' for the rules of the core. */
  refuseNext: string;
  /** The count of watches of a file now. */
  watching: (vaultId: string, path: string) => number;
  /** The core says who else is in the file (the list is complete, the own session is not in it). */
  members: (vaultId: string, path: string, list: MockPresenceMember[]) => void;
  /** Somebody moved: a text position (`{ line, col }`) or a point of the scene (`{ x, y }`). */
  move: (
    vaultId: string,
    path: string,
    sid: string,
    pos: { line: number; col: number } | { x: number; y: number },
  ) => void;
  /** Nothing is known about the file any more (connection lost, share revoked). */
  cleared: (vaultId: string, path: string) => void;
}

interface Deps {
  emit: (name: string, payload: unknown) => void;
  /** What the link of the vault is (`kind` '' and `linked` false when it is not linked). */
  link: (vaultId: string) => { linked: boolean; kind: string } | undefined;
}

const key = (vaultId: string, path: string): string => `${vaultId}\u0000${path}`;

export function createPresenceMock(deps: Deps): {
  state: MockPresence;
  api: Record<string, (...args: never[]) => Promise<unknown>>;
} {
  const state: MockPresence = {
    log: [],
    watches: new Map(),
    moves: [],
    refuseNext: '',
    watching: (vaultId, path) => state.watches.get(key(vaultId, path)) ?? 0,
    members: (vaultId, path, list) =>
      deps.emit(Events.presenceMembers, { vaultId, path, members: list }),
    move: (vaultId, path, sid, pos) =>
      deps.emit(Events.presenceMove, {
        vaultId,
        path,
        sid,
        pos:
          'line' in pos
            ? { kind: 'text', line: pos.line, col: pos.col, x: 0, y: 0 }
            : { kind: 'scene', line: 0, col: 0, x: pos.x, y: pos.y },
      }),
    cleared: (vaultId, path) => deps.emit(Events.presenceCleared, { vaultId, path }),
  };
  const api = {
    Watch: (vaultId: string, path: string) => {
      state.log.push(`Watch ${vaultId} ${path}`);
      if (state.refuseNext) {
        const reason = state.refuseNext;
        state.refuseNext = '';
        return Promise.resolve({ watching: false, reason });
      }
      const link = deps.link(vaultId);
      if (!link?.linked) return Promise.resolve({ watching: false, reason: 'offline' });
      if (link.kind === 'private')
        return Promise.resolve({ watching: false, reason: 'not-shared' });
      state.watches.set(key(vaultId, path), state.watching(vaultId, path) + 1);
      return Promise.resolve({ watching: true, reason: '' });
    },
    Unwatch: (vaultId: string, path: string) => {
      state.log.push(`Unwatch ${vaultId} ${path}`);
      const n = state.watching(vaultId, path) - 1;
      if (n > 0) state.watches.set(key(vaultId, path), n);
      else state.watches.delete(key(vaultId, path));
      return Promise.resolve();
    },
    Move: (
      vaultId: string,
      path: string,
      pos: { kind: string; line: number; col: number; x: number; y: number },
    ) => {
      state.log.push(
        `Move ${vaultId} ${path} ${pos.kind} ${pos.kind === 'text' ? `${pos.line}:${pos.col}` : `${pos.x},${pos.y}`}`,
      );
      state.moves.push({ vaultId, path, pos });
      return Promise.resolve();
    },
  };
  return { state, api };
}
